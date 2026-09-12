import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

type Scope = Readonly<{ conversationId: string; organizationId: string; projectId: string; ownerId: string }>;
type Observation = { id: string; sequence: number; execution: string; verification: string };
type Status = "loading" | "current" | "stale" | "paused";
type View = { scope: string; rows: Observation[]; status: Status; observedAt: number | null };
const executionLabels = { blocked: "Blocked", queued: "Queued", running: "Running", succeeded: "Succeeded", failed: "Failed", canceled: "Canceled" };
const verificationLabels = { unverified: "Unverified", checking: "Checking", passed: "Passed", failed: "Failed", stale: "Stale" };

function tabVisible(): boolean { return document.visibilityState !== "hidden"; }

function observations(value: unknown): Observation[] {
  if (!Array.isArray(value) || value.length > 25) throw new Error("Invalid observations");
  const ids = new Set<string>();
  const sequences = new Set<number>();
  return value.map((row) => {
    const sequence = row?.engineering_decisions?.sequence;
    if (!row || typeof row.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(row.id)
      || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1
      || typeof row.execution_state !== "string" || !Object.prototype.hasOwnProperty.call(executionLabels, row.execution_state)
      || typeof row.verification_state !== "string" || !Object.prototype.hasOwnProperty.call(verificationLabels, row.verification_state)
      || row.adoption_state !== "unadopted" || (row.verification_state === "passed" && row.execution_state !== "succeeded")
      || ids.has(row.id) || sequences.has(sequence)) throw new Error("Invalid observations");
    ids.add(row.id); sequences.add(sequence);
    return { id: row.id, sequence, execution: executionLabels[row.execution_state as keyof typeof executionLabels], verification: verificationLabels[row.verification_state as keyof typeof verificationLabels] };
  });
}

/** Read-only task observations. Polling cannot advance conversation context, retry a request or launch CAD. */
export function EngineeringTaskStatus({ conversationId, organizationId, projectId, ownerId }: Scope) {
  const scope = JSON.stringify([conversationId, organizationId, projectId, ownerId]);
  const [view, setView] = useState<View | null>(null);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let nextRead: ReturnType<typeof setTimeout>;
    let cancelRead: (() => void) | null = null;
    setView({ scope, rows: [], status: "loading", observedAt: null });

    async function refresh() {
      if (!active || inFlight || !tabVisible()) return;
      clearTimeout(nextRead);
      inFlight = true;
      const controller = new AbortController();
      let deadline: ReturnType<typeof setTimeout>;
      const bounded = new Promise<null>((resolve) => {
        cancelRead = () => { resolve(null); controller.abort(); };
        deadline = setTimeout(cancelRead, 10_000);
      });
      try {
        const response = await Promise.race([
          supabase.from("engineering_tasks")
            .select("id,execution_state,verification_state,adoption_state,engineering_decisions!inner(sequence)")
            .eq("conversation_id", conversationId).eq("organization_id", organizationId)
            .eq("project_id", projectId).eq("owner_user_id", ownerId)
            .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(25)
            .abortSignal(controller.signal),
          bounded,
        ]);
        if (!active || !tabVisible()) return;
        if (response?.status === 401 || response?.status === 403 || response?.error?.code === "42501") {
          setView({ scope, rows: [], status: "stale", observedAt: null });
          return;
        }
        if (!response || response.error) throw new Error("Unavailable");
        const rows = observations(response.data);
        setView({ scope, rows, status: "current", observedAt: Date.now() });
      } catch {
        if (active && tabVisible()) setView((previous) => ({
          scope, rows: previous?.scope === scope ? previous.rows : [], status: "stale",
          observedAt: previous?.scope === scope ? previous.observedAt : null,
        }));
      } finally {
        clearTimeout(deadline);
        cancelRead = null;
        inFlight = false;
        if (active && tabVisible()) nextRead = setTimeout(() => void refresh(), 5000);
      }
    }

    function visibilityChanged() {
      clearTimeout(nextRead);
      if (!tabVisible()) {
        cancelRead?.();
        setView((previous) => previous?.scope === scope ? { ...previous, status: "paused" } : previous);
      } else {
        void refresh();
      }
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    void refresh();
    return () => { active = false; clearTimeout(nextRead); cancelRead?.(); document.removeEventListener("visibilitychange", visibilityChanged); };
  }, [scope, conversationId, organizationId, projectId, ownerId]);

  const current = view?.scope === scope ? view : null;
  let summary = "Checking accepted changes…";
  if (current?.status === "current") summary = "Latest observed change states.";
  if (current?.status === "paused") summary = "Updates paused while this tab is hidden.";
  if (current?.status === "stale") summary = current.observedAt === null ? "Change status unavailable." : "Update unavailable. Showing last observed states.";

  return <section aria-label="Accepted change status" className="space-y-3 border-t border-border pt-4 text-sm">
    <h2 className="font-medium">Accepted changes</h2>
    <p aria-live="polite" className="text-xs text-muted-foreground">{summary}</p>
    {current?.observedAt !== null && current?.observedAt !== undefined && <p className="text-xs text-muted-foreground">Last checked {new Date(current.observedAt).toLocaleTimeString()}. Up to 25 most recent changes.</p>}
    {current?.status === "current" && current.rows.length === 0 && <p>No accepted changes are visible yet.</p>}
    {current?.rows.map((row) => <article key={row.id} aria-label={`Change ${row.sequence}`} className="space-y-2 border-b border-border pb-3">
      <h3>Change {row.sequence}</h3>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div><dt className="text-muted-foreground">Execution</dt><dd>{row.execution}</dd></div>
        <div><dt className="text-muted-foreground">Verification</dt><dd>{row.verification}</dd></div>
        <div><dt className="text-muted-foreground">Adoption</dt><dd>Not adopted</dd></div>
      </dl>
    </article>)}
  </section>;
}
