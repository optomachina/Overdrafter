import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ClientQuoteRequestStatusCard } from "@/components/quotes/ClientWorkspacePanelContent";

describe("ClientQuoteRequestStatusCard", () => {
  it("renders request status text inside a polite live region", () => {
    render(
      <ClientQuoteRequestStatusCard
        status="queued"
        tone="warning"
        label="Queued"
        detail="Your quote request was accepted and is queued for vendor quote collection."
      />,
    );

    const liveRegion = screen.getByText(/your quote request was accepted/i).parentElement;

    expect(liveRegion).toHaveAttribute("aria-live", "polite");
    expect(liveRegion).toHaveAttribute("aria-atomic", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders failed detail as an alert", () => {
    render(
      <ClientQuoteRequestStatusCard
        status="failed"
        tone="warning"
        label="Failed"
        detail="Quote collection did not return a usable vendor response."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Quote collection did not return a usable vendor response.");
  });

  it("marks disabled action buttons with aria-disabled", () => {
    render(
      <ClientQuoteRequestStatusCard
        status="not_requested"
        tone="blocked"
        label="Not requested"
        detail="Upload a CAD model before requesting a quote."
        actionLabel="Request quote"
        actionDisabled
        blockerReasons={["Upload a CAD model before requesting a quote."]}
        onAction={() => undefined}
      />,
    );

    const button = screen.getByRole("button", { name: /request quote/i });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(screen.getAllByText("Upload a CAD model before requesting a quote.")).toHaveLength(2);
  });

  it("leaves enabled action buttons without aria-disabled", () => {
    render(
      <ClientQuoteRequestStatusCard
        status="not_requested"
        tone="ready"
        label="Not requested"
        detail="Request a quote to start vendor quote collection for this part."
        actionLabel="Request quote"
        onAction={() => undefined}
      />,
    );

    const button = screen.getByRole("button", { name: /request quote/i });

    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-disabled");
  });

  it("shows a loading skeleton and disables the action button when isBusy is true", () => {
    render(
      <ClientQuoteRequestStatusCard
        status="not_requested"
        tone="ready"
        label="Not requested"
        detail="Request a quote to send this part to Xometry."
        actionLabel="Request quote"
        isBusy
        onAction={() => undefined}
      />,
    );

    expect(screen.getByLabelText("Submitting…")).toBeInTheDocument();
    expect(screen.queryByText("Request a quote to send this part to Xometry.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /request quote/i })).toBeDisabled();
  });

  it("renders cancel request actions without disabling them by default", () => {
    render(
      <ClientQuoteRequestStatusCard
        status="queued"
        tone="warning"
        label="Queued"
        detail="Your quote request was accepted and is queued for vendor quote collection."
        actionLabel="Cancel request"
        onAction={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel request" })).toBeEnabled();
  });

  it.each([
    ["not_requested", "Quote Not requested", ["border", "border-border", "bg-accent", "text-foreground/80"]],
    ["queued", "Quote Queued", ["border", "border-amber-300", "bg-amber-300", "text-amber-950"]],
    ["requesting", "Quote Requesting", ["border", "border-amber-300", "bg-amber-300", "text-amber-950"]],
    ["received", "Quote Quoted", ["border", "border-emerald-700", "bg-emerald-700", "text-white"]],
    ["failed", "Quote Failed", ["border", "border-rose-700", "bg-rose-700", "text-white"]],
    ["canceled", "Quote Canceled", ["border", "border-rose-700", "bg-rose-700", "text-white"]],
  ] as const)("renders %s with the shared badge mapping", (status, badgeLabel, classes) => {
    render(
      <ClientQuoteRequestStatusCard
        status={status}
        tone="blocked"
        label={badgeLabel.replace(/^Quote /, "")}
        detail="Status detail."
      />,
    );

    expect(screen.getByText(badgeLabel)).toHaveClass(...classes);
  });
});
