import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical, Loader2, ScanSearch } from "lucide-react";
import { useLocation, useMatch, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  fetchJobAggregate,
  fetchPartDetailByJobId,
  fetchWorkerReadiness,
  resolveClientPartDetailRoute,
} from "@/features/quotes/api/internal-review";
import { isFixtureModeAvailable } from "@/features/quotes/client-workspace-fixtures";
import { useAppSession } from "@/hooks/use-app-session";
import { useDiagnosticsSnapshot } from "@/lib/diagnostics";
import { shouldShowExtractionLauncher } from "@/components/debug/extraction-launcher-visibility";

type ExtractionRouteContext =
  | { kind: "internal"; routeId: string; jobId: string }
  | { kind: "client-part"; routeId: string; jobId: string; source: "job" | "part" }
  | { kind: "none"; routeId: string | null; jobId: null };

function contextLabel(context: ExtractionRouteContext) {
  switch (context.kind) {
    case "internal":
      return `Internal job ${context.jobId}`;
    case "client-part":
      return context.source === "part"
        ? `Client part route resolved to job ${context.jobId}`
        : `Client part job ${context.jobId}`;
    default:
      return "No extractable job context on this route";
  }
}

let _openExtractionLauncher: (() => void) | null = null;

export function openExtractionLauncher() {
  _openExtractionLauncher?.();
}

export function ExtractionLauncher({ hideFloatingButton = false }: { hideFloatingButton?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const diagnostics = useDiagnosticsSnapshot();
  const { activeMembership } = useAppSession();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    _openExtractionLauncher = () => setOpen(true);
    return () => {
      _openExtractionLauncher = null;
    };
  }, []);
  const [manualRouteId, setManualRouteId] = useState("");
  const internalJobMatch = useMatch("/internal/jobs/:jobId");
  const clientPartReviewMatch = useMatch("/parts/:jobId/review");
  const clientPartMatch = useMatch("/parts/:jobId");
  const clientRouteId = clientPartReviewMatch?.params.jobId ?? clientPartMatch?.params.jobId ?? null;
  const fixtureLauncherVisible = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return isFixtureModeAvailable() && params.get("embed") !== "1";
  }, [location.search]);
  const showLauncher = shouldShowExtractionLauncher({
    membershipRole: activeMembership?.role ?? null,
    diagnosticsEnabled: diagnostics.enabled,
    isDev: import.meta.env.DEV,
  });

  const clientRouteQuery = useQuery({
    queryKey: ["extraction-launcher-route", clientRouteId],
    queryFn: () => resolveClientPartDetailRoute(clientRouteId ?? ""),
    enabled: open && Boolean(clientRouteId),
    retry: false,
  });

  const resolvedContext: ExtractionRouteContext = internalJobMatch?.params.jobId
    ? {
        kind: "internal",
        routeId: internalJobMatch.params.jobId,
        jobId: internalJobMatch.params.jobId,
      }
    : clientRouteQuery.data?.jobId
      ? {
          kind: "client-part",
          routeId: clientRouteId ?? clientRouteQuery.data.jobId,
          jobId: clientRouteQuery.data.jobId,
          source: clientRouteQuery.data.source,
        }
      : { kind: "none", routeId: clientRouteId, jobId: null };

  const internalJobQuery = useQuery({
    queryKey: ["extraction-launcher-job", resolvedContext.jobId],
    queryFn: () => fetchJobAggregate(resolvedContext.jobId ?? ""),
    enabled:
      open &&
      resolvedContext.kind === "internal" &&
      Boolean(resolvedContext.jobId) &&
      activeMembership?.role !== "client",
  });

  const clientPartQuery = useQuery({
    queryKey: ["extraction-launcher-part-detail", resolvedContext.jobId],
    queryFn: () => fetchPartDetailByJobId(resolvedContext.jobId ?? ""),
    enabled: open && resolvedContext.kind === "client-part" && Boolean(resolvedContext.jobId),
  });

  const workerReadinessQuery = useQuery({
    queryKey: ["worker-readiness"],
    queryFn: () => fetchWorkerReadiness(),
    enabled: open,
  });

  const actionJobId = resolvedContext.jobId;
  const openJobHref = actionJobId ? `/internal/jobs/${actionJobId}` : null;
  const canOpenInternalJob = Boolean(
    activeMembership && (activeMembership.role !== "client" || diagnostics.enabled || import.meta.env.DEV),
  );

  if (!showLauncher) {
    return null;
  }

  const handleOpenInternalJob = async () => {
    if (!canOpenInternalJob) {
      toast.error("The full internal job page is only available to internal users.");
      return;
    }

    if (openJobHref) {
      navigate(openJobHref);
      setOpen(false);
      return;
    }

    const candidate = manualRouteId.trim();

    if (!candidate) {
      toast.error("Enter a job or part ID first.");
      return;
    }

    try {
      const resolved = await resolveClientPartDetailRoute(candidate);

      if (!resolved) {
        throw new Error("That job or part could not be resolved.");
      }

      navigate(`/internal/jobs/${resolved.jobId}`);
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to resolve that job.");
    }
  };

  const isBusy =
    clientRouteQuery.isLoading ||
    internalJobQuery.isLoading ||
    clientPartQuery.isLoading ||
    workerReadinessQuery.isLoading;

  return (
    <>
      {!hideFloatingButton ? (
        <Button
          type="button"
          size="sm"
          className={`fixed right-4 z-40 w-fit gap-2 rounded-full border border-white/12 bg-[#111827]/92 text-white shadow-2xl hover:bg-[#1f2937] ${fixtureLauncherVisible ? "bottom-36" : "bottom-20"}`}
          onClick={() => setOpen(true)}
        >
          <ScanSearch className="h-4 w-4" />
          Extraction
        </Button>
      ) : null}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-[min(96vw,34rem)] overflow-y-auto border-white/10 bg-[#111827] p-0 text-white sm:max-w-[34rem]"
        >
          <div className="flex h-full flex-col">
            <SheetHeader className="border-b border-white/10 px-6 py-5 text-left">
              <SheetTitle className="flex items-center gap-2 text-white">
                <ScanSearch className="h-5 w-5" />
                Extraction
              </SheetTitle>
              <SheetDescription className="text-white/60">
                Route-aware entry point into the Extraction Lab.
              </SheetDescription>
            </SheetHeader>

            <div className="space-y-6 px-6 py-5">
              <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                    Route: {location.pathname}
                  </Badge>
                  <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                    {contextLabel(resolvedContext)}
                  </Badge>
                </div>
                {isBusy ? (
                  <div className="flex items-center gap-2 text-sm text-white/60">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Resolving extraction context…
                  </div>
                ) : null}
                {actionJobId ? (
                  <p className="text-sm text-white/75">
                    Job ID: <span className="font-mono text-xs">{actionJobId}</span>
                  </p>
                ) : (
                  <p className="text-sm text-white/60">
                    This route does not map to an extractable job automatically. Paste a job or part ID to jump into the internal job page.
                  </p>
                )}
              </div>

              <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-sm font-medium text-white">Worker status</p>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                    Build: {workerReadinessQuery.data?.workerBuildVersion ?? "Unknown"}
                  </Badge>
                  <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/70">
                    Model: {workerReadinessQuery.data?.drawingExtractionModel ?? "Unknown"}
                  </Badge>
                  <Badge
                    variant="secondary"
                    className={
                      workerReadinessQuery.data?.reachable
                        ? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                        : "border border-amber-500/20 bg-amber-500/10 text-amber-200"
                    }
                  >
                    {workerReadinessQuery.data?.reachable ? "Worker reachable" : "Worker unreachable"}
                  </Badge>
                </div>
                {workerReadinessQuery.data?.message ? (
                  <p className="text-xs text-white/55">{workerReadinessQuery.data.message}</p>
                ) : null}
              </div>

              <div className="space-y-3 rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-sm font-medium text-white">Open Extraction Lab</p>
                <div className="flex gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    className="border-white/10 bg-transparent text-white hover:bg-white/6"
                    onClick={handleOpenInternalJob}
                  >
                    <FlaskConical className="mr-2 h-4 w-4" />
                    Open lab
                  </Button>
                </div>
                {canOpenInternalJob && !actionJobId ? (
                  <div className="space-y-2">
                    <Label htmlFor="extraction-launcher-job-input" className="text-white">
                      Job or part ID
                    </Label>
                    <Input
                      id="extraction-launcher-job-input"
                      value={manualRouteId}
                      onChange={(event) => setManualRouteId(event.target.value)}
                      placeholder="Paste a job ID or part ID"
                      className="border-white/10 bg-white/5 text-white placeholder:text-white/35"
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
