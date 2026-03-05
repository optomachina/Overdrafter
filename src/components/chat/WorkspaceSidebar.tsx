import { type ReactNode, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  Clock3,
  Folder,
  ListFilter,
  MessageCircle,
  PenLine,
  Pin,
  PlusCircle,
  Sparkles,
  Star,
} from "lucide-react";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type WorkspaceSidebarProject = {
  id: string;
  name: string;
  partCount: number;
  inviteCount?: number;
  roleLabel?: string;
  isReadOnly?: boolean;
  canManage?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type SidebarOrganizeMode = "by_project" | "chronological";
type SidebarSortMode = "created" | "updated";
type SidebarShowMode = "all" | "relevant";

type SidebarFilters = {
  organize: SidebarOrganizeMode;
  sortBy: SidebarSortMode;
  show: SidebarShowMode;
};

type WorkspaceSidebarProps = {
  projects: WorkspaceSidebarProject[];
  jobs: JobRecord[];
  summariesByJobId: Map<string, JobPartSummary>;
  activeProjectId?: string | null;
  activeJobId?: string | null;
  canCreateProject?: boolean;
  onCreateProject?: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectPart: (jobId: string) => void;
  resolveProjectIdForJob?: (job: JobRecord) => string | null;
  storageScopeKey?: string;
  pinnedProjectIds?: string[];
  pinnedJobIds?: string[];
  onPinProject?: (projectId: string) => Promise<void> | void;
  onUnpinProject?: (projectId: string) => Promise<void> | void;
  onPinPart?: (jobId: string) => Promise<void> | void;
  onUnpinPart?: (jobId: string) => Promise<void> | void;
  onAssignPartToProject?: (jobId: string, projectId: string) => Promise<void> | void;
  onRemovePartFromProject?: (jobId: string) => Promise<void> | void;
  onRenameProject?: (projectId: string, name: string) => Promise<void> | void;
  onDeleteProject?: (projectId: string) => Promise<void> | void;
};

const DEFAULT_FILTERS: SidebarFilters = {
  organize: "by_project",
  sortBy: "updated",
  show: "all",
};

function readFilters(storageKey: string): SidebarFilters {
  try {
    const raw = window.localStorage.getItem(storageKey);

    if (!raw) {
      return DEFAULT_FILTERS;
    }

    const parsed = JSON.parse(raw) as Partial<SidebarFilters>;

    return {
      organize:
        parsed.organize === "by_project" || parsed.organize === "chronological"
          ? parsed.organize
          : DEFAULT_FILTERS.organize,
      sortBy: parsed.sortBy === "created" || parsed.sortBy === "updated" ? parsed.sortBy : DEFAULT_FILTERS.sortBy,
      show: parsed.show === "all" || parsed.show === "relevant" ? parsed.show : DEFAULT_FILTERS.show,
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function readExpandedProjects(storageKey: string): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(storageKey);

    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const output: Record<string, boolean> = {};

    Object.entries(parsed).forEach(([projectId, value]) => {
      if (typeof value === "boolean") {
        output[projectId] = value;
      }
    });

    return output;
  } catch {
    return {};
  }
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-xs font-medium text-white/55">{children}</p>;
}

type FilterOptionProps = {
  icon: ReactNode;
  label: string;
  selected: boolean;
  onSelect: () => void;
};

function FilterOption({ icon, label, selected, onSelect }: FilterOptionProps) {
  return (
    <DropdownMenuItem
      className="flex items-center gap-3 rounded-lg px-2 py-2 text-[16px] text-white/92 focus:bg-white/10 focus:text-white"
      onSelect={(event) => {
        event.preventDefault();
        onSelect();
      }}
    >
      <span className="text-white/80">{icon}</span>
      <span>{label}</span>
      {selected ? <Check className="ml-auto h-4 w-4 text-white" /> : null}
    </DropdownMenuItem>
  );
}

export function WorkspaceSidebar({
  projects,
  jobs,
  summariesByJobId,
  activeProjectId,
  activeJobId,
  canCreateProject = true,
  onCreateProject,
  onSelectProject,
  onSelectPart,
  resolveProjectIdForJob,
  storageScopeKey,
  pinnedProjectIds = [],
  pinnedJobIds = [],
  onPinProject,
  onUnpinProject,
  onPinPart,
  onUnpinPart,
  onAssignPartToProject,
  onRemovePartFromProject,
  onRenameProject,
  onDeleteProject,
}: WorkspaceSidebarProps) {
  const filtersStorageKey = `workspace-sidebar-filters-v1:${storageScopeKey ?? "default"}`;
  const expandedStorageKey = `workspace-sidebar-expanded-v1:${storageScopeKey ?? "default"}`;

  const [filters, setFilters] = useState<SidebarFilters>(() =>
    typeof window === "undefined" ? DEFAULT_FILTERS : readFilters(filtersStorageKey),
  );
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>(() =>
    typeof window === "undefined" ? {} : readExpandedProjects(expandedStorageKey),
  );
  const [pendingProjectPinIds, setPendingProjectPinIds] = useState<string[]>([]);
  const [pendingPartPinIds, setPendingPartPinIds] = useState<string[]>([]);
  const [pendingMovePartIds, setPendingMovePartIds] = useState<string[]>([]);
  const [projectToRename, setProjectToRename] = useState<WorkspaceSidebarProject | null>(null);
  const [projectToDelete, setProjectToDelete] = useState<WorkspaceSidebarProject | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isRenamingProject, setIsRenamingProject] = useState(false);
  const [isDeletingProject, setIsDeletingProject] = useState(false);

  const pinnedProjectSet = useMemo(() => new Set(pinnedProjectIds), [pinnedProjectIds]);
  const pinnedPartSet = useMemo(() => new Set(pinnedJobIds), [pinnedJobIds]);
  const projectsById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const assignableProjects = useMemo(
    () => projects.filter((project) => !project.isReadOnly),
    [projects],
  );

  const getProjectIdForJob = (job: JobRecord) => {
    if (resolveProjectIdForJob) {
      return resolveProjectIdForJob(job);
    }

    return job.project_id;
  };

  const getJobSortTimestamp = (job: JobRecord) =>
    filters.sortBy === "created" ? parseTimestamp(job.created_at) : parseTimestamp(job.updated_at ?? job.created_at);

  const sortedJobs = (input: JobRecord[]) =>
    [...input].sort((left, right) => {
      const pinOrder = Number(pinnedPartSet.has(right.id)) - Number(pinnedPartSet.has(left.id));
      if (pinOrder !== 0) {
        return pinOrder;
      }

      const timeOrder = getJobSortTimestamp(right) - getJobSortTimestamp(left);
      if (timeOrder !== 0) {
        return timeOrder;
      }

      return left.title.localeCompare(right.title);
    });

  const jobsByProjectId = useMemo(() => {
    const grouped = new Map<string, JobRecord[]>();
    const ungrouped: JobRecord[] = [];

    jobs.forEach((job) => {
      const projectId = getProjectIdForJob(job);

      if (projectId && projectsById.has(projectId)) {
        const projectJobs = grouped.get(projectId) ?? [];
        projectJobs.push(job);
        grouped.set(projectId, projectJobs);
        return;
      }

      ungrouped.push(job);
    });

    return {
      grouped,
      ungrouped,
    };
  }, [jobs, projectsById]);

  const sortedProjects = useMemo(() => {
    const getProjectSortTimestamp = (project: WorkspaceSidebarProject) => {
      const projectJobs = jobsByProjectId.grouped.get(project.id) ?? [];

      if (projectJobs.length > 0) {
        return projectJobs.reduce((maxTimestamp, job) => Math.max(maxTimestamp, getJobSortTimestamp(job)), 0);
      }

      const fallback = filters.sortBy === "created" ? project.createdAt : project.updatedAt ?? project.createdAt;
      return parseTimestamp(fallback);
    };

    return [...projects].sort((left, right) => {
      const pinOrder = Number(pinnedProjectSet.has(right.id)) - Number(pinnedProjectSet.has(left.id));
      if (pinOrder !== 0) {
        return pinOrder;
      }

      const timeOrder = getProjectSortTimestamp(right) - getProjectSortTimestamp(left);
      if (timeOrder !== 0) {
        return timeOrder;
      }

      return left.name.localeCompare(right.name);
    });
  }, [filters.sortBy, jobsByProjectId.grouped, pinnedProjectSet, projects]);

  const groupedProjectRows = useMemo(() => {
    if (filters.organize !== "by_project") {
      return [] as Array<{ project: WorkspaceSidebarProject; jobs: JobRecord[] }>;
    }

    return sortedProjects
      .filter((project) => {
        if (filters.show === "all") {
          return true;
        }

        const projectJobs = jobsByProjectId.grouped.get(project.id) ?? [];
        const hasPinnedJob = projectJobs.some((job) => pinnedPartSet.has(job.id));

        return pinnedProjectSet.has(project.id) || hasPinnedJob;
      })
      .map((project) => {
        const projectJobs = jobsByProjectId.grouped.get(project.id) ?? [];

        return {
          project,
          jobs:
            filters.show === "relevant"
              ? sortedJobs(projectJobs.filter((job) => pinnedPartSet.has(job.id)))
              : sortedJobs(projectJobs),
        };
      });
  }, [filters.organize, filters.show, jobsByProjectId.grouped, pinnedPartSet, pinnedProjectSet, sortedProjects]);

  const groupedUngroupedJobs = useMemo(() => {
    if (filters.organize !== "by_project") {
      return [] as JobRecord[];
    }

    if (filters.show === "relevant") {
      return sortedJobs(jobsByProjectId.ungrouped.filter((job) => pinnedPartSet.has(job.id)));
    }

    return sortedJobs(jobsByProjectId.ungrouped);
  }, [filters.organize, filters.show, jobsByProjectId.ungrouped, pinnedPartSet]);

  const chronologicalJobs = useMemo(() => {
    if (filters.organize !== "chronological") {
      return [] as JobRecord[];
    }

    if (filters.show === "relevant") {
      return sortedJobs(jobs.filter((job) => pinnedPartSet.has(job.id)));
    }

    return sortedJobs(jobs);
  }, [filters.organize, filters.show, jobs, pinnedPartSet]);

  const persistFilters = (next: SidebarFilters) => {
    setFilters(next);

    try {
      window.localStorage.setItem(filtersStorageKey, JSON.stringify(next));
    } catch {
      // Ignore storage failures.
    }
  };

  const persistExpandedProjects = (next: Record<string, boolean>) => {
    setExpandedProjects(next);

    try {
      window.localStorage.setItem(expandedStorageKey, JSON.stringify(next));
    } catch {
      // Ignore storage failures.
    }
  };

  const isProjectExpanded = (projectId: string) => {
    if (expandedProjects[projectId] !== undefined) {
      return expandedProjects[projectId];
    }

    return activeProjectId === projectId;
  };

  const toggleProjectExpanded = (projectId: string) => {
    const next = {
      ...expandedProjects,
      [projectId]: !isProjectExpanded(projectId),
    };

    persistExpandedProjects(next);
  };

  const withBusyProjectPin = async (projectId: string, callback: () => Promise<void> | void) => {
    setPendingProjectPinIds((current) => (current.includes(projectId) ? current : [...current, projectId]));

    try {
      await callback();
    } finally {
      setPendingProjectPinIds((current) => current.filter((id) => id !== projectId));
    }
  };

  const withBusyPartPin = async (jobId: string, callback: () => Promise<void> | void) => {
    setPendingPartPinIds((current) => (current.includes(jobId) ? current : [...current, jobId]));

    try {
      await callback();
    } finally {
      setPendingPartPinIds((current) => current.filter((id) => id !== jobId));
    }
  };

  const withBusyPartMove = async (jobId: string, callback: () => Promise<void> | void) => {
    setPendingMovePartIds((current) => (current.includes(jobId) ? current : [...current, jobId]));

    try {
      await callback();
    } finally {
      setPendingMovePartIds((current) => current.filter((id) => id !== jobId));
    }
  };

  const toggleProjectPin = async (projectId: string) => {
    const isPinned = pinnedProjectSet.has(projectId);

    if (isPinned) {
      if (!onUnpinProject) {
        return;
      }

      await withBusyProjectPin(projectId, async () => {
        await onUnpinProject(projectId);
      });
      return;
    }

    if (!onPinProject) {
      return;
    }

    await withBusyProjectPin(projectId, async () => {
      await onPinProject(projectId);
    });
  };

  const togglePartPin = async (jobId: string) => {
    const isPinned = pinnedPartSet.has(jobId);

    if (isPinned) {
      if (!onUnpinPart) {
        return;
      }

      await withBusyPartPin(jobId, async () => {
        await onUnpinPart(jobId);
      });
      return;
    }

    if (!onPinPart) {
      return;
    }

    await withBusyPartPin(jobId, async () => {
      await onPinPart(jobId);
    });
  };

  const renderPartRow = (job: JobRecord, nestedInProject = false) => {
    const presentation = getClientItemPresentation(job, summariesByJobId.get(job.id));
    const isPinned = pinnedPartSet.has(job.id);
    const currentProjectId = getProjectIdForJob(job);
    const isPinBusy = pendingPartPinIds.includes(job.id);
    const isMoveBusy = pendingMovePartIds.includes(job.id);

    return (
      <ContextMenu key={job.id}>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={() => onSelectPart(job.id)}
            className={cn(
              "group flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition",
              nestedInProject ? "ml-6 w-[calc(100%-1.5rem)]" : "",
              activeJobId === job.id ? "bg-white/12 text-white" : "text-white/82 hover:bg-white/7 hover:text-white",
            )}
          >
            <MessageCircle className="h-4 w-4 shrink-0 text-white/45" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{presentation.title}</p>
            </div>
            <button
              type="button"
              aria-label={isPinned ? "Unpin part" : "Pin part"}
              className={cn(
                "rounded-md p-1 text-white/70 transition hover:bg-white/10 hover:text-white",
                isPinned ? "opacity-100" : "opacity-0 group-hover:opacity-100",
              )}
              disabled={isPinBusy}
              onClick={(event) => {
                event.stopPropagation();
                void togglePartPin(job.id);
              }}
            >
              <Pin className={cn("h-3.5 w-3.5", isPinned ? "fill-current" : "")} />
            </button>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-56 border-white/10 bg-[#1f1f1f] text-white">
          <ContextMenuItem onSelect={() => onSelectPart(job.id)}>See details</ContextMenuItem>

          {onAssignPartToProject ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger inset>Add to project</ContextMenuSubTrigger>
              <ContextMenuSubContent className="max-h-[280px] w-56 overflow-y-auto border-white/10 bg-[#1f1f1f] text-white">
                {assignableProjects.filter((project) => project.id !== currentProjectId).length === 0 ? (
                  <ContextMenuItem disabled>No projects available</ContextMenuItem>
                ) : (
                  assignableProjects
                    .filter((project) => project.id !== currentProjectId)
                    .map((project) => (
                      <ContextMenuItem
                        key={project.id}
                        disabled={isMoveBusy}
                        onSelect={() => {
                          void withBusyPartMove(job.id, async () => {
                            await onAssignPartToProject(job.id, project.id);
                          });
                        }}
                      >
                        {project.name}
                      </ContextMenuItem>
                    ))
                )}
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : null}

          {currentProjectId && onRemovePartFromProject ? (
            <ContextMenuItem
              disabled={isMoveBusy}
              onSelect={() => {
                void withBusyPartMove(job.id, async () => {
                  await onRemovePartFromProject(job.id);
                });
              }}
            >
              Remove from project
            </ContextMenuItem>
          ) : null}

          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={isPinBusy}
            onSelect={() => {
              void togglePartPin(job.id);
            }}
          >
            {isPinned ? "Unpin" : "Pin"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const renderProjectRow = (project: WorkspaceSidebarProject, projectJobs: JobRecord[]) => {
    const isPinned = pinnedProjectSet.has(project.id);
    const isPinBusy = pendingProjectPinIds.includes(project.id);
    const expanded = isProjectExpanded(project.id);

    return (
      <div key={project.id} className="space-y-1">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              onClick={() => onSelectProject(project.id)}
              className={cn(
                "group flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition",
                activeProjectId === project.id
                  ? "bg-white/12 text-white"
                  : "text-white/82 hover:bg-white/7 hover:text-white",
              )}
            >
              <button
                type="button"
                aria-label={expanded ? "Collapse project" : "Expand project"}
                onClick={(event) => {
                  event.stopPropagation();
                  toggleProjectExpanded(project.id);
                }}
                className={cn(
                  "rounded-md p-0.5 text-white/55 transition hover:bg-white/10 hover:text-white",
                  expanded ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                )}
              >
                <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded ? "rotate-90" : "")} />
              </button>
              <Folder className="h-4 w-4 shrink-0 text-white/45" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{project.name}</p>
              </div>
              {isPinned ? <Pin className="h-3.5 w-3.5 fill-current text-white/80" /> : null}
            </button>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-56 border-white/10 bg-[#1f1f1f] text-white">
            <ContextMenuItem onSelect={() => onSelectProject(project.id)}>See details</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={isPinBusy}
              onSelect={() => {
                void toggleProjectPin(project.id);
              }}
            >
              {isPinned ? "Unpin" : "Pin"}
            </ContextMenuItem>
            {project.canManage && onRenameProject ? (
              <ContextMenuItem
                onSelect={() => {
                  setProjectToRename(project);
                  setRenameValue(project.name);
                }}
              >
                Rename
              </ContextMenuItem>
            ) : null}
            {project.canManage && onDeleteProject ? (
              <ContextMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => {
                  setProjectToDelete(project);
                }}
              >
                Delete
              </ContextMenuItem>
            ) : null}
          </ContextMenuContent>
        </ContextMenu>

        {expanded ? <div className="space-y-1">{projectJobs.map((job) => renderPartRow(job, true))}</div> : null}
      </div>
    );
  };

  const noThreadsMessage =
    filters.show === "relevant" ? "No pinned threads yet." : filters.organize === "chronological" ? "No threads yet." : "No projects yet.";

  const hasByProjectContent = groupedProjectRows.length > 0 || groupedUngroupedJobs.length > 0;
  const hasChronologicalContent = chronologicalJobs.length > 0;

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-center justify-between px-1">
          <p className="px-2 text-[30px] font-medium text-white/75">Threads</p>
          <div className="flex items-center gap-1">
            {onCreateProject ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Create project"
                className="h-8 w-8 rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
                disabled={!canCreateProject}
                onClick={onCreateProject}
              >
                <Folder className="h-4 w-4" />
              </Button>
            ) : null}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Filter threads"
                  className="h-8 w-8 rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
                >
                  <ListFilter className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72 border-white/10 bg-[#1f1f1f] p-2 text-white">
                <SectionTitle>Organize</SectionTitle>
                <FilterOption
                  icon={<Folder className="h-4 w-4" />}
                  label="By project"
                  selected={filters.organize === "by_project"}
                  onSelect={() => persistFilters({ ...filters, organize: "by_project" })}
                />
                <FilterOption
                  icon={<Clock3 className="h-4 w-4" />}
                  label="Chronological list"
                  selected={filters.organize === "chronological"}
                  onSelect={() => persistFilters({ ...filters, organize: "chronological" })}
                />

                <DropdownMenuSeparator className="my-1 bg-white/10" />

                <SectionTitle>Sort by</SectionTitle>
                <FilterOption
                  icon={<PlusCircle className="h-4 w-4" />}
                  label="Created"
                  selected={filters.sortBy === "created"}
                  onSelect={() => persistFilters({ ...filters, sortBy: "created" })}
                />
                <FilterOption
                  icon={<PenLine className="h-4 w-4" />}
                  label="Updated"
                  selected={filters.sortBy === "updated"}
                  onSelect={() => persistFilters({ ...filters, sortBy: "updated" })}
                />

                <DropdownMenuSeparator className="my-1 bg-white/10" />

                <SectionTitle>Show</SectionTitle>
                <FilterOption
                  icon={<MessageCircle className="h-4 w-4" />}
                  label="All threads"
                  selected={filters.show === "all"}
                  onSelect={() => persistFilters({ ...filters, show: "all" })}
                />
                <FilterOption
                  icon={<Star className="h-4 w-4" />}
                  label="Relevant"
                  selected={filters.show === "relevant"}
                  onSelect={() => persistFilters({ ...filters, show: "relevant" })}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="space-y-1">
          {filters.organize === "by_project" ? (
            hasByProjectContent ? (
              <>
                {groupedProjectRows.map(({ project, jobs: projectJobs }) => renderProjectRow(project, projectJobs))}
                {groupedUngroupedJobs.map((job) => renderPartRow(job))}
              </>
            ) : (
              <div className="px-2 py-3 text-sm text-white/45">{noThreadsMessage}</div>
            )
          ) : hasChronologicalContent ? (
            chronologicalJobs.map((job) => renderPartRow(job))
          ) : (
            <div className="px-2 py-3 text-sm text-white/45">{noThreadsMessage}</div>
          )}
        </div>
      </div>

      <Dialog
        open={Boolean(projectToRename)}
        onOpenChange={(open) => {
          if (!open) {
            setProjectToRename(null);
            setRenameValue("");
          }
        }}
      >
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription className="text-white/55">
              Update the project name shown in your thread list.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            className="border-white/10 bg-[#2a2a2a] text-white"
          />
          <DialogFooter>
            <Button
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => {
                setProjectToRename(null);
                setRenameValue("");
              }}
            >
              Cancel
            </Button>
            <Button
              className="rounded-full"
              disabled={
                !projectToRename ||
                !onRenameProject ||
                isRenamingProject ||
                renameValue.trim().length === 0 ||
                renameValue.trim() === projectToRename.name
              }
              onClick={async () => {
                if (!projectToRename || !onRenameProject) {
                  return;
                }

                setIsRenamingProject(true);

                try {
                  await onRenameProject(projectToRename.id, renameValue.trim());
                  setProjectToRename(null);
                  setRenameValue("");
                } finally {
                  setIsRenamingProject(false);
                }
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(projectToDelete)}
        onOpenChange={(open) => {
          if (!open) {
            setProjectToDelete(null);
          }
        }}
      >
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
            <DialogDescription className="text-white/55">
              {projectToDelete
                ? `Delete ${projectToDelete.name} and move its parts back to ungrouped threads.`
                : "Delete this project."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => setProjectToDelete(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!projectToDelete || !onDeleteProject || isDeletingProject}
              onClick={async () => {
                if (!projectToDelete || !onDeleteProject) {
                  return;
                }

                setIsDeletingProject(true);

                try {
                  await onDeleteProject(projectToDelete.id);
                  setProjectToDelete(null);
                } finally {
                  setIsDeletingProject(false);
                }
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
