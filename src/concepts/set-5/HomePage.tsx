import { AlertTriangle, FolderOpen, Activity } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PROJECTS, MOCK_PARTS, getStatusLabel, type PartStatus, type ProjectStatus } from "@/concepts/mock-data";

const STATUS_BG: Record<PartStatus, string> = {
  quoted: "bg-emerald-400",
  selected: "bg-sky-400",
  requesting: "bg-yellow-400",
  needs_attention: "bg-rose-500",
};

const STATUS_ALERT_COLOR: Record<PartStatus, string> = {
  quoted: "border-emerald-400/20 bg-emerald-400/10 text-emerald-400",
  selected: "border-sky-400/20 bg-sky-400/10 text-sky-400",
  requesting: "border-yellow-400/20 bg-yellow-400/10 text-yellow-400",
  needs_attention: "border-rose-400/30 bg-rose-500/15 text-rose-400",
};

const PROJ_STATUS_COLORS: Record<ProjectStatus, string> = {
  active: "bg-emerald-400/15 text-emerald-400 border-emerald-400/25",
  review: "bg-yellow-400/15 text-yellow-400 border-yellow-400/25",
  archived: "bg-neutral-500/15 text-neutral-400 border-neutral-500/25",
};

function Sidebar() {
  return (
    <div className="flex flex-col gap-0.5 p-2 pt-3">
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Navigation</p>
      {[
        { Icon: Activity, label: "Dashboard", active: true },
        { Icon: FolderOpen, label: "Projects" },
        { Icon: AlertTriangle, label: "Alerts", badge: "2" },
      ].map(({ Icon, label, active, badge }) => (
        <button key={label} type="button"
          className={`flex items-center justify-between rounded-lg px-2 py-2 text-left text-sm transition hover:bg-white/[0.06] ${active ? "bg-pink-500/[0.10] text-pink-400" : "text-white/60"}`}>
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

function HealthBar() {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-ws-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Part Health — All Projects</p>
        <span className="text-[11px] text-white/35">{MOCK_PARTS.length} parts total</span>
      </div>
      <div className="flex h-5 w-full overflow-hidden rounded-full bg-white/[0.06]">
        {MOCK_PARTS.map((p) => (
          <div key={p.id} title={`${p.partNumber}: ${p.status}`}
            className={`h-full flex-1 first:rounded-l-full last:rounded-r-full ${STATUS_BG[p.status]} border-r border-[rgba(0,0,0,0.3)] last:border-0`} />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px]">
        {(["quoted", "selected", "requesting", "needs_attention"] as PartStatus[]).map((s) => {
          const count = MOCK_PARTS.filter((p) => p.status === s).length;
          if (count === 0) return null;
          return (
            <div key={s} className="flex items-center gap-1.5">
              <div className={`h-2 w-2 rounded-full ${STATUS_BG[s]}`} />
              <span className="text-white/50">{getStatusLabel(s)}: {count}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AlertList() {
  const alertParts = MOCK_PARTS.filter((p) => p.status === "needs_attention" || p.status === "requesting")
    .sort((a) => a.status === "needs_attention" ? -1 : 1);

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Alerts — Action Required</p>
      {alertParts.map((p) => (
        <div key={p.id} className={`flex items-center gap-3 rounded-2xl border p-4 ${STATUS_ALERT_COLOR[p.status]}`}>
          <AlertTriangle className={`h-4 w-4 shrink-0 ${p.status === "needs_attention" ? "text-rose-400" : "text-yellow-400"}`} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[12px]">{p.partNumber}</span>
              <span className="text-sm font-medium text-white/85">{p.name}</span>
            </div>
            <p className="mt-0.5 text-[11px] opacity-70">{p.status === "needs_attention" ? "Spec conflict — review required before quotes can proceed" : "Quote request sent — awaiting vendor responses"}</p>
          </div>
          <Badge className={`shrink-0 border ${STATUS_ALERT_COLOR[p.status]} text-[10px]`}>{getStatusLabel(p.status)}</Badge>
        </div>
      ))}
    </div>
  );
}

function ProjectStatusGrid() {
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Project Status</p>
      <div className="grid grid-cols-2 gap-3">
        {MOCK_PROJECTS.map((proj) => {
          const projParts = MOCK_PARTS.filter((p) => p.projectId === proj.id);
          return (
            <div key={proj.id} className="rounded-2xl border border-white/[0.08] bg-ws-card p-4 hover:bg-ws-raised transition cursor-pointer">
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium text-white/85 leading-tight">{proj.name}</p>
                <Badge className={`shrink-0 border text-[10px] ${PROJ_STATUS_COLORS[proj.status]}`}>{proj.status}</Badge>
              </div>
              {projParts.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {projParts.map((p) => (
                    <div key={p.id} title={`${p.partNumber}: ${p.status}`}
                      className={`h-3 w-3 rounded-full ${STATUS_BG[p.status]}`} />
                  ))}
                </div>
              )}
              <p className="mt-2 text-[11px] text-white/35">{proj.quotedCount}/{proj.partCount} quoted · ${proj.totalValue > 0 ? proj.totalValue.toLocaleString() : "—"}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Set5HomePage() {
  return (
    <ConceptShell sidebarContent={<Sidebar />} headerTitle="Signal Dashboard" headerBreadcrumb="OverDrafter">
      <div className="p-5 space-y-5">
        <HealthBar />
        <div className="grid grid-cols-2 gap-5">
          <AlertList />
          <ProjectStatusGrid />
        </div>
      </div>
    </ConceptShell>
  );
}
