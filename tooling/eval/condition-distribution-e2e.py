"""End-to-end test of the condition distribution views against production.

Three real accounts, because the rules that matter (the >=2 reporter floor,
the strengthened flag rule, endorsement disjointness) cannot be exercised
with one. Cleans up everything it creates.
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


# ---- accounts
s, r = call("/auth/v1/token?grant_type=password", "POST",
            body={"email": os.environ["MARKER_EVAL_EMAIL"], "password": os.environ["MARKER_EVAL_PASSWORD"]})
A = r.get("access_token")
a_id = call("/auth/v1/user", token=A)[1]["id"]
b_id, B = signup()
c_id, C = signup()
if not (B and C):
    sys.exit("could not create test accounts")
print(f"accounts: A={a_id[:8]} B={b_id[:8]} C={c_id[:8]}\n")

# two distinct places so the two scenarios can't contaminate each other
s, places = call("/rest/v1/places?select=id,slug&limit=2", token=A)
P1, P2 = places[0], places[1]

# ---- scenario 1: two independent 'poor' reports -> counted AND flagged
print("AGREEMENT (2 x poor)")
call("/rest/v1/rpc/report_condition", "POST", token=A, body={"place": P1["id"], "kind": "bunkers", "score": "poor", "note": "e2e raked never"})
call("/rest/v1/rpc/report_condition", "POST", token=B, body={"place": P1["id"], "kind": "bunkers", "score": "poor", "note": None})
s, rows = call(f"/rest/v1/condition_summary?place_id=eq.{P1['id']}&kind=eq.bunkers&select=*", token=A)
row = (rows or [{}])[0]
check("summary appears at 2 reporters", bool(rows), str(s))
check("poor_count = 2", row.get("poor_count") == 2, str(row))
check("counts sum to reporters",
      (row.get("poor_count", 0) + row.get("ok_count", 0) + row.get("good_count", 0)) == row.get("reporters"), str(row))
check("endorsements start at 0", row.get("endorsements") == 0, str(row.get("endorsements")))
s, flags = call(f"/rest/v1/place_condition_flags?place_id=eq.{P1['id']}&select=*", token=A)
check("place IS flagged (2 poor)", bool(flags), str(flags))
check("worst_kind is bunkers", (flags or [{}])[0].get("worst_kind") == "bunkers", str(flags))

# ---- scenario 2: disagreement -> visible in summary, but NOT flagged
print("\nDISAGREEMENT (1 poor + 1 good)  <- the strengthened rule")
call("/rest/v1/rpc/report_condition", "POST", token=A, body={"place": P2["id"], "kind": "greens", "score": "poor", "note": None})
call("/rest/v1/rpc/report_condition", "POST", token=B, body={"place": P2["id"], "kind": "greens", "score": "good", "note": None})
s, rows2 = call(f"/rest/v1/condition_summary?place_id=eq.{P2['id']}&kind=eq.greens&select=*", token=A)
r2 = (rows2 or [{}])[0]
check("summary shows the split", r2.get("poor_count") == 1 and r2.get("good_count") == 1, str(r2))
s, flags2 = call(f"/rest/v1/place_condition_flags?place_id=eq.{P2['id']}&select=*", token=A)
check("place is NOT flagged by one dissenter", not flags2, str(flags2))

# ---- endorsement disjointness
print("\nENDORSEMENT")
rid = row.get("latest_report_id")
s, _ = call("/rest/v1/rpc/endorse_condition", "POST", token=C, body={"report": rid})
check("C (no own report) can endorse", s in (200, 204), str(s))
s, rows = call(f"/rest/v1/condition_summary?place_id=eq.{P1['id']}&kind=eq.bunkers&select=*", token=A)
r3 = (rows or [{}])[0]
check("endorsements = 1", r3.get("endorsements") == 1, str(r3.get("endorsements")))
check("reporters unchanged at 2", r3.get("reporters") == 2, str(r3.get("reporters")))
s, _ = call("/rest/v1/rpc/endorse_condition", "POST", token=B, body={"report": rid})
s, rows = call(f"/rest/v1/condition_summary?place_id=eq.{P1['id']}&kind=eq.bunkers&select=*", token=A)
r4 = (rows or [{}])[0]
check("B (already a reporter) does NOT inflate endorsements",
      r4.get("endorsements") == 1, f"got {r4.get('endorsements')}")

# ---- one account cannot publish alone
print("\nFLOOR")
s, _ = call("/rest/v1/rpc/report_condition", "POST", token=C, body={"place": P2["id"], "kind": "rough", "score": "poor", "note": None})
s, solo = call(f"/rest/v1/condition_summary?place_id=eq.{P2['id']}&kind=eq.rough&select=*", token=A)
check("one reporter alone publishes nothing", not solo, str(solo))

# ---- cleanup
print("\nCLEANUP")
for pid in (P1["id"], P2["id"]):
    call(f"/rest/v1/condition_reports?place_id=eq.{pid}", "DELETE", key=SERVICE)
call(f"/auth/v1/admin/users/{b_id}", "DELETE", key=SERVICE)
call(f"/auth/v1/admin/users/{c_id}", "DELETE", key=SERVICE)
s, left = call("/rest/v1/condition_reports?select=id", key=SERVICE)
print(f"  test accounts deleted; condition_reports remaining: {len(left or [])}")

print(f"\n{ok} passed, {fail} failed")
sys.exit(1 if fail else 0)
