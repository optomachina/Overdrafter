import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceInlineSearch } from "@/components/workspace/WorkspaceInlineSearch";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    organization_id: "org-1",
    project_id: "project-1",
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
    requested_by_date: "2026-04-15",
    archived_at: null,
    created_at: "2026-03-01T00:00:00Z",
    updated_at: "2026-03-01T00:00:00Z",
    selected_vendor_quote_offer_id: null,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<JobPartSummary> = {}): JobPartSummary {
  return {
    jobId: "job-1",
    partNumber: "BRKT-001",
    revision: "A",
    description: "Bracket",
    requestedServiceKinds: ["manufacturing_quote"],
    primaryServiceKind: "manufacturing_quote",
    serviceNotes: null,
    quantity: 10,
    requestedQuoteQuantities: [10],
    requestedByDate: "2026-04-15",
    importedBatch: null,
    selectedSupplier: null,
    selectedPriceUsd: null,
    selectedLeadTimeBusinessDays: null,
    ...overrides,
  };
}

describe("WorkspaceInlineSearch", () => {
  it("matches part attributes from supplemental search text", async () => {
    render(
      <WorkspaceInlineSearch
        projects={[
          { id: "project-1", name: "QB00001", partCount: 1 },
          { id: "project-2", name: "Valve Project", partCount: 1 },
        ]}
        jobs={[
          makeJob(),
          makeJob({
            id: "job-2",
            project_id: "project-2",
            title: "Valve Housing",
          }),
        ]}
        summariesByJobId={
          new Map<string, JobPartSummary>([
            ["job-1", makeSummary()],
            ["job-2", makeSummary({ jobId: "job-2", partNumber: "VALV-001", revision: "B", description: "Valve Housing" })],
          ])
        }
        jobSearchTextById={new Map([["job-2", "6061-T6 aluminum black anodize cnc"]])}
        onSelectProject={vi.fn()}
        onSelectPart={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "aluminum" },
    });

    expect(await screen.findByText("VALV-001 rev B")).toBeTruthy();
  });

  it("starts scoped to the active project and lets the user clear the scope", async () => {
    render(
      <WorkspaceInlineSearch
        projects={[
          { id: "project-1", name: "QB00001", partCount: 1 },
          { id: "project-2", name: "Valve Project", partCount: 1 },
        ]}
        jobs={[
          makeJob(),
          makeJob({
            id: "job-2",
            project_id: "project-2",
            title: "Valve Housing",
          }),
        ]}
        summariesByJobId={
          new Map<string, JobPartSummary>([
            ["job-1", makeSummary()],
            ["job-2", makeSummary({ jobId: "job-2", partNumber: "VALV-001", revision: "B", description: "Valve Housing" })],
          ])
        }
        scopedProject={{ id: "project-1", name: "QB00001", partCount: 1 }}
        onSelectProject={vi.fn()}
        onSelectPart={vi.fn()}
      />,
    );

    expect(screen.getByText("QB00001")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "valve" },
    });

    expect(screen.queryByText("VALV-001 rev B")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Clear QB00001 search scope" }));

    expect(await screen.findByText("VALV-001 rev B")).toBeTruthy();
  });
});
