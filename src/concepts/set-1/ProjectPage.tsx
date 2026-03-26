import { FolderOpen, Package, AlertTriangle, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PROJECTS, MOCK_PARTS, getStatusLabel, type PartStatus } from "@/concepts/mock-data";

const STATUS_COLORS: Record<PartStatus, string> = {
  quoted: "bg-emerald-400/15 text-emerald-400 border-emerald-400/25",
  selected: "bg-sky-400/15 text-sky-400 border-sky-400/25",
  requesting: "bg-yellow-400/15 text-yellow-400 border-yellow-400/25",
  needs_attention: "bg-rose-400/15 text-rose-400 border-rose-400/25",
};

function Sidebar() {
  return (
    <div className="flex flex-col gap-1 p-2 pt-3">
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Projects</p>
      {MOCK_PROJECTS.map((p, i) => (
        <button key={p.id} type="button"
          className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/[0.06] ${i === 0 ? "border-l-2 border-emerald-400 bg-white/[0.06]" : ""}`}>
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-white/40" />
          <span className={`truncate text-sm ${i === 0 ? "text-white font-medium" : "text-white/70"}`}>{p.name}</span>
        </button>
      ))}
    </div>
  );
}

const proj1Parts = MOCK_PARTS.filter((p) => p.projectId === "proj-1");

function StatBar() {
  const totalValue = proj1Parts.reduce((s, p) => s + (p.bestPrice ?? 0), 0);
  const pending = proj1Parts.filter((p) => p.status === "requesting" || p.status === "needs_attention").length;
  const avgLead = proj1Parts.filter((p) => p.leadTimeDays != null).map((p) => p.leadTimeDays as number);
  const avgLeadVal = avgLead.length > 0 ? Math.round(avgLead.reduce((a, b) => a + b, 0) / avgLead.length) : null;

  return (
    <div className="flex items-center gap-6 border-t border-white/[0.06] bg-ws-shell px-5 py-3">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-[0.15em] text-white/35">Quoted Value</span>
        <span className="font-mono text-sm font-semibold text-white">${totalValue.toLocaleString()}</span>
      </div>
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-rose-400" />
        <span className="text-[10px] uppercase tracking-[0.15em] text-white/35">Pending</span>
        <span className="font-mono text-sm font-semibold text-white">{pending}</span>
      </div>
      {avgLeadVal != null && (
        <div className="flex items-center gap-2">
          <Clock className="h-3.5 w-3.5 text-white/40" />
          <span className="text-[10px] uppercase tracking-[0.15em] text-white/35">Avg Lead</span>
          <span className="font-mono text-sm font-semibold text-white">{avgLeadVal}d</span>
        </div>
      )}
    </div>
  );
}

export function Set1ProjectPage() {
  const project = MOCK_PROJECTS[0];
  return (
    <ConceptShell sidebarContent={<Sidebar />} headerTitle={project.name} headerBreadcrumb="Workspace">
      <div className="flex h-full flex-col">
        <div className="border-b border-white/[0.06] px-5 py-3">
          <div className="flex items-center gap-3">
            <Package className="h-4 w-4 text-white/40" />
            <p className="text-sm text-white/55">{project.partCount} parts · updated {project.updatedAt}</p>
            <div className="ml-auto flex gap-1">
              {(["All", "Quoted", "Requesting", "Needs Attention"] as const).map((t, i) => (
                <button key={t} type="button"
                  className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${i === 0 ? "bg-white/[0.08] text-white" : "text-white/50 hover:text-white/80"}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-ws-inset">
              <tr className="border-b border-white/[0.06]">
                {["Part #", "Name", "Material", "Finish", "Tol.", "Qty", "Status", "Best Price", "Lead"].map((h) => (
                  <th key={h} className="px-3 py-2.5 text-left text-[10px] font-medium uppercase tracking-[0.14em] text-white/35 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MOCK_PARTS.map((p) => (
                <tr key={p.id} className="border-b border-white/[0.04] hover:bg-white/[0.03] cursor-pointer">
                  <td className="px-3 py-3 font-mono text-[12px] text-emerald-400">{p.partNumber}</td>
                  <td className="px-3 py-3 font-medium text-white/90 max-w-[140px] truncate">{p.name}</td>
                  <td className="px-3 py-3 text-white/60 max-w-[120px] truncate">{p.material}</td>
                  <td className="px-3 py-3 text-white/50 max-w-[120px] truncate text-[12px]">{p.finish}</td>
                  <td className="px-3 py-3 font-mono text-[12px] text-white/60 whitespace-nowrap">{p.tolerance}</td>
                  <td className="px-3 py-3 tabular-nums text-white/70">{p.quantity}</td>
                  <td className="px-3 py-3">
                    <Badge className={`text-[10px] border ${STATUS_COLORS[p.status]}`}>{getStatusLabel(p.status)}</Badge>
                  </td>
                  <td className="px-3 py-3 font-mono text-[13px] font-semibold text-white">
                    {p.bestPrice != null ? `$${p.bestPrice}` : <span className="text-white/30">—</span>}
                  </td>
                  <td className="px-3 py-3 tabular-nums text-white/60">
                    {p.leadTimeDays != null ? `${p.leadTimeDays}d` : <span className="text-white/30">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <StatBar />
      </div>
    </ConceptShell>
  );
}
