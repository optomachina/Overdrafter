import { AlertTriangle, FolderOpen, Activity, CheckCircle2, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PROJECTS, MOCK_PARTS, getStatusLabel, type PartStatus } from "@/concepts/mock-data";

const STATUS_BG: Record<PartStatus, string> = {
  quoted: "bg-emerald-400",
  selected: "bg-sky-400",
  requesting: "bg-yellow-400",
  needs_attention: "bg-rose-500",
};

const STATUS_BORDER: Record<PartStatus, string> = {
  quoted: "border-emerald-400/20 bg-emerald-400/[0.05]",
  selected: "border-sky-400/20 bg-sky-400/[0.05]",
  requesting: "border-yellow-400/20 bg-yellow-400/[0.05]",
  needs_attention: "border-rose-400/25 bg-rose-500/[0.08]",
};

const STATUS_BADGE: Record<PartStatus, string> = {
  quoted: "border-emerald-400/25 bg-emerald-400/15 text-emerald-400",
  selected: "border-sky-400/25 bg-sky-400/15 text-sky-400",
  requesting: "border-yellow-400/25 bg-yellow-400/15 text-yellow-400",
  needs_attention: "border-rose-400/30 bg-rose-500/15 text-rose-400",
};

function Sidebar() {
  return (
    <div className="flex flex-col gap-0.5 p-2 pt-3">
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Navigation</p>
      {[{ Icon: Activity, label: "Dashboard" }, { Icon: FolderOpen, label: "Projects", active: true }, { Icon: AlertTriangle, label: "Alerts", badge: "2" }].map(({ Icon, label, active, badge }) => (
        <button key={label} type="button"
          className={`flex items-center justify-between rounded-lg px-2 py-2 text-left text-sm hover:bg-white/[0.06] ${active ? "bg-pink-500/[0.10] text-pink-400" : "text-white/60"}`}>
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </div>
          {badge && <span className="rounded-full bg-rose-500/20 px-1.5 py-0.5 font-mono text-[10px] text-rose-400">{badge}</span>}
        </button>
      ))}
    </div>
  );
}

const project = MOCK_PROJECTS[0];
const projParts = MOCK_PARTS;

function HealthScore() {
  const quoted = projParts.filter((p) => p.status === "quoted" || p.status === "selected").length;
  const total = projParts.length;
  const attention = projParts.filter((p) => p.status === "needs_attention").length;

  return (
    <div className="flex items-center gap-4 rounded-2xl border border-pink-400/15 bg-pink-500/[0.06] px-5 py-4">
      <div className="flex-1">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-pink-400/60">Project Health Score</p>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="font-mono text-4xl font-semibold text-white">{quoted}/{total}</span>
          <span className="text-sm text-white/40">parts quoted</span>
        </div>
      </div>
      {attention > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-rose-400/20 bg-rose-500/[0.10] px-3 py-2">
          <AlertTriangle className="h-4 w-4 text-rose-400" />
          <span className="text-sm font-medium text-rose-400">{attention} need attention</span>
        </div>
      )}
    </div>
  );
}

function PartStatusCard({ part }: { part: typeof MOCK_PARTS[0] }) {
  return (
    <div className={`rounded-2xl border p-4 hover:brightness-110 transition cursor-pointer ${STATUS_BORDER[part.status]}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <span className="font-mono text-[12px] text-white/60">{part.partNumber}</span>
          <p className="mt-0.5 text-sm font-medium text-white/90 leading-tight">{part.name}</p>
        </div>
        <div className={`h-2.5 w-2.5 shrink-0 rounded-full mt-1 ${STATUS_BG[part.status]}`} />
      </div>
      <div className="mt-3">
        <Badge className={`border text-[10px] ${STATUS_BADGE[part.status]}`}>{getStatusLabel(part.status)}</Badge>
      </div>
      {part.status === "needs_attention" && (
        <p className="mt-2 text-[11px] text-rose-400/70">Spec conflict — action required</p>
      )}
      <div className="mt-3 flex items-center gap-3 text-[11px] text-white/40">
        {part.bestPrice != null ? (
          <div className="flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3 text-emerald-400" />
            <span className="font-mono">${part.bestPrice}</span>
          </div>
        ) : null}
        {part.leadTimeDays != null ? (
          <div className="flex items-center gap-1">
            <Clock className="h-3 w-3 text-white/30" />
            <span>{part.leadTimeDays}d</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Set5ProjectPage() {
  return (
    <ConceptShell sidebarContent={<Sidebar />} headerTitle={project.name} headerBreadcrumb="Workspace">
      <div className="p-5 space-y-5">
        <HealthScore />
        <div>
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Part Status</p>
          <div className="grid grid-cols-3 gap-3">
            {projParts.map((p) => <PartStatusCard key={p.id} part={p} />)}
          </div>
        </div>
      </div>
    </ConceptShell>
  );
}
