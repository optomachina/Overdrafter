import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { approveJobRequirements } from "@/features/quotes/api/extraction-api";
import { useInternalJobDetailViewModel } from "./internal-job-detail-view-model";
import { useInternalJobDetailMutations } from "./use-internal-job-detail-mutations";
import { InternalJobRequirementsSection } from "./InternalJobRequirementsSection";
import { InternalJobHeaderActions } from "./InternalJobHeaderActions";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ApprovedPartRequirement,
  JobAggregate,
  ApprovedPartRequirementRecord,
  DrawingExtractionRecord,
  PartAggregate,
  WorkQueueRecord,
} from "@/features/quotes/types";
import { InternalJobPartRequirementCard } from "./InternalJobPartRequirementCard";

vi.mock("@/components/CadModelThumbnail", () => ({
  CadModelThumbnail: () => <div>CAD Preview</div>,
}));

vi.mock("@/components/quotes/RfqLineItemMetadataFields", () => ({
  RfqLineItemMetadataFields: () => <div>RFQ metadata</div>,
}));


vi.mock("@/components/quotes/RequestSummaryBadges", () => ({
  RequestSummaryBadges: () => <div>Request summary badges</div>,
}));

function makeDraft(): ApprovedPartRequirement {
  return {
    partId: "part-1",
    requestedServiceKinds: ["manufacturing_quote"],
    primaryServiceKind: "manufacturing_quote",
    serviceNotes: null,
    description: "Bracket",
    partNumber: "BRKT-001",
    revision: "A",
    material: "6061-T6",
    finish: null,
    tightestToleranceInch: 0.005,
    process: null,
    notes: null,
    quantity: 10,
    quoteQuantities: [10],
    requestedByDate: null,
    shipping: {
      requestedByDateOverride: null,
      packagingNotes: null,
      shippingNotes: null,
    },
    certifications: {
      requiredCertifications: [],
      materialCertificationRequired: null,
      certificateOfConformanceRequired: null,
      inspectionLevel: null,
      notes: null,
    },
    sourcing: {
      regionPreferenceOverride: null,
      preferredSuppliers: [],
      materialProvisioning: null,
      notes: null,
    },
    release: {
      releaseStatus: null,
      reviewDisposition: null,
      quoteBlockedUntilRelease: null,
      notes: null,
    },
    applicableVendors: ["xometry"],
  };
}

function makeApprovedRequirementRecord(): ApprovedPartRequirementRecord {
  return {
    id: "req-1",
    part_id: "part-1",
    organization_id: "org-1",
    approved_by: "user-1",
    description: "Bracket",
    part_number: "BRKT-001",
    revision: "A",
    material: "6061-T6",
    finish: null,
    tightest_tolerance_inch: 0.005,
    quantity: 10,
    quote_quantities: [10],
    requested_by_date: null,
    applicable_vendors: ["xometry"],
    spec_snapshot: {
      process: "milling",
      material: "6061-T6",
      finish: "As machined",
    },
    approved_at: "2026-03-15T00:00:00.000Z",
    created_at: "2026-03-15T00:00:00.000Z",
    updated_at: "2026-03-15T00:00:00.000Z",
  };
}

function makeExtractionRecord(selectedBy: "parser" | "model" | "review"): DrawingExtractionRecord {
  return {
    id: "extract-1",
    part_id: "part-1",
    organization_id: "org-1",
    extractor_version: "test-extractor",
    source_attempt_id: null,
    extraction: {
      description: "Bracket",
      partNumber: "BRKT-001",
      revision: "A",
      extractedDescriptionRaw: {
        value: "Bracket",
        confidence: 1,
        reviewNeeded: false,
        reasons: [],
        sourceRegion: null,
      },
      extractedPartNumberRaw: {
        value: "BRKT-001",
        confidence: 1,
        reviewNeeded: false,
        reasons: [],
        sourceRegion: null,
      },
      extractedRevisionRaw: {
        value: "A",
        confidence: 1,
        reviewNeeded: false,
        reasons: [],
        sourceRegion: null,
      },
      material: {
        raw: "6061-T6",
        normalized: "6061-T6",
        confidence: 1,
      },
      finish: {
        raw: "As machined",
        normalized: null,
        confidence: 1,
      },
      tolerances: {
        tightest: "0.005",
      },
      fieldSelections: {
        description: selectedBy,
        partNumber: "parser",
        revision: "parser",
        material: "parser",
        finish: "parser",
        process: "parser",
      },
    },
    warnings: [],
    evidence: [],
    confidence: 1,
    status: "approved",
    created_at: "2026-03-15T00:00:00.000Z",
    updated_at: "2026-03-15T00:00:00.000Z",
  };
}

function makePart(selectedBy: "parser" | "model" | "review"): PartAggregate {
  return {
    id: "part-1",
    job_id: "job-1",
    organization_id: "org-1",
    name: "Bracket",
    normalized_key: "bracket",
    cad_file_id: "cad-1",
    drawing_file_id: "drawing-1",
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
    drawingFile: {
      id: "drawing-1",
      job_id: "job-1",
      organization_id: "org-1",
      file_kind: "drawing",
      blob_id: "blob-2",
      storage_bucket: "job-files",
      storage_path: "drawing.pdf",
      normalized_name: "drawing.pdf",
      original_name: "drawing.pdf",
      size_bytes: 456,
      mime_type: "application/pdf",
      content_sha256: "hash-2",
      matched_part_key: null,
      uploaded_by: "user-1",
      created_at: "2026-03-15T00:00:00.000Z",
    },
    extraction: makeExtractionRecord(selectedBy),
    approvedRequirement: makeApprovedRequirementRecord(),
    vendorQuotes: [],
  };
}

function makePartQueueTask(): WorkQueueRecord {
  return {
    id: "task-1",
    organization_id: "org-1",
    job_id: "job-1",
    part_id: "part-1",
    quote_run_id: null,
    package_id: null,
    task_type: "extract_part",
    status: "queued",
    attempts: 2,
    attempt_id: null,
    payload: {
      partId: "part-1",
      source: "internal-diagnostics-test",
    },
    available_at: "2026-03-15T00:00:00.000Z",
    locked_at: null,
    locked_by: null,
    last_error: "Temporary worker timeout",
    created_at: "2026-03-15T00:00:00.000Z",
    updated_at: "2026-03-15T00:01:00.000Z",
  };
}

describe("InternalJobPartRequirementCard", () => {
  it("offers eMachineShop in the manual applicable-vendor list", () => {
    render(
      <InternalJobPartRequirementCard
        cadPreviewSource={null}
        disabled={false}
        draft={makeDraft()}
        onDraftChange={() => undefined}
        onDraftQuantityChange={() => undefined}
        onQuoteQuantityInputChange={() => undefined}
        onQuoteQuantityInputCommit={() => undefined}
        part={makePart("parser")}
        partQueueTasks={[]}
        quoteQuantityInput="10"
        showInternalDiagnostics={false}
      />,
    );

    expect(screen.getByText("eMachineShop")).toBeInTheDocument();
  });

  it("adds an AI-assisted label for model-selected extraction provenance", () => {
    render(
      <InternalJobPartRequirementCard
        cadPreviewSource={null}
        disabled={false}
        draft={makeDraft()}
        onDraftChange={() => undefined}
        onDraftQuantityChange={() => undefined}
        onQuoteQuantityInputChange={() => undefined}
        onQuoteQuantityInputCommit={() => undefined}
        part={makePart("model")}
        partQueueTasks={[]}
        quoteQuantityInput="10"
        showInternalDiagnostics
      />,
    );

    const provenance = screen.getAllByLabelText("AI-assisted");

    expect(provenance.length).toBeGreaterThan(0);
  });

  it("does not add the AI-assisted label for parser-selected provenance", () => {
    render(
      <InternalJobPartRequirementCard
        cadPreviewSource={null}
        disabled={false}
        draft={makeDraft()}
        onDraftChange={() => undefined}
        onDraftQuantityChange={() => undefined}
        onQuoteQuantityInputChange={() => undefined}
        onQuoteQuantityInputCommit={() => undefined}
        part={makePart("parser")}
        partQueueTasks={[]}
        quoteQuantityInput="10"
        showInternalDiagnostics
      />,
    );

    expect(screen.queryByLabelText("AI-assisted")).not.toBeInTheDocument();
    expect(screen.getAllByText(/source: parser/i).length).toBeGreaterThan(0);
  });

  it("shows internal diagnostics snapshot and part-scoped queue details", () => {
    render(
      <InternalJobPartRequirementCard
        cadPreviewSource={null}
        disabled={false}
        draft={makeDraft()}
        onDraftChange={() => undefined}
        onDraftQuantityChange={() => undefined}
        onQuoteQuantityInputChange={() => undefined}
        onQuoteQuantityInputCommit={() => undefined}
        part={makePart("model")}
        partQueueTasks={[makePartQueueTask()]}
        quoteQuantityInput="10"
        showInternalDiagnostics
      />,
    );

    expect(screen.getByText("Internal extraction diagnostics")).toBeInTheDocument();
    expect(screen.getByText("Approved spec snapshot")).toBeInTheDocument();
    expect(screen.getByText(/"process": "milling"/i)).toBeInTheDocument();
    expect(screen.getByText("Part queue activity")).toBeInTheDocument();
    expect(screen.getByText("Attempts: 2")).toBeInTheDocument();
    expect(screen.getByText(/temporary worker timeout/i)).toBeInTheDocument();
  });
});

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/features/quotes/api/extraction-api", () => ({
  approveJobRequirements: vi.fn().mockResolvedValue(2), requestExtraction: vi.fn(),
}));

// Exercise the real view model, cards, header and mutation with a populated two-part job.
// Only the network boundary is mocked: a rejected save must never call it or announce success.
describe("internal requirement quantity save integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(approveJobRequirements).mockResolvedValue(2);
  });

  function renderRequirements() {
    const job = {
      job: { id: "job-1", title: "Bracket" },
      parts: [makePart("parser"), { ...makePart("parser"), id: "part-2" }],
      packages: [],
    } as unknown as JobAggregate;
    function Host() {
      const vm = useInternalJobDetailViewModel({ job, latestQuoteRun: null });
      const mutations = useInternalJobDetailMutations({
        clientSummary: vm.clientSummary, getRequirementsForSave: vm.getRequirementsForSave,
        forcePublish: false, jobId: "job-1", latestQuoteRunId: null,
        navigate: vi.fn(), signOut: vi.fn(), userEmail: null,
      });
      return <>
        <InternalJobHeaderActions onRequestExtraction={vi.fn()} onStartQuoteRun={vi.fn()}
          onSaveRequirements={() => mutations.saveRequirementsMutation.mutate()}
          requestExtractionPending={false} startQuoteRunPending={false}
          saveRequirementsPending={mutations.saveRequirementsMutation.isPending}
          requirementsBlocked={vm.requirementsBlocked} writeActionsDisabled={false} />
        <button onClick={() => mutations.saveRequirementsMutation.mutate()}>Attempt programmatic save</button>
        <InternalJobRequirementsSection job={job} cadPreviewSources={vm.cadPreviewSources}
          getDraftForPart={vm.getDraftForPart} getQuoteQuantityInput={vm.getQuoteQuantityInput}
          getQuantityInput={vm.getQuantityInput} onDraftQuantityChange={vm.setDraftQuantity}
          onQuoteQuantityInputChange={(partId, value) => vm.setQuoteQuantityInputs((current) => ({ ...current, [partId]: value }))}
          onQuoteQuantityInputCommit={vm.commitQuoteQuantityInput} updateDraft={vm.updateDraft}
          workQueue={[]} showInternalDiagnostics={false} writeActionsDisabled={false} />
      </>;
    }
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <Host />
    </QueryClientProvider>);
    return {
      quantity: screen.getAllByLabelText("Quantity")[1] as HTMLInputElement,
      quotes: screen.getAllByLabelText("Quote quantities")[1],
      save: screen.getByRole("button", { name: "Save approved requirements" }),
    };
  }

  it.each([
    ["quotes", "10/12.5/25", "Enter whole numbers"],
    ["quotes", "25/50/abc", "Enter whole numbers"],
    ["quotes", "250,500", "Commas are ambiguous"],
    ["quotes", "1,250 2,500", "Commas are ambiguous"],
    ["quotes", "1,250, 2,500", "Commas are ambiguous"],
    ["quotes", "2,500 7,500", "Commas are ambiguous"],
    ["quotes", "100,250 500", "Commas are ambiguous"],
    ["quotes", "1,500,25/50", "Enter whole numbers"],
    ["quotes", "1,500, 2,500 / 5,000", "Enter whole numbers"],
    ["quotes", "0", "Enter whole numbers"],
    ["quotes", "-5", "Enter whole numbers"],
    ["quantity", "12.5", "Enter a whole number"],
    ["quantity", "", "Enter a whole number"],
    ["quantity", "0", "Enter a whole number"],
    ["quantity", "-5", "Enter a whole number"],
    ["quantity", "abc", "Enter a whole number"],
  ] as const)("blocks %s %j in any part, including direct mutation calls, then saves a correction", async (field, text, error) => {
    const host = renderRequirements();
    expect(host.save).toBeEnabled();
    fireEvent.change(host[field], { target: { value: text } });
    fireEvent.blur(host[field]);
    expect(host[field]).toHaveValue(text);
    expect(host[field]).toHaveAccessibleDescription(expect.stringContaining(error));
    expect(host.save).toBeDisabled();
    fireEvent.click(host.save);
    expect(approveJobRequirements).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByText("Attempt programmatic save")));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining(error)));
    expect(approveJobRequirements).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();

    // A working success path proves the no-save assertions above are not vacuous.
    fireEvent.change(host[field], { target: { value: field === "quotes" ? "1,000/2,000" : "50" } });
    fireEvent.blur(host[field]);
    await waitFor(() => expect(host.save).toBeEnabled());
    await act(async () => fireEvent.click(host.save));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Approved 2 part requirement set(s)."));
    expect(approveJobRequirements).toHaveBeenCalledTimes(1);
    expect(vi.mocked(approveJobRequirements).mock.calls[0][1][1]).toMatchObject(
      field === "quotes" ? { quoteQuantities: [10, 1000, 2000] } : { quantity: 50 },
    );
  });

  it.each(["quotes", "quantity"] as const)("allows saving after a service change hides invalid %s text", async (field) => {
    const host = renderRequirements();
    fireEvent.change(host[field], { target: { value: "12.5" } });
    fireEvent.blur(host[field]);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(host.save).toBeDisabled();

    const cadModeling = screen.getAllByRole("checkbox", { name: /CAD modeling/i })[1];
    fireEvent.click(cadModeling);
    expect(screen.getAllByLabelText("Quote quantities")).toHaveLength(1);
    expect(screen.getAllByLabelText("Quantity")).toHaveLength(1);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(host.save).toBeEnabled();
    await act(async () => fireEvent.click(host.save));
    await waitFor(() => expect(approveJobRequirements).toHaveBeenCalledOnce());
    expect(vi.mocked(approveJobRequirements).mock.calls[0][1][1]).toMatchObject({
      requestedServiceKinds: ["manufacturing_quote", "cad_modeling"],
      quantity: 10,
    });

    // Returning to quote services exposes the retained text and blocks Save again.
    fireEvent.click(cadModeling);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(host.save).toBeDisabled();
  });

  it.each(["1,000/2,000", "2,500/5,000/10,000"])("does not alert while typing valid %j", (text) => {
    const host = renderRequirements();
    fireEvent.change(host.quotes, { target: { value: "1,000" } });
    fireEvent.blur(host.quotes);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    for (let length = 1; length <= text.length; length += 1) {
      fireEvent.change(host.quotes, { target: { value: text.slice(0, length) } });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    }
    fireEvent.blur(host.quotes);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(host.save).toBeEnabled();
  });

  it("allows clearing and typing 50, and keeps a separate quote error until corrected", () => {
    const host = renderRequirements();
    fireEvent.change(host.quotes, { target: { value: "250,500" } });
    fireEvent.change(host.quantity, { target: { value: "" } });
    for (const character of "50") {
      fireEvent.change(host.quantity, { target: { value: host.quantity.value + character } });
    }
    expect(host.quantity).toHaveValue("50");
    expect(host.quotes).toHaveValue("250,500");
    expect(host.save).toBeDisabled();
  });
});
