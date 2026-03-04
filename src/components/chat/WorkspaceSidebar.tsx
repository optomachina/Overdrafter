import { type ReactNode } from "react";
import { FolderPlus, FolderKanban, PlusSquare, Search, Shapes } from "lucide-react";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type WorkspaceSidebarProject = {
  id: string;
  name: string;
  partCount: number;
  inviteCount?: number;
  roleLabel?: string;
  isReadOnly?: boolean;
};

type WorkspaceSidebarProps = {
  projects: WorkspaceSidebarProject[];
  yourParts: JobRecord[];
  summariesByJobId: Map<string, JobPartSummary>;
  activeProjectId?: string | null;
  activeJobId?: string | null;
  canCreateProject?: boolean;
  onCreateProject?: () => void;
  onNewPart: () => void;
  onSearchParts: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectPart: (jobId: string) => void;
};

function SidebarButton({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-white/85 transition hover:bg-white/6"
    >
      <span className="text-white/65">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export function WorkspaceSidebar({
  projects,
  yourParts,
  summariesByJobId,
  activeProjectId,
  activeJobId,
  canCreateProject = true,
  onCreateProject,
  onNewPart,
  onSearchParts,
  onSelectProject,
  onSelectPart,
}: WorkspaceSidebarProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <SidebarButton icon={<PlusSquare className="h-4 w-4" />} label="New Part" onClick={onNewPart} />
        <SidebarButton icon={<Search className="h-4 w-4" />} label="Search Parts" onClick={onSearchParts} />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between px-3">
          <p className="text-xs font-medium uppercase tracking-[0.18em] text-white/35">Projects</p>
          {onCreateProject ? (
            <Button
              type="button"
              variant="ghost"
              className="h-8 rounded-full px-3 text-xs text-white/70 hover:bg-white/6 hover:text-white"
              disabled={!canCreateProject}
              onClick={onCreateProject}
            >
              <FolderPlus className="mr-2 h-3.5 w-3.5" />
              New project
            </Button>
          ) : null}
        </div>

        <div className="space-y-1">
          <p className="px-3 text-xs uppercase tracking-[0.14em] text-white/28">Group Projects</p>
          {projects.length === 0 ? (
            <div className="px-3 py-2 text-sm text-white/40">No projects yet.</div>
          ) : (
            projects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => onSelectProject(project.id)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition",
                  activeProjectId === project.id
                    ? "bg-white/10 text-white"
                    : "text-white/75 hover:bg-white/6 hover:text-white",
                )}
              >
                <FolderKanban className="h-4 w-4 shrink-0 text-white/55" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{project.name}</p>
                  <p className="text-xs text-white/40">{project.partCount} parts</p>
                </div>
                {project.roleLabel ? (
                  <span className="rounded-full bg-white/6 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-white/45">
                    {project.roleLabel}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>

        <div className="space-y-1">
          <p className="px-3 text-xs uppercase tracking-[0.14em] text-white/28">Your Parts</p>
          {yourParts.length === 0 ? (
            <div className="px-3 py-2 text-sm text-white/40">No ungrouped parts.</div>
          ) : (
            yourParts.map((job) => {
              const presentation = getClientItemPresentation(job, summariesByJobId.get(job.id));

              return (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => onSelectPart(job.id)}
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl px-3 py-2 text-left transition",
                    activeJobId === job.id
                      ? "bg-white/10 text-white"
                      : "text-white/75 hover:bg-white/6 hover:text-white",
                  )}
                >
                  <Shapes className="mt-0.5 h-4 w-4 shrink-0 text-white/55" />
                  <div className="min-w-0">
                    <p className="truncate text-sm">{presentation.title}</p>
                    <p className="truncate text-xs text-white/40">{presentation.description}</p>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
