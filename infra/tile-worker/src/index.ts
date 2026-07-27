/**
 * Tile server: GET /<archive>/<z>/<x>/<y>.mvt -> vector tile from the PMTiles
 * archive in R2, via HTTP range reads. Edge-cached aggressively: after warmup
 * most requests never touch R2, keeping cost flat regardless of user count.
 */
import { PMTiles, ResolvedValueCache, type RangeResponse, type Source } from "pmtiles";

interface Env {
  BUCKET: R2Bucket;
}

class R2Source implements Source {
  constructor(
    private bucket: R2Bucket,
    private archive: string,
  ) {}
  getKey() {
    return this.archive;
  }
  async getBytes(offset: number, length: number): Promise<RangeResponse> {
    const obj = await this.bucket.get(this.archive, { range: { offset, length } });
    if (!obj) throw new Error(`archive ${this.archive} not found`);
    return { data: await (obj as R2ObjectBody).arrayBuffer() };
  }
}

// Header/directory cache persists across requests on a warm isolate.
const pmCache = new ResolvedValueCache(64, true);

const TILE_PATH = /^\/([0-9a-z-_]+)\/(\d+)\/(\d+)\/(\d+)\.mvt$/i;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") return new Response("method not allowed", { status: 405 });
    const url = new URL(request.url);
    const m = TILE_PATH.exec(url.pathname);
    if (!m) return new Response("not found", { status: 404 });
    const [, archive, zs, xs, ys] = m;
    const z = Number(zs), x = Number(xs), y = Number(ys);
    if (z > 15) return new Response("zoom out of range", { status: 404 });

    const cache = caches.default;
    const cacheKey = new Request(url.toString());
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const pm = new PMTiles(new R2Source(env.BUCKET, `${archive}.pmtiles`), pmCache);
    let tile;
    try {
      tile = await pm.getZxy(z, x, y);
    } catch {
      return new Response("archive not found", { status: 404 });
    }

    const headers = new Headers({
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=86400, s-maxage=2592000",
      "Content-Type": "application/x-protobuf",
    });
    const resp = tile?.data
      ? new Response(tile.data, { headers })
      : new Response(null, { status: 204, headers });
    ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  },
};
