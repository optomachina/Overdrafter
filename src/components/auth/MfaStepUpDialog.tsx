import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  beginTotpEnrollment,
  listTotpFactors,
  unenrollTotpFactor,
  verifyTotpCode,
  type TotpEnrollment,
  type TotpFactor,
} from "@/features/auth/mfa-api";

type MfaStepUpDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onVerified: () => Promise<void> | void;
  title?: string;
  description?: string;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Authenticator verification failed.";
}

function FactorState({
  isLoading,
  isError,
  error,
  isFetching,
  verifiedFactor,
  enrollment,
  isPending,
  onRetry,
  onEnroll,
}: Readonly<{
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  verifiedFactor: TotpFactor | undefined;
  enrollment: TotpEnrollment | null;
  isPending: boolean;
  onRetry: () => void;
  onEnroll: () => void;
}>) {
  if (isLoading) {
    return (
      <div className="flex min-h-36 items-center justify-center">
        <Loader2
          className="h-5 w-5 animate-spin text-primary"
          aria-label="Loading authenticator factors"
        />
      </div>
    );
  }

  if (isError) {
    return (
      <div
        className="rounded-2xl border border-destructive/30 bg-destructive/10 p-5"
        role="alert"
      >
        <p className="font-medium text-destructive">
          Authenticator factors could not be loaded
        </p>
        <p className="mt-2 text-sm text-destructive">
          {getErrorMessage(error)}
        </p>
        <Button
          type="button"
          variant="outline"
          className="mt-4"
          onClick={onRetry}
          disabled={isFetching}
        >
          {isFetching ? "Retrying…" : "Retry"}
        </Button>
      </div>
    );
  }

  if (verifiedFactor) {
    return (
      <div className="rounded-2xl border border-border bg-accent p-4">
        <p className="flex items-center gap-2 font-medium">
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          {verifiedFactor.friendlyName}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Enter the current six-digit code from this authenticator.
        </p>
      </div>
    );
  }

  if (enrollment) {
    return (
      <div className="space-y-4">
        <div className="rounded-2xl border border-border bg-white p-4 text-center">
          <img
            src={enrollment.qrCode}
            alt="Authenticator enrollment QR code"
            className="mx-auto h-48 w-48"
          />
        </div>
        <div className="rounded-2xl border border-border bg-accent p-4">
          <p className="text-sm font-medium">Can’t scan the code?</p>
          <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
            {enrollment.secret}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border bg-accent p-5">
      <p className="font-medium">Set up an authenticator app</p>
      <p className="mt-2 text-sm text-muted-foreground">
        No verified TOTP factor is available. Set one up before changing
        customer access.
      </p>
      <Button
        type="button"
        className="mt-4"
        onClick={onEnroll}
        disabled={isPending}
      >
        Set up authenticator
      </Button>
    </div>
  );
}

export function MfaStepUpDialog({
  open,
  onOpenChange,
  onVerified,
  title = "Verify this commercial change",
  description = "Trial, complimentary, and revocation changes require an authenticator-app code. Your account remains the actor; this does not switch or impersonate a customer.",
}: Readonly<MfaStepUpDialogProps>) {
  const [code, setCode] = useState("");
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const factorsQuery = useQuery({
    queryKey: ["commercial-admin-totp-factors"],
    queryFn: listTotpFactors,
    enabled: open,
  });
  const verifiedFactor = useMemo(
    () => factorsQuery.data?.find((factor) => factor.status === "verified"),
    [factorsQuery.data],
  );
  const enrollmentMutation = useMutation({
    mutationFn: beginTotpEnrollment,
    onSuccess: setEnrollment,
  });
  const verificationMutation = useMutation({
    mutationFn: verifyTotpCode,
    onSuccess: async () => {
      setEnrollment(null);
      await onVerified();
      onOpenChange(false);
    },
  });
  const cleanupMutation = useMutation({
    mutationFn: unenrollTotpFactor,
  });
  const resetEnrollment = enrollmentMutation.reset;
  const resetVerification = verificationMutation.reset;
  const resetCleanup = cleanupMutation.reset;
  const wasOpen = useRef(open);

  useEffect(() => {
    if (wasOpen.current && !open) {
      setCode("");
      setEnrollment(null);
      resetEnrollment();
      resetVerification();
      resetCleanup();
    }

    wasOpen.current = open;
  }, [open, resetCleanup, resetEnrollment, resetVerification]);

  const factorId = verifiedFactor?.id ?? enrollment?.factorId ?? null;
  const isPending =
    enrollmentMutation.isPending
    || verificationMutation.isPending
    || cleanupMutation.isPending;
  const error =
    cleanupMutation.error
    ?? verificationMutation.error
    ?? enrollmentMutation.error;
  const requestClose = async () => {
    if (isPending) {
      return;
    }

    if (enrollment) {
      try {
        await cleanupMutation.mutateAsync(enrollment.factorId);
        setEnrollment(null);
      } catch {
        return;
      }
    }

    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          onOpenChange(true);
          return;
        }

        void requestClose();
      }}
    >
      <DialogContent className="border-border bg-ws-overlay text-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <FactorState
          isLoading={factorsQuery.isLoading}
          isError={factorsQuery.isError}
          error={factorsQuery.error}
          isFetching={factorsQuery.isFetching}
          verifiedFactor={verifiedFactor}
          enrollment={enrollment}
          isPending={isPending}
          onRetry={() => void factorsQuery.refetch()}
          onEnroll={() => enrollmentMutation.mutate()}
        />

        {factorId ? (
          <div className="space-y-2">
            <Label htmlFor="commercial-admin-totp-code">
              Authenticator code
            </Label>
            <Input
              id="commercial-admin-totp-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={8}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="123456"
              disabled={isPending}
            />
          </div>
        ) : null}

        {error ? (
          <p className="text-sm text-destructive" role="alert">
            {getErrorMessage(error)}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => void requestClose()}
            disabled={isPending}
          >
            {cleanupMutation.isPending ? "Cleaning up…" : "Cancel"}
          </Button>
          {factorId ? (
            <Button
              type="button"
              onClick={() => verificationMutation.mutate({ factorId, code })}
              disabled={isPending || code.trim().length < 6}
            >
              {verificationMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Verify
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
