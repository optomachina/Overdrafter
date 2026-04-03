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
    ["not_requested", "Quote Not requested", ["border-white/10", "bg-white/6", "text-white/70"]],
    ["queued", "Quote Queued", ["border-amber-400/20", "bg-amber-500/10", "text-amber-100"]],
    ["requesting", "Quote Requesting", ["border-amber-400/20", "bg-amber-500/10", "text-amber-100"]],
    ["received", "Quote Quoted", ["border-emerald-400/20", "bg-emerald-500/10", "text-emerald-100"]],
    ["failed", "Quote Failed", ["border-rose-400/20", "bg-rose-500/10", "text-rose-100"]],
    ["canceled", "Quote Canceled", ["border-rose-400/20", "bg-rose-500/10", "text-rose-100"]],
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
