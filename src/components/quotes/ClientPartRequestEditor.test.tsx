import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ClientPartPropertyOverrideField, ClientPartRequestUpdateInput } from "@/features/quotes/types";
import { ClientPartRequestEditor } from "./ClientPartRequestEditor";

type FieldDefaults = Partial<Record<ClientPartPropertyOverrideField, string | number | null>>;

vi.mock("@/components/quotes/RfqLineItemMetadataFields", () => ({
  RfqLineItemMetadataFields: () => <div data-testid="rfq-metadata" />,
}));

vi.mock("@/components/quotes/RequestServiceIntentFields", () => ({
  RequestServiceIntentFields: () => <div data-testid="service-intent-fields" />,
}));

function makeDraft(overrides: Partial<ClientPartRequestUpdateInput> = {}): ClientPartRequestUpdateInput {
  return {
    jobId: "job-1",
    description: null,
    partNumber: null,
    revision: null,
    material: "",
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
    shipping: {
      requestedByDateOverride: null,
      packagingNotes: null,
      shippingNotes: null,
    },
    certifications: {
      requiredCertifications: [],
      materialCertificationRequired: null,
      certificateOfConformanceRequired: null,
      inspectionLevel: null,
      notes: null,
    },
    sourcing: {
      regionPreferenceOverride: null,
      preferredSuppliers: [],
      materialProvisioning: null,
      notes: null,
    },
    release: {
      releaseStatus: null,
      reviewDisposition: null,
      quoteBlockedUntilRelease: null,
      notes: null,
    },
    ...overrides,
  };
}

const noop = () => {};

describe("ClientPartRequestEditor — reset buttons", () => {
  it("renders a reset button when onResetField is provided and draft differs from default", () => {
    const draft = makeDraft({ material: "modified material" });
    const fieldDefaults: FieldDefaults = {
      material: "6061-T6 aluminum",
    };

    render(
      <ClientPartRequestEditor
        draft={draft}
        quoteQuantityInput=""
        onQuoteQuantityInputChange={noop}
        onChange={noop}
        onSave={noop}
        onUploadRevision={noop}
        onResetField={noop}
        fieldDefaults={fieldDefaults}
      />,
    );

    const resetButton = screen.getByTitle("Reset to extracted: 6061-T6 aluminum");
    expect(resetButton).toBeInTheDocument();
  });

  it("does not render a reset button when draft matches the default", () => {
    const draft = makeDraft({ material: "6061-T6 aluminum" });
    const fieldDefaults: FieldDefaults = {
      material: "6061-T6 aluminum",
    };

    render(
      <ClientPartRequestEditor
        draft={draft}
        quoteQuantityInput=""
        onQuoteQuantityInputChange={noop}
        onChange={noop}
        onSave={noop}
        onUploadRevision={noop}
        onResetField={noop}
        fieldDefaults={fieldDefaults}
      />,
    );

    expect(screen.queryByTitle("Reset to extracted: 6061-T6 aluminum")).not.toBeInTheDocument();
  });

  it("does not render a reset button when no default exists for the field", () => {
    const draft = makeDraft({ material: "some material" });
    const fieldDefaults: FieldDefaults = {};

    render(
      <ClientPartRequestEditor
        draft={draft}
        quoteQuantityInput=""
        onQuoteQuantityInputChange={noop}
        onChange={noop}
        onSave={noop}
        onUploadRevision={noop}
        onResetField={noop}
        fieldDefaults={fieldDefaults}
      />,
    );

    expect(screen.queryByRole("button", { name: /reset to extracted/i })).not.toBeInTheDocument();
  });

  it("does not render reset buttons when onResetField is not provided", () => {
    const draft = makeDraft({ material: "modified material" });
    const fieldDefaults: FieldDefaults = {
      material: "6061-T6 aluminum",
    };

    render(
      <ClientPartRequestEditor
        draft={draft}
        quoteQuantityInput=""
        onQuoteQuantityInputChange={noop}
        onChange={noop}
        onSave={noop}
        onUploadRevision={noop}
        fieldDefaults={fieldDefaults}
      />,
    );

    expect(screen.queryByTitle("Reset to extracted: 6061-T6 aluminum")).not.toBeInTheDocument();
  });

  it("calls onResetField with the correct field name when clicked", () => {
    const onResetField = vi.fn();
    const draft = makeDraft({ material: "modified material" });
    const fieldDefaults: FieldDefaults = {
      material: "6061-T6 aluminum",
    };

    render(
      <ClientPartRequestEditor
        draft={draft}
        quoteQuantityInput=""
        onQuoteQuantityInputChange={noop}
        onChange={noop}
        onSave={noop}
        onUploadRevision={noop}
        onResetField={onResetField}
        fieldDefaults={fieldDefaults}
      />,
    );

    fireEvent.click(screen.getByTitle("Reset to extracted: 6061-T6 aluminum"));
    expect(onResetField).toHaveBeenCalledOnce();
    expect(onResetField).toHaveBeenCalledWith("material");
  });
});
