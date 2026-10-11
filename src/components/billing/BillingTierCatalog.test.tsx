import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BillingTierCatalog } from "./BillingTierCatalog";

describe("BillingTierCatalog", () => {
  it("stays hidden when either billing flag is off", () => {
    const { container } = render(<BillingTierCatalog />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Price TBD")).not.toBeInTheDocument();
    expect(screen.queryByText(/\$49/)).not.toBeInTheDocument();

    render(
      <BillingTierCatalog selfServiceEnabled="true" tierCatalogEnabled="false" />,
    );
    expect(screen.queryByLabelText("Subscription tiers")).not.toBeInTheDocument();
  });

  it("renders TBD tier copy without invented amounts when both flags are on", () => {
    render(
      <BillingTierCatalog selfServiceEnabled="true" tierCatalogEnabled="true" />,
    );

    expect(screen.getByLabelText("Subscription tiers")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.getByText("Founding Team")).toBeInTheDocument();
    expect(screen.getAllByText("Price TBD")).toHaveLength(3);
    expect(screen.queryByText(/\$\d/)).not.toBeInTheDocument();
    expect(screen.getByText(/od_pro_month_v1/)).toBeInTheDocument();
    expect(screen.getByText(/od_founding_team_year_v1/)).toBeInTheDocument();
  });
});
