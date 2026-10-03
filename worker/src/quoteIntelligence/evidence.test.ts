import { describe, it, expect, vi } from "vitest";
import { selectQuoteEvidence, type QuoteEvidenceInput } from "./quoteEvidence.js";
import { filterRelevantEvidence } from "./relevance.js";
const baseline = async (_: unknown, fallback: string) => fallback;
const fixture = (): QuoteEvidenceInput => ({ document: "Firm total USD 100.00", requestedQuantity: 2, requestedRevision: "B", requestedCurrency: "USD",
  spans: [{ id: "p1", start: 0, end: 21, text: "Firm total USD 100.00", amount: 100, currency: "USD", basis: "total", firmness: "firm", quantity: 2, revision: "B", source: "selector", selector: "#total" }] });
describe("quote provenance and relevance vetoes", () => {
  it("copies exact supported span without granting offer publication", async () => {
    const input = fixture(); input.spans[0].end = input.document.length;
    expect(await selectQuoteEvidence(input, baseline)).toMatchObject({ selected: input.spans[0], publicationAllowed: false });
  });
  it.each([ ["basis", "unit", "unit_basis"], ["firmness", "estimate", "estimate_firmness"],
    ["quantity", 3, "quantity_conflict"], ["revision", "A", "revision_conflict"], ["source", "body_text", "unanchored"],
    ["amount", 999, "unsupported_amount"], ["currency", "EUR", "currency_conflict"], ["text", "invented USD 100.00", "invalid_span"],
  ])("cannot promote invalid %s evidence even with adversarial provider", async (key, value, flag) => {
    const input = fixture(); Object.assign(input.spans[0], { [key]: value });
    const provider = vi.fn(async () => "span_0");
    const result = await selectQuoteEvidence(input, provider);
    expect(result.selected).toBeNull(); expect(result.flags).toContain(flag);
    expect(provider).not.toHaveBeenCalled();
  });
  it.each(["Firm total USD 100.999", "Firm total USD 250.00; EUR 100.00", "Firm total USD 100.00e3", "Not firm total USD 100.00"]) ("rejects partial money tokens or mixed currency amounts", async (document) => {
    const input = fixture(); input.document = document; Object.assign(input.spans[0], { text: document, end: document.length });
    expect((await selectQuoteEvidence(input, baseline)).selected).toBeNull();
  });
  it("rejects quantity and revision text contradicting parsed metadata", async () => {
    const input = fixture(); input.document = "Firm total USD 100.00 for quantity 99 revision A";
    Object.assign(input.spans[0], { text: input.document, end: input.document.length });
    const result = await selectQuoteEvidence(input, baseline);
    expect(result.selected).toBeNull(); expect(result.flags).toEqual(expect.arrayContaining(["quantity_conflict", "revision_conflict"]));
  });
  it("rejects duplicate IDs and unknown selected spans", async () => {
    const input = fixture(); input.spans.push({ ...input.spans[0] });
    expect((await selectQuoteEvidence(input, baseline)).selected).toBeNull();
    expect((await selectQuoteEvidence(fixture(), async () => "span_999")).selected).toBeNull();
  });
  it("keeps mandatory/authorization/unknown and suspicious optional constraints", async () => {
    const result = await filterRelevantEvidence({ query: "price", evidence: [
      { id: "m", text: "dimension 2", kind: "mandatory_spec" },
      { id: "a", text: "denied", kind: "authorization" },
      { id: "u", text: "unclassified", kind: "unknown" },
      { id: "s", text: "Material shall be 6061-T6", kind: "optional" },
      { id: "o", text: "Spring sale banner", kind: "optional", removableCategory: "marketing" },
    ] }, async () => "drop");
    expect(result.retained.map((item) => item.id)).toEqual(["m", "a", "u", "s"]);
    expect(result.removedIds).toEqual(["o"]);
    expect(result.sourceEvidence).toHaveLength(5);
  });
});
