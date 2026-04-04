import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuoteSelectionFunctionBar } from "./QuoteSelectionFunctionBar";

describe("QuoteSelectionFunctionBar", () => {
  it("toggles scope and mode actions through the shared callbacks", () => {
    const onScopeChange = vi.fn();
    const onModeChange = vi.fn();

    render(
      <QuoteSelectionFunctionBar
        scope="domestic"
        mode="cheapest"
        requestedByDate="2026-04-15"
        onScopeChange={onScopeChange}
        onModeChange={onModeChange}
        onRequestedByDateChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Using domestic quotes" }));
    fireEvent.click(screen.getByRole("button", { name: "Balanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Fast" }));

    expect(onScopeChange).toHaveBeenCalledWith("global");
    expect(onModeChange).toHaveBeenNthCalledWith(1, "balanced");
    expect(onModeChange).toHaveBeenCalledWith("fastest");
  });

  it("propagates date changes and clear actions", () => {
    const onRequestedByDateChange = vi.fn();

    render(
      <QuoteSelectionFunctionBar
        scope="global"
        mode="fastest"
        requestedByDate="2026-04-15"
        onScopeChange={vi.fn()}
        onModeChange={vi.fn()}
        onRequestedByDateChange={onRequestedByDateChange}
      />,
    );

    fireEvent.change(screen.getByLabelText("Due by"), { target: { value: "2026-04-22" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    expect(onRequestedByDateChange).toHaveBeenNthCalledWith(1, "2026-04-22");
    expect(onRequestedByDateChange).toHaveBeenNthCalledWith(2, null);
  });
});
