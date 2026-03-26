import { Hash, Folder, Package, Clock, ChevronRight, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PROJECTS, MOCK_PARTS, getStatusLabel, type PartStatus } from "@/concepts/mock-data";

function IconRail() {
  const icons = [
    { Icon: Folder, label: "Projects", active: true },
    { Icon: Package, label: "Parts" },
    { Icon: Clock, label: "History" },
    { Icon: Hash, label: "Vendors" },
  ];
  return (
    <div className="flex h-full flex-col items-center gap-2 py-3">
      {icons.map(({ Icon, label, active }) => (
        <button key={label} type="button" aria-label={label}
          className={`flex h-9 w-9 items-center justify-center rounded-lg transition ${active ? "bg-violet-500/20 text-violet-400" : "text-white/35 hover:bg-white/[0.06] hover:text-white/70"}`}>
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}

function ShortcutHint({ keys }: { keys: string }) {
  return (
    <kbd className="rounded border border-white/[0.12] bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/40">{keys}</kbd>
  );
}

const STATUS_COLORS: Record<PartStatus, string> = {
  quoted: "bg-emerald-400/15 text-emerald-400 border-emerald-400/25",
  selected: "bg-sky-400/15 text-sky-400 border-sky-400/25",
  requesting: "bg-yellow-400/15 text-yellow-400 border-yellow-400/25",
  needs_attention: "bg-rose-400/15 text-rose-400 border-rose-400/25",
};

function FilterBar() {
  return (
    <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-2.5">
      {(["All", "Quoted", "Requesting", "Needs Attention"] as const).map((t, i) => (
        <button key={t} type="button"
          className={`flex items-center gap-1.5 text-[12px] font-medium transition ${i === 0 ? "text-violet-400" : "text-white/40 hover:text-white/70"}`}>
          {t}
          {i === 0 && <ShortcutHint keys="⌘A" />}
        </button>
      ))}
      <div className="ml-auto">
        <ShortcutHint keys="⌘F" />
      </div>
    </div>
  );
}

function InspectorPanel({ part }: { part: typeof MOCK_PARTS[0] }) {
  if (!part) return null;
  const fields = [
    ["Part #", part.partNumber, true],
    ["Rev", part.revision, false],
    ["Material", part.material, false],
    ["Finish", part.finish, false],
    ["Tolerance", part.tolerance, true],
    ["Qty", String(part.quantity), false],
  ] as const;

  return (
    <div className="w-60 shrink-0 border-l border-white/[0.08] bg-[#0b0d12] p-4">
      <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-violet-400/70">Inspector</p>
      <div className="space-y-2.5">
        {fields.map(([label, value, mono]) => (
          <div key={label} className="flex flex-col gap-0.5">
            <span className="text-[10px] text-white/30">{label}</span>
            <span className={`text-[12px] text-white/80 ${mono ? "font-mono" : ""}`}>{value}</span>
          </div>
        ))}
      </div>
      {part.bestPrice != null && (
        <div className="mt-4 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-3">
          <p className="text-[10px] text-emerald-400/70">Best Price</p>
          <p className="font-mono text-xl font-semibold text-emerald-400">${part.bestPrice}</p>
          <p className="text-[11px] text-white/40">{part.leadTimeDays}d lead time</p>
        </div>
      )}
    </div>
  );
}

export function Set2ProjectPage() {
  const project = MOCK_PROJECTS[0];
  const focusedPart = MOCK_PARTS[0];
  return (
    <ConceptShell sidebarContent={<IconRail />} headerTitle={project.name} headerBreadcrumb="OverDrafter"
      headerRight={
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-white/35">Jump to part</span>
          <ShortcutHint keys="⌘P" />
        </div>
      }>
      <div className="flex h-full">
        <div className="flex min-w-0 flex-1 flex-col">
          <FilterBar />
          <div className="flex-1 overflow-auto">
            {MOCK_PARTS.map((p, i) => (
              <div key={p.id}
                className={`flex items-center gap-4 border-b border-white/[0.04] px-5 py-3 cursor-pointer ${i === 0 ? "bg-violet-500/[0.06] ring-1 ring-inset ring-violet-500/20" : "hover:bg-white/[0.03]"}`}>
                <span className="w-6 shrink-0 font-mono text-[12px] text-white/25 tabular-nums">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <code className="font-mono text-[12px] text-violet-400">{p.partNumber}</code>
                    <span className="text-sm text-white/70">{p.name}</span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-white/40">{p.material} · {p.tolerance}</p>
                </div>
                <Badge className={`shrink-0 border text-[10px] ${STATUS_COLORS[p.status]}`}>{getStatusLabel(p.status)}</Badge>
                {p.status === "needs_attention" && <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />}
                <span className="shrink-0 font-mono text-sm text-white/60">
                  {p.bestPrice != null ? `$${p.bestPrice}` : "—"}
                </span>
                <ChevronRight className="h-4 w-4 shrink-0 text-white/20" />
              </div>
            ))}
          </div>
        </div>
        <InspectorPanel part={focusedPart} />
      </div>
    </ConceptShell>
  );
}
