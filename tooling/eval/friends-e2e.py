"""End-to-end test of the friends privacy boundary against production.

The claim under test: an accepted friend sees the map, card and counts, and
CANNOT see notes, ratings, wishlist or visit dates -- while a non-friend,
a removed friend and a blocked ex-friend see nothing at all.

Three real accounts. Cleans up everything it creates.
"""
import json, os, urllib.request, uuid, sys

URL = os.environ["SUPABASE_URL"].rstrip("/")
ANON = os.environ["ANON"]
SERVICE = os.environ["SUPABASE_SECRET_KEY"]


def call(path, method="GET", token=None, body=None, key=None):
    req = urllib.request.Request(f"{URL}{path}", method=method)
    req.add_header("apikey", key or ANON)
    req.add_header("Authorization", f"Bearer {token or key or ANON}")
    req.add_header("Content-Type", "application/json")
    if method in ("POST", "PATCH", "DELETE"):
        req.add_header("Prefer", "return=representation")
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(req, data) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw.strip() else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, raw


ok = fail = 0
def check(label, cond, detail=""):
    global ok, fail
    if cond:
        ok += 1; print(f"  PASS  {label}")
    else:
        fail += 1; print(f"  FAIL  {label}  {detail}")


def signup():
    email = f"e2e-{uuid.uuid4().hex[:8]}@markertest.dev"
    pw = uuid.uuid4().hex
    s, r = call("/auth/v1/signup", "POST", body={"email": email, "password": pw})
    uid = (r or {}).get("user", {}).get("id") or (r or {}).get("id")
    tok = (r or {}).get("access_token")
    if not tok:
        s, r = call("/auth/v1/token?grant_type=password", "POST", body={"email": email, "password": pw})
        tok = (r or {}).get("access_token")
    return uid, tok


s, r = call("/auth/v1/token?grant_type=password", "POST",
            body={"email": os.environ["MARKER_EVAL_EMAIL"], "password": os.environ["MARKER_EVAL_PASSWORD"]})
A = r.get("access_token")
a_id = call("/auth/v1/user", token=A)[1]["id"]
a_handle = (call(f"/rest/v1/profiles?id=eq.{a_id}&select=handle", key=SERVICE)[1] or [{}])[0].get("handle")
b_id, B = signup()
c_id, C = signup()
if not (B and C and a_handle):
    sys.exit("could not set up accounts")
print(f"A=@{a_handle} ({a_id[:8]})  B={b_id[:8]}  C={c_id[:8]}\n")

# A needs at least one log with a note and a rating for the leak tests to mean anything
s, places = call("/rest/v1/places?select=id&limit=1", token=A)
pid = places[0]["id"]
call("/rest/v1/place_logs", "POST", token=A, body={
    "user_id": a_id, "place_id": pid, "status": "visited",
    "rating": 16, "note": "E2E SECRET NOTE — must never be visible to a friend",
})

print("BEFORE FRIENDSHIP")
s, prof = call("/rest/v1/rpc/friend_profile", "POST", token=B, body={"friend": a_id})
check("non-friend gets nothing from friend_profile", s >= 400 or not prof, f"{s} {str(prof)[:80]}")
s, pl = call("/rest/v1/rpc/friend_places", "POST", token=B, body={"friend": a_id})
check("non-friend gets nothing from friend_places", s >= 400 or not pl, f"{s} {str(pl)[:80]}")
s, logs = call(f"/rest/v1/place_logs?user_id=eq.{a_id}&select=note,rating", token=B)
check("non-friend cannot read place_logs directly", not logs, str(logs)[:80])

print("\nPENDING (requested, not accepted)")
s, res = call("/rest/v1/rpc/request_friend", "POST", token=B, body={"handle": a_handle})
check("B can request", s == 200 and res in ("pending", "accepted"), f"{s} {res}")
s, prof = call("/rest/v1/rpc/friend_profile", "POST", token=B, body={"friend": a_id})
check("a PENDING requester still sees nothing", s >= 400 or not prof, f"{s} {str(prof)[:80]}")

print("\nACCEPTED — what a friend may and may not see")
s, _ = call("/rest/v1/rpc/accept_friend", "POST", token=A, body={"other": b_id})
check("A can accept", s in (200, 204), str(s))
s, prof = call("/rest/v1/rpc/friend_profile", "POST", token=B, body={"friend": a_id})
row = (prof or [{}])[0] if isinstance(prof, list) else (prof or {})
check("friend sees the profile", bool(row), f"{s} {str(prof)[:80]}")
check("profile carries a visited count", "visited_count" in row, str(row.keys()))
leaky = [k for k in row if k in ("note", "rating", "notes", "ratings", "visited_on")]
check("profile leaks NO note/rating/date field", not leaky, f"leaked: {leaky}")
s, pl = call("/rest/v1/rpc/friend_places", "POST", token=B, body={"friend": a_id})
check("friend sees the visited places", bool(pl), f"{s} {str(pl)[:80]}")
cols = set().union(*[set(p.keys()) for p in pl]) if pl else set()
leaky2 = cols & {"note", "rating", "visited_on", "status"}
check("places leak NO note/rating/date/status column", not leaky2, f"leaked: {leaky2}")
blob = json.dumps(pl) + json.dumps(prof)
check("the secret note appears NOWHERE in either response", "SECRET NOTE" not in blob)
s, logs = call(f"/rest/v1/place_logs?user_id=eq.{a_id}&select=note,rating", token=B)
check("even an accepted friend cannot read place_logs directly", not logs, str(logs)[:80])

print("\nNON-FRIEND C, while A and B are friends")
s, prof = call("/rest/v1/rpc/friend_profile", "POST", token=C, body={"friend": a_id})
check("unrelated account still sees nothing", s >= 400 or not prof, f"{s} {str(prof)[:80]}")

print("\nENUMERATION")
s, res = call("/rest/v1/rpc/request_friend", "POST", token=C, body={"handle": "definitely_not_a_real_handle_x"})
check("unknown handle RETURNS not_found (so the attempt is metered)", s == 200 and res == "not_found", f"{s} {res}")

print("\nAFTER REMOVAL")
s, _ = call("/rest/v1/rpc/remove_friend", "POST", token=A, body={"other": b_id})
check("A can remove", s in (200, 204), str(s))
s, prof = call("/rest/v1/rpc/friend_profile", "POST", token=B, body={"friend": a_id})
check("removed friend immediately sees nothing", s >= 400 or not prof, f"{s} {str(prof)[:80]}")

print("\nBLOCK TERMINATES FRIENDSHIP")
call("/rest/v1/rpc/request_friend", "POST", token=B, body={"handle": a_handle})
call("/rest/v1/rpc/accept_friend", "POST", token=A, body={"other": b_id})
s, prof = call("/rest/v1/rpc/friend_profile", "POST", token=B, body={"friend": a_id})
check("re-friended, B sees the profile again", bool(prof), str(s))
call("/rest/v1/rpc/block_user", "POST", token=A, body={"target": b_id})
s, prof = call("/rest/v1/rpc/friend_profile", "POST", token=B, body={"friend": a_id})
check("blocking ENDS the friendship (blocked user sees nothing)", s >= 400 or not prof, f"{s} {str(prof)[:80]}")

print("\nCLEANUP")
call(f"/rest/v1/place_logs?user_id=eq.{a_id}&note=like.E2E*", "DELETE", key=SERVICE)
call(f"/rest/v1/user_blocks?blocker_id=eq.{a_id}", "DELETE", key=SERVICE)
call(f"/auth/v1/admin/users/{b_id}", "DELETE", key=SERVICE)
call(f"/auth/v1/admin/users/{c_id}", "DELETE", key=SERVICE)
s, left = call(f"/rest/v1/place_logs?user_id=eq.{a_id}&note=like.E2E*&select=id", key=SERVICE)
print(f"  test accounts deleted; leftover test logs: {len(left or [])}")

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
