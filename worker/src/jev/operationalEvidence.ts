import { types as nodeTypes } from "node:util";
import { selectQuoteEvidence } from "../quoteIntelligence/quoteEvidence.js";
import { parseQuoteDocuments } from "./quoteDocument.js";
import { projectEngineeringCatalog, type EngineeringCatalogAuthority } from "./engineeringCatalog.js";
import { matchCatalog } from "../quoteIntelligence/catalog.js";
import { selectClarification } from "../quoteIntelligence/clarification.js";
import { isObservedXometryQuoteDocument } from "../adapters/xometryOffers.js";
import { projectRequirementProvenance, type RequirementProvenanceBinding, type RequirementProvenanceProjection } from "./requirementProvenance.js";
import { captureQuoteRelevanceEvidence, captureObservedPresentationRelevanceEvidence, captureCatalogRelevanceEvidence,
  captureRequirementRelevanceEvidence, projectRelevanceEvidence, type RelevanceEvidence } from "./relevanceProjection.js";
import type { XometryProviderObservation, XometryQuoteDocument, XometryCatalogObservation } from "./providerObservations.js";
import type { VendorQuoteAdapterInput } from "../types.js";
import type { ChoiceQuestion } from "./choice.js";
import type { OperationalJevScope, OperationalJevUse } from "./operationalSession.js";

export type EvidenceUse = Extract<OperationalJevUse, "quote_evidence" | "catalog_mapping" | "clarification" | "relevance">;
export type OperationalEvidenceProfile = "quote_facts.v1" | "catalog_facts.v1" | "clarification_facts.v1" | "presentation_facts.v1";
export type EvidencePlan = Readonly<{
  scope: OperationalJevScope; use: EvidenceUse; profile: OperationalEvidenceProfile;
  question: ChoiceQuestion | null; baseline: string; validUntil?: number;
  unavailable: "quote_spans_missing" | "catalog_process_provenance_missing" | "relevance_classification_missing" | "semantic_spans_missing" | null;
  /** Local-only resolution; never passed to transport/audit or merged into authoritative output. */
  resolve(choice: string): Promise<unknown>;
}>;
/** Complete bounded local snapshot. Reject unsupported records rather than silently
 * dropping unprojected approved constraints, invoking accessors, or truncating source. */
function snapshotApprovedSource(value: unknown): object {
  let nodes = 0, characters = 0;
  const ancestors = new WeakSet<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 16) throw new Error("approved_source_budget");
    if (typeof value === "string") {
      characters += value.length;
      if (value.length > 65_536 || characters > 262_144) throw new Error("approved_source_budget");
      return value;
    }
    if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || nodeTypes.isProxy(value) || ancestors.has(value)) throw new Error("approved_source_invalid");
    const array = Array.isArray(value), prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error("approved_source_invalid");
    const keys = Reflect.ownKeys(value), result: object = array ? [] : Object.create(null) as object;
    if (array ? keys.length > 1001 : keys.length > 128) throw new Error("approved_source_budget");
    if (array && keys.length !== value.length + 1) throw new Error("approved_source_invalid");
    ancestors.add(value);
    for (const key of keys) {
      if (array && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)
        || array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error("approved_source_invalid");
      characters += key.length;
      if (characters > 262_144) throw new Error("approved_source_budget");
      Object.defineProperty(result, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    ancestors.delete(value); return Object.freeze(result);
  };
  const result = copy(value, 0);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("approved_source_invalid");
  return result;
}
const plans = new WeakSet<object>();
function freezeTree<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeTree(child); Object.freeze(value); }
  return value;
}
function seal(plan: EvidencePlan): EvidencePlan {
  const sealed = Object.freeze({ ...plan, scope: Object.freeze({ ...plan.scope }),
    question: plan.question ? JSON.parse(JSON.stringify(plan.question)) as ChoiceQuestion : null });
  // Questions contain only code-owned flags and ordinals. Keep them detached from local sources.
  if (sealed.question) freezeTree(sealed.question);
  plans.add(sealed); return sealed;
}
export function isOperationalEvidencePlan(value: unknown): value is EvidencePlan {
  return typeof value === "object" && value !== null && plans.has(value);
}

/** One actual adapter invocation owns this bounded local capture. The callback is synchronous:
 * it authenticates collector objects before cloning, retains complete source, and never infers. */
export class OperationalEvidenceCapture {
  readonly requirement: RequirementProvenanceProjection;
  private readonly expectedRequirement: RequirementProvenanceBinding;
  private readonly records: XometryProviderObservation[] = [];
  private readonly relevance: RelevanceEvidence[];
  private readonly approvedSource: object | null;
  private overflow = false;
  private closed = false;
  constructor(private readonly scope: OperationalJevScope, input: VendorQuoteAdapterInput, private readonly catalogAuthority?: EngineeringCatalogAuthority) {
    this.scope = Object.freeze({ ...scope });
    try { this.approvedSource = snapshotApprovedSource(input.requirement); } catch { this.approvedSource = null; }
    this.expectedRequirement = Object.freeze({ requirementId: input.requirement.id, partId: input.part.id,
      revision: input.requirement.revision, updatedAt: input.requirement.updated_at ?? "", requestedQuantity: input.requestedQuantity });
    this.requirement = projectRequirementProvenance(input.requirement, this.expectedRequirement);
    this.relevance = [captureRequirementRelevanceEvidence("approved-requirement", {
      projection: this.requirement, approvedRequirement: this.approvedSource,
      approvedRequirementStatus: this.approvedSource ? "complete" : "unavailable",
    })];
  }
  readonly observe = (record: XometryProviderObservation): undefined => {
    if (this.closed || this.overflow) return;
    if (this.records.length >= 132) { this.overflow = true; return; }
    this.records.push(record);
    if (record.kind === "quote") for (const document of record.documents) {
      this.relevance.push(captureQuoteRelevanceEvidence(document.evidenceId, document));
    }
    else if (record.kind === "presentation") this.relevance.push(captureObservedPresentationRelevanceEvidence(record.evidenceId, record));
    else if (record.kind === "catalog") this.relevance.push(captureCatalogRelevanceEvidence(`catalog-${this.records.length}`, record));
  };
  close(): void { this.closed = true; }
  source(): Readonly<{ requirement: RequirementProvenanceProjection; approvedRequirement: object | null;
    approvedRequirementStatus: "complete" | "unavailable"; observations: readonly XometryProviderObservation[]; overflow: boolean }> {
    return Object.freeze({ requirement: this.requirement, approvedRequirement: this.approvedSource,
      approvedRequirementStatus: this.approvedSource ? "complete" : "unavailable", observations: Object.freeze([...this.records]), overflow: this.overflow });
  }
  private documents(): XometryQuoteDocument[] {
    return this.records.flatMap((record) => record.kind === "quote" ? [...record.documents].filter(isObservedXometryQuoteDocument) : []);
  }
  private unavailable(use: EvidenceUse, profile: OperationalEvidenceProfile, reason: NonNullable<EvidencePlan["unavailable"]>): EvidencePlan {
    return seal({ scope: this.scope, use, profile, question: null, baseline: "abstain", unavailable: reason,
      resolve: async () => Object.freeze({ status: "unavailable", reason, source: this.source(),
        ...(use === "quote_evidence" ? { publicationAllowed: false } : {}) }) });
  }
  async plan(use: EvidenceUse): Promise<EvidencePlan> {
    if (!this.approvedSource) {
      const profiles = { quote_evidence: "quote_facts.v1", catalog_mapping: "catalog_facts.v1", clarification: "clarification_facts.v1", relevance: "presentation_facts.v1" } as const;
      return this.unavailable(use, profiles[use], "semantic_spans_missing");
    }
    if (use === "relevance") return this.relevancePlan();
    if (use === "quote_evidence") return this.quotePlan();
    if (use === "catalog_mapping") return this.catalogPlan();
    return this.clarificationPlan();
  }
  private async quotePlan(): Promise<EvidencePlan> {
    // One aggregate admission over original capture objects. Never filter, deduplicate,
    // parse documents independently, or keep a surviving candidate from refused source.
    const parsed = parseQuoteDocuments({ observations: this.records, overflow: this.overflow, requirement: this.requirement });
    if (parsed.status === "unavailable") return this.unavailable("quote_evidence", "quote_facts.v1", "quote_spans_missing");
    // The existing selector's raw question stays local. Verify compatibility before
    // admission; only the aggregate parser's frozen fixed facts may reach transport.
    const validation = await selectQuoteEvidence(parsed.evidenceInput, async (_question, baseline) => baseline);
    if (validation.status !== "evidence_selected" || validation.flags.length) {
      return this.unavailable("quote_evidence", "quote_facts.v1", "quote_spans_missing");
    }
    return seal({ scope: this.scope, use: "quote_evidence", profile: "quote_facts.v1", unavailable: null,
      baseline: "span_0", question: { instructions: "Advisory evidence selection only. Select the uniquely supported candidate or abstain. Never calculate or publish money.",
        state: { candidates: [...parsed.facts.candidates] }, criteria: {
          abstain: "Retain complete source for operator review",
          span_0: "Collector-observed unique current firm total with explicit matching quantity, revision and USD",
        } },
      resolve: async (choice) => {
        const result = await selectQuoteEvidence(parsed.evidenceInput, async () => choice);
        return Object.freeze({ status: result.status, selected: result.selected ? parsed.candidate : null,
          publicationAllowed: false, source: this.source() });
      } });
  }
  private async catalogPlan(): Promise<EvidencePlan> {
    const requirement = this.requirement;
    const observed = this.records.filter((r): r is XometryCatalogObservation => r.kind === "catalog");
    if (this.overflow || requirement.status !== "available" || !observed.length
      || requirement.fields.material.state !== "observed" || requirement.fields.process.state !== "observed"
      || requirement.fields.finish.state !== "observed") return this.unavailable("catalog_mapping", "catalog_facts.v1", "catalog_process_provenance_missing");
    const projection = projectEngineeringCatalog({ scope: this.scope, requirement,
      expectedRequirement: this.expectedRequirement, observations: observed, now: Date.now() }, this.catalogAuthority);
    if (projection.status !== "available") return this.unavailable("catalog_mapping", "catalog_facts.v1", "catalog_process_provenance_missing");
    // The reviewed issuer provides complete observed-configuration tuples; the matcher
    // sees only field-specific equality tokens and ordinal IDs/labels, never local proof.
    let question: ChoiceQuestion | null = null;
    let baseline = "no_match";
    await matchCatalog(projection.catalogInput, async (packet, fallback) => {
      baseline = fallback;
      question = { ...packet, state: JSON.parse(JSON.stringify(projection.catalogInput)) as ChoiceQuestion["state"],
        instructions: "Advisory mapping within this complete observed configuration only. Never infer global catalog availability, equivalence, or permission to apply a change. " + packet.instructions,
        criteria: { ...packet.criteria, no_match: "No compatible option in this observed configuration; no global incompatibility conclusion",
          clarify: "Operator review of ambiguous compatible options in this observed configuration" } };
      return "no_match";
    });
    const validUntil = Math.min(projection.localEvidence.artifact.expiresAt,
      ...projection.localEvidence.artifact.materialEquivalenceApprovals.map((approval) => approval.expiresAt));
    return seal({ scope: this.scope, use: "catalog_mapping", profile: "catalog_facts.v1", unavailable: null,
      baseline, question, validUntil,
      resolve: async (choice) => {
        const expired = () => Object.freeze({ status: "unavailable", reason: "catalog_expired", projection, source: this.source() });
        if (Date.now() >= validUntil) return expired();
        const result = await matchCatalog(projection.catalogInput, async () => choice);
        if (Date.now() >= validUntil) return expired();
        return Object.freeze({ result, candidateScope: "observed_configuration", publicationAllowed: false, projection, source: this.source() });
      } });
  }

  private async clarificationPlan(): Promise<EvidencePlan> {
    const requirement = this.requirement;
    if (requirement.status !== "available" || this.overflow) return this.unavailable("clarification", "clarification_facts.v1", "semantic_spans_missing");
    const facts: Array<{ field: "material" | "finish" | "quantity" | "revision"; values: Array<string | number> }> = [{ field: "quantity", values: [requirement.binding.requestedQuantity] }];
    for (const field of ["material", "finish", "revision"] as const) {
      const fact = requirement.fields[field]; if (fact.state === "observed") facts.push({ field, values: [fact.value] });
    }
    for (const document of this.documents()) {
      for (const match of document.text.matchAll(/\b(?:qty|quantity)\s*[:=]\s*(\d+)\b/gi)) facts.push({ field: "quantity", values: [Number(match[1])] });
      for (const match of document.text.matchAll(/\b(?:rev|revision)\s*[:=]\s*([A-Za-z0-9_-]+)/gi)) facts.push({ field: "revision", values: [match[1]] });
    }
    const validationErrors = requirement.clarification.facts.filter((fact) => fact.state !== "observed").map((fact) => `${fact.field}_${fact.state}`);
    const raw = { requestText: "", facts, validationErrors };
    const baseline = await selectClarification(raw, async (_question, baseline) => baseline);
    const conflictingFields = (["material", "finish", "quantity", "revision"] as const).filter((field) => new Set(facts.filter((f) => f.field === field).flatMap((f) => f.values)).size > 1);
    const criteria = baseline.templateId === "general_review"
      ? { general_review: "Review observed missing or invalid requirements", abstain: "Retain required general review without further interpretation" }
      : { [baseline.templateId]: "Use the fixed template supported by observed facts", general_review: "Request broader operator review" };
    return seal({ scope: this.scope, use: "clarification", profile: "clarification_facts.v1", unavailable: null,
      baseline: baseline.templateId, question: validationErrors.length ? null : { instructions: "Choose only a fact-supported fixed operator clarification template. Do not generate messages or reinterpret approved requirements.",
        state: { fields: requirement.clarification.facts.map((f) => ({ ...f })), conflictingFields }, criteria },
      resolve: async (choice) => Object.freeze({ result: await selectClarification(raw, async () => choice), source: this.source(), customerMessageSent: false }) });
  }
  private relevancePlan(): EvidencePlan {
    if (this.overflow) return this.unavailable("relevance", "presentation_facts.v1", "relevance_classification_missing");
    const initial = projectRelevanceEvidence(this.relevance);
    if (!initial.optionalCandidates.length) return this.unavailable("relevance", "presentation_facts.v1", "relevance_classification_missing");
    return seal({ scope: this.scope, use: "relevance", profile: "presentation_facts.v1", unavailable: null, baseline: "keep_all",
      question: { instructions: "Presentation-only operator view. Keep anything uncertain. Only authenticated separate marketing badges are optional; parent quotes and all requirements remain complete.",
        state: { optionalMarketingBadgeCount: initial.optionalCandidates.length, completeParentQuotesRetained: true },
        criteria: { keep_all: "Retain all optional presentation badges", drop_optional: "Exclude only optional marketing badges from the operator view" } },
      resolve: async (choice) => projectRelevanceEvidence(this.relevance, choice === "drop_optional" ? initial.optionalCandidates.map((c) => c.id) : []) });
  }
}
