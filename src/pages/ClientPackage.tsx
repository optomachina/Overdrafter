import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import { RequestedQuantityFilter } from "@/components/quotes/RequestedQuantityFilter";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { EmailVerificationPrompt } from "@/components/EmailVerificationPrompt";
import { useAppSession } from "@/hooks/use-app-session";
import { fetchClientPackage, resendSignupConfirmation, selectQuoteOption } from "@/features/quotes/api";
import {
  collectRequestedQuantities,
  groupByRequestedQuantity,
  resolveRequestedQuantitySelection,
  type RequestedQuantityFilterValue,
} from "@/features/quotes/request-scenarios";
import { isEmailConfirmationRequired } from "@/lib/auth-status";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency, formatLeadTime, optionLabelForKind } from "@/features/quotes/utils";

const ClientPackage = () => {
  const navigate = useNavigate();
  const params = useParams();
  const packageId = params.packageId ?? "";
  const queryClient = useQueryClient();
  const { user, isVerifiedAuth, signOut } = useAppSession();
  const [selectionNote, setSelectionNote] = useState("");
  const [isRefreshingVerification, setIsRefreshingVerification] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [activeRequestedQuantity, setActiveRequestedQuantity] =
    useState<RequestedQuantityFilterValue | null>(null);

  const packageQuery = useQuery({
    queryKey: ["client-package", packageId],
    queryFn: () => fetchClientPackage(packageId),
    enabled: Boolean(packageId && user),
  });

  const latestSelection = useMemo(
    () => packageQuery.data?.selections[0] ?? null,
    [packageQuery.data],
  );
  const selectedOption = useMemo(
    () =>
      latestSelection
        ? packageQuery.data?.options.find((option) => option.id === latestSelection.option_id) ?? null
        : null,
    [latestSelection, packageQuery.data?.options],
  );
  const requestQuantities = useMemo(
    () =>
      collectRequestedQuantities(
        [
          packageQuery.data?.job.requested_quote_quantities,
          packageQuery.data?.options.map((option) => option.requested_quantity),
        ],
        packageQuery.data?.job.requested_quote_quantities?.[0] ?? null,
      ),
    [packageQuery.data?.job.requested_quote_quantities, packageQuery.data?.options],
  );
  const visibleOptions = useMemo(() => {
    if (!packageQuery.data) {
      return [];
    }

    if (activeRequestedQuantity === "all" || activeRequestedQuantity === null) {
      return packageQuery.data.options;
    }

    return packageQuery.data.options.filter((option) => option.requested_quantity === activeRequestedQuantity);
  }, [activeRequestedQuantity, packageQuery.data]);
  const visibleOptionGroups = useMemo(() => {
    if (visibleOptions.length === 0) {
      return [];
    }

    if (activeRequestedQuantity === "all") {
      return groupByRequestedQuantity(
        visibleOptions.map((option) => ({
          ...option,
          requestedQuantity: option.requested_quantity,
        })),
      );
    }

    return [
      {
        requestedQuantity:
          typeof activeRequestedQuantity === "number"
            ? activeRequestedQuantity
            : visibleOptions[0]?.requested_quantity ?? 1,
        items: visibleOptions.map((option) => ({
          ...option,
          requestedQuantity: option.requested_quantity,
        })),
      },
    ];
  }, [activeRequestedQuantity, visibleOptions]);
  const requestSummaryQuantity =
    requestQuantities[0] ?? packageQuery.data?.job.requested_quote_quantities?.[0] ?? null;

  useEffect(() => {
    setActiveRequestedQuantity((current) =>
      resolveRequestedQuantitySelection({
        availableQuantities: requestQuantities,
        currentSelection: current,
        preferredQuantity: selectedOption?.requested_quantity ?? requestSummaryQuantity,
        allowAll: true,
      }),
    );
  }, [requestQuantities, requestSummaryQuantity, selectedOption?.requested_quantity]);

  const handleRefreshVerification = async () => {
    setIsRefreshingVerification(true);

    try {
      const { data, error } = await supabase.auth.getUser();

      if (error) {
        throw error;
      }

      if (!data.user) {
        throw new Error("Open the confirmation link from your email first.");
      }

      if (isEmailConfirmationRequired(data.user)) {
        throw new Error("Email confirmation has not completed yet.");
      }

      await queryClient.invalidateQueries({ queryKey: ["app-session"] });
      toast.success("Email verified.");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to refresh verification status.");
    } finally {
      setIsRefreshingVerification(false);
    }
  };

  const handleResendVerification = async () => {
    if (!user?.email) {
      toast.error("No email is available for this account.");
      return;
    }

    setIsResendingVerification(true);

    try {
      await resendSignupConfirmation(user.email);
      toast.success(`Confirmation email resent to ${user.email}.`);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to resend confirmation email.");
    } finally {
      setIsResendingVerification(false);
    }
  };

  const selectMutation = useMutation({
    mutationFn: (optionId: string) =>
      selectQuoteOption({
        packageId,
        optionId,
        note: selectionNote,
      }),
    onSuccess: async () => {
      toast.success("Quote option selected.");
      await queryClient.invalidateQueries({ queryKey: ["client-package", packageId] });
      await queryClient.invalidateQueries({ queryKey: ["packages"] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to select quote option.");
    },
  });

  if (!user) {
    return <Navigate to="/?auth=signin" replace />;
  }

  if (packageQuery.isLoading) {
    return (
      <AppShell title="Loading package" subtitle="Collecting the published quote package and client options.">
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppShell>
    );
  }

  if (packageQuery.isError || !packageQuery.data) {
    return (
      <AppShell title="Package unavailable" subtitle="The requested client package could not be loaded.">
        <Card className="border-destructive/30 bg-destructive/10">
          <CardContent className="p-6 text-sm text-destructive">
            {packageQuery.error instanceof Error ? packageQuery.error.message : "Unknown error"}
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  const data = packageQuery.data;

  const handleChangeEmail = async () => {
    try {
      await signOut();
      navigate("/?auth=signup", { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to sign out.");
    }
  };

  return (
    <AppShell
      title={data.job.title}
      subtitle={
        data.package.client_summary ||
        "Review your curated CNC machining options and choose the best fit for cost, speed, or overall value."
      }
      actions={
        <Button asChild variant="outline" className="border-white/10 bg-white/5">
          <Link to="/">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to dashboard
          </Link>
        </Button>
      }
    >
      {!isVerifiedAuth && user?.email ? (
        <section className="mb-8">
          <EmailVerificationPrompt
            email={user.email}
            isRefreshing={isRefreshingVerification}
            isResending={isResendingVerification}
            onRefreshSession={() => {
              void handleRefreshVerification();
            }}
            onResend={() => {
              void handleResendVerification();
            }}
            onChangeEmail={() => {
              void handleChangeEmail();
            }}
          />
        </section>
      ) : null}

      <section className="grid gap-4 md:grid-cols-3">
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Published</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {new Date(data.package.published_at).toLocaleDateString()}
            </p>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Options</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{data.options.length}</p>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Status</CardTitle>
          </CardHeader>
          <CardContent>
            {latestSelection ? (
              <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                <CheckCircle2 className="h-4 w-4" />
                Selection received
              </div>
            ) : (
              <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/75">
                Awaiting selection
              </Badge>
            )}
          </CardContent>
        </Card>
      </section>

      <RequestSummaryBadges
        requestedServiceKinds={data.job.requested_service_kinds ?? []}
        quantity={requestSummaryQuantity}
        requestedQuoteQuantities={requestQuantities}
        requestedByDate={data.job.requested_by_date}
        className="mt-4"
      />

      <section className="mt-8 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          <RequestedQuantityFilter
            quantities={requestQuantities}
            value={activeRequestedQuantity}
            onChange={setActiveRequestedQuantity}
          />
          {visibleOptions.length === 0 ? (
            <Card className="border-white/10 bg-black/20">
              <CardContent className="p-6 text-sm text-white/55">
                No published options are available for qty {activeRequestedQuantity}.
              </CardContent>
            </Card>
          ) : (
            visibleOptionGroups.map((group) => (
              <div key={group.requestedQuantity} className="space-y-4">
                {activeRequestedQuantity === "all" ? (
                  <div className="flex items-center justify-between rounded-2xl border border-white/8 bg-white/5 px-4 py-3">
                    <p className="text-sm font-medium text-white">Qty {group.requestedQuantity}</p>
                    <p className="text-xs text-white/45">
                      {group.items.length} option{group.items.length === 1 ? "" : "s"}
                    </p>
                  </div>
                ) : null}
                {group.items.map((option) => (
                  <Card key={option.id} className="border-white/10 bg-black/20">
                    <CardHeader className="flex flex-row items-start justify-between gap-4">
                      <div>
                        <div className="flex flex-wrap gap-2">
                          <Badge className="border border-primary/20 bg-primary/10 text-primary">
                            {optionLabelForKind(option.option_kind)}
                          </Badge>
                          <Badge className="border border-white/10 bg-white/6 text-white/75">
                            Qty {option.requested_quantity}
                          </Badge>
                        </div>
                        <CardTitle className="mt-4 text-2xl">{option.label}</CardTitle>
                      </div>
                      <div className="text-right">
                        <p className="text-3xl font-semibold">{formatCurrency(option.published_price_usd)}</p>
                        <p className="mt-1 text-sm text-white/50">{formatLeadTime(option.lead_time_business_days)}</p>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <p className="text-sm text-white/60">
                        {option.comparison_summary || "Curated from the internal vendor comparison."}
                      </p>
                      <Button
                        className="w-full rounded-full"
                        onClick={() => selectMutation.mutate(option.id)}
                        disabled={!isVerifiedAuth || selectMutation.isPending}
                      >
                        {selectMutation.isPending ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="mr-2 h-4 w-4" />
                        )}
                        Select this option
                      </Button>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="space-y-6">
          <Card className="border-white/10 bg-white/5">
            <CardHeader>
              <CardTitle>Decision notes</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                value={selectionNote}
                onChange={(event) => setSelectionNote(event.target.value)}
                disabled={!isVerifiedAuth}
                className="min-h-32 border-white/10 bg-black/20"
                placeholder="Optional delivery, commercial, or approval notes for this selection."
              />
            </CardContent>
          </Card>

          {latestSelection ? (
            <Card className="border-emerald-500/20 bg-emerald-500/10">
              <CardHeader>
                <CardTitle className="text-emerald-200">Selection received</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-emerald-100">
                <p>Submitted on {new Date(latestSelection.created_at).toLocaleString()}</p>
                <p>{latestSelection.note || "No note was provided with the selection."}</p>
              </CardContent>
            </Card>
          ) : (
            <Card className="border-white/10 bg-black/20">
              <CardHeader>
                <CardTitle>What happens next</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-white/55">
                <p>Your selection is recorded against this published package.</p>
                <p>The estimating team will confirm the underlying quote lane and continue the downstream order workflow.</p>
              </CardContent>
            </Card>
          )}
        </div>
      </section>
    </AppShell>
  );
};

export default ClientPackage;
