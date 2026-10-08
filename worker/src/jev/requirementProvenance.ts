/**
 * Local provenance only: call with the row loaded from approved_part_requirements,
 * never extraction output. A structural check cannot authenticate a database row.
 * Neither approval-table membership nor this projection grants model disclosure,
 * human approval attribution, material equivalence, or provider action authority.
 */
export type RequirementProvenanceBinding = Readonly<{
  requirementId: string;
  partId: string;
  revision: string | null;
  updatedAt: string;
  requestedQuantity: number;
}>;

export type RequirementFactSource =
  | "approved_part_requirements.material"
  | "approved_part_requirements.finish"
  | "approved_part_requirements.revision"
  | "approved_part_requirements.tightest_tolerance_inch"
  | "approved_part_requirements.spec_snapshot.process";

export type RequirementFact<T> =
  | Readonly<{ state: "observed"; source: RequirementFactSource; value: T }>
  | Readonly<{ state: "missing" | "invalid"; source: RequirementFactSource }>;

export type RequirementClarificationField = "material" | "finish" | "process" | "revision" | "quantity";
export type RequirementClarification = Readonly<{
  /** Fixed facts only; still requires separate operational admission before inference. */
  facts: readonly Readonly<{
    field: RequirementClarificationField;
    state: "observed" | "missing" | "invalid";
  }>[];
  templateId: "general_review" | "none";
  semanticContradictions: "unavailable";
}>;

export type AvailableRequirementProvenance = Readonly<{
  status: "available";
  contract: "jev-requirement-provenance.v1";
  localOnly: true;
  disclosureAuthority: "none";
  binding: RequirementProvenanceBinding;
  approvedQuantities: readonly number[];
  fields: Readonly<{
    material: RequirementFact<string>;
    finish: RequirementFact<string>;
    process: RequirementFact<string>;
    revision: RequirementFact<string>;
    tightestToleranceInch: RequirementFact<number>;
  }>;
  clarification: RequirementClarification;
  /** Current row contract does not establish these distinct authorities. */
  humanApproval: "unavailable";
  catalogIdentity: "unavailable";
  equivalenceApproval: "unavailable";
}>;
export type RequirementProvenanceUnavailableReason =
  | "invalid_requirement"
  | "invalid_binding"
  | "binding_mismatch"
  | "invalid_approved_quantities"
  | "quantity_not_approved";
export type RequirementProvenanceProjection = AvailableRequirementProvenance | Readonly<{
  status: "unavailable";
  reason: RequirementProvenanceUnavailableReason;
  localOnly: true;
  disclosureAuthority: "none";
}>;

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

// No getters, inherited properties, coercions, JSON serialization, or toJSON hooks.
function own(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor)) throw new Error("accessor");
  return descriptor?.value;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && value.trim().length > 0;
}
function quantity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(`${value.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) === value.slice(0, 10);
}
function stringFact(value: unknown, source: RequirementFactSource): RequirementFact<string> {
  if (value == null || (typeof value === "string" && !value.trim())) return Object.freeze({ state: "missing", source });
  return Object.freeze(text(value) ? { state: "observed", source, value } : { state: "invalid", source });
}
function toleranceFact(value: unknown): RequirementFact<number> {
  const source = "approved_part_requirements.tightest_tolerance_inch";
  if (value == null) return Object.freeze({ state: "missing", source });
  return Object.freeze(typeof value === "number" && Number.isFinite(value) && value > 0
    ? { state: "observed", source, value } : { state: "invalid", source });
}
function unavailable(reason: RequirementProvenanceUnavailableReason): RequirementProvenanceProjection {
  return Object.freeze({ status: "unavailable", reason, localOnly: true, disclosureAuthority: "none" });
}

/**
 * Bind the exact current approved row and an approved quantity to a local snapshot.
 * `updatedAt` is the row version, not a substitute current-time capture timestamp.
 * No fallback to extraction, property defaults, process family, or free-form notes.
 * Process is already persisted by approval/update RPCs in spec_snapshot.process;
 * fieldSources and fieldSelections do not grant individual human approval.
 */
export function projectRequirementProvenance(
  requirement: unknown,
  expected: RequirementProvenanceBinding,
): RequirementProvenanceProjection {
  try {
    if (!record(expected)) return unavailable("invalid_binding");
    const requirementId = own(expected, "requirementId");
    const partId = own(expected, "partId");
    const revision = own(expected, "revision");
    const updatedAt = own(expected, "updatedAt");
    const requestedQuantity = own(expected, "requestedQuantity");
    if (!text(requirementId) || !text(partId) || !(revision === null || text(revision))
      || !timestamp(updatedAt) || !quantity(requestedQuantity)) return unavailable("invalid_binding");
    if (!record(requirement)) return unavailable("invalid_requirement");
    if (own(requirement, "id") !== requirementId || own(requirement, "part_id") !== partId
      || own(requirement, "revision") !== revision || own(requirement, "updated_at") !== updatedAt) {
      return unavailable("binding_mismatch");
    }
    const baseQuantity = own(requirement, "quantity");
    const quoteQuantities = own(requirement, "quote_quantities");
    if (!quantity(baseQuantity) || !Array.isArray(quoteQuantities) || quoteQuantities.length > 1000) {
      return unavailable("invalid_approved_quantities");
    }
    const approvedQuantities: number[] = [];
    // Read only own data properties and reject sparse/accessor entries.
    for (let index = 0; index < quoteQuantities.length; index += 1) {
      const entry = own(quoteQuantities as unknown as Record<string, unknown>, String(index));
      if (!quantity(entry) || approvedQuantities.includes(entry)) return unavailable("invalid_approved_quantities");
      approvedQuantities.push(entry);
    }
    // Legacy approved rows may store no alternate quantities; only their base is approved.
    if (!approvedQuantities.length) approvedQuantities.push(baseQuantity);
    if (!approvedQuantities.includes(baseQuantity)) return unavailable("invalid_approved_quantities");
    if (!approvedQuantities.includes(requestedQuantity)) return unavailable("quantity_not_approved");

    const snapshot = own(requirement, "spec_snapshot");
    const processSource = "approved_part_requirements.spec_snapshot.process";
    const process: RequirementFact<string> = snapshot == null
      ? stringFact(undefined, processSource)
      : record(snapshot) ? stringFact(own(snapshot, "process"), processSource)
        : Object.freeze({ state: "invalid", source: processSource });
    const fields = Object.freeze({
      material: stringFact(own(requirement, "material"), "approved_part_requirements.material"),
      finish: stringFact(own(requirement, "finish"), "approved_part_requirements.finish"),
      process,
      revision: stringFact(revision, "approved_part_requirements.revision"),
      tightestToleranceInch: toleranceFact(own(requirement, "tightest_tolerance_inch")),
    });
    const facts = Object.freeze([
      ...(["material", "finish", "process", "revision"] as const)
        .map((field) => Object.freeze({ field, state: fields[field].state })),
      Object.freeze({ field: "quantity" as const, state: "observed" as const }),
    ]);
    const clarification: RequirementClarification = Object.freeze({
      facts,
      // Missing optional finish/revision is an evidence gap, not a new dispatch rule.
      templateId: facts.some((fact) => fact.state !== "observed") ? "general_review" : "none",
      semanticContradictions: "unavailable",
    });
    return Object.freeze({
      status: "available", contract: "jev-requirement-provenance.v1", localOnly: true,
      disclosureAuthority: "none",
      binding: Object.freeze({ requirementId, partId, revision, updatedAt, requestedQuantity }),
      approvedQuantities: Object.freeze(approvedQuantities), fields, clarification,
      humanApproval: "unavailable", catalogIdentity: "unavailable", equivalenceApproval: "unavailable",
    });
  } catch {
    // Hostile objects/accessors/proxies cannot leak source values through errors.
    return unavailable("invalid_requirement");
  }
}
