import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  XometryBetaDispatchConfirmationDialog,
  type XometryBetaDispatchScope,
} from "./XometryBetaDispatchConfirmationDialog";

function createScope(overrides: Partial<XometryBetaDispatchScope> = {}): XometryBetaDispatchScope {
  return {
    declaredModelUnits: "inch",
    envelopeRevision: "xometry-controlled-beta-envelope.v1",
    jobId: "job-1",
    organizationId: "org-1",
    partId: "part-1",
    policyRevision: "founding-beta-notice.v1",
    provider: "xometry",
    requestedQuantity: 1,
    scopeFingerprint: "a".repeat(64),
    scopeVersion: 1,
    scope: {
      part: {
        id: "part-1",
        cad: {
          fileId: "cad-1",
          mimeType: "model/step",
          name: "BRKT-001.step",
          sha256: "b".repeat(64),
          sizeBytes: 1_048_576,
        },
        drawing: {
          fileId: "drawing-1",
          mimeType: "application/pdf",
          name: "BRKT-001.pdf",
          sha256: "c".repeat(64),
          sizeBytes: 204_800,
        },
      },
      quantity: 1,
      requirements: {
        id: "requirement-1",
        capturedAt: "2026-08-15T00:00:00Z",
        description: "Mounting bracket",
        finish: "As machined",
        material: "6061-T6 aluminum",
        partNumber: "BRKT-001",
        revision: "A",
        specification: { process: "CNC milling" },
        tightestToleranceInch: 0.005,
        requestedDeliveryDate: null,
      },
      schema: "quote-lane-scope.v1",
      vendor: "xometry",
    },
    ...overrides,
  };
}

function renderDialog(overrides: Partial<ComponentProps<typeof XometryBetaDispatchConfirmationDialog>> = {}) {
  const props = {
    declaredModelUnits: null,
    onConfirm: vi.fn().mockResolvedValue({ accepted: true, created: true, status: "queued" }),
    onDeclaredModelUnitsChange: vi.fn(),
    onOpenChange: vi.fn(),
    onRetryScope: vi.fn(),
    open: true,
    scope: null,
    ...overrides,
  } satisfies ComponentProps<typeof XometryBetaDispatchConfirmationDialog>;

  return { ...render(<XometryBetaDispatchConfirmationDialog {...props} />), props };
}

const authorityLabel = "I am authorized to share these files and requirements with Xometry to request a quote.";
const exportLabel = "I confirm this package is not ITAR, CUI, export-controlled, or otherwise restricted from this beta workflow.";
const quoteOnlyLabel = "I understand this is quote-only: it creates no card charge, order, purchase order, or supplier commitment.";

describe("XometryBetaDispatchConfirmationDialog", () => {
  it("starts with a blank unit declaration and cannot submit", () => {
    const { props } = renderDialog();

    expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeDisabled();
    expect(screen.getByText("Select the CAD model units to load the current Xometry disclosure scope.")).toBeInTheDocument();
    expect(props.onDeclaredModelUnitsChange).toHaveBeenCalledWith(null);
  });

  it("renders only the server-computed exact disclosure scope after units are declared", () => {
    const scope = createScope();
    renderDialog({ declaredModelUnits: "inch", scope });

    expect(screen.getByText("Xometry")).toBeInTheDocument();
    expect(screen.getByText("BRKT-001.step")).toBeInTheDocument();
    expect(screen.getByText("BRKT-001.pdf")).toBeInTheDocument();
    expect(screen.getByText("b".repeat(64))).toBeInTheDocument();
    expect(screen.getByText("CNC milling")).toBeInTheDocument();
    expect(screen.getByText("6061-T6 aluminum")).toBeInTheDocument();
    expect(screen.getByText("founding-beta-notice.v1")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: authorityLabel })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: exportLabel })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: quoteOnlyLabel })).not.toBeChecked();
  });

  it("requires each affirmation and submits only the server scope contract", async () => {
    const onConfirm = vi.fn().mockResolvedValue({ accepted: true, created: true, status: "queued" });
    renderDialog({ declaredModelUnits: "inch", scope: createScope(), onConfirm });

    fireEvent.click(screen.getByRole("checkbox", { name: authorityLabel }));
    fireEvent.click(screen.getByRole("checkbox", { name: exportLabel }));
    expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: quoteOnlyLabel }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledWith({
        approvalReference: expect.any(String),
        authorityToShare: true,
        declaredModelUnits: "inch",
        nonExportControlled: true,
        policyRevision: "founding-beta-notice.v1",
        quoteOnly: true,
        scopeFingerprint: "a".repeat(64),
      });
    });
    expect(screen.getByText("Xometry quote request queued")).toBeInTheDocument();
    expect(screen.getByText(/has not yet been confirmed as having received the package/i)).toBeInTheDocument();
  });

  it("clears all affirmations when a bound scope identity changes", () => {
    const { rerender, props } = renderDialog({ declaredModelUnits: "inch", scope: createScope() });

    fireEvent.click(screen.getByRole("checkbox", { name: authorityLabel }));
    fireEvent.click(screen.getByRole("checkbox", { name: exportLabel }));
    fireEvent.click(screen.getByRole("checkbox", { name: quoteOnlyLabel }));
    expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeEnabled();

    rerender(
      <XometryBetaDispatchConfirmationDialog
        {...props}
        declaredModelUnits="inch"
        scope={createScope({ policyRevision: "founding-beta-notice.v2", scopeFingerprint: "d".repeat(64) })}
      />,
    );

    expect(screen.getByRole("checkbox", { name: authorityLabel })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: exportLabel })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: quoteOnlyLabel })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeDisabled();
  });

  it("fails closed while loading or when the server cannot provide an eligible scope", () => {
    const onRetryScope = vi.fn();
    const { rerender, props } = renderDialog({ declaredModelUnits: "inch", isScopeLoading: true });

    expect(screen.getByText("Verifying the current Xometry disclosure scope…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeDisabled();

    rerender(
      <XometryBetaDispatchConfirmationDialog
        {...props}
        declaredModelUnits="inch"
        isScopeLoading={false}
        onRetryScope={onRetryScope}
        scopeError="The current requirements do not match the controlled beta package."
      />,
    );

    expect(screen.getByText("This package is not ready for controlled Xometry beta dispatch.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry scope check" }));
    expect(onRetryScope).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeDisabled();
  });

  it("shows a truthful denial and refresh path without claiming dispatch approval", async () => {
    const onConfirm = vi.fn().mockResolvedValue({ accepted: false, created: false, status: "not_requested" });
    const onRetryScope = vi.fn();
    renderDialog({ declaredModelUnits: "inch", onConfirm, onRetryScope, scope: createScope() });

    fireEvent.click(screen.getByRole("checkbox", { name: authorityLabel }));
    fireEvent.click(screen.getByRole("checkbox", { name: exportLabel }));
    fireEvent.click(screen.getByRole("checkbox", { name: quoteOnlyLabel }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));

    expect(await screen.findByText(/current package was not queued/i)).toBeInTheDocument();
    expect(screen.queryByText("Xometry quote request queued")).not.toBeInTheDocument();
    expect(onRetryScope).toHaveBeenCalledTimes(1);
  });

  it("preserves the approval reference when the queue outcome is unknown", async () => {
    const onConfirm = vi.fn().mockResolvedValue({
      accepted: false,
      created: false,
      diagnosticCode: "postgrest_failure",
      status: "unknown",
    });

    renderDialog({ declaredModelUnits: "inch", scope: createScope(), onConfirm });
    fireEvent.click(screen.getByRole("checkbox", { name: authorityLabel }));
    fireEvent.click(screen.getByRole("checkbox", { name: exportLabel }));
    fireEvent.click(screen.getByRole("checkbox", { name: quoteOnlyLabel }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));

    expect(await screen.findByText(/could not confirm whether the request was queued/i)).toBeInTheDocument();
    expect(screen.getByText(/Diagnostic: postgrest_failure/i)).toBeInTheDocument();
    const firstApprovalReference = onConfirm.mock.calls[0][0].approvalReference;

    fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    expect(onConfirm.mock.calls[1][0].approvalReference).toBe(firstApprovalReference);
  });
});
