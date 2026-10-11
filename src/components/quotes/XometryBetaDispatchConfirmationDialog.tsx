import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, FileText, Loader2, RefreshCw, Settings, ShieldCheck } from "lucide-react";
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
import type {
  XometryBetaDispatchDiagnosticCode,
  XometryBetaDispatchScope,
  XometryBetaModelUnits,
  XometryBetaScopeDenialCode,
} from "@/features/quotes/xometry-beta-dispatch";
export type { XometryBetaDispatchScope } from "@/features/quotes/xometry-beta-dispatch";

export type XometryBetaDeclaredModelUnits = XometryBetaModelUnits;

export type XometryBetaDispatchConfirmationInput = {
  approvalReference: string;
  authorityToShare: true;
  declaredModelUnits: XometryBetaDeclaredModelUnits;
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
  isScopeLoading?: boolean;
  isSubmitting?: boolean;
  onConfirm: (
    input: XometryBetaDispatchConfirmationInput,
  ) => Promise<XometryBetaDispatchConfirmationResult | null>;
  onDeclaredModelUnitsChange: (units: XometryBetaDeclaredModelUnits | null) => void;
  onOpenChange: (open: boolean) => void;
  /** Shown when the scope denial is a missing confirmed shipping address. */
  onOpenSourcingSettings?: () => void;
  onRetryScope?: () => void | Promise<void>;
  open: boolean;
  scope: XometryBetaDispatchScope | null;
  scopeDenialCode?: XometryBetaScopeDenialCode | null;
  scopeError?: string | null;
};

type Affirmations = {
  authorityToShare: boolean;
  nonExportControlled: boolean;
  quoteOnly: boolean;
};

const EMPTY_AFFIRMATIONS: Affirmations = {
  authorityToShare: false,
  nonExportControlled: false,
  quoteOnly: false,
};

function formatFileSize(sizeBytes: number | null | undefined) {
  if (sizeBytes === null || sizeBytes === undefined) {
    return null;
  }

  if (sizeBytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatValue(value: string | number | null | undefined, fallback = "Not specified") {
  if (typeof value === "string") {
    return value.trim() || fallback;
  }

  return value === null || value === undefined ? fallback : String(value);
}

function getSpecificationValue(
  specification: Record<string, unknown> | null | undefined,
  key: string,
) {
  const value = specification?.[key];
  return typeof value === "string" ? value : null;
}

function getScopeIdentity(
  scope: XometryBetaDispatchScope | null,
  declaredModelUnits: XometryBetaDeclaredModelUnits | null,
) {
  if (!scope || !declaredModelUnits || scope.declaredModelUnits !== declaredModelUnits) {
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

function createApprovalReference() {
  return globalThis.crypto.randomUUID();
}

function DisclosureFile({
  label,
  file,
}: Readonly<{
  label: "CAD" | "Drawing";
  file: XometryBetaDispatchScope["scope"]["part"]["cad"] | null;
}>) {
  if (!file) {
    return (
      <div className="border-b border-paper-hairline py-3 text-sm text-paper-muted">
        No {label.toLowerCase()} file is included in this Xometry scope.
      </div>
    );
  }

  return (
    <div className="border-b border-paper-hairline py-3">
      <div className="flex items-start gap-3">
        <FileText className="mt-0.5 h-4 w-4 shrink-0 text-paper-muted" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-paper-ink">{file.name}</p>
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-paper-muted">
            {label}{file.mimeType ? ` · ${file.mimeType}` : ""}{file.sizeBytes ? ` · ${formatFileSize(file.sizeBytes)}` : ""}
          </p>
          <dl className="mt-3 space-y-1 font-mono text-[11px] leading-5 text-paper-muted">
            <div>
              <dt className="inline">File ID: </dt>
              <dd className="inline break-all text-paper-ink">{file.fileId}</dd>
            </div>
            <div>
              <dt className="inline">SHA-256: </dt>
              <dd className="inline break-all text-paper-ink">{file.sha256}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}

function ScopeDetail({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div className="border-b border-paper-hairline py-3 sm:pr-5">
      <dt className="text-[11px] text-paper-muted">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-paper-ink">{value}</dd>
    </div>
  );
}

function ScopeLoadState({
  declaredModelUnits,
  isScopeLoading,
  onOpenSourcingSettings,
  onRetryScope,
  scopeDenialCode,
  scopeError,
}: Readonly<{
  declaredModelUnits: XometryBetaDeclaredModelUnits | null;
  isScopeLoading: boolean;
  onOpenSourcingSettings?: () => void;
  onRetryScope?: () => void | Promise<void>;
  scopeDenialCode: XometryBetaScopeDenialCode | null;
  scopeError: string | null;
}>) {
  if (!declaredModelUnits) {
    return (
      <output className="block border-y border-paper-hairline bg-paper-inset px-4 py-3 text-sm text-paper-muted">
        Select the CAD model units to load the current Xometry disclosure scope.
      </output>
    );
  }

  if (isScopeLoading) {
    return (
      <output className="flex min-h-28 items-center justify-center gap-3 text-sm text-paper-muted">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Verifying the current Xometry disclosure scope…
      </output>
    );
  }

  if (!scopeError) {
    return null;
  }

  return (
    <section role="alert" className="border-y border-destructive/40 bg-destructive/5 px-4 py-3">
      <p className="text-sm font-semibold text-paper-ink">This package is not ready for controlled Xometry beta dispatch.</p>
      <p className="mt-1 text-sm leading-5 text-paper-muted">{scopeError}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {scopeDenialCode === "xometry_beta_confirmed_sourcing_address_required" && onOpenSourcingSettings ? (
          <Button type="button" variant="outline" size="sm" className="rounded-[2px]" onClick={onOpenSourcingSettings}>
            <Settings className="mr-2 h-4 w-4" aria-hidden="true" />
            Open Settings to confirm address
          </Button>
        ) : null}
        {onRetryScope && (
          <Button type="button" variant="outline" size="sm" className="rounded-[2px]" onClick={() => void onRetryScope()}>
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
            Retry scope check
          </Button>
        )}
      </div>
    </section>
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
            Refresh current scope
          </Button>
        ) : null}
      </section>
    );
  }

  if (!isQueued) {
    return null;
  }

  return (
    <output className="flex gap-3 border-y border-emerald-500/30 bg-emerald-500/5 px-4 py-3">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" />
      <span>
        <strong className="block text-sm font-semibold text-paper-ink">Xometry quote request queued</strong>
        <span className="mt-1 block text-sm leading-5 text-paper-muted">
          The exact confirmed scope is queued for dispatch. Xometry has not yet been confirmed as having received the package.
        </span>
      </span>
    </output>
  );
}

export function XometryBetaDispatchConfirmationDialog({
  declaredModelUnits,
  isScopeLoading = false,
  isSubmitting = false,
  onConfirm,
  onDeclaredModelUnitsChange,
  onOpenChange,
  onOpenSourcingSettings,
  onRetryScope,
  open,
  scope,
  scopeDenialCode = null,
  scopeError = null,
}: Readonly<XometryBetaDispatchConfirmationDialogProps>) {
  const [affirmations, setAffirmations] = useState<Affirmations>(EMPTY_AFFIRMATIONS);
  const confirmationInFlight = useRef(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [uncertainAttempt, setUncertainAttempt] = useState<{
    scope: XometryBetaDispatchScope;
    input: XometryBetaDispatchConfirmationInput;
  } | null>(null);
  const [approvalReference, setApprovalReference] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [isQueued, setIsQueued] = useState(false);
  const wasOpenRef = useRef(false);
  const displayedScope = uncertainAttempt?.scope ?? scope;
  const displayedUnits = uncertainAttempt?.input.declaredModelUnits ?? declaredModelUnits;
  const scopeIdentity = useMemo(
    () => getScopeIdentity(displayedScope, displayedUnits),
    [displayedUnits, displayedScope],
  );
  const activeScope = scopeIdentity ? displayedScope : null;
  const effectiveScopeLoading = !uncertainAttempt && isScopeLoading;
  const effectiveScopeError = uncertainAttempt ? null : scopeError;
  // Until the outcome is known, these controls describe an existing request.
  // Editing them must never discard the reference needed to reconcile it.
  const confirmationControlsLocked = isSubmitting || isConfirming || isQueued || Boolean(uncertainAttempt);
  const hasAllAffirmations =
    affirmations.authorityToShare &&
    affirmations.nonExportControlled &&
    affirmations.quoteOnly;
  const canConfirm =
    Boolean(activeScope) &&
    !effectiveScopeLoading &&
    !effectiveScopeError &&
    !isSubmitting &&
    !isConfirming &&
    !isQueued &&
    (Boolean(uncertainAttempt) || hasAllAffirmations);

  useEffect(() => {
    if (uncertainAttempt) return;
    setAffirmations(EMPTY_AFFIRMATIONS);
    setApprovalReference(null);
    // Scope changes revoke fresh consent; only an explicit new flow clears an outcome.
  }, [scopeIdentity, uncertainAttempt]);

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;

    if (!justOpened || uncertainAttempt) {
      return;
    }

    setAffirmations(EMPTY_AFFIRMATIONS);
    setApprovalReference(null);
    setSubmissionError(null);
    setIsQueued(false);
    onDeclaredModelUnitsChange(null);
  }, [onDeclaredModelUnitsChange, open, uncertainAttempt]);

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
  };

  const handleModelUnitsChange = (units: XometryBetaDeclaredModelUnits) => {
    if (confirmationInFlight.current || confirmationControlsLocked) return;
    setAffirmations(EMPTY_AFFIRMATIONS);
    setApprovalReference(null);
    setSubmissionError(null);
    setIsQueued(false);
    onDeclaredModelUnitsChange(units);
  };

  const updateAffirmation = (key: keyof Affirmations, checked: boolean) => {
    if (confirmationInFlight.current || confirmationControlsLocked) {
      return;
    }

    setSubmissionError(null);
    setAffirmations((current) => ({ ...current, [key]: checked }));
    if (!checked) {
      setApprovalReference(null);
    }
  };

  const retryScope = () => {
    if (!uncertainAttempt) setSubmissionError(null);
    return onRetryScope?.();
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

    const attemptedInput: XometryBetaDispatchConfirmationInput = uncertainAttempt?.input ?? {
        approvalReference: nextApprovalReference,
        authorityToShare: true,
        declaredModelUnits: displayedUnits,
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
          `We could not confirm whether the request was queued. Retry with the same approval reference to check safely; do not create a new confirmation. Diagnostic: ${result.diagnosticCode ?? "unknown_failure"}.`,
        );
        return;
      }

      setUncertainAttempt(null);
      if (!result?.accepted) {
        setAffirmations(EMPTY_AFFIRMATIONS);
        setApprovalReference(null);
        setSubmissionError(
          "The current package was not queued. We refreshed its authoritative state; review it and try again.",
        );
        void onRetryScope?.();
        return;
      }

      setIsQueued(true);
    } catch {
      setUncertainAttempt({ scope: activeScope, input: attemptedInput });
      setSubmissionError(
        "We could not confirm whether the request was queued. Retry with the same approval reference to check safely; do not create a new confirmation. Diagnostic: unknown_failure.",
      );
    } finally {
      confirmationInFlight.current = false;
      setIsConfirming(false);
    }
  };

  const requirements = activeScope?.scope.requirements;
  const specification = requirements?.specification;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] w-[calc(100vw-2rem)] max-w-2xl overflow-y-auto border-paper-hairline bg-paper-surface p-0 text-paper-ink sm:rounded-[4px]">
        <DialogHeader className="border-b border-paper-hairline px-5 pb-5 pt-6 text-left sm:px-7">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper-red">
            Founding Beta · Xometry
          </p>
          <DialogTitle className="font-display text-2xl font-bold tracking-[-0.035em]">
            Confirm Xometry beta quote request
          </DialogTitle>
          <DialogDescription className="max-w-xl text-sm leading-6 text-paper-muted">
            Review the exact package OverDrafter will queue for Xometry. This creates a quote request only—no card charge, order, purchase order, or supplier commitment.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 px-5 py-5 sm:px-7">
          <section aria-labelledby="model-units-heading">
            <h3 id="model-units-heading" className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper-muted">
              CAD model units
            </h3>
            <p className="mt-2 text-sm leading-5 text-paper-muted">
              Choose the units used by this CAD model. This declaration is part of the confirmed Xometry scope.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
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
                    "justify-start rounded-[2px] border-paper-hairline bg-transparent",
                    displayedUnits === units && "border-paper-red bg-paper-inset text-paper-ink",
                  )}
                  disabled={confirmationControlsLocked}
                  onClick={() => handleModelUnitsChange(units)}
                >
                  {label}
                </Button>
              ))}
            </div>
          </section>

          <ScopeLoadState
            declaredModelUnits={displayedUnits}
            isScopeLoading={effectiveScopeLoading}
            onOpenSourcingSettings={onOpenSourcingSettings}
            onRetryScope={retryScope}
            scopeDenialCode={uncertainAttempt ? null : scopeDenialCode}
            scopeError={effectiveScopeError}
          />

          {activeScope && !effectiveScopeLoading && !effectiveScopeError ? (
            <>
              <section aria-labelledby="dispatch-scope-heading">
                <h3 id="dispatch-scope-heading" className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper-muted">
                  Exact disclosure scope
                </h3>
                <dl className="mt-2 grid border-y border-paper-hairline sm:grid-cols-2">
                  <ScopeDetail label="Provider" value="Xometry" />
                  <ScopeDetail label="Quote quantity" value={`${activeScope.requestedQuantity} part${activeScope.requestedQuantity === 1 ? "" : "s"}`} />
                  <ScopeDetail label="Confirmed shipping destination" value={`${activeScope.scope.destination.street}, ${activeScope.scope.destination.city}, ${[activeScope.scope.destination.region, activeScope.scope.destination.postalCode].filter(Boolean).join(" ")}, ${activeScope.scope.destination.country}`} />
                  <ScopeDetail label="Policy revision" value={activeScope.policyRevision} />
                  <ScopeDetail label="Envelope revision" value={activeScope.envelopeRevision} />
                  <div className="border-b border-paper-hairline py-3 sm:col-span-2">
                    <dt className="text-[11px] text-paper-muted">Scope fingerprint</dt>
                    <dd className="mt-1 break-all font-mono text-xs text-paper-ink">{activeScope.scopeFingerprint}</dd>
                  </div>
                </dl>
              </section>

              <section aria-labelledby="disclosure-files-heading">
                <h3 id="disclosure-files-heading" className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper-muted">
                  Files to be shared
                </h3>
                <div className="mt-2 border-t border-paper-hairline">
                  <DisclosureFile label="CAD" file={activeScope.scope.part.cad} />
                  <DisclosureFile label="Drawing" file={activeScope.scope.part.drawing} />
                </div>
              </section>

              <section aria-labelledby="normalized-requirements-heading">
                <h3 id="normalized-requirements-heading" className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper-muted">
                  Normalized manufacturing requirements
                </h3>
                <dl className="mt-2 grid border-y border-paper-hairline sm:grid-cols-2">
                  <ScopeDetail label="Part number" value={formatValue(requirements?.partNumber)} />
                  <ScopeDetail label="Revision" value={formatValue(requirements?.revision)} />
                  <ScopeDetail label="Description" value={formatValue(requirements?.description)} />
                  <ScopeDetail label="Process" value={formatValue(getSpecificationValue(specification, "process"))} />
                  <ScopeDetail label="Material" value={formatValue(requirements?.material)} />
                  <ScopeDetail label="Finish" value={formatValue(requirements?.finish, "As machined")} />
                  <ScopeDetail
                    label="Tightest tolerance"
                    value={
                      requirements?.tightestToleranceInch === null || requirements?.tightestToleranceInch === undefined
                        ? "Not specified"
                        : `±${requirements.tightestToleranceInch} in`
                    }
                  />
                  <ScopeDetail label="Requested quantity" value={`${activeScope.requestedQuantity}`} />
                </dl>
              </section>

              <section aria-labelledby="dispatch-affirmations-heading">
                <h3 id="dispatch-affirmations-heading" className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper-muted">
                  Your affirmations
                </h3>
                <div className="mt-2 divide-y divide-paper-hairline border-y border-paper-hairline">
                  <label className="flex cursor-pointer gap-3 py-4 text-sm leading-5 has-[:disabled]:cursor-default has-[:disabled]:opacity-65">
                    <Checkbox
                      checked={Boolean(uncertainAttempt) || affirmations.authorityToShare}
                      disabled={confirmationControlsLocked}
                      aria-label="I am authorized to share these files and requirements with Xometry to request a quote."
                      onCheckedChange={(checked) => updateAffirmation("authorityToShare", checked === true)}
                    />
                    <span>I am authorized to share these files and requirements with Xometry to request a quote.</span>
                  </label>
                  <label className="flex cursor-pointer gap-3 py-4 text-sm leading-5 has-[:disabled]:cursor-default has-[:disabled]:opacity-65">
                    <Checkbox
                      checked={Boolean(uncertainAttempt) || affirmations.nonExportControlled}
                      disabled={confirmationControlsLocked}
                      aria-label="I confirm this package is not ITAR, CUI, export-controlled, or otherwise restricted from this beta workflow."
                      onCheckedChange={(checked) => updateAffirmation("nonExportControlled", checked === true)}
                    />
                    <span>I confirm this package is not ITAR, CUI, export-controlled, or otherwise restricted from this beta workflow.</span>
                  </label>
                  <label className="flex cursor-pointer gap-3 py-4 text-sm leading-5 has-[:disabled]:cursor-default has-[:disabled]:opacity-65">
                    <Checkbox
                      checked={Boolean(uncertainAttempt) || affirmations.quoteOnly}
                      disabled={confirmationControlsLocked}
                      aria-label="I understand this is quote-only: it creates no card charge, order, purchase order, or supplier commitment."
                      onCheckedChange={(checked) => updateAffirmation("quoteOnly", checked === true)}
                    />
                    <span>I understand this is quote-only: it creates no card charge, order, purchase order, or supplier commitment.</span>
                  </label>
                </div>
              </section>
            </>
          ) : null}

          <SubmissionState
            isQueued={isQueued}
            onRetryScope={retryScope}
            submissionError={submissionError}
          />
        </div>

        <DialogFooter className="gap-2 border-t border-paper-hairline bg-paper-inset px-5 py-4 sm:px-7">
          <Button type="button" variant="outline" className="rounded-[2px]" disabled={isSubmitting} onClick={() => handleOpenChange(false)}>
            Close
          </Button>
          <Button type="button" className="rounded-[2px]" disabled={!canConfirm} onClick={() => void confirm()}>
            {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" />}
            Confirm & queue Xometry quote
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
