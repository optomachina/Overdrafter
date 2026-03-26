import { FileText, CheckCircle2, FolderOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PROJECTS, MOCK_PARTS, MOCK_VENDOR_QUOTES, MOCK_ACTIVITY, formatRelativeTime } from "@/concepts/mock-data";

const ACTIVITY_ICONS: Record<string, string> = {
  quote_received: "💰",
  spec_updated: "✏️",
  file_uploaded: "📄",
  selection_made: "✅",
};

function Sidebar() {
  return (
    <div className="flex flex-col gap-1 p-2 pt-3">
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Projects</p>
      {MOCK_PROJECTS.slice(0, 3).map((p) => (
        <button key={p.id} type="button" className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white/[0.06]">
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-white/40" />
          <span className="truncate text-white/70">{p.name}</span>
        </button>
      ))}
    </div>
  );
}

const part = MOCK_PARTS[0];

function SpecGrid() {
  const fields = [
    ["Part Number", part.partNumber, true],
    ["Revision", part.revision, false],
    ["Material", part.material, false],
    ["Finish", part.finish, false],
    ["Tolerance", part.tolerance, true],
    ["Quantity", String(part.quantity), false],
  ] as const;

  return (
    <div className="rounded-xl border border-white/[0.08] bg-ws-card p-4">
      <div className="mb-3 flex items-center gap-2">
        <FileText className="h-4 w-4 text-white/40" />
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-white/40">Spec</p>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        {fields.map(([label, value, mono]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="text-[10px] text-white/40">{label}</span>
            <span className={`text-sm text-white/85 ${mono ? "font-mono" : ""}`}>{value}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <div className="rounded-md border border-white/[0.08] bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-mono text-white/60">
          AHA-01093-C_RevC.pdf
        </div>
      </div>
    </div>
  );
}

function QuoteTable() {
  return (
    <div className="rounded-xl border border-white/[0.08] overflow-hidden">
      <p className="border-b border-white/[0.06] bg-ws-inset px-4 py-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-white/40">Quote Comparison</p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/[0.06] bg-white/[0.02]">
            {["Vendor", "Process", "Price", "Lead", "Tier", "Cert"].map((h) => (
              <th key={h} className="px-3 py-2 text-left text-[10px] font-medium uppercase tracking-[0.12em] text-white/35">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {MOCK_VENDOR_QUOTES.map((q, i) => (
            <tr key={i} className={`border-b border-white/[0.04] ${q.selected ? "bg-emerald-400/[0.06] ring-1 ring-inset ring-emerald-400/20" : "hover:bg-white/[0.03]"}`}>
              <td className="px-3 py-2.5 font-medium text-white/90">
                <div className="flex items-center gap-1.5">
                  {q.selected && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />}
                  {q.vendor}
                </div>
              </td>
              <td className="px-3 py-2.5 text-white/55 text-[12px]">{q.process}</td>
              <td className="px-3 py-2.5 font-mono font-semibold text-white">${q.price}</td>
              <td className="px-3 py-2.5 tabular-nums text-white/70">{q.leadTimeDays}d</td>
              <td className="px-3 py-2.5">
                <span className="rounded-md bg-white/[0.06] px-2 py-0.5 text-[10px] text-white/60">{q.tier}</span>
              </td>
              <td className="px-3 py-2.5">
                {q.cert ? <span className="rounded-md border border-sky-400/20 bg-sky-400/10 px-1.5 py-0.5 text-[10px] text-sky-400">{q.cert}</span> : <span className="text-white/25">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityLog() {
  return (
    <div className="rounded-xl border border-white/[0.08] bg-ws-card p-4">
      <p className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-white/40">Activity</p>
      <div className="space-y-3">
        {MOCK_ACTIVITY.map((e) => (
          <div key={e.id} className="flex gap-3">
            <span className="mt-0.5 text-base">{ACTIVITY_ICONS[e.type]}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] leading-5 text-white/75">{e.message}</p>
              <p className="mt-0.5 text-[10px] text-white/35">{e.actor} · {formatRelativeTime(e.timestamp)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Set1PartPage() {
  return (
    <ConceptShell sidebarContent={<Sidebar />} headerTitle={part.name} headerBreadcrumb="Actuator Housing Assembly"
      headerRight={<Badge className="border border-emerald-400/25 bg-emerald-400/15 text-[11px] text-emerald-400">Quoted</Badge>}>
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <SpecGrid />
          <div className="col-span-2 space-y-3">
            <QuoteTable />
          </div>
        </div>
        <ActivityLog />
      </div>
    </ConceptShell>
  );
}
