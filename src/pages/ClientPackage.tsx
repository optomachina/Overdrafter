import { useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { EmailVerificationPrompt } from "@/components/EmailVerificationPrompt";
import { useAppSession } from "@/hooks/use-app-session";
import { fetchClientPackage, resendSignupConfirmation, selectQuoteOption } from "@/features/quotes/api";
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

  const packageQuery = useQuery({
    queryKey: ["client-package", packageId],
    queryFn: () => fetchClientPackage(packageId),
    enabled: Boolean(packageId && user),
  });

  const latestSelection = useMemo(
    () => packageQuery.data?.selections[0] ?? null,
    [packageQuery.data],
  );

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

      <section className="mt-8 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
        <div className="space-y-6">
          {data.options.map((option) => (
            <Card key={option.id} className="border-white/10 bg-black/20">
              <CardHeader className="flex flex-row items-start justify-between gap-4">
                <div>
                  <Badge className="border border-primary/20 bg-primary/10 text-primary">
                    {optionLabelForKind(option.option_kind)}
                  </Badge>
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
