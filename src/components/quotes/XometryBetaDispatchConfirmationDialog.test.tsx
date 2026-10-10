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
      destination: { confirmationRevision: "1", state: "confirmed", street: "123 Test Ave", city: "Tucson", region: "AZ", postalCode: "85701", country: "US" },
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
    expect(screen.getByText("123 Test Ave, Tucson, AZ 85701, US")).toBeInTheDocument();
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
        envelopeRevision: "xometry-controlled-beta-envelope.v1",
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

  it("shows the fallback diagnostic when confirmation rejects", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    renderDialog({ declaredModelUnits: "inch", scope: createScope(), onConfirm });
    fireEvent.click(screen.getByRole("checkbox", { name: authorityLabel }));
    fireEvent.click(screen.getByRole("checkbox", { name: exportLabel }));
    fireEvent.click(screen.getByRole("checkbox", { name: quoteOnlyLabel }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));

    expect(await screen.findByText(/Diagnostic: unknown_failure/i)).toBeInTheDocument();
  });
  it("retains the attempted disclosure on policy block and clears it on definitive denial", async () => {
    const onConfirm = vi.fn().mockResolvedValueOnce({ accepted: false, created: false, status: "unknown" })
      .mockResolvedValueOnce({ accepted: false, created: false, status: "denied" });
    const { rerender, props } = renderDialog({ declaredModelUnits: "inch", scope: createScope(), onConfirm });
    for (const label of [authorityLabel, exportLabel, quoteOnlyLabel]) fireEvent.click(screen.getByRole("checkbox", { name: label }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));
    await screen.findByText(/could not confirm whether the request was queued/i);
    const attempted = onConfirm.mock.calls[0][0];
    rerender(<XometryBetaDispatchConfirmationDialog {...props} scope={null} scopeError="Policy no longer available" />);
    expect(screen.getByRole("checkbox", { name: authorityLabel })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    expect(onConfirm.mock.calls[1][0]).toEqual(attempted);
    expect(await screen.findByText(/current package was not queued/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeDisabled());
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it("locks an uncertain approval to its units and clears it for a replacement customer component", async () => {
    const onConfirm = vi.fn().mockResolvedValue({ accepted: false, created: false, status: "unknown" });
    const { rerender, props } = renderDialog({ declaredModelUnits: "inch", scope: createScope(), onConfirm });
    for (const label of [authorityLabel, exportLabel, quoteOnlyLabel]) fireEvent.click(screen.getByRole("checkbox", { name: label }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));
    await screen.findByText(/could not confirm whether the request was queued/i);
    rerender(<XometryBetaDispatchConfirmationDialog {...props} scope={null} scopeError="Policy unavailable" />);
    expect(screen.getByRole("button", { name: "Millimeters" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Millimeters" }));
    expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Inches" })).toHaveAttribute("aria-pressed", "true");
    rerender(<XometryBetaDispatchConfirmationDialog {...props} key="another-customer" scope={null} scopeError="Policy unavailable" />);
    expect(screen.getByRole("button", { name: "Confirm & queue Xometry quote" })).toBeDisabled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it.each(["Inches", "Millimeters", authorityLabel, exportLabel, quoteOnlyLabel])(
    "preserves exact uncertain replay after an attempted edit: %s",
    async (control) => {
      const onConfirm = vi.fn().mockResolvedValue({ accepted: false, created: false, status: "unknown" });
      const { props } = renderDialog({ declaredModelUnits: "inch", scope: createScope(), onConfirm });
      for (const label of [authorityLabel, exportLabel, quoteOnlyLabel]) fireEvent.click(screen.getByRole("checkbox", { name: label }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));
      await screen.findByText(/could not confirm whether the request was queued/i);
      const attempted = onConfirm.mock.calls[0][0];
      vi.mocked(props.onDeclaredModelUnitsChange).mockClear();
      const target = screen.getByRole(control === "Inches" || control === "Millimeters" ? "button" : "checkbox", { name: control });
      expect(target).toBeDisabled();
      fireEvent.click(target);
      fireEvent.click(screen.getByRole("button", { name: "Refresh current scope" }));
      expect(screen.getByText(/could not confirm whether the request was queued/i)).toBeInTheDocument();
      expect(props.onDeclaredModelUnitsChange).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));
      await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
      expect(onConfirm.mock.calls[1][0]).toEqual(attempted);
    },
  );

  it("locks edits while confirmation is pending even before a parent submitting update", async () => {
    let resolve!: (value: { accepted: false; created: false; status: "unknown" }) => void;
    const onConfirm = vi.fn().mockReturnValue(new Promise((done) => { resolve = done; }));
    renderDialog({ declaredModelUnits: "inch", scope: createScope(), onConfirm });
    for (const label of [authorityLabel, exportLabel, quoteOnlyLabel]) fireEvent.click(screen.getByRole("checkbox", { name: label }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm & queue Xometry quote" }));
    for (const label of [authorityLabel, exportLabel, quoteOnlyLabel]) expect(screen.getByRole("checkbox", { name: label })).toBeDisabled();
    for (const name of ["Inches", "Millimeters", "Confirm & queue Xometry quote"]) expect(screen.getByRole("button", { name })).toBeDisabled();
    resolve({ accepted: false, created: false, status: "unknown" });
    await screen.findByText(/could not confirm whether the request was queued/i);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

});

describe("ProviderDispatchConfirmationDialog for Fictiv (OVD-673)", () => {
  function createFictivScope(): XometryBetaDispatchScope {
    const scope = createScope({ provider: "fictiv", envelopeRevision: "fictiv-quote-envelope.v1" });
    return { ...scope, scope: { ...scope.scope, vendor: "fictiv" } };
  }
  const fictivAuthorityLabel = "I am authorized to share these files and requirements with Fictiv to request a quote.";

  it("names Fictiv everywhere the customer is told who receives the package", () => {
    renderDialog({ provider: "fictiv", declaredModelUnits: "inch", scope: createFictivScope() });

    expect(screen.getByText("Founding Beta · Fictiv")).toBeInTheDocument();
    expect(screen.getByText("Confirm Fictiv beta quote request")).toBeInTheDocument();
    expect(screen.getByText(/OverDrafter will queue for Fictiv\./)).toBeInTheDocument();
    expect(screen.getByText("Fictiv")).toBeInTheDocument();
    expect(screen.getByText("fictiv-quote-envelope.v1")).toBeInTheDocument();
    expect(screen.getByLabelText(fictivAuthorityLabel)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm & queue Fictiv quote" })).toBeDisabled();
    expect(screen.queryByText(/Xometry/)).not.toBeInTheDocument();
  });

  it("submits the exact Fictiv scope only after all three affirmations", async () => {
    const scope = createFictivScope();
    const onConfirm = vi.fn().mockResolvedValue({ accepted: true, created: true, status: "queued" });
    renderDialog({ provider: "fictiv", declaredModelUnits: "inch", scope, onConfirm });

    const submit = screen.getByRole("button", { name: "Confirm & queue Fictiv quote" });
    fireEvent.click(screen.getByLabelText(fictivAuthorityLabel));
    fireEvent.click(screen.getByLabelText(exportLabel));
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText(quoteOnlyLabel));
    fireEvent.click(submit);

    await screen.findByText("Fictiv quote request queued");
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      authorityToShare: true,
      nonExportControlled: true,
      quoteOnly: true,
      declaredModelUnits: "inch",
      envelopeRevision: "fictiv-quote-envelope.v1",
      policyRevision: scope.policyRevision,
      scopeFingerprint: scope.scopeFingerprint,
    }));
    expect(screen.getByText(/Fictiv has not yet been confirmed as having received the package\./)).toBeInTheDocument();
  });

  it("never presents a scope computed for a different provider", () => {
    renderDialog({ provider: "fictiv", declaredModelUnits: "inch", scope: createScope() });

    expect(screen.queryByText("BRKT-001.step")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(fictivAuthorityLabel)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm & queue Fictiv quote" })).toBeDisabled();
  });

  it("keeps the Xometry copy when no provider is named", () => {
    renderDialog({ declaredModelUnits: "inch", scope: createFictivScope() });

    expect(screen.getByText("Confirm Xometry beta quote request")).toBeInTheDocument();
    expect(screen.queryByText("BRKT-001.step")).not.toBeInTheDocument();
  });
});
