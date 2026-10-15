import { resolveProviderUploadCapabilityObservation } from "../../worker/src/providerUploadCapabilityPersistence";
import type { ProviderUploadCapabilityEnvelope, ProviderUploadCapabilityAdmissionResolverResult } from "../../worker/src/providerUploadCapabilityTypes";
import { projectCapabilityAttention, type CapabilityAttentionMetadata } from "../../worker/src/providerCapabilityAttention";
import type { AdminOperationsRuntime } from "./handler";
import { checkBudget, readBoundedJson } from "./budget";
import { object, type SourceName } from "./projection";

/** Supplied by the provider owner, never inferred from fixtures, requests or health text. */
export type ApprovedCapabilitySource = Readonly<{
  envelope: ProviderUploadCapabilityEnvelope;
  metadata: CapabilityAttentionMetadata;
  reviewedMetadata: readonly CapabilityAttentionMetadata[];
}>;
export type OperationsRuntimeOptions = Readonly<{ fetch?: typeof fetch; now?: () => number; approvedCapabilities?: readonly ApprovedCapabilitySource[]; readCapabilityAdmission?: (envelope: ProviderUploadCapabilityEnvelope, signal: AbortSignal) => Promise<ProviderUploadCapabilityAdmissionResolverResult> }>;
/** Normalize actual PostgREST offsets/microseconds only after strict calendar validation. */
export function databaseTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("unavailable");
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) throw new Error("unavailable");
  const day = new Date(`${match[1]}T00:00:00.000Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== match[1]) throw new Error("unavailable");
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("unavailable");
  return new Date(time).toISOString();
}
function origin(value: string | undefined): string {
  const url = new URL(value ?? "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("unavailable");
  return url.origin;
}
function required(value: string | undefined): string { if (!value || value.trim() !== value) throw new Error("unavailable"); return value; }

export function createAdminOperationsRuntime(environment: Readonly<Record<string, string | undefined>>, options: OperationsRuntimeOptions = {}): AdminOperationsRuntime {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const supabaseUrl = () => origin(environment.SUPABASE_URL ?? environment.VITE_SUPABASE_URL);
  const publicKey = () => required(environment.SUPABASE_PUBLISHABLE_KEY ?? environment.VITE_SUPABASE_PUBLISHABLE_KEY);
  const serviceKey = () => required(environment.SUPABASE_SERVICE_ROLE_KEY);
  async function json(url: string, signal: AbortSignal, headers: Record<string, string>, body?: unknown, allowNotReady = false, receipt?: (response: Response) => void) {
    checkBudget(signal);
    const response = await send(url, { method: body === undefined ? "GET" : "POST", redirect: "error", signal,
      headers: { ...headers, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    try { checkBudget(signal); } catch { void response.body?.cancel().catch(() => undefined); throw new Error("unavailable"); }
    if ((response.status === 401 || response.status === 403) && url.endsWith("/auth/v1/user")) { void response.body?.cancel().catch(() => undefined); return null; }
    if (!response.ok && !(allowNotReady && response.status === 503)) { void response.body?.cancel().catch(() => undefined); throw new Error("unavailable"); }
    if (receipt) { try { receipt(response); } catch { void response.body?.cancel().catch(() => undefined); throw new Error("unavailable"); } }
    return readBoundedJson(response, signal);
  }
  const userHeaders = (token: string) => ({ apikey: publicKey(), authorization: `Bearer ${token}` });
  const serviceHeaders = () => { const key = serviceKey(); return { apikey: key, authorization: `Bearer ${key}` }; };
  async function rows(table: string, select: string, filters: Record<string, string>, signal: AbortSignal) {
    const query = new URLSearchParams({ select, ...filters, limit: "201" });
    let range: string | null = null;
    const data = await json(`${supabaseUrl()}/rest/v1/${table}?${query}`, signal, { ...serviceHeaders(), prefer: "count=exact" }, undefined, false, (response) => { range = response.headers.get("content-range"); });
    if (!Array.isArray(data)) throw new Error("unavailable");
    const match = /^(?:(0)-(\d+)|\*)\/(\d+)$/.exec(range ?? "");
    if (!match) throw new Error("unavailable");
    const total = Number(match[3]);
    if (!Number.isSafeInteger(total) || total < data.length || (data.length === 0 ? match[1] !== undefined || total !== 0 : match[1] !== "0" || Number(match[2]) !== data.length - 1) || (total <= 200 && total !== data.length)) throw new Error("unavailable");
    if (total > 200) return { payload: [], truncated: true };
    const payload = data.map((row) => {
      if (!object(row)) throw new Error("unavailable");
      const normalized = { ...row };
      for (const key of ["created_at", "updated_at", "locked_at", "available_at"]) {
        if (key in row && row[key] !== null) normalized[key] = databaseTimestamp(row[key]);
      }
      return normalized;
    });
    return { payload, truncated: false };
  }
  async function capability(signal: AbortSignal) {
    const approved = options.approvedCapabilities;
    if (!approved?.length || !options.readCapabilityAdmission) return [];
    if (approved.length > 18) throw new Error("unavailable");
    for (const policy of approved) {
      const e = policy.envelope, m = policy.metadata;
      if (e.provider !== m.provider || e.route !== m.route || e.surface !== m.surface || e.revision !== m.surfaceRevision || e.policyRevision !== m.policyRevision
        || projectCapabilityAttention({ metadata: m, reviewedMetadata: policy.reviewedMetadata, evidence: null, previous: null, now: new Date(now()).toISOString() }).state !== "projected") throw new Error("unavailable");
    }
    return Promise.all(approved.map(async (policy) => {
      const e = policy.envelope;
      checkBudget(signal);
      const admission = await options.readCapabilityAdmission!(e, signal);
      checkBudget(signal);
      const raw = await json(`${supabaseUrl()}/rest/v1/rpc/api_resolve_current_capability_observation`, signal, serviceHeaders(), {
        p_provider: e.provider, p_capability: "provider_upload", p_route: e.route, p_surface: e.surface, p_surface_revision: e.revision,
      });
      if (!Array.isArray(raw) || raw.length !== 1 || !object(raw[0])) throw new Error("unavailable");
      const row = raw[0];
      // Reuse the provider-owned exact persisted-row validator and classifier.
      // Check the replay facade against the resolver's exact read-only contract.
      const resolver = { rpc: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) } satisfies Parameters<typeof resolveProviderUploadCapabilityObservation>[0];
      const resolution = await resolveProviderUploadCapabilityObservation(resolver, e, admission);
      return { metadata: policy.metadata, reviewedMetadata: policy.reviewedMetadata,
        evidence: resolution.observationRevision === null ? null : { decision: resolution.decision,
          observedAt: databaseTimestamp(row.observed_at), expiresAt: databaseTimestamp(row.expires_at), observationRevision: resolution.observationRevision } };
    }));
  }
  async function read(source: SourceName, _token: string, signal: AbortSignal) {
    let payload: unknown;
    const since = new Date(now() - 86_400_000).toISOString();
    if (source === "worker") payload = await json(`${origin(environment.WORKER_BASE_URL ?? environment.VITE_WORKER_BASE_URL)}/healthz`, signal, {}, undefined, true);
    else if (source === "queue") payload = await rows("work_queue", "task_type,status,attempts,available_at,locked_at,created_at,updated_at", { status: "in.(queued,running)", order: "created_at.asc" }, signal);
    else if (source === "failures") payload = await rows("work_queue", "status,task_type,created_at,updated_at,provider:payload->>vendor,failureCode:payload->>failureCode", { or: "(status.eq.failed,and(status.eq.queued,payload->>failureCode.not.is.null))", updated_at: `gte.${since}`, order: "updated_at.desc" }, signal);
    else if (source === "quotes") payload = await rows("jobs", "status,created_at,updated_at", { status: "eq.awaiting_vendor_manual_review", order: "updated_at.desc" }, signal);
    else if (source === "extraction") payload = await rows("extraction_quality_alerts", "alert_type,metric_value,threshold_value,alert_day,created_at", { created_at: `gte.${new Date(now() - 172_800_000).toISOString()}`, order: "created_at.desc" }, signal);
    else payload = await capability(signal);
    const fetchedAt = new Date(now()).toISOString();
    if (source !== "worker" && source !== "capability") return { ...(payload as { payload: unknown; truncated: boolean }), fetchedAt };
    return { payload, fetchedAt };
  }
  return {
    now, read,
    async authenticate(token, signal) {
      const value = await json(`${supabaseUrl()}/auth/v1/user`, signal, userHeaders(token));
      return object(value) && typeof value.id === "string" ? { userId: value.id } : null;
    },
    async isPlatformAdmin(token, _userId, signal) {
      return json(`${supabaseUrl()}/rest/v1/rpc/api_get_is_platform_admin`, signal, userHeaders(token), {});
    },
  };
}
