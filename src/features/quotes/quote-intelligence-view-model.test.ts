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
  it.each(["1.00 dia", "1.00 diameter", "Ø1.00", "⌀1.00"])(
    "normalizes the quoted inch-diameter convention for %s",
    (query) => {
      expect(parseEngineeringQuery(query).chips).toEqual([
        expect.objectContaining({
          kind: "diameter",
          label: "Diameter 1 in",
          value: 1,
          unit: "in",
        }),
      ]);
    },
  );

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
