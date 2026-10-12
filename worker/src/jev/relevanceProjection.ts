import { types as nodeTypes } from "node:util";
import {
  doesObservedXometryPresentationBelongToDocument,
  isObservedXometryPresentation,
  isObservedXometryQuoteDocument,
} from "../adapters/xometryOffers.js";

/**
 * Local presentation evidence only. These constructors belong at observed-evidence
 * hooks, after the observation exists; they neither establish its provenance nor
 * authorize disclosure. Keep the complete observation, including local bindings.
 * Never pass these handles to a model, audit receipt, or customer publication.
 */
export type RelevanceOrigin =
  | "approved_requirement"
  | "authorization"
  | "provider_quote"
  | "provider_catalog"
  | "provider_presentation"
  | "unknown"
  | "suspicious";

export type ImmutableEvidence<T> = T extends readonly (infer Item)[]
  ? readonly ImmutableEvidence<Item>[]
  : T extends object ? { readonly [Key in keyof T]: ImmutableEvidence<T[Key]> } : T;

declare const evidenceHandle: unique symbol;

export type RelevanceEvidence<T extends object = object> = Readonly<{
  [evidenceHandle]: true;
  id: string;
  origin: RelevanceOrigin;
  localOnly: true;
  disclosureAuthority: "none";
  observation: ImmutableEvidence<T>;
}>;

const capturedEvidence = new WeakSet<object>();
const observedQuoteDocuments = new WeakMap<object, object>();
const optionalOrigins = new WeakMap<object, Readonly<{
  observation: object; parentEvidenceId: string; start: number; end: number; text: string;
}>>();

/** Never invoke caller array methods, accessors, iterators or species hooks. */
function snapshotDenseArray(value: unknown): unknown[] {
  if (nodeTypes.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error("invalid_array");
  }
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) {
    throw new Error("invalid_array");
  }
  // Exact own keys reject holes and additional map/some/iterator/constructor hooks.
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length.value + 1) throw new Error("invalid_array");
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index += 1) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry?.enumerable || !("value" in entry)) throw new Error("invalid_array");
    result.push(entry.value);
  }
  return result;
}

/** Detach without JSON coercion, invoking getters, or dropping unknown fields. */
function copyObservation(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || nodeTypes.isProxy(value) || ancestors.has(value)) throw new Error("relevance_invalid_observation");
  const array = Array.isArray(value);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error("relevance_invalid_observation");
  }
  ancestors.add(value);
  if (array) {
    const entries = snapshotDenseArray(value);
    const copy: unknown[] = [];
    for (let index = 0; index < entries.length; index += 1) copy.push(copyObservation(entries[index], ancestors));
    ancestors.delete(value);
    return Object.freeze(copy);
  }
  const copy: object = Object.create(prototype as object | null) as object;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) throw new Error("relevance_invalid_observation");
    Object.defineProperty(copy, key, {
      value: copyObservation(descriptor.value, ancestors), enumerable: true,
    });
  }
  ancestors.delete(value);
  return Object.freeze(copy);
}

function capture<T extends object>(id: string, observation: T, origin: RelevanceOrigin): RelevanceEvidence<T> {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(id)) throw new Error("relevance_invalid_id");
  if (!observation || typeof observation !== "object") throw new Error("relevance_invalid_observation");
  let detached: ImmutableEvidence<T>;
  try { detached = copyObservation(observation) as ImmutableEvidence<T>; }
  catch { throw new Error("relevance_invalid_observation"); }
  const handle = Object.freeze({
    id, origin, localOnly: true as const, disclosureAuthority: "none" as const,
    observation: detached,
  }) as RelevanceEvidence<T>;
  capturedEvidence.add(handle);
  return handle;
}

// Named code-owned entry points prevent payload labels from classifying origins.
// Calling a constructor is not proof of authorization/approval of its contents.
export function captureRequirementRelevanceEvidence<T extends object>(id: string, observation: T) {
  return capture(id, observation, "approved_requirement");
}

export function captureAuthorizationRelevanceEvidence<T extends object>(id: string, observation: T) {
  return capture(id, observation, "authorization");
}

export function captureQuoteRelevanceEvidence<T extends object>(id: string, observation: T) {
  const handle = capture(id, observation, "provider_quote");
  if (isObservedXometryQuoteDocument(observation) && id === observation.evidenceId) {
    observedQuoteDocuments.set(handle, observation);
  }
  return handle;
}

export function captureCatalogRelevanceEvidence<T extends object>(id: string, observation: T) {
  return capture(id, observation, "provider_catalog");
}

export function captureUnknownRelevanceEvidence<T extends object>(id: string, observation: T) {
  return capture(id, observation, "unknown");
}

export function captureSuspiciousRelevanceEvidence<T extends object>(id: string, observation: T) {
  return capture(id, observation, "suspicious");
}

/**
 * Only the actual provider collector can authenticate this badge origin. Merely
 * copying its string labels (or serializing a real record) cannot grant removal.
 * This classifies the separate exact badge span, never the parent quote text.
 */
export function captureObservedPresentationRelevanceEvidence<T extends object>(id: string, observation: T) {
  if (!isObservedXometryPresentation(observation)
    || id !== observation.evidenceId
    || observation.origin !== "xometry_tier_presentation_badge"
    || observation.optionalCategory !== "marketing"
    || observation.selector !== '[data-testid="tierAndLeadTime"]'
    || observation.field !== "tierText"
    || !["Least Expensive", "Fastest", "Best Value"].includes(observation.text)) {
    return captureUnknownRelevanceEvidence(id, observation);
  }
  const handle = capture(id, observation, "provider_presentation");
  optionalOrigins.set(handle, Object.freeze({
    observation,
    parentEvidenceId: observation.parentEvidenceId,
    start: observation.start, end: observation.end, text: observation.text,
  }));
  return handle;
}

export type RelevanceProjection = Readonly<{
  localOnly: true;
  disclosureAuthority: "none";
  publicationAllowed: false;
  sourceEvidence: readonly RelevanceEvidence[];
  retained: readonly RelevanceEvidence[];
  optionalCandidates: readonly RelevanceEvidence[];
  proposedExcludedIds: readonly string[];
  optionalClassification: "available" | "unavailable_no_observed_optional_origin";
}>;

/**
 * Preserve complete source evidence and veto unsafe presentation exclusions.
 *
 * Only separately observed exact Xometry presentation badges currently establish
 * an optional origin. Their complete parent quote must be present and retained.
 * No observed optional navigation or social origin is established here. Unknown
 * text remains protected without relying on a constraint-keyword blacklist.
 */
export function projectRelevanceEvidence(
  evidence: readonly RelevanceEvidence[],
  proposedExcludedIds: readonly string[] = [],
): RelevanceProjection {
  let entries: unknown[];
  let proposedIds: unknown[];
  try {
    entries = snapshotDenseArray(evidence);
    proposedIds = snapshotDenseArray(proposedExcludedIds);
  } catch { throw new Error("relevance_invalid_projection"); }
  const proposed = new Set<string>();
  for (const id of proposedIds) {
    if (typeof id !== "string") throw new Error("relevance_invalid_projection");
    proposed.add(id);
  }
  const ids = new Set<string>();
  const sourceEvidence: RelevanceEvidence[] = [];
  for (const value of entries) {
    if (typeof value !== "object" || value === null || !capturedEvidence.has(value)) throw new Error("relevance_untrusted_handle");
    const item = value as RelevanceEvidence;
    if (ids.has(item.id)) throw new Error("relevance_duplicate_id");
    ids.add(item.id);
    sourceEvidence.push(item);
  }
  const optionalCandidates = sourceEvidence.filter((item) => {
    const origin = optionalOrigins.get(item);
    if (!origin) return false;
    const parent = sourceEvidence.find((candidate) => candidate.id === origin.parentEvidenceId
      && candidate.origin === "provider_quote");
    const originalParent = parent && observedQuoteDocuments.get(parent);
    if (!originalParent || !doesObservedXometryPresentationBelongToDocument(origin.observation, originalParent)) return false;
    const parentObservation = parent?.observation as { tierText?: unknown } | undefined;
    return typeof parentObservation?.tierText === "string"
      && Number.isSafeInteger(origin.start) && Number.isSafeInteger(origin.end)
      && origin.start >= 0 && origin.end > origin.start
      && parentObservation.tierText.slice(origin.start, origin.end) === origin.text;
  });
  const excluded = new Set(optionalCandidates.filter((item) => proposed.has(item.id)).map((item) => item.id));
  return Object.freeze({
    localOnly: true,
    disclosureAuthority: "none",
    publicationAllowed: false,
    sourceEvidence: Object.freeze(sourceEvidence),
    retained: Object.freeze(sourceEvidence.filter((item) => !excluded.has(item.id))),
    optionalCandidates: Object.freeze(optionalCandidates),
    proposedExcludedIds: Object.freeze([...excluded]),
    optionalClassification: optionalCandidates.length ? "available" : "unavailable_no_observed_optional_origin",
  });
}
