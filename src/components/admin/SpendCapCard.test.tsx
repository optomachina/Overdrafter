import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpendCapCard } from "./SpendCapCard";

const { fetchSummaryMock, setCapMock, aal2Mock, factorsMock } = vi.hoisted(() => ({
  fetchSummaryMock: vi.fn(),
  setCapMock: vi.fn(),
  aal2Mock: vi.fn(),
  factorsMock: vi.fn(),
}));
vi.mock("@/features/quotes/api/platform-admin-api", () => ({
  fetchSpendSummary: fetchSummaryMock,
  setGlobalSpendCap: setCapMock,
}));
vi.mock("@/features/auth/mfa-api", () => ({ hasAal2Session: aal2Mock, listTotpFactors: factorsMock }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
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

const summary = {
  totalSpendUsd: 12,
  globalDailyCeilingUsd: 50,
  perRunCeilingUsd: 2,
  killSwitch: false,
  byCategory: {},
  byOrganization: [],
};

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><SpendCapCard /></QueryClientProvider>);
}

beforeEach(() => {
  fetchSummaryMock.mockResolvedValue(summary);
  setCapMock.mockResolvedValue({ dailyCeilingUsd: 50, perRunCeilingUsd: 2, killSwitch: true });
  factorsMock.mockResolvedValue([{ id: "factor-1", friendlyName: "Phone", status: "verified", createdAt: "t" }]);
});

afterEach(() => {
  fetchSummaryMock.mockReset();
  setCapMock.mockReset();
  aal2Mock.mockReset();
  factorsMock.mockReset();
});

describe("SpendCapCard AAL2 step-up (OVD-771)", () => {
  it("at AAL1 halting shows the challenge and calls no RPC until verification succeeds", async () => {
    aal2Mock.mockResolvedValue(false);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Halt all spending" }));

    expect(await screen.findByText("Verify this spend change")).toBeInTheDocument();
    expect(setCapMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Complete MFA" }));
    await waitFor(() => expect(setCapMock).toHaveBeenCalledOnce());
    expect(setCapMock.mock.calls[0][0]).toEqual({ killSwitch: true });
  });

  it("at AAL1 a ceiling change waits for verification too", async () => {
    aal2Mock.mockResolvedValue(false);
    renderCard();
    fireEvent.change(await screen.findByLabelText("Daily ceiling (USD)"), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Verify this spend change")).toBeInTheDocument();
    expect(setCapMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Complete MFA" }));
    await waitFor(() => expect(setCapMock).toHaveBeenCalledOnce());
    expect(setCapMock.mock.calls[0][0]).toEqual({ dailyCeilingUsd: 25 });
  });

  it("at AAL2 writes without a challenge", async () => {
    aal2Mock.mockResolvedValue(true);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Halt all spending" }));

    await waitFor(() => expect(setCapMock).toHaveBeenCalledOnce());
    expect(screen.queryByText("Verify this spend change")).not.toBeInTheDocument();
  });

  it("cancelling the challenge writes nothing and says so", async () => {
    aal2Mock.mockResolvedValue(false);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Halt all spending" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel MFA" }));

    expect(await screen.findByRole("status")).toHaveTextContent("verification was cancelled. Nothing was changed.");
    expect(setCapMock).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Halt all spending" })).toBeEnabled();
  });

  it("without an enrolled authenticator shows where to enroll and sends no RPC", async () => {
    aal2Mock.mockResolvedValue(false);
    factorsMock.mockResolvedValue([]);
    renderCard();
    fireEvent.click(await screen.findByRole("button", { name: "Halt all spending" }));

    expect(await screen.findByRole("status")).toHaveTextContent("no authenticator app enrolled");
    expect(screen.getByRole("button", { name: "Set up authenticator" })).toBeInTheDocument();
    expect(screen.queryByText("Verify this spend change")).not.toBeInTheDocument();
    expect(setCapMock).not.toHaveBeenCalled();
  });

  it("an invalid ceiling is refused before any assurance check", async () => {
    renderCard();
    fireEvent.change(await screen.findByLabelText("Daily ceiling (USD)"), { target: { value: "25usd" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(aal2Mock).not.toHaveBeenCalled();
    expect(setCapMock).not.toHaveBeenCalled();
  });
});
