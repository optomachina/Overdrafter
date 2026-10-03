import { supabase } from "@/integrations/supabase/client";
import { parseOperationsSnapshot, OPERATIONS_MAX_BYTES, type OperationsSnapshot } from "./contract";

export class OperationsStatusError extends Error {
  constructor(readonly code: "access_denied" | "unavailable") {
    super(code === "access_denied" ? "Operations access unavailable." : "Operations status unavailable.");
    this.name = "OperationsStatusError";
  }
}

const OPERATIONS_TIMEOUT_MS = 10_000;
const OPERATIONS_MAX_CHUNKS = 4096;

type BoundedRead = <T>(operation: () => PromiseLike<T>) => Promise<T>;

function discardBody(body: ReadableStream<Uint8Array> | null | undefined) {
  try { void body?.cancel().catch(() => undefined); } catch { /* Disposal must remain bounded. */ }
}

/** Shared deadline + abort state for one read; every awaited step goes through `bounded`. */
function createReadBoundary(signal: AbortSignal) {
  const controller = new AbortController();
  const deadlineAt = performance.now() + OPERATIONS_TIMEOUT_MS;
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(abort, OPERATIONS_TIMEOUT_MS);

  const deadlinePassed = () => performance.now() >= deadlineAt;
  const check = () => {
    if (deadlinePassed()) abort();
    if (controller.signal.aborted) throw new OperationsStatusError("unavailable");
  };
  const bounded: BoundedRead = async (operation) => {
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
  };
  const release = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  };

  return { controller, abort, check, bounded, deadlinePassed, release };
}

type ReadBoundary = ReturnType<typeof createReadBoundary>;

async function requireAccessToken(bounded: BoundedRead, expectedUserId: string): Promise<string> {
  const session = await bounded(() => supabase.auth.getSession());
  const activeSession = session.data.session;
  if (session.error || !activeSession?.access_token || activeSession.user.id !== expectedUserId) {
    throw new OperationsStatusError("access_denied");
  }
  return activeSession.access_token;
}

function requestOperations(boundary: ReadBoundary, accessToken: string): Promise<Response> {
  return boundary.bounded(() => fetch("/api/admin-operations", {
    method: "GET", credentials: "omit", cache: "no-store", redirect: "error",
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    signal: boundary.controller.signal,
  }).then((fetched) => {
    if (boundary.controller.signal.aborted || boundary.deadlinePassed()) discardBody(fetched.body);
    return fetched;
  }));
}

function assertUsableResponse(response: Response) {
  if (response.status === 401 || response.status === 403) throw new OperationsStatusError("access_denied");
  const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (!response.ok || !response.body || contentType !== "application/json") {
    throw new OperationsStatusError("unavailable");
  }
}

async function readBoundedBody(reader: ReadableStreamDefaultReader<Uint8Array>, bounded: BoundedRead): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await bounded(() => reader.read());
    if (chunk.done) break;
    if (!(chunk.value instanceof Uint8Array) || chunk.value.byteLength === 0 || chunks.length >= OPERATIONS_MAX_CHUNKS) {
      throw new OperationsStatusError("unavailable");
    }
    bytes += chunk.value.byteLength;
    if (bytes > OPERATIONS_MAX_BYTES) throw new OperationsStatusError("unavailable");
    chunks.push(chunk.value);
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
  return buffer;
}

function decodeSnapshot(buffer: Uint8Array): OperationsSnapshot {
  const result = parseOperationsSnapshot(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)));
  if (Date.parse(result.generatedAt) > Date.now()) throw new OperationsStatusError("unavailable");
  return result;
}

/** One authenticated read; neither diagnostics nor credentials escape this boundary. */
export async function fetchOperationsStatus(signal: AbortSignal, expectedUserId: string): Promise<OperationsSnapshot> {
  const boundary = createReadBoundary(signal);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const accessToken = await requireAccessToken(boundary.bounded, expectedUserId);
    response = await requestOperations(boundary, accessToken);
    assertUsableResponse(response);
    reader = response.body!.getReader();
    const buffer = await readBoundedBody(reader, boundary.bounded);
    boundary.check();
    const result = decodeSnapshot(buffer);
    boundary.check();
    return result;
  } catch (error) {
    if (boundary.deadlinePassed()) boundary.abort();
    if (error instanceof OperationsStatusError) throw error;
    throw new OperationsStatusError("unavailable");
  } finally {
    boundary.release();
    if (reader) { try { void reader.cancel().catch(() => undefined); } catch { /* Noncooperative cleanup cannot delay the bounded read. */ } }
    else discardBody(response?.body);
  }
}
