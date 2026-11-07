import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { ClientPartRequestUpdateInput } from "@/features/quotes/types";
import { RFQ_OPTIONAL_DETAIL_FIELD_COUNT } from "@/features/quotes/rfq-metadata";
import { ClientPartRequestEditor } from "./ClientPartRequestEditor";

function makeDraft(overrides: Partial<ClientPartRequestUpdateInput> = {}): ClientPartRequestUpdateInput {
  return {
    jobId: "job-1",
    description: null,
    partNumber: null,
    revision: null,
    material: "6061-T6",
    finish: null,
    threads: null,
    tightestToleranceInch: null,
    process: null,
    notes: null,
    quantity: 1,
    requestedQuoteQuantities: [],
    requestedByDate: null,
    requestedServiceKinds: [],
    primaryServiceKind: null,
    serviceNotes: null,
    shipping: { requestedByDateOverride: null, packagingNotes: null, shippingNotes: null },
    certifications: {
      requiredCertifications: [],
      materialCertificationRequired: null,
      certificateOfConformanceRequired: null,
      inspectionLevel: null,
      notes: null,
    },
    sourcing: { regionPreferenceOverride: null, preferredSuppliers: [], materialProvisioning: null, notes: null },
    release: { releaseStatus: null, reviewDisposition: null, quoteBlockedUntilRelease: null, notes: null },
    ...overrides,
  };
}

const noop = () => {};

function Harness({ initial }: { initial: ClientPartRequestUpdateInput }) {
  const [draft, setDraft] = useState(initial);
  return (
    <ClientPartRequestEditor
      draft={draft}
      quoteQuantityInput=""
      onQuoteQuantityInputChange={noop}
      onChange={(next) => setDraft((current) => ({ ...current, ...next }))}
      onSave={noop}
      onUploadRevision={noop}
    />
  );
}

const total = RFQ_OPTIONAL_DETAIL_FIELD_COUNT;
const toggle = () => screen.getByRole("button", { name: /optional rfq details/i });

describe("ClientPartRequestEditor optional RFQ details", () => {
  it("is collapsed by default and keeps required fields visible", () => {
    render(<Harness initial={makeDraft()} />);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Packaging notes")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Material")).toBeVisible();
    expect(screen.getByLabelText("Process")).toBeVisible();
    expect(screen.getByLabelText("Qty")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save request details" })).toBeVisible();
  });

  it("summarises 0 set", () => {
    render(<Harness initial={makeDraft()} />);
    expect(within(toggle()).getByText(`0 of ${total} set`)).toBeInTheDocument();
  });

  it("summarises some set", () => {
    render(
      <Harness
        initial={makeDraft({
          shipping: { requestedByDateOverride: null, packagingNotes: "Bag it", shippingNotes: "   " },
          certifications: {
            requiredCertifications: ["ITAR"],
            materialCertificationRequired: true,
            certificateOfConformanceRequired: false,
            inspectionLevel: null,
            notes: null,
          },
        })}
      />,
    );
    expect(within(toggle()).getByText(`3 of ${total} set`)).toBeInTheDocument();
  });

  it("summarises all set", () => {
    render(
      <Harness
        initial={makeDraft({
          shipping: { requestedByDateOverride: null, packagingNotes: "a", shippingNotes: "b" },
          certifications: {
            requiredCertifications: ["ITAR"],
            materialCertificationRequired: true,
            certificateOfConformanceRequired: true,
            inspectionLevel: "standard" as never,
            notes: "c",
          },
          sourcing: {
            regionPreferenceOverride: "usa" as never,
            preferredSuppliers: ["Acme"],
            materialProvisioning: "supplier_provided" as never,
            notes: "d",
          },
          release: { releaseStatus: "released" as never, reviewDisposition: null, quoteBlockedUntilRelease: null, notes: "e" },
        })}
      />,
    );
    expect(within(toggle()).getByText(`${total} of ${total} set`)).toBeInTheDocument();
  });

  it("expands and collapses with the keyboard-operable button", () => {
    render(<Harness initial={makeDraft()} />);
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Packaging notes")).toBeVisible();
    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Packaging notes")).not.toBeInTheDocument();
  });

  it("updates the count as a field changes and stays open while typing", () => {
    render(<Harness initial={makeDraft()} />);
    fireEvent.click(toggle());
    fireEvent.change(screen.getByLabelText("Packaging notes"), { target: { value: "B" } });
    fireEvent.change(screen.getByLabelText("Packaging notes"), { target: { value: "Bag" } });
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Packaging notes")).toHaveValue("Bag");
    expect(within(toggle()).getByText(`1 of ${total} set`)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Packaging notes"), { target: { value: "" } });
    expect(within(toggle()).getByText(`0 of ${total} set`)).toBeInTheDocument();
  });

  it("reflects a draft change made while collapsed", () => {
    const props = {
      quoteQuantityInput: "",
      onQuoteQuantityInputChange: noop,
      onChange: noop,
      onSave: noop,
      onUploadRevision: noop,
    };
    const view = render(<ClientPartRequestEditor draft={makeDraft()} {...props} />);
    view.rerender(
      <ClientPartRequestEditor
        draft={makeDraft({ release: { releaseStatus: null, reviewDisposition: null, quoteBlockedUntilRelease: null, notes: "x" } })}
        {...props}
      />,
    );
    expect(within(view.container).getByText(`1 of ${total} set`)).toBeInTheDocument();
  });
});
