import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuoteSelectionFunctionBar } from "./QuoteSelectionFunctionBar";

describe("QuoteSelectionFunctionBar", () => {
  it("toggles scope through the shared callback and leaves table order to the comparison table", () => {
    const onScopeChange = vi.fn();

    render(
      <QuoteSelectionFunctionBar
        scope="domestic"
        requestedByDate="2026-04-15"
        viewDeadline="2026-04-02"
        deadlineCounts={{ on_time: 1, unconfirmed: 2, late: 0 }}
        onScopeChange={onScopeChange}
        onRequestedByDateChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "US-only sourcing" }));

    expect(onScopeChange).toHaveBeenCalledWith("global");
    // OVD-571: Cheapest/Fastest live on the comparison table; no Balanced preset or auto-selecting mode buttons.
    expect(screen.queryByRole("group", { name: "Quote preset" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Balanced" })).not.toBeInTheDocument();
  });

  it("disables the scope toggle, the date field and Clear while a save is pending (OVD-991)", () => {
    const { rerender } = render(
      <QuoteSelectionFunctionBar
        scope="global"
        requestedByDate="2026-04-15"
        viewDeadline="2026-04-02"
        onScopeChange={vi.fn()}
        onRequestedByDateChange={vi.fn()}
        disabled
      />,
    );

    expect(screen.getByRole("button", { name: "All sourcing" })).toBeDisabled();
    expect(screen.getByLabelText("Need by date")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();

    rerender(
      <QuoteSelectionFunctionBar
        scope="global"
        requestedByDate="2026-04-15"
        viewDeadline="2026-04-02"
        onScopeChange={vi.fn()}
        onRequestedByDateChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "All sourcing" })).toBeEnabled();
    expect(screen.getByLabelText("Need by date")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
  });

  it("shows the supplied due date help text in the tooltip", async () => {
    render(
      <QuoteSelectionFunctionBar
        scope="global"
        requestedByDate={null}
        onScopeChange={vi.fn()}
        onRequestedByDateChange={vi.fn()}
        dueDateHelpText="Changes this view only."
      />,
    );

    fireEvent.focus(screen.getByText("Need by date"));
    expect((await screen.findAllByText("Changes this view only.")).length).toBeGreaterThan(0);
  });

  it("propagates date changes and clear actions", () => {
    const onRequestedByDateChange = vi.fn();

    render(
      <QuoteSelectionFunctionBar
        scope="global"
        requestedByDate="2026-04-15"
        viewDeadline="2026-04-02"
        deadlineCounts={{ on_time: 1, unconfirmed: 2, late: 0 }}
        onScopeChange={vi.fn()}
        onRequestedByDateChange={onRequestedByDateChange}
      />,
    );

    const pill = screen.getByText("By Thu, Apr 2, 2026: 1 on time · 2 may miss · 0 late");
    expect(pill).toHaveClass("rounded-surface-sm", "border-border", "bg-muted", "text-foreground");
    expect(pill).not.toHaveClass("rounded-full");
    expect(pill.className).not.toContain("amber-50");
    expect(screen.queryByText(/meet your deadline/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Need by date"), { target: { value: "2026-04-22" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(onRequestedByDateChange).toHaveBeenNthCalledWith(1, "2026-04-22");
    expect(onRequestedByDateChange).toHaveBeenNthCalledWith(2, null);
  });
  it("shows the effective deadline with no Need by filter and hides it without a view deadline", () => {
    const props = { scope: "global" as const, requestedByDate: null,
      deadlineCounts: { on_time: 1, unconfirmed: 2, late: 0 },
      onScopeChange: vi.fn(), onRequestedByDateChange: vi.fn() };
    const { rerender } = render(<QuoteSelectionFunctionBar {...props} viewDeadline="2026-04-02" />);
    expect(screen.getByText("By Thu, Apr 2, 2026: 1 on time · 2 may miss · 0 late")).toBeInTheDocument();
    rerender(<QuoteSelectionFunctionBar {...props} requestedByDate="2026-04-15" viewDeadline={null} />);
    expect(screen.queryByText(/on time ·/)).not.toBeInTheDocument();
  });

});
