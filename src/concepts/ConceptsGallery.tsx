import { useState } from "react";
import { PanelsTopLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { isFixtureModeAvailable } from "@/features/quotes/client-workspace-fixtures";
import NotFound from "@/pages/NotFound";

import { Set1HomePage } from "@/concepts/set-1/HomePage";
import { Set1ProjectPage } from "@/concepts/set-1/ProjectPage";
import { Set1PartPage } from "@/concepts/set-1/PartPage";
import { Set2HomePage } from "@/concepts/set-2/HomePage";
import { Set2ProjectPage } from "@/concepts/set-2/ProjectPage";
import { Set2PartPage } from "@/concepts/set-2/PartPage";
import { Set3HomePage } from "@/concepts/set-3/HomePage";
import { Set3ProjectPage } from "@/concepts/set-3/ProjectPage";
import { Set3PartPage } from "@/concepts/set-3/PartPage";
import { Set4HomePage } from "@/concepts/set-4/HomePage";
import { Set4ProjectPage } from "@/concepts/set-4/ProjectPage";
import { Set4PartPage } from "@/concepts/set-4/PartPage";
import { Set5HomePage } from "@/concepts/set-5/HomePage";
import { Set5ProjectPage } from "@/concepts/set-5/ProjectPage";
import { Set5PartPage } from "@/concepts/set-5/PartPage";

type SetId = 1 | 2 | 3 | 4 | 5;
type PageType = "home" | "project" | "part";

type ConceptSet = {
  id: SetId;
  name: string;
  direction: string;
  accent: string;
};

const CONCEPT_SETS: ConceptSet[] = [
  { id: 1, name: "Precision", direction: "Data-table-forward. Tight spacing, monospace part numbers, emerald accent.", accent: "text-emerald-400" },
  { id: 2, name: "Command", direction: "Keyboard-first, command-palette-driven. Violet accent. Minimal chrome.", accent: "text-violet-400" },
  { id: 3, name: "Atlas", direction: "Spatial, card-based, cyan accent. File and drawing-centric.", accent: "text-sky-400" },
  { id: 4, name: "Chronicle", direction: "Timeline/activity-feed-first. Orange accent. History is primary.", accent: "text-orange-400" },
  { id: 5, name: "Signal", direction: "Status-forward, alert-driven. Pink/rose accent. Quote health dashboard.", accent: "text-pink-400" },
];

const PAGE_TYPES: Array<{ id: PageType; label: string }> = [
  { id: "home", label: "Home" },
  { id: "project", label: "Project" },
  { id: "part", label: "Part" },
];

type ComponentMap = Record<SetId, Record<PageType, () => JSX.Element>>;

const COMPONENT_MAP: ComponentMap = {
  1: { home: Set1HomePage, project: Set1ProjectPage, part: Set1PartPage },
  2: { home: Set2HomePage, project: Set2ProjectPage, part: Set2PartPage },
  3: { home: Set3HomePage, project: Set3ProjectPage, part: Set3PartPage },
  4: { home: Set4HomePage, project: Set4ProjectPage, part: Set4PartPage },
  5: { home: Set5HomePage, project: Set5ProjectPage, part: Set5PartPage },
};

function SidebarNav({
  selectedSet,
  selectedPage,
  onSelectSet,
  onSelectPage,
}: {
  selectedSet: SetId;
  selectedPage: PageType;
  onSelectSet: (id: SetId) => void;
  onSelectPage: (page: PageType) => void;
}) {
  return (
    <aside className="sticky top-0 hidden h-screen w-[21rem] shrink-0 border-r border-white/6 bg-[#16181c]/94 backdrop-blur md:flex md:flex-col">
      <div className="border-b border-white/8 px-5 py-5">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-2xl border border-white/10 bg-white/[0.06]">
            <PanelsTopLeft className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-medium text-white/70">OverDrafter</p>
            <p className="font-semibold tracking-tight text-white">Concept Gallery</p>
          </div>
        </div>
        <p className="mt-4 text-sm leading-6 text-white/55">
          Five UI direction explorations for the CNC quoting workspace. Three pages per concept.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-5">
        <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.24em] text-white/38">Concept Sets</p>
        <nav className="space-y-1.5">
          {CONCEPT_SETS.map((set) => (
            <div key={set.id}>
              <button
                type="button"
                onClick={() => onSelectSet(set.id)}
                className={cn(
                  "w-full rounded-[18px] border px-4 py-3 text-left transition",
                  selectedSet === set.id
                    ? "border-white/12 bg-white/[0.08]"
                    : "border-white/6 bg-white/[0.03] hover:bg-white/[0.06]",
                )}
              >
                <div className="flex items-center gap-2">
                  <span className={cn("text-[11px] font-semibold tabular-nums", set.accent)}>{set.id}</span>
                  <p className="text-sm font-semibold text-white">{set.name}</p>
                </div>
                <p className="mt-1 text-[11px] leading-4 text-white/42">{set.direction}</p>
              </button>

              {selectedSet === set.id && (
                <div className="ml-4 mt-1 space-y-0.5 border-l border-white/8 pl-3">
                  {PAGE_TYPES.map((page) => (
                    <button
                      key={page.id}
                      type="button"
                      onClick={() => onSelectPage(page.id)}
                      className={cn(
                        "w-full rounded-[14px] px-3 py-2 text-left text-sm transition",
                        selectedPage === page.id
                          ? "bg-white/[0.08] text-white font-medium"
                          : "text-white/52 hover:text-white/80 hover:bg-white/[0.04]",
                      )}
                    >
                      {page.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>

        <div className="mt-6 rounded-[24px] border border-white/8 bg-black/20 p-4">
          <p className="text-xs uppercase tracking-[0.18em] text-white/38">Usage</p>
          <p className="mt-3 text-sm leading-6 text-white/58">
            Select a concept set and page type to preview the component inline. All pages use shared mock data.
          </p>
        </div>
      </div>
    </aside>
  );
}

function SetSwitcher({
  selectedSet,
  onSelect,
}: {
  selectedSet: SetId;
  onSelect: (id: SetId) => void;
}) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5">
      {CONCEPT_SETS.map((set) => (
        <button
          key={set.id}
          type="button"
          onClick={() => onSelect(set.id)}
          className={cn(
            "shrink-0 rounded-full border px-4 py-1.5 text-sm font-medium transition",
            selectedSet === set.id
              ? "border-white/15 bg-white/[0.10] text-white"
              : "border-white/8 bg-white/[0.03] text-white/50 hover:text-white/75 hover:bg-white/[0.06]",
          )}
        >
          <span className={cn("mr-1.5 text-xs", set.accent)}>{set.id}</span>
          {set.name}
        </button>
      ))}
    </div>
  );
}

function PageSwitcher({
  selectedPage,
  onSelect,
}: {
  selectedPage: PageType;
  onSelect: (page: PageType) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {PAGE_TYPES.map((page) => (
        <button
          key={page.id}
          type="button"
          onClick={() => onSelect(page.id)}
          className={cn(
            "rounded-full border px-3.5 py-1.5 text-sm transition",
            selectedPage === page.id
              ? "border-white/15 bg-white/[0.10] font-medium text-white"
              : "border-white/8 bg-white/[0.03] text-white/50 hover:text-white/75 hover:bg-white/[0.06]",
          )}
        >
          {page.label}
        </button>
      ))}
    </div>
  );
}

export const ConceptsGallery = () => {
  const [selectedSet, setSelectedSet] = useState<SetId>(1);
  const [selectedPage, setSelectedPage] = useState<PageType>("home");

  if (!isFixtureModeAvailable()) {
    return <NotFound />;
  }

  const Component = COMPONENT_MAP[selectedSet][selectedPage];
  const currentSet = CONCEPT_SETS.find((s) => s.id === selectedSet);
  const currentPage = PAGE_TYPES.find((p) => p.id === selectedPage);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,hsl(var(--primary)/0.12),transparent_24%),linear-gradient(180deg,#1f2024_0%,#1a1b1f_44%,#12151b_100%)] text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-[1680px]">
        <SidebarNav
          selectedSet={selectedSet}
          selectedPage={selectedPage}
          onSelectSet={setSelectedSet}
          onSelectPage={setSelectedPage}
        />

        <div className="flex min-h-screen flex-1 flex-col">
          <header className="sticky top-0 z-20 border-b border-white/8 bg-[#111214]/88 backdrop-blur-xl">
            <div className="px-5 py-5 sm:px-8">
              <p className="text-xs font-medium uppercase tracking-[0.28em] text-white/40">Concept gallery</p>
              <h1 className="mt-2 text-3xl font-medium tracking-tight text-white sm:text-4xl">
                UI Direction Explorations
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-white/58">
                Five distinct design directions for the OverDrafter CNC quoting workspace, each rendered with live React components and shared mock machining data.
              </p>
            </div>
          </header>

          <div className="border-b border-white/8 bg-[#111214]/60 px-5 py-3 sm:px-8">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <SetSwitcher selectedSet={selectedSet} onSelect={setSelectedSet} />
              <PageSwitcher selectedPage={selectedPage} onSelect={setSelectedPage} />
            </div>
          </div>

          <div className="px-5 py-6 sm:px-8 sm:py-8">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className={cn("text-sm font-semibold", currentSet?.accent)}>
                  Set {selectedSet} — {currentSet?.name}
                </span>
                <span className="text-white/25">/</span>
                <span className="text-sm font-medium text-white/70">{currentPage?.label} Page</span>
              </div>
              <span className="ml-auto text-xs text-white/30">{currentSet?.direction}</span>
            </div>

            <div className="overflow-hidden rounded-[28px] border border-white/10 bg-[#08111c]/90 shadow-[0_26px_70px_rgba(0,0,0,0.28)]">
              <div className="flex items-center gap-2 border-b border-white/8 bg-white/[0.02] px-4 py-3">
                <div className="flex gap-1.5">
                  <div className="h-3 w-3 rounded-full bg-white/10" />
                  <div className="h-3 w-3 rounded-full bg-white/10" />
                  <div className="h-3 w-3 rounded-full bg-white/10" />
                </div>
                <div className="flex-1 rounded-full border border-white/8 bg-white/[0.04] px-3 py-1 text-center text-[11px] text-white/30">
                  overdrafter.app/{selectedPage === "home" ? "" : selectedPage === "project" ? "projects/proj-1" : "parts/part-1"}
                </div>
              </div>
              <div className="h-[720px] overflow-hidden">
                <Component />
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
};
