/** Browser-safe OVD-409 wire. No source diagnostic text or private entity identifiers. */
export const OPERATIONS_SCHEMA = "overdrafter.admin-operations.v1" as const;
export const OPERATIONS_REFRESH_MS = 30_000;
export const OPERATIONS_MAX_BYTES = 131_072;
export const OPERATIONS_MAX_ITEMS = 128;
export const OPERATIONS_CATEGORIES = ["worker", "runtime", "provider_session", "queue", "task_failure", "quote_attention", "extraction_quality", "upload_capability", "spend"] as const;
export const OPERATIONS_SEVERITIES = ["healthy", "attention", "blocked", "unknown"] as const;
export const OPERATIONS_PROVIDERS = ["xometry", "fictiv", "protolabs", "sendcutsend", "partsbadger", "fastdms", "devzmanufacturing", "infraredlaboratories", "oshcut", "fabworks", "ponoko", "quickparts", "rapiddirect", "geomiq", "weerg", "protolabsnetwork", "emachineshop", "rmfg"] as const;
// Browser-safe snapshot of registered identifiers in worker/src/extraction/modelRegistry.ts.
export const OPERATIONS_TASK_TYPES = ["extract_part", "run_vendor_quote", "poll_vendor_quote", "publish_package", "repair_adapter_candidate", "debug_extract_part", "generate_cad_preview"] as const;
export const OPERATIONS_MODELS = ["gpt-5.4", "gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251001", "openai/gpt-4.1-mini", "anthropic/claude-3-5-haiku", "moonshotai/kimi-k2", "minimax/minimax-m2.5", "minimax/minimax-m2.7", "zhipuai/glm-5"] as const;
export const OPERATIONS_SUMMARIES = {
  source_unavailable: "Operational evidence is unavailable.", source_malformed: "Operational evidence is invalid or incomplete.",
  source_stale: "Operational evidence is stale.", source_truncated: "The bounded source window is incomplete.", policy_invalid: "Approved source policy is unavailable.",
  worker_ready: "The worker is ready with a fresh heartbeat.", worker_not_ready: "The worker reports that it is not ready.",
  runtime_known: "Worker build and model identity are available.", authentication_unknown: "Current provider authentication is not independently established.",
  session_aging: "Provider session evidence is aging; review authentication.", queue_clear: "No active queue work was found.", queued_work: "Queue work is waiting for processing.", scheduled_work: "Queue work is scheduled for a future time.", task_stuck: "Active queue work exceeded its age threshold.", task_active: "Queue work is processing within its age threshold.",
  repeated_failures: "Recent task failures require review.", no_recent_failures: "No task failures were found in the checked window.",
  manual_followup: "Current provider quotes require manual follow-up.", no_manual_followup: "No current quote requires manual follow-up.",
  extraction_alert: "Extraction quality exceeded a review threshold.", evaluation_unknown: "Fresh extraction-quality evaluation is not established.",
  spend_control: "Review current spend limits in the existing spend control.",
  matches_policy: "Upload capability matches reviewed policy.", format_added: "Observed upload formats were added; review the policy.", format_removed: "Observed upload formats were removed; review the policy.", reviewed_missing_accept_xometry: "Upload capability matches the reviewed Xometry fallback.",
  accept_missing: "Upload format evidence is missing.", unsupported: "The upload capability is unsupported.", denied: "Upload capability policy denies this operation.",
  observation_missing: "Upload capability observations are missing.", observation_stale: "Upload capability observations are stale.", formats_loading: "Upload formats have not finished loading.", ambiguous_input: "Upload capability evidence is ambiguous.", route_or_selector_drift: "The provider upload surface changed.", authentication_required: "The provider requires authentication.", anti_bot_or_challenge: "The provider requires a challenge review.", provider_error: "The provider returned an operational error.", unclassified_response: "The provider response requires classification.",
} as const;
export type OperationsCategory = typeof OPERATIONS_CATEGORIES[number];
export type OperationsSeverity = typeof OPERATIONS_SEVERITIES[number];
export type OperationsProvider = typeof OPERATIONS_PROVIDERS[number];
export type OperationsReason = keyof typeof OPERATIONS_SUMMARIES;
export type OperationsItem = Readonly<{
  key: string; category: OperationsCategory; severity: OperationsSeverity;
  subsystem: "cad-worker" | "database" | "providers" | "spend"; provider: OperationsProvider | null;
  context: Readonly<{ build: string | null; model: string | null; runtime: string | null; adapterVersion: string | null; sessionEvidenceAgeDays: number | null; sessionEvidenceKind: "storage_modified_age" | null; taskType: string | null; taskStartedAt: string | null; taskCompletedAt: string | null; taskFailedAt: string | null }>;
  reasonCode: OperationsReason; summary: string;
  firstSeenAt: string | null; lastSeenAt: string | null; changedAt: string | null; lastCheckedAt: string | null;
  freshness: Readonly<{ state: "fresh" | "stale" | "unknown"; ageMs: number | null; maxAgeMs: number | null; expiresAt: string | null }>;
  occurrenceCount: number | null;
  action: Readonly<{ kind: "spend_control"; href: "/internal/admin#spend-controls" }> | null;
}>;
export type OperationsSnapshot = Readonly<{
  schema: typeof OPERATIONS_SCHEMA; generatedAt: string; refreshAfterMs: typeof OPERATIONS_REFRESH_MS;
  items: readonly OperationsItem[]; counts: Readonly<Record<OperationsSeverity, number>>;
}>;
export type OperationsErrorCode = "unauthenticated" | "forbidden" | "unavailable" | "invalid_request";

export function operationsTimestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
}
export function isOperationsVersion(value: unknown): value is string {
  return typeof value === "string" && (/^[a-f0-9]{7,40}$/.test(value) || /^v?\d{1,4}\.\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(value));
}
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && "value" in descriptor && descriptor.enumerable;
  });
}
function member(value: unknown, allowed: readonly string[]): value is string { return typeof value === "string" && allowed.includes(value); }
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validItem(value: unknown, now: number): value is OperationsItem {
  if (!record(value, ["key", "category", "severity", "subsystem", "provider", "context", "reasonCode", "summary", "firstSeenAt", "lastSeenAt", "changedAt", "lastCheckedAt", "freshness", "occurrenceCount", "action"])) return false;
  if (!member(value.category, OPERATIONS_CATEGORIES) || !member(value.severity, OPERATIONS_SEVERITIES)
    || !member(value.subsystem, ["cad-worker", "database", "providers", "spend"])
    || (value.provider !== null && !member(value.provider, OPERATIONS_PROVIDERS))
    || value.key !== `${value.category}:${value.provider ?? value.subsystem}`
    || !member(value.reasonCode, Object.keys(OPERATIONS_SUMMARIES))
    || value.summary !== OPERATIONS_SUMMARIES[value.reasonCode as OperationsReason]) return false;
  if (!record(value.context, ["build", "model", "runtime", "adapterVersion", "sessionEvidenceAgeDays", "sessionEvidenceKind", "taskType", "taskStartedAt", "taskCompletedAt", "taskFailedAt"])) return false;
  const c = value.context;
  if ((c.build !== null && !isOperationsVersion(c.build)) || (c.adapterVersion !== null && !isOperationsVersion(c.adapterVersion))
    || (c.model !== null && !member(c.model, OPERATIONS_MODELS)) || (c.runtime !== null && !member(c.runtime, ["live", "simulate"]))) return false;
  if ((c.sessionEvidenceAgeDays !== null && (typeof c.sessionEvidenceAgeDays !== "number" || !Number.isFinite(c.sessionEvidenceAgeDays) || c.sessionEvidenceAgeDays < 0 || c.sessionEvidenceAgeDays > 3650))
    || (c.sessionEvidenceAgeDays === null ? c.sessionEvidenceKind !== null : c.sessionEvidenceKind !== "storage_modified_age")
    || (c.taskType !== null && !member(c.taskType, OPERATIONS_TASK_TYPES))) return false;
  for (const key of ["taskStartedAt", "taskCompletedAt", "taskFailedAt"]) {
    if (c[key] !== null && (operationsTimestamp(c[key]) === null || operationsTimestamp(c[key])! > now)) return false;
  }
  const unknownReasons = ["source_unavailable", "source_malformed", "source_stale", "source_truncated", "policy_invalid", "evaluation_unknown", "authentication_unknown", "observation_missing", "observation_stale", "spend_control"];
  const healthyReasons = ["worker_ready", "runtime_known", "queue_clear", "scheduled_work", "task_active", "no_recent_failures", "no_manual_followup", "matches_policy", "reviewed_missing_accept_xometry"];
  if ((unknownReasons.includes(String(value.reasonCode)) && value.severity !== "unknown")
    || (value.severity === "healthy" && !healthyReasons.includes(String(value.reasonCode)))) return false;
  const reasonCategories: Partial<Record<OperationsReason, OperationsCategory>> = {
    worker_ready: "worker", worker_not_ready: "worker", runtime_known: "runtime", authentication_unknown: "provider_session", session_aging: "provider_session",
    queue_clear: "queue", queued_work: "queue", scheduled_work: "queue", task_stuck: "queue", task_active: "queue", repeated_failures: "task_failure", no_recent_failures: "task_failure",
    manual_followup: "quote_attention", no_manual_followup: "quote_attention", extraction_alert: "extraction_quality", evaluation_unknown: "extraction_quality", spend_control: "spend",
  };
  const expectedCategory = reasonCategories[value.reasonCode as OperationsReason];
  if (expectedCategory && value.category !== expectedCategory) return false;
  if (!expectedCategory && !["source_unavailable", "source_malformed", "source_stale", "source_truncated", "policy_invalid"].includes(value.reasonCode as string)
    && value.category !== "upload_capability") return false;
  for (const key of ["firstSeenAt", "lastSeenAt", "changedAt", "lastCheckedAt"]) {
    if (value[key] !== null && (operationsTimestamp(value[key]) === null || operationsTimestamp(value[key])! > now)) return false;
  }
  if (!record(value.freshness, ["state", "ageMs", "maxAgeMs", "expiresAt"])) return false;
  const f = value.freshness;
  if (!member(f.state, ["fresh", "stale", "unknown"]) || (f.ageMs !== null && !nonnegative(f.ageMs))
    || (f.maxAgeMs !== null && (!nonnegative(f.maxAgeMs) || f.maxAgeMs === 0))
    || (f.expiresAt !== null && operationsTimestamp(f.expiresAt) === null)
    || (value.severity !== "unknown" && f.state !== "fresh")
    || (f.state === "fresh" && (f.expiresAt === null || operationsTimestamp(f.expiresAt)! <= now || f.ageMs === null || f.maxAgeMs === null || f.ageMs > f.maxAgeMs))) return false;
  if (f.state === "fresh") {
    const observed = operationsTimestamp(value.lastSeenAt);
    const checked = operationsTimestamp(value.lastCheckedAt);
    if (observed === null || checked === null || observed > checked || f.ageMs !== now - observed
      || operationsTimestamp(f.expiresAt)! > Math.min(observed, checked) + (f.maxAgeMs as number)) return false;
  }
  const maximumAge = value.category === "upload_capability" ? 26 * 60 * 60 * 1000
    : ["worker", "runtime", "provider_session"].includes(String(value.category)) ? 120_000 : 60_000;
  if (f.maxAgeMs !== null && (f.maxAgeMs as number) > maximumAge) return false;
  if (f.expiresAt !== null && (value.lastCheckedAt === null || operationsTimestamp(f.expiresAt)! > operationsTimestamp(value.lastCheckedAt)! + maximumAge)) return false;
  if (value.occurrenceCount !== null && !nonnegative(value.occurrenceCount)) return false;
  return value.action === null || (value.category === "spend" && record(value.action, ["kind", "href"])
    && value.action.kind === "spend_control" && value.action.href === "/internal/admin#spend-controls");
}
/** Throws a generic error; caller must bound wire bytes before JSON.parse. */
export function parseOperationsSnapshot(value: unknown): OperationsSnapshot {
  const invalid = () => new TypeError("Invalid operations response.");
  if (!record(value, ["schema", "generatedAt", "refreshAfterMs", "items", "counts"]) || value.schema !== OPERATIONS_SCHEMA
    || value.refreshAfterMs !== OPERATIONS_REFRESH_MS) throw invalid();
  const now = operationsTimestamp(value.generatedAt);
  if (now === null || !Array.isArray(value.items) || value.items.length > OPERATIONS_MAX_ITEMS
    || !value.items.every((item) => validItem(item, now)) || !record(value.counts, OPERATIONS_SEVERITIES)) throw invalid();
  const items = value.items as OperationsItem[];
  if (new Set(items.map((item) => item.key)).size !== items.length || !OPERATIONS_CATEGORIES.every((category) => items.some((item) => item.category === category))) throw invalid();
  if (!OPERATIONS_SEVERITIES.every((severity) => value.counts && (value.counts as Record<string, unknown>)[severity] === items.filter((item) => item.severity === severity).length)) throw invalid();
  return value as unknown as OperationsSnapshot;
}
