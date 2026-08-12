import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ClientQuoteDetail from "@/pages/ClientQuoteDetail";

const mocks = vi.hoisted(() => ({
  createQuoteDisplayCode: vi.fn<(jobId: string) => string>(),
  useClientHomeController: vi.fn(),
  useClientPartController: vi.fn(),
}));

vi.mock("@/features/quotes/quote-intelligence-view-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/quotes/quote-intelligence-view-model")>()),
  createQuoteDisplayCode: mocks.createQuoteDisplayCode,
}));

vi.mock("@/features/quotes/use-client-home-controller", () => ({
  useClientHomeController: mocks.useClientHomeController,
}));

vi.mock("@/features/quotes/use-client-part-controller", () => ({
  useClientPartController: mocks.useClientPartController,
}));

vi.mock("@/components/quote-intelligence/QuoteIntelligenceShell", () => ({
  QuoteIntelligenceShell: ({
    title,
    description,
    children,
  }: PropsWithChildren<{ title: string; description?: string }>) => (
    <main>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </main>
  ),
}));

vi.mock("@/components/chat/WorkspaceAccountMenu", () => ({
  WorkspaceAccountMenu: () => <button type="button">Account</button>,
}));

vi.mock("@/components/quotes/ClientQuoteDecisionPanel", () => ({
  ClientQuoteDecisionPanel: () => <section>Supplier response comparison</section>,
}));

vi.mock("@/components/quotes/ClientWorkspacePanelContent", () => ({
  ClientQuoteRequestStatusCard: () => <section>Quote request status</section>,
}));

vi.mock("@/components/SignInDialog", () => ({
  SignInDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Authentication dialog</div> : null,
}));

function createHomeState(jobIds: string[], authenticated = true) {
  return {
    accessibleJobs: jobIds.map((id) => ({ id })),
    accessibleJobsQuery: {
      isFetching: false,
      isLoading: false,
    },
    activeMembership: {
      role: "client",
      organizationId: "org-1",
    },
    authDialogMode: "signin",
    isAuthDialogOpen: false,
    newJobFilePicker: {
      accept: ".step,.pdf",
      handleFileInputChange: vi.fn(),
      inputRef: { current: null },
      openFilePicker: vi.fn(),
    },
    openAuth: vi.fn(),
    setIsAuthDialogOpen: vi.fn(),
    signOut: vi.fn(),
    user: authenticated
      ? {
          id: "user-1",
          email: "client@example.com",
        }
      : null,
  };
}

function createPartState() {
  return {
    activePreset: null,
    displayPartTitle: "COL-100 · Rev B",
    handleCancelQuoteRequest: vi.fn(),
    handlePresetSelection: vi.fn(),
    handleRequestQuote: vi.fn(),
    handleSelectQuoteOption: vi.fn(),
    handleToggleVendorExclusion: vi.fn(),
    isAuthInitializing: false,
    isCancelingQuoteRequest: false,
    isPartDetailLoading: false,
    isRequestingQuote: false,
    partDetail: {
      job: {
        id: "job-1",
        organization_id: "org-1",
        project_id: null,
        selected_vendor_quote_offer_id: null,
        created_by: "user-1",
        title: "COL-100",
        description: null,
        status: "published",
        source: "client_home",
        tags: [],
        active_pricing_policy_id: null,
        requested_service_kinds: ["manufacturing_quote"],
        primary_service_kind: "manufacturing_quote",
        service_notes: null,
        requested_quote_quantities: [20],
        requested_by_date: null,
        archived_at: null,
        created_at: "2026-07-20T12:00:00.000Z",
        updated_at: "2026-07-27T12:00:00.000Z",
      },
      part: null,
      latestQuoteRequest: null,
      latestQuoteRun: null,
    },
    quoteDataMessage: null,
    quoteDataStatus: "available",
    quoteDiagnostics: {
      rawQuoteRowCount: 0,
      rawOfferCount: 0,
      plottableOfferCount: 0,
      excludedOfferCount: 0,
      excludedOffers: [],
      excludedReasonCounts: [],
    },
    rankedQuoteOptions: [],
    requestSummaryRequestedByDate: null,
    selectedQuoteOption: null,
  };
}

function renderQuote(code: string) {
  return render(
    <MemoryRouter initialEntries={[`/quotes/${code}`]}>
      <Routes>
        <Route path="/quotes/:quoteCode" element={<ClientQuoteDetail />} />
        <Route path="/quotes" element={<div>Quotes collection</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ClientQuoteDetail", () => {
  beforeEach(() => {
    window.localStorage.clear();
    mocks.createQuoteDisplayCode.mockImplementation((jobId) =>
      jobId === "job-1" ? "ABC234" : "XYZ567",
    );
    mocks.useClientHomeController.mockReturnValue(createHomeState(["job-1"]));
    mocks.useClientPartController.mockReturnValue(createPartState());
  });

  it("resolves the short code only across accessible jobs", () => {
    renderQuote("abc234");

    expect(mocks.useClientPartController).toHaveBeenCalledWith("job-1", {
      redirectUnauthenticated: false,
      warmNavigation: false,
    });
    expect(screen.getByRole("heading", { name: "COL-100 · Rev B" })).toBeInTheDocument();
    expect(screen.getByText("Supplier response comparison")).toBeInTheDocument();
    expect(screen.getByText(/OverDrafter login and workspace access required/i)).toBeInTheDocument();
  });

  it("shows the selected offer's commercial validity date", () => {
    mocks.useClientPartController.mockReturnValue({
      ...createPartState(),
      selectedQuoteOption: {
        validUntil: "2026-09-10T23:59:59.999Z",
      },
    });

    renderQuote("ABC234");

    expect(screen.getByText("Sep 10, 2026")).toBeInTheDocument();
  });

  it("fails closed when the code is not available to the account", () => {
    renderQuote("NOPE24");

    expect(mocks.useClientPartController).toHaveBeenCalledWith(undefined, {
      redirectUnauthenticated: false,
      warmNavigation: false,
    });
    expect(screen.getByRole("heading", { name: "Quote NOPE24" })).toBeInTheDocument();
    expect(screen.getByText(/does not match a quote available to your account/i)).toBeInTheDocument();
  });

  it("fails closed on a temporary display-code collision", () => {
    mocks.createQuoteDisplayCode.mockReturnValue("ABC234");
    mocks.useClientHomeController.mockReturnValue(createHomeState(["job-1", "job-2"]));

    renderQuote("ABC234");

    expect(mocks.useClientPartController).toHaveBeenCalledWith(undefined, {
      redirectUnauthenticated: false,
      warmNavigation: false,
    });
    expect(screen.getByText(/matches more than one accessible quote/i)).toBeInTheDocument();
    expect(screen.getByText(/No quote was opened/i)).toBeInTheDocument();
  });

  it("shows an explicit login gate instead of a blank page for a shared private link", () => {
    mocks.useClientHomeController.mockReturnValue(createHomeState([], false));

    renderQuote("ABC234");

    expect(screen.getByRole("heading", { name: "Quote ABC234" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to view quote" })).toBeInTheDocument();
    expect(screen.getByText(/locator, not an access credential/i)).toBeInTheDocument();
    expect(mocks.useClientPartController).toHaveBeenCalledWith(undefined, {
      redirectUnauthenticated: false,
      warmNavigation: false,
    });
  });
});
