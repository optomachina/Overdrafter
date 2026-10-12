import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BillingTierCatalog } from "./BillingTierCatalog";

describe("BillingTierCatalog", () => {
  it("stays hidden when either billing flag is off", () => {
    const { container } = render(<BillingTierCatalog />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/\$99/)).not.toBeInTheDocument();

    render(
      <BillingTierCatalog selfServiceEnabled="true" tierCatalogEnabled="false" />,
    );
    expect(screen.queryByLabelText("Subscription tiers")).not.toBeInTheDocument();
  });

  it("renders the locked prices and caps from the catalog when both flags are on", () => {
    render(
      <BillingTierCatalog selfServiceEnabled="true" tierCatalogEnabled="true" />,
    );

    expect(screen.getByLabelText("Subscription tiers")).toBeInTheDocument();
    for (const name of ["Free", "Pro", "Team", "Founding Team", "Jarvis"]) {
      expect(screen.getByRole("heading", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("$99/mo")).toBeInTheDocument();
    expect(screen.getByText("$349/mo, +$40/seat")).toBeInTheDocument();
    expect(screen.getByText("$199/mo")).toBeInTheDocument();
    expect(screen.getByText(/3 manual runs per month/)).toBeInTheDocument();
    expect(screen.getByText(/40 successful runs and 300 provider attempts/)).toBeInTheDocument();
    expect(screen.getAllByText(/120 pooled successful runs and 900 provider attempts/)).toHaveLength(2);
    expect(screen.getByText(/At most 8 teams\. Rate held 12 months\./)).toBeInTheDocument();
    expect(screen.getByText(/\$10 model usage cap per seat/)).toBeInTheDocument();
    expect(screen.queryByText(/annual|\/yr/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Price TBD")).not.toBeInTheDocument();
  });
});
