import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderKillSwitchCard } from "./ProviderKillSwitchCard";

const { fetchMock, setMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), setMock: vi.fn() }));
vi.mock("@/features/quotes/api/provider-kill-switch-api", () => ({
  fetchProviderKillSwitches: fetchMock,
  setProviderKillSwitch: setMock,
  PROVIDER_KILL_SWITCH_MIN_REASON_LENGTH: 10,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

afterEach(() => {
  fetchMock.mockReset();
  setMock.mockReset();
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
