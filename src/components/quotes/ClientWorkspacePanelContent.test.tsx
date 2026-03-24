import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClientQuoteRequestStatusCard } from "@/components/quotes/ClientWorkspacePanelContent";

vi.mock("@/components/quotes/ClientWorkspaceStateSummary", () => ({
  ClientWorkspaceToneBadge: ({ label }: { label: string }) => <span>{label}</span>,
}));

describe("ClientQuoteRequestStatusCard", () => {
  it("renders request status text inside a polite live region", () => {
    render(
      <ClientQuoteRequestStatusCard
        status="queued"
        tone="warning"
        label="Queued"
        detail="Your quote request was accepted and is queued for the worker."
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
        detail="Quote collection did not return a usable Xometry response."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Quote collection did not return a usable Xometry response.");
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
        detail="Request a quote to send this part to Xometry."
        actionLabel="Request quote"
        onAction={() => undefined}
      />,
    );

    const button = screen.getByRole("button", { name: /request quote/i });

    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-disabled");
  });

  it("renders cancel request actions without disabling them by default", () => {
    render(
      <ClientQuoteRequestStatusCard
        status="queued"
        tone="warning"
        label="Queued"
        detail="Your quote request was accepted and is queued for the worker."
        actionLabel="Cancel request"
        onAction={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Cancel request" })).toBeEnabled();
  });
});
