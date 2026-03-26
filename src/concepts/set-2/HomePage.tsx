import { Hash, Folder, Package, Clock, Search } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ConceptShell } from "@/concepts/ConceptShell";
import { MOCK_PROJECTS, MOCK_PARTS } from "@/concepts/mock-data";

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

export function Set2HomePage() {
  return (
    <ConceptShell
      sidebarContent={<IconRail />}
      headerTitle="Command"
      headerBreadcrumb="OverDrafter"
      accentClass="[--concept-accent:theme(colors.violet.400)]"
    >
      <div className="flex h-full flex-col items-center justify-start pt-12 px-6">
        <div className="w-full max-w-2xl">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs text-white/35">Command palette</span>
            <div className="flex items-center gap-1">
              <ShortcutHint keys="⌘" />
              <ShortcutHint keys="K" />
            </div>
          </div>
          <Command className="rounded-2xl border border-white/[0.12] bg-[#0d0f14] shadow-[0_24px_80px_rgba(0,0,0,0.5)]">
            <CommandInput placeholder="Search parts, projects, vendors…" className="h-12 text-sm text-white placeholder:text-white/35 border-none focus:ring-0" />
            <CommandList className="max-h-96 pb-2">
              <CommandEmpty className="py-6 text-center text-sm text-white/40">No results</CommandEmpty>
              <CommandGroup heading="Recent Projects" className="[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.2em] [&_[cmdk-group-heading]]:text-white/30 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2">
                {MOCK_PROJECTS.map((p, i) => (
                  <CommandItem key={p.id} className="group flex items-center justify-between rounded-xl mx-1 px-3 py-2.5 aria-selected:bg-violet-500/15 aria-selected:text-white cursor-pointer">
                    <div className="flex items-center gap-3">
                      <Folder className="h-4 w-4 text-violet-400/70" />
                      <span className="text-sm text-white/85">{p.name}</span>
                    </div>
                    <div className="flex items-center gap-2 opacity-0 group-aria-selected:opacity-100">
                      <ShortcutHint keys={`⌘${i + 1}`} />
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandGroup heading="Recent Parts" className="[&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.2em] [&_[cmdk-group-heading]]:text-white/30 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2">
                {MOCK_PARTS.map((p) => (
                  <CommandItem key={p.id} className="group flex items-center justify-between rounded-xl mx-1 px-3 py-2.5 aria-selected:bg-violet-500/15 aria-selected:text-white cursor-pointer">
                    <div className="flex items-center gap-3">
                      <Package className="h-4 w-4 text-violet-400/70" />
                      <span className="font-mono text-[12px] text-white/80">{p.partNumber}</span>
                      <span className="text-sm text-white/45">{p.name}</span>
                    </div>
                    <Search className="h-3.5 w-3.5 text-white/25 opacity-0 group-aria-selected:opacity-100" />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
          <div className="mt-6 grid grid-cols-3 gap-3">
            {[
              { label: "New project", hint: "⌘N", desc: "Start a new quoting project" },
              { label: "Upload drawing", hint: "⌘U", desc: "Add a PDF or STEP file" },
              { label: "View all quotes", hint: "⌘Q", desc: "Open the quote comparison view" },
            ].map(({ label, hint, desc }) => (
              <button key={label} type="button" className="flex flex-col gap-1 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3 text-left hover:bg-white/[0.06]">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white/80">{label}</span>
                  <ShortcutHint keys={hint} />
                </div>
                <span className="text-[11px] text-white/40">{desc}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </ConceptShell>
  );
}
