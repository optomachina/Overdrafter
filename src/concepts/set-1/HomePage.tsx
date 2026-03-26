import { Upload, Search, FolderOpen, Package } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PROJECTS, MOCK_PARTS, getStatusLabel, type PartStatus, type ProjectStatus } from "@/concepts/mock-data";

const STATUS_COLORS: Record<PartStatus | ProjectStatus, string> = {
  quoted: "bg-emerald-400/15 text-emerald-400 border-emerald-400/25",
  selected: "bg-sky-400/15 text-sky-400 border-sky-400/25",
  requesting: "bg-yellow-400/15 text-yellow-400 border-yellow-400/25",
  needs_attention: "bg-rose-400/15 text-rose-400 border-rose-400/25",
  active: "bg-emerald-400/15 text-emerald-400 border-emerald-400/25",
  review: "bg-yellow-400/15 text-yellow-400 border-yellow-400/25",
  archived: "bg-neutral-500/15 text-neutral-400 border-neutral-500/25",
};

function Sidebar() {
  return (
    <div className="flex flex-col gap-1 p-2 pt-3">
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Projects</p>
      {MOCK_PROJECTS.map((p) => (
        <button key={p.id} type="button" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/[0.06] data-[active]:bg-white/[0.08] data-[active]:border-l-2 data-[active]:border-emerald-400">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-white/40" />
          <span className="truncate text-white/80">{p.name}</span>
        </button>
      ))}
      <p className="mt-3 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Parts</p>
      {MOCK_PARTS.slice(0, 3).map((p) => (
        <button key={p.id} type="button" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/[0.06]">
          <Package className="h-3.5 w-3.5 shrink-0 text-white/40" />
          <span className="truncate font-mono text-[12px] text-white/70">{p.partNumber}</span>
        </button>
      ))}
    </div>
  );
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-white/[0.08] bg-white/[0.04] px-4 py-3">
      <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-white/40">{label}</span>
      <span className="text-2xl font-semibold tabular-nums text-white">{value}</span>
    </div>
  );
}

export function Set1HomePage() {
  return (
    <ConceptShell sidebarContent={<Sidebar />} headerTitle="Workspace" headerBreadcrumb="OverDrafter"
      headerRight={
        <Button size="sm" className="h-7 gap-1.5 rounded-lg bg-emerald-500 text-xs font-medium text-black hover:bg-emerald-400">
          <Upload className="h-3 w-3" />Upload Drawing
        </Button>
      }>
      <div className="p-5 space-y-5">
        <div className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-ws-inset px-3 py-2">
          <Search className="h-4 w-4 text-white/35" />
          <span className="text-sm text-white/35">Search parts, projects, vendors…</span>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <StatChip label="Active Projects" value="3" />
          <StatChip label="Total Parts" value="16" />
          <StatChip label="Awaiting Quotes" value="4" />
          <StatChip label="Total Value" value="$6,750" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <section>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Recent Projects</p>
            <div className="rounded-xl border border-white/[0.08] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                    <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.15em] text-white/35">Project</th>
                    <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.15em] text-white/35">Parts</th>
                    <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.15em] text-white/35">Status</th>
                    <th className="px-3 py-2 text-right text-[10px] font-medium uppercase tracking-[0.15em] text-white/35">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {MOCK_PROJECTS.map((p) => (
                    <tr key={p.id} className="border-b border-white/[0.04] hover:bg-white/[0.03]">
                      <td className="px-3 py-2.5 text-white/85 font-medium">{p.name}</td>
                      <td className="px-3 py-2.5 text-white/55 tabular-nums">{p.quotedCount}/{p.partCount}</td>
                      <td className="px-3 py-2.5">
                        <Badge className={`text-[10px] border ${STATUS_COLORS[p.status]}`}>{getStatusLabel(p.status)}</Badge>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-white/70">
                        {p.totalValue > 0 ? `$${p.totalValue.toLocaleString()}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <section>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Recent Parts</p>
            <div className="rounded-xl border border-white/[0.08] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/[0.06] bg-white/[0.02]">
                    <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.15em] text-white/35">Part #</th>
                    <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.15em] text-white/35">Material</th>
                    <th className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.15em] text-white/35">Status</th>
                    <th className="px-3 py-2 text-right text-[10px] font-medium uppercase tracking-[0.15em] text-white/35">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {MOCK_PARTS.map((p) => (
                    <tr key={p.id} className="border-b border-white/[0.04] hover:bg-white/[0.03]">
                      <td className="px-3 py-2.5 font-mono text-[12px] text-white/80">{p.partNumber}</td>
                      <td className="px-3 py-2.5 text-white/55 text-[12px] truncate max-w-[100px]">{p.material.split(" ")[0]}</td>
                      <td className="px-3 py-2.5">
                        <Badge className={`text-[10px] border ${STATUS_COLORS[p.status]}`}>{getStatusLabel(p.status)}</Badge>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono text-white/70">
                        {p.bestPrice != null ? `$${p.bestPrice}` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </ConceptShell>
  );
}
