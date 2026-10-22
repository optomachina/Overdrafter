import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createDefaultProcurementHandoffState } from "@/features/quotes/procurement-handoff";
import { ProcurementHandoffPanel } from "./ProcurementHandoffPanel";

describe("ProcurementHandoffPanel status treatment", () => {
  it.each([false, true])("uses words and neutral theme tokens when ready=%s", (ready) => {
    const value = createDefaultProcurementHandoffState();
    if (ready) Object.assign(value, {
      shipToContact: "Test Buyer",
      shipToLocation: "Test destination",
      billingContactName: "Test Billing",
      billingContactEmail: "billing@example.test",
    });
    const { container } = render(<ProcurementHandoffPanel scopeLabel="part" value={value} onChange={() => {}} />);
    expect(screen.getByText(ready ? "Ready for follow-up" : "4 details still needed"))
      .toHaveClass("border-border", "bg-accent", "text-foreground");
    if (ready) {
      expect(screen.getByText(/OverDrafter can use this handoff/)).toHaveClass("font-sans");
      expect(screen.getByText(/OverDrafter can use this handoff/)).not.toHaveClass("font-mono");
    }
    if (!ready) {
      expect(screen.getByText("Still needed")).toHaveClass("text-foreground");
      expect(screen.getByRole("list")).toHaveClass("text-foreground");
    }
    for (const element of container.querySelectorAll("[class]")) {
      expect(element.className).not.toMatch(/(?:text|border|bg)-(?:emerald|amber|sky|rose)-/);
    }
  });
});
