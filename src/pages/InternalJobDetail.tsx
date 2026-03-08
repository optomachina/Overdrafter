import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  FileUp,
  Loader2,
  PlayCircle,
  Rocket,
  ScanSearch,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import { CadModelThumbnail } from "@/components/CadModelThumbnail";
import { EmailVerificationPrompt } from "@/components/EmailVerificationPrompt";
import { ManualQuoteIntakeCard } from "@/components/quotes/ManualQuoteIntakeCard";
import { RequestedQuantityFilter } from "@/components/quotes/RequestedQuantityFilter";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import { XometryDebugCard } from "@/components/quotes/XometryDebugCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { useAppSession } from "@/hooks/use-app-session";
import { useDiagnosticsSnapshot } from "@/lib/diagnostics";
import { isEmailConfirmationRequired } from "@/lib/auth-status";
import { createCadPreviewSourceFromJobFile, isStepPreviewableFile } from "@/lib/cad-preview";
import { supabase } from "@/integrations/supabase/client";
import {
  approveJobRequirements,
  fetchJobAggregate,
  getQuoteRunReadiness,
  publishQuotePackage,
  requestExtraction,
  resendSignupConfirmation,
  startQuoteRun,
} from "@/features/quotes/api";
import {
  formatRequestedQuoteQuantitiesInput,
  parseRequestedQuoteQuantitiesInput,
} from "@/features/quotes/request-intake";
import {
  collectRequestedQuantities,
  normalizeApprovedRequirementDraft,
  resolveRequestedQuantitySelection,
  type RequestedQuantityFilterValue,
} from "@/features/quotes/request-scenarios";
import type { ApprovedPartRequirement } from "@/features/quotes/types";
import {
  buildRequirementDraft,
  formatCurrency,
  formatLeadTime,
  formatStatusLabel,
  formatVendorName,
  getImportedVendorOffers,
  getLatestPublishedPackage,
  getLatestQuoteRun,
  hasManualQuoteIntakeSource,
  isManualImportVendor,
  normalizeDrawingExtraction,
  optionLabelForKind,
  projectedClientPrice,
} from "@/features/quotes/utils";

const vendors = ["xometry", "fictiv", "protolabs", "sendcutsend"] as const;

const InternalJobDetail = () => {
  const navigate = useNavigate();
  const params = useParams();
  const jobId = params.jobId ?? "";
  const queryClient = useQueryClient();
  const { user, activeMembership, isVerifiedAuth, signOut } = useAppSession();
  const diagnostics = useDiagnosticsSnapshot();
  const [drafts, setDrafts] = useState<Record<string, ApprovedPartRequirement>>({});
  const [quoteQuantityInputs, setQuoteQuantityInputs] = useState<Record<string, string>>({});
  const [clientSummary, setClientSummary] = useState("");
  const [isRefreshingVerification, setIsRefreshingVerification] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [activeCompareRequestedQuantity, setActiveCompareRequestedQuantity] =
    useState<RequestedQuantityFilterValue | null>(null);

  const jobQuery = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => fetchJobAggregate(jobId),
    enabled: Boolean(jobId && user && activeMembership && activeMembership.role !== "client"),
  });

  const cadPreviewSources = useMemo(
    () =>
      new Map(
        (jobQuery.data?.parts ?? [])
          .filter((part) => Boolean(part.cadFile))
          .map((part) => [part.id, createCadPreviewSourceFromJobFile(part.cadFile!)]),
      ),
    [jobQuery.data?.parts],
  );

  const latestQuoteRun = useMemo(
    () => (jobQuery.data ? getLatestQuoteRun(jobQuery.data) : null),
    [jobQuery.data],
  );

  const latestPackage = useMemo(
    () => (jobQuery.data ? getLatestPublishedPackage(jobQuery.data) : null),
    [jobQuery.data],
  );
  const optionKindsByOfferId = useMemo(() => {
    const mapping = new Map<string, string[]>();

    latestPackage?.options.forEach((option) => {
      if (!option.source_vendor_quote_offer_id) {
        return;
      }

      const current = mapping.get(option.source_vendor_quote_offer_id) ?? [];
      current.push(optionLabelForKind(option.option_kind));
      mapping.set(option.source_vendor_quote_offer_id, current);
    });

    return mapping;
  }, [latestPackage]);

  const readinessQuery = useQuery({
    queryKey: ["quote-readiness", latestQuoteRun?.id],
    queryFn: () => getQuoteRunReadiness(latestQuoteRun!.id),
    enabled: Boolean(latestQuoteRun?.id),
  });
  const quoteRows = useMemo(
    () => latestQuoteRun?.vendorQuotes ?? [],
    [latestQuoteRun?.vendorQuotes],
  );
  const compareQuantities = useMemo(
    () =>
      collectRequestedQuantities(
        [
          quoteRows.map((quote) => quote.requested_quantity),
          Object.values(drafts).flatMap((draft) => draft.quoteQuantities),
          jobQuery.data?.job.requested_quote_quantities,
        ],
        jobQuery.data?.parts[0]?.quantity ?? null,
      ),
    [drafts, jobQuery.data?.job.requested_quote_quantities, jobQuery.data?.parts, quoteRows],
  );
  const visibleQuoteRows = useMemo(() => {
    const nextRows =
      activeCompareRequestedQuantity === "all" || activeCompareRequestedQuantity === null
        ? quoteRows
        : quoteRows.filter((quote) => quote.requested_quantity === activeCompareRequestedQuantity);

    return [...nextRows].sort((left, right) => {
      if (left.requested_quantity !== right.requested_quantity) {
        return left.requested_quantity - right.requested_quantity;
      }

      if (left.part_id !== right.part_id) {
        return left.part_id.localeCompare(right.part_id);
      }

      return left.vendor.localeCompare(right.vendor);
    });
  }, [activeCompareRequestedQuantity, quoteRows]);
  const writeActionsDisabled = !isVerifiedAuth;
  const showDebugTools = diagnostics.enabled || import.meta.env.DEV;

  useEffect(() => {
    setActiveCompareRequestedQuantity((current) =>
      resolveRequestedQuantitySelection({
        availableQuantities: compareQuantities,
        currentSelection: current,
        preferredQuantity: compareQuantities[0] ?? null,
        allowAll: true,
      }),
    );
  }, [compareQuantities]);

  useEffect(() => {
    if (!jobQuery.data) {
      return;
    }

    const jobRequestDefaults = {
      requested_quote_quantities: jobQuery.data.job.requested_quote_quantities ?? [],
      requested_by_date: jobQuery.data.job.requested_by_date ?? null,
    };
    const nextDrafts = Object.fromEntries(
      jobQuery.data.parts.map((part) => [part.id, buildRequirementDraft(part, jobRequestDefaults)]),
    );

    setDrafts(nextDrafts);
    setQuoteQuantityInputs(
      Object.fromEntries(
        Object.values(nextDrafts).map((draft) => [
          draft.partId,
          formatRequestedQuoteQuantitiesInput(draft.quoteQuantities),
        ]),
      ),
    );

    setClientSummary((current) =>
      current ||
      latestPackage?.client_summary ||
      `Curated CNC quote package for ${jobQuery.data.job.title}.`,
    );
  }, [jobQuery.data, latestPackage?.client_summary]);

  const requestExtractionMutation = useMutation({
    mutationFn: () => requestExtraction(jobId),
    onSuccess: async () => {
      toast.success("Extraction queue refreshed.");
      await queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    },
    onError: (error: Error) => toast.error(error.message || "Failed to queue extraction."),
  });

  const saveRequirementsMutation = useMutation({
    mutationFn: () =>
      approveJobRequirements(
        jobId,
        Object.values(drafts).map((draft) => normalizeApprovedRequirementDraft(draft)),
      ),
    onSuccess: async (approvedCount) => {
      toast.success(`Approved ${approvedCount} part requirement set(s).`);
      await queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    },
    onError: (error: Error) => toast.error(error.message || "Failed to save approved requirements."),
  });

  const startQuoteRunMutation = useMutation({
    mutationFn: () => startQuoteRun(jobId, true),
    onSuccess: async () => {
      toast.success("Quote run started.");
      await queryClient.invalidateQueries({ queryKey: ["job", jobId] });
    },
    onError: (error: Error) => toast.error(error.message || "Failed to start quote run."),
  });

  const publishMutation = useMutation({
    mutationFn: () =>
      publishQuotePackage({
        jobId,
        quoteRunId: latestQuoteRun!.id,
        clientSummary,
        force: !readinessQuery.data?.ready,
      }),
    onSuccess: async () => {
      toast.success("Quote package published.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["job", jobId] }),
        queryClient.invalidateQueries({ queryKey: ["packages"] }),
      ]);
    },
    onError: (error: Error) => toast.error(error.message || "Failed to publish quote package."),
  });

  if (!user) {
    return <Navigate to="/?auth=signin" replace />;
  }

  if (!activeMembership || activeMembership.role === "client") {
    return <Navigate to="/" replace />;
  }

  if (jobQuery.isLoading) {
    return (
      <AppShell title="Loading job" subtitle="Collecting job state, extraction evidence, and quote results.">
        <div className="flex min-h-[40vh] items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </AppShell>
    );
  }

  if (jobQuery.isError || !jobQuery.data) {
    return (
      <AppShell title="Job unavailable" subtitle="The requested job could not be loaded.">
        <Card className="border-destructive/30 bg-destructive/10">
          <CardContent className="p-6 text-sm text-destructive">
            {jobQuery.error instanceof Error ? jobQuery.error.message : "Unknown error"}
          </CardContent>
        </Card>
      </AppShell>
    );
  }

  const job = jobQuery.data;

  const updateDraft = (
    partId: string,
    updater: (current: ApprovedPartRequirement) => ApprovedPartRequirement,
  ) => {
    setDrafts((current) => ({
      ...current,
      [partId]: updater(current[partId]),
    }));
  };

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
      title={job.job.title}
      subtitle={job.job.description || "Internal review, quote orchestration, and publication for this CNC job."}
      actions={
        <>
          <Button
            variant="outline"
            className="border-white/10 bg-white/5"
            onClick={() => requestExtractionMutation.mutate()}
            disabled={writeActionsDisabled || requestExtractionMutation.isPending}
          >
            {requestExtractionMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <ScanSearch className="mr-2 h-4 w-4" />
            )}
            Queue extraction
          </Button>
          <Button
            variant="outline"
            className="border-white/10 bg-white/5"
            onClick={() => saveRequirementsMutation.mutate()}
            disabled={writeActionsDisabled || saveRequirementsMutation.isPending}
          >
            {saveRequirementsMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="mr-2 h-4 w-4" />
            )}
            Save approved requirements
          </Button>
          <Button
            className="rounded-full"
            onClick={() => startQuoteRunMutation.mutate()}
            disabled={writeActionsDisabled || startQuoteRunMutation.isPending}
          >
            {startQuoteRunMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <PlayCircle className="mr-2 h-4 w-4" />
            )}
            Start quote run
          </Button>
        </>
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

      {job.job.tags.length > 0 ? (
        <section className="mb-6 flex flex-wrap gap-2">
          {job.job.tags.map((tag) => (
            <Badge
              key={`${job.job.id}-${tag}`}
              variant="secondary"
              className="border border-primary/20 bg-primary/10 text-primary"
            >
              {tag}
            </Badge>
          ))}
        </section>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-4">
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Job status</CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/80">
              {formatStatusLabel(job.job.status)}
            </Badge>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Parts</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{job.parts.length}</p>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Files</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{job.files.length}</p>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Pricing policy</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">{job.pricingPolicy?.version ?? "v1_markup_20"}</p>
            <p className="mt-1 text-sm text-white/55">
              {job.pricingPolicy?.markup_percent ?? 20}% markup
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="mt-8 grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Parts and approved requirements</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {job.parts.map((part) => {
              const extraction = normalizeDrawingExtraction(part.extraction, part.id);
              const draft =
                drafts[part.id] ??
                buildRequirementDraft(part, {
                  requested_quote_quantities: job.job.requested_quote_quantities ?? [],
                  requested_by_date: job.job.requested_by_date ?? null,
                });
              const cadPreviewSource = cadPreviewSources.get(part.id) ?? null;
              const cadPreviewable = part.cadFile ? isStepPreviewableFile(part.cadFile.original_name) : false;
              const quoteQuantityInput =
                quoteQuantityInputs[part.id] ?? formatRequestedQuoteQuantitiesInput(draft.quoteQuantities);

              return (
                <div key={part.id} className="rounded-3xl border border-white/8 bg-black/20 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <p className="text-lg font-medium">{part.name}</p>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs">
                        <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                          CAD: {part.cadFile?.original_name ?? "Missing"}
                        </Badge>
                        <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                          Drawing: {part.drawingFile?.original_name ?? "Missing"}
                        </Badge>
                        <Badge
                          variant="secondary"
                          className="border border-primary/20 bg-primary/10 text-primary"
                        >
                          Extraction: {formatStatusLabel(extraction.status)}
                        </Badge>
                      </div>
                      <RequestSummaryBadges
                        quantity={draft.quantity}
                        requestedQuoteQuantities={draft.quoteQuantities}
                        requestedByDate={draft.requestedByDate}
                        className="mt-3"
                      />
                    </div>
                    {extraction.warnings.length > 0 ? (
                      <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-1 text-xs text-amber-300">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {extraction.warnings.length} warning(s)
                      </div>
                    ) : (
                      <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-300">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        No blocking warnings
                      </div>
                    )}
                  </div>

                  <div className="mt-5 grid gap-5 xl:grid-cols-[13rem_1fr]">
                    <div className="space-y-3">
                      {part.cadFile ? (
                        cadPreviewable ? (
                          <CadModelThumbnail
                            source={cadPreviewSource!}
                            className="h-52 w-full"
                          />
                        ) : (
                          <div className="flex h-52 flex-col items-center justify-center rounded-[1.6rem] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(11,15,24,0.95))] px-4 text-center">
                            <div className="rounded-full border border-white/10 bg-white/5 p-3">
                              <FileUp className="h-6 w-6 text-primary" />
                            </div>
                            <p className="mt-4 text-sm font-medium text-white">CAD attached</p>
                            <p className="mt-2 text-xs text-white/45">
                              {part.cadFile.original_name}
                            </p>
                            <p className="mt-3 text-xs text-white/40">
                              Interactive preview is currently enabled for `.step` and `.stp`.
                            </p>
                          </div>
                        )
                      ) : (
                        <div className="flex h-52 flex-col items-center justify-center rounded-[1.6rem] border border-dashed border-white/10 bg-black/20 px-4 text-center">
                          <div className="rounded-full border border-white/10 bg-white/5 p-3">
                            <AlertTriangle className="h-6 w-6 text-amber-300" />
                          </div>
                          <p className="mt-4 text-sm font-medium text-white">CAD missing</p>
                          <p className="mt-2 text-xs text-white/45">
                            Upload a STEP file to generate a reusable thumbnail.
                          </p>
                        </div>
                      )}

                      <div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-xs text-white/55">
                        <p className="font-medium text-white">Source files</p>
                        <p className="mt-2 truncate">CAD: {part.cadFile?.original_name ?? "Missing"}</p>
                        <p className="mt-1 truncate">Drawing: {part.drawingFile?.original_name ?? "Missing"}</p>
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="space-y-2">
                        <Label>Description</Label>
                        <Input
                          className="border-white/10 bg-black/20"
                          value={draft?.description ?? ""}
                          disabled={writeActionsDisabled}
                          onChange={(event) =>
                            updateDraft(part.id, (current) => ({
                              ...current,
                              description: event.target.value || null,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Part number</Label>
                        <Input
                          className="border-white/10 bg-black/20"
                          value={draft?.partNumber ?? ""}
                          disabled={writeActionsDisabled}
                          onChange={(event) =>
                            updateDraft(part.id, (current) => ({
                              ...current,
                              partNumber: event.target.value || null,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Revision</Label>
                        <Input
                          className="border-white/10 bg-black/20"
                          value={draft?.revision ?? ""}
                          disabled={writeActionsDisabled}
                          onChange={(event) =>
                            updateDraft(part.id, (current) => ({
                              ...current,
                              revision: event.target.value || null,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Quantity</Label>
                        <Input
                          type="number"
                          min={1}
                          className="border-white/10 bg-black/20"
                          value={draft.quantity}
                          disabled={writeActionsDisabled}
                          onChange={(event) => {
                            const nextDraft = normalizeApprovedRequirementDraft({
                              ...draft,
                              quantity: Number(event.target.value || 1),
                            });
                            setQuoteQuantityInputs((current) => ({
                              ...current,
                              [part.id]: formatRequestedQuoteQuantitiesInput(nextDraft.quoteQuantities),
                            }));
                            updateDraft(part.id, () => nextDraft);
                          }}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Quote quantities</Label>
                        <Input
                          className="border-white/10 bg-black/20"
                          value={quoteQuantityInput}
                          disabled={writeActionsDisabled}
                          placeholder="1/10/100"
                          onChange={(event) =>
                            setQuoteQuantityInputs((current) => ({
                              ...current,
                              [part.id]: event.target.value,
                            }))
                          }
                          onBlur={() => {
                            const nextDraft = normalizeApprovedRequirementDraft({
                              ...draft,
                              quoteQuantities: parseRequestedQuoteQuantitiesInput(
                                quoteQuantityInputs[part.id] ?? "",
                                draft.quantity,
                              ),
                            });
                            setQuoteQuantityInputs((current) => ({
                              ...current,
                              [part.id]: formatRequestedQuoteQuantitiesInput(nextDraft.quoteQuantities),
                            }));
                            updateDraft(part.id, () => nextDraft);
                          }}
                        />
                        <p className="text-xs text-white/45">
                          Use slash-delimited quantities like 1/10/100.
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label>Requested by</Label>
                        <Input
                          type="date"
                          className="border-white/10 bg-black/20"
                          value={draft.requestedByDate ?? ""}
                          disabled={writeActionsDisabled}
                          onChange={(event) =>
                            updateDraft(part.id, (current) => ({
                              ...current,
                              requestedByDate: event.target.value || null,
                            }))
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label>Material</Label>
                        <Input
                          className="border-white/10 bg-black/20"
                          value={draft?.material ?? ""}
                          disabled={writeActionsDisabled}
                          onChange={(event) =>
                            updateDraft(part.id, (current) => ({
                              ...current,
                              material: event.target.value,
                            }))
                          }
                        />
                        <p className="text-xs text-white/45">
                          Extracted: {extraction.material.normalized || extraction.material.raw || "Not found"}
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label>Finish</Label>
                        <Input
                          className="border-white/10 bg-black/20"
                          value={draft?.finish ?? ""}
                          disabled={writeActionsDisabled}
                          onChange={(event) =>
                            updateDraft(part.id, (current) => ({
                              ...current,
                              finish: event.target.value || null,
                            }))
                          }
                        />
                        <p className="text-xs text-white/45">
                          Extracted: {extraction.finish.normalized || extraction.finish.raw || "Not found"}
                        </p>
                      </div>
                      <div className="space-y-2">
                        <Label>Tightest tolerance (inches)</Label>
                        <Input
                          type="number"
                          step="0.0001"
                          className="border-white/10 bg-black/20"
                          value={draft?.tightestToleranceInch ?? ""}
                          disabled={writeActionsDisabled}
                          onChange={(event) =>
                            updateDraft(part.id, (current) => ({
                              ...current,
                              tightestToleranceInch: event.target.value
                                ? Number(event.target.value)
                                : null,
                            }))
                          }
                        />
                        <p className="text-xs text-white/45">
                          Extracted: {extraction.tightestTolerance.raw || "Not found"}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="mt-5">
                    <Label>Applicable vendors</Label>
                    <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                      {vendors.map((vendor) => {
                        const checked = draft?.applicableVendors.includes(vendor) ?? false;

                        return (
                          <label
                            key={vendor}
                            className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/5 px-4 py-3 text-sm"
                          >
                            <Checkbox
                              checked={checked}
                              disabled={writeActionsDisabled}
                              onCheckedChange={(nextChecked) =>
                                updateDraft(part.id, (current) => ({
                                  ...current,
                                  applicableVendors: nextChecked
                                    ? [...current.applicableVendors, vendor]
                                    : current.applicableVendors.filter((item) => item !== vendor),
                                }))
                              }
                            />
                            <span>{formatVendorName(vendor)}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>

                  {extraction.evidence.length > 0 ? (
                    <div className="mt-5 rounded-2xl border border-white/8 bg-white/5 p-4">
                      <p className="text-sm font-medium">Evidence highlights</p>
                      <div className="mt-3 space-y-2 text-sm text-white/55">
                        {extraction.evidence.slice(0, 3).map((item, index) => (
                          <div key={`${item.field}-${index}`}>
                            <span className="font-medium text-white/75">{item.field}</span>
                            {`: page ${item.page}, confidence ${(item.confidence * 100).toFixed(0)}%, "${item.snippet}"`}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {extraction.warnings.length > 0 ? (
                    <div className="mt-5 rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4 text-sm text-amber-200">
                      {extraction.warnings.map((warning) => (
                        <p key={warning}>{warning}</p>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <ManualQuoteIntakeCard
            jobId={jobId}
            parts={job.parts}
            disabled={writeActionsDisabled}
          />

          {showDebugTools ? (
            <XometryDebugCard
              jobId={jobId}
              latestQuoteRun={latestQuoteRun}
              parts={job.parts}
              workQueue={job.workQueue}
              disabled={writeActionsDisabled}
            />
          ) : null}

          <Card className="border-white/10 bg-white/5">
            <CardHeader>
              <CardTitle>Publication readiness</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!latestQuoteRun ? (
                <p className="text-sm text-white/55">
                  Start a quote run after approving requirements to evaluate publication readiness.
                </p>
              ) : (
                <>
                  <div className="flex items-center justify-between rounded-2xl border border-white/8 bg-black/20 px-4 py-3">
                    <div>
                      <p className="font-medium">Latest quote run</p>
                      <p className="text-xs text-white/50">{latestQuoteRun.id}</p>
                    </div>
                    <Badge
                      variant="secondary"
                      className={
                        readinessQuery.data?.ready
                          ? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                          : "border border-amber-500/20 bg-amber-500/10 text-amber-300"
                      }
                    >
                      {readinessQuery.data?.ready ? "Auto-publish eligible" : "Internal approval required"}
                    </Badge>
                  </div>
                  <Textarea
                    className="min-h-28 border-white/10 bg-black/20"
                    value={clientSummary}
                    disabled={writeActionsDisabled}
                    onChange={(event) => setClientSummary(event.target.value)}
                    placeholder="Client-facing summary"
                  />
                  <div className="space-y-2 rounded-2xl border border-white/8 bg-black/20 p-4 text-sm text-white/55">
                    {readinessQuery.data?.reasons?.length ? (
                      readinessQuery.data.reasons.map((reason) => <p key={reason}>{reason}</p>)
                    ) : (
                      <p>No blocking readiness issues detected.</p>
                    )}
                  </div>
                  <Button
                    className="w-full rounded-full"
                    onClick={() => publishMutation.mutate()}
                    disabled={writeActionsDisabled || !latestQuoteRun || publishMutation.isPending}
                  >
                    {publishMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : readinessQuery.data?.ready ? (
                      <Rocket className="mr-2 h-4 w-4" />
                    ) : (
                      <Send className="mr-2 h-4 w-4" />
                    )}
                    {readinessQuery.data?.ready
                      ? "Publish client package"
                      : "Publish with internal approval"}
                  </Button>
                  {latestPackage ? (
                    <Button asChild variant="outline" className="w-full border-white/10 bg-white/5">
                      <Link to={`/client/packages/${latestPackage.id}`}>
                        Open latest client package
                        <ArrowUpRight className="ml-2 h-4 w-4" />
                      </Link>
                    </Button>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>

          <Card className="border-white/10 bg-white/5">
            <CardHeader>
              <CardTitle>Worker queue</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {job.workQueue.slice(0, 8).map((task) => (
                <div
                  key={task.id}
                  className="flex items-center justify-between rounded-2xl border border-white/8 bg-black/20 px-4 py-3 text-sm"
                >
                  <div>
                    <p className="font-medium">{formatStatusLabel(task.task_type)}</p>
                    <p className="text-xs text-white/50">{new Date(task.created_at).toLocaleString()}</p>
                  </div>
                  <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/75">
                    {formatStatusLabel(task.status)}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="mt-8">
        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Vendor compare view</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <RequestedQuantityFilter
              quantities={compareQuantities}
              value={activeCompareRequestedQuantity}
              onChange={setActiveCompareRequestedQuantity}
            />
            {!quoteRows.length ? (
              <p className="text-sm text-white/55">
                No vendor quote rows yet. Once the worker processes queued tasks, raw vendor results will appear here.
              </p>
            ) : visibleQuoteRows.length === 0 ? (
              <p className="text-sm text-white/55">
                No vendor quote rows are available for qty {activeCompareRequestedQuantity}.
              </p>
            ) : (
              visibleQuoteRows.map((quote) => {
                const part = job.parts.find((item) => item.id === quote.part_id);
                const importedOffers = getImportedVendorOffers(quote);
                const isManualVendor = isManualImportVendor(quote.vendor);
                const isManualIntake = hasManualQuoteIntakeSource(quote);
                return (
                  <div
                    key={quote.id}
                    className="rounded-3xl border border-white/8 bg-black/20 p-5"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div>
                        <p className="text-lg font-medium">{part?.name ?? "Unknown part"}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
                          <p className="text-white/50">{formatVendorName(quote.vendor)}</p>
                          <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/65">
                            Qty {quote.requested_quantity}
                          </Badge>
                          {isManualVendor ? (
                            <Badge className="border border-sky-500/20 bg-sky-500/10 text-sky-200">
                              Manual source
                            </Badge>
                          ) : null}
                          {isManualIntake ? (
                            <Badge className="border border-amber-500/20 bg-amber-500/10 text-amber-200">
                              Manual intake
                            </Badge>
                          ) : !isManualVendor ? (
                            <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/65">
                              Browser adapter
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                      <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/75">
                        {formatStatusLabel(quote.status)}
                      </Badge>
                    </div>
                    <Separator className="my-4 bg-white/10" />
                    <div className="grid gap-4 md:grid-cols-4">
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-white/40">Raw total</p>
                        <p className="mt-2 text-lg font-medium">{formatCurrency(quote.total_price_usd)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-white/40">Projected client</p>
                        <p className="mt-2 text-lg font-medium">
                          {formatCurrency(projectedClientPrice(quote.total_price_usd))}
                        </p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-white/40">Lead time</p>
                        <p className="mt-2 text-lg font-medium">{formatLeadTime(quote.lead_time_business_days)}</p>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.2em] text-white/40">Quote link</p>
                        {quote.quote_url ? (
                          <a
                            href={quote.quote_url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-flex items-center text-sm text-primary hover:underline"
                          >
                            Open vendor quote
                            <ArrowUpRight className="ml-1 h-4 w-4" />
                          </a>
                        ) : (
                          <p className="mt-2 text-sm text-white/50">Not available</p>
                        )}
                      </div>
                    </div>
                    {Array.isArray(quote.dfm_issues) && quote.dfm_issues.length > 0 ? (
                      <div className="mt-4 rounded-2xl border border-white/8 bg-white/5 p-4 text-sm text-white/55">
                        <p className="font-medium text-white">DFM issues</p>
                        {(quote.dfm_issues as string[]).map((issue) => (
                          <p key={issue} className="mt-2">
                            {issue}
                          </p>
                        ))}
                      </div>
                    ) : null}
                    {importedOffers.length > 0 ? (
                      <div className="mt-4 rounded-2xl border border-white/8 bg-white/5 p-4">
                        <div className="flex items-center justify-between gap-4">
                          <p className="text-sm font-medium text-white">Imported offer lanes</p>
                          <p className="text-xs text-white/45">
                            {importedOffers.length} option{importedOffers.length === 1 ? "" : "s"}
                          </p>
                        </div>
                        <div className="mt-4 grid gap-3">
                          {importedOffers.map((offer) => {
                            const laneLabel =
                              offer.laneLabel || [offer.sourcing, offer.tier].filter(Boolean).join(" / ");
                            const publishedOptionKinds = offer.id
                              ? optionKindsByOfferId.get(offer.id) ?? []
                              : [];
                            return (
                              <div
                                key={offer.offerId}
                                className="rounded-2xl border border-white/8 bg-black/20 p-4"
                              >
                                <div className="flex flex-wrap items-start justify-between gap-4">
                                  <div>
                                    <p className="font-medium text-white">
                                      {laneLabel || offer.supplier}
                                    </p>
                                    <div className="mt-2 flex flex-wrap gap-2 text-xs">
                                      {offer.quoteRef ? (
                                        <Badge
                                          variant="secondary"
                                          className="border border-white/10 bg-white/5 text-white/70"
                                        >
                                          Ref: {offer.quoteRef}
                                        </Badge>
                                      ) : null}
                                      {offer.shipReceiveBy ? (
                                        <Badge
                                          variant="secondary"
                                          className="border border-white/10 bg-white/5 text-white/70"
                                        >
                                          Ship/receive: {offer.shipReceiveBy}
                                        </Badge>
                                      ) : null}
                                      {offer.process ? (
                                        <Badge
                                          variant="secondary"
                                          className="border border-white/10 bg-white/5 text-white/70"
                                        >
                                          {offer.process}
                                        </Badge>
                                      ) : null}
                                      <Badge
                                        variant="secondary"
                                        className="border border-white/10 bg-white/5 text-white/70"
                                      >
                                        Qty {offer.requestedQuantity}
                                      </Badge>
                                      {publishedOptionKinds.map((kind) => (
                                        <Badge
                                          key={`${offer.offerId}-${kind}`}
                                          className="border border-primary/20 bg-primary/10 text-primary"
                                        >
                                          Published: {kind}
                                        </Badge>
                                      ))}
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-lg font-medium text-white">
                                      {formatCurrency(offer.totalPriceUsd)}
                                    </p>
                                    <p className="text-sm text-white/50">
                                      {formatLeadTime(offer.leadTimeBusinessDays)}
                                    </p>
                                  </div>
                                </div>
                                <div className="mt-4 grid gap-3 text-sm text-white/55 md:grid-cols-3">
                                  <div>
                                    <p className="text-xs uppercase tracking-[0.2em] text-white/35">Unit</p>
                                    <p className="mt-1 text-white/75">
                                      {formatCurrency(offer.unitPriceUsd)}
                                    </p>
                                  </div>
                                  <div>
                                    <p className="text-xs uppercase tracking-[0.2em] text-white/35">Material</p>
                                    <p className="mt-1 text-white/75">{offer.material || "N/A"}</p>
                                  </div>
                                  <div>
                                    <p className="text-xs uppercase tracking-[0.2em] text-white/35">Finish</p>
                                    <p className="mt-1 text-white/75">{offer.finish || "N/A"}</p>
                                  </div>
                                </div>
                                {offer.notes ? (
                                  <p className="mt-3 text-sm text-white/55">{offer.notes}</p>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </section>
    </AppShell>
  );
};

export default InternalJobDetail;
