import { STATUS_TONE } from "@/components/quotes/status-tone";
import type {
  ClientWorkspaceState,
  ClientWorkspaceStateReason,
  ClientWorkspaceStateTone,
} from "@/features/quotes/client-workspace-state";
import { cn } from "@/lib/utils";

export function ClientWorkspaceToneBadge({
  tone,
  label,
  className,
}: {
  tone: ClientWorkspaceStateTone;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-[0.12em] uppercase",
        STATUS_TONE.state,
        className,
      )}
    >
      {label ?? (tone === "ready" ? "Ready" : tone === "warning" ? "Warning" : "Blocked")}
    </span>
  );
}

function ReasonRow({ reason }: { reason: ClientWorkspaceStateReason }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-border bg-muted px-3 py-3">
      <ClientWorkspaceToneBadge tone={reason.tone} className="shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{reason.label}</p>
        <p className="mt-1 text-xs text-muted-foreground">{reason.detail}</p>
      </div>
    </div>
  );
}

export function ClientWorkspaceStateSummary({
  state,
  className,
  maxReasons = 3,
}: {
  state: ClientWorkspaceState;
  className?: string;
  maxReasons?: number;
}) {
  const visibleReasons = state.reasons.slice(0, maxReasons);

  return (
    <div className={cn("rounded-surface-lg border p-4", STATUS_TONE.surface, className)}>
      <div className="flex flex-wrap items-center gap-2">
        <ClientWorkspaceToneBadge tone={state.tone} />
        <p className="text-sm font-medium text-foreground">{state.selection.label}</p>
      </div>
      <p className="mt-2 text-sm text-foreground">{state.selection.detail}</p>

      {visibleReasons.length > 0 ? (
        <div className="mt-4 grid gap-3">
          {visibleReasons.map((reason) => (
            <ReasonRow key={reason.id} reason={reason} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
