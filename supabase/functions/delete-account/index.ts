// Account deletion (App Store requirement). Verifies the caller's JWT, then
// deletes the auth user; every user table cascades from profiles -> auth.users.
Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const SB_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!jwt) return new Response("unauthorized", { status: 401 });
  const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!userRes.ok) return new Response("unauthorized", { status: 401 });
  const user = await userRes.json();

  const del = await fetch(`${SB_URL}/auth/v1/admin/users/${user.id}`, {
    method: "DELETE",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  return new Response(del.ok ? "deleted" : "failed", { status: del.ok ? 200 : 500 });
});
