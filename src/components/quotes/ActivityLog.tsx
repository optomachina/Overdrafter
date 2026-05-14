import { ChevronDown, CircleDashed, Info, Sparkles } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type ActivityLogEntry = {
  id: string;
  label: string;
  detail?: string | null;
  occurredAt?: string | null;
  tone?: "default" | "active" | "attention";
};

type ActivityLogProps = {
  entries: readonly ActivityLogEntry[];
  className?: string;
  title?: string;
  emptyState?: string;
};

function toneClasses(tone: ActivityLogEntry["tone"]): string {
  switch (tone) {
    case "active":
      return "border-emerald-400/20 bg-emerald-500/8 text-emerald-100";
    case "attention":
      return "border-amber-400/20 bg-amber-500/8 text-amber-100";
    case "default":
    default:
      return "border-border bg-muted text-foreground/80";
  }
}

function toneIcon(tone: ActivityLogEntry["tone"]) {
  switch (tone) {
    case "active":
      return Sparkles;
    case "attention":
      return Info;
    case "default":
    default:
      return CircleDashed;
  }
}

function formatOccurredAt(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.valueOf()) ? null : parsed.toLocaleString();
}

export function ActivityLog({
  entries,
  className,
  title = "Activity",
  emptyState = "No notable system activity yet.",
}: ActivityLogProps) {
  return (
    <section className={cn("rounded-surface-lg border border-border bg-ws-card p-5", className)}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">{title}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            Recent workflow milestones backed by curated audit and worker events.
          </p>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">{emptyState}</p>
      ) : (
        <div className="mt-4 space-y-3">
          {entries.map((entry) => {
            const Icon = toneIcon(entry.tone);
            const occurredAtLabel = formatOccurredAt(entry.occurredAt);

            return (
              <Collapsible key={entry.id}>
                <div className={cn("rounded-2xl border px-4 py-3", toneClasses(entry.tone))}>
                  <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 text-left">
                    <div className="flex items-center gap-3">
                      <div className="rounded-full border border-border bg-accent p-2 text-foreground/80">
                        <Icon className="h-3.5 w-3.5" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">{entry.label}</p>
                        {occurredAtLabel ? (
                          <p className="mt-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                            {occurredAtLabel}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    {entry.detail ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : null}
                  </CollapsibleTrigger>
                  {entry.detail ? (
                    <CollapsibleContent>
                      <p className="mt-3 pl-11 text-sm leading-6 text-muted-foreground">{entry.detail}</p>
                    </CollapsibleContent>
                  ) : null}
                </div>
              </Collapsible>
            );
          })}
        </div>
      )}
    </section>
  );
}
