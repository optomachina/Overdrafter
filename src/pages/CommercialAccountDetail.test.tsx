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
import { useState, type PropsWithChildren } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CommercialAccountAuditEvent,
  CommercialAccountDetail as CommercialAccountDetailData,
} from "@/features/quotes/api/commercial-account-admin-api";

const mocks = vi.hoisted(() => ({
  fetchAccess: vi.fn(),
  getAccount: vi.fn(),
  listAudit: vi.fn(),
  renderControls: vi.fn(),
  useAppSession: vi.fn(),
}));

vi.mock("@/features/quotes/api/commercial-admin-access-api", () => ({
  fetchCommercialAdminAccess: mocks.fetchAccess,
}));

vi.mock("@/features/quotes/api/commercial-account-admin-api", () => ({
  getCommercialAccount: mocks.getAccount,
  listCommercialAccountAudit: mocks.listAudit,
}));

vi.mock("@/hooks/use-app-session", () => ({
  useAppSession: mocks.useAppSession,
}));

vi.mock("@/components/auth/AuthBootstrapScreen", () => ({
  AuthBootstrapScreen: ({ message }: { message: string }) => <p>{message}</p>,
}));

vi.mock("@/components/admin/commercial/CommercialAdminShell", () => ({
  CommercialAdminShell: ({ children }: PropsWithChildren) => <>{children}</>,
}));

vi.mock("@/components/admin/commercial/CommercialEntitlementControls", () => ({
  CommercialEntitlementControls: (props: {
    organizationId: string;
    grants: CommercialAccountDetailData["grants"];
    hasAal2: boolean;
  }) => {
    const [mountedOrganizationId] = useState(props.organizationId);
    mocks.renderControls(props);
    return (
      <section
        aria-label="Manual grants"
        data-mounted-organization={mountedOrganizationId}
      >
        <h2>Trial and complimentary access</h2>
        {props.grants.map((grant) => (
          <p key={grant.id}>{grant.reason}</p>
        ))}
      </section>
    );
  },
}));

import CommercialAccountDetail from "./CommercialAccountDetail";

const freeAccount: CommercialAccountDetailData = {
  organization: {
    id: "org-42",
    name: "Atlas Manufacturing",
    slug: "atlas-mfg",
    createdAt: "2026-07-01T10:00:00.000Z",
  },
  members: [],
  billingAccount: null,
  effective: {
    plan: "free",
    source: "default",
    sourceId: null,
    automaticQuoteCollection: false,
    validUntil: null,
    reviewAt: null,
    reviewDue: false,
    graceEndsAt: null,
    organizationExists: true,
  },
  grants: [],
  subscriptions: [],
  quoteActivity: {
    manualRequestCount: 0,
    automaticRequestCount: 0,
    activeManualRequestCount: 0,
    receivedRequestCount: 0,
    failedRequestCount: 0,
    lastRequestAt: null,
    recentRequests: [],
  },
};

const detailedAccount: CommercialAccountDetailData = {
  ...freeAccount,
  members: [
    {
      userId: "user-1",
      email: "owner@atlas.example",
      role: "admin",
      joinedAt: "2026-07-02T10:00:00.000Z",
    },
  ],
  effective: {
    ...freeAccount.effective,
    plan: "pro",
    source: "manual_complimentary",
    sourceId: "grant-1",
    automaticQuoteCollection: true,
    reviewAt: "2026-10-01T10:00:00.000Z",
  },
  grants: [
    {
      id: "grant-1",
      entitlementKey: "automatic_quote_collection",
      type: "complimentary",
      startsAt: "2026-07-01T10:00:00.000Z",
      expiresAt: null,
      reviewAt: "2026-10-01T10:00:00.000Z",
      reason: "Audited pilot access",
      grantedByUserId: "billing-admin",
      revokedAt: null,
      revokedByUserId: null,
      revocationReason: null,
      createdAt: "2026-07-01T10:00:00.000Z",
    },
  ],
  subscriptions: [
    {
      id: "subscription-1",
      stripeSubscriptionId: "sub_atlas",
      status: "active",
      billingInterval: "month",
      currentPeriodEnd: "2026-08-01T10:00:00.000Z",
      pastDueSince: null,
      cancelAtPeriodEnd: false,
      stripeEventCreatedAt: "2026-07-30T10:00:00.000Z",
      updatedAt: "2026-07-30T10:00:00.000Z",
    },
  ],
  quoteActivity: {
    manualRequestCount: 4,
    automaticRequestCount: 2,
    activeManualRequestCount: 1,
    receivedRequestCount: 3,
    failedRequestCount: 1,
    lastRequestAt: "2026-07-30T10:00:00.000Z",
    recentRequests: [
      {
        requestId: "request-7",
        jobId: "job-9",
        jobTitle: "Gear housing",
        requestMode: "manual",
        status: "received",
        createdAt: "2026-07-30T10:00:00.000Z",
      },
    ],
  },
};

const auditEvent: CommercialAccountAuditEvent = {
  eventId: "event-1",
  organizationId: "org-42",
  actorUserId: "billing-admin",
  actorEmail: "admin@example.com",
  action: "organization_entitlement.grant",
  targetType: "organization_entitlement",
  targetId: "grant-1",
  reason: "Audited pilot access",
  beforeState: null,
  afterState: { grantType: "complimentary" },
  requestMetadata: { interface: "commercial_account_admin" },
  idempotencyKey: "org-42-grant-1",
  createdAt: "2026-07-30T10:00:00.000Z",
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

function DetailRouteHarness() {
  const navigate = useNavigate();

  return (
    <>
      <button
        type="button"
        onClick={() => navigate("/internal/commercial/org-99")}
      >
        Switch account
      </button>
      <CommercialAccountDetail />
    </>
  );
}

function renderPage(initialEntry = "/internal/commercial/org-42") {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route
            path="/internal/commercial/:organizationId"
            element={<DetailRouteHarness />}
          />
          <Route path="/internal/commercial" element={<p>Account list</p>} />
          <Route path="/" element={<p>Sign-in destination</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { queryClient, ...rendered };
}

describe("CommercialAccountDetail", () => {
  beforeEach(() => {
    mocks.useAppSession.mockReturnValue({
      user: { id: "billing-admin", email: "admin@example.com" },
      activeMembership: null,
      isPlatformAdmin: false,
      signOut: vi.fn(),
      isAuthInitializing: false,
    });
    mocks.fetchAccess.mockResolvedValue({
      hasCapability: true,
      hasAal2: true,
    });
    mocks.getAccount.mockResolvedValue(freeAccount);
    mocks.listAudit.mockResolvedValue({ items: [], nextCursor: null });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows session restoration and redirects signed-out users", async () => {
    mocks.useAppSession.mockReturnValueOnce({
      user: null,
      activeMembership: null,
      isPlatformAdmin: false,
      signOut: vi.fn(),
      isAuthInitializing: true,
    });
    const { unmount } = renderPage();

    expect(
      screen.getByText("Restoring your commercial admin session."),
    ).toBeInTheDocument();
    unmount();

    mocks.useAppSession.mockReturnValue({
      user: null,
      activeMembership: null,
      isPlatformAdmin: false,
      signOut: vi.fn(),
      isAuthInitializing: false,
    });
    renderPage();

    expect(await screen.findByText("Sign-in destination")).toBeInTheDocument();
    expect(mocks.getAccount).not.toHaveBeenCalled();
  });

  it("renders capability loading, failure, and denial without account reads", async () => {
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
    expect(mocks.getAccount).not.toHaveBeenCalled();
    unmount();

    mocks.fetchAccess.mockResolvedValueOnce({
      hasCapability: false,
      hasAal2: false,
    });
    renderPage();

    expect(await screen.findByText("Not authorized")).toBeInTheDocument();
    expect(mocks.getAccount).not.toHaveBeenCalled();
    expect(mocks.listAudit).not.toHaveBeenCalled();
  });

  it("renders account loading and exact-account failure states", async () => {
    const account = deferred<CommercialAccountDetailData>();
    mocks.getAccount.mockReturnValueOnce(account.promise);
    const { unmount } = renderPage();

    expect(
      await screen.findByLabelText("Loading commercial account"),
    ).toBeInTheDocument();
    await act(async () => {
      account.reject(new Error("Exact account unavailable"));
    });
    expect(await screen.findByText("Exact account unavailable")).toHaveAttribute(
      "role",
      "alert",
    );
    unmount();

    expect(mocks.getAccount).toHaveBeenCalledWith("org-42");
  });

  it.each([
    ["default", "free", "Free account — no paid subscription or active manual grant"],
    ["subscription_active", "pro", "Paid subscription — Subscription Active"],
    ["manual_trial", "pro", "Manual trial grant"],
    ["manual_complimentary", "pro", "Manual complimentary grant"],
  ] as const)("labels %s access truthfully", async (source, plan, expected) => {
    mocks.getAccount.mockResolvedValue({
      ...freeAccount,
      effective: {
        ...freeAccount.effective,
        source,
        plan,
        automaticQuoteCollection: plan === "pro",
      },
    });
    renderPage();

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(
      screen.getByText(plan === "pro" ? "Automatic quotes on" : "Manual quotes"),
    ).toBeInTheDocument();
  });

  it("separates account history without creating a partial completion link", async () => {
    mocks.getAccount.mockResolvedValue(detailedAccount);
    mocks.listAudit.mockResolvedValue({ items: [auditEvent], nextCursor: null });
    renderPage();

    expect(await screen.findByText("Paid subscriptions")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Manual grants" })).toHaveTextContent(
      "Audited pilot access",
    );
    expect(screen.getByText("Organization members")).toBeInTheDocument();
    expect(screen.getByText("owner@atlas.example")).toBeInTheDocument();
    expect(screen.getByText("Quote activity")).toBeInTheDocument();
    expect(screen.getByText("Gear housing")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Gear housing/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Commercial audit")).toBeInTheDocument();
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
  });

  it("passes the exact organization and access truth to entitlement controls", async () => {
    mocks.getAccount.mockResolvedValue(detailedAccount);
    mocks.fetchAccess.mockResolvedValue({
      hasCapability: true,
      hasAal2: false,
    });
    renderPage();

    await screen.findByRole("region", { name: "Manual grants" });
    expect(mocks.renderControls).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-42",
        grants: detailedAccount.grants,
        hasAal2: false,
      }),
    );
  });

  it("renders audit empty and failure states", async () => {
    const { unmount } = renderPage();
    expect(
      await screen.findByText("No commercial audit events are recorded."),
    ).toBeInTheDocument();
    unmount();

    mocks.listAudit.mockRejectedValueOnce(new Error("Audit unavailable"));
    renderPage();
    expect(await screen.findByText("Audit unavailable")).toHaveAttribute(
      "role",
      "alert",
    );
  });

  it("pages forward and backward with organization-bound opaque cursors", async () => {
    mocks.listAudit
      .mockResolvedValueOnce({ items: [auditEvent], nextCursor: "opaque:page:2" })
      .mockResolvedValueOnce({ items: [], nextCursor: null })
      .mockResolvedValueOnce({ items: [auditEvent], nextCursor: "opaque:page:2" });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /Next/ }));
    await waitFor(() => {
      expect(mocks.listAudit).toHaveBeenCalledWith({
        organizationId: "org-42",
        cursor: "opaque:page:2",
        limit: 25,
      });
    });

    fireEvent.click(screen.getByRole("button", { name: /Previous/ }));
    await waitFor(() => {
      expect(mocks.listAudit).toHaveBeenLastCalledWith({
        organizationId: "org-42",
        cursor: null,
        limit: 25,
      });
    });
  });

  it("resets audit pagination when navigation retains the detail component", async () => {
    mocks.listAudit
      .mockResolvedValueOnce({ items: [auditEvent], nextCursor: "opaque:page:2" })
      .mockResolvedValue({ items: [], nextCursor: null });
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /Next/ }));
    await waitFor(() => {
      expect(mocks.listAudit).toHaveBeenCalledWith({
        organizationId: "org-42",
        cursor: "opaque:page:2",
        limit: 25,
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Switch account" }));

    await waitFor(() => {
      expect(mocks.listAudit).toHaveBeenCalledWith({
        organizationId: "org-99",
        cursor: null,
        limit: 25,
      });
    });
    expect(screen.getByRole("region", { name: "Manual grants" }))
      .toHaveAttribute("data-mounted-organization", "org-99");
    expect(mocks.listAudit).not.toHaveBeenCalledWith({
      organizationId: "org-99",
      cursor: "opaque:page:2",
      limit: 25,
    });
  });

  it("labels a background refresh while retaining stale account truth", async () => {
    const refresh = deferred<CommercialAccountDetailData>();
    mocks.getAccount
      .mockResolvedValueOnce(freeAccount)
      .mockReturnValueOnce(refresh.promise);
    const { queryClient } = renderPage();
    await screen.findByText(
      "Free account — no paid subscription or active manual grant",
    );

    await act(async () => {
      void queryClient.invalidateQueries({
        queryKey: ["commercial-account", "org-42"],
      });
    });

    expect(await screen.findByText("Refreshing account truth…")).toBeInTheDocument();
    expect(
      screen.getByText("Free account — no paid subscription or active manual grant"),
    ).toBeInTheDocument();
    await act(async () => {
      refresh.resolve(freeAccount);
    });
  });
});
