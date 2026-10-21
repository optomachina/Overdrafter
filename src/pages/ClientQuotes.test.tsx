import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { createClientQuoteWorkspaceItemFixture } from "@/features/quotes/client-workspace-fixtures";
import ClientQuotes from "./ClientQuotes";

const mocks = vi.hoisted(() => ({ useClientHomeController: vi.fn() }));
vi.mock("@/features/quotes/use-client-home-controller", () => mocks);
vi.mock("@/components/quote-intelligence/QuoteIntelligenceShell", () => ({
  QuoteIntelligenceShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/quote-intelligence/useQuoteReferences", () => ({ useQuoteReferences: () => new Map() }));
vi.mock("@/features/quotes/use-quote-intelligence-workspace", () => ({
  useQuoteIntelligenceWorkspace: () => ({ metadataByJobId: new Map(), factsByJobId: new Map(), workspaceQuery: { isLoading: false } }),
}));

describe("ClientQuotes selected price", () => {
  it.each([[402.5, "$402.50"], [360, "$360.00"], [null, null]])("preserves the published price %s", (price, formatted) => {
    const item = createClientQuoteWorkspaceItemFixture();
    mocks.useClientHomeController.mockReturnValue({
      user: { id: "user-1" }, accessibleJobs: [item.job], sidebarProjects: [],
      summariesByJobId: new Map([[item.job.id, { ...item.summary, selectedSupplier: "Fastest delivery", selectedPriceUsd: price }]]),
      navigationModel: { partToProjectIds: new Map() }, accessibleJobsQuery: { isLoading: false },
      newJobFilePicker: {},
    });
    render(<MemoryRouter><ClientQuotes /></MemoryRouter>);
    expect(screen.getByText(`Selected: Fastest delivery${formatted ? ` · ${formatted}` : ""}`, { exact: true })).toBeInTheDocument();
  });
});
