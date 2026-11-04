import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ProviderFanoutStatus } from "@/components/quotes/ProviderFanoutStatus";
import { QuoteShippingAddressPanel } from "@/components/quotes/QuoteShippingAddressPanel";
import { isQuotedAsMachined } from "@/features/quotes/quote-as-machined";
import type { ProviderFanoutState } from "@/features/quotes/use-provider-fanout";
import {
  QUOTE_REQUEST_FIX_LABELS,
  getQuoteRequestFix,
  type LiveDispatchProvider,
  type QuoteRequestFix,
  type XometryBetaDispatchDiagnosticCode,
  type XometryBetaDispatchScope,
  type XometryBetaModelUnits,
  type XometryBetaScopeDenialCode,
} from "@/features/quotes/xometry-beta-dispatch";
export type { XometryBetaDispatchScope } from "@/features/quotes/xometry-beta-dispatch";

export type XometryBetaDeclaredModelUnits = XometryBetaModelUnits;

export type XometryBetaDispatchConfirmationInput = {
  approvalReference: string;
  authorityToShare: true;
  declaredModelUnits: XometryBetaDeclaredModelUnits;
  /** Reviewed envelope revision shown to the customer for this scope. */
  envelopeRevision: string;
  nonExportControlled: true;
  policyRevision: string;
  quoteOnly: true;
  scopeFingerprint: string;
};

export type XometryBetaDispatchConfirmationResult = {
  accepted: boolean;
  created: boolean;
  deduplicated?: boolean;
  diagnosticCode?: XometryBetaDispatchDiagnosticCode;
  status: "queued" | "denied" | "unknown";
};

type XometryBetaDispatchConfirmationDialogProps = {
  declaredModelUnits: XometryBetaDeclaredModelUnits | null;
  /** Multi provider fan out (flag on only): every provider this confirmation reaches. */
  fanout?: ProviderFanoutState | null;
  isScopeLoading?: boolean;
  isSubmitting?: boolean;
  /**
   * OVD-1163: applies a one-click fix for a fixable denial. The dialog re-runs
   * the check (onRetryScope) after it resolves; a rejection shows a retry line.
   */
  onApplyFix?: (fix: QuoteRequestFix) => Promise<void>;
  onConfirm: (
    input: XometryBetaDispatchConfirmationInput,
  ) => Promise<XometryBetaDispatchConfirmationResult | null>;
  onDeclaredModelUnitsChange: (units: XometryBetaDeclaredModelUnits | null) => void;
  onOpenChange: (open: boolean) => void;
  /** Fallback for a missing confirmed shipping address when no organization id is known. */
  onOpenSourcingSettings?: () => void;
  onRetryScope?: () => void | Promise<void>;
  open: boolean;
  /** The part's organization; lets the customer confirm a missing shipping address inline. */
  organizationId?: string | null;
  /** Provider the customer is confirming disclosure to; a scope for any other provider is never shown. */
  provider?: LiveDispatchProvider;
  scope: XometryBetaDispatchScope | null;
  scopeDenialCode?: XometryBetaScopeDenialCode | null;
  scopeError?: string | null;
};

/** Denials that only a confirmed organization shipping address resolves (legacy Xometry and generic paths). */
const SHIPPING_ADDRESS_DENIALS: ReadonlySet<XometryBetaScopeDenialCode> = new Set([
  "xometry_beta_confirmed_sourcing_address_required",
  "provider_dispatch_confirmed_destination_required",
]);

function getScopeIdentity(
  scope: XometryBetaDispatchScope | null,
  declaredModelUnits: XometryBetaDeclaredModelUnits | null,
  provider: LiveDispatchProvider,
) {
  if (
    !scope ||
    !declaredModelUnits ||
    scope.declaredModelUnits !== declaredModelUnits ||
    scope.provider !== provider ||
    scope.scope.vendor !== provider
  ) {
    return null;
  }

  return [
    scope.organizationId,
    scope.provider,
    scope.declaredModelUnits,
    scope.scopeFingerprint,
    scope.policyRevision,
    scope.envelopeRevision,
  ].join(":");
}

/** One consent line for the three server attestations; with several suppliers it says so. */
function getConsentLabel(fanout: ProviderFanoutState | null) {
  const withWhom = fanout && fanout.plan.send.length > 1 ? " with these suppliers" : "";
  return `I can share these files${withWhom}, they aren't export-controlled, and this is a quote request only.`;
}

function createApprovalReference() {
  return globalThis.crypto.randomUUID();
}

function ScopeLoadState({
  declaredModelUnits,
  fix,
  fixError,
  isFixing,
  isScopeLoading,
  onApplyFix,
  onOpenSourcingSettings,
  onRetryScope,
  organizationId,
  scopeDenialCode,
  scopeError,
}: Readonly<{
  declaredModelUnits: XometryBetaDeclaredModelUnits | null;
  fix: QuoteRequestFix | null;
  fixError: boolean;
  isFixing: boolean;
  isScopeLoading: boolean;
  onApplyFix?: (fix: QuoteRequestFix) => void;
  onOpenSourcingSettings?: () => void;
  onRetryScope?: () => void | Promise<void>;
  organizationId: string | null;
  scopeDenialCode: XometryBetaScopeDenialCode | null;
  scopeError: string | null;
}>) {
  if (!declaredModelUnits) {
    return null;
  }

  if (isScopeLoading || isFixing) {
    return (
      <output className="flex items-center gap-2 text-sm text-paper-muted">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Checking this part…
      </output>
    );
  }

  if (!scopeError) {
    return null;
  }

  const addressRequired = scopeDenialCode !== null && SHIPPING_ADDRESS_DENIALS.has(scopeDenialCode);

  return (
    <>
      <section role="alert" className="border-y border-paper-hairline bg-paper-inset px-4 py-3">
        <p className="text-sm leading-5 text-paper-ink">{scopeError}</p>
        {fixError ? <p className="mt-1 text-sm text-paper-muted">That change didn't save. Try again.</p> : null}
        <div className="mt-3 flex flex-wrap gap-2">
          {fix && onApplyFix ? (
            <Button type="button" size="sm" className="rounded-[2px]" onClick={() => onApplyFix(fix)}>
              {QUOTE_REQUEST_FIX_LABELS[fix]}
            </Button>
          ) : null}
          {addressRequired && !organizationId && onOpenSourcingSettings ? (
            <Button type="button" variant="outline" size="sm" className="rounded-[2px]" onClick={onOpenSourcingSettings}>
              <Settings className="mr-2 h-4 w-4" aria-hidden="true" />
              Open Settings to confirm address
            </Button>
          ) : null}
          {onRetryScope && (
            <Button type="button" variant="outline" size="sm" className="rounded-[2px]" onClick={() => void onRetryScope()}>
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
              Check again
            </Button>
          )}
        </div>
      </section>
      {addressRequired && organizationId ? (
        // A successful confirmation re-runs the check, which replaces this panel.
        <QuoteShippingAddressPanel organizationId={organizationId} providerLabel="Supplier" onConfirmed={() => onRetryScope?.()} />
      ) : null}
    </>
  );
}

function SubmissionState({
  isQueued,
  onRetryScope,
  submissionError,
}: Readonly<{
  isQueued: boolean;
  onRetryScope?: () => void | Promise<void>;
  submissionError: string | null;
}>) {
  if (submissionError) {
    return (
      <section role="alert" className="border-y border-destructive/40 bg-destructive/5 px-4 py-3">
        <p className="text-sm text-paper-ink">{submissionError}</p>
        {onRetryScope ? (
          <Button type="button" variant="outline" size="sm" className="mt-3 rounded-[2px]" onClick={() => void onRetryScope()}>
            Check again
          </Button>
        ) : null}
      </section>
    );
  }

  if (!isQueued) {
    return null;
  }

  return (
    <output className="flex gap-3 border-y border-paper-hairline px-4 py-3">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-paper-muted" aria-hidden="true" />
      <span>
        <strong className="block text-sm font-semibold text-paper-ink">Quote request queued</strong>
        <span className="mt-1 block text-sm leading-5 text-paper-muted">The supplier hasn't confirmed receipt yet.</span>
      </span>
    </output>
  );
}

export function XometryBetaDispatchConfirmationDialog({
  declaredModelUnits,
  fanout = null,
  isScopeLoading = false,
  isSubmitting = false,
  onApplyFix,
  onConfirm,
  onDeclaredModelUnitsChange,
  onOpenChange,
  onOpenSourcingSettings,
  onRetryScope,
  open,
  organizationId = null,
  provider = "xometry",
  scope,
  scopeDenialCode = null,
  scopeError = null,
}: Readonly<XometryBetaDispatchConfirmationDialogProps>) {
  // One box carries all three server attestations: authority to share, not
  // export-controlled, and quote only. Ticking it sends each one as true.
  const consentLabel = getConsentLabel(fanout);
  const [consented, setConsented] = useState(false);
  const confirmationInFlight = useRef(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [uncertainAttempt, setUncertainAttempt] = useState<{
    scope: XometryBetaDispatchScope;
    input: XometryBetaDispatchConfirmationInput;
  } | null>(null);
  const [approvalReference, setApprovalReference] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [isQueued, setIsQueued] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const [fixError, setFixError] = useState(false);
  const wasOpenRef = useRef(false);
  const displayedScope = uncertainAttempt?.scope ?? scope;
  const displayedUnits = uncertainAttempt?.input.declaredModelUnits ?? declaredModelUnits;
  const scopeIdentity = useMemo(
    () => getScopeIdentity(displayedScope, displayedUnits, provider),
    [displayedUnits, displayedScope, provider],
  );
  const activeScope = scopeIdentity ? displayedScope : null;
  const effectiveScopeLoading = !uncertainAttempt && isScopeLoading;
  const effectiveScopeError = uncertainAttempt ? null : scopeError;
  const effectiveDenialCode = uncertainAttempt ? null : scopeDenialCode;
  // Until the outcome is known, these controls describe an existing request.
  // Editing them must never discard the reference needed to reconcile it.
  const confirmationControlsLocked = isSubmitting || isConfirming || isQueued || Boolean(uncertainAttempt);
  const canConfirm =
    Boolean(activeScope) &&
    !effectiveScopeLoading &&
    !effectiveScopeError &&
    !isFixing &&
    !isSubmitting &&
    !isConfirming &&
    !isQueued &&
    (Boolean(uncertainAttempt) || consented);

  useEffect(() => {
    if (uncertainAttempt) return;
    setConsented(false);
    setApprovalReference(null);
    // Scope changes revoke fresh consent; only an explicit new flow clears an outcome.
  }, [scopeIdentity, uncertainAttempt]);

  // With several suppliers the consent names them, so a change to the send
  // list (for example a guard refetch) withdraws it.
  const recipientsKey = fanout ? fanout.plan.send.join(",") : provider;
  useEffect(() => {
    if (uncertainAttempt || confirmationInFlight.current) return;
    setConsented(false);
    setApprovalReference(null);
  }, [recipientsKey, uncertainAttempt]);

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;

    if (!justOpened || uncertainAttempt) {
      return;
    }

    setConsented(false);
    setApprovalReference(null);
    setSubmissionError(null);
    setIsQueued(false);
    setFixError(false);
    onDeclaredModelUnitsChange(null);
  }, [onDeclaredModelUnitsChange, open, uncertainAttempt]);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
  };

  const handleModelUnitsChange = (units: XometryBetaDeclaredModelUnits) => {
    if (confirmationInFlight.current || confirmationControlsLocked) return;
    setConsented(false);
    setApprovalReference(null);
    setSubmissionError(null);
    setIsQueued(false);
    setFixError(false);
    onDeclaredModelUnitsChange(units);
  };

  const updateConsent = (checked: boolean) => {
    if (confirmationInFlight.current || confirmationControlsLocked) {
      return;
    }

    setSubmissionError(null);
    setConsented(checked);
    if (!checked) {
      setApprovalReference(null);
    }
  };

  const retryScope = () => {
    if (!uncertainAttempt) setSubmissionError(null);
    setFixError(false);
    return onRetryScope?.();
  };

  // OVD-1163: apply the fix, then re-run the check without leaving the popup.
  const applyFix = async (fix: QuoteRequestFix) => {
    if (!onApplyFix || isFixing || confirmationControlsLocked) return;
    setIsFixing(true);
    setFixError(false);
    try {
      await onApplyFix(fix);
    } catch {
      setFixError(true);
      setIsFixing(false);
      return;
    }
    try {
      await onRetryScope?.();
    } finally {
      setIsFixing(false);
    }
  };

  const confirm = async () => {
    if (confirmationInFlight.current || !activeScope || !displayedUnits || !canConfirm) {
      return;
    }

    confirmationInFlight.current = true;
    setIsConfirming(true);
    const nextApprovalReference = uncertainAttempt?.input.approvalReference ?? approvalReference ?? createApprovalReference();
    setApprovalReference(nextApprovalReference);
    setSubmissionError(null);

    // The policy revision and scope fingerprint bind the consent to this exact
    // server scope; they are sent, never shown.
    const attemptedInput: XometryBetaDispatchConfirmationInput = uncertainAttempt?.input ?? {
        approvalReference: nextApprovalReference,
        authorityToShare: true,
        declaredModelUnits: displayedUnits,
        envelopeRevision: activeScope.envelopeRevision,
        nonExportControlled: true,
        policyRevision: activeScope.policyRevision,
        quoteOnly: true,
        scopeFingerprint: activeScope.scopeFingerprint,
      };
    try {
      const result = await onConfirm(attemptedInput);
      if (result?.status === "unknown") {
        setUncertainAttempt({ scope: activeScope, input: attemptedInput });
        setSubmissionError(
          `We could not confirm whether the request was queued. Try again; it won't be sent twice. Diagnostic: ${result.diagnosticCode ?? "unknown_failure"}.`,
        );
        return;
      }

      setUncertainAttempt(null);
      if (!result?.accepted) {
        setConsented(false);
        setApprovalReference(null);
        setSubmissionError("The request was not sent. We checked the part again; review it and try again.");
        void onRetryScope?.();
        return;
      }

      setIsQueued(true);
    } catch {
      setUncertainAttempt({ scope: activeScope, input: attemptedInput });
      setSubmissionError(
        "We could not confirm whether the request was queued. Try again; it won't be sent twice. Diagnostic: unknown_failure.",
      );
    } finally {
      confirmationInFlight.current = false;
      setIsConfirming(false);
    }
  };

  const requirements = activeScope?.scope.requirements;
  const quotedAsMachined = isQuotedAsMachined(requirements?.finish, requirements?.specification);
  const showFanout = Boolean(fanout && activeScope && fanout.plan.send.length > 1);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-md overflow-y-auto border-paper-hairline bg-paper-surface p-0 text-paper-ink sm:rounded-[4px]">
        <DialogHeader className="px-5 pb-0 pt-5 text-left">
          <DialogTitle className="font-display text-xl font-bold tracking-[-0.02em]">Request a quote</DialogTitle>
          <DialogDescription className="text-sm text-paper-ink">What units is this CAD model in?</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 px-5 py-4">
          <div className="grid grid-cols-2 gap-2" role="group" aria-label="CAD model units">
            {([
              ["inch", "Inches"],
              ["millimeter", "Millimeters"],
            ] as const).map(([units, label]) => (
              <Button
                key={units}
                type="button"
                variant="outline"
                aria-pressed={displayedUnits === units}
                className={cn(
                  "rounded-[2px] border-paper-hairline bg-transparent",
                  displayedUnits === units && "border-paper-red bg-paper-inset text-paper-ink",
                )}
                disabled={confirmationControlsLocked}
                onClick={() => handleModelUnitsChange(units)}
              >
                {label}
              </Button>
            ))}
          </div>

          <ScopeLoadState
            declaredModelUnits={displayedUnits}
            fix={getQuoteRequestFix(effectiveDenialCode)}
            fixError={fixError}
            isFixing={isFixing}
            isScopeLoading={effectiveScopeLoading}
            onApplyFix={onApplyFix ? (fix) => void applyFix(fix) : undefined}
            onOpenSourcingSettings={onOpenSourcingSettings}
            onRetryScope={retryScope}
            organizationId={organizationId}
            scopeDenialCode={effectiveDenialCode}
            scopeError={effectiveScopeError}
          />

          {activeScope && !effectiveScopeLoading && !effectiveScopeError && !isFixing ? (
            <>
              {quotedAsMachined ? (
                <p className="text-sm text-paper-muted">Quoting as machined. The price won't include the finish.</p>
              ) : null}
              {showFanout && fanout ? <ProviderFanoutStatus plan={fanout.plan} outcomes={fanout.outcomes} /> : null}
              <label className="flex cursor-pointer gap-3 text-sm leading-5 has-[:disabled]:cursor-default has-[:disabled]:opacity-65">
                <Checkbox
                  checked={Boolean(uncertainAttempt) || consented}
                  disabled={confirmationControlsLocked}
                  aria-label={consentLabel}
                  onCheckedChange={(checked) => updateConsent(checked === true)}
                />
                <span>{consentLabel}</span>
              </label>
            </>
          ) : null}

          <SubmissionState isQueued={isQueued} onRetryScope={retryScope} submissionError={submissionError} />
        </div>

        <DialogFooter className="gap-2 border-t border-paper-hairline px-5 py-3">
          <Button type="button" variant="outline" className="rounded-[2px]" disabled={isSubmitting} onClick={() => handleOpenChange(false)}>
            Close
          </Button>
          <Button type="button" className="rounded-[2px]" disabled={!canConfirm} onClick={() => void confirm()}>
            {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Send quote request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Provider-neutral name for the confirmation dialog (OVD-673). */
export const ProviderDispatchConfirmationDialog = XometryBetaDispatchConfirmationDialog;
