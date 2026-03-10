import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { PartContextMenuActions } from "@/components/chat/PartActionsMenu";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
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
import { cn } from "@/lib/utils";

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
  onCreateProject?: () => void;
  onSearch?: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectPart: (jobId: string) => void;
  onPrefetchProject?: (projectId: string) => void;
  onPrefetchPart?: (jobId: string) => void;
  resolveProjectIdsForJob?: (job: JobRecord) => string[];
  storageScopeKey?: string;
  pinnedProjectIds?: string[];
  pinnedJobIds?: string[];
  onPinProject?: (projectId: string) => Promise<void> | void;
  onUnpinProject?: (projectId: string) => Promise<void> | void;
  onPinPart?: (jobId: string) => Promise<void> | void;
  onUnpinPart?: (jobId: string) => Promise<void> | void;
  onAssignPartToProject?: (jobId: string, projectId: string) => Promise<void> | void;
  onRemovePartFromProject?: (jobId: string, projectId: string) => Promise<void> | void;
  onCreateProjectFromSelection?: (jobIds: string[]) => Promise<void> | void;
  onRenameProject?: (projectId: string, name: string) => Promise<void> | void;
  onRenamePart?: (jobId: string, name: string) => Promise<void> | void;
  onDeleteProject?: (projectId: string) => Promise<void> | void;
  onArchivePart?: (jobId: string) => Promise<void> | void;
  onArchiveProject?: (projectId: string) => Promise<void> | void;
  onDissolveProject?: (projectId: string) => Promise<void> | void;
};

type RenderPartRowOptions = {
  contextProjectId?: string | null;
  nestedInProject?: boolean;
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

const SIDEBAR_COLUMN_INSET_CLASS = "px-2";
const SIDEBAR_ACTION_BUTTON_PADDING_CLASS = "pl-1 pr-3";
const SIDEBAR_ROW_PADDING_CLASS = "px-2 py-2";
const SIDEBAR_PREFETCH_DELAY_MS = 75;

function formatSelectedQuote(summary: JobPartSummary | undefined) {
  if (!summary?.selectedSupplier || summary.selectedPriceUsd === null) {
    return null;
  }

  const price = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(summary.selectedPriceUsd);

  return `${summary.selectedSupplier} · ${price}${
    summary.selectedLeadTimeBusinessDays ? ` · ${summary.selectedLeadTimeBusinessDays}d` : ""
  }`;
}

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

function isMacPlatform() {
  if (typeof navigator === "undefined") {
    return false;
  }

  return /(Mac|iPhone|iPad|iPod)/i.test(navigator.platform || navigator.userAgent);
}

function isAdditiveSelectionInput(input: { ctrlKey: boolean; metaKey: boolean }) {
  return isMacPlatform() ? input.metaKey : input.ctrlKey;
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-white/40">{children}</p>;
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
    <div className={cn("flex items-center justify-between gap-3", SIDEBAR_COLUMN_INSET_CLASS)}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label.toLowerCase()}`}
        className="flex items-center gap-1 rounded-[10px] py-1 text-[11px] font-medium uppercase tracking-[0.14em] text-white/38 transition-colors hover:text-white/68"
        onClick={onToggle}
      >
        <span>{label}</span>
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded ? "rotate-90" : "")} />
      </button>
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
      <span className="text-white/[0.9]">{icon}</span>
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
  onCreateProject,
  onSearch,
  onSelectProject,
  onSelectPart,
  onPrefetchProject,
  onPrefetchPart,
  resolveProjectIdsForJob,
  storageScopeKey,
  pinnedProjectIds = [],
  pinnedJobIds = [],
  onPinProject,
  onUnpinProject,
  onPinPart,
  onUnpinPart,
  onAssignPartToProject,
  onRemovePartFromProject,
  onCreateProjectFromSelection,
  onRenameProject,
  onRenamePart,
  onArchivePart,
  onArchiveProject,
  onDissolveProject,
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
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [selectionAnchorJobId, setSelectionAnchorJobId] = useState<string | null>(null);
  const [contextSelectionJobIds, setContextSelectionJobIds] = useState<string[]>([]);
  const [pendingProjectPinIds, setPendingProjectPinIds] = useState<string[]>([]);
  const [pendingPartPinIds, setPendingPartPinIds] = useState<string[]>([]);
  const [pendingMovePartIds, setPendingMovePartIds] = useState<string[]>([]);
  const [pendingArchivePartIds, setPendingArchivePartIds] = useState<string[]>([]);
  const [projectToRename, setProjectToRename] = useState<WorkspaceSidebarProject | null>(null);
  const [partToRename, setPartToRename] = useState<{ jobId: string; currentName: string } | null>(null);
  const [projectToArchive, setProjectToArchive] = useState<WorkspaceSidebarProject | null>(null);
  const [projectToDissolve, setProjectToDissolve] = useState<WorkspaceSidebarProject | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [isRenamingProject, setIsRenamingProject] = useState(false);
  const [isRenamingPart, setIsRenamingPart] = useState(false);
  const [isArchivingProject, setIsArchivingProject] = useState(false);
  const [isDissolvingProject, setIsDissolvingProject] = useState(false);
  const [isCreatingProjectFromSelection, setIsCreatingProjectFromSelection] = useState(false);
  const [openContextTarget, setOpenContextTarget] = useState<string | null>(null);
  const prefetchTimeoutsRef = useRef<Map<string, number>>(new Map());

  const pinnedProjectSet = useMemo(() => new Set(pinnedProjectIds), [pinnedProjectIds]);
  const pinnedPartSet = useMemo(() => new Set(pinnedJobIds), [pinnedJobIds]);
  const selectedJobIdSet = useMemo(() => new Set(selectedJobIds), [selectedJobIds]);
  const projectsById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);
  const assignableProjects = useMemo(() => projects.filter((project) => !project.isReadOnly), [projects]);

  const getProjectIdsForJob = useCallback(
    (job: JobRecord) => {
      const projectIds = resolveProjectIdsForJob?.(job) ?? (job.project_id ? [job.project_id] : []);
      return [...new Set(projectIds.filter((projectId): projectId is string => Boolean(projectId)))];
    },
    [resolveProjectIdsForJob],
  );

  const schedulePrefetch = useCallback((key: string, action?: () => void) => {
    if (!action) {
      return;
    }

    const existingTimeoutId = prefetchTimeoutsRef.current.get(key);

    if (existingTimeoutId) {
      window.clearTimeout(existingTimeoutId);
    }

    const timeoutId = window.setTimeout(() => {
      prefetchTimeoutsRef.current.delete(key);
      action();
    }, SIDEBAR_PREFETCH_DELAY_MS);

    prefetchTimeoutsRef.current.set(key, timeoutId);
  }, []);

  useEffect(() => {
    const jobIdSet = new Set(jobs.map((job) => job.id));

    setSelectedJobIds((current) => current.filter((jobId) => jobIdSet.has(jobId)));
    setContextSelectionJobIds((current) => current.filter((jobId) => jobIdSet.has(jobId)));
    setSelectionAnchorJobId((current) => (current && jobIdSet.has(current) ? current : null));
  }, [jobs]);

  useEffect(
    () => () => {
      prefetchTimeoutsRef.current.forEach((timeoutId) => {
        window.clearTimeout(timeoutId);
      });
      prefetchTimeoutsRef.current.clear();
    },
    [],
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

    jobs.forEach((job) => {
      getProjectIdsForJob(job)
        .filter((projectId) => projectsById.has(projectId))
        .forEach((projectId) => {
          const projectJobs = grouped.get(projectId) ?? [];
          projectJobs.push(job);
          grouped.set(projectId, projectJobs);
        });
    });

    return grouped;
  }, [getProjectIdsForJob, jobs, projectsById]);

  const ungroupedJobs = useMemo(
    () => jobs.filter((job) => getProjectIdsForJob(job).filter((projectId) => projectsById.has(projectId)).length === 0),
    [getProjectIdsForJob, jobs, projectsById],
  );

  const sortedProjects = useMemo(() => {
    const getProjectSortTimestamp = (project: WorkspaceSidebarProject) => {
      const projectJobs = jobsByProjectId.get(project.id) ?? [];

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
  }, [filters.sortBy, getJobSortTimestamp, jobsByProjectId, pinnedProjectSet, projects]);

  const visibleProjects = useMemo(
    () =>
      sortedProjects.filter((project) => {
        if (filters.show === "all") {
          return true;
        }

        const projectJobs = jobsByProjectId.get(project.id) ?? [];
        return pinnedProjectSet.has(project.id) || projectJobs.some((job) => pinnedPartSet.has(job.id));
      }),
    [filters.show, jobsByProjectId, pinnedPartSet, pinnedProjectSet, sortedProjects],
  );

  const visibleParts = useMemo(
    () =>
      filters.show === "relevant"
        ? sortedJobs(ungroupedJobs.filter((job) => pinnedPartSet.has(job.id)))
        : sortedJobs(ungroupedJobs),
    [filters.show, pinnedPartSet, sortedJobs, ungroupedJobs],
  );

  const selectionOrderJobIds = useMemo(() => visibleParts.map((job) => job.id), [visibleParts]);

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

  const isProjectExpanded = (projectId: string) => expandedProjects[projectId] ?? false;

  const toggleProjectExpanded = (projectId: string) => {
    persistExpandedProjects({
      ...expandedProjects,
      [projectId]: !isProjectExpanded(projectId),
    });
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

  const withBusyPartArchive = async (jobId: string, callback: () => Promise<void> | void) => {
    setPendingArchivePartIds((current) => (current.includes(jobId) ? current : [...current, jobId]));

    try {
      await callback();
    } catch {
      // Parent handlers report errors.
    } finally {
      setPendingArchivePartIds((current) => current.filter((id) => id !== jobId));
    }
  };

  const toggleProjectPin = async (projectId: string) => {
    if (pinnedProjectSet.has(projectId)) {
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
    if (pinnedPartSet.has(jobId)) {
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

  const selectSingleJob = useCallback((jobId: string) => {
    setSelectedJobIds([jobId]);
    setSelectionAnchorJobId(jobId);
  }, []);

  const toggleJobSelection = useCallback((jobId: string) => {
    setSelectedJobIds((current) =>
      current.includes(jobId) ? current.filter((currentJobId) => currentJobId !== jobId) : [...current, jobId],
    );
    setSelectionAnchorJobId(jobId);
  }, []);

  const selectJobRange = useCallback(
    (jobId: string) => {
      const anchorId = selectionAnchorJobId ?? jobId;
      const anchorIndex = selectionOrderJobIds.indexOf(anchorId);
      const targetIndex = selectionOrderJobIds.indexOf(jobId);

      if (anchorIndex === -1 || targetIndex === -1) {
        selectSingleJob(jobId);
        return;
      }

      const [startIndex, endIndex] =
        anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];

      setSelectedJobIds(selectionOrderJobIds.slice(startIndex, endIndex + 1));
      setSelectionAnchorJobId(anchorId);
    },
    [selectSingleJob, selectionAnchorJobId, selectionOrderJobIds],
  );

  const prepareContextSelection = useCallback(
    (jobId: string) => {
      const nextSelection = selectedJobIdSet.has(jobId) ? selectedJobIds : [jobId];

      setContextSelectionJobIds(nextSelection);

      if (!selectedJobIdSet.has(jobId)) {
        setSelectedJobIds([jobId]);
        setSelectionAnchorJobId(jobId);
      }
    },
    [selectedJobIdSet, selectedJobIds],
  );

  const createProjectFromSelection = useCallback(
    async (jobIds: string[]) => {
      if (!onCreateProjectFromSelection || jobIds.length < 2) {
        return;
      }

      setIsCreatingProjectFromSelection(true);

      try {
        await onCreateProjectFromSelection(jobIds);
        setSelectedJobIds([]);
        setSelectionAnchorJobId(null);
        setContextSelectionJobIds([]);
      } catch {
        // Parent handlers report errors.
      } finally {
        setIsCreatingProjectFromSelection(false);
      }
    },
    [onCreateProjectFromSelection],
  );

  const renderPartRow = (job: JobRecord, options: RenderPartRowOptions = {}) => {
    const { contextProjectId = null, nestedInProject = false } = options;
    const summary = summariesByJobId.get(job.id);
    const presentation = getClientItemPresentation(job, summary);
    const selectedQuote = formatSelectedQuote(summary);
    const currentProjectIds = getProjectIdsForJob(job).filter((projectId) => projectsById.has(projectId));
    const currentProjectIdSet = new Set(currentProjectIds);
    const isPinned = pinnedPartSet.has(job.id);
    const isSelected = selectedJobIdSet.has(job.id);
    const isPinBusy = pendingPartPinIds.includes(job.id);
    const isMoveBusy = pendingMovePartIds.includes(job.id);
    const isArchiveBusy = pendingArchivePartIds.includes(job.id);
    const contextKey = `part:${job.id}:${contextProjectId ?? "all"}`;
    const contextSelection =
      openContextTarget === contextKey && contextSelectionJobIds.length > 0
        ? contextSelectionJobIds
        : isSelected
          ? selectedJobIds
          : [job.id];
    const showBatchAction = contextSelection.length > 1 && contextSelection.includes(job.id);
    const removableProjectIds =
      contextProjectId !== null
        ? [contextProjectId]
        : currentProjectIds.filter((projectId) => !projectsById.get(projectId)?.isReadOnly);
    const addableProjects = assignableProjects.filter((project) => !currentProjectIdSet.has(project.id));
    const parentProjectNames = currentProjectIds
      .map((projectId) => projectsById.get(projectId)?.name)
      .filter((name): name is string => Boolean(name));

    return (
      <ContextMenu
        key={`${job.id}:${contextProjectId ?? "all"}`}
        onOpenChange={(open) => {
          setOpenContextTarget((current) => {
            if (open) {
              return contextKey;
            }

            return current === contextKey ? null : current;
          });

          if (!open) {
            setContextSelectionJobIds([]);
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <div
            role="button"
            tabIndex={0}
            onClick={(event) => {
              if (openContextTarget === contextKey) {
                setOpenContextTarget(null);
                return;
              }

              if (event.shiftKey) {
                event.preventDefault();
                selectJobRange(job.id);
                return;
              }

              if (isAdditiveSelectionInput(event)) {
                event.preventDefault();
                toggleJobSelection(job.id);
                return;
              }

              selectSingleJob(job.id);
              onSelectPart(job.id);
            }}
            onContextMenu={() => {
              prepareContextSelection(job.id);
            }}
            onPointerEnter={() => {
              schedulePrefetch(`part:${job.id}`, () => onPrefetchPart?.(job.id));
            }}
            onFocus={() => {
              schedulePrefetch(`part:${job.id}`, () => onPrefetchPart?.(job.id));
            }}
            onPointerDown={() => {
              onPrefetchPart?.(job.id);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") {
                return;
              }

              event.preventDefault();
              selectSingleJob(job.id);
              onSelectPart(job.id);
            }}
            className={cn(
                "group flex w-full items-center gap-2.5 rounded-[10px] text-left transition-colors",
                SIDEBAR_ROW_PADDING_CLASS,
                isSelected || activeJobId === job.id
                  ? "bg-white/[0.08] text-white"
                  : "text-white/[0.8] hover:bg-white/[0.06] hover:text-white",
              )}
            >
            <Shapes className="h-4 w-4 shrink-0 text-white/[0.9]" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm leading-5">{presentation.title}</p>
              {selectedQuote ? (
                <p className="truncate text-[11px] leading-4 text-emerald-300/90">{selectedQuote}</p>
              ) : null}
              {!nestedInProject && parentProjectNames.length > 0 ? (
                <p className="truncate text-[12px] leading-4 text-white/[0.38]">{parentProjectNames.join(" · ")}</p>
              ) : null}
            </div>
            {isPinned ? (
              <div className="flex items-center gap-2">
                <Pin className="h-3.5 w-3.5 fill-current text-white/[0.72]" />
              </div>
            ) : null}
          </div>
        </ContextMenuTrigger>
        <PartContextMenuActions
          showBatchAction={showBatchAction}
          isCreateProjectDisabled={!onCreateProjectFromSelection || isCreatingProjectFromSelection}
          onCreateProjectFromSelection={() => {
            void createProjectFromSelection(contextSelection);
          }}
          onEditPart={() => onSelectPart(job.id)}
          onRenamePart={
            onRenamePart
              ? () => {
                  setPartToRename({
                    jobId: job.id,
                    currentName: summary?.partNumber ?? presentation.partNumber ?? presentation.title,
                  });
                  setRenameValue(summary?.partNumber ?? presentation.partNumber ?? presentation.title);
                }
              : undefined
          }
          addableProjects={addableProjects.map((project) => ({ id: project.id, name: project.name }))}
          removableProjects={removableProjectIds.map((projectId) => ({
            id: projectId,
            name: projectsById.get(projectId)?.name ?? "Project",
          }))}
          singleRemoveLabel={contextProjectId ? "Remove from this project" : "Remove from project"}
          isMoveBusy={isMoveBusy}
          onAddToProject={
            onAssignPartToProject
              ? (projectId) => {
                  void withBusyPartMove(job.id, async () => {
                    await onAssignPartToProject(job.id, projectId);
                  });
                }
              : undefined
          }
          onRemoveFromProject={
            onRemovePartFromProject
              ? (projectId) => {
                  void withBusyPartMove(job.id, async () => {
                    await onRemovePartFromProject(job.id, projectId);
                  });
                }
              : undefined
          }
          onArchivePart={
            onArchivePart
              ? () => {
                  void withBusyPartArchive(job.id, async () => {
                    await onArchivePart(job.id);
                  });
                }
              : undefined
          }
          isArchiveBusy={isArchiveBusy}
          pinLabel={isPinned ? "Unpin" : "Pin"}
          onTogglePin={() => {
            void togglePartPin(job.id);
          }}
          isPinBusy={isPinBusy}
        />
      </ContextMenu>
    );
  };

  const renderProjectRow = (project: WorkspaceSidebarProject, projectJobs: JobRecord[]) => {
    const isPinned = pinnedProjectSet.has(project.id);
    const isPinBusy = pendingProjectPinIds.includes(project.id);
    const expanded = isProjectExpanded(project.id);

    return (
      <div key={project.id} className="space-y-1">
        <ContextMenu
          onOpenChange={(open) => {
            setOpenContextTarget((current) => {
              if (open) {
                return `project:${project.id}`;
              }

              return current === `project:${project.id}` ? null : current;
            });
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
              onPointerEnter={() => {
                schedulePrefetch(`project:${project.id}`, () => onPrefetchProject?.(project.id));
              }}
              onFocus={() => {
                schedulePrefetch(`project:${project.id}`, () => onPrefetchProject?.(project.id));
              }}
              onPointerDown={() => {
                onPrefetchProject?.(project.id);
              }}
              className={cn(
                "group flex w-full items-center gap-2.5 rounded-[10px] text-left transition-colors",
                SIDEBAR_ROW_PADDING_CLASS,
                activeProjectId === project.id
                  ? "bg-white/[0.08] text-white"
                  : "text-white/[0.8] hover:bg-white/[0.06] hover:text-white",
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
                  className="rounded-[8px] p-0.5 text-white/[0.72] transition-colors hover:bg-white/[0.08] hover:text-white"
                >
                  <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded ? "rotate-90" : "")} />
                </button>
              ) : (
                <span className="h-4 w-4 shrink-0" />
              )}
              <Folder className="h-4 w-4 shrink-0 text-white/[0.9]" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm leading-5">{project.name}</p>
              </div>
              {isPinned ? (
                <div className="flex items-center gap-2">
                  <Pin className="h-3.5 w-3.5 fill-current text-white/[0.72]" />
                </div>
              ) : null}
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
            {onArchiveProject ? (
              <ContextMenuItem
                onSelect={() => {
                  setProjectToArchive(project);
                }}
              >
                Archive Project
              </ContextMenuItem>
            ) : null}
            {(project.canDelete ?? project.canManage) && onDissolveProject ? (
              <ContextMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => {
                  setProjectToDissolve(project);
                }}
              >
                Dissolve project
              </ContextMenuItem>
            ) : null}
          </ContextMenuContent>
        </ContextMenu>

        {expanded ? (
          <div className="ml-[14px] space-y-1 border-l border-white/[0.08] pl-3">
            {projectJobs.map((job) => renderPartRow(job, { contextProjectId: project.id, nestedInProject: true }))}
          </div>
        ) : null}
      </div>
    );
  };

  const noProjectsMessage = filters.show === "relevant" ? "No pinned projects yet." : "No projects yet.";
  const noPartsMessage = filters.show === "relevant" ? "No pinned parts yet." : "No parts yet.";
  const canCreateProject = Boolean(onCreateProject);

  const projectSectionAction = (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label="New project"
        disabled={!canCreateProject}
        className="h-8 w-8 rounded-[10px] text-white/[0.92] hover:bg-white/[0.06] hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        onClick={() => {
          onCreateProject?.();
        }}
      >
        <FolderPlus className="h-4 w-4" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Sort and filter sidebar"
            className="h-8 w-8 rounded-[10px] text-white/[0.92] hover:bg-white/[0.06] hover:text-white"
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
  );

  return (
    <>
      <div className="space-y-5">
        {onCreateJob || onSearch ? (
          <div className={cn("space-y-2", SIDEBAR_COLUMN_INSET_CLASS)}>
            {onCreateJob ? (
              <Button
                type="button"
                variant="ghost"
                className={cn(
                  "h-10 w-full justify-start rounded-[10px] bg-transparent text-white/[0.94] hover:bg-white/[0.06] hover:text-white",
                  SIDEBAR_ACTION_BUTTON_PADDING_CLASS,
                )}
                onClick={onCreateJob}
              >
                <span className="flex w-5 shrink-0 items-center justify-center text-white/[0.96]">
                  <PlusSquare aria-hidden="true" className="h-4 w-4" />
                </span>
                <span className="truncate">New Job</span>
              </Button>
            ) : null}

            {onSearch ? (
              <Button
                type="button"
                variant="ghost"
                className={cn(
                  "h-10 w-full justify-start rounded-[10px] bg-transparent text-white/[0.94] hover:bg-white/[0.06] hover:text-white",
                  SIDEBAR_ACTION_BUTTON_PADDING_CLASS,
                )}
                onClick={onSearch}
              >
                <span className="flex w-5 shrink-0 items-center justify-center text-white/[0.96]">
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
            action={projectSectionAction}
          />
          {expandedSections.projects ? (
            <div className="space-y-1">
              {visibleProjects.length > 0 ? (
                visibleProjects.map((project) => renderProjectRow(project, jobsByProjectId.get(project.id) ?? []))
              ) : (
                <div className="px-2 py-2 text-sm text-white/[0.42]">{noProjectsMessage}</div>
              )}
            </div>
          ) : null}
        </div>

        <div className="space-y-2">
          <SidebarSectionHeading label="Parts" expanded={expandedSections.parts} onToggle={() => toggleSectionExpanded("parts")} />
          {expandedSections.parts ? (
            <div className="space-y-1">
              {visibleParts.length > 0 ? (
                visibleParts.map((job) => renderPartRow(job))
              ) : (
                <div className="px-2 py-2 text-sm text-white/[0.42]">{noPartsMessage}</div>
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

      <ProjectNameDialog
        open={Boolean(partToRename)}
        onOpenChange={(open) => {
          if (!open) {
            setPartToRename(null);
            setRenameValue("");
          }
        }}
        title="Rename part"
        description="Update the part name shown throughout your workspace."
        value={renameValue}
        onValueChange={setRenameValue}
        submitLabel="Save"
        placeholder="Part name"
        isPending={isRenamingPart}
        isSubmitDisabled={
          !partToRename ||
          !onRenamePart ||
          renameValue.trim().length === 0 ||
          renameValue.trim() === partToRename.currentName
        }
        onSubmit={async () => {
          if (!partToRename || !onRenamePart) {
            return;
          }

          setIsRenamingPart(true);

          try {
            await onRenamePart(partToRename.jobId, renameValue.trim());
            setPartToRename(null);
            setRenameValue("");
          } catch {
            // Parent handlers report errors.
          } finally {
            setIsRenamingPart(false);
          }
        }}
      />

      <Dialog
        open={Boolean(projectToArchive)}
        onOpenChange={(open) => {
          if (!open) {
            setProjectToArchive(null);
          }
        }}
      >
        <DialogContent className="chatgpt-shell rounded-2xl border-white/[0.08] bg-[#2a2a2a] text-white">
          <DialogHeader>
            <DialogTitle>Archive project</DialogTitle>
            <DialogDescription className="text-white/55">
              {projectToArchive
                ? projectToArchive.id.startsWith("seed-")
                  ? `Archive all parts in ${projectToArchive.name}. This batch group will disappear once its parts are archived.`
                  : `Archive ${projectToArchive.name}. Parts only in this project will also be archived.`
                : "Archive this project."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="rounded-[10px] border-white/[0.08] bg-transparent text-white hover:bg-white/[0.06]"
              onClick={() => setProjectToArchive(null)}
            >
              Cancel
            </Button>
            <Button
              disabled={!projectToArchive || !onArchiveProject || isArchivingProject}
              onClick={async () => {
                if (!projectToArchive || !onArchiveProject) {
                  return;
                }

                setIsArchivingProject(true);

                try {
                  await onArchiveProject(projectToArchive.id);
                  setProjectToArchive(null);
                } catch {
                  // Parent handlers report errors.
                } finally {
                  setIsArchivingProject(false);
                }
              }}
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(projectToDissolve)}
        onOpenChange={(open) => {
          if (!open) {
            setProjectToDissolve(null);
          }
        }}
      >
        <DialogContent className="chatgpt-shell rounded-2xl border-white/[0.08] bg-[#2a2a2a] text-white">
          <DialogHeader>
            <DialogTitle>Dissolve project</DialogTitle>
            <DialogDescription className="text-white/55">
              {projectToDissolve
                ? `Dissolve ${projectToDissolve.name}. The project will be deleted and its parts will remain in Parts.`
                : "Dissolve this project."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="rounded-[10px] border-white/[0.08] bg-transparent text-white hover:bg-white/[0.06]"
              onClick={() => setProjectToDissolve(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!projectToDissolve || !onDissolveProject || isDissolvingProject}
              onClick={async () => {
                if (!projectToDissolve || !onDissolveProject) {
                  return;
                }

                setIsDissolvingProject(true);

                try {
                  await onDissolveProject(projectToDissolve.id);
                  setProjectToDissolve(null);
                } catch {
                  // Parent handlers report errors.
                } finally {
                  setIsDissolvingProject(false);
                }
              }}
            >
              Dissolve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
