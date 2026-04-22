import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderKanban, Shapes, X } from "lucide-react";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";
import { cn } from "@/lib/utils";

type WorkspaceInlineSearchProject = {
  id: string;
  name: string;
  partCount: number;
};

type WorkspaceInlineSearchProps = {
  projects: WorkspaceInlineSearchProject[];
  jobs: JobRecord[];
  summariesByJobId: Map<string, JobPartSummary>;
  jobSearchTextById?: Map<string, string>;
  scopedProject?: WorkspaceInlineSearchProject | null;
  resolveProjectIdsForJob?: (job: Pick<JobRecord, "id" | "project_id" | "source">) => string[];
  onSelectProject: (projectId: string) => void;
  onSelectPart: (jobId: string) => void;
  placeholder?: string;
  className?: string;
};

const RESULT_LIMIT = 6;

function isEditableTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  const tagName = target.tagName;
  return (
    target.isContentEditable ||
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT"
  );
}

export function WorkspaceInlineSearch({
  projects,
  jobs,
  summariesByJobId,
  jobSearchTextById,
  scopedProject = null,
  resolveProjectIdsForJob,
  onSelectProject,
  onSelectPart,
  placeholder = "/ Search",
  className,
}: WorkspaceInlineSearchProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [scopedProjectId, setScopedProjectId] = useState<string | null>(scopedProject?.id ?? null);

  useEffect(() => {
    setScopedProjectId(scopedProject?.id ?? null);
  }, [scopedProject?.id]);

  const normalizedQuery = query.trim().toLowerCase();
  const activeScopedProject = scopedProject && scopedProject.id === scopedProjectId ? scopedProject : null;
  const hasScopeChip = Boolean(activeScopedProject);
  const getProjectIdsForJob = useCallback(
    (job: JobRecord) => {
      if (resolveProjectIdsForJob) {
        return resolveProjectIdsForJob(job);
      }

      return job.project_id ? [job.project_id] : [];
    },
    [resolveProjectIdsForJob],
  );
  const filteredProjects = useMemo(
    () =>
      projects
        .filter((project) => !activeScopedProject || project.id === activeScopedProject.id)
        .filter((project) => project.name.toLowerCase().includes(normalizedQuery))
        .slice(0, RESULT_LIMIT),
    [activeScopedProject, normalizedQuery, projects],
  );
  const filteredJobs = useMemo(
    () =>
      jobs
        .filter((job) => {
          if (scopedProjectId && !getProjectIdsForJob(job).includes(scopedProjectId)) {
            return false;
          }

          const presentation = getClientItemPresentation(job, summariesByJobId.get(job.id));
          return [
            presentation.title,
            presentation.originalTitle ?? "",
            presentation.description,
            job.tags.join(" "),
            jobSearchTextById?.get(job.id) ?? "",
          ]
            .join(" ")
            .toLowerCase()
            .includes(normalizedQuery);
        })
        .slice(0, RESULT_LIMIT),
    [getProjectIdsForJob, jobSearchTextById, jobs, normalizedQuery, scopedProjectId, summariesByJobId],
  );
  const hasQuery = normalizedQuery.length > 0;
  const hasResults = filteredProjects.length > 0 || filteredJobs.length > 0;

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "/" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      event.preventDefault();
      inputRef.current?.focus();

      if (query.trim()) {
        setIsOpen(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [query]);

  const close = () => setIsOpen(false);

  return (
    <div ref={rootRef} className={cn("relative w-full min-w-0", className)}>
      <Command
        shouldFilter={false}
        className="overflow-visible bg-transparent text-white [&_[cmdk-input-wrapper]_svg]:hidden"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
            inputRef.current?.blur();
          }
        }}
      >
        <TooltipProvider delayDuration={150}>
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <CommandInput
                  ref={inputRef}
                  value={query}
                  onValueChange={(value) => {
                    setQuery(value);
                    setIsOpen(value.trim().length > 0);
                  }}
                  onFocus={() => {
                    if (query.trim()) {
                      setIsOpen(true);
                    }
                  }}
                  placeholder={placeholder}
                  aria-label={placeholder}
                  className={cn(
                    "h-10 rounded-full border border-white/10 bg-white/[0.04] pr-4 text-sm text-white placeholder:text-white/35 focus-visible:ring-0",
                    hasScopeChip ? "pl-[8.85rem]" : "pl-4",
                  )}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent side="top">Press / to search</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {hasScopeChip ? (
          <div className="pointer-events-none absolute inset-y-0 left-[1.22rem] z-10 flex items-center">
            <span className="pointer-events-auto relative -top-px inline-flex max-w-[8rem] items-center gap-1 rounded-full border border-white/12 bg-white/10 px-2 py-1 text-xs font-medium text-white/88">
              <span className="truncate">{activeScopedProject.name}</span>
              <button
                type="button"
                aria-label={`Clear ${activeScopedProject.name} search scope`}
                className="inline-flex h-4 w-4 items-center justify-center rounded-full text-white/55 transition hover:bg-white/12 hover:text-white"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setScopedProjectId(null);
                  inputRef.current?.focus();
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          </div>
        ) : null}
        {isOpen && hasQuery ? (
          <div className="absolute right-0 top-[calc(100%+0.5rem)] z-30 w-full overflow-hidden rounded-xl border border-white/10 bg-ws-shell shadow-[0_16px_40px_rgba(0,0,0,0.45)]">
            <CommandList className="max-h-[360px] bg-transparent p-2 text-white">
              {!hasResults ? <CommandEmpty>No matching projects or parts.</CommandEmpty> : null}

              {filteredProjects.length > 0 ? (
                <CommandGroup heading="Projects" className="text-white/70">
                  {filteredProjects.map((project) => (
                    <CommandItem
                      key={project.id}
                      value={project.name}
                      onSelect={() => {
                        close();
                        onSelectProject(project.id);
                      }}
                      className="rounded-lg px-3 py-2.5 data-[selected=true]:bg-white/8 data-[selected=true]:text-white"
                    >
                      <FolderKanban className="mr-2 h-4 w-4 text-white/60" />
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <span className="truncate">{project.name}</span>
                        <span className="text-xs text-white/45">{project.partCount}</span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}

              {filteredJobs.length > 0 ? (
                <CommandGroup heading="Parts" className="text-white/70">
                  {filteredJobs.map((job) => {
                    const presentation = getClientItemPresentation(job, summariesByJobId.get(job.id));

                    return (
                      <CommandItem
                        key={job.id}
                        value={`${presentation.title} ${presentation.originalTitle ?? ""} ${presentation.description}`}
                        onSelect={() => {
                          close();
                          onSelectPart(job.id);
                        }}
                        className="rounded-lg px-3 py-2.5 data-[selected=true]:bg-white/8 data-[selected=true]:text-white"
                      >
                        <Shapes className="mr-2 h-4 w-4 text-white/60" />
                        <div className="min-w-0">
                          <p className="truncate">{presentation.title}</p>
                          <p className="truncate text-xs text-white/45">{presentation.description}</p>
                        </div>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              ) : null}
            </CommandList>
          </div>
        ) : null}
      </Command>
    </div>
  );
}
