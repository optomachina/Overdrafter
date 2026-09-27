import { useEffect, useState } from "react";
import { Box } from "lucide-react";
import { CadModelThumbnail } from "@/components/CadModelThumbnail";
import { supabase } from "@/integrations/supabase/client";
import { readExactStepReview, type StepReviewResult } from "./exact-step-review";

type Scope = Readonly<{
  conversationId: string; organizationId: string; projectId: string;
  ownerId: string; candidateSnapshotId: string;
}>;
type View = { status: "loading" } | { status: "unavailable"; reason: string }
  | { status: "ready"; review: Extract<StepReviewResult, { status: "ready" }>["review"] };

/** Current finalized STEP only. Any failed or late read leaves geometry unavailable. */
export function EngineeringStepReview(scope: Scope) {
  const [view, setView] = useState<View>({ status: "loading" });
  useEffect(() => {
    let active = true;
    setView({ status: "loading" });
    void (async () => {
      try {
        const latest = await supabase.from("engineering_tasks")
          .select("id,conversation_id,organization_id,project_id,owner_user_id,execution_state,verification_state")
          .eq("conversation_id", scope.conversationId)
          .eq("organization_id", scope.organizationId)
          .eq("project_id", scope.projectId)
          .eq("owner_user_id", scope.ownerId)
          .eq("execution_state", "succeeded").eq("verification_state", "passed")
          .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(1);
        if (!active) return;
        if (latest.error || !Array.isArray(latest.data)) throw new Error("Task read unavailable.");
        const task = latest.data[0];
        if (!task) {
          setView({ status: "unavailable", reason: "No candidate result has been verified for this conversation." });
          return;
        }
        if (task.conversation_id !== scope.conversationId || task.organization_id !== scope.organizationId
          || task.project_id !== scope.projectId || task.owner_user_id !== scope.ownerId
          || task.execution_state !== "succeeded" || task.verification_state !== "passed") {
          throw new Error("Task scope changed.");
        }
        const result = await readExactStepReview(scope.conversationId, task.id, scope.candidateSnapshotId);
        if (!active) return;
        if (result.status === "unavailable") {
          setView({ status: "unavailable", reason: result.reason === "not_verified"
            ? "The latest native result has not established verified candidate geometry."
            : "The finalized candidate has no verified STEP export yet." });
          return;
        }
        setView({ status: "ready", review: result.review });
      } catch {
        if (active) setView({ status: "unavailable",
          reason: "Verified geometry is unavailable. Refresh the conversation to check its current result." });
      }
    })();
    return () => { active = false; };
  }, [scope.conversationId, scope.organizationId, scope.projectId,
    scope.ownerId, scope.candidateSnapshotId]);

  if (view.status !== "ready") {
    return <section aria-label="Exact STEP review" className="flex h-full min-h-[360px] flex-col items-center justify-center px-6 text-center">
      <Box aria-hidden="true" className="mb-4 size-9 text-muted-foreground/60" strokeWidth={1.2} />
      <h2 className="text-base font-medium">{view.status === "loading" ? "Checking candidate geometry" : "Candidate geometry unavailable"}</h2>
      <p aria-live="polite" className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
        {view.status === "loading" ? "Checking the current finalized result and exact STEP export…" : view.reason}
      </p>
    </section>;
  }
  return <section aria-label="Exact STEP review" className="flex h-full min-h-[360px] flex-col">
    <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm sm:px-8">
      <h2 className="font-medium">Verified candidate geometry</h2>
      <span className="text-xs text-muted-foreground">Exact native STEP export</span>
    </div>
    <CadModelThumbnail source={view.review.source} autoRotate={false}
      className="min-h-[220px] flex-1 !rounded-none !border-0 !bg-[linear-gradient(160deg,#eef0ed,#d8ddda)]" />
    <details className="px-5 py-3 text-xs text-muted-foreground sm:px-8">
      <summary className="cursor-pointer">Exact result binding</summary>
      <p className="mt-2 break-all">STEP SHA-256: {view.review.stepSha256}</p>
      <p className="break-all">Candidate snapshot: {view.review.candidateSnapshotId}</p>
      <p className="break-all">Source snapshot: {view.review.sourceSnapshotId}</p>
      <p>Preview geometry is read-only; finalizing a native result does not adopt a candidate.</p>
    </details>
  </section>;
}
