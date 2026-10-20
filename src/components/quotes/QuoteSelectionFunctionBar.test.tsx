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
        matchingOptionCount={2}
        totalOptionCount={4}
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
        matchingOptionCount={2}
        totalOptionCount={4}
        onScopeChange={vi.fn()}
        onRequestedByDateChange={onRequestedByDateChange}
      />,
    );

    expect(screen.getByText("Showing 2 of 4 options that meet your deadline.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Need by date"), { target: { value: "2026-04-22" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(onRequestedByDateChange).toHaveBeenNthCalledWith(1, "2026-04-22");
    expect(onRequestedByDateChange).toHaveBeenNthCalledWith(2, null);
  });
});
