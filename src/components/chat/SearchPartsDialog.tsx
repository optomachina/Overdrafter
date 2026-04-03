import { useMemo, useState } from "react";
import { FolderKanban, Shapes } from "lucide-react";
import type { JobPartSummary, JobRecord } from "@/features/quotes/types";
import { getClientItemPresentation } from "@/features/quotes/client-presentation";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

type SearchPartsProject = {
  id: string;
  name: string;
  partCount: number;
};

type SearchPartsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: SearchPartsProject[];
  jobs: JobRecord[];
  summariesByJobId: Map<string, JobPartSummary>;
  onSelectProject: (projectId: string) => void;
  onSelectPart: (jobId: string) => void;
};

export function SearchPartsDialog({
  open,
  onOpenChange,
  projects,
  jobs,
  summariesByJobId,
  onSelectProject,
  onSelectPart,
}: SearchPartsDialogProps) {
  const [query, setQuery] = useState("");

  const normalizedQuery = query.trim().toLowerCase();
  const filteredProjects = useMemo(
    () =>
      projects.filter((project) => project.name.toLowerCase().includes(normalizedQuery)),
    [normalizedQuery, projects],
  );
  const filteredJobs = useMemo(
    () =>
      jobs.filter((job) => {
        const presentation = getClientItemPresentation(job, summariesByJobId.get(job.id));
        return [presentation.title, presentation.description, job.tags.join(" ")]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);
      }),
    [jobs, normalizedQuery, summariesByJobId],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput
        placeholder="Search parts and projects"
        value={query}
        onValueChange={setQuery}
        className="border-white/8 bg-ws-overlay text-white placeholder:text-white/40"
      />
      <CommandList className="max-h-[420px] bg-ws-overlay text-white">
        <CommandEmpty>No matching projects or parts.</CommandEmpty>

        <CommandGroup heading="Projects">
          {filteredProjects.map((project) => (
            <CommandItem
              key={project.id}
              value={project.name}
              onSelect={() => {
                onOpenChange(false);
                onSelectProject(project.id);
              }}
              className="rounded-xl data-[selected=true]:bg-white/8 data-[selected=true]:text-white"
            >
              <FolderKanban className="mr-2 h-4 w-4 text-white/60" />
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="truncate">{project.name}</span>
                <span className="text-xs text-white/45">{project.partCount}</span>
              </div>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading="Parts">
          {filteredJobs.map((job) => {
            const presentation = getClientItemPresentation(job, summariesByJobId.get(job.id));

            return (
              <CommandItem
                key={job.id}
                value={`${presentation.title} ${presentation.description}`}
                onSelect={() => {
                  onOpenChange(false);
                  onSelectPart(job.id);
                }}
                className="rounded-xl data-[selected=true]:bg-white/8 data-[selected=true]:text-white"
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
      </CommandList>
    </CommandDialog>
  );
}
