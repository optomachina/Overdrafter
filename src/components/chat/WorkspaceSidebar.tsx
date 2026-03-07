import { type ReactNode, useCallback, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  Clock3,
  Folder,
  FolderPlus,
  ListFilter,
  PenLine,
  Pin,
  PlusSquare,
  Search,
  Shapes,
  Star,
} from "lucide-react";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export type WorkspaceSidebarProject = {
  id: string;
  name: string;
  partCount: number;
  inviteCount?: number;
  roleLabel?: string;
  isReadOnly?: boolean;
  canManage?: boolean;
  canRename?: boolean;
  canDelete?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
};

type SidebarOrganizeMode = "by_project" | "chronological";
type SidebarSortMode = "created" | "updated";
type SidebarShowMode = "all" | "relevant";
type SidebarSectionKey = "projects" | "parts";

type SidebarFilters = {
  organize: SidebarOrganizeMode;
  sortBy: SidebarSortMode;
  show: SidebarShowMode;
};

type SidebarSections = Record<SidebarSectionKey, boolean>;

type WorkspaceSidebarProps = {
  projects: WorkspaceSidebarProject[];
  jobs: JobRecord[];
  summariesByJobId: Map<string, JobPartSummary>;
  activeProjectId?: string | null;
  activeJobId?: string | null;
  onCreateJob?: () => void;
  onSearch?: () => void;
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

const DEFAULT_SECTIONS: SidebarSections = {
  projects: true,
  parts: true,
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

function readExpandedSections(storageKey: string): SidebarSections {
  try {
    const raw = window.localStorage.getItem(storageKey);

    if (!raw) {
      return DEFAULT_SECTIONS;
    }

    const parsed = JSON.parse(raw) as Partial<Record<SidebarSectionKey, unknown>>;

    return {
      projects: typeof parsed.projects === "boolean" ? parsed.projects : DEFAULT_SECTIONS.projects,
      parts: typeof parsed.parts === "boolean" ? parsed.parts : DEFAULT_SECTIONS.parts,
    };
  } catch {
    return DEFAULT_SECTIONS;
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
  return <p className="px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">{children}</p>;
}

function SidebarSectionHeading({
  label,
  action,
  expanded,
  onToggle,
}: {
  label: string;
  action?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-2.5">
      {onToggle ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} ${label.toLowerCase()}`}
          className="flex items-center gap-1.5 rounded-[10px] py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-white/38 transition-colors hover:text-white/68"
          onClick={onToggle}
        >
          <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded ? "rotate-90" : "")} />
          <span>{label}</span>
        </button>
      ) : (
        <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-white/38">{label}</p>
      )}
      {action}
    </div>
  );
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
      className="flex items-center gap-3 rounded-[10px] px-2.5 py-2 text-sm text-white/90 focus:bg-white/[0.08] focus:text-white"
      onSelect={(event) => {
        event.preventDefault();
        onSelect();
      }}
    >
      <span className="text-white/72">{icon}</span>
      <span>{label}</span>
      {selected ? <Check className="ml-auto h-4 w-4 text-white/82" /> : null}
    </DropdownMenuItem>
  );
}

export function WorkspaceSidebar({
  projects,
  jobs,
  summariesByJobId,
  activeProjectId,
  activeJobId,
  onCreateJob,
  onSearch,
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
  const sectionsStorageKey = `workspace-sidebar-sections-v1:${storageScopeKey ?? "default"}`;

  const [filters, setFilters] = useState<SidebarFilters>(() =>
    typeof window === "undefined" ? DEFAULT_FILTERS : readFilters(filtersStorageKey),
  );
  const [expandedSections, setExpandedSections] = useState<SidebarSections>(() =>
    typeof window === "undefined" ? DEFAULT_SECTIONS : readExpandedSections(sectionsStorageKey),
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
  const [openContextTarget, setOpenContextTarget] = useState<string | null>(null);

  const pinnedProjectSet = useMemo(() => new Set(pinnedProjectIds), [pinnedProjectIds]);
  const pinnedPartSet = useMemo(() => new Set(pinnedJobIds), [pinnedJobIds]);
  const projectsById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const assignableProjects = useMemo(
    () => projects.filter((project) => !project.isReadOnly),
    [projects],
  );

  const getProjectIdForJob = useCallback(
    (job: JobRecord) => {
      if (resolveProjectIdForJob) {
        return resolveProjectIdForJob(job);
      }

      return job.project_id;
    },
    [resolveProjectIdForJob],
  );

  const getJobSortTimestamp = useCallback(
    (job: JobRecord) =>
      filters.sortBy === "created" ? parseTimestamp(job.created_at) : parseTimestamp(job.updated_at ?? job.created_at),
    [filters.sortBy],
  );

  const sortedJobs = useCallback(
    (input: JobRecord[]) =>
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
      }),
    [getJobSortTimestamp, pinnedPartSet],
  );

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
  }, [getProjectIdForJob, jobs, projectsById]);

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
  }, [filters.sortBy, getJobSortTimestamp, jobsByProjectId.grouped, pinnedProjectSet, projects]);

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

  const persistExpandedSections = (next: SidebarSections) => {
    setExpandedSections(next);

    try {
      window.localStorage.setItem(sectionsStorageKey, JSON.stringify(next));
    } catch {
      // Ignore storage failures.
    }
  };

  const isProjectExpanded = (projectId: string) => {
    if (expandedProjects[projectId] !== undefined) {
      return expandedProjects[projectId];
    }

    return false;
  };

  const toggleProjectExpanded = (projectId: string) => {
    const next = {
      ...expandedProjects,
      [projectId]: !isProjectExpanded(projectId),
    };

    persistExpandedProjects(next);
  };

  const toggleSectionExpanded = (section: SidebarSectionKey) => {
    persistExpandedSections({
      ...expandedSections,
      [section]: !expandedSections[section],
    });
  };

  const withBusyProjectPin = async (projectId: string, callback: () => Promise<void> | void) => {
    setPendingProjectPinIds((current) => (current.includes(projectId) ? current : [...current, projectId]));

    try {
      await callback();
    } catch {
      // Parent handlers report errors.
    } finally {
      setPendingProjectPinIds((current) => current.filter((id) => id !== projectId));
    }
  };

  const withBusyPartPin = async (jobId: string, callback: () => Promise<void> | void) => {
    setPendingPartPinIds((current) => (current.includes(jobId) ? current : [...current, jobId]));

    try {
      await callback();
    } catch {
      // Parent handlers report errors.
    } finally {
      setPendingPartPinIds((current) => current.filter((id) => id !== jobId));
    }
  };

  const withBusyPartMove = async (jobId: string, callback: () => Promise<void> | void) => {
    setPendingMovePartIds((current) => (current.includes(jobId) ? current : [...current, jobId]));

    try {
      await callback();
    } catch {
      // Parent handlers report errors.
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
    const parentProject = currentProjectId ? projectsById.get(currentProjectId) ?? null : null;
    const isPinBusy = pendingPartPinIds.includes(job.id);
    const isMoveBusy = pendingMovePartIds.includes(job.id);

    return (
      <ContextMenu
        key={job.id}
        onOpenChange={(open) => {
          setOpenContextTarget(open ? `part:${job.id}` : (current) => (current === `part:${job.id}` ? null : current));
        }}
      >
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            onClick={() => {
              if (openContextTarget === `part:${job.id}`) {
                setOpenContextTarget(null);
                return;
              }

              onSelectPart(job.id);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectPart(job.id);
              }
            }}
            className={cn(
              "group flex w-full items-center gap-2.5 text-left transition-colors",
              nestedInProject ? "rounded-[10px] px-2.5 py-2" : "rounded-[10px] px-2.5 py-2",
              activeJobId === job.id
                ? "bg-white/[0.08] text-white"
                : "text-white/[0.72] hover:bg-white/[0.06] hover:text-white",
            )}
          >
            <Shapes className="h-4 w-4 shrink-0 text-white/[0.42]" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm leading-5">{presentation.title}</p>
              {!nestedInProject && parentProject ? (
                <p className="truncate text-[12px] leading-4 text-white/[0.38]">{parentProject.name}</p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label={isPinned ? "Unpin part" : "Pin part"}
              className={cn(
                "rounded-[8px] p-1 text-white/[0.58] transition-colors hover:bg-white/[0.08] hover:text-white",
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
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="chatgpt-shell w-56 rounded-xl border-white/[0.08] bg-[#2a2a2a] p-1 text-white">
          <ContextMenuItem onSelect={() => onSelectPart(job.id)}>Edit part</ContextMenuItem>

          {onAssignPartToProject ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger inset>Add to project</ContextMenuSubTrigger>
              <ContextMenuSubContent className="chatgpt-shell max-h-[280px] w-56 overflow-y-auto rounded-xl border-white/[0.08] bg-[#2a2a2a] p-1 text-white">
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
    const projectPartCount = projectJobs.length || project.partCount;

    return (
      <div key={project.id} className="space-y-1">
        <ContextMenu
          onOpenChange={(open) => {
            setOpenContextTarget(
              open ? `project:${project.id}` : (current) => (current === `project:${project.id}` ? null : current),
            );
          }}
        >
          <ContextMenuTrigger asChild>
            <div
              role="button"
              tabIndex={0}
              onClick={() => {
                if (openContextTarget === `project:${project.id}`) {
                  setOpenContextTarget(null);
                  return;
                }

                onSelectProject(project.id);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelectProject(project.id);
                }
              }}
              className={cn(
                "group flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left transition-colors",
                activeProjectId === project.id
                  ? "bg-white/[0.08] text-white"
                  : "text-white/[0.72] hover:bg-white/[0.06] hover:text-white",
              )}
            >
              {projectJobs.length > 0 ? (
                <button
                  type="button"
                  aria-label={expanded ? "Collapse project" : "Expand project"}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleProjectExpanded(project.id);
                  }}
                  className="rounded-[8px] p-0.5 text-white/[0.36] transition-colors hover:bg-white/[0.08] hover:text-white"
                >
                  <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded ? "rotate-90" : "")} />
                </button>
              ) : (
                <span className="h-4 w-4 shrink-0" />
              )}
              <Folder className="h-4 w-4 shrink-0 text-white/[0.42]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm leading-5">{project.name}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[11px] text-white/[0.42]">
                  {projectPartCount}
                </span>
                {isPinned ? <Pin className="h-3.5 w-3.5 fill-current text-white/[0.72]" /> : null}
              </div>
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="chatgpt-shell w-56 rounded-xl border-white/[0.08] bg-[#2a2a2a] p-1 text-white">
            <ContextMenuItem onSelect={() => onSelectProject(project.id)}>Edit project</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={isPinBusy}
              onSelect={() => {
                void toggleProjectPin(project.id);
              }}
            >
              {isPinned ? "Unpin" : "Pin"}
            </ContextMenuItem>
            {(project.canRename ?? project.canManage) && onRenameProject ? (
              <ContextMenuItem
                onSelect={() => {
                  setProjectToRename(project);
                  setRenameValue(project.name);
                }}
              >
                Edit project name
              </ContextMenuItem>
            ) : null}
            {(project.canDelete ?? project.canManage) && onDeleteProject ? (
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

        {expanded ? (
          <div className="ml-[14px] space-y-1 border-l border-white/[0.08] pl-3">
            {projectJobs.map((job) => renderPartRow(job, true))}
          </div>
        ) : null}
      </div>
    );
  };

  const visibleProjects = useMemo(
    () =>
      sortedProjects.filter((project) => {
        if (filters.show === "all") {
          return true;
        }

        const projectJobs = jobsByProjectId.grouped.get(project.id) ?? [];
        const hasPinnedJob = projectJobs.some((job) => pinnedPartSet.has(job.id));

        return pinnedProjectSet.has(project.id) || hasPinnedJob;
      }),
    [filters.show, jobsByProjectId.grouped, pinnedPartSet, pinnedProjectSet, sortedProjects],
  );

  const visibleParts = useMemo(
    () => (filters.show === "relevant" ? sortedJobs(jobs.filter((job) => pinnedPartSet.has(job.id))) : sortedJobs(jobs)),
    [filters.show, jobs, pinnedPartSet, sortedJobs],
  );

  const noProjectsMessage = filters.show === "relevant" ? "No pinned projects yet." : "No projects yet.";
  const noPartsMessage = filters.show === "relevant" ? "No pinned parts yet." : "No parts yet.";

  return (
    <>
      <div className="space-y-5">
        {onCreateJob || onSearch ? (
          <div className="space-y-2 px-1.5">
            {onCreateJob ? (
              <Button
                type="button"
                variant="ghost"
                className="h-10 w-full justify-start rounded-[10px] bg-transparent px-3 text-white/[0.88] hover:bg-white/[0.06] hover:text-white"
                onClick={() => {
                  onCreateJob();
                }}
              >
                <span className="flex w-5 shrink-0 items-center justify-center">
                  <PlusSquare aria-hidden="true" className="h-4 w-4" />
                </span>
                <span className="truncate">New Job</span>
              </Button>
            ) : null}

            {onSearch ? (
              <Button
                type="button"
                variant="ghost"
                className="h-10 w-full justify-start rounded-[10px] bg-transparent px-3 text-white/[0.72] hover:bg-white/[0.06] hover:text-white"
                onClick={() => {
                  onSearch();
                }}
              >
                <span className="flex w-5 shrink-0 items-center justify-center">
                  <Search aria-hidden="true" className="h-4 w-4" />
                </span>
                <span className="truncate">Search</span>
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-2">
          <SidebarSectionHeading
            label="Projects"
            expanded={expandedSections.projects}
            onToggle={() => toggleSectionExpanded("projects")}
            action={
              onCreateProject ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="New project"
                  className="h-8 w-8 rounded-[10px] text-white/[0.54] hover:bg-white/[0.06] hover:text-white"
                  disabled={!canCreateProject}
                  onClick={() => {
                    onCreateProject();
                  }}
                >
                  <FolderPlus className="h-4 w-4" />
                </Button>
              ) : null
            }
          />

          {expandedSections.projects ? (
            <div className="space-y-1">
              {visibleProjects.length > 0 ? (
                visibleProjects.map((project) => renderProjectRow(project, jobsByProjectId.grouped.get(project.id) ?? []))
              ) : (
                <div className="px-2.5 py-2 text-sm text-white/[0.42]">{noProjectsMessage}</div>
              )}
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          <SidebarSectionHeading
            label="Parts"
            expanded={expandedSections.parts}
            onToggle={() => toggleSectionExpanded("parts")}
            action={
              <div className="flex items-center gap-1">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Filter parts"
                      className="h-8 w-8 rounded-[10px] text-white/[0.54] hover:bg-white/[0.06] hover:text-white"
                    >
                      <ListFilter className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    className="chatgpt-shell w-64 rounded-xl border-white/[0.08] bg-[#2a2a2a] p-1.5 text-white"
                  >
                    <SectionTitle>Sort by</SectionTitle>
                    <FilterOption
                      icon={<Clock3 className="h-4 w-4" />}
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

                    <DropdownMenuSeparator className="my-1 bg-white/[0.08]" />

                    <SectionTitle>Show</SectionTitle>
                    <FilterOption
                      icon={<Shapes className="h-4 w-4" />}
                      label="All parts"
                      selected={filters.show === "all"}
                      onSelect={() => persistFilters({ ...filters, show: "all" })}
                    />
                    <FilterOption
                      icon={<Star className="h-4 w-4" />}
                      label="Pinned"
                      selected={filters.show === "relevant"}
                      onSelect={() => persistFilters({ ...filters, show: "relevant" })}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            }
          />

          {expandedSections.parts ? (
            <div className="space-y-1">
              {visibleParts.length > 0 ? (
                visibleParts.map((job) => renderPartRow(job))
              ) : (
                <div className="px-2.5 py-2 text-sm text-white/[0.42]">{noPartsMessage}</div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <ProjectNameDialog
        open={Boolean(projectToRename)}
        onOpenChange={(open) => {
          if (!open) {
            setProjectToRename(null);
            setRenameValue("");
          }
        }}
        title="Rename project"
        description="Update the project name shown in your thread list."
        value={renameValue}
        onValueChange={setRenameValue}
        submitLabel="Save"
        isPending={isRenamingProject}
        isSubmitDisabled={
          !projectToRename ||
          !onRenameProject ||
          renameValue.trim().length === 0 ||
          renameValue.trim() === projectToRename.name
        }
        onSubmit={async () => {
          if (!projectToRename || !onRenameProject) {
            return;
          }

          setIsRenamingProject(true);

          try {
            await onRenameProject(projectToRename.id, renameValue.trim());
            setProjectToRename(null);
            setRenameValue("");
          } catch {
            // Parent handlers report errors.
          } finally {
            setIsRenamingProject(false);
          }
        }}
      />

      <Dialog
        open={Boolean(projectToDelete)}
        onOpenChange={(open) => {
          if (!open) {
            setProjectToDelete(null);
          }
        }}
      >
        <DialogContent className="chatgpt-shell rounded-2xl border-white/[0.08] bg-[#2a2a2a] text-white">
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
              className="rounded-[10px] border-white/[0.08] bg-transparent text-white hover:bg-white/[0.06]"
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
                } catch {
                  // Parent handlers report errors.
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
