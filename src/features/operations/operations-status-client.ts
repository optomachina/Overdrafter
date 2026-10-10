import { supabase } from "@/integrations/supabase/client";
import { parseOperationsSnapshot, OPERATIONS_MAX_BYTES, type OperationsSnapshot } from "./contract";

export class OperationsStatusError extends Error {
  constructor(readonly code: "access_denied" | "unavailable") {
    super(code === "access_denied" ? "Operations access unavailable." : "Operations status unavailable.");
    this.name = "OperationsStatusError";
  }
}

/** One authenticated read; neither diagnostics nor credentials escape this boundary. */
export async function fetchOperationsStatus(signal: AbortSignal, expectedUserId: string): Promise<OperationsSnapshot> {
  const controller = new AbortController();
  const deadlineAt = performance.now() + 10_000;
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, 10_000);
  let response: Response | undefined;
  const discard = (body: ReadableStream<Uint8Array> | null | undefined) => {
    try { void body?.cancel().catch(() => undefined); } catch { /* Disposal must remain bounded. */ }
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  function check() {
    if (performance.now() >= deadlineAt) abort();
    if (controller.signal.aborted) throw new OperationsStatusError("unavailable");
  }
  async function bounded<T>(operation: () => PromiseLike<T>): Promise<T> {
    check();
    let onAbort: () => void;
    const canceled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new OperationsStatusError("unavailable"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const value = await Promise.race([operation(), canceled]);
      check();
      return value;
    } finally {
      controller.signal.removeEventListener("abort", onAbort!);
    }
  }
  try {
    const session = await bounded(() => supabase.auth.getSession());
    if (session.error || !session.data.session?.access_token || session.data.session.user.id !== expectedUserId) throw new OperationsStatusError("access_denied");
    response = await bounded(() => fetch("/api/admin-operations", {
      method: "GET", credentials: "omit", cache: "no-store", redirect: "error",
      headers: { authorization: `Bearer ${session.data.session.access_token}`, accept: "application/json" },
      signal: controller.signal,
    }).then((received) => {
      if (controller.signal.aborted || performance.now() >= deadlineAt) discard(received.body);
      return received;
    }));
    if (response.status === 401 || response.status === 403) throw new OperationsStatusError("access_denied");
    if (!response.ok || !response.body || response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
      throw new OperationsStatusError("unavailable");
    }
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await bounded(() => reader!.read());
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength === 0 || chunks.length >= 4096) throw new OperationsStatusError("unavailable");
      bytes += chunk.value.byteLength;
      if (bytes > OPERATIONS_MAX_BYTES) throw new OperationsStatusError("unavailable");
      chunks.push(chunk.value);
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
    check();
    const result = parseOperationsSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)));
    if (Date.parse(result.generatedAt) > Date.now()) throw new OperationsStatusError("unavailable");
    check();
    return result;
  } catch (error) {
    if (performance.now() >= deadlineAt) abort();
    if (error instanceof OperationsStatusError) throw error;
    throw new OperationsStatusError("unavailable");
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (reader) { try { void reader.cancel().catch(() => undefined); } catch { /* Noncooperative cleanup cannot delay the bounded read. */ } }
    else discard(response?.body);
  }
}
