import { useMemo, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { MfaStepUpDialog } from "@/components/auth/MfaStepUpDialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
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
  grantCommercialEntitlement,
  revokeCommercialEntitlement,
  type CommercialEntitlementGrant,
} from "@/features/quotes/api/commercial-account-admin-api";

type CommercialEntitlementControlsProps = {
  organizationId: string;
  grants: readonly CommercialEntitlementGrant[];
  hasAal2: boolean;
  onAccessRefresh: () => Promise<void>;
  onChanged: () => Promise<void>;
};

function newIntentKey(): string {
  const cryptoApi = globalThis.crypto;

  if (!cryptoApi) {
    throw new Error("Secure intent generation is unavailable.");
  }

  if (cryptoApi.randomUUID) {
    return cryptoApi.randomUUID();
  }

  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);

  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function toLocalDateTime(date: Date): string {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function toIso(value: string): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isAal2RequiredError(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes(
      "Multi-factor authentication is required for this commercial operation.",
    );
}

export function CommercialEntitlementControls({
  organizationId,
  grants,
  hasAal2,
  onAccessRefresh,
  onChanged,
}: Readonly<CommercialEntitlementControlsProps>) {
  const now = useMemo(() => new Date(), []);
  const [grantType, setGrantType] = useState<"trial" | "complimentary">("trial");
  const [startsAt, setStartsAt] = useState(toLocalDateTime(now));
  const [expiresAt, setExpiresAt] = useState(
    toLocalDateTime(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)),
  );
  const [reviewAt, setReviewAt] = useState(
    toLocalDateTime(new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)),
  );
  const [reason, setReason] = useState("");
  const [grantIntentKey, setGrantIntentKey] = useState(newIntentKey);
  const [mfaOpen, setMfaOpen] = useState(false);
  const [revokeGrant, setRevokeGrant] =
    useState<CommercialEntitlementGrant | null>(null);
  const [revokeReason, setRevokeReason] = useState("");
  const [revokeIntentKey, setRevokeIntentKey] = useState(newIntentKey);
  const grantMutation = useMutation({
    mutationFn: grantCommercialEntitlement,
    onSuccess: async (result) => {
      await onChanged();
      setReason("");
      setGrantIntentKey(newIntentKey());
      let message = "Trial Pro access granted.";

      if (result.replayed) {
        message = "The existing audited grant was confirmed.";
      } else if (grantType === "complimentary") {
        message = "Complimentary Pro access granted.";
      }

      toast.success(message);
    },
    onError: async (error) => {
      if (isAal2RequiredError(error)) {
        await onAccessRefresh();
        setMfaOpen(true);
      }
    },
  });
  const revokeMutation = useMutation({
    mutationFn: revokeCommercialEntitlement,
    onSuccess: async (result) => {
      await onChanged();
      setRevokeGrant(null);
      setRevokeReason("");
      setRevokeIntentKey(newIntentKey());
      toast.success(
        result.replayed
          ? "The existing audited revocation was confirmed."
          : "Pro grant revoked.",
      );
    },
    onError: async (error) => {
      if (isAal2RequiredError(error)) {
        await onAccessRefresh();
        setMfaOpen(true);
      }
    },
  });

  const rotateGrantIntent = () => {
    if (!grantMutation.isPending) {
      setGrantIntentKey(newIntentKey());
      grantMutation.reset();
    }
  };

  const submitGrant = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!hasAal2) {
      setMfaOpen(true);
      return;
    }

    const startsAtIso = toIso(startsAt);
    const expiresAtIso = grantType === "trial" ? toIso(expiresAt) : null;
    const reviewAtIso =
      grantType === "complimentary" ? toIso(reviewAt) : null;

    if (
      !startsAtIso
      || (grantType === "trial" && !expiresAtIso)
      || (grantType === "complimentary" && !reviewAtIso)
      || reason.trim().length === 0
    ) {
      return;
    }

    grantMutation.mutate({
      organizationId,
      grantType,
      startsAt: startsAtIso,
      expiresAt: expiresAtIso,
      reviewAt: reviewAtIso,
      reason: reason.trim(),
      idempotencyKey: grantIntentKey,
    });
  };

  const confirmRevoke = () => {
    if (!revokeGrant || revokeReason.trim().length === 0) {
      return;
    }

    revokeMutation.mutate({
      grantId: revokeGrant.id,
      reason: revokeReason.trim(),
      idempotencyKey: revokeIntentKey,
    });
  };
  let grantButtonLabel = "Grant trial Pro";

  if (!hasAal2) {
    grantButtonLabel = "Verify with MFA to grant";
  } else if (grantType === "complimentary") {
    grantButtonLabel = "Grant complimentary Pro";
  }

  return (
    <>
      <Card className="border-border bg-muted">
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Manual Pro access</CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">
                Manual access is labeled as a trial or complimentary grant. It
                is never presented as a paid subscription.
              </p>
            </div>
            <Badge variant={hasAal2 ? "default" : "outline"}>
              {hasAal2 ? (
                <ShieldCheck className="mr-1 h-3.5 w-3.5" />
              ) : (
                <KeyRound className="mr-1 h-3.5 w-3.5" />
              )}
              {hasAal2 ? "AAL2 verified" : "MFA required"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={submitGrant} className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="commercial-grant-type">Access type</Label>
              <Select
                value={grantType}
                onValueChange={(value: "trial" | "complimentary") => {
                  setGrantType(value);
                  rotateGrantIntent();
                }}
                disabled={grantMutation.isPending}
              >
                <SelectTrigger id="commercial-grant-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="trial">Trial</SelectItem>
                  <SelectItem value="complimentary">Complimentary</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="commercial-grant-start">Starts</Label>
              <Input
                id="commercial-grant-start"
                type="datetime-local"
                value={startsAt}
                onChange={(event) => {
                  setStartsAt(event.target.value);
                  rotateGrantIntent();
                }}
                required
                disabled={grantMutation.isPending}
              />
            </div>
            {grantType === "trial" ? (
              <div className="space-y-2 lg:col-span-2">
                <Label htmlFor="commercial-grant-expiration">
                  Trial expiration
                </Label>
                <Input
                  id="commercial-grant-expiration"
                  type="datetime-local"
                  value={expiresAt}
                  onChange={(event) => {
                    setExpiresAt(event.target.value);
                    rotateGrantIntent();
                  }}
                  required
                  disabled={grantMutation.isPending}
                />
                <p className="text-xs text-muted-foreground">
                  Every trial must have a concrete end time.
                </p>
              </div>
            ) : (
              <div className="space-y-2 lg:col-span-2">
                <Label htmlFor="commercial-grant-review">
                  Complimentary review date
                </Label>
                <Input
                  id="commercial-grant-review"
                  type="datetime-local"
                  value={reviewAt}
                  onChange={(event) => {
                    setReviewAt(event.target.value);
                    rotateGrantIntent();
                  }}
                  required
                  disabled={grantMutation.isPending}
                />
                <p className="text-xs text-muted-foreground">
                  Complimentary access remains explicit and returns for human
                  review on this date.
                </p>
              </div>
            )}
            <div className="space-y-2 lg:col-span-2">
              <Label htmlFor="commercial-grant-reason">Reason</Label>
              <Textarea
                id="commercial-grant-reason"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  rotateGrantIntent();
                }}
                placeholder="Why this organization should receive manual Pro access"
                required
                disabled={grantMutation.isPending}
              />
            </div>
            {grantMutation.isError ? (
              <p className="text-sm text-destructive lg:col-span-2" role="alert">
                {getErrorMessage(
                  grantMutation.error,
                  "Pro access could not be granted.",
                )}
              </p>
            ) : null}
            <div className="flex justify-end lg:col-span-2">
              <Button
                type="submit"
                disabled={grantMutation.isPending || reason.trim().length === 0}
              >
                {grantMutation.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : null}
                {grantButtonLabel}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="border-border bg-muted">
        <CardHeader>
          <CardTitle>Grant history</CardTitle>
          <p className="text-sm text-muted-foreground">
            Expired and revoked grants remain visible for audit.
          </p>
        </CardHeader>
        <CardContent>
          {grants.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              No trial or complimentary grants have been recorded.
            </div>
          ) : (
            <div className="space-y-3">
              {grants.map((grant) => {
                const isRevoked = Boolean(grant.revokedAt);

                return (
                  <div
                    key={grant.id}
                    className="flex flex-col gap-4 rounded-2xl border border-border bg-accent p-4 sm:flex-row sm:items-start sm:justify-between"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">
                          {grant.type === "trial" ? "Trial" : "Complimentary"}
                        </Badge>
                        {isRevoked ? (
                          <Badge variant="destructive">Revoked</Badge>
                        ) : (
                          <Badge variant="default">Recorded</Badge>
                        )}
                      </div>
                      <p className="mt-3 text-sm">{grant.reason}</p>
                      <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                        <p>Started {new Date(grant.startsAt).toLocaleString()}</p>
                        {grant.expiresAt ? (
                          <p>Expires {new Date(grant.expiresAt).toLocaleString()}</p>
                        ) : null}
                        {grant.reviewAt ? (
                          <p>Review {new Date(grant.reviewAt).toLocaleString()}</p>
                        ) : null}
                        {grant.revokedAt ? (
                          <p>
                            Revoked {new Date(grant.revokedAt).toLocaleString()}
                            {grant.revocationReason
                              ? ` — ${grant.revocationReason}`
                              : ""}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isRevoked || revokeMutation.isPending}
                      onClick={() => {
                        if (!hasAal2) {
                          setMfaOpen(true);
                          return;
                        }

                        setRevokeGrant(grant);
                        setRevokeReason("");
                        setRevokeIntentKey(newIntentKey());
                        revokeMutation.reset();
                      }}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      {hasAal2 ? "Revoke" : "Verify to revoke"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <MfaStepUpDialog
        open={mfaOpen}
        onOpenChange={setMfaOpen}
        onVerified={onAccessRefresh}
      />

      <AlertDialog
        open={Boolean(revokeGrant)}
        onOpenChange={(open) => {
          if (!open && !revokeMutation.isPending) {
            setRevokeGrant(null);
            setRevokeReason("");
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this Pro grant?</AlertDialogTitle>
            <AlertDialogDescription>
              This does not cancel or mislabel a paid Stripe subscription. It
              removes only the selected manual grant and records an audit event.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="commercial-revoke-reason">Revocation reason</Label>
            <Textarea
              id="commercial-revoke-reason"
              value={revokeReason}
              onChange={(event) => {
                const nextReason = event.target.value;

                if (
                  nextReason !== revokeReason
                  && !revokeMutation.isPending
                ) {
                  setRevokeIntentKey(newIntentKey());
                  revokeMutation.reset();
                }

                setRevokeReason(nextReason);
              }}
              placeholder="Why this manual access is being removed"
              disabled={revokeMutation.isPending}
            />
          </div>
          {revokeMutation.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {getErrorMessage(
                revokeMutation.error,
                "The Pro grant could not be revoked.",
              )}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>
              Keep grant
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                confirmRevoke();
              }}
              disabled={
                revokeMutation.isPending || revokeReason.trim().length === 0
              }
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revokeMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Revoke grant
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
