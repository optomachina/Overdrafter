import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import {
  ArrowRight,
  CheckSquare,
  ChevronDown,
  Clock3,
  Filter,
  FolderKanban,
  FolderPlus,
  Layers3,
  Loader2,
  PencilLine,
  Search,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { GuestAppShell } from "@/components/auth/GuestAppShell";
import { toast } from "sonner";
import { AppShell } from "@/components/app/AppShell";
import { EmailVerificationPrompt } from "@/components/EmailVerificationPrompt";
import { SignInDialog } from "@/components/SignInDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAppSession } from "@/hooks/use-app-session";
import { cn } from "@/lib/utils";
import { isEmailConfirmationRequired } from "@/lib/auth-status";
import { supabase } from "@/integrations/supabase/client";
import type { AppRole, ClientOptionKind } from "@/integrations/supabase/types";
import type {
  JobPartSummary,
  JobRecord,
  PublishedQuotePackageRecord,
} from "@/features/quotes/types";
import {
  createSelfServiceOrganization,
  fetchJobPartSummariesByOrganization,
  fetchJobsByOrganization,
  fetchOrganizationMemberships,
  fetchPublishedPackagesByOrganization,
  resendSignupConfirmation,
  updateOrganizationMembershipRole,
} from "@/features/quotes/api";
import {
  formatStatusLabel,
  getJobSummaryMetrics,
  optionLabelForKind,
} from "@/features/quotes/utils";

const membershipRoleOptions: AppRole[] = ["client", "internal_estimator", "internal_admin"];
const seededProjectNames = ["QB00001", "QB00002", "QB00003"];
const projectStoragePrefix = "overdrafter-job-projects-v2";
const dmriflesEmail = "dmrifles@gmail.com";
const dmriflesProjectAssignments: Record<string, string> = {
  "1093-05589": "QB00001",
  "1093-03242": "QB00001",
  "1093-03247": "QB00001",
  "1093-03258": "QB00001",
  "1093-03266": "QB00001",
  "1093-03292": "QB00001",
  "1093-03548": "QB00001",
  "1093-05974": "QB00001",
  "1093-06156": "QB00001",
  "1093-10569": "QB00002",
  "1093-10570": "QB00002",
  "1093-05907": "QB00003",
  "1093-10435": "QB00003",
};

type JobFilter = "all" | "needs_attention" | "quoting" | "published";

type JobProject = {
  id: string;
  name: string;
  jobIds: string[];
  createdAt: string;
};

type ProjectSection = JobProject & {
  jobs: JobRecord[];
  visibleJobs: JobRecord[];
  isVirtual?: boolean;
};

const clientFilterOptions: { id: JobFilter; label: string }[] = [
  { id: "all", label: "All jobs" },
  { id: "needs_attention", label: "Needs attention" },
  { id: "quoting", label: "Quoting" },
  { id: "published", label: "Published" },
];
const EMPTY_JOB_LIST: JobRecord[] = [];
const EMPTY_PUBLISHED_PACKAGES: PublishedQuotePackageRecord[] = [];

function createProjectStorageKey(organizationId?: string, userEmail?: string): string | null {
  if (!organizationId || !userEmail) {
    return null;
  }

  return `${projectStoragePrefix}:${organizationId}:${userEmail.toLowerCase()}`;
}

function matchesJobFilter(job: JobRecord, filter: JobFilter): boolean {
  switch (filter) {
    case "needs_attention":
      return job.status === "needs_spec_review" || job.status === "internal_review";
    case "quoting":
      return job.status === "quoting";
    case "published":
      return job.status === "published";
    case "all":
    default:
      return true;
  }
}

function matchesJobSearch(job: JobRecord, searchTerm: string): boolean {
  const normalizedSearch = searchTerm.trim().toLowerCase();

  if (!normalizedSearch) {
    return true;
  }

  return [job.title, job.description ?? "", job.tags.join(" ")]
    .join(" ")
    .toLowerCase()
    .includes(normalizedSearch);
}

function sanitizeProjectList(projects: JobProject[], jobs: JobRecord[]): JobProject[] {
  const validJobIds = new Set(jobs.map((job) => job.id));
  const assignedJobIds = new Set<string>();

  return projects
    .map((project) => ({
      ...project,
      name: project.name.trim(),
      jobIds: project.jobIds.filter((jobId) => {
        if (!validJobIds.has(jobId) || assignedJobIds.has(jobId)) {
          return false;
        }

        assignedJobIds.add(jobId);
        return true;
      }),
    }))
    .filter((project) => project.name.length > 0);
}

function parsePartReferenceFromTitle(title: string): Pick<JobPartSummary, "partNumber" | "revision"> | null {
  const match = title.trim().match(/^(\d{4}-\d{5})(?:\s+rev(?:ision)?\s+([A-Za-z0-9]+))?/i);

  if (!match) {
    return null;
  }

  return {
    partNumber: match[1] ?? null,
    revision: match[2] ?? null,
  };
}

function formatPartLabel(partNumber: string | null, revision: string | null, fallbackTitle: string): string {
  if (!partNumber) {
    return fallbackTitle;
  }

  return `${partNumber}${revision ? ` rev ${revision}` : ""}`;
}

function getClientItemPresentation(
  job: JobRecord,
  partSummary?: JobPartSummary | null,
): {
  title: string;
  description: string;
  quantity: number | null;
  originalTitle: string | null;
  partNumber: string | null;
} {
  const titleReference = parsePartReferenceFromTitle(job.title);
  const partNumber = partSummary?.partNumber ?? titleReference?.partNumber ?? null;
  const revision = partSummary?.revision ?? titleReference?.revision ?? null;
  const title = formatPartLabel(partNumber, revision, job.title);
  const description = partSummary?.description ?? job.description ?? "No description provided.";

  return {
    title,
    description,
    quantity: partSummary?.quantity ?? null,
    originalTitle: title === job.title ? null : job.title,
    partNumber,
  };
}

function getDmriflesProjectName(job: JobRecord, partSummary?: JobPartSummary | null): string {
  const titleReference = parsePartReferenceFromTitle(job.title);
  const partNumber = partSummary?.partNumber ?? titleReference?.partNumber ?? null;

  if (partNumber && dmriflesProjectAssignments[partNumber]) {
    return dmriflesProjectAssignments[partNumber];
  }

  const searchText = [partSummary?.description, job.description, job.title]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (searchText.includes("pc6010")) {
    return "QB00002";
  }

  if (searchText.includes("tip-tilt") || searchText.includes("accufiz")) {
    return "QB00003";
  }

  return "QB00001";
}

function buildDmriflesProjects(
  jobs: JobRecord[],
  partSummariesByJobId: Map<string, JobPartSummary>,
): JobProject[] {
  const timestamp = new Date().toISOString();
  const seedProjects = new Map(
    seededProjectNames.map((name) => [
      name,
      {
        id: `seed-${name.toLowerCase()}`,
        name,
        jobIds: [] as string[],
        createdAt: timestamp,
      },
    ]),
  );

  const sortedJobs = [...jobs].sort((left, right) => {
    const leftTitle = getClientItemPresentation(left, partSummariesByJobId.get(left.id)).title;
    const rightTitle = getClientItemPresentation(right, partSummariesByJobId.get(right.id)).title;

    if (leftTitle !== rightTitle) {
      return leftTitle.localeCompare(rightTitle);
    }

    return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
  });

  sortedJobs.forEach((job) => {
    const projectName = getDmriflesProjectName(job, partSummariesByJobId.get(job.id));
    seedProjects.get(projectName)?.jobIds.push(job.id);
  });

  return seededProjectNames
    .map((name) => seedProjects.get(name))
    .filter((project): project is JobProject => Boolean(project));
}

function matchesDefaultDmriflesSeed(projects: JobProject[]): boolean {
  if (projects.length !== seededProjectNames.length) {
    return false;
  }

  return seededProjectNames.every((name) =>
    projects.some((project) => project.id === `seed-${name.toLowerCase()}` && project.name === name),
  );
}

function loadPersistedProjects(
  projectStorageKey: string,
  jobs: JobRecord[],
  userEmail: string,
  partSummariesByJobId: Map<string, JobPartSummary>,
): JobProject[] {
  const systemDmriflesProjects =
    userEmail.toLowerCase() === dmriflesEmail
      ? sanitizeProjectList(buildDmriflesProjects(jobs, partSummariesByJobId), jobs)
      : [];

  if (typeof window !== "undefined") {
    const rawProjects = window.localStorage.getItem(projectStorageKey);

    if (rawProjects) {
      try {
        const parsedProjects = JSON.parse(rawProjects) as JobProject[];
        if (Array.isArray(parsedProjects)) {
          const sanitizedProjects = sanitizeProjectList(parsedProjects, jobs);

          if (userEmail.toLowerCase() === dmriflesEmail) {
            return matchesDefaultDmriflesSeed(sanitizedProjects)
              ? systemDmriflesProjects
              : sanitizedProjects;
          }

          return sanitizedProjects;
        }
      } catch {
        window.localStorage.removeItem(projectStorageKey);
      }
    }
  }

  if (userEmail.toLowerCase() === dmriflesEmail) {
    return systemDmriflesProjects;
  }

  return [];
}

function getSuggestedProjectName(projects: JobProject[]): string {
  const existingNames = new Set(projects.map((project) => project.name.toLowerCase()));
  let nextNumber = 1;

  while (existingNames.has(`qb${String(nextNumber).padStart(5, "0")}`)) {
    nextNumber += 1;
  }

  return `QB${String(nextNumber).padStart(5, "0")}`;
}

function normalizeAccountNameSeed(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toTitleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function getDefaultAccountName(user: User | null): string {
  if (!user) {
    return "Personal account";
  }

  const metadataName = [
    user.user_metadata?.full_name,
    user.user_metadata?.name,
    user.user_metadata?.company,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0);

  if (metadataName) {
    return metadataName.trim();
  }

  const emailLocalPart = normalizeAccountNameSeed(user.email?.split("@")[0] ?? "");
  return emailLocalPart ? toTitleCase(emailLocalPart) : "Personal account";
}

const Index = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const { user, activeMembership, isLoading, isVerifiedAuth, signOut } = useAppSession();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(false);
  const [isRefreshingVerification, setIsRefreshingVerification] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [projectGroups, setProjectGroups] = useState<JobProject[]>([]);
  const [loadedProjectKey, setLoadedProjectKey] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<JobFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [isProjectsSectionCollapsed, setIsProjectsSectionCollapsed] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false);
  const [projectDialogMode, setProjectDialogMode] = useState<"create" | "rename">("create");
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState("");
  const [isDeleteProjectOpen, setIsDeleteProjectOpen] = useState(false);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);
  const authIntent = searchParams.get("auth");
  const hasAuthIntent = authIntent === "signin" || authIntent === "signup";
  const authDialogMode = authIntent === "signup" ? "sign-up" : "sign-in";

  const normalizedEmail = user?.email?.toLowerCase() ?? "";
  const defaultAccountName = useMemo(() => getDefaultAccountName(user), [user]);
  const isDmriflesWorkspace = normalizedEmail === dmriflesEmail;
  const projectStorageKey = useMemo(
    () => createProjectStorageKey(activeMembership?.organizationId, normalizedEmail),
    [activeMembership?.organizationId, normalizedEmail],
  );

  const jobsQuery = useQuery({
    queryKey: ["jobs", activeMembership?.organizationId],
    queryFn: () => fetchJobsByOrganization(activeMembership!.organizationId),
    enabled: Boolean(activeMembership?.organizationId),
  });

  const packagesQuery = useQuery({
    queryKey: ["packages", activeMembership?.organizationId],
    queryFn: () => fetchPublishedPackagesByOrganization(activeMembership!.organizationId),
    enabled: Boolean(activeMembership?.organizationId),
  });

  const partSummariesQuery = useQuery({
    queryKey: ["job-part-summaries", activeMembership?.organizationId],
    queryFn: () => fetchJobPartSummariesByOrganization(activeMembership!.organizationId),
    enabled: activeMembership?.role === "client",
  });

  const organizationMembershipsQuery = useQuery({
    queryKey: ["organization-memberships", activeMembership?.organizationId],
    queryFn: () => fetchOrganizationMemberships(activeMembership!.organizationId),
    enabled: activeMembership?.role === "internal_admin",
  });

  const jobs = jobsQuery.data ?? EMPTY_JOB_LIST;
  const publishedPackages = packagesQuery.data ?? EMPTY_PUBLISHED_PACKAGES;
  const partSummaryByJobId = useMemo(
    () => new Map((partSummariesQuery.data ?? []).map((summary) => [summary.jobId, summary])),
    [partSummariesQuery.data],
  );
  const metrics = useMemo(() => getJobSummaryMetrics(jobs), [jobs]);
  const clientItemLabel = isDmriflesWorkspace ? "parts" : "jobs";
  const clientItemLabelSingular = isDmriflesWorkspace ? "part" : "job";

  const updateAuthIntent = (nextIntent: "signin" | "signup" | null) => {
    const nextSearchParams = new URLSearchParams(searchParams);

    if (nextIntent) {
      nextSearchParams.set("auth", nextIntent);
    } else {
      nextSearchParams.delete("auth");
    }

    setSearchParams(nextSearchParams, { replace: true });
  };

  const openAuthDialog = (mode: "signin" | "signup") => {
    setIsAuthDialogOpen(true);
    updateAuthIntent(mode);
  };

  const handleAuthDialogOpenChange = (open: boolean) => {
    setIsAuthDialogOpen(open);

    if (!open && hasAuthIntent) {
      updateAuthIntent(null);
    }
  };

  useEffect(() => {
    if (!projectStorageKey) {
      setProjectGroups([]);
      setLoadedProjectKey(null);
      return;
    }

    if (jobsQuery.isLoading || (isDmriflesWorkspace && partSummariesQuery.isLoading)) {
      return;
    }

    const nextProjects = loadPersistedProjects(
      projectStorageKey,
      jobs,
      normalizedEmail,
      partSummaryByJobId,
    );
    setProjectGroups(nextProjects);
    setLoadedProjectKey(projectStorageKey);
  }, [
    isDmriflesWorkspace,
    jobs,
    jobsQuery.isLoading,
    normalizedEmail,
    partSummariesQuery.isLoading,
    partSummaryByJobId,
    projectStorageKey,
  ]);

  useEffect(() => {
    if (!user && hasAuthIntent) {
      setIsAuthDialogOpen(true);
      return;
    }

    if (user) {
      if (isAuthDialogOpen) {
        setIsAuthDialogOpen(false);
      }

      if (hasAuthIntent) {
        const nextSearchParams = new URLSearchParams(searchParams);
        nextSearchParams.delete("auth");
        setSearchParams(nextSearchParams, { replace: true });
      }
    }
  }, [hasAuthIntent, isAuthDialogOpen, searchParams, setSearchParams, user]);

  useEffect(() => {
    if (
      !projectStorageKey ||
      loadedProjectKey !== projectStorageKey ||
      typeof window === "undefined"
    ) {
      return;
    }

    window.localStorage.setItem(projectStorageKey, JSON.stringify(projectGroups));
  }, [loadedProjectKey, projectGroups, projectStorageKey]);

  useEffect(() => {
    if (!selectionMode) {
      setSelectedJobIds([]);
    }
  }, [selectionMode]);

  useEffect(() => {
    setSelectedJobIds((current) => current.filter((jobId) => jobs.some((job) => job.id === jobId)));
  }, [jobs]);

  const projectSections = useMemo(() => {
    const sanitizedProjects = sanitizeProjectList(projectGroups, jobs);
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const assignedJobIds = new Set<string>();

    const sections: ProjectSection[] = sanitizedProjects.map((project) => {
      const sectionJobs = project.jobIds
        .map((jobId) => jobsById.get(jobId))
        .filter((job): job is JobRecord => Boolean(job));

      sectionJobs.forEach((job) => {
        assignedJobIds.add(job.id);
      });

      return {
        ...project,
        jobs: sectionJobs,
        visibleJobs: sectionJobs.filter(
          (job) => matchesJobFilter(job, activeFilter) && matchesJobSearch(job, searchTerm),
        ),
      };
    });

    const unassignedJobs = jobs.filter((job) => !assignedJobIds.has(job.id));
    if (unassignedJobs.length > 0) {
      sections.push({
        id: "unassigned",
        name: "Ungrouped",
        jobIds: unassignedJobs.map((job) => job.id),
        createdAt: "",
        jobs: unassignedJobs,
        visibleJobs: unassignedJobs.filter(
          (job) => matchesJobFilter(job, activeFilter) && matchesJobSearch(job, searchTerm),
        ),
        isVirtual: true,
      });
    }

    return sections;
  }, [activeFilter, jobs, projectGroups, searchTerm]);

  useEffect(() => {
    if (activeMembership?.role !== "client") {
      return;
    }

    if (projectSections.length === 0) {
      setSelectedProjectId(null);
      return;
    }

    if (!selectedProjectId || !projectSections.some((section) => section.id === selectedProjectId)) {
      setSelectedProjectId(projectSections[0].id);
    }
  }, [activeMembership?.role, projectSections, selectedProjectId]);

  const selectedProject = useMemo(
    () => projectSections.find((section) => section.id === selectedProjectId) ?? null,
    [projectSections, selectedProjectId],
  );

  const selectedEditableProject = useMemo(
    () => projectGroups.find((project) => project.id === selectedProjectId) ?? null,
    [projectGroups, selectedProjectId],
  );

  const visibleJobs = useMemo(() => {
    if (selectedProject) {
      return selectedProject.visibleJobs;
    }

    return jobs.filter((job) => matchesJobFilter(job, activeFilter) && matchesJobSearch(job, searchTerm));
  }, [activeFilter, jobs, searchTerm, selectedProject]);

  useEffect(() => {
    if (activeMembership?.role !== "client") {
      return;
    }

    if (visibleJobs.length === 0) {
      setFocusedJobId(null);
      return;
    }

    if (!focusedJobId || !visibleJobs.some((job) => job.id === focusedJobId)) {
      setFocusedJobId(visibleJobs[0].id);
    }
  }, [activeMembership?.role, focusedJobId, visibleJobs]);

  const focusedJob = useMemo(
    () => visibleJobs.find((job) => job.id === focusedJobId) ?? null,
    [focusedJobId, visibleJobs],
  );

  const focusedJobPackages = useMemo(
    () => (focusedJob ? publishedPackages.filter((pkg) => pkg.job_id === focusedJob.id) : []),
    [focusedJob, publishedPackages],
  );

  const selectedProjectFilterCounts = useMemo(() => {
    const sourceJobs = selectedProject?.jobs ?? jobs;

    return clientFilterOptions.reduce<Record<JobFilter, number>>((counts, filterOption) => {
      counts[filterOption.id] = sourceJobs.filter(
        (job) => matchesJobFilter(job, filterOption.id) && matchesJobSearch(job, searchTerm),
      ).length;
      return counts;
    }, { all: 0, needs_attention: 0, quoting: 0, published: 0 });
  }, [jobs, searchTerm, selectedProject]);

  const realProjectCount = useMemo(
    () => projectSections.filter((section) => !section.isVirtual).length,
    [projectSections],
  );

  const projectNameSuggestion = useMemo(
    () => getSuggestedProjectName(projectGroups),
    [projectGroups],
  );

  const handleSelectProject = (section: ProjectSection) => {
    setSelectedProjectId(section.id);
    setFocusedJobId(section.visibleJobs[0]?.id ?? section.jobs[0]?.id ?? null);
  };

  const handleSignOut = async () => {
    setIsSigningOut(true);

    try {
      await signOut();
      navigate("/", { replace: true });
      toast.success("Signed out successfully.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to sign out.");
    } finally {
      setIsSigningOut(false);
    }
  };

  const bootstrapAccountMutation = useMutation({
    mutationFn: (organizationName: string) => createSelfServiceOrganization(organizationName),
    retry: false,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["app-session"] });
    },
    onError: async (error: Error) => {
      if (error.message.toLowerCase().includes("already has an organization membership")) {
        await queryClient.invalidateQueries({ queryKey: ["app-session"] });
      }
    },
  });

  const updateMembershipRoleMutation = useMutation({
    mutationFn: (input: { membershipId: string; role: AppRole }) =>
      updateOrganizationMembershipRole(input),
    onSuccess: async () => {
      toast.success("Access updated.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["organization-memberships"] }),
        queryClient.invalidateQueries({ queryKey: ["app-session"] }),
      ]);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update access.");
    },
  });

  const handleRefreshVerification = async () => {
    setIsRefreshingVerification(true);

    try {
      const { data, error } = await supabase.auth.getUser();

      if (error) {
        throw error;
      }

      if (!data.user) {
        throw new Error("Open the confirmation link from your email first.");
      }

      if (isEmailConfirmationRequired(data.user)) {
        throw new Error("Email confirmation has not completed yet.");
      }

      await queryClient.invalidateQueries({ queryKey: ["app-session"] });
      toast.success("Email verified.");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to refresh verification status.");
    } finally {
      setIsRefreshingVerification(false);
    }
  };

  const handleResendVerification = async () => {
    if (!user?.email) {
      toast.error("No email is available for this account.");
      return;
    }

    setIsResendingVerification(true);

    try {
      await resendSignupConfirmation(user.email);
      toast.success(`Confirmation email resent to ${user.email}.`);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Unable to resend confirmation email.");
    } finally {
      setIsResendingVerification(false);
    }
  };

  useEffect(() => {
    if (
      !user ||
      isLoading ||
      activeMembership ||
      !isVerifiedAuth ||
      bootstrapAccountMutation.status !== "idle"
    ) {
      return;
    }

    bootstrapAccountMutation.mutate(defaultAccountName);
  }, [
    activeMembership,
    bootstrapAccountMutation,
    defaultAccountName,
    isLoading,
    isVerifiedAuth,
    user,
  ]);

  const toggleJobSelection = (jobId: string) => {
    setSelectedJobIds((current) =>
      current.includes(jobId)
        ? current.filter((existingJobId) => existingJobId !== jobId)
        : [...current, jobId],
    );
  };

  const openCreateProjectDialog = () => {
    setProjectDialogMode("create");
    setEditingProjectId(null);
    setProjectName(projectNameSuggestion);
    setIsCreateProjectOpen(true);
  };

  const openRenameProjectDialog = (projectId: string) => {
    const project = projectGroups.find((candidate) => candidate.id === projectId);

    if (!project) {
      return;
    }

    setProjectDialogMode("rename");
    setEditingProjectId(project.id);
    setProjectName(project.name);
    setIsCreateProjectOpen(true);
  };

  const openDeleteProjectDialog = (projectId: string) => {
    setDeletingProjectId(projectId);
    setIsDeleteProjectOpen(true);
  };

  const handleSaveProject = () => {
    const trimmedProjectName = projectName.trim();

    if (!trimmedProjectName) {
      toast.error("Enter a project name.");
      return;
    }

    if (
      projectGroups.some(
        (project) =>
          project.name.toLowerCase() === trimmedProjectName.toLowerCase() &&
          project.id !== editingProjectId,
      )
    ) {
      toast.error("That project name already exists.");
      return;
    }

    if (projectDialogMode === "rename" && editingProjectId) {
      setProjectGroups((currentProjects) =>
        currentProjects.map((project) =>
          project.id === editingProjectId ? { ...project, name: trimmedProjectName } : project,
        ),
      );
      setIsCreateProjectOpen(false);
      setEditingProjectId(null);
      setProjectName("");
      toast.success(`Renamed project to ${trimmedProjectName}.`);
      return;
    }

    const nextProjectId = `project-${Date.now()}`;
    const movedJobIds = Array.from(new Set(selectedJobIds));

    setProjectGroups((currentProjects) => {
      const nextProjects = sanitizeProjectList(currentProjects, jobs).map((project) => ({
        ...project,
        jobIds: project.jobIds.filter((jobId) => !movedJobIds.includes(jobId)),
      }));

      return [
        ...nextProjects,
        {
          id: nextProjectId,
          name: trimmedProjectName,
          jobIds: movedJobIds,
          createdAt: new Date().toISOString(),
        },
      ];
    });

    setSelectedProjectId(nextProjectId);
    setFocusedJobId(movedJobIds[0] ?? null);
    setSelectedJobIds([]);
    setSelectionMode(false);
    setIsCreateProjectOpen(false);
    setProjectName("");
    toast.success(
      movedJobIds.length > 0
        ? `Created ${trimmedProjectName} and moved ${movedJobIds.length} jobs into it.`
        : `Created ${trimmedProjectName}.`,
    );
  };

  const handleDeleteProject = () => {
    if (!deletingProjectId) {
      return;
    }

    const project = projectGroups.find((candidate) => candidate.id === deletingProjectId);

    setProjectGroups((currentProjects) =>
      currentProjects.filter((candidate) => candidate.id !== deletingProjectId),
    );

    if (selectedProjectId === deletingProjectId) {
      setSelectedProjectId(null);
      setFocusedJobId(null);
    }

    setDeletingProjectId(null);
    setIsDeleteProjectOpen(false);
    toast.success(
      project ? `Deleted ${project.name}. Its ${clientItemLabel} moved to Ungrouped.` : "Project deleted.",
    );
  };

  if (!user && !isLoading) {
    return (
      <>
        <GuestAppShell
          authOpen={isAuthDialogOpen || hasAuthIntent}
          onOpenAuth={openAuthDialog}
        />

        <SignInDialog
          open={isAuthDialogOpen}
          onOpenChange={handleAuthDialogOpenChange}
          initialMode={authDialogMode}
        />
      </>
    );
  }

  if (!activeMembership) {
    const bootstrapErrorMessage =
      bootstrapAccountMutation.error instanceof Error
        ? bootstrapAccountMutation.error.message
        : "We couldn't finish preparing your account.";

    return (
      <AppShell
        title={isVerifiedAuth ? "Preparing your account" : "Verify your email"}
        subtitle={
          isVerifiedAuth
            ? "Your account context is created automatically. There’s nothing to name or configure."
            : "Finish email confirmation first. Setup continues automatically after verification."
        }
      >
        {!isVerifiedAuth && user?.email ? (
          <section className="mb-8">
            <EmailVerificationPrompt
              email={user.email}
              isRefreshing={isRefreshingVerification}
              isResending={isResendingVerification}
              onRefreshSession={() => {
                void handleRefreshVerification();
              }}
              onResend={() => {
                void handleResendVerification();
              }}
              onChangeEmail={handleSignOut}
            />
          </section>
        ) : null}

        <section className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
          <Card className="border-white/10 bg-black/20">
            <CardHeader>
              <Badge className="w-fit border border-primary/30 bg-primary/10 text-primary">
                Automatic setup
              </Badge>
              <CardTitle className="text-2xl">
                {bootstrapAccountMutation.isError ? "Setup needs attention" : "No account picker"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {bootstrapAccountMutation.isError ? (
                <>
                  <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                    {bootstrapErrorMessage}
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      className="rounded-full"
                      onClick={() => bootstrapAccountMutation.mutate(defaultAccountName)}
                      disabled={bootstrapAccountMutation.isPending}
                    >
                      Retry setup
                    </Button>
                    <Button
                      variant="outline"
                      className="border-white/10 bg-white/[0.04]"
                      onClick={handleSignOut}
                      disabled={isSigningOut}
                    >
                      Sign out
                    </Button>
                  </div>
                </>
              ) : (
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5">
                  <div className="flex items-center gap-3">
                    <div className="flex h-11 w-11 items-center justify-center rounded-full border border-primary/20 bg-primary/10">
                      <Loader2 className="h-5 w-5 animate-spin text-primary" />
                    </div>
                    <div>
                      <p className="font-medium text-white">
                        {isVerifiedAuth ? "Creating your account context" : "Waiting for verification"}
                      </p>
                      <p className="mt-1 text-sm text-white/55">
                        {isVerifiedAuth
                          ? `Using ${defaultAccountName} as the default account name behind the scenes.`
                          : "Once your email is confirmed, the app will finish setup automatically."}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              <p className="text-sm text-white/50">
                This flow stays single-account by default so the app behaves more like ChatGPT or
                Codex and less like a multi-account admin console.
              </p>
            </CardContent>
          </Card>

          <Card className="border-white/10 bg-white/5">
            <CardHeader>
              <CardTitle>Account status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm text-white/60">
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-white/40">Signed in as</p>
                <p className="mt-2 font-medium text-white">{user?.email}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-xs uppercase tracking-[0.22em] text-white/40">Default account name</p>
                <p className="mt-2 text-2xl font-semibold text-white">{defaultAccountName}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                After setup completes, projects and job uploads unlock automatically in the main view.
              </div>
            </CardContent>
          </Card>
        </section>
      </AppShell>
    );
  }

  const isClientView = activeMembership.role === "client";
  const isInternalAdmin = activeMembership.role === "internal_admin";

  const clientSidebarContent = (
    <div className="space-y-4">
      <div className="rounded-3xl border border-white/8 bg-white/[0.03] p-3">
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            onClick={() => setIsProjectsSectionCollapsed((current) => !current)}
            className="flex min-w-0 flex-1 items-start gap-3 rounded-2xl px-2 py-2 text-left transition-colors hover:bg-white/5"
          >
            <ChevronDown
              className={cn(
                "mt-0.5 h-4 w-4 shrink-0 text-white/55 transition-transform",
                isProjectsSectionCollapsed ? "-rotate-90" : "rotate-0",
              )}
            />
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-white/35">Projects</p>
              <p className="mt-2 text-sm text-white/45">
                {jobsQuery.isLoading
                  ? "Loading project folders..."
                  : `${jobs.length} ${clientItemLabel} organized into project folders.`}
              </p>
            </div>
          </button>
          <Button
            size="sm"
            className="shrink-0 rounded-full"
            onClick={openCreateProjectDialog}
          >
            <FolderPlus className="mr-2 h-3.5 w-3.5" />
            New
          </Button>
        </div>

        {!isProjectsSectionCollapsed ? (
          <div className="mt-3 space-y-3">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-1 border-white/10 bg-white/[0.04]"
                onClick={() => selectedEditableProject && openRenameProjectDialog(selectedEditableProject.id)}
                disabled={!selectedEditableProject}
              >
                <PencilLine className="mr-2 h-3.5 w-3.5" />
                Rename
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="flex-1 border-white/10 bg-white/[0.04] text-white hover:bg-destructive/10 hover:text-destructive"
                onClick={() => selectedEditableProject && openDeleteProjectDialog(selectedEditableProject.id)}
                disabled={!selectedEditableProject}
              >
                <Trash2 className="mr-2 h-3.5 w-3.5" />
                Delete
              </Button>
            </div>

            {jobsQuery.isLoading ? (
              <div className="flex items-center justify-center rounded-3xl border border-dashed border-white/10 bg-white/[0.03] p-6">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : projectSections.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.03] p-4 text-sm text-white/50">
                Create a {clientItemLabelSingular} to start building project groups.
              </div>
            ) : (
              <div className="space-y-2">
                {projectSections.map((section) => (
                  <div
                    key={section.id}
                    className={cn(
                      "rounded-3xl border p-3 transition-colors",
                      selectedProjectId === section.id
                        ? "border-primary/30 bg-primary/8"
                        : "border-white/8 bg-white/[0.03]",
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <button
                        type="button"
                        onClick={() => handleSelectProject(section)}
                        className="flex min-w-0 flex-1 items-start justify-between gap-3 rounded-2xl px-2 py-2 text-left"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <FolderKanban className="h-4 w-4 text-primary" />
                            <span className="truncate font-medium">{section.name}</span>
                          </div>
                          <p className="mt-1 text-xs text-white/45">
                            {section.visibleJobs.length === section.jobs.length && !searchTerm && activeFilter === "all"
                              ? `${section.jobs.length} ${clientItemLabelSingular}${section.jobs.length === 1 ? "" : "s"} in main window`
                              : `${section.visibleJobs.length} of ${section.jobs.length} shown in main window`}
                          </p>
                        </div>
                        <Badge
                          variant="secondary"
                          className="border border-white/10 bg-white/[0.05] text-white/70"
                        >
                          {section.jobs.length}
                        </Badge>
                      </button>

                      {!section.isVirtual ? (
                        <div className="flex shrink-0 gap-1 pt-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-xl text-white/45 hover:bg-white/5 hover:text-white"
                            onClick={() => openRenameProjectDialog(section.id)}
                          >
                            <PencilLine className="h-3.5 w-3.5" />
                            <span className="sr-only">Rename project</span>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-xl text-white/45 hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => openDeleteProjectDialog(section.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            <span className="sr-only">Delete project</span>
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : projectSections.length > 0 ? (
          <div className="mt-3 rounded-2xl border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/45">
            {projectSections.length} project{projectSections.length === 1 ? "" : "s"} hidden
          </div>
        ) : null}
      </div>
    </div>
  );

  if (isClientView) {
    return (
      <AppShell
        title="Projects"
        subtitle="Use the left rail like ChatGPT or Codex: pick a project, filter the jobs inside it, and keep the active work visible in the main pane."
        sidebarContent={clientSidebarContent}
        sidebarTitle="Projects"
        actions={
          <>
            <Button
              variant="outline"
              className="border-white/10 bg-white/[0.04]"
              onClick={openCreateProjectDialog}
            >
              <FolderPlus className="mr-2 h-4 w-4" />
              New project
            </Button>
            <Button asChild className="rounded-full">
              <Link to="/jobs/new">
                <UploadCloud className="mr-2 h-4 w-4" />
                Create Job
              </Link>
            </Button>
          </>
        }
      >
        {!isVerifiedAuth && user?.email ? (
          <section className="mb-8">
            <EmailVerificationPrompt
              email={user.email}
              isRefreshing={isRefreshingVerification}
              isResending={isResendingVerification}
              onRefreshSession={() => {
                void handleRefreshVerification();
              }}
              onResend={() => {
                void handleResendVerification();
              }}
              onChangeEmail={handleSignOut}
            />
          </section>
        ) : null}

        <Dialog
          open={isCreateProjectOpen}
          onOpenChange={(open) => {
            setIsCreateProjectOpen(open);
            if (!open) {
              setEditingProjectId(null);
              setProjectDialogMode("create");
              setProjectName("");
            }
          }}
        >
          <DialogContent className="border-white/10 bg-[#111318]">
            <DialogHeader>
              <DialogTitle>{projectDialogMode === "create" ? "Create project" : "Rename project"}</DialogTitle>
              <DialogDescription>
                {projectDialogMode === "create"
                  ? `Use selected ${clientItemLabel} to build a new project thread, or create an empty container and organize it later.`
                  : "Update the project name shown in the left project rail."}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2">
              <Label htmlFor="project-name">Project name</Label>
              <Input
                id="project-name"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                className="border-white/10 bg-black/20"
                placeholder={projectNameSuggestion}
              />
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-sm text-white/60">
              {projectDialogMode === "create"
                ? selectedJobIds.length > 0
                  ? `${selectedJobIds.length} selected ${clientItemLabel} will be moved into this project.`
                  : `No ${clientItemLabel} are selected. The project will be created empty.`
                : "Renaming keeps the current project contents in place."}
            </div>

            <DialogFooter>
              <Button
                variant="outline"
                className="border-white/10 bg-transparent"
                onClick={() => {
                  setIsCreateProjectOpen(false);
                  setEditingProjectId(null);
                  setProjectDialogMode("create");
                  setProjectName("");
                }}
              >
                Cancel
              </Button>
              <Button onClick={handleSaveProject}>
                {projectDialogMode === "create" ? "Create project" : "Save name"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog
          open={isDeleteProjectOpen}
          onOpenChange={(open) => {
            setIsDeleteProjectOpen(open);
            if (!open) {
              setDeletingProjectId(null);
            }
          }}
        >
          <DialogContent className="border-white/10 bg-[#111318]">
            <DialogHeader>
              <DialogTitle>Delete project</DialogTitle>
              <DialogDescription>
                Delete this project and move its {clientItemLabel} into Ungrouped.
              </DialogDescription>
            </DialogHeader>

            <DialogFooter>
              <Button
                variant="outline"
                className="border-white/10 bg-transparent"
                onClick={() => {
                  setIsDeleteProjectOpen(false);
                  setDeletingProjectId(null);
                }}
              >
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDeleteProject}>
                Delete project
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <section className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
          <div className="space-y-6">
            <Card className="border-white/10 bg-[#111318]/90">
              <CardContent className="p-6">
                <div className="flex flex-col gap-5 2xl:flex-row 2xl:items-start 2xl:justify-between">
                  <div className="max-w-2xl">
                    <Badge className="border border-primary/20 bg-primary/10 text-primary">
                      {normalizedEmail === dmriflesEmail ? "Seeded ChatGPT-style projects" : "Project view"}
                    </Badge>
                    <h2 className="mt-4 text-3xl font-semibold tracking-tight">
                      {selectedProject?.name ?? "Projects"}
                    </h2>
                    <p className="mt-2 text-sm text-white/55">
                      {normalizedEmail === dmriflesEmail
                        ? `${jobs.length} total jobs are now filed under QB00001, QB00002, and QB00003, with each project's parts listed in the main window.`
                        : "Browse jobs the way ChatGPT and Codex organize threads: choose a project in the left rail, then work the files in the main window."}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Badge variant="secondary" className="border border-white/10 bg-white/[0.05] text-white/75">
                        {jobs.length} total jobs
                      </Badge>
                      <Badge variant="secondary" className="border border-white/10 bg-white/[0.05] text-white/75">
                        {realProjectCount} projects
                      </Badge>
                      <Badge variant="secondary" className="border border-white/10 bg-white/[0.05] text-white/75">
                        {publishedPackages.length} published packages
                      </Badge>
                    </div>
                  </div>

                  <div className="w-full max-w-xl space-y-3">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                      <Input
                        value={searchTerm}
                        onChange={(event) => setSearchTerm(event.target.value)}
                        placeholder={`Search ${clientItemLabel}, descriptions, or tags`}
                        className="border-white/10 bg-black/20 pl-9"
                      />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant={selectionMode ? "default" : "outline"}
                        className={cn(
                          "border-white/10",
                          selectionMode ? "bg-primary text-primary-foreground" : "bg-white/[0.04]",
                        )}
                        onClick={() => setSelectionMode((current) => !current)}
                      >
                        <CheckSquare className="mr-2 h-4 w-4" />
                        {selectionMode ? "Done selecting" : `Select ${clientItemLabel}`}
                      </Button>

                      {clientFilterOptions.map((filterOption) => (
                        <Button
                          key={filterOption.id}
                          variant={activeFilter === filterOption.id ? "default" : "outline"}
                          className={cn(
                            "border-white/10",
                            activeFilter === filterOption.id ? "bg-primary text-primary-foreground" : "bg-white/[0.04]",
                          )}
                          onClick={() => setActiveFilter(filterOption.id)}
                        >
                          {filterOption.label}
                          <span className="ml-2 text-xs opacity-80">
                            {selectedProjectFilterCounts[filterOption.id]}
                          </span>
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>

                {selectionMode ? (
                  <div className="mt-5 flex flex-col gap-3 rounded-3xl border border-primary/20 bg-primary/10 p-4 md:flex-row md:items-center md:justify-between">
                    <div>
                      <p className="font-medium">
                        {selectedJobIds.length} {clientItemLabel} selected
                      </p>
                      <p className="text-sm text-primary-foreground/80">
                        Use selection mode to build a project from existing {clientItemLabel}, similar to organizing threads in ChatGPT.
                      </p>
                    </div>
                    <Button
                      className="rounded-full"
                      onClick={openCreateProjectDialog}
                      disabled={selectedJobIds.length === 0}
                    >
                      <FolderPlus className="mr-2 h-4 w-4" />
                      Create project from selection
                    </Button>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-lg font-medium">
                  {selectedProject?.name ? `${selectedProject.name} files` : `Filtered ${clientItemLabel}`}
                </h3>
                <p className="text-sm text-white/50">
                  {visibleJobs.length} visible {clientItemLabelSingular}
                  {visibleJobs.length === 1 ? "" : "s"} in the main window
                </p>
              </div>
              <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-white/60">
                <Filter className="h-4 w-4" />
                {clientFilterOptions.find((filterOption) => filterOption.id === activeFilter)?.label}
              </div>
            </div>

            {jobsQuery.isLoading ? (
              <div className="flex min-h-[320px] items-center justify-center rounded-3xl border border-dashed border-white/10 bg-white/[0.03]">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : jobsQuery.isError ? (
              <Card className="border-destructive/30 bg-destructive/10">
                <CardContent className="p-6 text-sm text-destructive">
                  {jobsQuery.error instanceof Error ? jobsQuery.error.message : "Failed to load jobs."}
                </CardContent>
              </Card>
            ) : visibleJobs.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-white/10 bg-black/20 p-10 text-center">
                <p className="text-lg font-medium">No {clientItemLabel} match the current filters</p>
                <p className="mt-2 text-sm text-white/50">
                  Adjust the project, search, or status filters to bring {clientItemLabel} back into view.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {visibleJobs.map((job) => {
                  const itemPresentation = getClientItemPresentation(job, partSummaryByJobId.get(job.id));
                  const isSelected = selectedJobIds.includes(job.id);
                  const isFocused = focusedJobId === job.id;

                  return (
                    <Card
                      key={job.id}
                      className={cn(
                        "border transition-colors",
                        isFocused ? "border-primary/35 bg-primary/8" : "border-white/10 bg-black/20",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => setFocusedJobId(job.id)}
                        className="w-full text-left"
                      >
                        <CardContent className="p-5">
                          <div className="flex items-start gap-4">
                            {selectionMode ? (
                              <div className="pt-1">
                                <Checkbox
                                  checked={isSelected}
                                  onCheckedChange={() => toggleJobSelection(job.id)}
                                  onClick={(event) => event.stopPropagation()}
                                  className="border-white/20 data-[state=checked]:border-primary data-[state=checked]:bg-primary"
                                />
                              </div>
                            ) : null}

                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-lg font-medium">{itemPresentation.title}</p>
                                  <p className="mt-2 text-sm text-white/55">
                                    {itemPresentation.description}
                                  </p>
                                  {itemPresentation.originalTitle ? (
                                    <p className="mt-2 text-xs text-white/35">
                                      Source job: {itemPresentation.originalTitle}
                                    </p>
                                  ) : null}
                                </div>
                                <Badge variant="secondary" className="border border-white/10 bg-white/[0.05] text-white/75">
                                  {formatStatusLabel(job.status)}
                                </Badge>
                              </div>

                              {job.tags.length > 0 ? (
                                <div className="mt-4 flex flex-wrap gap-2">
                                  {job.tags.map((tag) => (
                                    <Badge
                                      key={`${job.id}-${tag}`}
                                      variant="secondary"
                                      className="border border-primary/20 bg-primary/10 text-primary"
                                    >
                                      {tag}
                                    </Badge>
                                  ))}
                                </div>
                              ) : null}

                              <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-white/45">
                                <span className="inline-flex items-center gap-2">
                                  <Clock3 className="h-3.5 w-3.5 text-primary" />
                                  {new Date(job.created_at).toLocaleDateString()}
                                </span>
                                <span>
                                  {itemPresentation.quantity !== null
                                    ? `Qty ${itemPresentation.quantity}`
                                    : job.tags.length > 0
                                      ? `${job.tags.length} tag${job.tags.length === 1 ? "" : "s"}`
                                      : "No tags"}
                                </span>
                              </div>
                            </div>
                          </div>
                        </CardContent>
                      </button>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-4">
            <Card className="border-white/10 bg-black/20">
              <CardHeader>
                <CardTitle>Workspace pulse</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 md:grid-cols-3 xl:grid-cols-1">
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-sm text-white/55">Total jobs</p>
                  <p className="mt-2 text-2xl font-semibold">{metrics.totalJobs}</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-sm text-white/55">Needs review</p>
                  <p className="mt-2 text-2xl font-semibold">{metrics.needsReview}</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-sm text-white/55">Published packages</p>
                  <p className="mt-2 text-2xl font-semibold">{publishedPackages.length}</p>
                </div>
              </CardContent>
            </Card>

            <Card className="border-white/10 bg-black/20">
              <CardHeader>
                <CardTitle>{isDmriflesWorkspace ? "Focused part" : "Focused job"}</CardTitle>
              </CardHeader>
              <CardContent>
                {focusedJob ? (
                  (() => {
                    const itemPresentation = getClientItemPresentation(
                      focusedJob,
                      partSummaryByJobId.get(focusedJob.id),
                    );

                    return (
                      <div className="space-y-4">
                        <div>
                          <p className="text-2xl font-semibold">{itemPresentation.title}</p>
                          <p className="mt-2 text-sm text-white/55">
                            {itemPresentation.description}
                          </p>
                          {itemPresentation.originalTitle ? (
                            <p className="mt-2 text-xs text-white/35">
                              Source job: {itemPresentation.originalTitle}
                            </p>
                          ) : null}
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                            <p className="text-xs uppercase tracking-[0.2em] text-white/40">Status</p>
                            <p className="mt-2 font-medium">{formatStatusLabel(focusedJob.status)}</p>
                          </div>
                          <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                            <p className="text-xs uppercase tracking-[0.2em] text-white/40">Created</p>
                            <p className="mt-2 font-medium">{new Date(focusedJob.created_at).toLocaleDateString()}</p>
                          </div>
                        </div>

                        {focusedJob.tags.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {focusedJob.tags.map((tag) => (
                              <Badge
                                key={`${focusedJob.id}-focus-${tag}`}
                                variant="secondary"
                                className="border border-primary/20 bg-primary/10 text-primary"
                              >
                                {tag}
                              </Badge>
                            ))}
                          </div>
                        ) : (
                          <p className="text-sm text-white/45">
                            {itemPresentation.quantity !== null
                              ? `Quantity ${itemPresentation.quantity}`
                              : "No tags assigned to this job."}
                          </p>
                        )}
                      </div>
                    );
                  })()
                ) : (
                  <p className="text-sm text-white/50">
                    Select a {clientItemLabelSingular} to inspect its latest state here.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card className="border-white/10 bg-black/20">
              <CardHeader>
                <CardTitle>Published options</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {packagesQuery.isLoading ? (
                  <div className="flex items-center justify-center rounded-2xl border border-dashed border-white/10 bg-white/[0.03] p-6">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  </div>
                ) : packagesQuery.isError ? (
                  <div className="rounded-2xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                    {packagesQuery.error instanceof Error ? packagesQuery.error.message : "Failed to load packages."}
                  </div>
                ) : focusedJobPackages.length > 0 ? (
                  focusedJobPackages.map((pkg) => (
                    <Link
                      key={pkg.id}
                      to={`/client/packages/${pkg.id}`}
                      className="block rounded-2xl border border-white/10 bg-white/[0.04] p-4 transition hover:border-primary/25 hover:bg-white/[0.06]"
                    >
                      <p className="font-medium">Package {pkg.id.slice(0, 8)}</p>
                      <p className="mt-1 text-sm text-white/50">
                        Published {new Date(pkg.published_at).toLocaleDateString()}
                      </p>
                    </Link>
                  ))
                ) : publishedPackages.length > 0 ? (
                  <>
                    <p className="text-sm text-white/50">
                      No package has been published for the focused {clientItemLabelSingular} yet. Latest published packages are below.
                    </p>
                    {publishedPackages.slice(0, 3).map((pkg) => (
                      <Link
                        key={pkg.id}
                        to={`/client/packages/${pkg.id}`}
                        className="block rounded-2xl border border-white/10 bg-white/[0.04] p-4 transition hover:border-primary/25 hover:bg-white/[0.06]"
                      >
                        <p className="font-medium">Package {pkg.id.slice(0, 8)}</p>
                        <p className="mt-1 text-sm text-white/50">
                          Published {new Date(pkg.published_at).toLocaleDateString()}
                        </p>
                      </Link>
                    ))}
                  </>
                ) : (
                  <div className="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] p-6 text-center">
                    <p className="font-medium">No packages published yet</p>
                    <p className="mt-2 text-sm text-white/50">
                      Published quote options will appear here once an internal user completes the compare and publish flow.
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </section>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Operations Dashboard"
      subtitle="Review extracted specs, launch vendor quote runs, and publish curated options with versioned pricing."
      actions={
        <Button asChild className="rounded-full">
          <Link to="/jobs/new">
            <UploadCloud className="mr-2 h-4 w-4" />
            Create Job
          </Link>
        </Button>
      }
    >
      {!isVerifiedAuth && user?.email ? (
        <section className="mb-8">
          <EmailVerificationPrompt
            email={user.email}
            isRefreshing={isRefreshingVerification}
            isResending={isResendingVerification}
            onRefreshSession={() => {
              void handleRefreshVerification();
            }}
            onResend={() => {
              void handleResendVerification();
            }}
            onChangeEmail={handleSignOut}
          />
        </section>
      ) : null}

      <section className="grid gap-4 lg:grid-cols-4">
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Total jobs</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{metrics.totalJobs}</p>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">In review</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{metrics.needsReview}</p>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Active quote runs</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{metrics.quoted}</p>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-white/70">Published packages</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-semibold">{publishedPackages.length}</p>
          </CardContent>
        </Card>
      </section>

      {isInternalAdmin ? (
        <section className="mt-8">
          <Card className="border-white/10 bg-black/20">
            <CardHeader>
              <CardTitle>Team Access</CardTitle>
              <p className="text-sm text-white/55">
                Promote client users to estimator or admin after they have joined this account.
              </p>
            </CardHeader>
            <CardContent>
              {organizationMembershipsQuery.isLoading ? (
                <div className="flex items-center justify-center rounded-3xl border border-dashed border-white/10 bg-white/5 p-8">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                </div>
              ) : organizationMembershipsQuery.isError ? (
                <div className="rounded-3xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                  {organizationMembershipsQuery.error instanceof Error
                    ? organizationMembershipsQuery.error.message
                    : "Failed to load team access."}
                </div>
              ) : (organizationMembershipsQuery.data ?? []).length === 0 ? (
                <div className="rounded-3xl border border-dashed border-white/10 bg-white/5 p-8 text-center">
                  <p className="font-medium">No members found</p>
                  <p className="mt-2 text-sm text-white/50">
                    Members appear here after they sign in and get attached to this account.
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow className="border-white/10 hover:bg-transparent">
                      <TableHead className="text-white/55">Member</TableHead>
                      <TableHead className="text-white/55">Current role</TableHead>
                      <TableHead className="text-white/55">Created</TableHead>
                      <TableHead className="text-right text-white/55">Access level</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(organizationMembershipsQuery.data ?? []).map((member) => {
                      const isUpdatingMember =
                        updateMembershipRoleMutation.isPending &&
                        updateMembershipRoleMutation.variables?.membershipId === member.id;

                      return (
                        <TableRow key={member.id} className="border-white/10 hover:bg-white/5">
                          <TableCell>
                            <div>
                              <p className="font-medium">{member.email}</p>
                              <p className="text-xs text-white/45">
                                {member.userId === user?.id ? "You" : "Team member"}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell>
                            <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/75">
                              {formatStatusLabel(member.role)}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-white/55">
                            {new Date(member.createdAt).toLocaleDateString()}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="ml-auto flex w-full max-w-[220px] items-center justify-end gap-3">
                              {isUpdatingMember ? (
                                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                              ) : null}
                              <Select
                                value={member.role}
                                onValueChange={(value) =>
                                  updateMembershipRoleMutation.mutate({
                                    membershipId: member.id,
                                    role: value as AppRole,
                                  })
                                }
                                disabled={!isVerifiedAuth || updateMembershipRoleMutation.isPending}
                              >
                                <SelectTrigger className="border-white/10 bg-white/5 text-white">
                                  <SelectValue placeholder="Select role" />
                                </SelectTrigger>
                                <SelectContent>
                                  {membershipRoleOptions.map((role) => (
                                    <SelectItem key={role} value={role}>
                                      {formatStatusLabel(role)}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </section>
      ) : null}

      <section className="mt-8 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <Card className="border-white/10 bg-white/5">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle>Recent operational jobs</CardTitle>
              <p className="mt-2 text-sm text-white/55">
                Jobs are routed into extraction, approval, quote-run, and publication states.
              </p>
            </div>
            <FolderKanban className="h-5 w-5 text-primary" />
          </CardHeader>
          <CardContent className="space-y-4">
            {jobs.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-white/10 bg-black/20 p-10 text-center">
                <p className="text-lg font-medium">No jobs yet</p>
                <p className="mt-2 text-sm text-white/50">
                  Create a new CNC quoting job to start file intake and extraction.
                </p>
              </div>
            ) : (
              jobs.map((job) => (
                <Link
                  key={job.id}
                  to={`/internal/jobs/${job.id}`}
                  className="block rounded-3xl border border-white/8 bg-black/20 p-5 transition hover:border-primary/25 hover:bg-black/30"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-lg font-medium">{job.title}</p>
                      <p className="mt-1 text-sm text-white/50">{job.description || "No description provided."}</p>
                      {job.tags.length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {job.tags.map((tag) => (
                            <Badge
                              key={`${job.id}-${tag}`}
                              variant="secondary"
                              className="border border-primary/20 bg-primary/10 text-primary"
                            >
                              {tag}
                            </Badge>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <Badge variant="secondary" className="border border-white/10 bg-white/5 text-white/75">
                      {formatStatusLabel(job.status)}
                    </Badge>
                  </div>
                  <Separator className="my-4 bg-white/10" />
                  <div className="flex items-center gap-6 text-sm text-white/55">
                    <span className="inline-flex items-center gap-2">
                      <Clock3 className="h-4 w-4 text-primary" />
                      {new Date(job.created_at).toLocaleDateString()}
                    </span>
                    <span className="inline-flex items-center gap-2">
                      <Layers3 className="h-4 w-4 text-primary" />
                      Internal review path
                    </span>
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/5">
          <CardHeader>
            <CardTitle>Latest published packages</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {publishedPackages.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-white/10 bg-black/20 p-8 text-center">
                <p className="font-medium">No packages published yet</p>
                <p className="mt-2 text-sm text-white/50">
                  Published client options will appear here once an internal user completes the compare and publish flow.
                </p>
              </div>
            ) : (
              publishedPackages.map((pkg) => (
                <Link
                  key={pkg.id}
                  to={`/client/packages/${pkg.id}`}
                  className="block rounded-3xl border border-white/8 bg-black/20 p-5 transition hover:border-primary/25 hover:bg-black/30"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium">Package {pkg.id.slice(0, 8)}</p>
                      <p className="mt-1 text-sm text-white/50">
                        Published {new Date(pkg.published_at).toLocaleDateString()}
                      </p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-white/45" />
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </section>

      {publishedPackages.length > 0 ? (
        <section className="mt-8">
          <Card className="border-white/10 bg-black/20">
            <CardHeader>
              <CardTitle>Client-facing publication behavior</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-3">
              {["lowest_cost", "fastest_delivery", "balanced"].map((kind) => (
                <div key={kind} className="rounded-2xl border border-white/8 bg-white/5 p-4">
                  <p className="font-medium">{optionLabelForKind(kind as ClientOptionKind)}</p>
                  <p className="mt-2 text-sm text-white/55">
                    Publish distinct curated options only. Duplicate underlying vendor results are collapsed before the client sees them.
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      ) : null}
    </AppShell>
  );
};

export default Index;
