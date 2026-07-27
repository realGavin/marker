import { loadDotEnv, serviceHeaders, supabaseUrl } from "./env.js";
import { validate } from "./describe.js";

/**
 * Re-check every stored description against the current grounding rules and
 * null out the ones that fail, so `describe` regenerates them under the
 * tightened prompt.
 */
export async function scrub(): Promise<void> {
  await loadDotEnv();
  const url = supabaseUrl();
  const headers = serviceHeaders();

  let scanned = 0, nulled = 0;
  for (let from = 0; ; from += 1000) {
    const res = await fetch(
      `${url}/rest/v1/places?niche_id=eq.golf&description=not.is.null&select=slug,name,city,region,attrs,description&limit=1000&offset=${from}`,
      { headers },
    );
    const page = (await res.json()) as Array<{
      slug: string; name: string; city: string | null; region: string | null;
      attrs: Record<string, unknown>; description: string;
    }>;
    for (const p of page) {
      scanned++;
      const facts = JSON.stringify({
        name: p.name,
        ...(p.city ? { city: p.city } : {}),
        ...(p.region ? { state: p.region } : {}),
        ...(p.attrs["holes"] ? { holes: p.attrs["holes"] } : {}),
        ...(p.attrs["access"] && p.attrs["access"] !== "unknown" ? { access: p.attrs["access"] } : {}),
      });
      if (!validate(p.description, facts)) {
        const del = await fetch(
          `${url}/rest/v1/places?niche_id=eq.golf&slug=eq.${encodeURIComponent(p.slug)}`,
          { method: "PATCH", headers, body: JSON.stringify({ description: null }) },
        );
        if (!del.ok) throw new Error(`null ${p.slug}: ${del.status}`);
        nulled++;
      }
    }
    if (page.length < 1000) break;
  }
  console.log(`scrub: ${scanned} scanned, ${nulled} descriptions nulled for regeneration`);
}
