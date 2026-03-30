import { MapPin, Search, Activity, FolderOpen, Package } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PROJECTS, MOCK_ACTIVITY, formatRelativeTime, type ProjectStatus } from "@/concepts/mock-data";

const STATUS_COLORS: Record<ProjectStatus, string> = {
  active: "bg-sky-400/15 text-sky-400 border-sky-400/25",
  review: "bg-yellow-400/15 text-yellow-400 border-yellow-400/25",
  archived: "bg-neutral-500/15 text-neutral-400 border-neutral-500/25",
};

function Sidebar() {
  return (
    <div className="flex flex-col gap-1 p-2 pt-3">
      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/35">Navigation</p>
      {[
        { Icon: FolderOpen, label: "All Projects", active: true },
        { Icon: Package, label: "All Parts" },
        { Icon: Activity, label: "Activity Feed" },
        { Icon: MapPin, label: "Vendors" },
      ].map(({ Icon, label, active }) => (
        <button key={label} type="button"
          className={`flex items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition hover:bg-white/[0.06] ${active ? "bg-sky-500/[0.10] text-sky-400" : "text-white/60"}`}>
          <Icon className="h-4 w-4 shrink-0" />
          {label}
        </button>
      ))}
    </div>
  );
}

function ProjectCard({ proj }: { proj: typeof MOCK_PROJECTS[0] }) {
  const filledDots = proj.quotedCount;
  const totalDots = proj.partCount;
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-ws-card p-4 hover:border-sky-400/20 hover:bg-ws-raised transition cursor-pointer">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-400/60" />
          <p className="text-sm font-medium text-white/90 leading-tight">{proj.name}</p>
        </div>
        <Badge className={`shrink-0 border text-[10px] ${STATUS_COLORS[proj.status]}`}>
          {proj.status}
        </Badge>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <div className="flex gap-1">
          {Array.from({ length: totalDots }).map((_, i) => (
            <div key={i} className={`h-2 w-2 rounded-full ${i < filledDots ? "bg-sky-400" : "bg-white/[0.10]"}`} />
          ))}
        </div>
        <span className="text-[11px] text-white/40">{filledDots}/{totalDots} quoted</span>
      </div>
      <div className="mt-2 flex items-baseline gap-1.5">
        <span className="font-mono text-lg font-semibold text-white">{proj.totalValue > 0 ? `$${proj.totalValue.toLocaleString()}` : "—"}</span>
        <span className="text-[11px] text-white/35">total value</span>
      </div>
      <p className="mt-1 text-[10px] text-white/30">Updated {proj.updatedAt}</p>
    </div>
  );
}

function ActivityFeed() {
  return (
    <div className="rounded-2xl border border-white/[0.08] bg-ws-card p-4">
      <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-white/40">Workspace Feed</p>
      <div className="relative space-y-4 pl-5">
        <div className="absolute left-2 top-1 bottom-1 w-px bg-sky-400/20" />
        {MOCK_ACTIVITY.map((e) => (
          <div key={e.id} className="relative">
            <div className="absolute -left-3 top-1.5 h-2 w-2 rounded-full bg-sky-400/60 ring-2 ring-[#0d1117]" />
            <p className="text-[12px] leading-5 text-white/75">{e.message}</p>
            <p className="mt-0.5 text-[10px] text-white/30">{e.actor} · {formatRelativeTime(e.timestamp)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Set3HomePage() {
  return (
    <ConceptShell sidebarContent={<Sidebar />} headerTitle="Workspace" headerBreadcrumb="OverDrafter"
      headerRight={
        <div className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-ws-inset px-3 py-1.5">
          <Search className="h-3.5 w-3.5 text-white/35" />
          <span className="text-sm text-white/35">Search…</span>
        </div>
      }>
      <div className="p-5">
        <div className="grid grid-cols-5 gap-5">
          <div className="col-span-3 space-y-4">
            <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Projects</p>
            <div className="grid grid-cols-2 gap-3">
              {MOCK_PROJECTS.map((p) => <ProjectCard key={p.id} proj={p} />)}
            </div>
          </div>
          <div className="col-span-2">
            <p className="mb-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-white/40">Activity</p>
            <ActivityFeed />
          </div>
        </div>
      </div>
    </ConceptShell>
  );
}
