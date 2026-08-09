"""End-to-end community test against production, with a real second account.

Verifies the security properties the review cared about, not just the happy
path. Cleans up everything it creates.
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
        try: return e.code, json.loads(raw)
        except Exception: return e.code, raw

def login(email, pw):
    s, r = call("/auth/v1/token?grant_type=password", "POST", body={"email": email, "password": pw})
    return r.get("access_token") if s == 200 else None

ok = fail = 0
def check(label, cond, detail=""):
    global ok, fail
    if cond: ok += 1; print(f"  PASS  {label}")
    else: fail += 1; print(f"  FAIL  {label}  {detail}")

# ---- accounts
A = login(os.environ["MARKER_EVAL_EMAIL"], os.environ["MARKER_EVAL_PASSWORD"])
if not A: sys.exit("could not sign in as account A")
a_id = call("/auth/v1/user", token=A)[1]["id"]

b_email = f"e2e-{uuid.uuid4().hex[:8]}@markertest.dev"
b_pw = uuid.uuid4().hex
s, r = call("/auth/v1/signup", "POST", body={"email": b_email, "password": b_pw})
b_id = (r or {}).get("user", {}).get("id") or (r or {}).get("id")
B = (r or {}).get("access_token") or login(b_email, b_pw)
if not B: sys.exit(f"could not create account B: {s} {r}")
call("/rest/v1/profiles?id=eq." + b_id, "PATCH", key=SERVICE, body={"handle": "e2etester"})
print(f"accounts ready (A={a_id[:8]} B={b_id[:8]})\n")

# ---- A publishes a trip
s, trips = call("/rest/v1/trip_plans?select=id,invite_code,request&limit=1", token=A)
if not trips: sys.exit("account A has no trips to publish")
trip = trips[0]
print("PUBLISH")
s, _ = call("/rest/v1/rpc/publish_trip", "POST", token=A,
            body={"trip": trip["id"], "title": "E2E Test Trip", "summary": "architect e2e"})
check("A can publish own trip", s in (200, 204), f"{s}")

s, feed = call("/rest/v1/published_trips?select=id,title,votes,author_id", token=B)
check("B sees A's published trip", any(t["id"] == trip["id"] for t in (feed or [])), f"{s}")

# ---- votes
print("\nVOTE")
s, _ = call("/rest/v1/rpc/vote_trip", "POST", token=B, body={"trip": trip["id"]})
check("B can vote", s in (200, 204), f"{s}")
s, _ = call("/rest/v1/rpc/vote_trip", "POST", token=A, body={"trip": trip["id"]})
check("A cannot vote for own trip", s >= 400, f"got {s}")
s, feed = call(f"/rest/v1/published_trips?id=eq.{trip['id']}&select=votes", token=B)
check("vote count = 1", (feed or [{}])[0].get("votes") == 1, str(feed))

# ---- adopt (H3: must NOT copy request; must mint fresh invite_code)
print("\nADOPT  (H3 privacy fix)")
s, new_id = call("/rest/v1/rpc/adopt_trip", "POST", token=B, body={"trip": trip["id"]})
check("B can adopt", s == 200 and new_id, f"{s} {new_id}")
if isinstance(new_id, str):
    s, clone = call(f"/rest/v1/trip_plans?id=eq.{new_id}&select=request,invite_code,published_at,editor_pick", token=B)
    c = (clone or [{}])[0]
    orig_req = json.dumps(trip.get("request") or {})
    clone_req = json.dumps(c.get("request") or {})
    check("clone does NOT carry author's private request payload",
          "adopted_from" in clone_req and clone_req != orig_req, clone_req[:120])
    check("clone got a FRESH invite_code (not a write credential for A's trip)",
          c.get("invite_code") and c["invite_code"] != trip["invite_code"])
    check("clone starts private", c.get("published_at") is None)
    check("clone is not editor_pick", c.get("editor_pick") is False)

# ---- editor_pick cannot be self-granted
print("\nEDITOR PICK")
s, _ = call(f"/rest/v1/trip_plans?id=eq.{trip['id']}", "PATCH", token=A, body={"editor_pick": True})
check("A cannot promote own trip to editor_pick", s >= 400, f"got {s}")

# ---- block hides content
print("\nBLOCK")
s, _ = call("/rest/v1/rpc/block_user", "POST", token=B, body={"target": a_id})
check("B can block A", s in (200, 204), f"{s}")
s, feed = call("/rest/v1/published_trips?select=id", token=B)
check("A's trip vanishes from B's feed", not any(t["id"] == trip["id"] for t in (feed or [])))
s, _ = call("/rest/v1/rpc/adopt_trip", "POST", token=B, body={"trip": trip["id"]})
check("B cannot adopt a blocked author's trip", s >= 400, f"got {s}")
s, blocks = call("/rest/v1/rpc/my_blocks", "POST", token=B, body={})
check("my_blocks lists it with a handle", bool(blocks), str(blocks)[:100])
s, _ = call("/rest/v1/rpc/unblock_user", "POST", token=B, body={"target": a_id})
check("B can unblock", s in (200, 204), f"{s}")

# ---- report
print("\nREPORT")
s, _ = call("/rest/v1/rpc/report_content", "POST", token=B,
            body={"target_type": "trip", "target_id": trip["id"], "reason": "e2e test"})
check("B can report content", s in (200, 204), f"{s}")
s, rows = call("/rest/v1/content_reports?select=id", token=B)
check("B cannot read the reports table", s >= 400 or rows == [], f"{s} {str(rows)[:60]}")

# ---- the M8.2 blocker, attempted for real: a MEMBER tries to seize the trip
print("\nOWNERSHIP SEIZURE (member attack)")
s, joined = call("/rest/v1/rpc/join_trip", "POST", token=B, body={"code": trip["invite_code"]})
check("B can join A's trip with the invite code", s == 200, f"{s} {joined}")
s, _ = call(f"/rest/v1/trip_plans?id=eq.{trip['id']}", "PATCH", token=B, body={"user_id": b_id})
check("member CANNOT seize ownership", s >= 400, f"got {s}")
s, _ = call(f"/rest/v1/trip_plans?id=eq.{trip['id']}", "PATCH", token=B, body={"invite_code": "AAAAAAAAAAAA"})
check("member CANNOT rotate the invite code", s >= 400, f"got {s}")
s, _ = call("/rest/v1/rpc/publish_trip", "POST", token=B,
            body={"trip": trip["id"], "title": "hijacked", "summary": "x"})
check("member CANNOT publish the owner's trip", s >= 400, f"got {s}")
s, still = call(f"/rest/v1/trip_plans?id=eq.{trip['id']}&select=user_id", key=SERVICE)
check("owner unchanged after all attempts", (still or [{}])[0].get("user_id") == a_id)

# ---- cleanup
print("\nCLEANUP")
call("/rest/v1/rpc/unpublish_trip", "POST", token=A, body={"trip": trip["id"]})
call(f"/rest/v1/content_reports?reporter_id=eq.{b_id}", "DELETE", key=SERVICE)
call(f"/rest/v1/trip_plans?user_id=eq.{b_id}", "DELETE", key=SERVICE)
call(f"/auth/v1/admin/users/{b_id}", "DELETE", key=SERVICE)
s, feed = call("/rest/v1/published_trips?select=id", key=SERVICE)
print(f"  test account deleted; published trips remaining: {len(feed or [])}")

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
