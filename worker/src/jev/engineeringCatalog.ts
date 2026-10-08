import { types as nodeTypes } from "node:util";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { CatalogInput } from "../quoteIntelligence/catalog.js";
import type { OperationalJevScope } from "./operationalSession.js";
import type { XometryCatalogObservation } from "./providerObservations.js";
import type { RequirementProvenanceBinding, RequirementProvenanceProjection } from "./requirementProvenance.js";

export type EngineeringCatalogInput = Readonly<{
  scope: OperationalJevScope;
  requirement: RequirementProvenanceProjection;
  expectedRequirement: RequirementProvenanceBinding;
  observations: readonly XometryCatalogObservation[];
  now: number;
}>;

/** Reviewed identity semantics, not a claim that every DOM id is a catalog ID. */
export type EngineeringCatalogNamespace = Readonly<{
  namespace: string;
  field: "material" | "finish";
  attributeName: "data-option-id" | "value" | "id";
  controlSelector: string;
  optionSelector: string;
}>;
export type EngineeringCatalogOption = Readonly<{
  id: string;
  /** This joint tuple comes from the reviewed catalog, never capability products. */
  fields: Readonly<{ material: string; process: string; finish: string; tightestToleranceInch?: number }>;
  observedBindings: readonly Readonly<{ namespace: string; observedId: string }>[];
  applicability?: Readonly<{ quantities?: readonly number[]; revisions?: readonly (string | null)[] }>;
}>;
export type EngineeringMaterialEquivalenceApproval = Readonly<{
  approvalId: string;
  scope: OperationalJevScope;
  requirementBinding: RequirementProvenanceBinding;
  catalogId: string;
  catalogRevision: string;
  optionId: string;
  requestedMaterial: string;
  equivalentMaterial: string;
  expiresAt: number;
}>;
export type EngineeringCatalogArtifact = Readonly<{
  contract: "jev-engineering-catalog.v1";
  provider: "xometry";
  catalogId: string;
  catalogRevision: string;
  scope: OperationalJevScope;
  requirementBinding: RequirementProvenanceBinding;
  issuedAt: number;
  expiresAt: number;
  source: Readonly<{
    identity: string; sha256: string; schemaRevision: string;
    collection: "observed_configuration"; completeness: "complete" | "incomplete";
    candidateCount: number; observationsSha256: string;
  }>;
  namespaces: readonly EngineeringCatalogNamespace[];
  options: readonly EngineeringCatalogOption[];
  materialEquivalenceApprovals: readonly EngineeringMaterialEquivalenceApproval[];
}>;

/**
 * Separate trusted host capability, supplied by composition code, never read from
 * caller input. It must issue a reviewed current catalog for the exact captured
 * observations and approved requirement. It is a synchronous local operation.
 * This type/function signature authenticates nothing by itself. The host owns
 * source authentication, actual-observation provenance and review of namespace
 * semantics/joint tuples/material-equivalence approval. No such current Xometry
 * artifact/issuer exists in maintained sources; synthetic issuers test only this
 * boundary. A schema-valid artifact is not live compatibility or disclosure proof.
 */
export type EngineeringCatalogIssueContext = EngineeringCatalogInput & Readonly<{ observationsSha256: string }>;
export type EngineeringCatalogAuthority = (context: EngineeringCatalogIssueContext) => unknown;

export const ENGINEERING_CATALOG_LIMITS = Object.freeze({
  options: 62, observations: 64, namespaces: 16, depth: 16,
  nodes: 20_000, objectKeys: 128, arrayEntries: 1000,
  stringCodeUnits: 65_536, totalStringCodeUnits: 262_144,
});
export type EngineeringCatalogUnavailableReason =
  | "catalog_authority_missing" | "catalog_authority_unavailable" | "invalid_input"
  | "requirement_unavailable" | "requirement_binding_mismatch" | "engineering_fields_missing"
  | "invalid_catalog_artifact" | "catalog_scope_mismatch" | "catalog_expired"
  | "catalog_incomplete"
  | "observed_binding_missing" | "observed_binding_ambiguous" | "catalog_applicability_mismatch"
  | "material_equivalence_unbound";
type LocalFlags = Readonly<{ localOnly: true; disclosureAuthority: "none"; publicationAllowed: false }>;
export type EngineeringCatalogProjection = (LocalFlags & Readonly<{
  status: "available";
  candidateScope: "observed_configuration";
  /** Only this ordinal packet may be considered for separately admitted inference. */
  catalogInput: CatalogInput;
  /** Complete detached source, never a model/audit/publication packet. */
  localEvidence: Readonly<{
    input: EngineeringCatalogInput;
    artifact: EngineeringCatalogArtifact;
    optionBindings: readonly Readonly<{ modelOptionId: string; catalogOptionId: string }>[];
  }>;
}>) | (LocalFlags & Readonly<{ status: "unavailable"; reason: EngineeringCatalogUnavailableReason }>);

const flags = { localOnly: true, disclosureAuthority: "none", publicationAllowed: false } as const;
const text = z.string().min(1).max(4096).refine((value) => value.trim().length > 0);
const id = z.string().min(1).max(128);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const quantity = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const scopeSchema = z.object({ organizationId: id, taskId: id, quoteRunId: id,
  provider: z.literal("xometry"), sourceRevision: z.string().regex(/^[a-f0-9]{40}$/) }).strict();
const bindingSchema = z.object({ requirementId: id, partId: id, revision: text.nullable(),
  updatedAt: z.string().max(64).datetime({ offset: true }), requestedQuantity: quantity }).strict();
const observedSchema = z.object({
  kind: z.literal("catalog"), provider: z.literal("xometry"), field: z.enum(["material", "finish"]),
  controlSelector: text, optionSelector: text, label: z.string().max(65_536).nullable(),
  attributes: z.record(z.string().max(16_384)), deterministicTerm: text,
  catalogStatus: z.literal("unavailable"), reason: z.literal("custom_widget_engineering_catalog_unavailable"),
}).strict();
const inputSchema = z.object({ scope: scopeSchema, expectedRequirement: bindingSchema,
  requirement: z.unknown(), observations: z.array(observedSchema).min(1).max(64), now: time }).strict();
const fact = (source: string, value: z.ZodTypeAny) => z.union([
  z.object({ state: z.literal("observed"), source: z.literal(source), value }).strict(),
  z.object({ state: z.enum(["missing", "invalid"]), source: z.literal(source) }).strict(),
]);
const requirementSchema = z.object({
  status: z.literal("available"), contract: z.literal("jev-requirement-provenance.v1"),
  localOnly: z.literal(true), disclosureAuthority: z.literal("none"), binding: bindingSchema,
  approvedQuantities: z.array(quantity).min(1).max(1000),
  fields: z.object({
    material: fact("approved_part_requirements.material", text),
    process: fact("approved_part_requirements.spec_snapshot.process", text),
    finish: fact("approved_part_requirements.finish", text),
    revision: fact("approved_part_requirements.revision", text),
    tightestToleranceInch: fact("approved_part_requirements.tightest_tolerance_inch", z.number().finite().positive()),
  }).strict(),
  clarification: z.unknown(), humanApproval: z.literal("unavailable"),
  catalogIdentity: z.literal("unavailable"), equivalenceApproval: z.literal("unavailable"),
}).strict();
const namespaceSchema = z.object({ namespace: id, field: z.enum(["material", "finish"]),
  attributeName: z.enum(["data-option-id", "value", "id"]), controlSelector: text, optionSelector: text }).strict();
const artifactSchema = z.object({
  contract: z.literal("jev-engineering-catalog.v1"), provider: z.literal("xometry"),
  catalogId: id, catalogRevision: id, scope: scopeSchema, requirementBinding: bindingSchema,
  issuedAt: time, expiresAt: time, namespaces: z.array(namespaceSchema).min(2).max(16),
  source: z.object({ identity: id, sha256: z.string().regex(/^[a-f0-9]{64}$/), schemaRevision: id,
    collection: z.literal("observed_configuration"), completeness: z.enum(["complete", "incomplete"]),
    candidateCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    observationsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  options: z.array(z.object({ id,
    fields: z.object({ material: text, process: text, finish: text,
      tightestToleranceInch: z.number().finite().positive().optional() }).strict(),
    observedBindings: z.array(z.object({ namespace: id, observedId: id }).strict()).length(2),
    applicability: z.object({ quantities: z.array(quantity).min(1).max(1000).optional(),
      revisions: z.array(text.nullable()).min(1).max(1000).optional() }).strict().optional(),
  }).strict()).min(1).max(62),
  materialEquivalenceApprovals: z.array(z.object({
    approvalId: id, scope: scopeSchema, requirementBinding: bindingSchema, catalogId: id, catalogRevision: id,
    optionId: id, requestedMaterial: text, equivalentMaterial: text, expiresAt: time,
  }).strict()).max(62),
}).strict();

/** Bounded own-data snapshot: no source methods, accessors, proxies or truncation. */
function snapshot<T>(input: T): T {
  const active = new WeakSet<object>();
  let nodes = 0;
  let stringUnits = 0;
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > ENGINEERING_CATALOG_LIMITS.nodes || depth > ENGINEERING_CATALOG_LIMITS.depth) throw new Error("limit");
    if (typeof value === "string") {
      stringUnits += value.length;
      if (value.length > ENGINEERING_CATALOG_LIMITS.stringCodeUnits || stringUnits > ENGINEERING_CATALOG_LIMITS.totalStringCodeUnits) throw new Error("limit");
      return value;
    }
    if (value === null || value === undefined || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
    if (typeof value !== "object" || nodeTypes.isProxy(value) || active.has(value)) throw new Error("data");
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("data");
    const keys = Reflect.ownKeys(value);
    active.add(value);
    const output: object = array ? [] : Object.create(null) as object;
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, "length")?.value as unknown;
      if (typeof length !== "number" || length > ENGINEERING_CATALOG_LIMITS.arrayEntries || keys.length !== length + 1) throw new Error("data");
      for (let index = 0; index < length; index += 1) {
        const item = Object.getOwnPropertyDescriptor(value, String(index));
        if (!item?.enumerable || !("value" in item)) throw new Error("data");
        (output as unknown[]).push(copy(item.value, depth + 1));
      }
    } else {
      if (keys.length > ENGINEERING_CATALOG_LIMITS.objectKeys) throw new Error("limit");
      for (const key of keys) {
        const item = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== "string" || !item?.enumerable || !("value" in item)) throw new Error("data");
        stringUnits += key.length;
        if (stringUnits > ENGINEERING_CATALOG_LIMITS.totalStringCodeUnits) throw new Error("limit");
        Object.defineProperty(output, key, { value: copy(item.value, depth + 1), enumerable: true });
      }
    }
    active.delete(value);
    return Object.freeze(output);
  };
  return copy(input, 0) as T;
}

const scopeKeys = ["organizationId", "taskId", "quoteRunId", "provider", "sourceRevision"] as const;
const bindingKeys = ["requirementId", "partId", "revision", "updatedAt", "requestedQuantity"] as const;
function sameScope(left: OperationalJevScope, right: OperationalJevScope) {
  return scopeKeys.every((key) => left[key] === right[key]);
}
function sameBinding(left: RequirementProvenanceBinding, right: RequirementProvenanceBinding) {
  return bindingKeys.every((key) => left[key] === right[key]);
}
function unavailable(reason: EngineeringCatalogUnavailableReason): EngineeringCatalogProjection {
  return Object.freeze({ status: "unavailable", reason, ...flags });
}

/** Pure advisory source prerequisite; never invokes matchCatalog or a model. */
export function projectEngineeringCatalog(input: EngineeringCatalogInput, trustedHost?: EngineeringCatalogAuthority): EngineeringCatalogProjection {
  let context: EngineeringCatalogInput;
  try {
    context = snapshot(input);
    if (!inputSchema.safeParse(context).success) return unavailable("invalid_input");
  } catch { return unavailable("invalid_input"); }
  const parsedRequirement = requirementSchema.safeParse(context.requirement);
  if (!parsedRequirement.success) return unavailable("requirement_unavailable");
  const requirement = parsedRequirement.data;
  if (!sameBinding(requirement.binding, context.expectedRequirement)
    || !requirement.approvedQuantities.includes(context.expectedRequirement.requestedQuantity)
    || new Set(requirement.approvedQuantities).size !== requirement.approvedQuantities.length) return unavailable("requirement_binding_mismatch");
  const revision = requirement.fields.revision;
  if (requirement.binding.revision === null ? revision.state !== "missing"
    : revision.state !== "observed" || revision.value !== requirement.binding.revision) return unavailable("requirement_binding_mismatch");
  const requested: Record<string, string | number | boolean> = {};
  for (const field of ["material", "process", "finish"] as const) {
    const entry = requirement.fields[field];
    if (entry.state !== "observed") return unavailable("engineering_fields_missing");
    requested[field] = entry.value as string;
  }
  const tolerance = requirement.fields.tightestToleranceInch;
  if (tolerance.state === "invalid") return unavailable("engineering_fields_missing");
  if (tolerance.state === "observed") requested.tightestToleranceInch = tolerance.value as number;
  if (!trustedHost) return unavailable("catalog_authority_missing");
  if (typeof trustedHost !== "function" || nodeTypes.isProxy(trustedHost) || nodeTypes.isAsyncFunction(trustedHost)) return unavailable("catalog_authority_unavailable");
  let artifact: EngineeringCatalogArtifact;
  // Canonical to this exact validated capture ordering, not a source trust claim.
  const observationsSha256 = createHash("sha256").update(JSON.stringify(context.observations)).digest("hex");
  try {
    const issued = trustedHost(Object.freeze({ ...context, observationsSha256 }));
    if (nodeTypes.isPromise(issued)) {
      // A mistaken async issuer cannot delay projection or leak a late rejection.
      void Promise.prototype.then.call(issued, () => undefined, () => undefined);
      return unavailable("catalog_authority_unavailable");
    }
    artifact = snapshot(issued) as EngineeringCatalogArtifact;
    if (!artifactSchema.safeParse(artifact).success) return unavailable("invalid_catalog_artifact");
  } catch { return unavailable("catalog_authority_unavailable"); }
  if (!sameScope(artifact.scope, context.scope) || !sameBinding(artifact.requirementBinding, context.expectedRequirement)) return unavailable("catalog_scope_mismatch");
  if (artifact.source.observationsSha256 !== observationsSha256) return unavailable("catalog_scope_mismatch");
  if (artifact.source.completeness !== "complete" || artifact.source.candidateCount !== artifact.options.length) return unavailable("catalog_incomplete");
  if (artifact.issuedAt > context.now || artifact.expiresAt <= context.now || artifact.expiresAt <= artifact.issuedAt) return unavailable("catalog_expired");
  const namespaces = new Map(artifact.namespaces.map((entry) => [entry.namespace, entry]));
  const options = new Map(artifact.options.map((entry) => [entry.id, entry]));
  if (namespaces.size !== artifact.namespaces.length || options.size !== artifact.options.length) return unavailable("invalid_catalog_artifact");
  for (const option of artifact.options) {
    // Missing compatibility evidence is unavailable, not evidence of no-match.
    if (requested.tightestToleranceInch !== undefined && option.fields.tightestToleranceInch === undefined) {
      return unavailable("engineering_fields_missing");
    }
    const observedFields = new Set<string>();
    for (const binding of option.observedBindings) {
      const namespace = namespaces.get(binding.namespace);
      if (!namespace || observedFields.has(namespace.field)) return unavailable("observed_binding_missing");
      observedFields.add(namespace.field);
      const matches = context.observations.filter((observation) => observation.field === namespace.field
        && observation.controlSelector === namespace.controlSelector && observation.optionSelector === namespace.optionSelector
        && Object.hasOwn(observation.attributes, namespace.attributeName)
        && observation.attributes[namespace.attributeName] === binding.observedId);
      if (!matches.length) return unavailable("observed_binding_missing");
      if (matches.length !== 1) return unavailable("observed_binding_ambiguous");
    }
    if (option.applicability?.quantities && !option.applicability.quantities.includes(context.expectedRequirement.requestedQuantity)) return unavailable("catalog_applicability_mismatch");
    if (option.applicability?.revisions && !option.applicability.revisions.includes(context.expectedRequirement.revision)) return unavailable("catalog_applicability_mismatch");
  }
  const equivalentIds = new Set<string>();
  const approvalIds = new Set<string>();
  for (const approval of artifact.materialEquivalenceApprovals) {
    const option = options.get(approval.optionId);
    if (!option || approvalIds.has(approval.approvalId) || equivalentIds.has(approval.optionId)
      || !sameScope(approval.scope, context.scope) || !sameBinding(approval.requirementBinding, context.expectedRequirement)
      || approval.catalogId !== artifact.catalogId || approval.catalogRevision !== artifact.catalogRevision
      || approval.requestedMaterial !== requested.material || approval.equivalentMaterial !== option.fields.material
      || approval.expiresAt <= context.now) return unavailable("material_equivalence_unbound");
    approvalIds.add(approval.approvalId);
    equivalentIds.add(approval.optionId);
  }
  // Field-specific maps preserve strict equality and primitive type, without
  // sending any source strings/numbers/labels/IDs into the matcher/model packet.
  const tokens = new Map<string, Map<string | number | boolean, string>>();
  const encode = (field: string, value: string | number | boolean): string => {
    let values = tokens.get(field);
    if (!values) { values = new Map(); tokens.set(field, values); }
    let token = values.get(value);
    if (!token) { token = `${field}_${values.size}`; values.set(value, token); }
    return token;
  };
  const minimizedRequested = Object.fromEntries(Object.entries(requested).map(([field, value]) => [field, encode(field, value)]));
  const optionBindings = artifact.options.map((option, index) => ({ modelOptionId: `option_${index}`, catalogOptionId: option.id }));
  const catalogInput: CatalogInput = {
    requested: minimizedRequested,
    options: artifact.options.map((option, index) => ({ id: `option_${index}`, label: `observed_option_${index}`,
      fields: Object.fromEntries(Object.entries(option.fields).filter(([, value]) => value !== undefined)
        .map(([field, value]) => [field, encode(field, value!)])),
    })),
    approvedEquivalentIds: optionBindings.filter((entry) => equivalentIds.has(entry.catalogOptionId)).map((entry) => entry.modelOptionId),
  };
  return Object.freeze({ status: "available", candidateScope: "observed_configuration", ...flags, catalogInput: snapshot(catalogInput),
    localEvidence: Object.freeze({ input: context, artifact, optionBindings: snapshot(optionBindings) }) });
}
