import { ChevronDown, CircleDashed, Info, Sparkles } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

export type ActivityLogEntry = {
  id: string;
  label: string;
  detail?: string | null;
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
      return "border-white/10 bg-black/20 text-white/78";
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

export function ActivityLog({
  entries,
  className,
  title = "Activity",
  emptyState = "No notable system activity yet.",
}: ActivityLogProps) {
  return (
    <section className={cn("rounded-[24px] border border-white/8 bg-[#262626] p-5", className)}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">{title}</p>
          <p className="mt-2 text-sm text-white/55">
            High-level processing status for extraction, quote matching, and selection filters.
          </p>
        </div>
      </div>

      {entries.length === 0 ? (
        <p className="mt-4 text-sm text-white/45">{emptyState}</p>
      ) : (
        <div className="mt-4 space-y-3">
          {entries.map((entry) => {
            const Icon = toneIcon(entry.tone);

            return (
              <Collapsible key={entry.id}>
                <div className={cn("rounded-2xl border px-4 py-3", toneClasses(entry.tone))}>
                  <CollapsibleTrigger className="flex w-full items-center justify-between gap-3 text-left">
                    <div className="flex items-center gap-3">
                      <div className="rounded-full border border-white/10 bg-white/6 p-2 text-white/70">
                        <Icon className="h-3.5 w-3.5" />
                      </div>
                      <p className="text-sm font-medium">{entry.label}</p>
                    </div>
                    {entry.detail ? <ChevronDown className="h-4 w-4 text-white/45" /> : null}
                  </CollapsibleTrigger>
                  {entry.detail ? (
                    <CollapsibleContent>
                      <p className="mt-3 pl-11 text-sm leading-6 text-white/55">{entry.detail}</p>
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
