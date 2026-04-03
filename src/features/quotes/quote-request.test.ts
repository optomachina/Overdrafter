import { describe, expect, it } from "vitest";
import { buildQuoteRequestViewModel } from "@/features/quotes/quote-request";
import type {
  JobRecord,
  PartAggregate,
  QuoteRequestRecord,
  QuoteRunRecord,
} from "@/features/quotes/types";
import type { QuoteRequestViewModel } from "@/features/quotes/quote-request";

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

function expectRequestAction(model: QuoteRequestViewModel, disabled: boolean) {
  expect(model.action).toEqual({
    kind: "request",
    label: "Request quote",
    disabled,
  });
}

function expectBlockedNotRequested(
  model: QuoteRequestViewModel,
  blockerReason: string,
  actionKind: QuoteRequestViewModel["action"]["kind"] = "request",
) {
  expect(model.status).toBe("not_requested");
  expect(model.tone).toBe("blocked");
  expect(model.blockerReasons).toContain(blockerReason);

  if (actionKind === "request") {
    expectRequestAction(model, true);
    return;
  }

  expect(model.action.kind).toBe(actionKind);
  expect(model.action.disabled).toBe(true);
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

  it("blocks requests while the part package is still being prepared", () => {
    const model = buildQuoteRequestViewModel({
      job: makeJob(),
      part: null,
      latestQuoteRequest: null,
      latestQuoteRun: null,
    });

    expectBlockedNotRequested(model, "This part is still being prepared.");
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

  it("blocks requests when quote-compatible work is missing material", () => {
    const defaultPart = makePart();
    const model = buildQuoteRequestViewModel({
      job: makeJob(),
      part: makePart({
        approvedRequirement: {
          ...defaultPart.approvedRequirement,
          material: "   ",
        },
      }),
      latestQuoteRequest: null,
      latestQuoteRun: null,
    });

    expectBlockedNotRequested(model, "Add material before requesting a quote.");
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
    expect(model.detail).toBe("This quote request was canceled before a response was received.");
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

  it("surfaces the received state from a live request record", () => {
    const model = buildQuoteRequestViewModel({
      job: makeJob({ status: "internal_review" }),
      part: makePart(),
      latestQuoteRequest: makeRequest({ status: "received" }),
      latestQuoteRun: makeRun({ quote_request_id: "request-1", status: "completed" }),
    });

    expect(model.status).toBe("received");
    expect(model.label).toBe("Quoted");
    expect(model.tone).toBe("ready");
    expect(model.action).toEqual({
      kind: "none",
      label: "Quoted",
      disabled: true,
    });
  });

  it.each([
    {
      name: "blocks requests when the job is archived",
      job: makeJob({ archived_at: "2026-03-20T00:00:00.000Z" }),
      part: makePart(),
      blockerReason: "Archived parts cannot request quotes.",
    },
    {
      name: "blocks requests when the job is closed",
      job: makeJob({ status: "closed" }),
      part: makePart(),
      blockerReason: "This part is already closed to new quote requests.",
    },
    {
      name: "blocks requests when the job is client_selected",
      job: makeJob({ status: "client_selected" }),
      part: makePart(),
      blockerReason: "This part is already closed to new quote requests.",
    },
    {
      name: "blocks requests when the job has no quote-compatible service kinds",
      job: makeJob({ requested_service_kinds: ["design_review"] }),
      part: makePart(),
      blockerReason: "Only manufacturing quote and sourcing-only requests can start vendor quoting.",
    },
    {
      name: "blocks requests when the part has no approved requirement",
      job: makeJob(),
      part: makePart({ approvedRequirement: null }),
      blockerReason:
        "Finish the request details so OverDrafter can create approved quote requirements.",
    },
  ])("$name", ({ job, part, blockerReason }) => {
    const model = buildQuoteRequestViewModel({
      job,
      part,
      latestQuoteRequest: null,
      latestQuoteRun: null,
    });

    expectBlockedNotRequested(model, blockerReason);
  });

  it("disables retry and sets blocked tone when a failed request has active blockers", () => {
    const model = buildQuoteRequestViewModel({
      job: makeJob({ archived_at: "2026-03-20T00:00:00.000Z" }),
      part: makePart(),
      latestQuoteRequest: makeRequest({ status: "failed", failure_reason: null }),
      latestQuoteRun: makeRun({ quote_request_id: "request-1", status: "failed" }),
    });

    expect(model.status).toBe("failed");
    expect(model.tone).toBe("blocked");
    expect(model.action).toEqual({
      kind: "retry",
      label: "Retry quote",
      disabled: true,
    });
    expect(model.blockerReasons.length).toBeGreaterThan(0);
  });

  it("uses latestQuoteRequest status over the quote-run fallback when both are present", () => {
    // The run is "completed" which would normally derive "received",
    // but the request record says "queued" — request wins.
    const model = buildQuoteRequestViewModel({
      job: makeJob({ status: "quoting" }),
      part: makePart(),
      latestQuoteRequest: makeRequest({ status: "queued" }),
      latestQuoteRun: makeRun({ quote_request_id: "request-1", status: "completed" }),
    });

    expect(model.status).toBe("queued");
    expect(model.tone).toBe("warning");
    expect(model.label).toBe("Queued");
    expect(model.action).toEqual({
      kind: "cancel",
      label: "Cancel request",
      disabled: false,
    });
  });
});
