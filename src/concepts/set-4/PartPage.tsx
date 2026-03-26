import { Upload, FileText, DollarSign, CheckCircle2, FolderOpen, GitBranch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PROJECTS, MOCK_PARTS, MOCK_VENDOR_QUOTES, MOCK_ACTIVITY, formatRelativeTime } from "@/concepts/mock-data";

function Sidebar() {
  return (
    <div className="flex flex-col gap-1 p-2 pt-3">
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Projects</p>
      {MOCK_PROJECTS.slice(0, 3).map((p) => (
        <button key={p.id} type="button" className="flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-white/60 hover:bg-white/[0.06]">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-white/40" />
          <span className="truncate">{p.name}</span>
        </button>
      ))}
    </div>
  );
}

const part = MOCK_PARTS[0];

type LifecycleNode = { icon: typeof Upload; label: string; sub: string; color: string; done: boolean };

const LIFECYCLE: LifecycleNode[] = [
  { icon: Upload, label: "Drawing uploaded", sub: "AHA-01093-C_RevC.pdf · Alex R.", color: "text-sky-400 bg-sky-400/10 border-sky-400/20", done: true },
  { icon: FileText, label: "Specs extracted", sub: "6061-T6 Al · ±0.003 in · Qty 10", color: "text-sky-400 bg-sky-400/10 border-sky-400/20", done: true },
  { icon: DollarSign, label: "Quotes requested", sub: "Sent to 5 vendors", color: "text-orange-400 bg-orange-400/10 border-orange-400/20", done: true },
  { icon: DollarSign, label: "Quotes received", sub: `${MOCK_VENDOR_QUOTES.length} responses`, color: "text-orange-400 bg-orange-400/10 border-orange-400/20", done: true },
  { icon: CheckCircle2, label: "Vendor selected", sub: "eMachineShop — $431 Economy", color: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20", done: true },
];

function LifecyclePipeline() {
  return (
    <div className="relative space-y-0 pl-8">
      <div className="absolute left-3.5 top-3 bottom-3 w-0.5 bg-gradient-to-b from-orange-400/40 to-orange-400/05" />
      {LIFECYCLE.map((node, i) => {
        const Icon = node.icon;
        return (
          <div key={i} className={`relative pb-4 ${i === LIFECYCLE.length - 1 ? "pb-0" : ""}`}>
            <div className={`absolute left-0 top-1 flex h-6 w-6 items-center justify-center rounded-full border ${node.color}`}>
              <Icon className="h-3 w-3" />
            </div>
            <div className="rounded-xl border border-white/[0.06] bg-ws-card p-3 hover:bg-ws-raised transition">
              <p className="text-sm font-medium text-white/90">{node.label}</p>
              <p className="mt-0.5 text-[11px] text-white/45">{node.sub}</p>
            </div>
            {i === 3 && (
              <div className="mt-2 ml-4 space-y-1.5 pl-4 border-l border-orange-400/15">
                <p className="text-[10px] font-medium uppercase tracking-[0.15em] text-orange-400/50 flex items-center gap-1.5">
                  <GitBranch className="h-3 w-3" /> Quote Branch
                </p>
                {MOCK_VENDOR_QUOTES.map((q, qi) => (
                  <div key={qi} className={`flex items-center justify-between rounded-lg border px-3 py-2 ${q.selected ? "border-emerald-400/20 bg-emerald-400/[0.06]" : "border-white/[0.05] bg-white/[0.02]"}`}>
                    <div className="flex items-center gap-2">
                      {q.selected && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
                      <span className="text-[12px] text-white/80">{q.vendor}</span>
                      <Badge className="text-[9px] bg-white/[0.05] text-white/40 border-white/[0.08]">{q.tier}</Badge>
                    </div>
                    <span className="font-mono text-sm text-white">${q.price}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Set4PartPage() {
  return (
    <ConceptShell sidebarContent={<Sidebar />} headerTitle={part.name} headerBreadcrumb="Actuator Housing Assembly"
      headerRight={
        <div className="flex items-center gap-2">
          <code className="rounded border border-white/[0.10] bg-white/[0.05] px-2 py-0.5 font-mono text-[11px] text-orange-400">{part.partNumber}</code>
          <Badge className="border border-orange-400/20 bg-orange-400/10 text-[10px] text-orange-400">Rev C</Badge>
        </div>
      }>
      <div className="p-5 space-y-4">
        <div className="rounded-2xl border border-orange-400/15 bg-orange-400/[0.04] px-5 py-4">
          <h2 className="font-mono text-2xl font-semibold text-white">{part.partNumber}</h2>
          <p className="mt-0.5 text-base text-white/60">{part.name} · {part.revision}</p>
          <div className="mt-2 flex flex-wrap gap-3 text-[12px]">
            <span className="text-white/50">{part.material}</span>
            <span className="text-white/25">·</span>
            <span className="font-mono text-white/50">{part.tolerance}</span>
            <span className="text-white/25">·</span>
            <span className="text-white/50">Qty {part.quantity}</span>
          </div>
        </div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Lifecycle</p>
        <LifecyclePipeline />
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Activity Log</p>
        <div className="space-y-2">
          {MOCK_ACTIVITY.map((e) => (
            <div key={e.id} className="flex items-start gap-3 rounded-xl border border-white/[0.05] bg-ws-card px-3 py-2.5">
              <span className="mt-0.5 text-sm">
                {e.type === "quote_received" ? "💰" : e.type === "file_uploaded" ? "📄" : e.type === "selection_made" ? "✅" : "✏️"}
              </span>
              <div>
                <p className="text-[12px] text-white/70">{e.message}</p>
                <p className="mt-0.5 text-[10px] text-white/30">{e.actor} · {formatRelativeTime(e.timestamp)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </ConceptShell>
  );
}
