import { markQuoteAsTrustedLive, createVendorQuoteFixture, createPublishedQuoteOptionsFixture, createOfflineQuoteOptionsClient, expectOfflineQuoteOptionsRecovery } from "@/test-support/project-quote-workspace";
import "@testing-library/jest-dom/vitest";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientQuoteWorkspaceItemFixture } from "@/features/quotes/client-workspace-fixtures";
import ClientProjectReview from "./ClientProjectReview";

const api = vi.hoisted(() => ({
  fetchProject: vi.fn(),
  fetchJobsByProject: vi.fn(),
  fetchClientQuoteWorkspaceByJobIds: vi.fn(),
}));
vi.mock("@/features/quotes/api/workspace-access", () => api);
vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: () => ({ user: { id: "client" }, isAuthInitializing: false }),
}));
vi.mock("@/components/workspace/ClientWorkspaceShell", () => ({
  ClientWorkspaceShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

beforeEach(() => {
  vi.resetAllMocks();
  api.fetchProject.mockResolvedValue({ id: "project-1", name: "Project one" });
  api.fetchJobsByProject.mockResolvedValue([{ id: "job-1" }]);
  api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValue([]);
});
afterEach(() => { cleanup(); onlineManager.setOnline(true); });

describe("project review quote-options failures", () => {
  it.each(["jobs", "workspace"])("shows an error and disables handoff when %s fails", async (failedQuery) => {
    const query = failedQuery === "jobs" ? api.fetchJobsByProject : api.fetchClientQuoteWorkspaceByJobIds;
    query.mockRejectedValue(new Error("Query unavailable"));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/projects/project-1/review"]}>
          <Routes><Route path="/projects/:projectId/review" element={<ClientProjectReview />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Unable to load quote options. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review handoff" })).toBeDisabled();
    expect(screen.queryByText(/Choose a (quote|package option) to continue/)).not.toBeInTheDocument();
    if (failedQuery === "jobs") expect(api.fetchClientQuoteWorkspaceByJobIds).not.toHaveBeenCalled();
  });
});

describe("project review background failures", () => {
  it.each(["jobs", "workspace"])("keeps handoff enabled after a background %s failure", async (failedQuery) => {
    const item = createClientQuoteWorkspaceItemFixture();
    item.part!.vendorQuotes = [markQuoteAsTrustedLive(createVendorQuoteFixture({
      resultId: "result-1", offerId: "offer-1", supplier: "Supplier",
      totalPriceUsd: 100, leadTimeBusinessDays: 7,
    }))];
    item.publishedQuoteOptions = createPublishedQuoteOptionsFixture();
    item.publishedQuoteSelection = {
      id: "selection-1", option_id: "option-A", package_id: "package-1",
      organization_id: "org-1", selected_by: "client", note: null, created_at: new Date().toISOString(),
    };
    api.fetchJobsByProject.mockResolvedValue([item.job]);
    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValue([item]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/projects/project-1/review"]}>
          <Routes><Route path="/projects/:projectId/review" element={<ClientProjectReview />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const button = await screen.findByRole("button", { name: "Review handoff" });
    await waitFor(() => expect(button).toBeEnabled());
    const query = failedQuery === "jobs" ? api.fetchJobsByProject : api.fetchClientQuoteWorkspaceByJobIds;
    query.mockRejectedValue(new Error("Background refetch unavailable"));
    const calls = query.mock.calls.length;
    await act(async () => { await client.refetchQueries(); });
    expect(query.mock.calls.length).toBeGreaterThan(calls);
    await waitFor(() => expect(client.getQueryCache().getAll().some(
      (entry) => entry.state.status === "error" && entry.state.data !== undefined,
    )).toBe(true));
    expect(button).toBeEnabled();
    expect(screen.queryByText("Unable to load quote options. Please try again.")).not.toBeInTheDocument();
  });
});

describe("offline quote options", () => {
  it.each(["cold open", "workspace retry"])("shows loading during %s and recovers online", async (scenario) => {
    const item = createClientQuoteWorkspaceItemFixture();
    item.publishedQuoteOptions = createPublishedQuoteOptionsFixture();
    item.publishedQuoteSelection = null;
    api.fetchJobsByProject.mockResolvedValue([item.job]);
    api.fetchClientQuoteWorkspaceByJobIds.mockResolvedValue([item]);
    const client = createOfflineQuoteOptionsClient(scenario, api);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/projects/project-1/review"]}>
          <Routes><Route path="/projects/:projectId/review" element={<ClientProjectReview />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await expectOfflineQuoteOptionsRecovery(client, scenario, api);
  });

  it("keeps the normal prompt when there are no jobs", async () => {
    api.fetchJobsByProject.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/projects/project-1/review"]}>
          <Routes><Route path="/projects/:projectId/review" element={<ClientProjectReview />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/Choose a quote to continue/)).toBeInTheDocument();
    expect(screen.queryByText("Loading quote options…")).not.toBeInTheDocument();
    expect(api.fetchClientQuoteWorkspaceByJobIds).not.toHaveBeenCalled();
  });
});
