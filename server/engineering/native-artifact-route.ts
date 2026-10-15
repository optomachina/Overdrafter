import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createPrivateNativeArtifactHandler } from "./native-artifact-runtime";
import { createNativePrivateSql } from "./native-private-sql";
import { createNativePrivateStorage } from "./native-private-storage";
import type { NativeOwnerSqlPool } from "./native-result-executor";

export const NATIVE_ARTIFACT_ROUTE = "/functions/v1/engineering-worker-artifact";
export type NativeArtifactRouteConfig = {
  pool: NativeOwnerSqlPool; storageOrigin: string; storageAuthorization: string;
  publicOrigin: string; enabled?: boolean; storageVersionIdQualified?: boolean;
  fetch?: typeof fetch; timeoutMs?: number; outputBucket?: string;
};
/** Mount on an existing trusted Node HTTPS server/reverse proxy. The proxy must
 * preserve method, path and headers and bound incoming connections. No listener,
 * credential discovery, registration or activation occurs in this module. */
export function createNativeArtifactRoute(config: NativeArtifactRouteConfig) {
  const origin = new URL(config.publicOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new TypeError("Invalid artifact public origin.");
  const publicOrigin = origin.origin, enabled = config.enabled === true, timeoutMs = config.timeoutMs ?? 30000;
  const sql = createNativePrivateSql({ pool: config.pool, enabled, timeoutMs: config.timeoutMs });
  const storage = createNativePrivateStorage({ sql, storageOrigin: config.storageOrigin, authorization: config.storageAuthorization,
    enabled, versionIdQualified: config.storageVersionIdQualified, fetch: config.fetch, timeoutMs: config.timeoutMs });
  const handle = createPrivateNativeArtifactHandler({ sql, storage, enabled: () => enabled, outputBucket: config.outputBucket });
  return async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<boolean> => {
    // Exact raw path. Never derive authority/origin from Host/X-Forwarded-*.
    if (incoming.url !== NATIVE_ARTIFACT_ROUTE) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    const close = () => { if (!outgoing.writableFinished) abort(); };
    incoming.on("aborted", abort); incoming.on("error", abort); outgoing.on("close", close); outgoing.on("error", abort);
    if (incoming.aborted || outgoing.destroyed) abort();
    const fail = (status: number, error: string) => {
      if (!outgoing.headersSent && !outgoing.destroyed) {
        outgoing.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", connection: "close" });
        outgoing.end(JSON.stringify({ schema: "overdrafter.native-artifact-transfer.v1", error }));
      }
    };
    try {
      if (!enabled) { fail(503, "transfer_disabled"); return true; }
      const headers = new Headers(), seen = new Set<string>();
      let headerBytes = 0;
      for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
        const name = incoming.rawHeaders[index].toLowerCase(), value = incoming.rawHeaders[index + 1];
        headerBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
        if (seen.has(name) || headerBytes > 16384) { fail(400, "invalid_transfer"); return true; }
        seen.add(name); headers.set(name, value);
      }
      const method = incoming.method ?? "";
      if (method !== "GET" && method !== "PUT") { fail(405, "method_not_allowed"); return true; }
      if (method === "GET" && (headers.has("transfer-encoding") || (headers.has("content-length") && headers.get("content-length") !== "0"))) {
        fail(400, "invalid_transfer"); return true;
      }
      const init: RequestInit & { duplex?: "half" } = { method, headers, signal: controller.signal };
      if (method === "PUT") { init.body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>; init.duplex = "half"; }
      const response = await handle(new Request(`${publicOrigin}${NATIVE_ARTIFACT_ROUTE}`, init));
      if (controller.signal.aborted || outgoing.destroyed) {
        void response.body?.cancel().catch(() => undefined);
        // A deadline is not a peer disconnect. Finish the HTTP exchange even
        // when an inner handler returned only after the deadline fired.
        if (!outgoing.destroyed) fail(503, "transfer_unavailable");
        return true;
      }
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), outgoing, { signal: controller.signal });
      else outgoing.end();
      return true;
    } catch {
      fail(503, "transfer_unavailable");
      if (outgoing.headersSent && !outgoing.writableFinished) outgoing.destroy();
      return true;
    } finally {
      clearTimeout(timer); abort(); incoming.off("aborted", abort); incoming.off("error", abort); outgoing.off("close", close); outgoing.off("error", abort);
    }
  };
}
