// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { collectXometryOffers } from "../adapters/xometryOffers";
import { XOMETRY_LOCATORS } from "../adapters/xometryConstraints";
import { chooseOptionByTerms } from "../adapters/xometry";
import type { EngineeringCatalogArtifact, EngineeringCatalogAuthority, EngineeringCatalogIssueContext } from "./engineeringCatalog";
import { OperationalEvidenceCapture } from "./operationalEvidence";
import { OperationalJevSession, OperationalJevObservations, OPERATIONAL_JEV_USES, type OperationalJevScope } from "./operationalSession";
import { JEV_MODEL, type ChoiceQuestion } from "./choice";
import { createXometryQuoteObservation, unavailableXometryObservation, type XometryProviderObservation } from "./providerObservations";
import type { VendorQuoteAdapterInput } from "../types";
const scope: OperationalJevScope = { organizationId: "org", taskId: "task", quoteRunId: "run", provider: "xometry", sourceRevision: "a".repeat(40) };
const input = { organizationId: "org", quoteRunId: "run", part: { id: "part" }, requestedQuantity: 2,
  requirement: { id: "req", part_id: "part", revision: "B", material: "secret-grade", finish: "secret-finish", quantity: 2,
    quote_quantities: [2], updated_at: "2026-10-02T00:00:00Z", tightest_tolerance_inch: 0.01, spec_snapshot: { process: "secret-process" } } } as VendorQuoteAdapterInput;
function page(texts: string[], tier = "Least Expensive - Lead Time: 5 business days") {
  return { url: () => "https://www.xometry.com/quoting/quote/Q26-SYNTHETIC",
    locator: (selector: string) => ({ count: async () => selector === XOMETRY_LOCATORS.offerContainers[0] ? texts.length : 0,
      nth: (index: number) => ({ innerText: async () => texts[index], getAttribute: async () => null,
        locator: (selector: string) => selector.includes("disabled") ? { count: async () => 0 } : { first: () => ({ innerText: async () => tier }) } }) }) } as unknown as Page;
}
const total = "Firm total USD 40.00 quantity: 2 revision: B";
const text = `Standard\nUSD $20.00 ea.\nUSD $40.00\n5 business days\n${total}\nReference: secret-customer-note`;
async function captured(texts = [text]) {
  const capture = new OperationalEvidenceCapture(scope, input);
  const result = await collectXometryOffers(page(texts), 2, capture.observe).catch(() => null);
  capture.close(); return { capture, result };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function session(choice: string) {
  const caps = { authorize: vi.fn(async () => true), reserve: vi.fn(async () => ({ reservationId: "reserved", estimatedUsd: 0.1 })),
    settle: vi.fn(async () => undefined), audit: vi.fn(async () => true), decide: vi.fn(async (q: ChoiceQuestion) => ({
      model: JEV_MODEL, choice, confidence: 1, inputTokens: 10, outputTokens: 5,
      probabilities: Object.fromEntries(Object.keys(q.criteria).map((key) => [key, key === choice ? 1 : 0])) })) };
  return { caps, session: new OperationalJevSession({ mode: "shadow", capabilities: caps, admission: { scope, expiresAt: Date.now() + 60000,
    uses: OPERATIONAL_JEV_USES, evidenceProfiles: ["quote_facts.v1", "catalog_facts.v1", "clarification_facts.v1", "presentation_facts.v1"] } }) };
}
// Independently specified synthetic engineering catalog. Values are not inferred from
// requested fields or selected labels; the host fixture binds this fixed tuple to capture.
function issueSyntheticCatalog(context: EngineeringCatalogIssueContext): EngineeringCatalogArtifact {
  return { contract: "jev-engineering-catalog.v1", provider: "xometry", catalogId: "secret-catalog", catalogRevision: "fixture-v1",
    scope: context.scope, requirementBinding: context.expectedRequirement, issuedAt: context.now, expiresAt: context.now + 500,
    source: { identity: "synthetic-only-source", sha256: "f".repeat(64), schemaRevision: "fixture-schema-v1",
      collection: "observed_configuration", completeness: "complete", candidateCount: 1, observationsSha256: context.observationsSha256 },
    namespaces: ["material", "finish"].map((field) => ({ namespace: field, field: field as "material" | "finish",
      attributeName: "data-option-id", controlSelector: `#${field}`, optionSelector: "role=option" })),
    options: [{ id: "secret-compatible-tuple", fields: { material: "secret-grade", process: "secret-process", finish: "secret-finish", tightestToleranceInch: 0.01 },
      observedBindings: [{ namespace: "material", observedId: "secret-material-id" }, { namespace: "finish", observedId: "secret-finish-id" }] }],
    materialEquivalenceApprovals: [] };
}
async function capturedCatalog(authority?: EngineeringCatalogAuthority) {
  const capture = new OperationalEvidenceCapture(scope, input, authority); const clicks = vi.fn();
  for (const field of ["material", "finish"] as const) {
    const option = { waitFor: async () => undefined, click: clicks, innerText: async () => `secret-${field}-label`,
      getAttribute: async (name: string) => name === "data-option-id" ? `secret-${field}-id` : null };
    const page = { getByRole: () => ({ first: () => option }) } as unknown as Page;
    await chooseOptionByTerms(page, [field], [".option"], field, `#${field}`, capture.observe);
  }
  capture.close(); expect(clicks).toHaveBeenCalledTimes(2); return capture;
}
describe("operational consumers of original actual collector evidence", () => {
  async function queuedQuote(capture: OperationalEvidenceCapture) {
    const test = session("span_0"), queue = new OperationalJevObservations();
    queue.enqueue("quote_evidence", async () => {
      const plan = await capture.plan("quote_evidence");
      const receipt = await test.session.reviewEvidence(scope, plan);
      queue.retainLocal("quote", { plan, receipt, result: await plan.resolve(receipt.proposal ?? "abstain") });
    });
    expect(test.caps.reserve).not.toHaveBeenCalled(); expect(test.caps.decide).not.toHaveBeenCalled();
    await queue.drain();
    return { ...test, local: queue.localReview().get("quote") };
  }
  it("drains a collected unique total through the real session with only fixed facts and original local identity", async () => {
    const { capture } = await captured(); const test = await queuedQuote(capture);
    expect(test.local).toMatchObject({ receipt: { outcome: "observed", proposal: "span_0" },
      result: { status: "evidence_selected", publicationAllowed: false } });
    expect(test.caps.reserve).toHaveBeenCalledTimes(1); expect(test.caps.decide).toHaveBeenCalledTimes(1);
    expect(test.caps.decide.mock.calls[0][0].state).toEqual({ candidates: [
      { key: "span_0", firmTotal: true, quantityMatches: true, revisionMatches: true, explicitUsd: true },
    ] });
    const selected = (test.local as { result: { selected: { document: object } } }).result.selected;
    const original = capture.source().observations.find((record) => record.kind === "quote")!;
    expect(original.kind === "quote" && selected.document === original.documents[0]).toBe(true);
    expect(JSON.stringify(test.caps.decide.mock.calls)).not.toMatch(/secret|40\.00|20\.00/);
  });
  it.each([
    ["uppercase competing total", `${text}\nFirm total USD 80.00 quantity: 2 revision: B`],
    ["lowercase competing currency", `${text}\nfirm total usd 80.00 quantity: 2 revision: B`],
    ["competing total before valid source", `Firm total USD 80.00 quantity: 2 revision: B\n${text}`],
    ["duplicate identical total", `${text}\n${total}`],
    ["contradictory auxiliary amount", text.replace("USD $40.00", "USD $80.00")],
    ["malformed money", text.replace(total, total.replace("40.00", "40.0"))],
    ["unknown context", `${text}\nsecret-customer-note`],
    ["no firm disclaimer", `${text}\nNo firm quote is available.`],
    ["budgetary disclaimer", `${text}\nbudgetary estimate, not a firm quote`],
    ["missing total", text.replace(total, "")],
    ["conflicting revision", text.replace(total, total.replace("revision: B", "revision: C"))],
    ["oversized complete line", `${text}\nReference: ${"x".repeat(2001)}`],
  ])("queued %s is unavailable before reservation or inference", async (_name, source) => {
    const { capture } = await captured([source]); const test = await queuedQuote(capture);
    expect(test.local).toMatchObject({ plan: { question: null, baseline: "abstain" }, receipt: { outcome: "unavailable" }, result: { status: "unavailable" } });
    expect(test.caps.reserve).not.toHaveBeenCalled(); expect(test.caps.decide).not.toHaveBeenCalled();
    expect(JSON.stringify(capture.source())).toContain(JSON.stringify(source).slice(1, -1));
  });
  it.each(["duplicate documents", "replayed observation", "unavailable quote", "unavailable catalog", "unbranded extra document",
    "cloned extra document", "unknown record", "capture overflow", "missing approved revision", "conflicting second document"])(
    "refuses the entire queued capture for %s without retaining the valid prefix", async (kind) => {
      const approved = structuredClone(input);
      if (kind === "missing approved revision") approved.requirement.revision = null;
      const capture = new OperationalEvidenceCapture(scope, approved);
      const records: XometryProviderObservation[] = [];
      await collectXometryOffers(page([text]), 2, (record) => {
        // The collector deduplicates identical DOM text. Exercise duplicate capture
        // documents explicitly, retaining the original authenticated document objects.
        const supplied = kind === "duplicate documents" && record.kind === "quote"
          ? { ...record, documents: [record.documents[0], record.documents[0]] } : record;
        records.push(supplied); capture.observe(supplied);
      });
      const original = records.find((record) => record.kind === "quote")!;
      if (kind === "replayed observation") capture.observe(original);
      if (kind === "unavailable quote" || kind === "unavailable catalog") capture.observe(unavailableXometryObservation(kind === "unavailable quote" ? "quote" : "catalog"));
      if (kind === "unbranded extra document") capture.observe(createXometryQuoteObservation([{ selector: ".quote", text, tierText: "Standard", attributes: {} }], 2));
      if (kind === "cloned extra document") capture.observe(structuredClone(original));
      if (kind === "unknown record") capture.observe({ kind: "unknown", provider: "xometry" } as unknown as XometryProviderObservation);
      if (kind === "capture overflow") {
        const badge = records.find((record) => record.kind === "presentation")!;
        for (let i = 0; i < 133; i++) capture.observe(badge);
        expect(capture.source().overflow).toBe(true);
      }
      if (kind === "conflicting second document") await collectXometryOffers(page([text.replace("revision: B", "revision: C")]), 2, capture.observe);
      capture.close(); const test = await queuedQuote(capture);
      expect(test.local).toMatchObject({ plan: { question: null }, receipt: { outcome: "unavailable" } });
      expect(test.caps.reserve).not.toHaveBeenCalled(); expect(test.caps.decide).not.toHaveBeenCalled();
      expect(capture.source().observations).toContain(original);
    });
  it("selects an exact positively observed firm total, retains whole source and minimizes transport", async () => {
    const { capture, result } = await captured();
    expect(result).toEqual(await collectXometryOffers(page([text]), 2));
    const plan = await capture.plan("quote_evidence"); expect(plan.unavailable).toBeNull();
    const test = session("span_0"); const receipt = await test.session.reviewEvidence(scope, plan);
    expect(receipt).toMatchObject({ outcome: "observed", proposal: "span_0" });
    expect(await plan.resolve(receipt.proposal!)).toMatchObject({ status: "evidence_selected", publicationAllowed: false,
      selected: { span: { text: total, quantity: 2, revision: "B", currency: "USD" }, document: { text } } });
    expect(JSON.stringify(test.caps.decide.mock.calls)).not.toMatch(/secret|40\.00|revision.*B/);
    expect(JSON.stringify(test.caps.audit.mock.calls)).not.toContain("secret");
    expect(test.caps.settle).not.toHaveBeenCalled();
    expect(Object.isFrozen((plan.question!.state as { candidates: object[] }).candidates[0])).toBe(true);
    expect(() => { (plan.question!.state as { candidates: object[] }).candidates.push({}); }).toThrow();
  });
  it.each([
    total.replace("quantity: 2", ""), total.replace("revision: B", ""), total.replace("USD", "$"),
    total.replace("Firm", "Not firm"), total.replace("total", "unit"), total.replace("revision: B", "revision: C"),
    `${total}\nRevision: C`,
  ])("abstains pre-model without exact complete positive evidence: %s", async (line) => {
    const { capture } = await captured([text.replace(total, line)]);
    const plan = await capture.plan("quote_evidence"); const test = session("span_0");
    expect(await test.session.reviewEvidence(scope, plan)).toMatchObject({ outcome: "unavailable" });
    expect(test.caps.decide).not.toHaveBeenCalled(); expect(test.caps.reserve).not.toHaveBeenCalled();
  });
  it("rejects eligible candidate overflow instead of selecting from a truncated prefix", async () => {
    const { capture } = await captured([text.replace(total, Array.from({ length: 63 }, () => total).join("\n"))]);
    expect((await capture.plan("quote_evidence")).unavailable).toBe("quote_spans_missing");
    expect(JSON.stringify(capture.source())).toContain(Array.from({ length: 63 }, () => total).join("\\n"));
  });
  it("does not promote a publicly constructed quote record into actual collector proof", async () => {
    const capture = new OperationalEvidenceCapture(scope, input);
    const observation = createXometryQuoteObservation([{ selector: ".quote", text, tierText: "Least Expensive", attributes: {} }], 2);
    capture.observe(observation); capture.close();
    expect((await capture.plan("quote_evidence")).unavailable).toBe("quote_spans_missing");
    expect((await capture.plan("relevance")).unavailable).toBe("relevance_classification_missing");
  });
  it("uses original authenticated badge-parent identity and retains complete quote after exclusion", async () => {
    const { capture } = await captured(); const plan = await capture.plan("relevance");
    const test = session("drop_optional"); const receipt = await test.session.reviewEvidence(scope, plan);
    expect(receipt).toMatchObject({ proposal: "drop_optional" });
    const result = await plan.resolve(receipt.proposal!);
    expect(JSON.stringify(result)).toContain("secret-customer-note");
    expect(result).toMatchObject({ proposedExcludedIds: expect.arrayContaining([expect.any(String)]) });
    expect(JSON.stringify(test.caps.decide.mock.calls)).not.toContain("secret");
  });
  it("uses actual approved facts plus observed contradiction with fixed clarification only", async () => {
    const { capture } = await captured([text.replace(total, total.replace("revision: B", "revision: C"))]);
    const plan = await capture.plan("clarification"); const test = session("revision_conflict");
    expect(plan.baseline).toBe("revision_conflict");
    const receipt = await test.session.reviewEvidence(scope, plan);
    expect(await plan.resolve(receipt.proposal!)).toMatchObject({ result: { templateId: "revision_conflict" }, customerMessageSent: false });
    expect(JSON.stringify(test.caps.decide.mock.calls)).not.toContain("secret");
  });
  it("missing engineering catalog identity/compatibility stays unavailable before reserve/inference", async () => {
    const { capture } = await captured(); const plan = await capture.plan("catalog_mapping"); const test = session("no_match");
    expect(await test.session.reviewEvidence(scope, plan)).toMatchObject({ outcome: "unavailable" });
    expect(test.caps.reserve).not.toHaveBeenCalled(); expect(test.caps.decide).not.toHaveBeenCalled();
  });
  it("retains complete approved description and unprojected constraints locally without disclosure", async () => {
    const approved = structuredClone(input);
    approved.requirement.description = "secret-original-description";
    approved.requirement.spec_snapshot = { process: "secret-process", specialInstruction: "secret-engineering-constraint" };
    const capture = new OperationalEvidenceCapture(scope, approved);
    await collectXometryOffers(page([text]), 2, capture.observe); capture.close();
    approved.requirement.description = "later mutation";
    const plan = await capture.plan("relevance"); const result = await plan.resolve("drop_optional");
    for (const local of [capture.source(), result]) {
      expect(JSON.stringify(local)).toContain("secret-original-description"); expect(JSON.stringify(local)).toContain("secret-engineering-constraint");
      expect(JSON.stringify(local)).not.toContain("later mutation");
    }
    const test = session("drop_optional"); await test.session.reviewEvidence(scope, plan);
    expect(JSON.stringify(test.caps.decide.mock.calls)).not.toContain("secret");
  });
  it.each(["budgetary estimate, not a firm quote", "Indicative pricing", "Subject to change", "Not final",
    "No firm quote is available.", "This is no longer a firm quote.", "Tentative", "Prices may be revised.",
    "Material: No firm quote is available.", "Reference: No firm quote is available.", "Shipping and taxes are additional.",
    "USD 40.00 is not firm", "USD 40.00 USD 80.00", "USD", "USD -40.00", "USD 4O.00", "USD 40.0", "Unknown terms apply."])("refuses contrary complete-document context: %s", async (disclaimer) => {
    const { capture } = await captured([`${text}\n${disclaimer}`]); const test = session("span_0");
    expect(await test.session.reviewEvidence(scope, await capture.plan("quote_evidence"))).toMatchObject({ outcome: "unavailable" });
    expect(test.caps.reserve).not.toHaveBeenCalled(); expect(test.caps.decide).not.toHaveBeenCalled();
  });
  it("refuses oversized full approved source without dropping constraints or invoking accessors", async () => {
    const approved = structuredClone(input); approved.requirement.description = "x".repeat(65537);
    const capture = new OperationalEvidenceCapture(scope, approved);
    await collectXometryOffers(page([text]), 2, capture.observe); capture.close();
    expect(capture.source()).toMatchObject({ approvedRequirementStatus: "unavailable", approvedRequirement: null });
    expect((await capture.plan("quote_evidence")).unavailable).toBeTruthy();
    const getter = vi.fn(() => "constraint"); Object.defineProperty(approved.requirement, "unknown", { enumerable: true, get: getter });
    new OperationalEvidenceCapture(scope, approved); expect(getter).not.toHaveBeenCalled();
  });

  it("joins actual custom option observations to separately issued exact engineering tuple and existing matcher", async () => {
    const issuer = vi.fn(issueSyntheticCatalog); const capture = await capturedCatalog(issuer);
    expect(issuer).not.toHaveBeenCalled(); // No issuer/model/ledger in synchronous observer.
    const plan = await capture.plan("catalog_mapping"); const test = session("option_0");
    expect(plan.unavailable).toBeNull(); expect(plan.baseline).toBe("option_0");
    const receipt = await test.session.reviewEvidence(scope, plan);
    expect(receipt).toMatchObject({ outcome: "observed", proposal: "option_0" });
    expect(await plan.resolve(receipt.proposal!)).toMatchObject({ result: { status: "exact", option: { id: "option_0" } },
      candidateScope: "observed_configuration", publicationAllowed: false, projection: { localEvidence: { optionBindings: [{ catalogOptionId: "secret-compatible-tuple" }] } } });
    expect(JSON.stringify(test.caps.decide.mock.calls)).not.toContain("secret"); expect(JSON.stringify(test.caps.audit.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(capture.source())).toContain("secret-material-id"); expect(test.caps.settle).not.toHaveBeenCalled();
  });
  it.each(["missing", "wrong_binding", "incomplete", "expired"])("refuses %s catalog before inference", async (kind) => {
    const capture = await capturedCatalog(kind === "missing" ? undefined : (context) => {
      const artifact = issueSyntheticCatalog(context);
      if (kind === "wrong_binding") return { ...artifact, scope: { ...artifact.scope, taskId: "different" } };
      if (kind === "incomplete") return { ...artifact, source: { ...artifact.source, completeness: "incomplete" } };
      return { ...artifact, expiresAt: context.now };
    });
    const test = session("option_0"); expect(await test.session.reviewEvidence(scope, await capture.plan("catalog_mapping"))).toMatchObject({ outcome: "unavailable" });
    expect(test.caps.reserve).not.toHaveBeenCalled(); expect(test.caps.decide).not.toHaveBeenCalled();
  });
  it("rechecks catalog expiry after pending audit before inference and before local resolution", async () => {
    vi.useFakeTimers(); const capture = await capturedCatalog(issueSyntheticCatalog); const plan = await capture.plan("catalog_mapping");
    const test = session("option_0"); test.caps.audit.mockImplementation(async (receipt) => {
      if (receipt.phase === "reserved") vi.setSystemTime(Date.now() + 501); return true;
    });
    expect(await test.session.reviewEvidence(scope, plan)).toMatchObject({ outcome: "unavailable", reason: "expired" });
    expect(test.caps.decide).not.toHaveBeenCalled(); expect(test.caps.settle).toHaveBeenCalledWith(expect.objectContaining({ reservationId: "reserved" }), 0, expect.anything());
    expect(await plan.resolve("option_0")).toMatchObject({ status: "unavailable", reason: "catalog_expired" });
  });

  it("actual observed mapping requires explicit bound material equivalence and never relaxes process/finish", async () => {
    for (const approved of [false, true]) {
      const capture = await capturedCatalog((context) => {
        const base = issueSyntheticCatalog(context);
        return { ...base, options: [{ ...base.options[0], fields: { ...base.options[0].fields, material: "secret-equivalent-grade" } }],
          materialEquivalenceApprovals: approved ? [{ approvalId: "synthetic-approved-equivalence", scope: context.scope,
            requirementBinding: context.expectedRequirement, catalogId: base.catalogId, catalogRevision: base.catalogRevision,
            optionId: base.options[0].id, requestedMaterial: "secret-grade", equivalentMaterial: "secret-equivalent-grade", expiresAt: base.expiresAt }] : [] };
      });
      const plan = await capture.plan("catalog_mapping"); const test = session(approved ? "option_0" : "no_match");
      const receipt = await test.session.reviewEvidence(scope, plan);
      expect(await plan.resolve(receipt.proposal!)).toMatchObject({ candidateScope: "observed_configuration",
        result: { status: approved ? "approved_equivalent" : "no_match" } });
      expect(JSON.stringify(test.caps.decide.mock.calls)).not.toContain("secret");
    }
  });

  it("unknown nonempty freeform source is retained but cannot certify the firm-total flag", async () => {
    const originalFreeform = text.replace("Reference: secret-customer-note", "secret-customer-note");
    const { capture } = await captured([originalFreeform]); const plan = await capture.plan("quote_evidence"); const test = session("span_0");
    expect(await test.session.reviewEvidence(scope, plan)).toMatchObject({ outcome: "unavailable" });
    expect(test.caps.reserve).not.toHaveBeenCalled(); expect(test.caps.decide).not.toHaveBeenCalled();
    expect(JSON.stringify(capture.source())).toContain("secret-customer-note");
  });
  it("accepts only exact approved engineering lines and identifier-only references alongside the explicit positive format", async () => {
    const source = `${text}\nMaterial: secret-grade\nFinish: secret-finish\nProcess: secret-process\nQuote ID: Q26-SYNTHETIC`;
    const { capture } = await captured([source]); const plan = await capture.plan("quote_evidence"); const test = session("span_0");
    expect(await test.session.reviewEvidence(scope, plan)).toMatchObject({ proposal: "span_0" });
    const mismatched = await captured([source.replace("Material: secret-grade", "Material: another-grade")]);
    expect((await mismatched.capture.plan("quote_evidence")).unavailable).toBeTruthy();
    const proseReference = await captured([`${text}\nReference: a note with freeform prose`]);
    expect((await proseReference.capture.plan("quote_evidence")).unavailable).toBeTruthy();
  });

  it("does not promote an approved engineering value into a commercial firm-total candidate", async () => {
    const unusual = structuredClone(input); unusual.requirement.material = total;
    const capture = new OperationalEvidenceCapture(scope, unusual);
    await collectXometryOffers(page([`Standard\nUSD $40.00\n5 business days\nMaterial: ${total}`]), 2, capture.observe);
    capture.close(); expect((await capture.plan("quote_evidence")).unavailable).toBe("quote_spans_missing");
  });

});
