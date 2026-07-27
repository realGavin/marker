import { readFile, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import type { PlaceRow } from "./types.js";
import { loadDotEnv, serviceHeaders, supabaseUrl } from "./env.js";

/**
 * One-time batch generation of place descriptions, grounded in stored facts.
 * Claude Batch API (50% discount) + Haiku per the approved architecture:
 * the model may ONLY restate facts we hold — validation rejects anything else.
 * Resumable: batch id persisted; already-described places are skipped.
 */

const BATCH_STATE = new URL("../data/describe-batch.json", import.meta.url).pathname;

const SYSTEM = `You write short, editorial descriptions for a place-collection app.
Rules — these are absolute:
- Use ONLY the facts provided in the message. Do not add any fact from outside knowledge: no designers, years, prices, rankings, tournaments, hole details, or history.
- If "access" is not in the facts, you must NOT state or imply who can play there: no "private", "members", "membership", "public course", "municipal", "semi-private", "exclusive", "open to all". Names are not evidence — a "Country Club" is not necessarily private.
- Do not infer geography from the name: a place named "Lakeview", "Links", "Bay", or "Seaside" gets no lake, links, bay, or sea claims unless the facts say so.
- Never state a hole count (in digits or words) unless "holes" is in the facts. Never mention prices, fees, or costs. Do not infer or add a city that is not in the facts.
- 2 sentences, 35-60 words total. Warm, editorial, collector's-guide tone. No hype words like "world-class" or "must-play" unless the facts justify them.
- If facts are sparse, write an evocative but generic description using only the name and state.
- Output the description text only — no preamble, no quotes.`;

function factsFor(r: PlaceRow): string {
  const a = r.attrs;
  const facts: Record<string, string | number> = { name: r.name };
  if (r.city) facts.city = r.city;
  if (r.region) facts.state = r.region;
  if (a.holes) facts.holes = a.holes;
  if (a.par) facts.par = a.par;
  if (a.access && a.access !== "unknown") facts.access = a.access;
  if (a.yearOpened) facts.yearOpened = a.yearOpened;
  return JSON.stringify(facts);
}

/**
 * Grounding gate: no numbers absent from facts, no price signs, no access
 * claims without an access fact, no hole counts (digits or words) without a
 * holes fact. Exported for the cleanup scan.
 */
export function validate(description: string, facts: string): boolean {
  if (/[$€£]/.test(description)) return false;
  const factNumbers = new Set(facts.match(/\d+/g) ?? []);
  for (const n of description.match(/\d+/g) ?? []) {
    if (!factNumbers.has(n)) return false;
  }
  if (!/"access"/.test(facts) && /\b(private|members?-only|membership|members\b|public course|municipal|semi-private|exclusive)\b/i.test(description)) {
    return false;
  }
  if (!/"holes"/.test(facts) && /\b(nine|eighteen|twenty-seven|thirty-six|9|18|27|36)[- ]holes?\b/i.test(description)) {
    return false;
  }
  return description.length > 40 && description.length < 600;
}

async function fetchDescribedSlugs(url: string, headers: Record<string, string>): Promise<Set<string>> {
  const done = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const res = await fetch(
      `${url}/rest/v1/places?niche_id=eq.golf&description=not.is.null&select=slug&limit=1000&offset=${from}`,
      { headers },
    );
    const page = (await res.json()) as Array<{ slug: string }>;
    for (const p of page) done.add(p.slug);
    if (page.length < 1000) break;
  }
  return done;
}

export async function describe(): Promise<void> {
  await loadDotEnv();
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing in tooling/etl/.env");
  const url = supabaseUrl();
  const headers = serviceHeaders();
  const client = new Anthropic();

  const rows: PlaceRow[] = JSON.parse(
    await readFile(new URL("../data/places.json", import.meta.url).pathname, "utf8"),
  );
  const bySlug = new Map(rows.map((r) => [r.slug, r]));

  // resume: existing batch takes priority
  let batchId: string | null = null;
  try {
    const state = JSON.parse(await readFile(BATCH_STATE, "utf8")) as { batchId: string; completed?: boolean };
    if (!state.completed) batchId = state.batchId; // completed batches: start fresh for the remainder
  } catch {
    /* no batch in flight */
  }

  if (!batchId) {
    const described = await fetchDescribedSlugs(url, headers);
    const todo = rows.filter((r) => !described.has(r.slug));
    console.log(`${todo.length}/${rows.length} places need descriptions`);
    if (todo.length === 0) return;

    const batch = await client.messages.batches.create({
      requests: todo.map((r) => ({
        custom_id: r.slug.slice(0, 64),
        params: {
          model: "claude-haiku-4-5",
          max_tokens: 200,
          system: SYSTEM,
          messages: [{ role: "user" as const, content: factsFor(r) }],
        },
      })),
    });
    batchId = batch.id;
    await writeFile(BATCH_STATE, JSON.stringify({ batchId, createdAt: batch.created_at }));
    console.log(`batch ${batchId} submitted with ${todo.length} requests`);
  }

  // poll until ended
  for (;;) {
    const batch = await client.messages.batches.retrieve(batchId);
    if (batch.processing_status === "ended") break;
    console.log(`batch ${batchId}: ${batch.processing_status} (${batch.request_counts.processing} processing)`);
    await new Promise((r) => setTimeout(r, 60_000));
  }

  // collect + validate + upsert
  const bySlugTrunc = new Map<string, PlaceRow>();
  for (const r of rows) bySlugTrunc.set(r.slug.slice(0, 64), r);

  let ok = 0, invalid = 0, errored = 0;
  let inTokens = 0, outTokens = 0;
  const updates: Array<{ slug: string; description: string }> = [];
  for await (const result of await client.messages.batches.results(batchId)) {
    const row = bySlugTrunc.get(result.custom_id);
    if (!row) continue;
    if (result.result.type !== "succeeded") {
      errored++;
      continue;
    }
    const msg = result.result.message;
    inTokens += msg.usage.input_tokens;
    outTokens += msg.usage.output_tokens;
    const textBlock = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    const text = textBlock?.text.trim() ?? "";
    if (validate(text, factsFor(row))) {
      updates.push({ slug: row.slug, description: text });
      ok++;
    } else {
      invalid++;
    }
  }

  // patch in chunks via slug filter
  for (let i = 0; i < updates.length; i += 50) {
    const chunk = updates.slice(i, i + 50);
    await Promise.all(
      chunk.map(async (u) => {
        for (let attempt = 1; ; attempt++) {
          const res = await fetch(
            `${url}/rest/v1/places?niche_id=eq.golf&slug=eq.${encodeURIComponent(u.slug)}`,
            { method: "PATCH", headers, body: JSON.stringify({ description: u.description }) },
          ).catch(() => null);
          if (res?.ok) return;
          if (attempt >= 4) throw new Error(`patch ${u.slug}: ${res?.status ?? "network"} after ${attempt} tries`);
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }),
    );
    if ((i / 50) % 20 === 0) console.log(`saved ${Math.min(i + 50, updates.length)}/${updates.length}`);
  }

  // batch pricing: haiku $1/$5 per MTok, 50% batch discount
  const cost = ((inTokens / 1e6) * 1 + (outTokens / 1e6) * 5) * 0.5;
  console.log(
    `descriptions: ${ok} saved, ${invalid} failed validation, ${errored} errored; ` +
      `tokens in=${inTokens} out=${outTokens}; est. cost $${cost.toFixed(2)}`,
  );
  await writeFile(BATCH_STATE, JSON.stringify({ batchId, completed: true }));
  if (invalid > 0) console.log("rerun `pnpm etl describe` to retry validation failures in a new batch");
}
