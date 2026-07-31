import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommercialEntitlementGrant } from "@/features/quotes/api/commercial-account-admin-api";
import { CommercialEntitlementControls } from "./CommercialEntitlementControls";

const commercialApiMock = vi.hoisted(() => ({
  grantCommercialEntitlement: vi.fn(),
  revokeCommercialEntitlement: vi.fn(),
}));

vi.mock("@/features/quotes/api/commercial-account-admin-api", () => ({
  grantCommercialEntitlement: commercialApiMock.grantCommercialEntitlement,
  revokeCommercialEntitlement: commercialApiMock.revokeCommercialEntitlement,
}));

vi.mock("@/components/auth/MfaStepUpDialog", () => ({
  MfaStepUpDialog: ({
    open,
    onVerified,
  }: {
    open: boolean;
    onVerified: () => Promise<void> | void;
  }) => open ? (
    <div role="dialog" aria-label="MFA step-up">
      <button type="button" onClick={() => void onVerified()}>
        Complete MFA
      </button>
    </div>
  ) : null,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
  },
}));

function makeGrant(
  overrides: Partial<CommercialEntitlementGrant> = {},
): CommercialEntitlementGrant {
  return {
    id: "grant-1",
    entitlementKey: "automatic_quote_collection",
    type: "trial",
    startsAt: "2026-07-01T12:00:00.000Z",
    expiresAt: "2026-08-01T12:00:00.000Z",
    reviewAt: null,
    reason: "Pilot access",
    grantedByUserId: "admin-1",
    revokedAt: null,
    revokedByUserId: null,
    revocationReason: null,
    createdAt: "2026-07-01T12:00:00.000Z",
    ...overrides,
  };
}

function renderControls({
  grants = [],
  hasAal2 = true,
  onAccessRefresh = vi.fn().mockResolvedValue(undefined),
  onChanged = vi.fn().mockResolvedValue(undefined),
}: {
  grants?: CommercialEntitlementGrant[];
  hasAal2?: boolean;
  onAccessRefresh?: ReturnType<typeof vi.fn>;
  onChanged?: ReturnType<typeof vi.fn>;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <CommercialEntitlementControls
        organizationId="org-1"
        grants={grants}
        hasAal2={hasAal2}
        onAccessRefresh={onAccessRefresh}
        onChanged={onChanged}
      />
    </QueryClientProvider>,
  );

  return { onAccessRefresh, onChanged };
}

function submitGrant(): void {
  const button = screen.getByRole("button", {
    name: /Grant (trial|complimentary) Pro|Verify with MFA to grant/,
  });
  fireEvent.submit(button.closest("form") as HTMLFormElement);
}

async function selectComplimentary(): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: "Access type" }));
  fireEvent.click(await screen.findByRole("option", { name: "Complimentary" }));
}

describe("CommercialEntitlementControls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    HTMLElement.prototype.scrollIntoView = vi.fn();
    commercialApiMock.grantCommercialEntitlement.mockResolvedValue({
      replayed: false,
    });
    commercialApiMock.revokeCommercialEntitlement.mockResolvedValue({
      replayed: false,
    });
  });

  it("keeps manual access truthfully labeled as trial or complimentary, never paid", () => {
    renderControls({
      grants: [
        makeGrant(),
        makeGrant({
          id: "grant-2",
          type: "complimentary",
          expiresAt: null,
          reviewAt: "2026-10-01T12:00:00.000Z",
          reason: "Partner program",
        }),
      ],
    });

    expect(screen.getByText("Manual Pro access")).toBeInTheDocument();
    expect(
      screen.getByText(/never presented as a paid subscription/i),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Trial").length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getAllByText("Complimentary").length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Partner program")).toBeInTheDocument();
  });

  it("requires a reason and concrete expiration before submitting a trial", () => {
    renderControls();

    fireEvent.change(screen.getByLabelText("Trial expiration"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Pilot access" },
    });
    submitGrant();

    expect(commercialApiMock.grantCommercialEntitlement).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Trial expiration"), {
      target: { value: "2026-08-15T09:30" },
    });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "   " },
    });
    submitGrant();

    expect(commercialApiMock.grantCommercialEntitlement).not.toHaveBeenCalled();
  });

  it("requires a review date and reason before submitting complimentary access", async () => {
    renderControls();
    await selectComplimentary();

    expect(screen.queryByLabelText("Trial expiration")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Complimentary review date")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Complimentary review date"), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Partner access" },
    });
    submitGrant();

    expect(commercialApiMock.grantCommercialEntitlement).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Complimentary review date"), {
      target: { value: "2026-10-15T09:30" },
    });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "" },
    });
    submitGrant();

    expect(commercialApiMock.grantCommercialEntitlement).not.toHaveBeenCalled();
  });

  it("requires trial expiration and complimentary review dates after the start", async () => {
    renderControls();

    fireEvent.change(screen.getByLabelText("Starts"), {
      target: { value: "2026-08-15T10:00" },
    });
    fireEvent.change(screen.getByLabelText("Trial expiration"), {
      target: { value: "2026-08-15T09:59" },
    });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Pilot access" },
    });
    submitGrant();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Trial expiration must be after the start time.",
    );
    expect(commercialApiMock.grantCommercialEntitlement).not.toHaveBeenCalled();

    await selectComplimentary();
    fireEvent.change(screen.getByLabelText("Complimentary review date"), {
      target: { value: "2026-08-15T10:00" },
    });
    submitGrant();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Complimentary review date must be after the start time.",
    );
    expect(commercialApiMock.grantCommercialEntitlement).not.toHaveBeenCalled();
  });

  it("opens MFA at AAL1 and does not attempt either privileged mutation", async () => {
    const onAccessRefresh = vi.fn().mockResolvedValue(undefined);
    renderControls({
      hasAal2: false,
      grants: [makeGrant()],
      onAccessRefresh,
    });

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Pilot access" },
    });
    submitGrant();

    expect(screen.getByRole("dialog", { name: "MFA step-up" })).toBeInTheDocument();
    expect(commercialApiMock.grantCommercialEntitlement).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Complete MFA" }));
    await waitFor(() => expect(onAccessRefresh).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("button", { name: "Verify to revoke" }));
    expect(commercialApiMock.revokeCommercialEntitlement).not.toHaveBeenCalled();
  });

  it("sends exact AAL2 trial and complimentary grant parameters", async () => {
    commercialApiMock.grantCommercialEntitlement.mockResolvedValue({
      replayed: false,
    });
    renderControls();

    fireEvent.change(screen.getByLabelText("Starts"), {
      target: { value: "2026-07-31T08:15" },
    });
    fireEvent.change(screen.getByLabelText("Trial expiration"), {
      target: { value: "2026-08-31T18:45" },
    });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "  Thirty-day pilot  " },
    });
    submitGrant();

    await waitFor(() => {
      expect(commercialApiMock.grantCommercialEntitlement).toHaveBeenCalledWith({
        organizationId: "org-1",
        grantType: "trial",
        startsAt: new Date("2026-07-31T08:15").toISOString(),
        expiresAt: new Date("2026-08-31T18:45").toISOString(),
        reviewAt: null,
        reason: "Thirty-day pilot",
        idempotencyKey: expect.any(String),
      });
    });

    await waitFor(() => expect(screen.getByLabelText("Reason")).toHaveValue(""));
    await selectComplimentary();
    fireEvent.change(screen.getByLabelText("Starts"), {
      target: { value: "2026-09-01T09:00" },
    });
    fireEvent.change(screen.getByLabelText("Complimentary review date"), {
      target: { value: "2026-12-01T09:00" },
    });
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "  Strategic partner  " },
    });
    submitGrant();

    await waitFor(() => {
      expect(commercialApiMock.grantCommercialEntitlement).toHaveBeenLastCalledWith({
        organizationId: "org-1",
        grantType: "complimentary",
        startsAt: new Date("2026-09-01T09:00").toISOString(),
        expiresAt: null,
        reviewAt: new Date("2026-12-01T09:00").toISOString(),
        reason: "Strategic partner",
        idempotencyKey: expect.any(String),
      });
    });
  });

  it("reuses an idempotency key for retry and rotates it after changed intent and success", async () => {
    commercialApiMock.grantCommercialEntitlement
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValue({ replayed: false });
    renderControls();

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Initial pilot" },
    });
    submitGrant();
    expect(await screen.findByRole("alert")).toHaveTextContent("Temporary failure");

    const firstKey = commercialApiMock.grantCommercialEntitlement.mock.calls[0][0]
      .idempotencyKey;
    submitGrant();

    await waitFor(() => {
      expect(commercialApiMock.grantCommercialEntitlement).toHaveBeenCalledTimes(2);
    });
    expect(
      commercialApiMock.grantCommercialEntitlement.mock.calls[1][0]
        .idempotencyKey,
    ).toBe(firstKey);

    await waitFor(() => expect(screen.getByLabelText("Reason")).toHaveValue(""));
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Second pilot" },
    });
    submitGrant();

    await waitFor(() => {
      expect(commercialApiMock.grantCommercialEntitlement).toHaveBeenCalledTimes(3);
    });
    expect(
      commercialApiMock.grantCommercialEntitlement.mock.calls[2][0]
        .idempotencyKey,
    ).not.toBe(firstKey);
  });

  it("refreshes expired AAL2 access and reopens step-up without changing intent", async () => {
    commercialApiMock.grantCommercialEntitlement.mockRejectedValue(
      {
        message:
          "Multi-factor authentication is required for this commercial operation.",
      },
    );
    const onAccessRefresh = vi.fn().mockResolvedValue(undefined);
    renderControls({ onAccessRefresh });

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Audited pilot" },
    });
    submitGrant();

    expect(
      await screen.findByRole("dialog", { name: "MFA step-up" }),
    ).toBeInTheDocument();
    expect(onAccessRefresh).toHaveBeenCalledTimes(1);
    const firstKey =
      commercialApiMock.grantCommercialEntitlement.mock.calls[0][0]
        .idempotencyKey;

    submitGrant();
    await waitFor(() => {
      expect(commercialApiMock.grantCommercialEntitlement).toHaveBeenCalledTimes(2);
    });
    expect(
      commercialApiMock.grantCommercialEntitlement.mock.calls[1][0]
        .idempotencyKey,
    ).toBe(firstKey);
  });

  it("recovers from plain Postgrest AAL2 errors when revoking", async () => {
    commercialApiMock.revokeCommercialEntitlement.mockRejectedValue({
      message:
        "Multi-factor authentication is required for this commercial operation.",
    });
    const onAccessRefresh = vi.fn().mockResolvedValue(undefined);
    renderControls({ grants: [makeGrant()], onAccessRefresh });

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.change(screen.getByLabelText("Revocation reason"), {
      target: { value: "Access review complete" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revoke grant" }));

    expect(
      await screen.findByRole("dialog", { name: "MFA step-up" }),
    ).toBeInTheDocument();
    expect(onAccessRefresh).toHaveBeenCalledTimes(1);
    const firstKey =
      commercialApiMock.revokeCommercialEntitlement.mock.calls[0][0]
        .idempotencyKey;

    commercialApiMock.revokeCommercialEntitlement.mockResolvedValue({
      replayed: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Complete MFA" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke grant" }));
    await waitFor(() => {
      expect(commercialApiMock.revokeCommercialEntitlement).toHaveBeenCalledTimes(2);
    });
    expect(
      commercialApiMock.revokeCommercialEntitlement.mock.calls[1][0]
        .idempotencyKey,
    ).toBe(firstKey);
  });

  it("confirms and revokes only the selected grant with a required reason", async () => {
    renderControls({
      grants: [makeGrant(), makeGrant({ id: "grant-2", reason: "Other grant" })],
    });

    const revokeButtons = screen.getAllByRole("button", { name: "Revoke" });
    fireEvent.click(revokeButtons[1]);

    expect(screen.getByText("Revoke this Pro grant?")).toBeInTheDocument();
    expect(
      screen.getByText(/removes only the selected manual grant/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke grant" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Revocation reason"), {
      target: { value: "  Access review complete  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revoke grant" }));

    await waitFor(() => {
      expect(commercialApiMock.revokeCommercialEntitlement).toHaveBeenCalledWith({
        grantId: "grant-2",
        reason: "Access review complete",
        idempotencyKey: expect.any(String),
      });
    });
  });

  it("rotates the revocation idempotency key when a failed intent changes", async () => {
    commercialApiMock.revokeCommercialEntitlement
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValue({ replayed: false });
    renderControls({ grants: [makeGrant()] });

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    fireEvent.change(screen.getByLabelText("Revocation reason"), {
      target: { value: "First reason" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revoke grant" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Temporary failure",
    );
    const firstKey =
      commercialApiMock.revokeCommercialEntitlement.mock.calls[0][0]
        .idempotencyKey;

    fireEvent.change(screen.getByLabelText("Revocation reason"), {
      target: { value: "Corrected reason" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revoke grant" }));

    await waitFor(() => {
      expect(commercialApiMock.revokeCommercialEntitlement).toHaveBeenCalledTimes(2);
    });
    expect(
      commercialApiMock.revokeCommercialEntitlement.mock.calls[1][0]
        .idempotencyKey,
    ).not.toBe(firstKey);
  });
});
