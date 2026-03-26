import { FolderOpen, Package, AlertTriangle, DollarSign, FileText, CheckCircle2, Upload } from "lucide-react";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PROJECTS, MOCK_PARTS, MOCK_ACTIVITY, formatRelativeTime, type ActivityType } from "@/concepts/mock-data";

const ACTIVITY_CONFIG: Record<ActivityType, { Icon: typeof Upload; color: string; label: string }> = {
  quote_received: { Icon: DollarSign, color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20", label: "Quote" },
  spec_updated: { Icon: FileText, color: "text-yellow-400 bg-yellow-400/10 border-yellow-400/20", label: "Spec" },
  file_uploaded: { Icon: Upload, color: "text-sky-400 bg-sky-400/10 border-sky-400/20", label: "File" },
  selection_made: { Icon: CheckCircle2, color: "text-orange-400 bg-orange-400/10 border-orange-400/20", label: "Selected" },
};

function Sidebar() {
  return (
    <div className="flex flex-col gap-0.5 p-2 pt-3">
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Projects</p>
      {MOCK_PROJECTS.map((p) => (
        <button key={p.id} type="button" className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-white/65 hover:bg-white/[0.06]">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-white/40" />
          <span className="truncate">{p.name}</span>
        </button>
      ))}
      <p className="mt-3 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-orange-400/50">Needs Attention</p>
      {MOCK_PARTS.filter((p) => p.status === "needs_attention").map((p) => (
        <button key={p.id} type="button" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-rose-400/80 hover:bg-rose-500/[0.06]">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
          <span className="truncate font-mono text-[11px]">{p.partNumber}</span>
        </button>
      ))}
    </div>
  );
}

function TodayFocusPanel() {
  const attentionParts = MOCK_PARTS.filter((p) => p.status === "needs_attention" || p.status === "requesting");
  return (
    <div className="w-56 shrink-0 border-l border-white/[0.06] bg-ws-shell p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-orange-400/60">Today's Focus</p>
      <div className="space-y-2">
        {attentionParts.map((p) => (
          <div key={p.id} className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-2.5">
            <div className="flex items-start gap-1.5">
              {p.status === "needs_attention" && <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-rose-400" />}
              <Package className={`mt-0.5 h-3 w-3 shrink-0 ${p.status === "needs_attention" ? "hidden" : "text-white/35"}`} />
              <div className="min-w-0">
                <p className="font-mono text-[11px] text-white/80">{p.partNumber}</p>
                <p className="mt-0.5 text-[10px] text-white/40">{p.name}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Set4HomePage() {
  return (
    <ConceptShell sidebarContent={<Sidebar />} headerTitle="Activity Feed" headerBreadcrumb="OverDrafter">
      <div className="flex h-full">
        <div className="flex-1 overflow-auto p-5">
          <p className="mb-5 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Recent Activity — All Projects</p>
          <div className="relative pl-8 space-y-0">
            <div className="absolute left-3 top-2 bottom-2 w-0.5 bg-gradient-to-b from-orange-400/40 via-orange-400/20 to-orange-400/05" />
            {MOCK_ACTIVITY.map((e) => {
              const { Icon, color, label } = ACTIVITY_CONFIG[e.type];
              return (
                <div key={e.id} className="relative pb-5">
                  <div className={`absolute -left-5 flex h-6 w-6 items-center justify-center rounded-full border ${color}`}>
                    <Icon className="h-3 w-3" />
                  </div>
                  <div className="rounded-2xl border border-white/[0.06] bg-ws-card p-3 hover:bg-ws-raised transition cursor-pointer">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm text-white/80 leading-5">{e.message}</p>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] ${color}`}>{label}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[11px] font-medium text-white/45">{e.actor}</span>
                      <span className="text-white/20">·</span>
                      <span className="text-[11px] text-white/30">{formatRelativeTime(e.timestamp)}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <TodayFocusPanel />
      </div>
    </ConceptShell>
  );
}
