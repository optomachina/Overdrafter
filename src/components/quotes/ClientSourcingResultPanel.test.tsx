import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ClientSourcingResult } from "@/features/quotes/sourcing-result";
import { ClientSourcingResultPanel } from "./ClientSourcingResultPanel";

const unresolvedProcessResult: ClientSourcingResult = {
  outcome: "unsupported_package",
  reason: "process_unresolved",
  title: "Confirm milling or turning",
  explanation: "The current process is not specific enough to rank provider fit.",
  nextAction: "Choose CNC milling or CNC turning in the request details.",
};

describe("ClientSourcingResultPanel", () => {
  it("offers direct process selectors when provider matching needs a process", () => {
    const onProcessSelect = vi.fn();

    render(
      <ClientSourcingResultPanel
        result={unresolvedProcessResult}
        selectedProcess="CNC milling"
        onProcessSelect={onProcessSelect}
      />,
    );

    expect(screen.getByRole("button", { name: "CNC milling" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/provider matching refreshes automatically/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "CNC turning" }));
    expect(onProcessSelect).toHaveBeenCalledWith("CNC turning");
  });

  it("does not show process selectors for unrelated unsupported states", () => {
    render(
      <ClientSourcingResultPanel
        result={{
          outcome: "unsupported_package",
          reason: "material_unresolved",
          title: "Confirm the material",
          explanation: "Material is required.",
          nextAction: "Set an aluminum alloy in request details.",
        }}
        onProcessSelect={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "CNC milling" })).not.toBeInTheDocument();
  });
});
