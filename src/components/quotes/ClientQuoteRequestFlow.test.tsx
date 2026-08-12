import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClientQuoteRequestFlow } from "./ClientQuoteRequestFlow";

const baseProps = {
  availableVendors: ["fictiv", "xometry"] as const,
  canSubmit: true,
  disclosureFields: [
    { label: "Quantity", value: "10 pcs" },
    { label: "Material", value: "6061-T6 aluminum" },
  ],
  files: [
    { kind: "CAD" as const, name: "BRKT-001.step", sizeBytes: 1_048_576 },
    { kind: "Drawing" as const, name: "BRKT-001.pdf", sizeBytes: 204_800 },
  ],
  initialSelectedVendors: ["xometry"] as const,
  open: true,
  partLabel: "BRKT-001 rev A",
  onConfirm: vi.fn().mockResolvedValue(true),
  onOpenChange: vi.fn(),
};

describe("ClientQuoteRequestFlow", () => {
  it("requires scope review before confirming the disclosure", async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);

    render(<ClientQuoteRequestFlow {...baseProps} onConfirm={onConfirm} />);

    expect(screen.getByRole("heading", { name: "Choose where to request quotes" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Send to Xometry" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Send to Fictiv" })).not.toBeChecked();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Send to Fictiv" }));
    fireEvent.click(screen.getByRole("button", { name: "Review what will be shared" }));

    expect(screen.getByRole("heading", { name: "Confirm what will be shared" })).toBeInTheDocument();
    expect(screen.getByText("BRKT-001.step")).toBeInTheDocument();
    expect(screen.getByText("BRKT-001.pdf")).toBeInTheDocument();
    expect(screen.getByText("6061-T6 aluminum")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send to 2 vendors" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(["xometry", "fictiv"]));
  });

  it("keeps Free coverage read-only", () => {
    render(<ClientQuoteRequestFlow {...baseProps} canSubmit={false} />);

    expect(screen.getByText("Pro sourcing required")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Send to Xometry" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Review what will be shared" })).toBeDisabled();
  });

  it("shows blockers before vendor selection can continue", () => {
    render(
      <ClientQuoteRequestFlow
        {...baseProps}
        blockerReasons={["Attach a CAD file.", "Choose a manufacturing process."]}
      />,
    );

    expect(screen.getByText("Finish the part requirements first")).toBeInTheDocument();
    expect(screen.getByText("· Attach a CAD file.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review what will be shared" })).toBeDisabled();
  });

  it("retains the selected vendors when submission is rejected", async () => {
    render(
      <ClientQuoteRequestFlow
        {...baseProps}
        onConfirm={vi.fn().mockResolvedValue(false)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review what will be shared" }));
    fireEvent.click(screen.getByRole("button", { name: "Send to 1 vendor" }));

    expect(
      await screen.findByText(/request was not started/i),
    ).toBeInTheDocument();
    expect(screen.getByText("Xometry")).toBeInTheDocument();
  });

  it("disables a fully covered vendor and explains commercial validity", () => {
    render(
      <ClientQuoteRequestFlow
        {...baseProps}
        laneEligibility={[
          {
            vendor: "xometry",
            partId: "part-1",
            requestedQuantity: 10,
            state: "valid_quote",
            currentOfferId: "offer-1",
            validUntil: "2026-09-10T23:59:59.999Z",
            retryAt: null,
          },
          {
            vendor: "fictiv",
            partId: "part-1",
            requestedQuantity: 10,
            state: "requestable",
            currentOfferId: null,
            validUntil: null,
            retryAt: null,
          },
        ]}
      />,
    );

    expect(screen.getByRole("checkbox", { name: "Send to Xometry" })).toBeDisabled();
    expect(screen.getByText(/Valid through/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Send to Fictiv" })).toBeEnabled();
  });

  it("reviews and submits only uncovered vendors in a mixed selection", async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    render(
      <ClientQuoteRequestFlow
        {...baseProps}
        initialSelectedVendors={["xometry", "fictiv"]}
        onConfirm={onConfirm}
        laneEligibility={[
          {
            vendor: "xometry",
            partId: "part-1",
            requestedQuantity: 10,
            state: "valid_quote",
            currentOfferId: "offer-1",
            validUntil: "2026-09-10T23:59:59.999Z",
            retryAt: null,
          },
          {
            vendor: "fictiv",
            partId: "part-1",
            requestedQuantity: 10,
            state: "requestable",
            currentOfferId: null,
            validUntil: null,
            retryAt: null,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review what will be shared" }));

    const recipients = screen.getByRole("region", { name: "Recipients" });
    expect(recipients).toHaveTextContent("Fictiv");
    expect(recipients).not.toHaveTextContent("Xometry");

    fireEvent.click(screen.getByRole("button", { name: "Send to 1 vendor" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(["fictiv"]));
  });

  it("routes a fully covered selection to its current comparison", async () => {
    const onConfirm = vi.fn().mockResolvedValue(true);
    render(
      <ClientQuoteRequestFlow
        {...baseProps}
        availableVendors={["xometry"]}
        onConfirm={onConfirm}
        laneEligibility={[
          {
            vendor: "xometry",
            partId: "part-1",
            requestedQuantity: 10,
            state: "valid_quote",
            currentOfferId: "offer-1",
            validUntil: "2026-09-10T23:59:59.999Z",
            retryAt: null,
          },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Review what will be shared" }));
    fireEvent.click(screen.getByRole("button", { name: "View current comparison" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(["xometry"]));
  });

  it("shows the retry time while a same-scope cooldown is active", () => {
    render(
      <ClientQuoteRequestFlow
        {...baseProps}
        laneEligibility={[
          {
            vendor: "xometry",
            partId: "part-1",
            requestedQuantity: 10,
            state: "cooldown",
            currentOfferId: null,
            validUntil: null,
            retryAt: "2026-08-13T12:00:00.000Z",
          },
        ]}
      />,
    );

    expect(screen.getByText(/Try again after/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review what will be shared" })).toBeDisabled();
  });

  it("keeps an active request distinct from a valid quote comparison", () => {
    render(
      <ClientQuoteRequestFlow
        {...baseProps}
        availableVendors={["xometry"]}
        laneEligibility={[
          {
            vendor: "xometry",
            partId: "part-1",
            requestedQuantity: 10,
            state: "active",
            currentOfferId: null,
            validUntil: null,
            retryAt: null,
          },
        ]}
      />,
    );

    expect(screen.getByText("Request already in progress")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review what will be shared" })).toBeDisabled();
  });
});
