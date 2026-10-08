import { NativeStopFailure, stopObject } from "./native-stop-admission.ts";

export const observerId = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  && value !== "00000000-0000-0000-0000-000000000000";

export function privateStopUrl(value: string, path: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
    url.pathname = url.pathname.replace(/\/$/, "") + path;
    return url.href;
  } catch { throw new NativeStopFailure(503, "stop_configuration_unavailable"); }
}
/** Fixed small reply bound; dispatcher timeouts abort body reads as well as send. */
export async function stopJsonReply(response: Response, signal: AbortSignal): Promise<unknown> {
  if (response.redirected || !response.body) throw new NativeStopFailure(503, "stop_outcome_unknown", true);
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error("aborted");
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 4096) throw new Error("oversize");
      chunks.push(next.value);
    }
    if (signal.aborted) throw new Error("aborted");
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => undefined); }
}
export async function boundedStopCall<T>(operation: (signal: AbortSignal) => Promise<T>, deadlineMs: number): Promise<T> {
  const controller = new AbortController(), deadline = performance.now() + deadlineMs; let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([operation(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new NativeStopFailure(503, "stop_outcome_unknown", true)); }, deadlineMs);
    })]);
    if (performance.now() >= deadline || controller.signal.aborted) throw new NativeStopFailure(503, "stop_outcome_unknown", true);
    return result;
  } catch (error) {
    if (performance.now() >= deadline || controller.signal.aborted) throw new NativeStopFailure(503, "stop_outcome_unknown", true);
    throw error;
  } finally { clearTimeout(timer); controller.abort(); }
}
/** No worker-supplied actor, profile, completeness or qualification. The fixed
 * private role and database-owned actor/profile mapping remain authoritative.
 * Construct this only inside an independently attributed validator process. */
export function createNativeObserverRepository(config: Readonly<{
  url: string; token: string; profileId: string; fetch?: typeof fetch; deadlineMs?: number;
}>) {
  const endpoint = privateStopUrl(config.url, "/rpc/store_native_observer_evidence");
  try {
    const parts = config.token.split(".");
    const claims: unknown = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"));
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))
      || !stopObject(claims) || claims.role !== "ovd575_observer_validator" || !observerId(config.profileId)) throw new Error();
  } catch { throw new NativeStopFailure(503, "observer_executor_unavailable"); }
  const deadline = config.deadlineMs ?? 5000;
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > 30000) throw new NativeStopFailure(503, "observer_executor_unavailable");
  return { async ingest(manifest: Uint8Array, journal: Uint8Array): Promise<string> {
    if (manifest.byteLength < 1 || manifest.byteLength > 131072 || journal.byteLength < 1 || journal.byteLength > 1048576) {
      throw new NativeStopFailure(400, "invalid_observer_bytes");
    }
    // Snapshot before the first await; exact bytea encoding never JSON-roundtrips the certificate.
    const body = JSON.stringify({ p_profile: config.profileId,
      p_manifest: `\\x${Buffer.from(manifest).toString("hex")}`, p_journal: `\\x${Buffer.from(journal).toString("hex")}` });
    try {
      return await boundedStopCall(async signal => {
        const response = await (config.fetch ?? fetch)(endpoint, { method: "POST", redirect: "error", signal,
          headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json",
            "content-profile": "engineering_private", accept: "application/json" }, body });
        const value = await stopJsonReply(response, signal);
        if (!response.ok) {
          const code = stopObject(value) ? value.code : null;
          if (code === "42501") throw new NativeStopFailure(401, "observer_access_denied");
          if (code === "PT409" || code === "22023") throw new NativeStopFailure(code === "PT409" ? 409 : 400, "observer_not_admitted");
          // Existing OVD575 without staged replay can return 23505 after a lost
          // commit. That is UNKNOWN, never proof that evidence was not stored.
          throw new NativeStopFailure(503, "observer_outcome_unknown", true);
        }
        if (!observerId(value)) throw new NativeStopFailure(503, "observer_outcome_unknown", true);
        return value;
      }, deadline);
    } catch (error) {
      if (error instanceof NativeStopFailure) throw error;
      throw new NativeStopFailure(503, "observer_outcome_unknown", true);
    }
  } };
}
