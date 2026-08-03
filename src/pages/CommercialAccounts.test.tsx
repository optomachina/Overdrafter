import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommercialAccountSearchItem } from "@/features/quotes/api/commercial-account-admin-api";

const mocks = vi.hoisted(() => ({
  fetchAccess: vi.fn(),
  searchAccounts: vi.fn(),
  useAppSession: vi.fn(),
}));

vi.mock("@/features/quotes/api/commercial-admin-access-api", () => ({
  fetchCommercialAdminAccess: mocks.fetchAccess,
}));

vi.mock("@/features/quotes/api/commercial-account-admin-api", () => ({
  searchCommercialAccounts: mocks.searchAccounts,
}));

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: mocks.useAppSession,
}));

vi.mock("@/components/admin/commercial/CommercialAdminShell", () => ({
  CommercialAdminShell: ({
    children,
    onSignOut,
  }: PropsWithChildren<{ onSignOut: () => void }>) => (
    <div>
      <button type="button" onClick={onSignOut}>
        Sign out
      </button>
      {children}
    </div>
  ),
}));

import CommercialAccounts from "./CommercialAccounts";

const account: CommercialAccountSearchItem = {
  organizationId: "org-42",
  organizationName: "Atlas Manufacturing",
  organizationSlug: "atlas-mfg",
  createdAt: "2026-07-30T12:00:00.000Z",
  memberCount: 3,
  matchingMemberEmails: ["buyer@atlas.example"],
  effective: {
    plan: "pro",
    source: "complimentary",
    sourceId: "grant-1",
    automaticQuoteCollection: true,
    validUntil: null,
    reviewAt: "2026-09-01T12:00:00.000Z",
    reviewDue: false,
    graceEndsAt: null,
    organizationExists: true,
  },
  quoteActivity: {
    manualRequestCount: 4,
    automaticRequestCount: 2,
    activeManualRequestCount: 1,
    lastRequestAt: "2026-07-30T12:00:00.000Z",
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

function RouterHistoryProbe() {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <div>
      <output data-testid="router-search">{location.search}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        Browser back
      </button>
      <button type="button" onClick={() => void navigate(1)}>
        Browser forward
      </button>
    </div>
  );
}

function renderPage(
  initialEntry = "/internal/commercial",
  earlierEntries: string[] = [],
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[...earlierEntries, initialEntry]}
        initialIndex={earlierEntries.length}
      >
        <RouterHistoryProbe />
        <CommercialAccounts />
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { queryClient, ...rendered };
}

describe("CommercialAccounts", () => {
  const signOut = vi.fn();

  beforeEach(() => {
    mocks.useAppSession.mockReturnValue({
      user: { id: "billing-admin", email: "admin@example.com" },
      activeMembership: null,
      isPlatformAdmin: false,
      signOut,
      isAuthInitializing: false,
    });
    mocks.fetchAccess.mockResolvedValue({
      hasCapability: true,
      hasAal2: false,
    });
    mocks.searchAccounts.mockResolvedValue({ items: [account], nextCursor: null });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows auth restoration and wires sign-out through the admin shell", async () => {
    mocks.useAppSession.mockReturnValue({
      user: { id: "billing-admin", email: "admin@example.com" },
      activeMembership: null,
      isPlatformAdmin: false,
      signOut,
      isAuthInitializing: true,
    });

    const { rerender } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <CommercialAccounts />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      screen.getByText("Restoring your commercial admin session."),
    ).toBeInTheDocument();

    mocks.useAppSession.mockReturnValue({
      user: { id: "billing-admin", email: "admin@example.com" },
      activeMembership: null,
      isPlatformAdmin: false,
      signOut,
      isAuthInitializing: false,
    });
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <CommercialAccounts />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(signOut).toHaveBeenCalledOnce();
  });

  it("renders capability loading, failure, and denial states", async () => {
    const access = deferred<{ hasCapability: boolean; hasAal2: boolean }>();
    mocks.fetchAccess.mockReturnValueOnce(access.promise);

    const { unmount } = renderPage();
    expect(
      screen.getByLabelText("Checking commercial account access"),
    ).toBeInTheDocument();

    await act(async () => {
      access.reject(new Error("Capability service unavailable"));
    });
    expect(
      await screen.findByText("Capability service unavailable"),
    ).toHaveAttribute("role", "alert");
    unmount();

    mocks.fetchAccess.mockResolvedValueOnce({
      hasCapability: false,
      hasAal2: false,
    });
    renderPage();
    expect(await screen.findByText("Not authorized")).toBeInTheDocument();
    expect(mocks.searchAccounts).not.toHaveBeenCalled();
  });

  it("renders account loading, failure, and empty states", async () => {
    const accounts = deferred<{ items: CommercialAccountSearchItem[]; nextCursor: null }>();
    mocks.searchAccounts.mockReturnValueOnce(accounts.promise);

    const { unmount } = renderPage();
    expect(
      await screen.findByLabelText("Loading commercial accounts"),
    ).toBeInTheDocument();
    await act(async () => {
      accounts.reject(new Error("Accounts unavailable"));
    });
    expect(await screen.findByText("Accounts unavailable")).toHaveAttribute(
      "role",
      "alert",
    );
    unmount();

    mocks.searchAccounts.mockResolvedValueOnce({ items: [], nextCursor: null });
    renderPage();
    expect(
      await screen.findByText("No commercial accounts found"),
    ).toBeInTheDocument();
  });

  it("links every account presentation to the exact organization detail", async () => {
    renderPage();

    await screen.findAllByText("Atlas Manufacturing");
    const detailLinks = screen.getAllByRole("link", { name: /View/ });

    expect(detailLinks).toHaveLength(2);
    detailLinks.forEach((link) => {
      expect(link).toHaveAttribute("href", "/internal/commercial/org-42");
    });
  });

  it("scrubs a legacy member-email URL while retaining the current search", async () => {
    renderPage(
      "/internal/commercial?q=buyer%40atlas.example&view=active",
      ["/internal/commercial?q=atlas&view=active"],
    );

    expect(await screen.findByLabelText("Search commercial accounts")).toHaveValue(
      "buyer@atlas.example",
    );
    await waitFor(() => {
      expect(mocks.searchAccounts).toHaveBeenCalledWith({
        search: "buyer@atlas.example",
        cursor: null,
        limit: 25,
      });
    });
    await waitFor(() => {
      expect(screen.getByTestId("router-search")).toHaveTextContent(
        "?view=active",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Browser back" }));
    await waitFor(() => {
      expect(screen.getByTestId("router-search")).toHaveTextContent(
        "?q=atlas&view=active",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Browser forward" }));
    await waitFor(() => {
      expect(screen.getByTestId("router-search")).toHaveTextContent(
        "?view=active",
      );
    });
  });

  it("keeps submitted member-email searches out of the URL", async () => {
    renderPage("/internal/commercial?view=active");

    const searchInput = await screen.findByRole("textbox", {
      name: "Search commercial accounts",
    });
    fireEvent.change(searchInput, {
      target: { value: "  buyer@atlas.example  " },
    });
    fireEvent.submit(searchInput.closest("form")!);

    await waitFor(() => {
      expect(mocks.searchAccounts).toHaveBeenCalledWith({
        search: "buyer@atlas.example",
        cursor: null,
        limit: 25,
      });
    });
    expect(screen.getByTestId("router-search")).toHaveTextContent(
      "?view=active",
    );
  });

  it("keeps organization and slug searches URL-backed", async () => {
    renderPage();

    const searchInput = await screen.findByRole("textbox", {
      name: "Search commercial accounts",
    });
    fireEvent.change(searchInput, {
      target: { value: "atlas-mfg" },
    });
    fireEvent.submit(searchInput.closest("form")!);

    await waitFor(() => {
      expect(screen.getByTestId("router-search")).toHaveTextContent(
        "?q=atlas-mfg",
      );
    });
    expect(mocks.searchAccounts).toHaveBeenCalledWith({
      search: "atlas-mfg",
      cursor: null,
      limit: 25,
    });
  });

  it("moves forward and backward with opaque cursors", async () => {
    mocks.searchAccounts
      .mockResolvedValueOnce({ items: [account], nextCursor: "opaque:page:2" })
      .mockResolvedValueOnce({ items: [account], nextCursor: null })
      .mockResolvedValueOnce({ items: [account], nextCursor: "opaque:page:2" });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /Next/ }));
    await waitFor(() => {
      expect(mocks.searchAccounts).toHaveBeenCalledWith({
        search: null,
        cursor: "opaque:page:2",
        limit: 25,
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: /Previous/ }));
    await waitFor(() => {
      expect(mocks.searchAccounts).toHaveBeenLastCalledWith({
        search: null,
        cursor: null,
        limit: 25,
      });
    });
  });

  it("resets the opaque cursor before searching a different account scope", async () => {
    mocks.searchAccounts
      .mockResolvedValueOnce({ items: [account], nextCursor: "opaque:page:2" })
      .mockResolvedValue({ items: [account], nextCursor: null });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /Next/ }));
    await waitFor(() => {
      expect(mocks.searchAccounts).toHaveBeenCalledWith({
        search: null,
        cursor: "opaque:page:2",
        limit: 25,
      });
    });
    const searchInput = screen.getByRole("textbox", {
      name: "Search commercial accounts",
    });
    fireEvent.change(searchInput, {
      target: { value: "atlas" },
    });
    fireEvent.submit(searchInput.closest("form")!);

    await waitFor(() => {
      expect(mocks.searchAccounts).toHaveBeenCalledWith({
        search: "atlas",
        cursor: null,
        limit: 25,
      });
    });
    expect(mocks.searchAccounts).not.toHaveBeenCalledWith({
      search: "atlas",
      cursor: "opaque:page:2",
      limit: 25,
    });
  });

  it("labels a background refresh while retaining stale account data", async () => {
    const refresh = deferred<{ items: CommercialAccountSearchItem[]; nextCursor: null }>();
    mocks.searchAccounts
      .mockResolvedValueOnce({ items: [account], nextCursor: null })
      .mockReturnValueOnce(refresh.promise);
    const { queryClient } = renderPage();
    await screen.findAllByText("Atlas Manufacturing");

    await act(async () => {
      void queryClient.invalidateQueries({
        queryKey: ["commercial-accounts", "", null],
      });
    });

    expect(await screen.findByText("Refreshing…")).toBeInTheDocument();
    expect(screen.getAllByText("Atlas Manufacturing")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: /View/ })).toHaveLength(2);
    await act(async () => {
      refresh.resolve({ items: [account], nextCursor: null });
    });
  });
});
