import { ChevronDown, ChevronRight, FileText, FolderOpen, Package } from "lucide-react";
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
    <div className="flex flex-col gap-0.5 p-2 pt-3">
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Projects</p>
      {MOCK_PROJECTS.map((p, i) => (
        <div key={p.id}>
          <button type="button"
            className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/[0.06] ${i === 0 ? "text-white font-medium" : "text-white/60"}`}>
            {i === 0 ? <ChevronDown className="h-3 w-3 shrink-0 text-sky-400" /> : <ChevronRight className="h-3 w-3 shrink-0 text-white/30" />}
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-white/40" />
            <span className="truncate">{p.name}</span>
          </button>
          {i === 0 && MOCK_PARTS.filter((pt) => pt.projectId === p.id).map((pt, j) => (
            <button key={pt.id} type="button"
              className={`flex w-full items-center gap-1.5 rounded-lg pl-6 pr-2 py-1.5 text-left text-sm hover:bg-white/[0.06] ${j === 0 ? "bg-sky-500/[0.08] text-sky-300" : "text-white/55"}`}>
              <Package className="h-3 w-3 shrink-0 text-white/30" />
              <span className="truncate font-mono text-[11px]">{pt.partNumber}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function DrawingPlaceholder() {
  return (
    <div className="relative flex h-52 items-center justify-center rounded-xl border border-white/[0.08] bg-[#060a0f] overflow-hidden">
      <div className="absolute inset-0 opacity-[0.04]"
        style={{ backgroundImage: "repeating-linear-gradient(0deg, transparent, transparent 19px, rgba(255,255,255,0.3) 19px, rgba(255,255,255,0.3) 20px), repeating-linear-gradient(90deg, transparent, transparent 19px, rgba(255,255,255,0.3) 19px, rgba(255,255,255,0.3) 20px)" }} />
      <div className="z-10 flex flex-col items-center gap-2">
        <FileText className="h-10 w-10 text-sky-400/30" />
        <span className="font-mono text-sm text-white/30">AHA-01093-C_RevC.pdf</span>
        <span className="text-[10px] text-white/20">3 pages · Drawing</span>
      </div>
    </div>
  );
}

export function Set3ProjectPage() {
  const project = MOCK_PROJECTS[0];
  const parts = MOCK_PARTS;
  return (
    <ConceptShell sidebarContent={<Sidebar />} headerTitle={project.name} headerBreadcrumb="Workspace">
      <div className="flex h-full">
        <div className="flex min-w-0 flex-1 flex-col gap-0">
          <div className="border-b border-white/[0.06] p-4">
            <DrawingPlaceholder />
          </div>
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-ws-inset">
                <tr className="border-b border-white/[0.06]">
                  {["Part #", "Name", "Material", "Finish", "Status", "Price", "Lead"].map((h) => (
                    <th key={h} className="px-3 py-2.5 text-left text-[10px] font-medium uppercase tracking-[0.14em] text-white/35 whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parts.map((p, i) => (
                  <tr key={p.id}
                    className={`border-b border-white/[0.04] cursor-pointer ${i === 0 ? "bg-sky-500/[0.05]" : "hover:bg-white/[0.03]"}`}>
                    <td className="px-3 py-3 font-mono text-[12px] text-sky-400">{p.partNumber}</td>
                    <td className="px-3 py-3 font-medium text-white/85">{p.name}</td>
                    <td className="px-3 py-3 text-white/55 text-[12px] max-w-[100px] truncate">{p.material}</td>
                    <td className="px-3 py-3 text-white/45 text-[12px] max-w-[100px] truncate">{p.finish}</td>
                    <td className="px-3 py-3">
                      <Badge className={`border text-[10px] ${STATUS_COLORS[p.status]}`}>{getStatusLabel(p.status)}</Badge>
                    </td>
                    <td className="px-3 py-3 font-mono text-sm font-semibold text-white">{p.bestPrice != null ? `$${p.bestPrice}` : <span className="text-white/30">—</span>}</td>
                    <td className="px-3 py-3 tabular-nums text-white/60">{p.leadTimeDays != null ? `${p.leadTimeDays}d` : <span className="text-white/30">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </ConceptShell>
  );
}
