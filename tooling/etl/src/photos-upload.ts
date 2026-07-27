import { readFile, readdir } from "node:fs/promises";
import { S3Client, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { env, loadDotEnv } from "./env.js";

const OUT = new URL("../data/photos/", import.meta.url).pathname;
const BUCKET = "marker-tiles";
// Cloudflare account id is not a secret (it's in every dashboard URL).
const ENDPOINT = "https://e28dc8077789e1afed9a0fe016f676e5.r2.cloudflarestorage.com";
const CONCURRENCY = 12;

/** Push data/photos/*.jpg to R2 under photos/<slug>.jpg. Resumable. */
export async function photosUpload(): Promise<void> {
  await loadDotEnv();
  const s3 = new S3Client({
    region: "auto",
    endpoint: ENDPOINT,
    credentials: {
      accessKeyId: env("R2_ACCESS_KEY_ID"),
      secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
    },
  });

  const have = new Set<string>();
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "photos/", ContinuationToken: token }),
    );
    for (const o of page.Contents ?? []) if (o.Key) have.add(o.Key);
    token = page.NextContinuationToken;
  } while (token);

  const files = (await readdir(OUT)).filter((f) => f.endsWith(".jpg"));
  const todo = files.filter((f) => !have.has("photos/" + f));
  console.log(`upload: ${files.length} local, ${have.size} already in R2, ${todo.length} to upload`);

  let done = 0, failed = 0, i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const f = todo[i++];
      if (!f) break;
      try {
        await s3.send(
          new PutObjectCommand({
            Bucket: BUCKET,
            Key: "photos/" + f,
            Body: await readFile(OUT + f),
            ContentType: "image/jpeg",
            CacheControl: "public, max-age=31536000, immutable",
          }),
        );
        done++;
      } catch {
        failed++;
      }
      if ((done + failed) % 500 === 0) console.log(`upload: ${done + failed}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`upload done: ${done} ok, ${failed} failed (rerun to retry)`);
}
