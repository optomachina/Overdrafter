import { describe, expect, it } from "vitest";
import { buildQuoteRequestViewModel } from "@/features/quotes/quote-request";
import type {
  JobRecord,
  PartAggregate,
  QuoteRequestRecord,
  QuoteRunRecord,
} from "@/features/quotes/types";

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    organization_id: "org-1",
    project_id: null,
    selected_vendor_quote_offer_id: null,
    created_by: "user-1",
    title: "Bracket",
    description: null,
    status: "ready_to_quote",
    source: "client_home",
    active_pricing_policy_id: null,
    tags: [],
    requested_service_kinds: ["manufacturing_quote"],
    primary_service_kind: "manufacturing_quote",
    service_notes: null,
    requested_quote_quantities: [10],
    requested_by_date: null,
    archived_at: null,
    created_at: "2026-03-15T00:00:00.000Z",
    updated_at: "2026-03-15T00:00:00.000Z",
    ...overrides,
  };
}

function makePart(overrides: Partial<PartAggregate> = {}): PartAggregate {
  return {
    id: "part-1",
    job_id: "job-1",
    organization_id: "org-1",
    name: "Bracket",
    normalized_key: "bracket",
    cad_file_id: "cad-1",
    drawing_file_id: null,
    quantity: 10,
    created_at: "2026-03-15T00:00:00.000Z",
    updated_at: "2026-03-15T00:00:00.000Z",
    cadFile: {
      id: "cad-1",
      job_id: "job-1",
      organization_id: "org-1",
      file_kind: "cad",
      blob_id: "blob-1",
      storage_bucket: "job-files",
      storage_path: "cad.step",
      normalized_name: "cad.step",
      original_name: "cad.step",
      size_bytes: 123,
      mime_type: "application/step",
      content_sha256: "hash",
      matched_part_key: null,
      uploaded_by: "user-1",
      created_at: "2026-03-15T00:00:00.000Z",
    },
    drawingFile: null,
    extraction: null,
    approvedRequirement: {
      id: "requirement-1",
      part_id: "part-1",
      organization_id: "org-1",
      approved_by: "user-1",
      description: "Bracket",
      part_number: "BRKT-001",
      revision: "A",
      material: "6061-T6",
      finish: null,
      tightest_tolerance_inch: null,
      quantity: 10,
      quote_quantities: [10],
      requested_by_date: null,
      applicable_vendors: ["xometry"],
      spec_snapshot: {},
      approved_at: "2026-03-15T00:00:00.000Z",
      created_at: "2026-03-15T00:00:00.000Z",
      updated_at: "2026-03-15T00:00:00.000Z",
    },
    vendorQuotes: [],
    ...overrides,
  };
}

function makeRequest(overrides: Partial<QuoteRequestRecord> = {}): QuoteRequestRecord {
  return {
    id: "request-1",
    organization_id: "org-1",
    job_id: "job-1",
    requested_by: "user-1",
    requested_vendors: ["xometry"],
    service_request_line_item_id: null,
    status: "queued",
    failure_reason: null,
    received_at: null,
    failed_at: null,
    canceled_at: null,
    created_at: "2026-03-15T00:00:00.000Z",
    updated_at: "2026-03-15T00:00:00.000Z",
    ...overrides,
  };
}

function makeRun(overrides: Partial<QuoteRunRecord> = {}): QuoteRunRecord {
  return {
    id: "run-1",
    quote_request_id: null,
    job_id: "job-1",
    organization_id: "org-1",
    initiated_by: "user-1",
    status: "queued",
    requested_auto_publish: false,
    created_at: "2026-03-15T00:00:00.000Z",
    updated_at: "2026-03-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildQuoteRequestViewModel", () => {
  it("allows new requests when the part is quote-ready", () => {
    const model = buildQuoteRequestViewModel({
      job: makeJob(),
      part: makePart(),
      latestQuoteRequest: null,
      latestQuoteRun: null,
    });

    expect(model.status).toBe("not_requested");
    expect(model.action).toEqual({
      kind: "request",
      label: "Request quote",
      disabled: false,
    });
  });

  it("blocks requests when the CAD file is missing", () => {
    const model = buildQuoteRequestViewModel({
      job: makeJob(),
      part: makePart({
        cad_file_id: null,
        cadFile: null,
      }),
      latestQuoteRequest: null,
      latestQuoteRun: null,
    });

    expect(model.status).toBe("not_requested");
    expect(model.tone).toBe("blocked");
    expect(model.blockerReasons).toContain("Upload a CAD model before requesting a quote.");
    expect(model.action.disabled).toBe(true);
  });

  it("surfaces queued and requesting request states directly", () => {
    const queued = buildQuoteRequestViewModel({
      job: makeJob({ status: "quoting" }),
      part: makePart(),
      latestQuoteRequest: makeRequest({ status: "queued" }),
      latestQuoteRun: makeRun({ quote_request_id: "request-1", status: "queued" }),
    });
    const requesting = buildQuoteRequestViewModel({
      job: makeJob({ status: "quoting" }),
      part: makePart(),
      latestQuoteRequest: makeRequest({ status: "requesting" }),
      latestQuoteRun: makeRun({ quote_request_id: "request-1", status: "running" }),
    });

    expect(queued.label).toBe("Queued");
    expect(queued.action).toEqual({
      kind: "cancel",
      label: "Cancel request",
      disabled: false,
    });
    expect(requesting.label).toBe("Requesting");
    expect(requesting.action).toEqual({
      kind: "cancel",
      label: "Cancel request",
      disabled: false,
    });
  });

  it("enables retry when the latest request failed", () => {
    const model = buildQuoteRequestViewModel({
      job: makeJob({ status: "awaiting_vendor_manual_review" }),
      part: makePart(),
      latestQuoteRequest: makeRequest({
        status: "failed",
        failure_reason: "Configured vendors could not return an automated quote and need manual follow-up.",
      }),
      latestQuoteRun: makeRun({ quote_request_id: "request-1", status: "completed" }),
    });

    expect(model.status).toBe("failed");
    expect(model.action).toEqual({
      kind: "retry",
      label: "Retry quote",
      disabled: false,
    });
    expect(model.detail).toContain("manual follow-up");
  });

  it("preserves allowlisted failure reasons in the client view model", () => {
    const model = buildQuoteRequestViewModel({
      job: makeJob(),
      part: makePart(),
      latestQuoteRequest: makeRequest({
        status: "failed",
        failure_reason: "Quote collection failed before a usable vendor response was received.",
      }),
      latestQuoteRun: makeRun({ quote_request_id: "request-1", status: "failed" }),
    });

    expect(model.detail).toBe("Quote collection failed before a usable vendor response was received.");
  });

  it("normalizes legacy xometry-safe failure reasons into vendor-neutral copy", () => {
    const model = buildQuoteRequestViewModel({
      job: makeJob(),
      part: makePart(),
      latestQuoteRequest: makeRequest({
        status: "failed",
        failure_reason: "Xometry quote collection failed before a usable response was received.",
      }),
      latestQuoteRun: makeRun({ quote_request_id: "request-1", status: "failed" }),
    });

    expect(model.detail).toBe("Quote collection failed before a usable vendor response was received.");
  });

  it("replaces unsafe failure reasons with the generic client-safe fallback", () => {
    const model = buildQuoteRequestViewModel({
      job: makeJob(),
      part: makePart(),
      latestQuoteRequest: makeRequest({
        status: "failed",
        failure_reason: "Error: vendor timeout\n    at runVendorQuote (/worker/src/index.ts:1282:17)",
      }),
      latestQuoteRun: makeRun({ quote_request_id: "request-1", status: "failed" }),
    });

    expect(model.detail).toBe("Quote collection did not return a usable vendor response.");
  });

  it("replaces blank failure reasons with the generic client-safe fallback", () => {
    const model = buildQuoteRequestViewModel({
      job: makeJob(),
      part: makePart(),
      latestQuoteRequest: makeRequest({
        status: "failed",
        failure_reason: "   ",
      }),
      latestQuoteRun: makeRun({ quote_request_id: "request-1", status: "failed" }),
    });

    expect(model.detail).toBe("Quote collection did not return a usable vendor response.");
  });

  it("blocks requests when no applicable vendors remain on the approved requirement", () => {
    const defaultPart = makePart();
    const model = buildQuoteRequestViewModel({
      job: makeJob(),
      part: makePart({
        approvedRequirement: {
          ...defaultPart.approvedRequirement,
          applicable_vendors: [],
        },
      }),
      latestQuoteRequest: null,
      latestQuoteRun: null,
    });

    expect(model.tone).toBe("blocked");
    expect(model.blockerReasons).toContain(
      "No enabled vendors are available for this part in its current package state.",
    );
    expect(model.action.disabled).toBe(true);
  });

  it("surfaces the canceled state with a retry action", () => {
    const model = buildQuoteRequestViewModel({
      job: makeJob({ status: "ready_to_quote" }),
      part: makePart(),
      latestQuoteRequest: makeRequest({ status: "canceled", canceled_at: "2026-03-23T00:00:00.000Z" }),
      latestQuoteRun: makeRun({ quote_request_id: "request-1", status: "failed" }),
    });

    expect(model.status).toBe("canceled");
    expect(model.label).toBe("Canceled");
    expect(model.tone).toBe("warning");
    expect(model.action).toEqual({
      kind: "retry",
      label: "Retry quote",
      disabled: false,
    });
  });

  it("falls back to existing quote runs when the request row does not exist yet", () => {
    const model = buildQuoteRequestViewModel({
      job: makeJob({ status: "internal_review" }),
      part: makePart(),
      latestQuoteRequest: null,
      latestQuoteRun: makeRun({ status: "completed" }),
    });

    expect(model.status).toBe("received");
    expect(model.label).toBe("Quoted");
    expect(model.action.disabled).toBe(true);
  });
});
