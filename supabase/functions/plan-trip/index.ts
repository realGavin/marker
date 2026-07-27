// Grounded trip planner. The model can only CHOOSE from candidates our code
// retrieved from the database; the server discards any id it didn't supply.
// Deploy: supabase functions deploy plan-trip
// Secrets: ANTHROPIC_API_KEY
import Anthropic from "npm:@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5"; // approved architecture decision: cheap, ~$0.01/plan
const FREE_TRIAL_PLANS = 1;
const PRO_PLANS_PER_MONTH = 20;
const NICHE = "golf";

interface TripInput {
  region: string;
  days: number;
  rounds: number;
  budget: "$" | "$$" | "$$$" | "any";
  notes?: string;
}

interface Candidate {
  id: string;
  slug: string;
  name: string;
  city: string | null;
  region: string | null;
  attrs: { access?: string; holes?: number; greenFeeBand?: string };
  description: string | null;
  lat: number;
  lng: number;
  distance_km: number;
}

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sbHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

async function sbGet<T>(path: string): Promise<T> {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: sbHeaders });
  if (!res.ok) throw new Error(`db ${path}: ${res.status}`);
  return res.json();
}

/** Resolve a free-text region to a center point using our own places data. */
async function resolveRegion(region: string): Promise<{ lat: number; lng: number } | null> {
  const q = region.trim();
  if (!q) return null;
  const STATE_NAMES: Record<string, string> = {
    alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
    connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
    illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA",
    maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN",
    mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV",
    "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
    "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR",
    pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
    tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
    "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
  };

  // City match first (specific beats broad), then state.
  const cityPts = await sbGet<Array<{ lat: number; lng: number }>>(
    `rpc/place_centroid?search_city=${encodeURIComponent("%" + q + "%")}&niche=${NICHE}`,
  ).catch(() => []);
  if (cityPts.length > 0 && cityPts[0].lat != null) return cityPts[0];

  const state = q.length === 2 ? q.toUpperCase() : STATE_NAMES[q.toLowerCase()];
  if (state) {
    const statePts = await sbGet<Array<{ lat: number; lng: number }>>(
      `rpc/state_centroid?state_code=${state}&niche=${NICHE}`,
    ).catch(() => []);
    if (statePts.length > 0 && statePts[0].lat != null) return statePts[0];
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // ---- auth: the caller's JWT identifies the user
  const jwt = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!jwt) return json({ error: "unauthorized" }, 401);
  const userRes = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!userRes.ok) return json({ error: "unauthorized" }, 401);
  const user = await userRes.json();

  // ---- entitlement gate (server-side truth, not client claims)
  const ent = await sbGet<Array<{ tier: string; expires_at: string | null }>>(
    `entitlements?user_id=eq.${user.id}&select=tier,expires_at`,
  );
  const isPro =
    ent[0]?.tier === "pro" &&
    (!ent[0].expires_at || new Date(ent[0].expires_at) > new Date());
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const countRes = await fetch(
    `${SB_URL}/rest/v1/trip_plans?user_id=eq.${user.id}&select=count` +
      (isPro ? `&created_at=gte.${monthStart.toISOString()}` : ""),
    { headers: { ...sbHeaders, Prefer: "count=exact" } },
  );
  const used = (await countRes.json())[0]?.count ?? 0;
  if (!isPro && used >= FREE_TRIAL_PLANS) return json({ error: "upgrade_required" }, 402);
  if (isPro && used >= PRO_PLANS_PER_MONTH) return json({ error: "monthly_limit" }, 429);

  // ---- input
  const input = (await req.json()) as TripInput;
  const days = Math.min(Math.max(Math.round(input.days || 3), 1), 14);
  const rounds = Math.min(Math.max(Math.round(input.rounds || days), 1), days * 2);

  // ---- retrieve real candidates (our code, not the model)
  const center = await resolveRegion(input.region);
  if (!center) return json({ error: "region_not_found" }, 422);
  let candidates = await sbGet<Candidate[]>(
    `rpc/places_near?center_lat=${center.lat}&center_lng=${center.lng}&radius_km=140&max_results=80`,
  );
  // playable bias: drop known-private unless nothing else remains
  const playable = candidates.filter((c) => c.attrs?.access !== "private");
  if (playable.length >= 10) candidates = playable;
  // budget filter only when we hold fee data
  if (input.budget && input.budget !== "any") {
    const within = candidates.filter(
      (c) => !c.attrs?.greenFeeBand || c.attrs.greenFeeBand.length <= input.budget.length,
    );
    if (within.length >= 10) candidates = within;
  }
  candidates = candidates.slice(0, 40);
  if (candidates.length === 0) return json({ error: "no_places_in_region" }, 422);

  // ---- compose: the model chooses among candidate ids only
  const anthropic = new Anthropic({ apiKey: Deno.env.get("ANTHROPIC_API_KEY")! });
  const candidateBlock = candidates.map((c) => ({
    id: c.id,
    name: c.name,
    city: c.city,
    region: c.region,
    km_from_center: Math.round(c.distance_km),
    access: c.attrs?.access ?? "unknown",
    holes: c.attrs?.holes,
    fee_band: c.attrs?.greenFeeBand,
    about: c.description?.slice(0, 160),
  }));

  const schema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      days: {
        type: "array",
        items: {
          type: "object",
          properties: {
            day: { type: "integer" },
            place_ids: { type: "array", items: { type: "string" } },
            note: { type: "string" },
          },
          required: ["day", "place_ids", "note"],
          additionalProperties: false,
        },
      },
    },
    required: ["summary", "days"],
    additionalProperties: false,
  };

  const SYSTEM = `You are a trip-routing assistant for a golf trip. You are given a fixed list of candidate courses with ids. Build a ${days}-day itinerary with ${rounds} total rounds.
Absolute rules:
- You may ONLY reference courses by the exact "id" values given. Never invent a course, never reference one you know from outside the list.
- Every day on which golf is played MUST list that day's course ids in place_ids. Do not name a course only in the note; the note supplements place_ids, never replaces them. Only rest/travel days may have an empty place_ids.
- Never state prices or costs. The fee_band symbol, when present, may guide choices but must not appear as a dollar amount.
- Prefer variety and sensible routing (close courses on the same/adjacent days; use km_from_center).
- Notes are 1-2 sentences: pacing, drive order, why the course fits. No fabricated facts about courses; use only the provided fields.
- At most 2 rounds per day.`;

  async function compose(compact: boolean) {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: compact
        ? `Build a ${days}-day itinerary with ${rounds} rounds as compact JSON. place_ids must contain the chosen candidate ids — never leave every day empty. Notes max 12 words. Only provided ids; no prices.`
        : SYSTEM,
      messages: [
        {
          role: "user",
          content: `Traveler request: region=${input.region}; days=${days}; rounds=${rounds}; budget=${input.budget}; preferences=${input.notes ?? "none"}.\n\nCandidates:\n${JSON.stringify(
            compact
              ? candidateBlock.map(({ id, name, km_from_center }) => ({ id, name, km_from_center }))
              : candidateBlock,
          )}`,
        },
      ],
      output_config: { format: { type: "json_schema", schema } },
    });
    const block = res.content.find((b: { type: string }) => b.type === "text") as { text: string } | undefined;
    try {
      return JSON.parse(block?.text ?? "") as {
        summary: string;
        days: Array<{ day: number; place_ids: string[]; note: string }>;
      };
    } catch {
      return null;
    }
  }

  const allowed = new Map(candidates.map((c) => [c.id, c]));
  const clean = (plan: NonNullable<Awaited<ReturnType<typeof compose>>>) =>
    plan.days
      .map((d) => ({
        day: d.day,
        note: String(d.note ?? "").slice(0, 400),
        places: (d.place_ids ?? [])
          .filter((id) => allowed.has(id))
          .map((id) => {
            const c = allowed.get(id)!;
            return { id: c.id, slug: c.slug, name: c.name, city: c.city, region: c.region };
          }),
      }))
      .filter((d) => d.places.length > 0 || d.note.length > 0)
      .slice(0, days);

  let plan = await compose(false);
  let cleanDays = plan ? clean(plan) : [];
  if (!plan || cleanDays.every((d) => d.places.length === 0)) {
    // covers both failure modes: unparseable output, or prose-only days
    plan = await compose(true);
    cleanDays = plan ? clean(plan) : [];
  }
  if (!plan || cleanDays.every((d) => d.places.length === 0)) {
    return json({ error: "planner_failed" }, 502);
  }

  const itinerary = { summary: String(plan.summary ?? "").slice(0, 600), days: cleanDays };

  // ---- persist
  const saveRes = await fetch(`${SB_URL}/rest/v1/trip_plans`, {
    method: "POST",
    headers: { ...sbHeaders, Prefer: "return=representation" },
    body: JSON.stringify({ user_id: user.id, request: input, itinerary }),
  });
  const [saved] = saveRes.ok ? await saveRes.json() : [null];

  return json({ id: saved?.id ?? null, itinerary });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
