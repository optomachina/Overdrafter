import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminOrganizationSummary } from "@/features/quotes/api/platform-admin-api";
import { FoundingBetaEnrollmentCard } from "./FoundingBetaEnrollmentCard";

const apiMock = vi.hoisted(() => ({
  fetchFoundingBetaEnrollment: vi.fn(),
  setFoundingBetaEnrollment: vi.fn(),
}));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock("@/features/quotes/api/founding-beta-admin-api", () => ({
  fetchFoundingBetaEnrollment: apiMock.fetchFoundingBetaEnrollment,
  setFoundingBetaEnrollment: apiMock.setFoundingBetaEnrollment,
}));
vi.mock("sonner", () => ({ toast: toastMock }));
vi.mock("@/components/auth/MfaStepUpDialog", () => ({
  MfaStepUpDialog: ({
    open,
    title,
    description,
    onOpenChange,
    onVerified,
  }: {
    open: boolean;
    title: string;
    description: string;
    onOpenChange: (open: boolean) => void;
    onVerified: () => Promise<void>;
  }) =>
    open ? (
      <div>
        <p>{title}</p>
        <p>{description}</p>
        <button
          type="button"
          onClick={() => void onVerified().catch(() => undefined)}
        >
          Complete MFA
        </button>
        <button type="button" onClick={() => onOpenChange(false)}>
          Cancel MFA
        </button>
      </div>
    ) : null,
}));

const organizationId = "abcdef12-3456-4890-abcd-ef1234567890";
const organizations: AdminOrganizationSummary[] = [
  {
    id: organizationId,
    name: "Validation Works",
    slug: "validation-works",
    memberCount: 1,
    activeJobCount: 0,
    createdAt: "2026-08-16T00:00:00.000Z",
  },
];
const notEnrolledState = {
  organizationId,
  enrolled: false,
  latestAction: null,
  latestEventId: null,
  latestEventAt: null,
  policyRevision: "founding-beta-2026-08-15",
  termsPath: "/legal/beta-terms",
  privacyPath: "/legal/privacy",
};

function renderCard(
  props: Partial<React.ComponentProps<typeof FoundingBetaEnrollmentCard>> = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <FoundingBetaEnrollmentCard
        organizations={organizations}
        isOrganizationsLoading={false}
        organizationsError={null}
        onRetryOrganizations={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("FoundingBetaEnrollmentCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("crypto", { randomUUID: () => "intent-1" });
    apiMock.fetchFoundingBetaEnrollment.mockResolvedValue(notEnrolledState);
    apiMock.setFoundingBetaEnrollment.mockResolvedValue({
      eventId: 1,
      replayed: false,
      organizationId,
      enrolled: true,
    });
  });

  it("shows authoritative not-enrolled state without implying billing access", async () => {
    renderCard();

    expect(await screen.findByText("Not enrolled")).toBeInTheDocument();
    expect(screen.getAllByText("Validation Works")).toHaveLength(2);
    expect(screen.getByText(/independent of signup/)).toBeInTheDocument();
    expect(screen.queryByText(/Pro access/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke enrollment" })).toBeDisabled();
  });

  it("requires a reason and MFA before granting enrollment", async () => {
    renderCard();

    fireEvent.click(await screen.findByRole("button", { name: "Grant enrollment" }));
    expect(toastMock.error).toHaveBeenCalledWith(
      "Select an organization and enter a reason.",
    );
    expect(apiMock.setFoundingBetaEnrollment).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "  Approved validation organization  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant enrollment" }));

    expect(screen.getByText("Verify this Founding Beta change")).toBeInTheDocument();
    expect(screen.getByText(/does not change customer roles or billing/)).toBeInTheDocument();
    expect(apiMock.setFoundingBetaEnrollment).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Complete MFA" }));

    await waitFor(() =>
      expect(apiMock.setFoundingBetaEnrollment).toHaveBeenCalledWith({
        organizationId,
        enrolled: true,
        reason: "Approved validation organization",
        idempotencyKey: `founding-beta:${organizationId}:intent-1`,
      }),
    );
    await waitFor(() =>
      expect(apiMock.fetchFoundingBetaEnrollment).toHaveBeenCalledTimes(2),
    );
  });

  it("offers revocation for an enrolled organization through the same MFA gate", async () => {
    apiMock.fetchFoundingBetaEnrollment.mockResolvedValue({
      ...notEnrolledState,
      enrolled: true,
      latestAction: "grant",
      latestEventId: 10,
      latestEventAt: "2026-08-16T12:00:00.000Z",
    });
    apiMock.setFoundingBetaEnrollment.mockResolvedValue({
      eventId: 11,
      replayed: false,
      organizationId,
      enrolled: false,
    });
    renderCard();

    expect(await screen.findByText("Enrolled")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason"), {
      target: { value: "Validation window complete" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revoke enrollment" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete MFA" }));

    await waitFor(() =>
      expect(apiMock.setFoundingBetaEnrollment).toHaveBeenCalledWith(
        expect.objectContaining({ enrolled: false }),
      ),
    );
  });

  it("performs no mutation when MFA is canceled", async () => {
    renderCard();

    fireEvent.change(await screen.findByLabelText("Reason"), {
      target: { value: "Approved validation organization" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant enrollment" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel MFA" }));

    expect(apiMock.setFoundingBetaEnrollment).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Complete MFA" }),
    ).not.toBeInTheDocument();
  });

  it("keeps enrollment fail closed when the server denies the mutation", async () => {
    apiMock.setFoundingBetaEnrollment.mockRejectedValue(
      new Error("Multi-factor authentication is required."),
    );
    renderCard();

    fireEvent.change(await screen.findByLabelText("Reason"), {
      target: { value: "Approved validation organization" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Grant enrollment" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete MFA" }));

    await waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Multi-factor authentication is required.",
      ),
    );
    expect(screen.getByText("Not enrolled")).toBeInTheDocument();
  });

  it("fails closed when the authoritative state cannot be loaded", async () => {
    apiMock.fetchFoundingBetaEnrollment.mockRejectedValue(
      new Error("Platform administrator access is required."),
    );
    renderCard();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enrollment state unavailable",
    );
    expect(screen.getByRole("button", { name: "Grant enrollment" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Revoke enrollment" })).toBeDisabled();
    expect(apiMock.setFoundingBetaEnrollment).not.toHaveBeenCalled();
  });

  it("distinguishes an organization-list failure from an empty list", () => {
    const onRetryOrganizations = vi.fn();
    renderCard({
      organizations: [],
      organizationsError: new Error("Organization lookup failed."),
      onRetryOrganizations,
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Organization list unavailable",
    );
    expect(
      screen.queryByText("No organizations are available for enrollment."),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryOrganizations).toHaveBeenCalledTimes(1);
    expect(apiMock.fetchFoundingBetaEnrollment).not.toHaveBeenCalled();
  });

  it("shows a revoked state separately from an organization never enrolled", async () => {
    apiMock.fetchFoundingBetaEnrollment.mockResolvedValue({
      ...notEnrolledState,
      latestAction: "revoke",
      latestEventId: 14,
      latestEventAt: "2026-08-16T13:00:00.000Z",
    });
    renderCard();

    expect(await screen.findByText("Revoked")).toBeInTheDocument();
  });
});
