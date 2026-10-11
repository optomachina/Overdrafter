import {
  OPERATIONS_CATEGORIES, OPERATIONS_TASK_TYPES, OPERATIONS_MODELS, OPERATIONS_PROVIDERS, OPERATIONS_REFRESH_MS, OPERATIONS_SCHEMA, OPERATIONS_SUMMARIES,
  isOperationsVersion, operationsTimestamp, parseOperationsSnapshot,
  type OperationsCategory, type OperationsItem, type OperationsProvider, type OperationsReason, type OperationsSeverity,
} from "../../src/features/operations/contract";
import { projectWorkerReadiness } from "../operations/worker-readiness";
import { projectCapabilityAttention, type CapabilityAttentionMetadata } from "../../worker/src/providerCapabilityAttention";

export type SourceName = "worker" | "queue" | "failures" | "quotes" | "extraction" | "capability";
export type SourceObservation = Readonly<{ payload: unknown; fetchedAt: string; truncated?: boolean }>;
export type CapabilitySource = Readonly<{ metadata: CapabilityAttentionMetadata; reviewedMetadata: readonly CapabilityAttentionMetadata[]; evidence: unknown }>;
const DATABASE_AGE = 60_000;
const WORKER_AGE = 120_000;
const FAILURE_WINDOW = 86_400_000;
const MAX_ROWS = 200;
const FAILURE_CODES = ["task_failure", "login_required", "captcha", "selector_failure", "upload_failure", "navigation_failure", "unexpected_ui_state", "anti_detection_block", "profile_in_use", "persistence_failure", "not_implemented", "dispatch_preflight_unavailable", "dispatch_permit_missing", "dispatch_permit_invalid", "spend_cap_reached"];
function oneOf(value: unknown, values: readonly string[]): boolean { return typeof value === "string" && values.includes(value); }
export function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function provider(value: unknown): OperationsProvider | null { return typeof value === "string" && (OPERATIONS_PROVIDERS as readonly string[]).includes(value) ? value as OperationsProvider : null; }
function sourceProblem(source: SourceObservation | null | undefined, now: number, maxAge = DATABASE_AGE): OperationsReason | null {
  if (!source) return "source_unavailable";
  const checked = operationsTimestamp(source.fetchedAt);
  if (checked === null || checked > now) return "source_malformed";
  return now - checked >= maxAge ? "source_stale" : null;
}
function base(category: OperationsCategory, now: number, reason: OperationsReason = "source_unavailable", vendor: OperationsProvider | null = null): OperationsItem {
  const subsystem = ["worker", "runtime"].includes(category) ? "cad-worker" : ["provider_session", "upload_capability"].includes(category) ? "providers" : category === "spend" ? "spend" : "database";
  return { key: `${category}:${vendor ?? subsystem}`, category, subsystem, provider: vendor,
    severity: "unknown", reasonCode: reason, summary: OPERATIONS_SUMMARIES[reason],
    context: { build: null, model: null, runtime: null, adapterVersion: null, sessionEvidenceAgeDays: null, sessionEvidenceKind: null, taskType: null, taskStartedAt: null, taskCompletedAt: null, taskFailedAt: null },
    firstSeenAt: null, lastSeenAt: null, changedAt: null, lastCheckedAt: new Date(now).toISOString(),
    freshness: { state: reason === "source_stale" ? "stale" : "unknown", ageMs: null, maxAgeMs: null, expiresAt: null }, occurrenceCount: null,
    action: category === "spend" ? { kind: "spend_control", href: "/internal/admin#spend-controls" } : null };
}
function observed(item: OperationsItem, source: SourceObservation, now: number, reason: OperationsReason, severity: OperationsSeverity, count: number | null, observedAt = source.fetchedAt, maxAge = DATABASE_AGE): OperationsItem {
  const at = operationsTimestamp(observedAt);
  const checked = operationsTimestamp(source.fetchedAt);
  if (at === null || checked === null || at > checked || checked > now) return base(item.category, now, "source_malformed", item.provider);
  const deadline = Math.min(at, checked) + maxAge;
  const stale = now >= deadline;
  return { ...item, reasonCode: stale ? "source_stale" : reason, summary: OPERATIONS_SUMMARIES[stale ? "source_stale" : reason], severity: stale ? "unknown" : severity,
    lastCheckedAt: source.fetchedAt, lastSeenAt: observedAt, occurrenceCount: count,
    freshness: { state: stale ? "stale" : "fresh", ageMs: now - at, maxAgeMs: maxAge, expiresAt: new Date(deadline).toISOString() } };
}
function workerItems(source: SourceObservation | null | undefined, now: number): OperationsItem[] {
  const readiness = projectWorkerReadiness(source ?? null, { nowMs: now, maxAgeMs: WORKER_AGE });
  const item = base("worker", now, readiness.reasonCode);
  const worker = source && readiness.lastObservedAt && readiness.freshness === "fresh"
    ? observed(item, source, now, readiness.reasonCode, readiness.severity, null, readiness.lastObservedAt, WORKER_AGE) : item;
  let runtime = base("runtime", now);
  const sessions = [base("provider_session", now, "authentication_unknown", "xometry"), base("provider_session", now, "authentication_unknown", "fictiv")];
  if (source && object(source.payload) && worker.freshness.state === "fresh") {
    const p = source.payload;
    const context = { ...runtime.context, build: isOperationsVersion(p.workerBuildVersion) ? p.workerBuildVersion : null,
      model: typeof p.drawingExtractionModel === "string" && (OPERATIONS_MODELS as readonly string[]).includes(p.drawingExtractionModel) ? p.drawingExtractionModel : null,
      runtime: p.workerMode === "live" || p.workerMode === "simulate" ? p.workerMode : null, adapterVersion: null };
    for (const [sourceKey, targetKey] of [["lastTaskStartedAt", "taskStartedAt"], ["lastTaskCompletedAt", "taskCompletedAt"], ["lastTaskFailedAt", "taskFailedAt"]] as const) {
      const time = operationsTimestamp(p[sourceKey]);
      if (time !== null && time <= now) context[targetKey] = p[sourceKey] as string;
    }
    if (object(p.currentTask) && typeof p.currentTask.type === "string" && (OPERATIONS_TASK_TYPES as readonly string[]).includes(p.currentTask.type)) context.taskType = p.currentTask.type;
    runtime = { ...observed(base("runtime", now), source, now, "runtime_known", "healthy", null, readiness.lastObservedAt!, WORKER_AGE), context };
    if (!context.build || !context.model || !context.runtime) runtime = { ...base("runtime", now, "source_malformed"), context };
    for (let index = 0; index < sessions.length; index++) {
      const age = p[`${sessions[index].provider}_session_age_days`];
      if (typeof age === "number" && Number.isFinite(age) && age >= 0 && age <= 3650) {
        sessions[index] = { ...observed(sessions[index], source, now, "authentication_unknown", "unknown", null, readiness.lastObservedAt!, WORKER_AGE),
          context: { ...sessions[index].context, sessionEvidenceAgeDays: age, sessionEvidenceKind: "storage_modified_age" } };
      }
      if (typeof age === "number" && Number.isFinite(age) && age >= 7 && age <= 3650) {
        sessions[index] = observed(sessions[index], source, now, "session_aging", "attention", null, readiness.lastObservedAt!, WORKER_AGE);
      }
    }
  }
  return [worker, runtime, ...sessions];
}
function rows(source: SourceObservation): Record<string, unknown>[] | OperationsReason {
  if (source.truncated === true) return "source_truncated";
  if (!Array.isArray(source.payload) || !source.payload.every(object)) return "source_malformed";
  if (source.payload.length > MAX_ROWS) return "source_truncated";
  return source.payload;
}
function databaseItem(category: "queue" | "task_failure" | "quote_attention", source: SourceObservation | null | undefined, now: number): OperationsItem {
  const failure = sourceProblem(source, now);
  if (failure || !source) return base(category, now, failure ?? "source_unavailable");
  const data = rows(source);
  if (typeof data === "string") return base(category, now, data);
  const validTime = (value: unknown) => operationsTimestamp(value) !== null && operationsTimestamp(value)! <= now;
  if (data.some((row) => !validTime(row.created_at) || !validTime(row.updated_at))) return base(category, now, "source_malformed");
  let reason: OperationsReason;
  let severity: OperationsSeverity = "healthy";
  if (category === "queue") {
    if (data.some((r) => !oneOf(r.status, ["queued", "running"]) || !oneOf(r.task_type, OPERATIONS_TASK_TYPES) || !Number.isSafeInteger(r.attempts) || (r.attempts as number) < 0 || operationsTimestamp(r.available_at) === null || (r.locked_at !== null && !validTime(r.locked_at)))) return base(category, now, "source_malformed");
    const stuck = data.some((r) => (r.status === "running" || operationsTimestamp(r.available_at)! <= now) && now - operationsTimestamp(r.locked_at ?? r.available_at)! >= 15 * 60_000);
    reason = !data.length ? "queue_clear" : stuck ? "task_stuck" : data.every((r) => r.status === "queued" && operationsTimestamp(r.available_at)! > now) ? "scheduled_work" : data.some((r) => r.status === "queued") ? "queued_work" : "task_active";
    severity = stuck ? "blocked" : reason === "queued_work" ? "attention" : "healthy";
  } else if (category === "task_failure") {
    if (data.some((r) => !oneOf(r.status, ["failed", "queued"]) || !oneOf(r.task_type, OPERATIONS_TASK_TYPES) || !oneOf(r.failureCode, FAILURE_CODES) || (r.provider !== null && !provider(r.provider)) || now - operationsTimestamp(r.updated_at)! > FAILURE_WINDOW)) return base(category, now, "source_malformed");
    reason = data.length ? "repeated_failures" : "no_recent_failures";
    severity = data.length ? "attention" : "healthy";
  } else {
    if (data.some((r) => r.status !== "awaiting_vendor_manual_review")) return base(category, now, "source_malformed");
    reason = data.length ? "manual_followup" : "no_manual_followup";
    severity = data.length ? "attention" : "healthy";
  }
  const result = observed(base(category, now), source, now, reason, severity, data.length);
  return result;
}
function extractionItem(source: SourceObservation | null | undefined, now: number): OperationsItem {
  const failed = sourceProblem(source, now);
  if (failed || !source) return base("extraction_quality", now, failed ?? "source_unavailable");
  const data = rows(source);
  if (typeof data === "string") return base("extraction_quality", now, data);
  if (!data.length) return base("extraction_quality", now, "evaluation_unknown");
  for (const row of data) {
    const time = operationsTimestamp(row.created_at);
    if (time === null || time > now || !oneOf(row.alert_type, ["model_fallback_rate_high", "auto_approve_rate_low"])
      || typeof row.metric_value !== "number" || !Number.isFinite(row.metric_value) || row.metric_value < 0 || row.metric_value > 1
      || typeof row.threshold_value !== "number" || !Number.isFinite(row.threshold_value) || row.threshold_value < 0 || row.threshold_value > 1
      || typeof row.alert_day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.alert_day)
      || operationsTimestamp(`${row.alert_day}T00:00:00.000Z`) === null || row.alert_day > new Date(now).toISOString().slice(0, 10)
      || (row.alert_type === "model_fallback_rate_high" ? row.metric_value <= row.threshold_value : row.metric_value >= row.threshold_value)) return base("extraction_quality", now, "source_malformed");
    if (now - time > 2 * FAILURE_WINDOW) return base("extraction_quality", now, "source_stale");
  }
  return observed(base("extraction_quality", now), source, now, "extraction_alert", "attention", data.length);
}
function capabilityItems(source: SourceObservation | null | undefined, now: number): OperationsItem[] {
  const failed = sourceProblem(source, now);
  if (failed || !source) return [base("upload_capability", now, failed ?? "source_unavailable")];
  if (!Array.isArray(source.payload) || !source.payload.length || source.payload.length > OPERATIONS_PROVIDERS.length) return [base("upload_capability", now, "policy_invalid")];
  const seen = new Set<string>();
  return source.payload.map((raw) => {
    if (!object(raw) || !object(raw.metadata) || !Array.isArray(raw.reviewedMetadata)) return base("upload_capability", now, "source_malformed");
    const vendor = provider(raw.metadata.provider);
    if (!vendor || seen.has(vendor)) throw new Error("malformed provider projection");
    seen.add(vendor);
    const projection = projectCapabilityAttention({ metadata: raw.metadata, reviewedMetadata: raw.reviewedMetadata as CapabilityAttentionMetadata[], evidence: raw.evidence, previous: null, now: new Date(now).toISOString() });
    const item = base("upload_capability", now, "source_malformed", vendor);
    if (projection.state !== "projected") return item;
    const p = projection.item;
    if (p.freshness !== "current" || !p.observedAt || !p.expiresAt) return { ...item, reasonCode: p.reasonCode, summary: OPERATIONS_SUMMARIES[p.reasonCode], freshness: { ...item.freshness, state: p.freshness === "stale" ? "stale" : "unknown" } };
    return { ...observed(item, source, now, p.reasonCode, p.severity, null, p.observedAt, operationsTimestamp(p.expiresAt)! - operationsTimestamp(p.observedAt)!),
      context: { ...item.context, build: isOperationsVersion(p.metadata.workerBuild) ? p.metadata.workerBuild : null, adapterVersion: isOperationsVersion(p.metadata.adapterRevision) ? p.metadata.adapterRevision : null } };
  });
}
function failureItems(source: SourceObservation | null | undefined, now: number): OperationsItem[] {
  const aggregate = databaseItem("task_failure", source, now);
  if (!source || aggregate.severity === "unknown" || !Array.isArray(source.payload) || source.payload.length === 0) return [aggregate];
  const providers = [...new Set(source.payload.map((row) => provider(row.provider)))];
  return providers.map((vendor) => {
    const group = source.payload as Record<string, unknown>[];
    const item = databaseItem("task_failure", { ...source, payload: group.filter((row) => provider(row.provider) === vendor) }, now);
    return { ...item, provider: vendor, key: `task_failure:${vendor ?? item.subsystem}` };
  });
}
export function projectOperations(sources: Partial<Record<SourceName, SourceObservation | null>>, now: number) {
  const isolate = (categories: OperationsCategory[], project: () => OperationsItem[]) => {
    try { return project(); } catch { return categories.map((category) => base(category, now, "source_malformed")); }
  };
  const items = [
    ...isolate(["worker", "runtime", "provider_session"], () => workerItems(sources.worker, now)),
    ...isolate(["queue"], () => [databaseItem("queue", sources.queue, now)]),
    ...isolate(["task_failure"], () => failureItems(sources.failures, now)),
    ...isolate(["quote_attention"], () => [databaseItem("quote_attention", sources.quotes, now)]),
    ...isolate(["extraction_quality"], () => [extractionItem(sources.extraction, now)]),
    ...isolate(["upload_capability"], () => capabilityItems(sources.capability, now)),
    base("spend", now, "spend_control"),
  ];
  if (!OPERATIONS_CATEGORIES.every((category) => items.some((item) => item.category === category))) throw new Error("incomplete categories");
  return parseOperationsSnapshot({ schema: OPERATIONS_SCHEMA, generatedAt: new Date(now).toISOString(), refreshAfterMs: OPERATIONS_REFRESH_MS,
    items, counts: Object.fromEntries(["healthy", "attention", "blocked", "unknown"].map((severity) => [severity, items.filter((item) => item.severity === severity).length])) });
}
