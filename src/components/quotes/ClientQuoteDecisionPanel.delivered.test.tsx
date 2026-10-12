import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DeliveredComparisonRow, QuoteRequestCompletionInput } from "@/features/quotes/delivered-comparison";
import type { ClientQuoteSelectionOption } from "@/features/quotes/selection";
import { ClientQuoteDecisionPanel } from "./ClientQuoteDecisionPanel";
import { makeClientQuoteOption } from "./test-option-factory";

vi.mock("@/components/quotes/ClientQuoteComparisonChart", () => ({
  ClientQuoteComparisonChart: (props: {
    axes?: string;
    deliveredRows?: readonly DeliveredComparisonRow[];
    deadline?: string | null;
    onDeadlineChange?: (next: string) => void;
    selectedKey: string | null;
  }) => (
    <div data-testid="mock-chart" data-axes={props.axes ?? "working_days"} data-deadline={props.deadline ?? ""}>
      <span data-testid="mock-chart-selected">{props.selectedKey ?? "none"}</span>
      <span data-testid="mock-chart-plotted">
        {(props.deliveredRows ?? []).filter((row) => row.plot).map((row) => row.key).join(",")}
      </span>
      <button type="button" onClick={() => props.onDeadlineChange?.("2026-10-31")}>Mock drag deadline</button>
    </div>
  ),
}));

// Monday 2026-10-12; all fixed delivery dates are civil dates in UTC.
const NOW = new Date("2026-10-12T15:00:00.000Z");

function option(key: string, overrides: Partial<ClientQuoteSelectionOption> = {}) {
  return makeClientQuoteOption({
    key,
    offerId: key,
    persistedOfferId: key,
    vendorQuoteResultId: `result-${key}`,
    leadTimeBusinessDays: null,
    resolvedDeliveryDate: null,
    ...overrides,
  });
}

const LATE_CHEAP = option("late-cheap", { vendorKey: "protolabs", vendorLabel: "Proto Labs", totalPriceUsd: 50, shipReceiveBy: "2026-10-30" });
const ON_PRICEY = option("on-pricey", { vendorKey: "xometry", vendorLabel: "Xometry", totalPriceUsd: 300, shipReceiveBy: "2026-10-15" });
const ON_MID = option("on-mid", { vendorKey: "fictiv", vendorLabel: "Fictiv", totalPriceUsd: 150, shipReceiveBy: "2026-10-21" });
const UNKNOWN = option("unknown", { vendorKey: "sendcutsend", vendorLabel: "SendCutSend", totalPriceUsd: 40 });

function rowKeys() {
  return within(screen.getByTestId("quote-vendor-table"))
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.getAttribute("data-quote-key"));
}

function renderPanel(props: Partial<Parameters<typeof ClientQuoteDecisionPanel>[0]> = {}) {
  const defaults: Parameters<typeof ClientQuoteDecisionPanel>[0] = {
    options: [LATE_CHEAP, ON_PRICEY, ON_MID, UNKNOWN],
    selectedOption: null,
    onSelect: vi.fn(),
    requestedByDate: null,
    deadline: { date: "2026-10-22", state: "confirmed" },
    now: NOW,
    timeZone: "UTC",
    activePreset: "cheapest_global",
  };
  return render(<ClientQuoteDecisionPanel {...defaults} {...props} />);
}

describe("ClientQuoteDecisionPanel delivered-date comparison (OVD-571)", () => {
  it("feeds the chart delivered-date axes and does not plot unknown arrivals", async () => {
    renderPanel();
    const chart = await screen.findByTestId("mock-chart");
    expect(chart).toHaveAttribute("data-axes", "delivered");
    expect(screen.getByTestId("mock-chart-plotted").textContent).not.toContain("unknown");
    const unplotted = screen.getByRole("list", { name: /not plotted/i });
    expect(within(unplotted).getByRole("button", { name: /SendCutSend.*arrival unknown/i })).toBeInTheDocument();
  });

  it("shows delivered dates and expected OTD with unknown and lower-bound values labeled", () => {
    renderPanel();
    const unknownRow = screen.getByTestId("quote-vendor-table").querySelector('[data-quote-key="unknown"]') as HTMLElement;
    expect(within(unknownRow).getByText("Arrival unknown")).toBeInTheDocument();
    expect(within(unknownRow).getByText("≥ $40.00")).toBeInTheDocument();
    expect(within(unknownRow).getByText(/shipping, tax, fees not quoted/i)).toBeInTheDocument();
    const onMidRow = screen.getByTestId("quote-vendor-table").querySelector('[data-quote-key="on-mid"]') as HTMLElement;
    expect(within(onMidRow).getByText("Wed, Oct 21, 2026")).toBeInTheDocument();
  });

  it("offers only Cheapest (default) and Fastest table modes", () => {
    renderPanel({ activePreset: null });
    const group = screen.getByRole("radiogroup", { name: "Table order" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["Cheapest", "Fastest"]);
    expect(within(group).getByRole("radio", { name: "Cheapest" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("button", { name: "Balanced" })).not.toBeInTheDocument();
  });

  it("Cheapest with a deadline lists on-time options first by OTD, then unconfirmed, then late", () => {
    renderPanel();
    expect(rowKeys()).toEqual(["on-mid", "on-pricey", "unknown", "late-cheap"]);
  });

  it("Fastest orders rows by delivered date", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("radio", { name: "Fastest" }));
    expect(rowKeys()).toEqual(["on-pricey", "on-mid", "late-cheap", "unknown"]);
  });

  it("keeps late options present but de-emphasized and labeled Misses deadline", () => {
    renderPanel();
    const lateRow = screen.getByTestId("quote-vendor-table").querySelector('[data-quote-key="late-cheap"]') as HTMLElement;
    expect(lateRow).toHaveAttribute("data-deadline-status", "late");
    expect(within(lateRow).getByText("Misses deadline")).toBeInTheDocument();
    expect(lateRow.className).toContain("opacity-60");
  });

  it("shows no winner badge, recommendation, or default emphasis", () => {
    renderPanel();
    expect(screen.queryByText(/pick$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Recommended starting point/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/leaders?$/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("mock-chart-selected").textContent).toBe("none");
    expect(screen.getByTestId("quote-vendor-table").querySelector("[aria-selected='true']")).toBeNull();
  });

  it("starts the deadline line at the persisted confirmed part deadline and shows the date", () => {
    renderPanel();
    expect(screen.getByTestId("mock-chart")).toHaveAttribute("data-deadline", "2026-10-22");
    expect(screen.getByTestId("deadline-summary")).toHaveTextContent("Thu, Oct 22, 2026");
    expect(screen.getByTestId("deadline-summary")).toHaveTextContent(/confirmed/i);
  });

  it("re-evaluates on-time and late when the deadline line is moved and can reset it", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Mock drag deadline" }));
    expect(screen.getByTestId("deadline-summary")).toHaveTextContent("Sat, Oct 31, 2026");
    expect(rowKeys()).toEqual(["late-cheap", "on-mid", "on-pricey", "unknown"]);
    fireEvent.click(screen.getByRole("button", { name: /Reset to confirmed deadline/i }));
    expect(screen.getByTestId("mock-chart")).toHaveAttribute("data-deadline", "2026-10-22");
  });

  it("preserves selection, focus, table mode and deadline when new options arrive", async () => {
    const onSelect = vi.fn();
    const view = renderPanel({ selectedOption: ON_PRICEY, onSelect });
    fireEvent.click(screen.getByRole("radio", { name: "Fastest" }));
    fireEvent.click(screen.getByRole("button", { name: "Mock drag deadline" }));
    const focusedRow = screen.getByTestId("quote-vendor-table").querySelector('[data-quote-key="on-mid"]') as HTMLElement;
    act(() => focusedRow.focus());

    const arriving = option("arriving", { vendorKey: "xometry", vendorLabel: "Xometry", totalPriceUsd: 10, shipReceiveBy: "2026-10-13" });
    view.rerender(
      <ClientQuoteDecisionPanel
        options={[arriving, LATE_CHEAP, ON_PRICEY, ON_MID, UNKNOWN]}
        selectedOption={ON_PRICEY}
        onSelect={onSelect}
        requestedByDate={null}
        deadline={{ date: "2026-10-22", state: "confirmed" }}
        now={NOW}
        timeZone="UTC"
        activePreset="cheapest_global"
      />,
    );

    await waitFor(() => expect(rowKeys()[0]).toBe("arriving"));
    expect(screen.getByRole("radio", { name: "Fastest" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("mock-chart")).toHaveAttribute("data-deadline", "2026-10-31");
    expect(screen.getByTestId("mock-chart-selected").textContent).toBe("on-pricey");
    expect(document.activeElement?.getAttribute("data-quote-key")).toBe("on-mid");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("re-anchors the viewport only for arrivals, never for a table order or deadline reorder", () => {
    // jsdom has no layout: place each row by its index so a reorder moves the selected row.
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const index = this.matches("tr[data-quote-key]") ? Array.from(this.parentElement?.children ?? []).indexOf(this) : 0;
      const top = 100 + index * 40;
      return { top, bottom: top + 40, left: 0, right: 600, width: 600, height: 40, x: 0, y: top, toJSON: () => ({}) };
    });
    const scrollBy = vi.fn();
    const scroller = document.scrollingElement ?? document.documentElement;
    const originalScrollBy = scroller.scrollBy;
    scroller.scrollBy = scrollBy as typeof scroller.scrollBy;
    try {
      const props = {
        selectedOption: ON_PRICEY,
        onSelect: vi.fn(),
        requestedByDate: null,
        deadline: { date: "2026-10-22", state: "confirmed" as const },
        now: NOW,
        timeZone: "UTC",
        activePreset: "cheapest_global" as const,
      };
      const view = render(<ClientQuoteDecisionPanel {...props} options={[LATE_CHEAP, ON_PRICEY, ON_MID, UNKNOWN]} />);
      const before = rowKeys();
      fireEvent.click(screen.getByRole("radio", { name: "Fastest" }));
      expect(rowKeys().indexOf("on-pricey")).not.toBe(before.indexOf("on-pricey"));
      const afterMode = rowKeys();
      fireEvent.click(screen.getByRole("button", { name: "Mock drag deadline" }));
      fireEvent.click(screen.getByRole("radio", { name: "Cheapest" }));
      expect(rowKeys()).not.toEqual(afterMode);
      expect(scrollBy).not.toHaveBeenCalled();

      // An arrival above the selected row keeps that row where it was.
      const arriving = option("arriving", { vendorKey: "xometry", vendorLabel: "Xometry", totalPriceUsd: 10, shipReceiveBy: "2026-10-13" });
      view.rerender(<ClientQuoteDecisionPanel {...props} options={[arriving, LATE_CHEAP, ON_PRICEY, ON_MID, UNKNOWN]} />);
      expect(rowKeys()[0]).toBe("arriving");
      expect(scrollBy).toHaveBeenCalledTimes(1);
      expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ top: 40 }));
    } finally {
      scroller.scrollBy = originalScrollBy;
      rectSpy.mockRestore();
    }
  });
});

describe("ClientQuoteDecisionPanel request-completion notice (OVD-571)", () => {
  const completion: QuoteRequestCompletionInput = {
    request: { id: "req-1", status: "received", requestedVendors: ["xometry", "protolabs", "fictiv"] },
    run: { id: "run-1", quoteRequestId: "req-1" },
    vendorResults: [
      { id: "result-on-pricey", vendor: "xometry", quoteRunId: "run-1", status: "instant_quote_received" },
      { id: "result-foreign", vendor: "fictiv", quoteRunId: "run-1", status: "instant_quote_received" },
      { id: "result-late-cheap", vendor: "protolabs", quoteRunId: "run-1", status: "failed" },
    ],
  };
  const domestic = option("on-pricey", { vendorKey: "xometry", vendorLabel: "Xometry", totalPriceUsd: 300, shipReceiveBy: "2026-10-15", geographicOrigin: "domestic", domesticStatus: "domestic" });
  const foreign = option("foreign", { vendorKey: "fictiv", vendorLabel: "Fictiv", vendorQuoteResultId: "result-foreign", totalPriceUsd: 90, shipReceiveBy: "2026-10-15", geographicOrigin: "foreign", domesticStatus: "foreign" });
  const unverified = option("unverified", { vendorKey: "fictiv", vendorLabel: "Fictiv", vendorQuoteResultId: "result-foreign", totalPriceUsd: 95, shipReceiveBy: "2026-10-15", geographicOrigin: "unknown", domesticStatus: "unknown" });

  it("announces completion with counts that exclude concealed overseas and unverified-origin results", () => {
    renderPanel({ options: [domestic, foreign, unverified], activePreset: "cheapest_domestic", requestCompletion: completion });
    const notice = screen.getByTestId("quote-request-completion-notice");
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveTextContent("Quote request complete: 1 option from 1 provider.");
    expect(notice).toHaveTextContent("1 provider returned no quote.");
    expect(notice.textContent).not.toMatch(/3 options|overseas|international|hidden/i);
  });

  it("does not appear until every requested provider is terminal", () => {
    renderPanel({
      options: [domestic],
      requestCompletion: {
        ...completion,
        vendorResults: [completion.vendorResults[0], { ...completion.vendorResults[1], status: "running" }, completion.vendorResults[2]],
      },
    });
    expect(screen.queryByTestId("quote-request-completion-notice")).not.toBeInTheDocument();
  });

  it("does not appear for a canceled request or without request context", () => {
    const view = renderPanel({ options: [domestic], requestCompletion: { ...completion, request: { ...completion.request!, status: "canceled" } } });
    expect(screen.queryByTestId("quote-request-completion-notice")).not.toBeInTheDocument();
    view.rerender(<ClientQuoteDecisionPanel options={[domestic]} selectedOption={null} onSelect={vi.fn()} requestedByDate={null} now={NOW} timeZone="UTC" />);
    expect(screen.queryByTestId("quote-request-completion-notice")).not.toBeInTheDocument();
  });

  it("gives the dismiss control a touch target of at least 24px (WCAG 2.2 target size)", () => {
    renderPanel({ options: [domestic], requestCompletion: completion });
    const dismiss = screen.getByRole("button", { name: "Dismiss request completion notice" });
    // Tailwind h-6/w-6 is 1.5rem (24px); padding-only sizing around a 14px icon was 18px.
    expect(dismiss).toHaveClass("h-6", "w-6");
    expect(dismiss.className).not.toMatch(/\bp-0\.5\b/);
  });

  it("can be dismissed for that request only", () => {
    const view = renderPanel({ options: [domestic], requestCompletion: completion });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss request completion notice" }));
    expect(screen.queryByTestId("quote-request-completion-notice")).not.toBeInTheDocument();
    view.rerender(
      <ClientQuoteDecisionPanel
        options={[domestic]}
        selectedOption={null}
        onSelect={vi.fn()}
        requestedByDate={null}
        now={NOW}
        timeZone="UTC"
        requestCompletion={{
          ...completion,
          request: { ...completion.request!, id: "req-2" },
          run: { id: "run-1", quoteRequestId: "req-2" },
        }}
      />,
    );
    expect(screen.getByTestId("quote-request-completion-notice")).toBeInTheDocument();
  });
});
