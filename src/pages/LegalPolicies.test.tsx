import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  FOUNDING_BETA_POLICY_REVISION,
  FOUNDING_BETA_SUPPORT_EMAIL,
} from "@/lib/founding-beta-policy";
import LegalPolicies from "./LegalPolicies";

function renderPolicy(policy: "terms" | "privacy") {
  return render(
    <MemoryRouter>
      <LegalPolicies policy={policy} />
    </MemoryRouter>,
  );
}

describe("Founding Beta policy pages", () => {
  it("publishes the bounded beta terms and approved commitments", () => {
    renderPolicy("terms");

    expect(screen.getByRole("heading", { name: "Founding Beta Terms" })).toBeInTheDocument();
    expect(screen.getByText(FOUNDING_BETA_POLICY_REVISION)).toBeInTheDocument();
    expect(screen.getByText(/free and invitation-only/i)).toBeInTheDocument();
    expect(screen.getByText(/does not create a charge, order, purchase order, supplier commitment/i)).toBeInTheDocument();
    expect(screen.getByText(/must have authority to share/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Account responsibility" })).toBeInTheDocument();
    expect(screen.getByText(/keep your sign-in credentials secure/i)).toBeInTheDocument();
    expect(screen.getByText(/do not submit ITAR, CUI, export-controlled/i)).toBeInTheDocument();
    expect(screen.getByText(/within 30 days/i)).toBeInTheDocument();
    expect(screen.getByText(/within 90 days/i)).toBeInTheDocument();
    expect(screen.getByText(/within one Arizona business day/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: FOUNDING_BETA_SUPPORT_EMAIL })).toHaveAttribute(
      "href",
      `mailto:${FOUNDING_BETA_SUPPORT_EMAIL}`,
    );
    expect(document.body).not.toHaveTextContent(/placeholder|intended to cover/i);
  });

  it("publishes truthful privacy, diagnostics, provider, and deletion behavior", () => {
    renderPolicy("privacy");

    expect(screen.getByRole("heading", { name: "Privacy & data handling" })).toBeInTheDocument();
    expect(screen.getByText(/does not automatically upload that diagnostic report/i)).toBeInTheDocument();
    expect(screen.getByText(/not used for model training, model evaluation, or product improvement/i)).toBeInTheDocument();
    expect(screen.getByText(/OpenAI, Anthropic, or OpenRouter/i)).toBeInTheDocument();
    expect(screen.getByText(/title-block or full-page drawing images, the filename, and parser context/i)).toBeInTheDocument();
    expect(screen.getByText(/named provider receives only the displayed files/i)).toBeInTheDocument();
    expect(screen.getByText(/within 30 days/i)).toBeInTheDocument();
    expect(screen.getByText(/within 90 days/i)).toBeInTheDocument();
    expect(screen.getAllByText(FOUNDING_BETA_SUPPORT_EMAIL).length).toBeGreaterThan(0);
    expect(document.body).not.toHaveTextContent(/placeholder|intended to document/i);
  });
});
