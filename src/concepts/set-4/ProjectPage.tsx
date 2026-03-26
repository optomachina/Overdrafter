import { FolderOpen, Package, DollarSign, FileText, CheckCircle2, Upload, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PROJECTS, MOCK_PARTS, MOCK_ACTIVITY, formatRelativeTime, type ActivityType, type PartStatus } from "@/concepts/mock-data";

const STATUS_COLORS: Record<PartStatus, string> = {
  quoted: "bg-emerald-400/15 text-emerald-400 border-emerald-400/25",
  selected: "bg-sky-400/15 text-sky-400 border-sky-400/25",
  requesting: "bg-yellow-400/15 text-yellow-400 border-yellow-400/25",
  needs_attention: "bg-rose-400/15 text-rose-400 border-rose-400/25",
};

const ACTIVITY_ICONS: Record<ActivityType, typeof Upload> = {
  quote_received: DollarSign,
  spec_updated: FileText,
  file_uploaded: Upload,
  selection_made: CheckCircle2,
};

function Sidebar() {
  return (
    <div className="flex flex-col gap-0.5 p-2 pt-3">
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Projects</p>
      {MOCK_PROJECTS.map((p, i) => (
        <button key={p.id} type="button"
          className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-white/[0.06] ${i === 0 ? "text-white font-medium bg-white/[0.05]" : "text-white/60"}`}>
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-white/40" />
          <span className="truncate">{p.name}</span>
        </button>
      ))}
    </div>
  );
}

const project = MOCK_PROJECTS[0];

function TimelineEvent({ event, isLast }: { event: typeof MOCK_ACTIVITY[0]; isLast: boolean }) {
  const Icon = ACTIVITY_ICONS[event.type];
  return (
    <div className={`relative pl-8 ${!isLast ? "pb-4" : ""}`}>
      {!isLast && <div className="absolute left-3.5 top-6 bottom-0 w-0.5 bg-orange-400/15" />}
      <div className="absolute left-2 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-orange-400/10 border border-orange-400/20">
        <Icon className="h-2.5 w-2.5 text-orange-400" />
      </div>
      <p className="text-[12px] leading-5 text-white/65">{event.message}</p>
      <p className="mt-0.5 text-[10px] text-white/30">{event.actor} · {formatRelativeTime(event.timestamp)}</p>
    </div>
  );
}

function PartRow({ part }: { part: typeof MOCK_PARTS[0] }) {
  const partEvents = MOCK_ACTIVITY.slice(0, 2);
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-ws-card overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <Package className="h-4 w-4 shrink-0 text-white/40" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12px] text-orange-400/80">{part.partNumber}</span>
            <span className="text-sm font-medium text-white/85">{part.name}</span>
          </div>
          <p className="mt-0.5 text-[11px] text-white/40">{part.material}</p>
        </div>
        <Badge className={`shrink-0 border text-[10px] ${STATUS_COLORS[part.status]}`}>{part.status.replace("_", " ")}</Badge>
        <span className="shrink-0 font-mono text-sm font-semibold text-white">{part.bestPrice != null ? `$${part.bestPrice}` : "—"}</span>
        <button type="button" className="text-white/30 hover:text-white/60 transition">
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
      <div className="border-t border-white/[0.04] px-4 py-3 space-y-2 bg-white/[0.01]">
        {partEvents.map((e, i) => <TimelineEvent key={e.id} event={e} isLast={i === partEvents.length - 1} />)}
      </div>
    </div>
  );
}

export function Set4ProjectPage() {
  return (
    <ConceptShell sidebarContent={<Sidebar />} headerTitle={project.name} headerBreadcrumb="Workspace">
      <div className="p-5 space-y-4">
        <div className="rounded-2xl border border-orange-400/15 bg-orange-400/[0.05] px-5 py-4">
          <h2 className="text-xl font-semibold text-white">{project.name}</h2>
          <p className="mt-1 text-sm text-white/50">{project.partCount} parts · {project.quotedCount} quoted · Updated {project.updatedAt}</p>
          <div className="relative mt-4 pl-5 space-y-0">
            <div className="absolute left-2 top-1 bottom-1 w-0.5 bg-orange-400/20" />
            {MOCK_ACTIVITY.slice(0, 3).map((e, i, arr) => (
              <TimelineEvent key={e.id} event={e} isLast={i === arr.length - 1} />
            ))}
          </div>
        </div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Parts</p>
        {MOCK_PARTS.map((p) => <PartRow key={p.id} part={p} />)}
      </div>
    </ConceptShell>
  );
}
