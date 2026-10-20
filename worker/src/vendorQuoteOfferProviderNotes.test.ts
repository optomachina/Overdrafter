// @vitest-environment node

// OVD-982 policy: the offer `notes` column is the only text a customer can be
// shown as "Provider notes". It must carry text the provider wrote on its own
// page (`providerNotes`) and nothing else. Worker automation status strings
// stay in `raw_payload.workerNotes`, which no customer surface renders.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { UNANCHORED_PRICE_NOTE } from "./extractedValue";
import { buildVendorQuoteOfferPayload, buildVendorQuoteOfferPayloads } from "./vendorQuoteOffer";
import type { ApprovedRequirementRecord, VendorName, VendorQuoteAdapterOutput } from "./types";

const requirement: ApprovedRequirementRecord = {
  id: "requirement-1",
  part_id: "part-1",
  description: "End attachment",
  part_number: "1093-05589",
  revision: "02",
  material: "6061 Alloy",
  finish: "Black Anodize, Type II",
  tightest_tolerance_inch: 0.005,
  quantity: 10,
  quote_quantities: [10],
  requested_by_date: null,
  applicable_vendors: ["xometry"],
  updated_at: "2026-07-30T11:55:00.000Z",
  spec_snapshot: { process: "CNC Machining" },
};

function makeResult(
  vendor: VendorName,
  overrides: Partial<VendorQuoteAdapterOutput>,
): VendorQuoteAdapterOutput {
  return {
    vendor,
    status: "instant_quote_received",
    unitPriceUsd: 9.2,
    totalPriceUsd: 92,
    leadTimeBusinessDays: 6,
    quoteUrl: "https://example.com/quote/1",
    dfmIssues: [],
    notes: [],
    artifacts: [],
    rawPayload: {},
    ...overrides,
  };
}

function build(result: VendorQuoteAdapterOutput) {
  return buildVendorQuoteOfferPayload({
    vendorQuoteResultId: "result-1",
    organizationId: "organization-1",
    vendor: result.vendor,
    requestedQuantity: 10,
    requirement,
    requirementCapturedAt: "2026-07-30T11:55:00.000Z",
    result,
  });
}

// One result per adapter family, with the exact automation strings the adapters
// write today (worker/src/adapters/xometry.ts and fictiv.ts).
const AUTOMATION_RESULTS: Array<{ name: string; result: VendorQuoteAdapterOutput; workerNotes: string[] }> = [
  {
    name: "xometry live capture",
    result: makeResult("xometry", {
      notes: ["Live Xometry quote captured via Playwright."],
      rawPayload: { source: "xometry-live-adapter", detectedFlow: "upload_complete" },
    }),
    workerNotes: ["Live Xometry quote captured via Playwright."],
  },
  {
    name: "xometry manual review",
    result: makeResult("xometry", {
      status: "manual_review_pending",
      notes: ["Xometry flagged the part for manual review after upload and configuration."],
      rawPayload: { detectedFlow: "upload_complete" },
    }),
    workerNotes: ["Xometry flagged the part for manual review after upload and configuration."],
  },
  {
    name: "xometry unanchored price",
    result: makeResult("xometry", { notes: [UNANCHORED_PRICE_NOTE], rawPayload: {} }),
    workerNotes: [UNANCHORED_PRICE_NOTE],
  },
  {
    name: "xometry simulated model",
    result: makeResult("xometry", {
      notes: ["Simulated instant quote generated from the deterministic worker model."],
      rawPayload: { detectedFlow: "simulate" },
    }),
    workerNotes: ["Simulated instant quote generated from the deterministic worker model."],
  },
  {
    name: "xometry manual vendor follow-up reason",
    result: makeResult("xometry", {
      status: "manual_vendor_followup",
      notes: ["Xometry session expired; manual vendor follow-up is required."],
      rawPayload: { detectedFlow: "manual_vendor_followup" },
    }),
    workerNotes: ["Xometry session expired; manual vendor follow-up is required."],
  },
  {
    name: "fictiv portal signal",
    result: makeResult("fictiv", {
      status: "manual_review_pending",
      notes: [
        "Fictiv flagged the part for manual review after upload and configuration.",
        "Portal signal: quote under review",
      ],
      rawPayload: { detectedFlow: "manual_review" },
    }),
    workerNotes: [
      "Fictiv flagged the part for manual review after upload and configuration.",
      "Portal signal: quote under review",
    ],
  },
  {
    name: "generic result with notes and no providerNotes",
    result: makeResult("protolabs", { notes: ["Anything an adapter wants to say"] }),
    workerNotes: ["Anything an adapter wants to say"],
  },
];

describe("vendor offer notes provenance (OVD-982)", () => {
  it.each(AUTOMATION_RESULTS)(
    "$name: notes stay null and the automation text lands only in raw_payload.workerNotes",
    ({ result, workerNotes }) => {
      const payload = build(result);

      expect(payload.notes).toBeNull();
      expect(payload.raw_payload.workerNotes).toEqual(workerNotes);
      expect(payload.raw_payload).not.toHaveProperty("notesSource");
      for (const note of workerNotes) {
        expect(JSON.stringify({ ...payload, raw_payload: undefined })).not.toContain(note);
      }
    },
  );

  it("writes notes and notesSource 'provider' only from providerNotes", () => {
    const payload = build(
      makeResult("xometry", {
        notes: ["Live Xometry quote captured via Playwright."],
        providerNotes: ["Anodize adds 2 business days.", "Tolerance <0.005 in is quoted as +$40."],
      }),
    );

    expect(payload.notes).toBe("Anodize adds 2 business days.\nTolerance <0.005 in is quoted as +$40.");
    expect(payload.raw_payload.notesSource).toBe("provider");
    expect(payload.raw_payload.workerNotes).toEqual(["Live Xometry quote captured via Playwright."]);
    expect(payload.notes).not.toContain("Playwright");
  });

  it("treats empty or blank providerNotes as no provider text", () => {
    for (const providerNotes of [[], [""], ["   ", "\n"]]) {
      const payload = build(makeResult("xometry", { notes: ["automation"], providerNotes }));
      expect(payload.notes).toBeNull();
      expect(payload.raw_payload).not.toHaveProperty("notesSource");
    }
  });

  it("an adapter rawPayload cannot forge the provider marker or the worker notes", () => {
    const payload = build(
      makeResult("xometry", {
        notes: ["automation"],
        rawPayload: { notesSource: "provider", workerNotes: ["forged"] },
      }),
    );

    expect(payload.notes).toBeNull();
    expect(payload.raw_payload).not.toHaveProperty("notesSource");
    expect(payload.raw_payload.workerNotes).toEqual(["automation"]);
  });

  it("a per-offer rawPayload cannot forge the provider marker either", () => {
    const [payload] = buildVendorQuoteOfferPayloads({
      vendorQuoteResultId: "result-1",
      organizationId: "organization-1",
      vendor: "xometry",
      requestedQuantity: 10,
      requirement,
      requirementCapturedAt: "2026-07-30T11:55:00.000Z",
      result: makeResult("xometry", {
        notes: ["automation"],
        offers: [
          {
            providerOptionId: "standard",
            providerLabel: "Standard",
            quoteRef: null,
            quoteUrl: null,
            unitPriceUsd: 9.2,
            totalPriceUsd: 92,
            leadTimeBusinessDays: 6,
            shipReceiveBy: null,
            tier: "Instant",
            sourcing: "automated",
            geographicOrigin: "unknown",
            sortRank: 0,
            provenance: {
              containerSelector: "x",
              providerOptionIdSource: "attribute",
              priceSource: "selector",
              leadTimeSource: "selector",
              geographicOriginSource: "none",
            },
            rawPayload: { notesSource: "provider" },
          },
        ],
      }),
    });

    expect(payload.notes).toBeNull();
    expect(payload.raw_payload).not.toHaveProperty("notesSource");
  });

  it("applies the same notes policy to every offer row of a multi-offer result", () => {
    const base = makeResult("xometry", { notes: ["automation"], providerNotes: ["Provider says hi"] });
    const offer = {
      providerOptionId: "a",
      providerLabel: "A",
      quoteRef: null,
      quoteUrl: null,
      unitPriceUsd: 1,
      totalPriceUsd: 10,
      leadTimeBusinessDays: 5,
      shipReceiveBy: null,
      tier: "Instant",
      sourcing: "automated",
      geographicOrigin: "unknown" as const,
      sortRank: 0,
      provenance: {
        containerSelector: "x",
        providerOptionIdSource: "attribute" as const,
        priceSource: "selector" as const,
        leadTimeSource: "selector" as const,
        geographicOriginSource: "none" as const,
      },
      rawPayload: {},
    };
    const payloads = buildVendorQuoteOfferPayloads({
      vendorQuoteResultId: "result-1",
      organizationId: "organization-1",
      vendor: "xometry",
      requestedQuantity: 10,
      requirement,
      requirementCapturedAt: "2026-07-30T11:55:00.000Z",
      result: { ...base, offers: [offer, { ...offer, providerOptionId: "b", sortRank: 1 }] },
    });

    expect(payloads).toHaveLength(2);
    for (const payload of payloads) {
      expect(payload.notes).toBe("Provider says hi");
      expect(payload.raw_payload.notesSource).toBe("provider");
      expect(payload.raw_payload.workerNotes).toEqual(["automation"]);
    }
  });

  it("no live adapter sets providerNotes until it copies text from the provider's own page", () => {
    // Allowlist of adapter files that may set `providerNotes`. Adding a file here is the
    // reviewed decision that its text is provider-written, not automation status.
    const PROVIDER_NOTES_ALLOWLIST: string[] = [];
    const adaptersDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "adapters");
    const offenders = readdirSync(adaptersDir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => /\bproviderNotes\b/.test(readFileSync(path.join(adaptersDir, file), "utf8")))
      .filter((file) => !PROVIDER_NOTES_ALLOWLIST.includes(file));

    expect(offenders).toEqual([]);
  });
});
