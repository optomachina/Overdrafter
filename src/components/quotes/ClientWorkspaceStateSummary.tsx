import type {
  ClientWorkspaceState,
  ClientWorkspaceStateReason,
  ClientWorkspaceStateTone,
} from "@/features/quotes/client-workspace-state";
import { cn } from "@/lib/utils";

function toneClasses(tone: ClientWorkspaceStateTone) {
  switch (tone) {
    case "ready":
      return {
        badge: "border-emerald-400/20 bg-emerald-500/10 text-emerald-100",
        panel: "border-emerald-400/20 bg-emerald-500/8",
      };
    case "warning":
      return {
        badge: "border-amber-400/20 bg-amber-500/10 text-amber-100",
        panel: "border-amber-400/20 bg-amber-500/8",
      };
    case "blocked":
    default:
      return {
        badge: "border-rose-400/20 bg-rose-500/10 text-rose-100",
        panel: "border-rose-400/20 bg-rose-500/8",
      };
  }
}

export function ClientWorkspaceToneBadge({
  tone,
  label,
  className,
}: {
  tone: ClientWorkspaceStateTone;
  label?: string;
  className?: string;
}) {
  const classes = toneClasses(tone);

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium tracking-[0.12em] uppercase",
        classes.badge,
        className,
      )}
    >
      {label ?? (tone === "ready" ? "Ready" : tone === "warning" ? "Warning" : "Blocked")}
    </span>
  );
}

function ReasonRow({ reason }: { reason: ClientWorkspaceStateReason }) {
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-white/8 bg-black/20 px-3 py-3">
      <ClientWorkspaceToneBadge tone={reason.tone} className="shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-white">{reason.label}</p>
        <p className="mt-1 text-xs text-white/60">{reason.detail}</p>
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
  const classes = toneClasses(state.tone);
  const visibleReasons = state.reasons.slice(0, maxReasons);

  return (
    <div className={cn("rounded-[24px] border p-4", classes.panel, className)}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <ClientWorkspaceToneBadge tone={state.tone} />
            <p className="text-sm font-medium text-white">{state.selection.label}</p>
          </div>
          <p className="mt-2 text-sm text-white/70">{state.selection.detail}</p>
        </div>
        <p className="text-xs uppercase tracking-[0.18em] text-white/40">Client workspace state</p>
      </div>

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
