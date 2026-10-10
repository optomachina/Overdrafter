import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { matchCatalog } from "../quoteIntelligence/catalog.js";
import { projectRequirementProvenance } from "./requirementProvenance.js";
import {
  projectEngineeringCatalog, type EngineeringCatalogArtifact, type EngineeringCatalogAuthority,
  type EngineeringCatalogInput, type EngineeringCatalogProjection,
} from "./engineeringCatalog.js";

const baseline = async (_question: unknown, fallback: string) => fallback;
type Mutable<T> = T extends readonly (infer Item)[] ? Mutable<Item>[]
  : T extends object ? { -readonly [Key in keyof T]: Mutable<T[Key]> } : T;
function fixture() {
  const scope = { organizationId: "ORG_SECRET", taskId: "TASK_SECRET", quoteRunId: "RUN_SECRET",
    provider: "xometry" as const, sourceRevision: "b".repeat(40) };
  const binding = { requirementId: "REQUIREMENT_SECRET", partId: "PART_SECRET", revision: "REV_SECRET",
    updatedAt: "2026-10-02T00:00:00Z", requestedQuantity: 37 };
  const requirement = projectRequirementProvenance({ id: binding.requirementId, part_id: binding.partId,
    revision: binding.revision, updated_at: binding.updatedAt, material: "6061-T6 MATERIAL_SECRET",
    finish: "Anodized FINISH_SECRET", spec_snapshot: { process: "CNC PROCESS_SECRET" },
    tightest_tolerance_inch: 0.00123, quantity: 37, quote_quantities: [37] }, binding);
  if (requirement.status !== "available") throw new Error("fixture_invalid");
  const input: EngineeringCatalogInput = { scope, requirement, expectedRequirement: binding, now: 1000,
    observations: ["material", "finish"].map((field) => ({
      kind: "catalog" as const, provider: "xometry" as const, field: field as "material" | "finish",
      controlSelector: `#${field}`, optionSelector: "role=option", label: `${field}_LABEL_SECRET`,
      attributes: { "data-option-id": `${field}_ID_SECRET`, other: "unclassified_attribute" },
      deterministicTerm: `${field}_TERM_SECRET`, catalogStatus: "unavailable" as const,
      reason: "custom_widget_engineering_catalog_unavailable" as const,
    })),
  };
  const artifact: EngineeringCatalogArtifact = {
    contract: "jev-engineering-catalog.v1", provider: "xometry", catalogId: "CATALOG_SECRET", catalogRevision: "VERSION_SECRET",
    scope: { ...scope }, requirementBinding: { ...binding }, issuedAt: 900, expiresAt: 2000,
    source: { identity: "SOURCE_SECRET", sha256: "f".repeat(64), schemaRevision: "SCHEMA_SECRET",
      collection: "observed_configuration", completeness: "complete", candidateCount: 1,
      observationsSha256: createHash("sha256").update(JSON.stringify(input.observations)).digest("hex") },
    namespaces: ["material", "finish"].map((field) => ({ namespace: `${field}_namespace`,
      field: field as "material" | "finish", attributeName: "data-option-id", controlSelector: `#${field}`, optionSelector: "role=option" })),
    options: [{ id: "JOINT_TUPLE_SECRET", fields: { material: "6061-T6 MATERIAL_SECRET", process: "CNC PROCESS_SECRET",
      finish: "Anodized FINISH_SECRET", tightestToleranceInch: 0.00123 }, observedBindings: [
      { namespace: "material_namespace", observedId: "material_ID_SECRET" },
      { namespace: "finish_namespace", observedId: "finish_ID_SECRET" },
    ] }], materialEquivalenceApprovals: [],
  };
  return { input: structuredClone(input) as Mutable<EngineeringCatalogInput>,
    artifact: structuredClone(artifact) as Mutable<EngineeringCatalogArtifact> };
}
function available(value: EngineeringCatalogProjection) {
  expect(value.status).toBe("available");
  if (value.status !== "available") throw new Error("expected_available");
  return value;
}
function project(data = fixture()) { return projectEngineeringCatalog(data.input, () => data.artifact); }
function equivalence(data: ReturnType<typeof fixture>) {
  return { approvalId: "APPROVAL_SECRET", scope: data.input.scope, requirementBinding: data.input.expectedRequirement,
    catalogId: data.artifact.catalogId, catalogRevision: data.artifact.catalogRevision,
    optionId: data.artifact.options[0].id, requestedMaterial: "6061-T6 MATERIAL_SECRET",
    equivalentMaterial: data.artifact.options[0].fields.material, expiresAt: 2000 };
}

describe("trusted-host engineering catalog projection (synthetic source fixtures only)", () => {
  it("projects a separately issued joint tuple bound to actual observation fields and preserves the complete local evidence", async () => {
    const data = fixture();
    const host = vi.fn(() => data.artifact);
    const result = available(projectEngineeringCatalog(data.input, host));
    expect(host).toHaveBeenCalledOnce();
    expect(result.localEvidence.input).toEqual(data.input);
    expect(result.localEvidence.artifact).toEqual(data.artifact);
    expect(result.localEvidence.optionBindings).toEqual([{ modelOptionId: "option_0", catalogOptionId: "JOINT_TUPLE_SECRET" }]);
    expect(result).toMatchObject({ localOnly: true, disclosureAuthority: "none", publicationAllowed: false });
    expect(await matchCatalog(result.catalogInput, baseline)).toMatchObject({ status: "exact", option: { id: "option_0" } });
  });

  it("puts no raw values, observation labels/IDs, scope or requirement identifiers in the matcher/model packet", async () => {
    const result = available(project());
    const packet = JSON.stringify(result.catalogInput);
    for (const value of ["SECRET", "0.00123", "37", "2026-10-02", "#material", "#finish", "data-option-id", "namespace", "unclassified_attribute"])
      expect(packet).not.toContain(value);
    expect(result.catalogInput.requested).not.toHaveProperty("quantity");
    expect(result.catalogInput.requested).not.toHaveProperty("revision");
    const decide = vi.fn(baseline);
    await matchCatalog(result.catalogInput, decide);
    expect(JSON.stringify(decide.mock.calls)).not.toContain("SECRET");
  });

  it.each(["material", "process", "finish", "tightestToleranceInch"])("preserves exact %s inequality instead of collapsing options to a shared token", async (field) => {
    const data = fixture();
    const fields = data.artifact.options[0].fields as Record<string, unknown>;
    fields[field] = field === "tightestToleranceInch" ? 0.00456 : "DIFFERENT_SECRET";
    const result = available(project(data));
    expect(result.catalogInput.options[0].fields[field]).not.toBe(result.catalogInput.requested[field]);
    expect(await matchCatalog(result.catalogInput, baseline)).toMatchObject({ status: "no_match", option: null });
  });

  it("requires explicit bound approval for material equivalence and cannot relax any other constraint", async () => {
    const data = fixture();
    (data.artifact.options[0].fields as { material: string }).material = "7075-T6 EQUIVALENT_SECRET";
    expect(await matchCatalog(available(project(data)).catalogInput, baseline)).toMatchObject({ status: "no_match" });
    (data.artifact as { materialEquivalenceApprovals: unknown[] }).materialEquivalenceApprovals = [equivalence(data)];
    expect(await matchCatalog(available(project(data)).catalogInput, baseline)).toMatchObject({ status: "approved_equivalent" });
    for (const field of ["process", "finish", "tightestToleranceInch"] as const) {
      const changed = structuredClone(data);
      (changed.artifact.options[0].fields as Record<string, unknown>)[field] = field === "tightestToleranceInch" ? 0.1 : "DIFFERENT";
      expect(await matchCatalog(available(project(changed)).catalogInput, async () => "option_0")).toMatchObject({ status: "clarify", option: null });
    }
  });

  it("refuses unavailable provider tolerance evidence instead of dropping the constraint or claiming no-match", () => {
    const data = fixture();
    delete (data.artifact.options[0].fields as { tightestToleranceInch?: number }).tightestToleranceInch;
    expect(project(data)).toMatchObject({ status: "unavailable", reason: "engineering_fields_missing" });
  });

  it("uses every supplied joint tuple independently and preserves ambiguity and exact-match preference", async () => {
    const data = fixture();
    const options = data.artifact.options as unknown[];
    options.push({ ...data.artifact.options[0], id: "SECOND_TUPLE_SECRET", fields: { ...data.artifact.options[0].fields } });
    (data.artifact.source as { candidateCount: number }).candidateCount = 2;
    const result = available(project(data));
    expect(result.catalogInput.options).toHaveLength(2);
    expect(await matchCatalog(result.catalogInput, baseline)).toMatchObject({ status: "clarify" });
    (data.artifact.options[0].fields as { material: string }).material = "APPROVED_OTHER_MATERIAL";
    (data.artifact as { materialEquivalenceApprovals: unknown[] }).materialEquivalenceApprovals = [equivalence(data)];
    expect(await matchCatalog(available(project(data)).catalogInput, baseline)).toMatchObject({ status: "exact", option: { id: "option_1" } });
  });

  it("does not mistake labels, aliases, generic capabilities or caller type flags for host authority", () => {
    const data = fixture();
    expect(projectEngineeringCatalog(data.input)).toMatchObject({ status: "unavailable", reason: "catalog_authority_missing" });
    expect(projectEngineeringCatalog(data.input, { trusted: true, artifact: data.artifact } as unknown as EngineeringCatalogAuthority))
      .toMatchObject({ reason: "catalog_authority_unavailable" });
    expect(projectEngineeringCatalog(data.input, () => ({ materials: ["6061"], processes: ["CNC"], finishes: ["Anodized"] })))
      .toMatchObject({ reason: "invalid_catalog_artifact" });
  });

  it.each(["organizationId", "taskId", "quoteRunId", "provider", "sourceRevision"])("rejects mismatched catalog scope %s", (field) => {
    const data = fixture();
    (data.artifact.scope as Record<string, unknown>)[field] = field === "sourceRevision" ? "c".repeat(40) : "different";
    expect(project(data)).toMatchObject({ status: "unavailable" });
  });

  it.each(["requirementId", "partId", "revision", "updatedAt", "requestedQuantity"])("rejects stale approved requirement binding %s before host issuance", (field) => {
    const data = fixture();
    (data.input.expectedRequirement as Record<string, unknown>)[field] = field === "requestedQuantity" ? 38
      : field === "updatedAt" ? "2026-10-02T00:01:00Z" : "changed";
    const host = vi.fn(() => data.artifact);
    expect(projectEngineeringCatalog(data.input, host)).toMatchObject({ reason: "requirement_binding_mismatch" });
    expect(host).not.toHaveBeenCalled();
  });

  it.each(["material", "process", "finish", "tightestToleranceInch"])("rejects missing/invalid approved %s provenance", (field) => {
    const data = fixture();
    if (data.input.requirement.status !== "available") throw new Error("fixture");
    const fact = data.input.requirement.fields[field as keyof typeof data.input.requirement.fields];
    Object.assign(fact, { state: "invalid" });
    delete (fact as { value?: unknown }).value;
    const host = vi.fn(() => data.artifact);
    expect(projectEngineeringCatalog(data.input, host)).toMatchObject({ status: "unavailable", reason: "engineering_fields_missing" });
    expect(host).not.toHaveBeenCalled();
  });

  it.each(["issuedAt", "expiresAt"])("rejects future or expired artifact %s", (field) => {
    const data = fixture();
    (data.artifact as unknown as Record<string, unknown>)[field] = field === "issuedAt" ? 1001 : 1000;
    expect(project(data)).toMatchObject({ reason: "catalog_expired" });
  });

  it.each(["attributeName", "controlSelector", "optionSelector", "namespace"])("requires the exact reviewed identity namespace binding: %s", (field) => {
    const data = fixture();
    (data.artifact.namespaces[0] as unknown as Record<string, unknown>)[field] = field === "attributeName" ? "id" : "wrong";
    expect(project(data)).toMatchObject({ reason: "observed_binding_missing" });
  });

  it("rejects invented observed IDs, missing finish observations and ambiguous duplicate captures", () => {
    const data = fixture();
    const changed = structuredClone(data);
    (changed.artifact.options[0].observedBindings[0] as { observedId: string }).observedId = "invented";
    expect(project(changed)).toMatchObject({ reason: "observed_binding_missing" });
    (data.input.observations as unknown[]).pop();
    (data.artifact.source as { observationsSha256: string }).observationsSha256 = createHash("sha256").update(JSON.stringify(data.input.observations)).digest("hex");
    expect(project(data)).toMatchObject({ reason: "observed_binding_missing" });
    const duplicate = fixture();
    (duplicate.input.observations as unknown[]).push(structuredClone(duplicate.input.observations[0]));
    (duplicate.artifact.source as { observationsSha256: string }).observationsSha256 = createHash("sha256").update(JSON.stringify(duplicate.input.observations)).digest("hex");
    expect(project(duplicate)).toMatchObject({ reason: "observed_binding_ambiguous" });
  });

  it("validates separately declared quantity/revision applicability without adding request values to provider fields", () => {
    const data = fixture();
    Object.assign(data.artifact.options[0], { applicability: { quantities: [37], revisions: ["REV_SECRET"] } });
    expect(project(data)).toMatchObject({ status: "available" });
    Object.assign(data.artifact.options[0], { applicability: { quantities: [38] } });
    expect(project(data)).toMatchObject({ reason: "catalog_applicability_mismatch" });
    Object.assign(data.artifact.options[0], { applicability: { revisions: ["OLD"] } });
    expect(project(data)).toMatchObject({ reason: "catalog_applicability_mismatch" });
  });

  it.each(["catalogId", "catalogRevision", "optionId", "requestedMaterial", "equivalentMaterial", "expiresAt"])("rejects unbound material approval %s", (field) => {
    const data = fixture();
    const approval = equivalence(data);
    (approval as Record<string, unknown>)[field] = field === "expiresAt" ? 1000 : "wrong";
    (data.artifact as { materialEquivalenceApprovals: unknown[] }).materialEquivalenceApprovals = [approval];
    expect(project(data)).toMatchObject({ reason: "material_equivalence_unbound" });
  });

  it("rejects material-equivalence approvals from another run or approved requirement version", () => {
    for (const field of ["scope", "requirementBinding"] as const) {
      const data = fixture();
      const approval = structuredClone(equivalence(data));
      if (field === "scope") Object.assign(approval.scope, { quoteRunId: "OTHER_RUN" });
      else Object.assign(approval.requirementBinding, { updatedAt: "2026-10-02T00:01:00Z" });
      (data.artifact as { materialEquivalenceApprovals: unknown[] }).materialEquivalenceApprovals = [approval];
      expect(project(data)).toMatchObject({ reason: "material_equivalence_unbound" });
    }
  });

  it("rejects duplicate IDs and incomplete/unsupported engineering tuples instead of synthesizing fields", () => {
    const data = fixture();
    (data.artifact.options as unknown[]).push(structuredClone(data.artifact.options[0]));
    (data.artifact.source as { candidateCount: number }).candidateCount = 2;
    expect(project(data)).toMatchObject({ reason: "invalid_catalog_artifact" });
    const missing = fixture();
    delete (missing.artifact.options[0].fields as { process?: string }).process;
    expect(project(missing)).toMatchObject({ reason: "invalid_catalog_artifact" });
    const extra = fixture();
    Object.assign(extra.artifact.options[0].fields, { quantity: 37 });
    expect(project(extra)).toMatchObject({ reason: "invalid_catalog_artifact" });
    const typeMismatch = fixture();
    Object.assign(typeMismatch.artifact.options[0].fields, { tightestToleranceInch: "0.00123" });
    expect(project(typeMismatch)).toMatchObject({ reason: "invalid_catalog_artifact" });
  });

  it("detaches and deeply freezes the complete local snapshots, host context and minimized packet", () => {
    const data = fixture();
    let context: EngineeringCatalogInput | undefined;
    const result = available(projectEngineeringCatalog(data.input, (value) => { context = value; return data.artifact; }));
    (data.artifact.options[0].fields as { material: string }).material = "MUTATED";
    (data.input.observations[0].attributes as Record<string, string>)["data-option-id"] = "MUTATED";
    expect(result.localEvidence.artifact.options[0].fields.material).toBe("6061-T6 MATERIAL_SECRET");
    expect(result.localEvidence.input.observations[0].attributes["data-option-id"]).toBe("material_ID_SECRET");
    expect(Reflect.set(result.catalogInput.options[0].fields, "material", "MUTATED")).toBe(false);
    expect(Object.isFrozen(result.localEvidence.artifact.options)).toBe(true);
    expect(Object.isFrozen(context?.observations[0].attributes)).toBe(true);
  });

  it.each(["map", "some", "constructor", Symbol.iterator])("rejects caller array hooks without invoking %s", (key) => {
    const data = fixture();
    const hook = vi.fn(() => []);
    Object.defineProperty(data.input.observations, key, { get: hook });
    const host = vi.fn(() => data.artifact);
    expect(projectEngineeringCatalog(data.input, host)).toMatchObject({ reason: "invalid_input" });
    expect(hook).not.toHaveBeenCalled();
    expect(host).not.toHaveBeenCalled();
  });

  it("rejects getters, sparse arrays, toJSON and source proxies without executing them or exposing errors", () => {
    const data = fixture();
    const getter = vi.fn(() => { throw new Error("PRIVATE_SOURCE"); });
    Object.defineProperty(data.input, "now", { get: getter });
    expect(project(data)).toMatchObject({ reason: "invalid_input" });
    const proxyData = fixture();
    const proxy = new Proxy(proxyData.input, { getPrototypeOf: getter, get: getter, ownKeys: getter });
    expect(projectEngineeringCatalog(proxy, () => proxyData.artifact)).toMatchObject({ reason: "invalid_input" });
    expect(projectEngineeringCatalog(proxyData.input, () => new Proxy(proxyData.artifact, { getPrototypeOf: getter })))
      .toMatchObject({ reason: "catalog_authority_unavailable" });
    expect(getter).not.toHaveBeenCalled();
    const sparse = fixture();
    delete (sparse.input.observations as unknown[])[0];
    expect(project(sparse)).toMatchObject({ reason: "invalid_input" });
    const json = fixture();
    const toJSON = vi.fn(() => ({}));
    Object.assign(json.artifact, { toJSON });
    expect(project(json)).toMatchObject({ reason: "catalog_authority_unavailable" });
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("bounds text, aggregate text, nesting, arrays and candidate count before inference", () => {
    const huge = fixture();
    Object.assign(huge.input.observations[0], { label: "x".repeat(65_537) });
    expect(project(huge)).toMatchObject({ reason: "invalid_input" });
    const aggregate = fixture();
    (aggregate.input as { observations: unknown[] }).observations = Array.from({ length: 5 }, () => ({ ...aggregate.input.observations[0], label: "x".repeat(60_000) }));
    expect(project(aggregate)).toMatchObject({ reason: "invalid_input" });
    const excessive = fixture();
    (excessive.artifact as { options: unknown[] }).options = Array.from({ length: 63 }, (_, index) => ({ ...excessive.artifact.options[0], id: String(index) }));
    expect(project(excessive)).toMatchObject({ reason: "invalid_catalog_artifact" });
    const array = fixture();
    (array.input as { observations: unknown[] }).observations = Array.from({ length: 1001 }, () => array.input.observations[0]);
    expect(project(array)).toMatchObject({ reason: "invalid_input" });
    let nested: object = {};
    for (let index = 0; index < 20; index += 1) nested = { nested };
    const deep = fixture();
    Object.assign(deep.input.requirement, { nested });
    expect(project(deep)).toMatchObject({ reason: "invalid_input" });
  });

  it("returns fixed unavailable for throwing/async issuers and consumes mistaken Promise rejection without waiting", async () => {
    const data = fixture();
    expect(projectEngineeringCatalog(data.input, () => { throw new Error("PRIVATE_ERROR"); })).toMatchObject({ reason: "catalog_authority_unavailable" });
    expect(projectEngineeringCatalog(data.input, async () => data.artifact)).toMatchObject({ reason: "catalog_authority_unavailable" });
    expect(projectEngineeringCatalog(data.input, () => Promise.reject(new Error("PRIVATE_REJECTION")))).toMatchObject({ reason: "catalog_authority_unavailable" });
    await Promise.resolve();
  });

  it("requires completeness for the exact observed configuration and never treats a truncated set as unique or global no-match", () => {
    const incomplete = fixture();
    (incomplete.artifact.source as { completeness: string }).completeness = "incomplete";
    expect(project(incomplete)).toMatchObject({ reason: "catalog_incomplete" });
    const truncated = fixture();
    (truncated.artifact.source as { candidateCount: number }).candidateCount = 63;
    expect(project(truncated)).toMatchObject({ reason: "catalog_incomplete" });
    expect(available(project()).candidateScope).toBe("observed_configuration");
  });

  it("binds all observed source data to the host artifact digest, not just matching DOM IDs", () => {
    const data = fixture();
    Object.assign(data.input.observations[0], { label: "changed-capture" });
    expect(project(data)).toMatchObject({ reason: "catalog_scope_mismatch" });
    const host = vi.fn((context) => ({ ...data.artifact,
      source: { ...data.artifact.source, observationsSha256: context.observationsSha256 } }));
    expect(projectEngineeringCatalog(data.input, host)).toMatchObject({ status: "available" });
    expect(host.mock.calls[0][0].observationsSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
