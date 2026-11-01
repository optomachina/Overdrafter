import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ClientPackage from "./ClientPackage";
import { toast } from "sonner";

const mocks = vi.hoisted(() => ({
  fetchClientPackage: vi.fn(), selectQuoteOption: vi.fn(),
  selectionMutation: null as null | ((variables: { optionId: string; noteOnly: boolean }) => Promise<unknown>),
}));
vi.mock("@/features/quotes/api/workspace-access", () => mocks);
vi.mock("@/features/quotes/api/session-access", () => ({ resendSignupConfirmation: vi.fn() }));
vi.mock("@/hooks/use-app-session", () => ({ useAppSession: () => ({ user: { id: "client", email: "client@example.test" }, isVerifiedAuth: true, isAuthInitializing: false, signOut: vi.fn() }) }));
vi.mock("@/components/app/AppShell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: {} } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return { ...actual, useMutation: (options: Parameters<typeof actual.useMutation>[0]) => {
    mocks.selectionMutation = options.mutationFn as typeof mocks.selectionMutation;
    return actual.useMutation(options);
  } };
});

const fixture = (source: string | null) => ({
  package: { id: "package-1", published_at: "2026-10-01T12:00:00Z", client_summary: "Published package" },
  job: { title: "Bracket", requested_quote_quantities: [10], requested_service_kinds: [] },
  options: [{ id: "option-1", source_vendor_quote_offer_id: source, label: "Historical option", option_kind: "lowest_cost", requested_quantity: 10, published_price_usd: 120, lead_time_business_days: 5, comparison_summary: "Published quote details", valid_until: null }],
  selections: [{ option_id: "option-1", created_at: "2026-10-01T13:00:00Z", note: "Previous selection note" }],
});
const renderPackage = (client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })) => render(
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={["/package/package-1"]}><Routes><Route path="/package/:packageId" element={<ClientPackage />} /></Routes></MemoryRouter>
  </QueryClientProvider>,
);

beforeEach(() => { vi.clearAllMocks(); mocks.selectQuoteOption.mockResolvedValue(undefined); });
afterEach(cleanup);

describe("published package selection eligibility", () => {
  it("keeps only the linked option actionable in a mixed package, including keyboard attempts", async () => {
    const mixed = fixture(null);
    mixed.options.push({ ...fixture("offer-2").options[0], id: "option-2", label: "Current linked option" });
    mocks.fetchClientPackage.mockResolvedValue(mixed);
    renderPackage();
    await screen.findByText("Historical option");
    expect(screen.getByText("Current linked option")).toBeInTheDocument();
    expect(screen.getByText("Previous selection note")).toBeInTheDocument();
    const retired = screen.getByRole("button", { name: "Selected" });
    const linked = screen.getByRole("button", { name: "Select another option" });
    expect(retired).toBeDisabled();
    expect(linked).toBeEnabled();
    expect(retired).toHaveAccessibleDescription(/needs a refreshed quote/);
    retired.focus();
    expect(retired).not.toHaveFocus();
    for (const key of ["Enter", " "]) {
      fireEvent.keyDown(retired, { key });
      fireEvent.keyUp(retired, { key });
    }
    fireEvent.click(retired);
    await expect(Promise.resolve().then(() => mocks.selectionMutation!({ optionId: "option-1", noteOnly: false }))).rejects.toThrow(/refreshed quote/);
    expect(mocks.selectQuoteOption).not.toHaveBeenCalled();
    fireEvent.click(linked);
    await waitFor(() => expect(mocks.selectQuoteOption).toHaveBeenCalledExactlyOnceWith({ packageId: "package-1", optionId: "option-2", note: "" }));
    expect(screen.getByText("Previous selection note")).toBeInTheDocument();
  });

  it("retains source-less quote display and selection history but disables selection with refresh guidance", async () => {
    mocks.fetchClientPackage.mockResolvedValue(fixture(null));
    renderPackage();
    expect(await screen.findByText("Historical option")).toBeInTheDocument();
    expect(screen.getByText("Published quote details")).toBeInTheDocument();
    expect(screen.getByText("Previous selection note")).toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Selected" });
    expect(button).toBeDisabled();
    expect(screen.getByText(/This option needs a refreshed quote before it can be selected/)).toBeInTheDocument();
    fireEvent.click(button);
    expect(mocks.selectQuoteOption).not.toHaveBeenCalled();
  });

  it("marks the chosen option, names its published price and quantity, and allows replacement", async () => {
    const selected = fixture("offer-1");
    selected.options.push({ ...selected.options[0], id: "option-2", label: "Fastest delivery", source_vendor_quote_offer_id: "offer-2", published_price_usd: 150 });
    selected.selections[0].option_id = "option-2";
    mocks.fetchClientPackage.mockResolvedValue(selected);
    renderPackage();
    const heading = await screen.findByRole("heading", { name: "Fastest delivery" });
    const card = heading.closest(".border") as HTMLElement;
    expect(card).toHaveClass("border-primary");
    expect(within(card).getByText("Selected", { selector: "span" })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Save decision note" })).toBeDisabled();
    expect(within(card).getByRole("button")).toHaveAttribute("aria-pressed", "true");
    const receipt = screen.getByText("Selection received").closest(".border") as HTMLElement;
    expect(receipt).toHaveTextContent("Fastest delivery · $150.00 · Qty 10");
    expect(within(receipt).getByText("Selection received")).toHaveClass("text-foreground");
    const replacement = screen.getByRole("button", { name: "Select another option" });
    expect(replacement).toBeEnabled();
    fireEvent.click(replacement);
    await waitFor(() => expect(mocks.selectQuoteOption).toHaveBeenCalledWith({ packageId: "package-1", optionId: "option-1", note: "" }));
  });

  it("keeps the option-selection toast when a refetch selects the option mid-flight", async () => {
    const initial = fixture("offer-1");
    initial.options.push({ ...initial.options[0], id: "option-2", label: "New option", source_vendor_quote_offer_id: "offer-2" });
    mocks.fetchClientPackage.mockResolvedValue(initial);
    let finish!: () => void;
    mocks.selectQuoteOption.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPackage(client);
    fireEvent.click(await screen.findByRole("button", { name: "Select another option" }));
    await waitFor(() => expect(mocks.selectQuoteOption).toHaveBeenCalledWith({
      packageId: "package-1", optionId: "option-2", note: "",
    }));
    mocks.fetchClientPackage.mockResolvedValue({
      ...initial, selections: [{ ...initial.selections[0], option_id: "option-2", note: "" }],
    });
    await act(async () => { await client.refetchQueries({ queryKey: ["client-package"] }); });
    const card = screen.getByRole("heading", { name: "New option" }).closest(".border") as HTMLElement;
    await waitFor(() => expect(within(card).getByRole("button")).toHaveAttribute("aria-pressed", "true"));
    expect(toast.success).not.toHaveBeenCalled();
    await act(async () => { finish(); });
    await waitFor(() => expect(toast.success).toHaveBeenCalledExactlyOnceWith("Quote option selected."));
  });

  it("saves another decision note for the already selected option", async () => {
    mocks.fetchClientPackage.mockResolvedValue(fixture("offer-1"));
    renderPackage();
    const save = await screen.findByRole("button", { name: "Save decision note" });
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Ship to dock B  " } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(mocks.selectQuoteOption).toHaveBeenCalledExactlyOnceWith({
      packageId: "package-1", optionId: "option-1", note: "Ship to dock B",
    }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Decision note saved."));
  });

  it.each(["", "   ", "Previous selection note", "  Previous selection note  "])(
    "disables Save decision note for an empty or unchanged note (%j)", async (note) => {
      mocks.fetchClientPackage.mockResolvedValue(fixture("offer-1"));
      renderPackage();
      const save = await screen.findByRole("button", { name: "Save decision note" });
      fireEvent.change(screen.getByRole("textbox"), { target: { value: note } });
      expect(save).toBeDisabled();
      fireEvent.click(save);
      expect(mocks.selectQuoteOption).not.toHaveBeenCalled();
      expect(screen.getByText("Previous selection note", { selector: "p" })).toBeInTheDocument();
    },
  );

  it("guards the mutation itself against missing sources and unknown option IDs", async () => {
    mocks.fetchClientPackage.mockResolvedValue(fixture(null));
    renderPackage();
    await screen.findByText("Historical option");
    for (const id of ["option-1", "not-in-package"]) {
      await expect(Promise.resolve().then(() => mocks.selectionMutation!({ optionId: id, noteOnly: false }))).rejects.toThrow(/refreshed quote/);
    }
    expect(mocks.selectQuoteOption).not.toHaveBeenCalled();
  });

  it("keeps a linked legacy quote with null validity selectable", async () => {
    const unselected = fixture("offer-1");
    unselected.selections = [];
    mocks.fetchClientPackage.mockResolvedValue(unselected);
    renderPackage();
    await screen.findByText("Historical option");
    const button = screen.getByRole("button", { name: "Select this option" });
    expect(button).toBeEnabled();
    expect(screen.queryByText(/needs a refreshed quote/)).not.toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(mocks.selectQuoteOption).toHaveBeenCalledWith({ packageId: "package-1", optionId: "option-1", note: "" }));
  });
});
