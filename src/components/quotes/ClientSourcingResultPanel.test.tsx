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

  it("keeps provider recommendations collapsed as secondary sourcing paths", () => {
    render(
      <ClientSourcingResultPanel
        result={{
          outcome: "provider_recommendations_available",
          recommendations: [
            {
              vendorName: "xometry",
              vendorLabel: "Xometry",
              fitScore: 91,
              fitReasons: ["Matches CNC milling and 6061 aluminum"],
              capabilityReviewedAt: "2026-08-01T00:00:00.000Z",
              officialRfqUrl: "https://www.xometry.com/quoting/home/",
              provenance: "reviewed_provider_capability_profile",
            },
          ],
          reason: "free_preview",
        }}
      />,
    );

    expect(screen.getByText("Additional sourcing paths")).toBeInTheDocument();
    expect(screen.queryByText("Potential provider #1")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open RFQ" })).not.toBeVisible();
  });
});
