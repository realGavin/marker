// RevenueCat webhook -> server-side entitlements table.
// Deploy: supabase functions deploy revenuecat-webhook --no-verify-jwt
// Secrets: RC_WEBHOOK_AUTH (shared secret configured in the RevenueCat
// dashboard's webhook Authorization header), plus the project's service key
// (SUPABASE_SERVICE_ROLE_KEY is injected automatically).
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const auth = req.headers.get("authorization");
  if (!auth || auth !== Deno.env.get("RC_WEBHOOK_AUTH")) {
    return new Response("unauthorized", { status: 401 });
  }

  const { event } = await req.json();
  // app_user_id is our auth user id (set at Purchases.configure time).
  const userId: string | undefined = event?.app_user_id;
  if (!userId || !/^[0-9a-f-]{36}$/.test(userId)) {
    return new Response("ignored", { status: 200 });
  }

  // Grant on purchase/renewal; revoke only at EXPIRATION (a CANCELLATION just
  // turns off auto-renew — access runs until the paid period ends).
  const GRANT = ["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE"];
  const tier = GRANT.includes(event.type) ? "pro" : event.type === "EXPIRATION" ? "free" : null;
  if (tier === null) return new Response("noop", { status: 200 });

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const res = await fetch(`${url}/rest/v1/entitlements`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      user_id: userId,
      tier,
      expires_at: event.expiration_at_ms ? new Date(event.expiration_at_ms).toISOString() : null,
      rc_app_user_id: event.app_user_id,
    }),
  });
  return new Response(res.ok ? "ok" : "upsert failed", { status: res.ok ? 200 : 500 });
});
