import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCKED_PUBLIC_ASSET_SHA256 } from "./verify-public-assets.mjs";

const FORMER_ASSET_PATHS = [
  "/fixtures/1093-05589-02.STEP",
  "/fixtures/1093-05589-02.pdf",
];
const MISSING_ROUTE_CONTROL = "/fixtures/ovd-360-asset-absence-control";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function downloadSnapshot(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { "cache-control": "no-cache" },
    redirect: "follow",
  });
  const body = Buffer.from(await response.arrayBuffer());

  return {
    status: response.status,
    contentType: response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "",
    hash: sha256(body),
  };
}

/**
 * Proves removal through an explicit missing status or an exact SPA-fallback
 * match while always rejecting known validation-package bytes.
 */
export function classifyFormerAssetResponse(target, missingRouteControl) {
  if (BLOCKED_PUBLIC_ASSET_SHA256.has(target.hash)) {
    return { ok: false, reason: `response has prohibited SHA-256 ${target.hash}` };
  }

  if (target.status === 404 || target.status === 410) {
    return { ok: true, reason: `explicit ${target.status}` };
  }

  const matchesSpaFallback =
    target.status === 200 &&
    target.contentType === "text/html" &&
    missingRouteControl.status === 200 &&
    missingRouteControl.contentType === "text/html" &&
    target.hash === missingRouteControl.hash;

  if (matchesSpaFallback) {
    return { ok: true, reason: "exact match for the host's missing-route HTML fallback" };
  }

  return {
    ok: false,
    reason: `unproven removal: status=${target.status} content-type=${target.contentType || "missing"} sha256=${target.hash}`,
  };
}

async function verifyHost(baseUrl) {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, "");
  const cacheBust = `ovd360=${Date.now()}`;
  const control = await downloadSnapshot(`${normalizedBaseUrl}${MISSING_ROUTE_CONTROL}?${cacheBust}`);
  const results = [];

  for (const assetPath of FORMER_ASSET_PATHS) {
    for (const suffix of ["", `?${cacheBust}`]) {
      const targetUrl = `${normalizedBaseUrl}${assetPath}${suffix}`;
      const target = await downloadSnapshot(targetUrl);
      results.push({ targetUrl, target, result: classifyFormerAssetResponse(target, control) });
    }
  }

  return results;
}

async function main() {
  const baseUrls = process.argv.slice(2);
  if (baseUrls.length === 0) {
    throw new Error("Pass at least one deployed base URL to verify.");
  }

  let failed = false;
  for (const baseUrl of baseUrls) {
    const results = await verifyHost(baseUrl);
    for (const { targetUrl, target, result } of results) {
      const summary = `${targetUrl} -> ${target.status} ${target.contentType || "unknown"} ${target.hash}`;
      if (result.ok) {
        console.log(`PASS ${summary} (${result.reason})`);
      } else {
        failed = true;
        console.error(`FAIL ${summary} (${result.reason})`);
      }
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
}

const isDirectExecution = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isDirectExecution) {
  await main();
}
