import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { MfaStepUpDialog } from "@/components/auth/MfaStepUpDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  fetchFoundingBetaEnrollment,
  setFoundingBetaEnrollment,
} from "@/features/quotes/api/founding-beta-admin-api";
import type { FoundingBetaEnrollment } from "@/features/quotes/api/founding-beta-admin-api";
import type { AdminOrganizationSummary } from "@/features/quotes/api/platform-admin-api";

type FoundingBetaEnrollmentCardProps = {
  organizations: readonly AdminOrganizationSummary[];
  isOrganizationsLoading: boolean;
  organizationsError: unknown;
  onRetryOrganizations: () => void;
};

type PendingIntent = {
  organizationId: string;
  enrolled: boolean;
  reason: string;
  idempotencyKey: string;
};

type EnrollmentContentProps = {
  organizations: readonly AdminOrganizationSummary[];
  isOrganizationsLoading: boolean;
  organizationsError: unknown;
  onRetryOrganizations: () => void;
  effectiveOrganizationId: string;
  selectedOrganizationName: string | undefined;
  onOrganizationChange: (organizationId: string) => void;
  currentState: FoundingBetaEnrollment | undefined;
  isEnrollmentLoading: boolean;
  enrollmentError: unknown;
  isEnrollmentFetching: boolean;
  onRetryEnrollment: () => void;
  reason: string;
  onReasonChange: (reason: string) => void;
  onBeginChange: (enrolled: boolean) => void;
  isMutationPending: boolean;
  isMfaOpen: boolean;
};

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    typeof error === "object"
    && error !== null
    && "message" in error
    && typeof error.message === "string"
  ) {
    return error.message;
  }

  return "Founding Beta enrollment is unavailable.";
}

function formatEventTime(
  action: FoundingBetaEnrollment["latestAction"],
  value: string | null,
): string {
  if (!action || !value) {
    return "No enrollment event recorded";
  }

  const actionLabel = action === "grant" ? "Granted" : "Revoked";
  return `${actionLabel} ${new Date(value).toLocaleString()}`;
}

function getStateLabel(currentState: FoundingBetaEnrollment): string {
  if (currentState.enrolled) {
    return "Enrolled";
  }

  if (currentState.latestAction === "revoke") {
    return "Revoked";
  }

  return "Not enrolled";
}

function LoadingState({ label }: Readonly<{ label: string }>) {
  return (
    <div className="flex min-h-24 items-center justify-center">
      <Loader2 className="h-5 w-5 animate-spin text-primary" aria-label={label} />
    </div>
  );
}

function ErrorState({
  title,
  error,
  onRetry,
  isRetrying = false,
}: Readonly<{
  title: string;
  error: unknown;
  onRetry: () => void;
  isRetrying?: boolean;
}>) {
  return (
    <div
      className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4"
      role="alert"
    >
      <p className="font-medium text-destructive">{title}</p>
      <p className="mt-2 text-sm text-destructive">{getErrorMessage(error)}</p>
      <Button
        type="button"
        variant="outline"
        className="mt-4"
        onClick={onRetry}
        disabled={isRetrying}
      >
        Retry
      </Button>
    </div>
  );
}

function EnrollmentStatePanel({
  currentState,
  selectedOrganizationName,
  isLoading,
  error,
  isFetching,
  onRetry,
}: Readonly<{
  currentState: FoundingBetaEnrollment | undefined;
  selectedOrganizationName: string | undefined;
  isLoading: boolean;
  error: unknown;
  isFetching: boolean;
  onRetry: () => void;
}>) {
  if (isLoading) {
    return <LoadingState label="Loading Founding Beta enrollment" />;
  }

  if (error) {
    return (
      <ErrorState
        title="Enrollment state unavailable"
        error={error}
        onRetry={onRetry}
        isRetrying={isFetching}
      />
    );
  }

  if (!currentState) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-border bg-accent p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">{selectedOrganizationName}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Policy {currentState.policyRevision}
          </p>
        </div>
        <Badge variant={currentState.enrolled ? "default" : "outline"}>
          {getStateLabel(currentState)}
        </Badge>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {formatEventTime(currentState.latestAction, currentState.latestEventAt)}
      </p>
    </div>
  );
}

function EnrollmentContent({
  organizations,
  isOrganizationsLoading,
  organizationsError,
  onRetryOrganizations,
  effectiveOrganizationId,
  selectedOrganizationName,
  onOrganizationChange,
  currentState,
  isEnrollmentLoading,
  enrollmentError,
  isEnrollmentFetching,
  onRetryEnrollment,
  reason,
  onReasonChange,
  onBeginChange,
  isMutationPending,
  isMfaOpen,
}: Readonly<EnrollmentContentProps>) {
  if (isOrganizationsLoading) {
    return <LoadingState label="Loading organizations for Founding Beta" />;
  }

  if (organizationsError) {
    return (
      <ErrorState
        title="Organization list unavailable"
        error={organizationsError}
        onRetry={onRetryOrganizations}
      />
    );
  }

  if (organizations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No organizations are available for enrollment.
      </p>
    );
  }

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="founding-beta-organization">Organization</Label>
        <Select
          value={effectiveOrganizationId}
          onValueChange={onOrganizationChange}
          disabled={isMutationPending || isMfaOpen}
        >
          <SelectTrigger id="founding-beta-organization">
            <SelectValue placeholder="Select an organization" />
          </SelectTrigger>
          <SelectContent>
            {organizations.map((organization) => (
              <SelectItem key={organization.id} value={organization.id}>
                {organization.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <EnrollmentStatePanel
        currentState={currentState}
        selectedOrganizationName={selectedOrganizationName}
        isLoading={isEnrollmentLoading}
        error={enrollmentError}
        isFetching={isEnrollmentFetching}
        onRetry={onRetryEnrollment}
      />

      <div className="space-y-2">
        <Label htmlFor="founding-beta-reason">Reason</Label>
        <Textarea
          id="founding-beta-reason"
          value={reason}
          onChange={(event) => onReasonChange(event.target.value)}
          placeholder="Why this organization is being enrolled or revoked"
          maxLength={1000}
          disabled={isMutationPending || Boolean(enrollmentError) || isMfaOpen}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <Button
          type="button"
          onClick={() => onBeginChange(true)}
          disabled={
            isEnrollmentLoading
            || Boolean(enrollmentError)
            || currentState?.enrolled === true
            || isMutationPending
            || isMfaOpen
          }
        >
          Grant enrollment
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() => onBeginChange(false)}
          disabled={
            isEnrollmentLoading
            || Boolean(enrollmentError)
            || currentState?.enrolled !== true
            || isMutationPending
            || isMfaOpen
          }
        >
          Revoke enrollment
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        Every change requires an authenticator code and a non-empty reason.
        Revocation stops new drafts and uploads but preserves access to existing work.
      </p>
    </>
  );
}

export function FoundingBetaEnrollmentCard({
  organizations,
  isOrganizationsLoading,
  organizationsError,
  onRetryOrganizations,
}: Readonly<FoundingBetaEnrollmentCardProps>) {
  const queryClient = useQueryClient();
  const [selectedOrganizationId, setSelectedOrganizationId] = useState("");
  const [reason, setReason] = useState("");
  const [pendingIntent, setPendingIntent] = useState<PendingIntent | null>(null);
  const [isMfaOpen, setIsMfaOpen] = useState(false);
  useEffect(() => {
    const selectionStillExists = organizations.some(
      (organization) => organization.id === selectedOrganizationId,
    );

    if (selectionStillExists || isOrganizationsLoading || organizationsError) {
      return;
    }

    setSelectedOrganizationId(organizations[0]?.id ?? "");
    setReason("");
    setPendingIntent(null);
    setIsMfaOpen(false);
  }, [
    isOrganizationsLoading,
    organizations,
    organizationsError,
    selectedOrganizationId,
  ]);
  const effectiveOrganizationId = selectedOrganizationId;
  const selectedOrganization = organizations.find(
    (organization) => organization.id === effectiveOrganizationId,
  );
  const queryKey = ["admin", "founding-beta-enrollment", effectiveOrganizationId] as const;
  const enrollmentQuery = useQuery({
    queryKey,
    queryFn: () => fetchFoundingBetaEnrollment(effectiveOrganizationId),
    enabled: effectiveOrganizationId.length > 0,
  });
  const enrollmentMutation = useMutation({
    mutationFn: setFoundingBetaEnrollment,
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({
        queryKey: ["admin", "founding-beta-enrollment", result.organizationId],
        exact: true,
      });
      setReason("");
      setPendingIntent(null);
      let message = "Founding Beta enrollment revoked.";

      if (result.replayed) {
        message = "The existing Founding Beta decision was confirmed.";
      } else if (result.enrolled) {
        message = "Founding Beta enrollment granted.";
      }

      toast.success(message);
    },
    onError: (error) => {
      toast.error(getErrorMessage(error));
    },
  });

  const beginChange = (enrolled: boolean) => {
    const trimmedReason = reason.trim();

    if (!effectiveOrganizationId || !trimmedReason) {
      toast.error("Select an organization and enter a reason.");
      return;
    }

    setPendingIntent({
      organizationId: effectiveOrganizationId,
      enrolled,
      reason: trimmedReason,
      idempotencyKey: `founding-beta:${effectiveOrganizationId}:${crypto.randomUUID()}`,
    });
    setIsMfaOpen(true);
  };

  const currentState = enrollmentQuery.data;

  return (
    <>
      <Card className="border-border bg-muted">
        <CardHeader className="gap-2">
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            Founding Beta enrollment
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            Enrollment is an audited invitation decision. It is independent of
            signup, organization membership, application role, billing, and
            automatic-quote entitlement.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          <EnrollmentContent
            organizations={organizations}
            isOrganizationsLoading={isOrganizationsLoading}
            organizationsError={organizationsError}
            onRetryOrganizations={onRetryOrganizations}
            effectiveOrganizationId={effectiveOrganizationId}
            selectedOrganizationName={selectedOrganization?.name}
            onOrganizationChange={(value) => {
              setSelectedOrganizationId(value);
              setReason("");
              setPendingIntent(null);
            }}
            currentState={currentState}
            isEnrollmentLoading={enrollmentQuery.isLoading}
            enrollmentError={enrollmentQuery.isError ? enrollmentQuery.error : null}
            isEnrollmentFetching={enrollmentQuery.isFetching}
            onRetryEnrollment={() => void enrollmentQuery.refetch()}
            reason={reason}
            onReasonChange={setReason}
            onBeginChange={beginChange}
            isMutationPending={enrollmentMutation.isPending}
            isMfaOpen={isMfaOpen}
          />
        </CardContent>
      </Card>

      <MfaStepUpDialog
        open={isMfaOpen}
        onOpenChange={setIsMfaOpen}
        title="Verify this Founding Beta change"
        description="Enrollment grants and revocations require an authenticator-app code. Your account remains the audited actor; this does not change customer roles or billing."
        onVerified={async () => {
          if (!pendingIntent) {
            throw new Error("The pending Founding Beta change could not be restored.");
          }

          await enrollmentMutation.mutateAsync(pendingIntent);
        }}
      />
    </>
  );
}
