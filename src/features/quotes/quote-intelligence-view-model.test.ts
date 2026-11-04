import { describe, expect, it } from "vitest";
import {
  buildAppAwareHref,
  buildGlobalSearchResults,
  buildPartCollection,
  buildQuoteCollection,
  buildQuoteDetailHref,
  createQuoteDisplayCode,
  filterPartCollection,
  filterQuoteCollection,
  parseEngineeringQuery,
  type QuoteIntelligenceJob,
  type QuoteIntelligenceSummary,
} from "./quote-intelligence-view-model";

function makeJob(overrides: Partial<QuoteIntelligenceJob> = {}): QuoteIntelligenceJob {
  return {
    id: "2d404767-dc8a-461b-a06d-c0f7cf31df11",
    title: "Drive collar",
    description: "Turned 6061 collar, Ø1.00 in",
    status: "published",
    tags: ["6061", "turned"],
    requested_service_kinds: ["cnc_machining"],
    primary_service_kind: "cnc_machining",
    created_at: "2026-07-27T12:00:00.000Z",
    updated_at: "2026-07-28T12:00:00.000Z",
    ...overrides,
  };
}

function makeSummary(overrides: Partial<QuoteIntelligenceSummary> = {}): QuoteIntelligenceSummary {
  return {
    partNumber: "COL-100",
    revision: "B",
    description: "Turned 6061 collar, Ø1.00 in",
    quantity: 20,
    requestedQuoteQuantities: [20],
    requestedByDate: null,
    requestedServiceKinds: ["cnc_machining"],
    primaryServiceKind: "cnc_machining",
    serviceNotes: null,
    selectedSupplier: null,
    selectedPriceUsd: null,
    ...overrides,
  };
}

describe("parseEngineeringQuery", () => {
  it.each([
    ['1/2"', "measurement", 0.5, "1/2 in"],
    ['1 1/2"', "measurement", 1.5, "1 1/2 in"],
    ['1-1/2"', "measurement", 1.5, "1-1/2 in"],
    ['Ø1 1/2"', "diameter", 1.5, "Diameter 1 1/2 in"],
    ['Ø1/2"', "diameter", 0.5, "Diameter 1/2 in"],
    ["3/8 in", "measurement", 0.375, "3/8 in"],
    ['.5"', "measurement", 0.5, ".5 in"],
    ["Ø1/4 in", "diameter", 0.25, "Diameter 1/4 in"],
    ["1/2 diameter mm", "diameter", 0.5, "Diameter 1/2 mm"],
  ])("parses the whole engineering number in %s", (query, kind, value, label) => {
    expect(parseEngineeringQuery(query).chips).toEqual([
      expect.objectContaining({ kind, value, label, unit: query.endsWith("mm") ? "mm" : "in" }),
    ]);
  });

  it.each(['1/4-20 1/2"', '6-32 1/2"', "#10-32 1/2 in"])("keeps a thread callout's pitch out of the length in %s", (query) => {
    expect(parseEngineeringQuery(query).chips).toEqual([
      expect.objectContaining({ kind: "measurement", value: 0.5, label: "1/2 in", unit: "in" }),
    ]);
  });

  it("refuses numbers glued to letters", () => {
    expect(parseEngineeringQuery("rev12mm").chips).toEqual([]);
  });

  it.each(["1/2 in 0.5 in", "Ø1/2 in Ø0.5 in"])("uses unique chip keys for %s", (query) => {
    const chips = parseEngineeringQuery(query).chips;
    expect(chips).toHaveLength(2);
    expect(new Set(chips.map((chip) => chip.id)).size).toBe(chips.length);
  });

  it("does not interpret a unitless thread fraction as a measurement", () => {
    expect(parseEngineeringQuery("1/4-20").chips).toEqual([]);
  });

  // A diameter typed without a unit gets no unit assumed (OVD-1033 P2-9b): no chip, same as a bare number.
  it.each([
    ["Ø12", "diameter 12"],
    ["⌀12", "diameter 12"],
    ["12 dia", "diameter 12"],
    ["12 diameter", "diameter 12"],
    ["1.00 dia", "diameter 1.00"],
    ["1.00 diameter", "diameter 1.00"],
    ["Ø1.00", "diameter 1.00"],
    ["⌀1.00", "diameter 1.00"],
    ["1/2 dia", "diameter 1/2"],
    ["1 1/2 dia", "diameter 1 1/2"],
  ])("assumes no unit for the unitless diameter %s", (query, normalized) => {
    const parsed = parseEngineeringQuery(query);
    expect(parsed.normalized).toBe(normalized);
    expect(parsed.tokens).not.toContain("in");
    expect(parsed.chips).toEqual([]);
  });

  it.each([
    ["Ø12 mm", 12, "mm", "Diameter 12 mm"],
    ["⌀12mm", 12, "mm", "Diameter 12 mm"],
    ["12 dia mm", 12, "mm", "Diameter 12 mm"],
    ['Ø1/2"', 0.5, "in", "Diameter 1/2 in"],
    ["Ø0.5 in", 0.5, "in", "Diameter 0.5 in"],
  ])("keeps the typed unit on the diameter %s", (query, value, unit, label) => {
    expect(parseEngineeringQuery(query).chips).toEqual([
      expect.objectContaining({ kind: "diameter", value, unit, label }),
    ]);
  });

  it("keeps an explicit metric diameter unit", () => {
    expect(parseEngineeringQuery("dia 12mm 6061").chips[0]).toMatchObject({
      kind: "diameter",
      label: "Diameter 12 mm",
      unit: "mm",
    });
  });

  it("does not interpret a bare number as a measurement", () => {
    expect(parseEngineeringQuery("6061 bracket 12").chips).toEqual([]);
  });
});

describe("quote display locators", () => {
  it("creates a stable ambiguity-reduced six-character locator", () => {
    const first = createQuoteDisplayCode("job-1");
    expect(first).toBe(createQuoteDisplayCode("job-1"));
    expect(first).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
    expect(createQuoteDisplayCode("job-2")).not.toBe(first);
  });

  it("keeps the legacy job identifier out of the dedicated URL", () => {
    expect(buildQuoteDetailHref("Q7M4DX")).toBe("/quotes/Q7M4DX");
    expect(buildQuoteDetailHref("Q7M4DX", "ios")).toBe("/quotes/Q7M4DX?app=ios");
  });

  it("preserves existing query and fragment state while marking iOS navigation", () => {
    expect(buildAppAwareHref("/projects/project-1?part=job-1#drawing", "ios")).toBe(
      "/projects/project-1?part=job-1&app=ios#drawing",
    );
    expect(buildAppAwareHref("/parts/job-1", null)).toBe("/parts/job-1");
  });
});

describe("quote collection", () => {
  it("uses client-safe request facts and searches the transparent local reference live", () => {
    const job = makeJob();
    const quotes = buildQuoteCollection({
      jobs: [job],
      summariesByJobId: new Map([[job.id, makeSummary()]]),
      referencesByJobId: new Map([[job.id, "PO-4471"]]),
      factsByJobId: new Map([
        [
          job.id,
          {
            offerCount: 3,
            requestedAt: "2026-07-27T15:00:00.000Z",
          },
        ],
      ]),
    });

    expect(quotes[0]).toMatchObject({
      displayCode: expect.stringMatching(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/),
      reference: "PO-4471",
      offerCount: 3,
      requestedAt: "2026-07-27T15:00:00.000Z",
      stateLabel: "Offers available",
    });
    expect(filterQuoteCollection(quotes, parseEngineeringQuery("PO-4471"))).toHaveLength(1);
  });

  it("searches access-filtered manufacturing metadata without geometry inference", () => {
    const job = makeJob({
      title: "Drive collar",
      description: null,
      tags: [],
    });
    const metadata = new Map([
      [
        job.id,
        {
          material: "17-4 PH stainless",
          finish: "Passivated",
          process: "CNC turning",
          threads: "1/4-20 UNC",
          tightestToleranceInch: 0.0005,
          fileNames: ["COL-100.step", "COL-100.pdf"],
        },
      ],
    ]);
    const parts = buildPartCollection({
      jobs: [job],
      summariesByJobId: new Map([[job.id, makeSummary({ description: null })]]),
      metadataByJobId: metadata,
      appMode: "ios",
    });
    const quotes = buildQuoteCollection({
      jobs: [job],
      summariesByJobId: new Map([[job.id, makeSummary({ description: null })]]),
      metadataByJobId: metadata,
    });

    expect(parts[0]).toMatchObject({
      material: "17-4 PH stainless",
      finish: "Passivated",
      process: "CNC turning",
      href: `/parts/${job.id}?app=ios`,
    });
    expect(filterQuoteCollection(quotes, parseEngineeringQuery("1/4-20"))).toHaveLength(1);
    expect(filterQuoteCollection(quotes, parseEngineeringQuery("0.0005 in"))).toHaveLength(1);
    expect(filterQuoteCollection(quotes, parseEngineeringQuery("passivated"))).toHaveLength(1);
  });

  it("filters parts live by normalized diameter metadata and keeps unsupported assemblies empty", () => {
    const job = makeJob();
    const parts = buildPartCollection({
      jobs: [job],
      summariesByJobId: new Map([[job.id, makeSummary()]]),
    });
    const diameterMatches = filterPartCollection(
      parts,
      "parts",
      parseEngineeringQuery("1.00 dia"),
    );

    expect(diameterMatches).toHaveLength(1);
    expect(diameterMatches[0].matchExplanations).not.toEqual([]);
    expect(
      filterPartCollection(parts, "assemblies", parseEngineeringQuery("")),
    ).toEqual([]);
  });

  it("finds metric and inch parts for a unitless diameter query", () => {
    // No service kinds: names like "cnc_machining" contain "in" and would hide a stray inch token.
    const shaft = makeJob({
      id: "job-shaft",
      title: "Turned shaft",
      description: "Turned shaft, Ø12 mm",
      tags: ["303"],
      requested_service_kinds: [],
      primary_service_kind: null,
    });
    const flange = makeJob({
      id: "job-flange",
      title: "Pipe flange",
      description: "Pipe flange, Ø12 in",
      tags: ["304"],
      requested_service_kinds: [],
      primary_service_kind: null,
    });
    const noService = { requestedServiceKinds: [], primaryServiceKind: null };
    const parts = buildPartCollection({
      jobs: [shaft, flange],
      summariesByJobId: new Map([
        [shaft.id, makeSummary({ ...noService, partNumber: "SH-12", revision: "A", description: shaft.description })],
        [flange.id, makeSummary({ ...noService, partNumber: "FL-12", revision: "A", description: flange.description })],
      ]),
    });

    expect(filterPartCollection(parts, "parts", parseEngineeringQuery("Ø12")).map((part) => part.id).sort()).toEqual([
      "job-flange",
      "job-shaft",
    ]);
    expect(filterPartCollection(parts, "parts", parseEngineeringQuery("Ø12 mm")).map((part) => part.id)).toEqual([
      "job-shaft",
    ]);
  });

  it("searches part and quote metadata through one global result stream", () => {
    const job = makeJob();
    const summariesByJobId = new Map([[job.id, makeSummary()]]);
    const parts = buildPartCollection({ jobs: [job], summariesByJobId });
    const quotes = buildQuoteCollection({
      jobs: [job],
      summariesByJobId,
      referencesByJobId: new Map([[job.id, "PO-4471"]]),
    });

    expect(
      buildGlobalSearchResults({
        parts,
        quotes,
        query: parseEngineeringQuery("COL-100"),
        appMode: "ios",
      }).map((result) => result.kind),
    ).toEqual(["part", "quote"]);
    expect(
      buildGlobalSearchResults({
        parts,
        quotes,
        query: parseEngineeringQuery("PO-4471"),
      }),
    ).toEqual([
      expect.objectContaining({
        kind: "quote",
        context: expect.stringContaining("PO-4471"),
      }),
    ]);
  });
});
