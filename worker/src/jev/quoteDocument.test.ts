// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Page } from "patchright";
import { collectXometryOffers, isObservedXometryQuoteDocument } from "../adapters/xometryOffers";
import { XOMETRY_LOCATORS } from "../adapters/xometryConstraints";
import { selectQuoteEvidence, quoteEvidenceInputSchema } from "../quoteIntelligence/quoteEvidence";
import { createXometryQuoteObservation, unavailableXometryObservation, type XometryProviderObservation, type XometryQuoteObservation } from "./providerObservations";
import { projectRequirementProvenance } from "./requirementProvenance";
import { parseQuoteDocuments, QUOTE_DOCUMENT_LIMITS, type QuoteDocumentInput, type QuoteDocumentResult } from "./quoteDocument";

const firm = "Firm total USD 40.00 quantity: 2 revision: B";
const positive = `Standard\nUSD $20.00 ea.\nUSD $40.00\n5 business days\n${firm}\nReference: secret-customer-note`;
function requirement(revision = "B", material = "secret-grade") {
  return projectRequirementProvenance({ id: "req", part_id: "part", revision, material,
    finish: "secret-finish", quantity: 2, quote_quantities: [2], updated_at: "2026-10-02T00:00:00Z",
    tightest_tolerance_inch: 0.01, spec_snapshot: { process: "secret-process" } },
  { requirementId: "req", partId: "part", revision, updatedAt: "2026-10-02T00:00:00Z", requestedQuantity: 2 });
}
/** Actual local collector with a synthetic DOM adapter only. No browser/provider/model call. */
async function collect(texts: string[], tier = "Least Expensive - Lead Time: 5 business days", attributes: Record<string, string> = {}) {
  const observations: XometryProviderObservation[] = [];
  const page = { url: () => "https://www.xometry.com/quoting/quote/Q26-SYNTHETIC",
    locator: (selector: string) => ({ count: async () => selector === XOMETRY_LOCATORS.offerContainers[0] ? texts.length : 0,
      nth: (index: number) => ({ innerText: async () => texts[index], getAttribute: async (name: string) => attributes[name] ?? null,
        locator: (selector: string) => selector.includes("disabled") ? { count: async () => 0 } : { first: () => ({ innerText: async () => tier }) } }) }) } as unknown as Page;
  await collectXometryOffers(page, 2, (observation) => { observations.push(observation); }).catch(() => undefined);
  return observations;
}
async function input(texts = [positive], tier?: string, attributes?: Record<string, string>): Promise<QuoteDocumentInput> {
  return { observations: await collect(texts, tier, attributes), overflow: false, requirement: requirement() };
}
function available(result: QuoteDocumentResult) {
  expect(result.status).toBe("available");
  if (result.status !== "available") throw new Error(result.reason);
  return result;
}
function unavailable(result: QuoteDocumentResult, reason?: string) {
  expect(result).toEqual({ status: "unavailable", reason: reason ?? expect.any(String), publicationAllowed: false });
  expect(result).not.toHaveProperty("candidate"); expect(result).not.toHaveProperty("facts");
  expect(result).not.toHaveProperty("evidenceInput");
}
function quote(observations: readonly XometryProviderObservation[]): XometryQuoteObservation {
  const result = observations.find((observation) => observation.kind === "quote");
  if (!result || result.kind !== "quote") throw new Error("fixture did not collect a quote");
  return result;
}

describe("complete collector quote document aggregate", () => {
  it("retains exact source identity, unit basis and a single compatible firm span", async () => {
    const source = await input();
    const before = JSON.stringify(source);
    const result = available(parseQuoteDocuments(source));
    expect(result.candidate.document).toBe(quote(source.observations).documents[0]);
    expect(isObservedXometryQuoteDocument(result.candidate.document)).toBe(true);
    expect(result.candidate.document.text).toBe(positive);
    const span = result.candidate.span;
    expect(span).toEqual({ id: "candidate-0", start: positive.indexOf(firm), end: positive.indexOf(firm) + firm.length,
      text: firm, amount: 40, currency: "USD", basis: "total", firmness: "firm", quantity: 2, revision: "B", source: "selector",
      selector: XOMETRY_LOCATORS.offerContainers[0] });
    expect(result.documents[0].lines.map((line) => line.role.kind)).toEqual([
      "presentation", "unit", "auxiliary_total", "presentation", "firm_total", "reference",
    ]);
    for (const line of result.documents[0].lines) expect(positive.slice(line.start, line.end)).toBe(line.text);
    expect(JSON.stringify(source)).toBe(before);
    expect(quoteEvidenceInputSchema.safeParse(result.evidenceInput).success).toBe(true);
    const decide = vi.fn(async (_question, baseline: string) => baseline);
    expect(await selectQuoteEvidence(result.evidenceInput, decide)).toMatchObject({ selected: span, flags: [], publicationAllowed: false });
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it("keeps the model-facing projection fixed, minimal and deeply frozen", async () => {
    const first = available(parseQuoteDocuments(await input()));
    const second = available(parseQuoteDocuments(await input([positive.replaceAll("40.00", "80.00")])));
    expect(first.facts).toEqual({ candidates: [{ key: "span_0", firmTotal: true, quantityMatches: true, revisionMatches: true, explicitUsd: true }] });
    expect(second.facts).toEqual(first.facts);
    expect(JSON.stringify(first.facts)).not.toMatch(/secret|USD|40|\bB\b|selector|revision:/);
    expect(Object.isFrozen(first.facts.candidates[0])).toBe(true);
    expect(Object.isFrozen(first.candidate.span)).toBe(true);
    expect(Object.isFrozen(first.evidenceInput.spans)).toBe(true);
    expect(() => { (first.candidate.span as { amount: number }).amount = 99; }).toThrow();
    expect(first.publicationAllowed).toBe(false);
  });

  it.each(["FIRM TOTAL USD 40.00 QUANTITY: 2 REVISION: B", "firm total USD 40.00 quantity: 2 revision: B",
    "FiRm ToTaL USD 40.00 QuAnTiTy: 2 ReViSiOn: B"])("supports keyword case using the same exact parsed span: %s", async (line) => {
    const result = available(parseQuoteDocuments(await input([positive.replace(firm, line)])));
    expect(result.candidate.span.text).toBe(line);
    expect(await selectQuoteEvidence(result.evidenceInput, async (_question, baseline) => baseline)).toMatchObject({ selected: result.candidate.span, flags: [] });
  });

  it.each(["usd", "Usd", "uSD", "USd", "uSd", "UsD", "usD", "eur", "EUR", "US$", "$", "USD$", "CAD", "USD/EUR"])(
    "refuses unsupported currency spelling throughout the complete document: %s", async (currency) => {
      const invalid = firm.replace("USD", currency);
      for (const text of [invalid, `${firm}\n${invalid}`, `${invalid}\n${firm}`]) unavailable(parseQuoteDocuments(await input([text])));
    });

  it.each(["0", "0.00", "-40.00", "+40.00", "40.0", "40.000", "40.", ".40", "04.00", "1,00.00", "1,0000.00", "4O.00", "4e1", "40_00", "40.00USD", "40.00x", "40.00-", "40.00+", "40.00,", "40.00.", "90071992547410.00"])(
    "does not ignore a recognized-looking malformed money token: %s", async (token) => {
      const invalid = firm.replace("40.00", token);
      for (const text of [invalid, `${firm}\n${invalid}`, `${invalid}\n${firm}`]) unavailable(parseQuoteDocuments(await input([text])));
    });

  it.each(["1", "0.01", "40", "40.00", "1,234.56", "1234.56", "999999.99"])("preserves supported amounts without deriving prices: %s", async (amount) => {
    const result = available(parseQuoteDocuments(await input([firm.replace("40.00", amount)])));
    expect(result.candidate.span.amount).toBe(Number(amount.replaceAll(",", "")));
    expect(await selectQuoteEvidence(result.evidenceInput, async (_question, baseline) => baseline)).toMatchObject({ selected: result.candidate.span, flags: [] });
  });

  it.each(["No firm quote is available.", "budgetary estimate, not a firm quote", "Indicative pricing", "Subject to change", "Not final",
    "This quotation is not binding", "All prices are estimates", "Unknown terms apply.", "secret customer freeform note",
    "USD 40.00 is not firm", "USD 40.00 USD 80.00", "USD", "USD -40.00", "USD 4O.00", "USD 40.0", "Firm total USD 40.00",
    "Firm unit USD 40.00 quantity: 2 revision: B", "not Firm total USD 40.00 quantity: 2 revision: B", "Total excludes shipping", "USD 40.00 excluding tax"])(
    "refuses the entire source on unsupported or contrary context: %s", async (line) => {
      for (const text of [`${positive}\n${line}`, `${line}\n${positive}`]) unavailable(parseQuoteDocuments(await input([text])));
    });

  it.each([firm, firm.replace("40.00", "80.00"), firm.toUpperCase(), firm.toLowerCase()])(
    "refuses competing or duplicate firm totals without presenting a model candidate: %s", async (other) => {
      unavailable(parseQuoteDocuments(await input([`${positive}\n${other}`])));
      const first = await input();
      const next = await collect([other]);
      unavailable(parseQuoteDocuments({ ...first, observations: [...first.observations, ...next] }));
    });

  it("does not deduplicate documents or replayed observation objects into uniqueness", async () => {
    const source = await input(); const observation = quote(source.observations);
    unavailable(parseQuoteDocuments({ ...source, observations: [observation, observation] }), "competing_firm_totals");
    unavailable(parseQuoteDocuments({ ...source, observations: [{ ...observation, documents: [...observation.documents, ...observation.documents] }] }), "competing_firm_totals");
  });

  it.each(["USD $80.00", "USD 40.01", "usd 40.00", "USD 40.00/2", "USD 40.00 total", "EUR 40.00"])(
    "refuses contradictory or unparsed auxiliary amounts: %s", async (line) => {
      unavailable(parseQuoteDocuments(await input([`${firm}\n${line}`])));
    });

  it.each(["USD $40.00", "USD 40", "USD 40.00", "USD 40.00 each", "USD 20.00 per piece", "USD $20.00 ea."])(
    "accounts for explicit auxiliary or unit basis: %s", async (line) => {
      const result = available(parseQuoteDocuments(await input([`${firm}\n${line}`])));
      expect(result.documents[0].lines[1].role.kind).toBe(/each|piece|ea\./.test(line) ? "unit" : "auxiliary_total");
      expect(result.candidate.span.amount).toBe(40);
      unavailable(parseQuoteDocuments(await input([line])), "missing_firm_total");
    });

  it.each(["Quantity: 3", "Qty= 3", "Revision: C", "Rev= b", firm.replace("quantity: 2", "quantity: 3"), firm.replace("revision: B", "revision: C"),
    firm.replace("quantity: 2", "quantity: 0"), firm.replace("quantity: 2", "quantity: 9007199254740992"),
    firm.replace("quantity: 2", "quantity: 2.0"), firm.replace("quantity: 2", ""), firm.replace("revision: B", "")])(
    "never fills, skips or normalizes conflicting/missing source fields: %s", async (line) => {
      unavailable(parseQuoteDocuments(await input([`${firm}\n${line}`])));
    });

  it("accounts for all neutral lines while preserving CRLF offsets and indentation", async () => {
    const raw = `Standard\r\n\r\n  ${firm}\t\r\nQuantity: 2\r\nRevision: B\r\nQuote ID: Q_1.2-B\r\nMaterial: secret-grade\r\nFinish: secret-finish\r\nProcess: secret-process`;
    const result = available(parseQuoteDocuments(await input([raw])));
    expect(result.candidate.span.text).toBe(`  ${firm}\t`);
    expect(result.candidate.span.start).toBe(raw.indexOf("  Firm"));
    expect(raw.slice(result.candidate.span.start, result.candidate.span.end)).toBe(result.candidate.span.text);
    expect(result.documents[0].lines).toHaveLength(8);
    expect(await selectQuoteEvidence(result.evidenceInput, async (_question, baseline) => baseline)).toMatchObject({ selected: result.candidate.span, flags: [] });
  });

  it("does not promote approved engineering text containing a commercial sentence into a total", async () => {
    const source = await input([`Material: ${firm}`]);
    unavailable(parseQuoteDocuments({ ...source, requirement: requirement("B", firm) }), "missing_firm_total");
    const withFirm = await input([`${firm}\nMaterial: ${firm}`]);
    const result = available(parseQuoteDocuments({ ...withFirm, requirement: requirement("B", firm) }));
    expect(result.documents[0].lines[1].role.kind).toBe("engineering");
    expect(result.candidate.span.text).toBe(firm);
  });

  it.each(["Material: unapproved", "Finish: unapproved", "Process: unapproved", "Material: secret-grade; not firm", "Reference: words with spaces",
    `Reference: ${"a".repeat(81)}`, "Reference: $40.00", "Reference: https://example.com", "Note: secret-grade"])("refuses unapproved engineering/reference context: %s", async (line) => {
    unavailable(parseQuoteDocuments(await input([`${positive}\n${line}`])));
  });

  it.each(["Least Expensive - Lead Time: 5 business days; not firm", "No firm quote is available.", "Firm total USD 80.00 quantity: 2 revision: B"])(
    "accounts for tier context outside the text body: %s", async (tier) => {
      unavailable(parseQuoteDocuments(await input([positive], tier)));
    });
  it.each([{ "aria-label": "Not firm" }, { "aria-label": "USD 80.00" }, { "data-option-id": "not firm" },
    { disabled: "" }, { disabled: "false" }, { "aria-disabled": "true" }, { "data-available": "false" }])("refuses unsupported or unavailable attribute context: %j", async (attributes) => {
    unavailable(parseQuoteDocuments(await input([positive], "Standard", attributes)));
  });
  it("permits bounded actual identity attributes and explicit enabled presentation", async () => {
    available(parseQuoteDocuments(await input([positive], "Standard", { id: "tier-1", "aria-label": "Standard", "aria-disabled": "false", "data-available": "true" })));
  });

  it("rejects unsupported documents beside a valid one rather than filtering records", async () => {
    for (const other of ["No firm quote is available.", "USD 80.00", "Reference: no-quote", "", firm.replace("revision: B", "revision: C")]) {
      const source = await input();
      // An empty collector capture is an explicit incomplete quote record.
      const more = other ? await collect([other]) : [{ ...quote(source.observations), documents: [] }];
      for (const observations of [[...source.observations, ...more], [...more, ...source.observations]]) {
        unavailable(parseQuoteDocuments({ ...source, observations }));
      }
    }
  });

  it("rejects unavailable/unknown records and source overflow without partial candidates", async () => {
    const source = await input();
    unavailable(parseQuoteDocuments({ ...source, overflow: true }), "incomplete_source");
    for (const record of [unavailableXometryObservation("quote"), unavailableXometryObservation("catalog"),
      { kind: "quote_context", provider: "xometry", text: "No firm quote" }, { ...quote(source.observations), requestedQuantity: 3 }]) {
      unavailable(parseQuoteDocuments({ ...source, observations: [...source.observations, record] } as QuoteDocumentInput));
    }
  });

  it("authenticates every document before source parsing, including copied/replayed lookalikes", async () => {
    const source = await input(); const observed = quote(source.observations);
    const factory = createXometryQuoteObservation([{ text: positive, selector: "#quote", attributes: {} }], 2);
    for (const record of [factory, JSON.parse(JSON.stringify(observed)), { ...observed, documents: [{ ...observed.documents[0] }] }]) {
      unavailable(parseQuoteDocuments({ ...source, observations: [...source.observations, record] }), "invalid_source");
    }
  });

  it("rejects unknown presentation records rather than trusting caller-provided role labels", async () => {
    const source = await input();
    const badge = source.observations.find((observation) => observation.kind === "presentation")!;
    unavailable(parseQuoteDocuments({ ...source, observations: [...source.observations, { ...badge }] }), "invalid_source");
  });

  it("enforces aggregate document/record bounds across captures with no truncation", async () => {
    const source = await input(); const observation = quote(source.observations);
    unavailable(parseQuoteDocuments({ ...source, observations: Array.from({ length: 65 }, () => observation) }), "source_budget");
    unavailable(parseQuoteDocuments({ ...source, observations: Array.from({ length: 133 }, () => observation) }), "source_budget");
    unavailable(parseQuoteDocuments({ ...source, observations: [{ ...observation, documents: Array.from({ length: 65 }, () => observation.documents[0]) }] }), "source_budget");
  });

  it("enforces aggregate text limits including selector, metadata and tier text", async () => {
    const padded = `${firm}\n${Array.from({ length: 600 }, () => `Reference: ${"a".repeat(60)}`).join("\n")}`;
    const one = await input([padded], "Standard");
    available(parseQuoteDocuments(one));
    const two = await collect([padded.replace("a".repeat(60), "b".repeat(60))], "Standard");
    unavailable(parseQuoteDocuments({ ...one, observations: [...one.observations, ...two] }), "source_budget");
  });

  it("refuses oversized complete lines and line sets instead of keeping a valid prefix", async () => {
    unavailable(parseQuoteDocuments(await input([`${firm}\nMaterial: ${"a".repeat(2001)}`])), "source_budget");
    unavailable(parseQuoteDocuments(await input([`${firm}\n${"Standard\n".repeat(QUOTE_DOCUMENT_LIMITS.lines)}`])), "source_budget");
  });

  it.each(["\u00a0", "\u200b", "\u2028", "\u202e", "\u0000", "\r"])("does not hide unsupported separators/controls: %j", async (separator) => {
    unavailable(parseQuoteDocuments(await input([`${firm}${separator}No firm quote is available.`])));
  });

  it.each(["unit", "NOT", "B-unit", "USD40", "EUR40", "no", "budgetary"])("refuses ambiguous revision tokens rejected by the existing span validator: %s", async (revision) => {
    const source = await input([firm.replace("revision: B", `revision: ${revision}`)]);
    unavailable(parseQuoteDocuments({ ...source, requirement: requirement(revision) }), "requirement_unavailable");
  });

  it.each(["A", "B2", "C_01", "REV-99", "a1", "123"])("keeps supported revision identifiers source-bound: %s", async (revision) => {
    const source = await input([firm.replace("revision: B", `revision: ${revision}`)]);
    const result = available(parseQuoteDocuments({ ...source, requirement: requirement(revision) }));
    expect(await selectQuoteEvidence(result.evidenceInput, async (_question, baseline) => baseline)).toMatchObject({ selected: result.candidate.span, flags: [] });
  });

  it("refuses unavailable approved provenance, missing revision and malformed source objects without invoking accessors", async () => {
    const source = await input();
    unavailable(parseQuoteDocuments({ ...source, requirement: { status: "unavailable", reason: "invalid_requirement", localOnly: true, disclosureAuthority: "none" } }), "requirement_unavailable");
    const getter = vi.fn(() => quote(source.observations));
    const records = [quote(source.observations)]; Object.defineProperty(records, "0", { get: getter });
    unavailable(parseQuoteDocuments({ ...source, observations: records }), "invalid_source"); expect(getter).not.toHaveBeenCalled();
    const proxyGet = vi.fn();
    unavailable(parseQuoteDocuments(new Proxy(source, { get: proxyGet }) as QuoteDocumentInput), "invalid_source"); expect(proxyGet).not.toHaveBeenCalled();
    unavailable(parseQuoteDocuments({ ...source, observations: new Array(1) }), "invalid_source");
  });
});
