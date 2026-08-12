import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { MfaStepUpDialog } from "@/components/auth/MfaStepUpDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  fetchCommercialAdminAccess,
} from "@/features/quotes/api/commercial-admin-access-api";
import { invalidateAdminVendorQuoteOffer } from "@/features/quotes/api/manual-quote-admin-api";
import type { VendorQuoteOfferRecord } from "@/features/quotes/types";

type AdminQuoteOfferInvalidationCardProps = {
  jobId: string;
  offers: VendorQuoteOfferRecord[];
};

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "Validity not provided";
  }
  return `Valid through ${new Date(value).toLocaleString()}`;
}

export function AdminQuoteOfferInvalidationCard({
  jobId,
  offers,
}: Readonly<AdminQuoteOfferInvalidationCardProps>) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [pendingOfferId, setPendingOfferId] = useState<string | null>(null);
  const [pendingIdempotencyKey, setPendingIdempotencyKey] = useState<string | null>(null);
  const [isMfaOpen, setIsMfaOpen] = useState(false);
  const accessQuery = useQuery({
    queryKey: ["commercial-admin-access"],
    queryFn: fetchCommercialAdminAccess,
    enabled: offers.length > 0,
  });
  const activeOffers = useMemo(
    () => offers.filter((offer) => !offer.invalidated_at),
    [offers],
  );
  const invalidateMutation = useMutation({
    mutationFn: invalidateAdminVendorQuoteOffer,
    onSuccess: async () => {
      toast.success("Offer invalidated. One immediate replacement request is now allowed.");
      setReason("");
      setPendingOfferId(null);
      setPendingIdempotencyKey(null);
      await queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "The quote offer could not be invalidated.");
    },
  });

  if (offers.length === 0 || accessQuery.isLoading || !accessQuery.data?.hasCapability) {
    return null;
  }

  const beginInvalidation = (offerId: string) => {
    const invalidationReason = reason.trim();
    if (!invalidationReason) {
      toast.error("Add a reason before invalidating an offer.");
      return;
    }

    const idempotencyKey = `quote-offer-invalidate:${offerId}:${crypto.randomUUID()}`;
    setPendingOfferId(offerId);
    setPendingIdempotencyKey(idempotencyKey);
    if (!accessQuery.data.hasAal2) {
      setIsMfaOpen(true);
      return;
    }
    invalidateMutation.mutate({
      offerId,
      reason: invalidationReason,
      idempotencyKey,
    });
  };

  return (
    <>
      <Card className="border-border bg-accent">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldAlert className="h-4 w-4" />
            Quote validity controls
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="quote-invalidation-reason">Invalidation reason</Label>
            <Input
              id="quote-invalidation-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Vendor withdrew pricing or scope changed outside the recorded package"
              disabled={invalidateMutation.isPending}
            />
          </div>
          <div className="divide-y divide-border border-y border-border">
            {activeOffers.map((offer) => (
              <div key={offer.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{offer.supplier}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(offer.valid_until)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={invalidateMutation.isPending}
                  onClick={() => beginInvalidation(offer.id)}
                >
                  {invalidateMutation.isPending && pendingOfferId === offer.id ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Invalidate
                </Button>
              </div>
            ))}
            {activeOffers.length === 0 ? (
              <p className="py-4 text-sm text-muted-foreground">
                Every recorded offer on this job is already invalidated.
              </p>
            ) : null}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            This action requires MFA, records an append-only audit event, and releases the matching lane for one immediate replacement request.
          </p>
        </CardContent>
      </Card>
      <MfaStepUpDialog
        open={isMfaOpen}
        onOpenChange={setIsMfaOpen}
        onVerified={async () => {
          await accessQuery.refetch();
          if (!pendingOfferId || !pendingIdempotencyKey || !reason.trim()) {
            throw new Error("The pending invalidation could not be restored.");
          }
          await invalidateMutation.mutateAsync({
            offerId: pendingOfferId,
            reason: reason.trim(),
            idempotencyKey: pendingIdempotencyKey,
          });
        }}
      />
    </>
  );
}
