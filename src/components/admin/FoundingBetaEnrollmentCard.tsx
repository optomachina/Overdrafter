import { useMemo, useState } from "react";
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

function formatEventTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "No enrollment event recorded";
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
  const effectiveOrganizationId = useMemo(() => {
    if (
      selectedOrganizationId
      && organizations.some((organization) => organization.id === selectedOrganizationId)
    ) {
      return selectedOrganizationId;
    }

    return organizations[0]?.id ?? "";
  }, [organizations, selectedOrganizationId]);
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
  let stateLabel = "Not enrolled";

  if (currentState?.enrolled) {
    stateLabel = "Enrolled";
  } else if (currentState?.latestAction === "revoke") {
    stateLabel = "Revoked";
  }

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
          {isOrganizationsLoading ? (
            <div className="flex min-h-24 items-center justify-center">
              <Loader2
                className="h-5 w-5 animate-spin text-primary"
                aria-label="Loading organizations for Founding Beta"
              />
            </div>
          ) : organizationsError ? (
            <div
              className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4"
              role="alert"
            >
              <p className="font-medium text-destructive">
                Organization list unavailable
              </p>
              <p className="mt-2 text-sm text-destructive">
                {getErrorMessage(organizationsError)}
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-4"
                onClick={onRetryOrganizations}
              >
                Retry
              </Button>
            </div>
          ) : organizations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No organizations are available for enrollment.
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="founding-beta-organization">Organization</Label>
                <Select
                  value={effectiveOrganizationId}
                  onValueChange={(value) => {
                    setSelectedOrganizationId(value);
                    setReason("");
                    setPendingIntent(null);
                  }}
                  disabled={enrollmentMutation.isPending || isMfaOpen}
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

              {enrollmentQuery.isLoading ? (
                <div className="flex min-h-24 items-center justify-center">
                  <Loader2
                    className="h-5 w-5 animate-spin text-primary"
                    aria-label="Loading Founding Beta enrollment"
                  />
                </div>
              ) : enrollmentQuery.isError ? (
                <div
                  className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4"
                  role="alert"
                >
                  <p className="font-medium text-destructive">
                    Enrollment state unavailable
                  </p>
                  <p className="mt-2 text-sm text-destructive">
                    {getErrorMessage(enrollmentQuery.error)}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-4"
                    onClick={() => void enrollmentQuery.refetch()}
                    disabled={enrollmentQuery.isFetching}
                  >
                    Retry
                  </Button>
                </div>
              ) : currentState ? (
                <div className="rounded-2xl border border-border bg-accent p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-medium">{selectedOrganization?.name}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Policy {currentState.policyRevision}
                      </p>
                    </div>
                    <Badge variant={currentState.enrolled ? "default" : "outline"}>
                      {stateLabel}
                    </Badge>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {formatEventTime(currentState.latestEventAt)}
                  </p>
                </div>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor="founding-beta-reason">Reason</Label>
                <Textarea
                  id="founding-beta-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Why this organization is being enrolled or revoked"
                  maxLength={1000}
                  disabled={
                    enrollmentMutation.isPending
                    || enrollmentQuery.isError
                    || isMfaOpen
                  }
                />
              </div>

              <div className="flex flex-wrap gap-3">
                <Button
                  type="button"
                  onClick={() => beginChange(true)}
                  disabled={
                    enrollmentQuery.isLoading
                    || enrollmentQuery.isError
                    || currentState?.enrolled === true
                    || enrollmentMutation.isPending
                    || isMfaOpen
                  }
                >
                  Grant enrollment
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => beginChange(false)}
                  disabled={
                    enrollmentQuery.isLoading
                    || enrollmentQuery.isError
                    || currentState?.enrolled !== true
                    || enrollmentMutation.isPending
                    || isMfaOpen
                  }
                >
                  Revoke enrollment
                </Button>
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                Every change requires an authenticator code and a non-empty
                reason. Revocation stops new drafts and uploads but preserves
                access to existing work.
              </p>
            </>
          )}
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
