import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderKillSwitchCard } from "./ProviderKillSwitchCard";

const { fetchMock, setMock, aal2Mock, factorsMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(), setMock: vi.fn(), aal2Mock: vi.fn(), factorsMock: vi.fn(),
}));
vi.mock("@/features/quotes/api/provider-kill-switch-api", () => ({
  fetchProviderKillSwitches: fetchMock,
  setProviderKillSwitch: setMock,
  PROVIDER_KILL_SWITCH_MIN_REASON_LENGTH: 10,
}));
vi.mock("@/features/auth/mfa-api", () => ({ hasAal2Session: aal2Mock, listTotpFactors: factorsMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// Same stand-in as FoundingBetaEnrollmentCard.test.tsx: the real dialog runs
// onVerified and then closes; the stand-in exposes each step as a button.
vi.mock("@/components/auth/MfaStepUpDialog", () => ({
  MfaStepUpDialog: ({
    open,
    title,
    onOpenChange,
    onVerified,
  }: {
    open: boolean;
    title: string;
    onOpenChange: (open: boolean) => void;
    onVerified: () => Promise<void>;
  }) =>
    open ? (
      <div>
        <p>{title}</p>
        <button type="button" onClick={() => void onVerified().then(() => onOpenChange(false), () => undefined)}>
          Complete MFA
        </button>
        <button type="button" onClick={() => onOpenChange(false)}>
          Cancel MFA
        </button>
      </div>
    ) : null,
}));

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><ProviderKillSwitchCard /></QueryClientProvider>);
}

const available = {
  available: true,
  global: { engaged: false, reason: null, changedBy: null, changedAt: null, version: 4 },
  providers: [
    { provider: "fictiv", engaged: true, reason: "cease and desist received", changedBy: "admin-1", changedAt: "2026-10-11T12:00:00Z", version: 7 },
    { provider: "xometry", engaged: false, reason: null, changedBy: null, changedAt: null, version: 0 },
  ],
};

beforeEach(() => {
  // Existing OVD-722 flows run on an AAL2 session; OVD-771 cases override this.
  aal2Mock.mockResolvedValue(true);
  factorsMock.mockResolvedValue([{ id: "factor-1", friendlyName: "Phone", status: "verified", createdAt: "t" }]);
});

afterEach(() => {
  fetchMock.mockReset();
  setMock.mockReset();
  aal2Mock.mockReset();
  factorsMock.mockReset();
});

async function fillStopXometry() {
  fireEvent.click(await screen.findByRole("button", { name: "Stop xometry" }));
  fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "cease and desist received" } });
  fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "xometry" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
}

describe("ProviderKillSwitchCard AAL2 step-up (OVD-771)", () => {
  it("at AAL1 shows the challenge and calls no RPC until verification succeeds", async () => {
    aal2Mock.mockResolvedValue(false);
    fetchMock.mockResolvedValue(available);
    setMock.mockResolvedValue({ provider: "xometry", engaged: true });
    renderCard();
    await fillStopXometry();

    expect(await screen.findByText("Verify this kill switch change")).toBeInTheDocument();
    expect(setMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Complete MFA" }));
    await waitFor(() => expect(setMock).toHaveBeenCalledOnce());
    expect(setMock.mock.calls[0][0]).toEqual({
      provider: "xometry", engaged: true, reason: "cease and desist received", expectedVersion: 0,
    });
    await waitFor(() => expect(screen.queryByText("Verify this kill switch change")).not.toBeInTheDocument());
    expect(screen.queryByText(/Nothing was changed/)).not.toBeInTheDocument();
  });

  it("at AAL2 writes without a challenge", async () => {
    fetchMock.mockResolvedValue(available);
    setMock.mockResolvedValue({ provider: "xometry", engaged: true });
    renderCard();
    await fillStopXometry();

    await waitFor(() => expect(setMock).toHaveBeenCalledOnce());
    expect(aal2Mock).toHaveBeenCalledOnce();
    expect(screen.queryByText("Verify this kill switch change")).not.toBeInTheDocument();
  });

  it("cancelling the challenge writes nothing and says so", async () => {
    aal2Mock.mockResolvedValue(false);
    fetchMock.mockResolvedValue(available);
    renderCard();
    await fillStopXometry();

    fireEvent.click(await screen.findByRole("button", { name: "Cancel MFA" }));
    expect(await screen.findByRole("status")).toHaveTextContent("verification was cancelled. Nothing was changed.");
    expect(screen.queryByText("Verify this kill switch change")).not.toBeInTheDocument();
    expect(setMock).not.toHaveBeenCalled();
  });

  it("without an enrolled authenticator shows where to enroll and sends no RPC", async () => {
    aal2Mock.mockResolvedValue(false);
    factorsMock.mockResolvedValue([{ id: "factor-1", friendlyName: "Phone", status: "unverified", createdAt: "t" }]);
    fetchMock.mockResolvedValue(available);
    renderCard();
    await fillStopXometry();

    expect(await screen.findByRole("status")).toHaveTextContent("no authenticator app enrolled");
    expect(screen.queryByText("Verify this kill switch change")).not.toBeInTheDocument();
    expect(setMock).not.toHaveBeenCalled();

    // "Set up authenticator" opens enrollment only; finishing it sends nothing.
    fireEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    expect(await screen.findByText("Set up an authenticator app")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Complete MFA" }));
    await waitFor(() => expect(screen.queryByText("Set up an authenticator app")).not.toBeInTheDocument());
    expect(setMock).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("after verify sends the write once and does not resend it on a failure", async () => {
    aal2Mock.mockResolvedValue(false);
    fetchMock.mockResolvedValue(available);
    setMock.mockRejectedValue(new Error("platform_admin_required"));
    renderCard();
    await fillStopXometry();

    fireEvent.click(await screen.findByRole("button", { name: "Complete MFA" }));
    await waitFor(() => expect(setMock).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByText("Verify this kill switch change")).not.toBeInTheDocument());
    expect(setMock).toHaveBeenCalledOnce();
  });

  it("challenges when the assurance level cannot be read (fails closed)", async () => {
    aal2Mock.mockRejectedValue(new Error("network"));
    fetchMock.mockResolvedValue(available);
    renderCard();
    await fillStopXometry();

    expect(await screen.findByText("Verify this kill switch change")).toBeInTheDocument();
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe("ProviderKillSwitchCard (OVD-722)", () => {
  it("lists each provider with state, last reason and actor", async () => {
    fetchMock.mockResolvedValue(available);
    renderCard();
    expect(await screen.findByText("cease and desist received")).toBeInTheDocument();
    expect(screen.getByText("All providers (global)")).toBeInTheDocument();
    expect(screen.getAllByText("STOPPED")).toHaveLength(1);
    expect(screen.getByText(/by admin-1/)).toBeInTheDocument();
  });

  it("requires a typed reason of at least 10 characters and the typed provider key before flipping", async () => {
    fetchMock.mockResolvedValue(available);
    setMock.mockResolvedValue({ provider: "xometry", engaged: true });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Stop xometry" }));
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "too short" } });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "xometry" } });
    expect(confirm).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "cease and desist received" } });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "xometr" } });
    expect(confirm).toBeDisabled();
    expect(setMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "xometry" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(setMock).toHaveBeenCalledOnce());
    expect(setMock.mock.calls[0][0]).toEqual({
      provider: "xometry", engaged: true, reason: "cease and desist received", expectedVersion: 0,
    });
  });

  it("flips the global switch with provider null after typing all", async () => {
    fetchMock.mockResolvedValue(available);
    setMock.mockResolvedValue({ provider: null, engaged: true });
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Stop all providers" }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "global incident response" } });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(setMock).toHaveBeenCalledOnce());
    expect(setMock.mock.calls[0][0]).toEqual({ provider: null, engaged: true, reason: "global incident response", expectedVersion: 4 });
  });

  it("a release carries the version the admin saw, and a refused stale release reloads the state", async () => {
    fetchMock.mockResolvedValue(available);
    setMock.mockRejectedValue(new Error("The kill switch changed since you loaded it."));
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Release fictiv" }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "counsel cleared the provider" } });
    fireEvent.change(screen.getByLabelText(/to confirm/), { target: { value: "fictiv" } });
    const fetchesBefore = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(setMock).toHaveBeenCalledOnce());
    expect(setMock.mock.calls[0][0]).toEqual({
      provider: "fictiv", engaged: false, reason: "counsel cleared the provider", expectedVersion: 7,
    });
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(fetchesBefore));
  });

  it("says the switch is not installed while the migration is pending", async () => {
    fetchMock.mockResolvedValue({ available: false });
    renderCard();
    expect(await screen.findByText(/migration pending/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Stop/ })).not.toBeInTheDocument();
  });
});
