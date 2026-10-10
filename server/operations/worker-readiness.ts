/** OVD-409 fixture-first projection. No transport, authorization or runtime wiring. */
export type WorkerHealthSource = { payload: unknown; fetchedAt: unknown } | null;
export type WorkerReadinessPolicy = { nowMs: number; maxAgeMs: number };

type Reason = "source_unavailable" | "source_malformed" | "source_stale" | "policy_invalid"
  | "worker_not_ready" | "worker_ready";

export type WorkerReadinessItem = {
  key: "worker:readiness";
  category: "worker";
  subsystem: "cad-worker";
  severity: "healthy" | "blocked" | "unknown";
  reasonCode: Reason;
  summary: string;
  freshness: "fresh" | "stale" | "unknown";
  lastCheckedAt: string | null;
  lastObservedAt: string | null;
  firstSeenAt: null;
  lastChangedAt: null;
  occurrenceCount: null;
  versionContext: null;
  action: null;
  reference: null;
};

const SUMMARIES: Record<Reason, string> = {
  source_unavailable: "Worker readiness data is unavailable.",
  source_malformed: "Worker readiness data is incomplete or inconsistent.",
  source_stale: "Worker readiness data is stale.",
  policy_invalid: "Worker readiness freshness policy is invalid.",
  worker_not_ready: "The worker reports that it is not ready.",
  worker_ready: "The worker reports that it is ready with a fresh heartbeat.",
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Match the canonical UTC format emitted by Date.toISOString in worker health. */
function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function item(reasonCode: Reason, checked: number | null = null, observed: number | null = null): WorkerReadinessItem {
  return {
    key: "worker:readiness", category: "worker", subsystem: "cad-worker",
    severity: reasonCode === "worker_ready" ? "healthy" : reasonCode === "worker_not_ready" ? "blocked" : "unknown",
    reasonCode, summary: SUMMARIES[reasonCode],
    freshness: reasonCode === "source_stale" ? "stale"
      : reasonCode === "worker_ready" || reasonCode === "worker_not_ready" ? "fresh" : "unknown",
    lastCheckedAt: checked === null ? null : new Date(checked).toISOString(),
    lastObservedAt: observed === null ? null : new Date(observed).toISOString(),
    firstSeenAt: null, lastChangedAt: null, occurrenceCount: null,
    versionContext: null, action: null, reference: null,
  };
}

/**
 * Transform one worker snapshot; callers must independently authorize any exposure.
 * Null source means unavailable. Budgets are caller policy, never deployment defaults.
 * Invalid/future metadata is unknown; age equal to the budget is still fresh.
 * Snapshot history, identities, versions, raw diagnostics and links are not projected.
 */
export function projectWorkerReadiness(source: WorkerHealthSource, policy: WorkerReadinessPolicy): WorkerReadinessItem {
  if (!record(policy) || !Number.isSafeInteger(policy.nowMs)
    || !Number.isFinite(new Date(policy.nowMs).getTime())
    || !Number.isSafeInteger(policy.maxAgeMs) || policy.maxAgeMs <= 0) {
    return item("policy_invalid");
  }
  if (source === null) return item("source_unavailable");
  if (!record(source)) return item("source_malformed");
  const checked = timestamp(source.fetchedAt);
  if (checked === null || checked > policy.nowMs) return item("source_malformed");
  const payload = source.payload;
  if (!record(payload)) return item("source_malformed", checked);
  const observed = timestamp(payload.lastLoopAt);
  if (observed === null || observed > checked) return item("source_malformed", checked);
  if (payload.service !== "overdrafter-cad-worker"
    || typeof payload.status !== "string"
    || !["starting", "running", "shutting_down"].includes(payload.status)
    || typeof payload.ready !== "boolean"
    || !Array.isArray(payload.readinessIssues)
    || !payload.readinessIssues.every((issue) => typeof issue === "string")
    || payload.ready !== (payload.status === "running" && payload.readinessIssues.length === 0)) {
    return item("source_malformed", checked, observed);
  }
  if (policy.nowMs - checked > policy.maxAgeMs || policy.nowMs - observed > policy.maxAgeMs) {
    return item("source_stale", checked, observed);
  }
  return item(payload.ready ? "worker_ready" : "worker_not_ready", checked, observed);
}
