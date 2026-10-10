import { createHash } from "node:crypto";
import {
  decideProviderUploadCapability,
  normalizeProviderUploadExtensions,
  normalizeProviderUploadMimeTypes,
  PROVIDER_UPLOAD_CAPABILITY_CONTRACT_VERSION,
} from "./providerUploadCapability.js";
import type { CapabilityRecordInput } from "./providerUploadCapabilityPersistence.js";
import type { VendorName } from "./types.js";
import type {
  ProviderUploadCapabilityAdmissionResolverResult,
  ProviderUploadCapabilityDecision,
  ProviderUploadCapabilityEnvelope,
} from "./providerUploadCapabilityTypes.js";

/** Planning policy only: this module cannot install, enable, or execute a canary. */
export const CANARY_PLANNING_POLICY = "capability-canary-offline.v1" as const;
type Scope = Pick<CapabilityRecordInput, "provider" | "route" | "surface" | "revision">;
export type CanaryReviewedEnvelope = ProviderUploadCapabilityEnvelope & Scope;
export type CanaryPlanInput = {
  enabled: false;
  scope: Scope;
  probeMode: "capability_inspection_no_upload";
  startAt: string;
  intervalSeconds: number;
  windowCount: number;
  timeoutSeconds: number;
};
export type CanaryObservationInput = Pick<CapabilityRecordInput,
  "provider" | "route" | "surface" | "revision" | "state" | "extensions" |
  "mimeTypes" | "acceptAttributePresent" | "observedAt" | "expiresAt" | "observationRevision"
> & { windowIndex: number };
export type CanaryPlan = {
  policyRevision: typeof CANARY_PLANNING_POLICY;
  enabled: false;
  probeMode: CanaryPlanInput["probeMode"];
  releaseEnvelope: CanaryReviewedEnvelope;
  timeoutSeconds: number;
  taskCount: 1;
  parallelism: 1;
  taskRetries: 0;
  schedulerRetries: 0;
  maxObservationsPerWindow: 1;
  cpu: 1;
  memoryMiB: 512;
  endAt: string;
  windows: { index: number; startAt: string; endAt: string; idempotencyKey: string }[];
};
type Refusal = { state: "disabled" } | { state: "invalid_configuration" };
export type CanaryPlanResult = Refusal | { state: "prepared_plan"; plan: CanaryPlan };
export type CanaryObservationResult = Refusal | { state: "invalid_observation" } | {
  state: "prepared_observation";
  candidate: CapabilityRecordInput;
  decision: ProviderUploadCapabilityDecision;
};

const SCOPE_KEYS = ["provider", "route", "surface", "revision"];
const ENVELOPE_KEYS = [...SCOPE_KEYS, "extensions", "policyRevision", "evidenceReference"];
const PLAN_KEYS = ["enabled", "scope", "probeMode", "startAt", "intervalSeconds", "windowCount", "timeoutSeconds"];
const OBSERVATION_KEYS = [...SCOPE_KEYS, "state", "extensions", "mimeTypes", "acceptAttributePresent",
  "observedAt", "expiresAt", "observationRevision", "windowIndex"];
const SLUG = /^[a-z][a-z0-9._-]{0,79}$/;
// Identity vocabulary only; inclusion never means reviewed, enabled or admitted.
const PROVIDER_IDENTITIES: Record<VendorName, true> = {
  xometry: true, fictiv: true, protolabs: true, sendcutsend: true, oshcut: true,
  fabworks: true, ponoko: true, quickparts: true, rapiddirect: true, geomiq: true,
  weerg: true, protolabsnetwork: true, partsbadger: true, fastdms: true,
  devzmanufacturing: true, infraredlaboratories: true, emachineshop: true, rmfg: true,
};
const STATES = new Set<CapabilityRecordInput["state"]>([
  "fresh", "loading", "route_or_selector_drift", "authentication_required",
  "anti_bot_or_challenge", "provider_error", "unclassified_response", "ambiguous",
]);

/** Closed JSON-like records: reject accessors rather than invoking them. */
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true;
  });
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : null;
}

function scope(value: unknown): value is Scope {
  return record(value, SCOPE_KEYS) && typeof value.provider === "string" && Object.hasOwn(PROVIDER_IDENTITIES, value.provider)
    && SCOPE_KEYS.every((key) => typeof value[key] === "string" && SLUG.test(value[key] as string));
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.provider === right.provider && left.route === right.route && left.surface === right.surface && left.revision === right.revision;
}

function tokens(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 32 || Reflect.ownKeys(value).length !== value.length + 1) return false;
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    return descriptor && "value" in descriptor && typeof descriptor.value === "string" && descriptor.value.length <= 255;
  }).every(Boolean);
}

function reviewedEnvelope(value: unknown): value is CanaryReviewedEnvelope {
  if (!record(value, ENVELOPE_KEYS) || typeof value.provider !== "string" || !Object.hasOwn(PROVIDER_IDENTITIES, value.provider)
    || !SCOPE_KEYS.every((key) => typeof value[key] === "string" && SLUG.test(value[key] as string))
    || typeof value.policyRevision !== "string" || !SLUG.test(value.policyRevision)
    || typeof value.evidenceReference !== "string" || !/^OVD-[1-9]\d{0,9}$/.test(value.evidenceReference)
    || !tokens(value.extensions) || value.extensions.length === 0) return false;
  normalizeProviderUploadExtensions(value.extensions);
  return true;
}

function windowKey(identity: Scope, startAt: string): string {
  const tuple = [CANARY_PLANNING_POLICY, PROVIDER_UPLOAD_CAPABILITY_CONTRACT_VERSION,
    identity.provider, identity.route, identity.surface, identity.revision, startAt];
  return `canary:${createHash("sha256").update(JSON.stringify(tuple)).digest("hex")}`;
}

/** Return inert planning data only. No enablement, scheduler, probe or timer exists. */
export function prepareCapabilityCanaryPlan(
  input: unknown,
  reviewed: readonly CanaryReviewedEnvelope[],
): CanaryPlanResult {
  try {
    if (input === undefined || record(input, []) || (record(input, ["enabled"]) && input.enabled === false)) return { state: "disabled" };
    if (!record(input, PLAN_KEYS) || input.enabled !== false || !scope(input.scope)
      || input.probeMode !== "capability_inspection_no_upload"
      || !integer(input.intervalSeconds, 3600, 86400) || !integer(input.windowCount, 1, 24)
      || input.intervalSeconds * input.windowCount > 86400 || !integer(input.timeoutSeconds, 1, 60)) return { state: "invalid_configuration" };
    const start = timestamp(input.startAt);
    if (start === null || !Array.isArray(reviewed) || reviewed.length === 0 || reviewed.length > 32
      || !reviewed.every(reviewedEnvelope)) return { state: "invalid_configuration" };
    const matches = reviewed.filter((entry) => sameScope(entry, input.scope as Scope));
    if (matches.length !== 1) return { state: "invalid_configuration" };
    const releaseEnvelope = { ...matches[0], extensions: normalizeProviderUploadExtensions(matches[0].extensions) };
    const interval = input.intervalSeconds * 1000;
    const windows = Array.from({ length: input.windowCount }, (_, index) => {
      const startAt = new Date(start + interval * index).toISOString();
      return { index, startAt, endAt: new Date(start + interval * (index + 1)).toISOString(), idempotencyKey: windowKey(releaseEnvelope, startAt) };
    });
    // A four-digit UTC timestamp keeps candidates compatible with the ledger contract.
    const endAt = windows[windows.length - 1].endAt;
    if (timestamp(endAt) === null) return { state: "invalid_configuration" };
    return { state: "prepared_plan", plan: {
      policyRevision: CANARY_PLANNING_POLICY, enabled: false, probeMode: input.probeMode,
      releaseEnvelope, timeoutSeconds: input.timeoutSeconds,
      taskCount: 1, parallelism: 1, taskRetries: 0, schedulerRetries: 0,
      maxObservationsPerWindow: 1, cpu: 1, memoryMiB: 512, endAt, windows,
    } };
  } catch {
    return { state: "invalid_configuration" };
  }
}

function observationValid(value: unknown, plan: CanaryPlan, now: number): value is CanaryObservationInput {
  if (!record(value, OBSERVATION_KEYS) || !sameScope(value as unknown as Scope, plan.releaseEnvelope)
    || !STATES.has(value.state as CapabilityRecordInput["state"])
    || !tokens(value.extensions) || !tokens(value.mimeTypes)
    || !integer(value.observationRevision, 1, Number.MAX_SAFE_INTEGER)
    || !integer(value.windowIndex, 0, plan.windows.length - 1)
    || !Number.isSafeInteger(now) || Math.abs(now) > 8640000000000000) return false;
  const observed = timestamp(value.observedAt), expires = timestamp(value.expiresAt);
  const window = plan.windows[value.windowIndex];
  if (observed === null || expires === null || observed > now || expires <= now || expires <= observed
    || expires - observed > 3600000 || observed < Date.parse(window.startAt) || observed >= Date.parse(window.endAt)) return false;
  if (value.state === "fresh") return typeof value.acceptAttributePresent === "boolean";
  return value.acceptAttributePresent === null && value.extensions.length === 0 && value.mimeTypes.length === 0;
}

/** Project supplied evidence without acquiring it or calling the existing record RPC. */
export function prepareCapabilityCanaryObservation(
  config: unknown,
  reviewed: readonly CanaryReviewedEnvelope[],
  input: unknown,
  admission: ProviderUploadCapabilityAdmissionResolverResult,
  now: number,
): CanaryObservationResult {
  const prepared = prepareCapabilityCanaryPlan(config, reviewed);
  if (prepared.state !== "prepared_plan") return prepared;
  try {
    const plan = prepared.plan;
    if (!observationValid(input, plan, now)) return { state: "invalid_observation" };
    const extensions = normalizeProviderUploadExtensions(input.extensions);
    const mimeTypes = normalizeProviderUploadMimeTypes(input.mimeTypes);
    // Match the persistence contract's token-size limits as well as its vocabulary.
    if (extensions.some((token) => token.length > 32)
      || mimeTypes.some((token) => token.split("/").some((part) => part.length > 127))) return { state: "invalid_observation" };
    const candidate: CapabilityRecordInput = {
      provider: input.provider, route: input.route, surface: input.surface, revision: input.revision,
      state: input.state, extensions, mimeTypes, acceptAttributePresent: input.acceptAttributePresent,
      observedAt: input.observedAt, expiresAt: input.expiresAt, observationRevision: input.observationRevision,
      actorKind: "scheduled_canary", sourceKind: "scheduled_canary", sourceVersion: CANARY_PLANNING_POLICY,
      evidenceReference: "issue:OVD-415", idempotencyKey: plan.windows[input.windowIndex].idempotencyKey,
    };
    const decision = decideProviderUploadCapability({
      releaseEnvelope: plan.releaseEnvelope, admissionResolver: admission, nowMs: now,
      observed: { provider: candidate.provider, route: candidate.route, surface: candidate.surface, revision: candidate.revision,
        state: candidate.state, extensions, mimeTypes, acceptAttributePresent: candidate.acceptAttributePresent === true,
        evidenceRefs: ["issue:OVD-415"] },
    });
    // Only the closed classification payload is returned; never admission/session data.
    return { state: "prepared_observation", candidate, decision };
  } catch {
    return { state: "invalid_observation" };
  }
}
