/** Build a scope using production worker code and synthetic SQL fixture records. */
import { readFileSync } from "node:fs";
import { buildQuoteLaneScopeSnapshot, parseWorkerSourcingIntent } from "../worker/src/quoteScope.ts";

const input = JSON.parse(readFileSync(0, "utf8"));
const staged = (file) => file ? {
  originalName: file.original_name,
  localPath: `/synthetic/${file.id}`,
  storageBucket: file.storage_bucket,
  storagePath: file.storage_path,
  trustedContentSha256: file.trusted_content_sha256,
} : null;
try {
  const scope = buildQuoteLaneScopeSnapshot({
    ...input,
    sourcingIntent: parseWorkerSourcingIntent(input.sourcingIntent),
    stagedCadFile: staged(input.cadFile),
    stagedDrawingFile: staged(input.drawingFile),
  });
  process.stdout.write(JSON.stringify({ scope }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: error.message }));
}
