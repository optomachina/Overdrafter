import { OPERATIONS_MAX_BYTES, type OperationsErrorCode } from "../../src/features/operations/contract";
import { withinBudget } from "./budget";
import { projectOperations, type SourceName, type SourceObservation } from "./projection";

export type AdminOperationsRuntime = Readonly<{
  authenticate: (token: string, signal: AbortSignal) => Promise<{ userId: string } | null>;
  isPlatformAdmin: (token: string, userId: string, signal: AbortSignal) => Promise<unknown>;
  read: (source: SourceName, token: string, signal: AbortSignal) => Promise<SourceObservation>;
  now?: () => number;
}>;
const SOURCES: readonly SourceName[] = ["worker", "queue", "failures", "quotes", "extraction", "capability"];
function reply(status: number, value: unknown): Response {
  return Response.json(value, { status, headers: {
    "cache-control": "private, no-store, max-age=0", "vary": "Authorization", "x-content-type-options": "nosniff",
  } });
}
function failure(status: number, error: OperationsErrorCode): Response { return reply(status, { error }); }

export function createAdminOperationsHandler(runtime: AdminOperationsRuntime) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return failure(405, "invalid_request");
    const url = new URL(request.url);
    if (url.pathname !== "/api/admin-operations" || url.search || url.hash) return failure(400, "invalid_request");
    const origin = request.headers.get("origin");
    if (origin !== null && origin !== url.origin) return failure(403, "forbidden");
    const bearer = request.headers.get("authorization");
    if (!bearer || !/^Bearer [A-Za-z0-9._-]{16,8192}$/.test(bearer)) return failure(401, "unauthenticated");
    const token = bearer.slice(7);
    try {
      return await withinBudget(async (wholeSignal) => {
        const user = await withinBudget((signal) => runtime.authenticate(token, signal), 1500, wholeSignal);
        if (!user || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(user.userId)) return failure(401, "unauthenticated");
        const admin = await withinBudget((signal) => runtime.isPlatformAdmin(token, user.userId, signal), 1500, wholeSignal);
        if (admin !== true) return failure(403, "forbidden");
        const observations = await Promise.all(SOURCES.map(async (source) => {
          try { return [source, await withinBudget((signal) => runtime.read(source, token, signal), 5000, wholeSignal)] as const; }
          catch { return [source, null] as const; }
        }));
        const snapshot = projectOperations(Object.fromEntries(observations), (runtime.now ?? Date.now)());
        const serialized = JSON.stringify(snapshot);
        if (new TextEncoder().encode(serialized).byteLength > OPERATIONS_MAX_BYTES) return failure(503, "unavailable");
        return reply(200, snapshot);
      }, 8500, request.signal);
    } catch { return failure(503, "unavailable"); }
  };
}
