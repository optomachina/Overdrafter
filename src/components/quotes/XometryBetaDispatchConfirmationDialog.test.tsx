import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { ProviderFanoutPlan } from "@/features/quotes/provider-fanout";
import { describe, expect, it, vi } from "vitest";
import {
  XometryBetaDispatchConfirmationDialog,
  type XometryBetaDispatchScope,
} from "./XometryBetaDispatchConfirmationDialog";

const sourcingApi = vi.hoisted(() => ({
  confirmSourcingDestination: vi.fn(),
  fetchSourcingDestination: vi.fn(),
  updateOrganizationAddresses: vi.fn(),
}));
vi.mock("@/features/quotes/api/organizations-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/quotes/api/organizations-api")>()),
  ...sourcingApi,
}));

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

// OVD-1163: one consent line carries the three server attestations.
const consentLabel = "I can share these files, they aren't export-controlled, and this is a quote request only.";
const fanoutConsentLabel = "I can share these files with these suppliers, they aren't export-controlled, and this is a quote request only.";
const submitName = "Send quote request";

/** Customer copy OVD-1163 removed from the popup. */
const FORBIDDEN_POPUP_WORDS = /founding|beta|xometry|fictiv|scope|dispatch|package|envelope|disclosure|fingerprint|policy revision/i;

describe("XometryBetaDispatchConfirmationDialog", () => {
  it("starts with a blank unit declaration and cannot submit", () => {
    const { props } = renderDialog();

    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
    expect(screen.getByText("What units is this CAD model in?")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(props.onDeclaredModelUnitsChange).toHaveBeenCalledWith(null);
  });

  // OVD-1163: a small, plain popup.
  it("asks only for the units and one consent line, with no beta, supplier or disclosure text", () => {
    renderDialog({ declaredModelUnits: "inch", scope: createScope() });

    const dialog = screen.getByRole("dialog");
    expect(screen.getByRole("heading", { name: "Request a quote" })).toBeInTheDocument();
    expect(screen.getByText("What units is this CAD model in?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Inches" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Millimeters" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: consentLabel })).not.toBeChecked();
    expect(dialog.textContent).not.toMatch(FORBIDDEN_POPUP_WORDS);
    // The policy revision and fingerprint stay plumbing only.
    expect(dialog.textContent).not.toContain("founding-beta-notice.v1");
    expect(dialog.textContent).not.toContain("a".repeat(64));
    expect(dialog.textContent).not.toContain("BRKT-001.step");
  });

  it("requires the consent and submits all three attestations with the server scope contract", async () => {
    const onConfirm = vi.fn().mockResolvedValue({ accepted: true, created: true, status: "queued" });
    renderDialog({ declaredModelUnits: "inch", scope: createScope(), onConfirm });

    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: consentLabel }));
    fireEvent.click(screen.getByRole("button", { name: submitName }));

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
    expect(screen.getByText("Quote request queued")).toBeInTheDocument();
    expect(screen.getByText("The supplier hasn't confirmed receipt yet.")).toBeInTheDocument();
  });

  it("never submits after the consent is unticked again", () => {
    const onConfirm = vi.fn();
    renderDialog({ declaredModelUnits: "inch", scope: createScope(), onConfirm });

    const consent = screen.getByRole("checkbox", { name: consentLabel });
    fireEvent.click(consent);
    fireEvent.click(consent);
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: submitName }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("clears the consent when a bound scope identity changes", () => {
    const { rerender, props } = renderDialog({ declaredModelUnits: "inch", scope: createScope() });

    fireEvent.click(screen.getByRole("checkbox", { name: consentLabel }));
    expect(screen.getByRole("button", { name: submitName })).toBeEnabled();

    rerender(
      <XometryBetaDispatchConfirmationDialog
        {...props}
        declaredModelUnits="inch"
        scope={createScope({ policyRevision: "founding-beta-notice.v2", scopeFingerprint: "d".repeat(64) })}
      />,
    );

    expect(screen.getByRole("checkbox", { name: consentLabel })).not.toBeChecked();
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
  });

  it("withdraws the consent when the fan out send list changes", () => {
    const plan = { send: ["xometry", "fictiv"], skipped: [], budget: null } satisfies ProviderFanoutPlan;
    const { rerender, props } = renderDialog({
      declaredModelUnits: "inch",
      scope: createScope(),
      fanout: { plan, outcomes: {} },
    });

    // With several suppliers the consent says so, and the list names them.
    expect(screen.getByRole("list", { name: "Providers sent" })).toHaveTextContent(/Xometry.*Fictiv/);
    fireEvent.click(screen.getByRole("checkbox", { name: fanoutConsentLabel }));
    expect(screen.getByRole("button", { name: submitName })).toBeEnabled();

    // A guard refetch adds a recipient after the box was ticked.
    rerender(
      <XometryBetaDispatchConfirmationDialog
        {...props}
        declaredModelUnits="inch"
        scope={createScope()}
        fanout={{ plan: { ...plan, send: ["xometry", "fictiv", "protolabs"] }, outcomes: {} }}
      />,
    );

    expect(screen.getByRole("checkbox", { name: fanoutConsentLabel })).not.toBeChecked();
    expect(screen.getByRole("list", { name: "Providers sent" })).toHaveTextContent(/Protolabs/);
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
  });

  it("keeps a single-supplier fan out plan as small as the plain popup", () => {
    const plan = { send: ["xometry"], skipped: [], budget: null } satisfies ProviderFanoutPlan;
    renderDialog({ declaredModelUnits: "inch", scope: createScope(), fanout: { plan, outcomes: {} } });

    expect(screen.getByRole("checkbox", { name: consentLabel })).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Providers sent" })).not.toBeInTheDocument();
  });

  it("fails closed while loading or when the server cannot provide an eligible scope", () => {
    const onRetryScope = vi.fn();
    const { rerender, props } = renderDialog({ declaredModelUnits: "inch", isScopeLoading: true });

    expect(screen.getByText("Checking this part…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();

    rerender(
      <XometryBetaDispatchConfirmationDialog
        {...props}
        declaredModelUnits="inch"
        isScopeLoading={false}
        onRetryScope={onRetryScope}
        scopeError="Enter this part's tightest tolerance."
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Enter this part's tightest tolerance.");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onRetryScope).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Retry scope check" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
  });

  it("falls back to Settings for a missing confirmed shipping destination when no organization is known", () => {
    const onOpenSourcingSettings = vi.fn();
    const { rerender, props } = renderDialog({
      declaredModelUnits: "inch",
      onOpenSourcingSettings,
      scopeDenialCode: "xometry_beta_confirmed_sourcing_address_required",
      scopeError: "Confirm your organization's shipping address so suppliers can quote.",
    });

    fireEvent.click(screen.getByRole("button", { name: "Open Settings to confirm address" }));
    expect(onOpenSourcingSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();

    rerender(
      <XometryBetaDispatchConfirmationDialog
        {...props}
        scopeDenialCode="xometry_beta_standard_tolerance_required"
        scopeError="Enter this part's tightest tolerance."
      />,
    );
    expect(screen.queryByRole("button", { name: "Open Settings to confirm address" })).not.toBeInTheDocument();
    expect(screen.getByText("Enter this part's tightest tolerance.")).toBeInTheDocument();
  });

  it("confirms a missing shipping address inline and re-runs the check without leaving the dialog", async () => {
    const address = { street: "123 Test Ave", city: "Tucson", region: "AZ", postalCode: "85701", country: "US" };
    sourcingApi.fetchSourcingDestination.mockResolvedValue({ address, state: "inferred" });
    sourcingApi.confirmSourcingDestination.mockResolvedValue(undefined);
    const onOpenSourcingSettings = vi.fn();
    const onRetryScope = vi.fn();
    renderDialog({
      declaredModelUnits: "inch",
      onOpenSourcingSettings,
      onRetryScope,
      organizationId: "org-1",
      scopeDenialCode: "xometry_beta_confirmed_sourcing_address_required",
      scopeError: "Confirm your organization's shipping address so suppliers can quote.",
    });

    expect(screen.queryByRole("button", { name: "Open Settings to confirm address" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm shipping address" }));

    await waitFor(() => expect(onRetryScope).toHaveBeenCalledTimes(1));
    expect(sourcingApi.confirmSourcingDestination).toHaveBeenCalledWith("org-1", address);
    expect(onOpenSourcingSettings).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
  });

  it("offers the inline address panel for the generic provider destination denial without naming the supplier", async () => {
    sourcingApi.fetchSourcingDestination.mockResolvedValue({
      address: { street: null, city: null, region: null, postalCode: null, country: "US" },
      state: "inferred",
    });
    renderDialog({
      declaredModelUnits: "inch",
      organizationId: "org-1",
      provider: "fictiv",
      scopeDenialCode: "provider_dispatch_confirmed_destination_required",
      scopeError: "Confirm your organization's shipping address so suppliers can quote.",
    });

    expect(await screen.findByText("Add street, city, ZIP, state before confirming.")).toBeInTheDocument();
    expect(screen.getByText(/Supplier quotes need the address parts would ship to/)).toBeInTheDocument();
    expect(screen.getByRole("dialog").textContent).not.toMatch(/Fictiv|Xometry/);
  });

  it("withdraws the consent when a refreshed scope names a different destination", () => {
    const scope = createScope();
    const { rerender, props } = renderDialog({ declaredModelUnits: "inch", scope });
    fireEvent.click(screen.getByRole("checkbox", { name: consentLabel }));
    expect(screen.getByRole("button", { name: submitName })).toBeEnabled();

    // The destination is part of the server scope, so a re-confirmed address yields a new fingerprint.
    const destination = { ...scope.scope.destination, confirmationRevision: "2", street: "200 Sample Road" };
    rerender(
      <XometryBetaDispatchConfirmationDialog
        {...props}
        declaredModelUnits="inch"
        scope={createScope({ scopeFingerprint: "e".repeat(64), scope: { ...scope.scope, destination } })}
      />,
    );

    expect(screen.getByRole("checkbox", { name: consentLabel })).not.toBeChecked();
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
  });

  it("shows a truthful denial and refresh path without claiming the request was sent", async () => {
    const onConfirm = vi.fn().mockResolvedValue({ accepted: false, created: false, status: "not_requested" });
    const onRetryScope = vi.fn();
    renderDialog({ declaredModelUnits: "inch", onConfirm, onRetryScope, scope: createScope() });

    fireEvent.click(screen.getByRole("checkbox", { name: consentLabel }));
    fireEvent.click(screen.getByRole("button", { name: submitName }));

    expect(await screen.findByText(/request was not sent/i)).toBeInTheDocument();
    expect(screen.queryByText("Quote request queued")).not.toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("checkbox", { name: consentLabel }));
    fireEvent.click(screen.getByRole("button", { name: submitName }));

    expect(await screen.findByText(/could not confirm whether the request was queued/i)).toBeInTheDocument();
    expect(screen.getByText(/Diagnostic: postgrest_failure/i)).toBeInTheDocument();
    const firstApprovalReference = onConfirm.mock.calls[0][0].approvalReference;

    fireEvent.click(screen.getByRole("button", { name: submitName }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    expect(onConfirm.mock.calls[1][0].approvalReference).toBe(firstApprovalReference);
  });

  it("shows the fallback diagnostic when confirmation rejects", async () => {
    const onConfirm = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    renderDialog({ declaredModelUnits: "inch", scope: createScope(), onConfirm });
    fireEvent.click(screen.getByRole("checkbox", { name: consentLabel }));
    fireEvent.click(screen.getByRole("button", { name: submitName }));

    expect(await screen.findByText(/Diagnostic: unknown_failure/i)).toBeInTheDocument();
  });
  it("retains the attempted consent on policy block and clears it on definitive denial", async () => {
    const onConfirm = vi.fn().mockResolvedValueOnce({ accepted: false, created: false, status: "unknown" })
      .mockResolvedValueOnce({ accepted: false, created: false, status: "denied" });
    const { rerender, props } = renderDialog({ declaredModelUnits: "inch", scope: createScope(), onConfirm });
    fireEvent.click(screen.getByRole("checkbox", { name: consentLabel }));
    fireEvent.click(screen.getByRole("button", { name: submitName }));
    await screen.findByText(/could not confirm whether the request was queued/i);
    const attempted = onConfirm.mock.calls[0][0];
    rerender(<XometryBetaDispatchConfirmationDialog {...props} scope={null} scopeError="Policy no longer available" />);
    expect(screen.getByRole("checkbox", { name: consentLabel })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: submitName }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    expect(onConfirm.mock.calls[1][0]).toEqual(attempted);
    expect(await screen.findByText(/request was not sent/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: submitName })).toBeDisabled());
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it("locks an uncertain approval to its units and clears it for a replacement customer component", async () => {
    const onConfirm = vi.fn().mockResolvedValue({ accepted: false, created: false, status: "unknown" });
    const { rerender, props } = renderDialog({ declaredModelUnits: "inch", scope: createScope(), onConfirm });
    fireEvent.click(screen.getByRole("checkbox", { name: consentLabel }));
    fireEvent.click(screen.getByRole("button", { name: submitName }));
    await screen.findByText(/could not confirm whether the request was queued/i);
    rerender(<XometryBetaDispatchConfirmationDialog {...props} scope={null} scopeError="Policy unavailable" />);
    expect(screen.getByRole("button", { name: "Millimeters" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Millimeters" }));
    expect(screen.getByRole("button", { name: submitName })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Inches" })).toHaveAttribute("aria-pressed", "true");
    rerender(<XometryBetaDispatchConfirmationDialog {...props} key="another-customer" scope={null} scopeError="Policy unavailable" />);
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it.each(["Inches", "Millimeters", consentLabel])(
    "preserves exact uncertain replay after an attempted edit: %s",
    async (control) => {
      const onConfirm = vi.fn().mockResolvedValue({ accepted: false, created: false, status: "unknown" });
      const { props } = renderDialog({ declaredModelUnits: "inch", scope: createScope(), onConfirm });
      fireEvent.click(screen.getByRole("checkbox", { name: consentLabel }));
      fireEvent.click(screen.getByRole("button", { name: submitName }));
      await screen.findByText(/could not confirm whether the request was queued/i);
      const attempted = onConfirm.mock.calls[0][0];
      vi.mocked(props.onDeclaredModelUnitsChange).mockClear();
      const target = screen.getByRole(control === "Inches" || control === "Millimeters" ? "button" : "checkbox", { name: control });
      expect(target).toBeDisabled();
      fireEvent.click(target);
      fireEvent.click(screen.getByRole("button", { name: "Check again" }));
      expect(screen.getByText(/could not confirm whether the request was queued/i)).toBeInTheDocument();
      expect(props.onDeclaredModelUnitsChange).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: submitName }));
      await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
      expect(onConfirm.mock.calls[1][0]).toEqual(attempted);
    },
  );

  it("locks edits while confirmation is pending even before a parent submitting update", async () => {
    let resolve!: (value: { accepted: false; created: false; status: "unknown" }) => void;
    const onConfirm = vi.fn().mockReturnValue(new Promise((done) => { resolve = done; }));
    renderDialog({ declaredModelUnits: "inch", scope: createScope(), onConfirm });
    fireEvent.click(screen.getByRole("checkbox", { name: consentLabel }));
    fireEvent.click(screen.getByRole("button", { name: submitName }));
    expect(screen.getByRole("checkbox", { name: consentLabel })).toBeDisabled();
    for (const name of ["Inches", "Millimeters", submitName]) expect(screen.getByRole("button", { name })).toBeDisabled();
    resolve({ accepted: false, created: false, status: "unknown" });
    await screen.findByText(/could not confirm whether the request was queued/i);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

// OVD-1163: fixable denials get a plain line and a one-click fix that re-runs the check.
describe("one-click fixes", () => {
  const drawingFinish = "ANODIZE, BLACK, MIL-A-8625F, TYPE II CLASS 2";

  it.each([
    ["xometry_beta_6061_t6_required", "use_6061_t6", "Use 6061-T6 aluminum"],
    ["xometry_beta_as_machined_required", "quote_as_machined", "Quote as machined (price won't include the finish)"],
  ] as const)("%s applies %s and checks again automatically", async (code, fix, label) => {
    const order: string[] = [];
    const onApplyFix = vi.fn(async () => { order.push("fix"); });
    const onRetryScope = vi.fn(async () => { order.push("check"); });
    renderDialog({ declaredModelUnits: "inch", onApplyFix, onRetryScope, scopeDenialCode: code, scopeError: "Plain line." });

    expect(screen.getByRole("alert")).toHaveTextContent("Plain line.");
    fireEvent.click(screen.getByRole("button", { name: label }));

    await waitFor(() => expect(onRetryScope).toHaveBeenCalledTimes(1));
    expect(onApplyFix).toHaveBeenCalledExactlyOnceWith(fix);
    expect(order).toEqual(["fix", "check"]);
  });

  it("shows the check running while the fix applies, and never submits on its own", async () => {
    let finish!: () => void;
    const onApplyFix = vi.fn(() => new Promise<void>((done) => { finish = done; }));
    const onConfirm = vi.fn();
    renderDialog({
      declaredModelUnits: "inch", onApplyFix, onConfirm,
      scopeDenialCode: "xometry_beta_as_machined_required", scopeError: "Plain line.",
    });

    fireEvent.click(screen.getByRole("button", { name: "Quote as machined (price won't include the finish)" }));
    expect(await screen.findByText("Checking this part…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
    finish();
    await waitFor(() => expect(screen.queryByText("Checking this part…")).not.toBeInTheDocument());
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("keeps the denial and says so when the fix fails, without re-running the check", async () => {
    const onApplyFix = vi.fn().mockRejectedValue(new Error("nope"));
    const onRetryScope = vi.fn();
    renderDialog({
      declaredModelUnits: "inch", onApplyFix, onRetryScope,
      scopeDenialCode: "xometry_beta_6061_t6_required", scopeError: "Plain line.",
    });

    fireEvent.click(screen.getByRole("button", { name: "Use 6061-T6 aluminum" }));
    expect(await screen.findByText("That change didn't save. Try again.")).toBeInTheDocument();
    expect(onRetryScope).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Use 6061-T6 aluminum" })).toBeInTheDocument();
  });

  it.each([
    "xometry_beta_standard_tolerance_required",
    "xometry_beta_cnc_milling_required",
    "xometry_beta_manufacturing_quote_only",
    null,
  ] as const)("offers no fix button for %s", (code) => {
    renderDialog({ declaredModelUnits: "inch", onApplyFix: vi.fn(), scopeDenialCode: code as never, scopeError: "Plain line." });

    expect(screen.getByRole("alert")).toHaveTextContent("Plain line.");
    expect(screen.queryByRole("button", { name: "Use 6061-T6 aluminum" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Quote as machined/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check again" })).toBeInTheDocument();
  });

  it("labels an as-machined quote as excluding the finish, keeping the drawing finish in the scope", () => {
    const scope = createScope();
    const requirements = {
      ...scope.scope.requirements,
      finish: drawingFinish,
      specification: { process: "CNC milling", quoteAsMachined: { finish: drawingFinish } },
    };
    renderDialog({ declaredModelUnits: "inch", scope: { ...scope, scope: { ...scope.scope, requirements } } });

    expect(screen.getByText("Quoting as machined. The price won't include the finish.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: consentLabel })).toBeInTheDocument();
  });

  it("does not claim an as-machined quote when the choice names another finish", () => {
    const scope = createScope();
    const requirements = {
      ...scope.scope.requirements,
      finish: drawingFinish,
      specification: { process: "CNC milling", quoteAsMachined: { finish: "Bead blast" } },
    };
    renderDialog({ declaredModelUnits: "inch", scope: { ...scope, scope: { ...scope.scope, requirements } } });

    expect(screen.queryByText(/Quoting as machined/)).not.toBeInTheDocument();
  });
});

describe("ProviderDispatchConfirmationDialog for Fictiv (OVD-673)", () => {
  function createFictivScope(): XometryBetaDispatchScope {
    const scope = createScope({ provider: "fictiv", envelopeRevision: "fictiv-quote-envelope.v1" });
    return { ...scope, scope: { ...scope.scope, vendor: "fictiv" } };
  }

  it("shows the same plain popup and never names another supplier", () => {
    renderDialog({ provider: "fictiv", declaredModelUnits: "inch", scope: createFictivScope() });

    expect(screen.getByRole("heading", { name: "Request a quote" })).toBeInTheDocument();
    expect(screen.getByLabelText(consentLabel)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
    expect(screen.getByRole("dialog").textContent).not.toMatch(FORBIDDEN_POPUP_WORDS);
  });

  it("submits the exact Fictiv scope with all three attestations only after the consent", async () => {
    const scope = createFictivScope();
    const onConfirm = vi.fn().mockResolvedValue({ accepted: true, created: true, status: "queued" });
    renderDialog({ provider: "fictiv", declaredModelUnits: "inch", scope, onConfirm });

    const submit = screen.getByRole("button", { name: submitName });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText(consentLabel));
    fireEvent.click(submit);

    await screen.findByText("Quote request queued");
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      authorityToShare: true,
      nonExportControlled: true,
      quoteOnly: true,
      declaredModelUnits: "inch",
      envelopeRevision: "fictiv-quote-envelope.v1",
      policyRevision: scope.policyRevision,
      scopeFingerprint: scope.scopeFingerprint,
    }));
  });

  it("never presents a scope computed for a different provider", () => {
    renderDialog({ provider: "fictiv", declaredModelUnits: "inch", scope: createScope() });

    expect(screen.queryByLabelText(consentLabel)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
  });

  it("refuses a Fictiv scope when no provider is named", () => {
    renderDialog({ declaredModelUnits: "inch", scope: createFictivScope() });

    expect(screen.queryByLabelText(consentLabel)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: submitName })).toBeDisabled();
  });
});
