import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { User } from "@supabase/supabase-js";
import {
  ArrowRight,
  CheckSquare,
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
import {
  buildDmriflesProjects,
  DMRIFLES_EMAIL,
  isDmriflesSystemProject,
  PROJECT_STORAGE_PREFIX,
  type ClientJobProject,
} from "@/features/quotes/client-workspace";

const membershipRoleOptions: AppRole[] = ["client", "internal_estimator", "internal_admin"];

type JobFilter = "all" | "needs_attention" | "quoting" | "published";

type ProjectSection = ClientJobProject & {
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

  return `${PROJECT_STORAGE_PREFIX}:${organizationId}:${userEmail.toLowerCase()}`;
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

function sanitizeProjectList(projects: ClientJobProject[], jobs: JobRecord[]): ClientJobProject[] {
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

function loadPersistedProjects(
  projectStorageKey: string,
  jobs: JobRecord[],
  userEmail: string,
  partSummariesByJobId: Map<string, JobPartSummary>,
): ClientJobProject[] {
  const systemDmriflesProjects =
    userEmail.toLowerCase() === DMRIFLES_EMAIL
      ? sanitizeProjectList(buildDmriflesProjects(jobs, partSummariesByJobId), jobs)
      : [];

  if (userEmail.toLowerCase() === DMRIFLES_EMAIL) {
    return systemDmriflesProjects;
  }

  if (typeof window !== "undefined") {
    const rawProjects = window.localStorage.getItem(projectStorageKey);

    if (rawProjects) {
      try {
        const parsedProjects = JSON.parse(rawProjects) as ClientJobProject[];
        if (Array.isArray(parsedProjects)) {
          const sanitizedProjects = sanitizeProjectList(parsedProjects, jobs);
          return sanitizedProjects;
        }
      } catch {
        window.localStorage.removeItem(projectStorageKey);
      }
    }
  }

  return [];
}

function getSuggestedProjectName(projects: ClientJobProject[]): string {
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
  const [projectGroups, setProjectGroups] = useState<ClientJobProject[]>([]);
  const [loadedProjectKey, setLoadedProjectKey] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<JobFilter>("all");
  const [searchTerm, setSearchTerm] = useState("");
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
  const isDmriflesWorkspace = normalizedEmail === DMRIFLES_EMAIL;
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
      isDmriflesWorkspace ||
      !projectStorageKey ||
      loadedProjectKey !== projectStorageKey ||
      typeof window === "undefined"
    ) {
      return;
    }

    window.localStorage.setItem(projectStorageKey, JSON.stringify(projectGroups));
  }, [isDmriflesWorkspace, loadedProjectKey, projectGroups, projectStorageKey]);

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
  const selectedProjectIsSystemManaged = useMemo(
    () => isDmriflesSystemProject(selectedEditableProject),
    [selectedEditableProject],
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
  const canMutateProjects = !isDmriflesWorkspace;
  const canRenameSelectedProject = Boolean(selectedEditableProject) && !selectedProjectIsSystemManaged;
  const activeFilterLabel =
    clientFilterOptions.find((filterOption) => filterOption.id === activeFilter)?.label ?? "All jobs";
  const focusedItemPresentation = useMemo(
    () => (focusedJob ? getClientItemPresentation(focusedJob, partSummaryByJobId.get(focusedJob.id)) : null),
    [focusedJob, partSummaryByJobId],
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
    if (!canMutateProjects) {
      return;
    }

    setProjectDialogMode("create");
    setEditingProjectId(null);
    setProjectName(projectNameSuggestion);
    setIsCreateProjectOpen(true);
  };

  const openRenameProjectDialog = (projectId: string) => {
    const project = projectGroups.find((candidate) => candidate.id === projectId);

    if (!project || isDmriflesSystemProject(project)) {
      return;
    }

    setProjectDialogMode("rename");
    setEditingProjectId(project.id);
    setProjectName(project.name);
    setIsCreateProjectOpen(true);
  };

  const openDeleteProjectDialog = (projectId: string) => {
    const project = projectGroups.find((candidate) => candidate.id === projectId);

    if (!project || isDmriflesSystemProject(project)) {
      return;
    }

    setDeletingProjectId(projectId);
    setIsDeleteProjectOpen(true);
  };

  const handleSaveProject = () => {
    if (!canMutateProjects) {
      return;
    }

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
    if (!deletingProjectId || !canMutateProjects) {
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
      <div className="rounded-[26px] border border-white/6 bg-white/[0.02] p-4">
        <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">Account</p>
        <p className="mt-3 truncate text-sm font-medium text-white">{user?.email}</p>
        <div className="mt-4 grid grid-cols-2 gap-2 text-xs text-white/55">
          <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-2">
            <span className="block text-[10px] uppercase tracking-[0.18em] text-white/35">Items</span>
            <span className="mt-2 block text-base font-medium text-white">{jobs.length}</span>
          </div>
          <div className="rounded-2xl border border-white/8 bg-black/20 px-3 py-2">
            <span className="block text-[10px] uppercase tracking-[0.18em] text-white/35">Projects</span>
            <span className="mt-2 block text-base font-medium text-white">{realProjectCount}</span>
          </div>
        </div>
        <p className="mt-4 text-xs leading-5 text-white/45">
          {isDmriflesWorkspace
            ? "QB folders are system-managed from imported quote batches."
            : "Use the rail like a thread list: pick a project, then work the active jobs in the main pane."}
        </p>
      </div>

      <div className="rounded-[26px] border border-white/6 bg-white/[0.02] p-3">
        <div className="flex items-start justify-between gap-3 px-2 pb-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">Projects</p>
            <p className="mt-2 text-xs text-white/45">
              {jobsQuery.isLoading
                ? "Loading project folders..."
                : `${jobs.length} ${clientItemLabel} organized in the rail.`}
            </p>
          </div>
          <Button
            size="sm"
            className="rounded-full"
            onClick={openCreateProjectDialog}
            disabled={!canMutateProjects}
            title={canMutateProjects ? "Create project" : "DMRifles folders are system-managed"}
          >
            <FolderPlus className="mr-2 h-3.5 w-3.5" />
            New
          </Button>
        </div>

        <div className="flex gap-2 px-2 pb-3">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 border-white/10 bg-white/[0.04]"
            onClick={() => selectedEditableProject && openRenameProjectDialog(selectedEditableProject.id)}
            disabled={!canRenameSelectedProject}
          >
            <PencilLine className="mr-2 h-3.5 w-3.5" />
            Rename
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 border-white/10 bg-white/[0.04] text-white hover:bg-destructive/10 hover:text-destructive"
            onClick={() => selectedEditableProject && openDeleteProjectDialog(selectedEditableProject.id)}
            disabled={!canRenameSelectedProject}
          >
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete
          </Button>
        </div>

        {jobsQuery.isLoading ? (
          <div className="flex items-center justify-center rounded-[22px] border border-dashed border-white/10 bg-black/20 p-6">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : projectSections.length === 0 ? (
          <div className="rounded-[22px] border border-dashed border-white/10 bg-black/20 p-4 text-sm text-white/50">
            Create a {clientItemLabelSingular} to start organizing projects.
          </div>
        ) : (
          <div className="space-y-1.5">
            {projectSections.map((section) => (
              <button
                key={section.id}
                type="button"
                onClick={() => handleSelectProject(section)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-[22px] px-3 py-3 text-left transition-colors",
                  selectedProjectId === section.id
                    ? "bg-white/[0.10] text-white"
                    : "bg-transparent text-white/75 hover:bg-white/[0.04] hover:text-white",
                )}
              >
                <FolderKanban className="h-4 w-4 shrink-0 text-white/55" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{section.name}</span>
                    {isDmriflesSystemProject(section) ? (
                      <span className="rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] text-white/45">
                        Batch
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-xs text-white/40">
                    {section.visibleJobs.length === section.jobs.length && !searchTerm && activeFilter === "all"
                      ? `${section.jobs.length} ${clientItemLabelSingular}${section.jobs.length === 1 ? "" : "s"}`
                      : `${section.visibleJobs.length} of ${section.jobs.length} shown`}
                  </p>
                </div>
                <Badge
                  variant="secondary"
                  className="border border-white/10 bg-white/[0.05] text-white/70"
                >
                  {section.jobs.length}
                </Badge>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  if (isClientView) {
    return (
      <AppShell
        title="Projects"
        subtitle="Pick a project in the left rail, filter the active work, and keep the current part visible while you move through the queue."
        sidebarContent={clientSidebarContent}
        sidebarTitle="Projects"
        variant="client-chat"
        actions={
          <>
            <Button
              variant="outline"
              className="border-white/10 bg-white/[0.04]"
              onClick={openCreateProjectDialog}
              disabled={!canMutateProjects}
              title={canMutateProjects ? "Create project" : "DMRifles folders are system-managed"}
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
              <Button onClick={handleSaveProject} disabled={!canMutateProjects}>
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

        <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="space-y-4">
            <div className="sticky top-24 z-10 rounded-[30px] border border-white/8 bg-[#15171b]/95 p-5 shadow-[0_20px_60px_rgba(0,0,0,0.28)] backdrop-blur">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">Active project</p>
                    <h2 className="mt-3 truncate text-2xl font-medium tracking-tight text-white">
                      {selectedProject?.name ?? "All projects"}
                    </h2>
                    <p className="mt-2 text-sm text-white/50">
                      {selectedProject
                        ? `${selectedProject.jobs.length} ${clientItemLabel} in this project`
                        : `${jobs.length} ${clientItemLabel} across the workspace`}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Badge variant="secondary" className="border border-white/10 bg-white/[0.05] text-white/75">
                        {jobs.length} total
                      </Badge>
                      <Badge variant="secondary" className="border border-white/10 bg-white/[0.05] text-white/75">
                        {realProjectCount} projects
                      </Badge>
                      <Badge variant="secondary" className="border border-white/10 bg-white/[0.05] text-white/75">
                        {publishedPackages.length} published
                      </Badge>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      className="border-white/10 bg-white/[0.04]"
                      onClick={openCreateProjectDialog}
                      disabled={!canMutateProjects}
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
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto]">
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

                <div className="flex flex-wrap items-center gap-3 text-sm text-white/50">
                  <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1.5">
                    <Filter className="h-4 w-4" />
                    {activeFilterLabel}
                  </span>
                  <span>
                    {visibleJobs.length} visible {clientItemLabelSingular}
                    {visibleJobs.length === 1 ? "" : "s"}
                  </span>
                </div>

                {isDmriflesWorkspace ? (
                  <p className="text-sm text-white/45">
                    QB folders are system-managed from imported quote batches. Selection and filtering stay available, but project edits are disabled for this demo account.
                  </p>
                ) : null}

                {selectionMode ? (
                  <div className="rounded-[24px] border border-primary/20 bg-primary/10 px-4 py-3">
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div>
                        <p className="font-medium text-white">
                          {selectedJobIds.length} {clientItemLabel} selected
                        </p>
                        <p className="text-sm text-primary-foreground/80">
                          Use the selected rows to assemble a project thread from the current list.
                        </p>
                      </div>
                      <Button
                        className="rounded-full"
                        onClick={openCreateProjectDialog}
                        disabled={selectedJobIds.length === 0 || !canMutateProjects}
                      >
                        <FolderPlus className="mr-2 h-4 w-4" />
                        Create project from selection
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            {jobsQuery.isLoading ? (
              <div className="flex min-h-[320px] items-center justify-center rounded-[30px] border border-dashed border-white/10 bg-[#15171b]">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : jobsQuery.isError ? (
              <div className="rounded-[30px] border border-destructive/30 bg-destructive/10 p-6 text-sm text-destructive">
                {jobsQuery.error instanceof Error ? jobsQuery.error.message : "Failed to load jobs."}
              </div>
            ) : visibleJobs.length === 0 ? (
              <div className="rounded-[30px] border border-dashed border-white/10 bg-[#15171b] p-10 text-center">
                <p className="text-lg font-medium text-white">No {clientItemLabel} match this view</p>
                <p className="mt-2 text-sm text-white/50">
                  Adjust the project, search, or status filters to bring {clientItemLabel} back into view.
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-[30px] border border-white/8 bg-[#15171b]">
                {visibleJobs.map((job) => {
                  const itemPresentation = getClientItemPresentation(job, partSummaryByJobId.get(job.id));
                  const isSelected = selectedJobIds.includes(job.id);
                  const isFocused = focusedJobId === job.id;

                  return (
                    <div
                      key={job.id}
                      className={cn(
                        "flex w-full items-start gap-4 border-b border-white/6 px-4 py-4 text-left transition-colors last:border-b-0",
                        isFocused ? "bg-white/[0.08]" : "hover:bg-white/[0.03]",
                      )}
                    >
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

                      <button
                        type="button"
                        onClick={() => setFocusedJobId(job.id)}
                        className="flex min-w-0 flex-1 items-start gap-4 text-left"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-base font-medium text-white">{itemPresentation.title}</p>
                              <p className="mt-1 line-clamp-2 text-sm text-white/52">
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

                          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-white/42">
                            <span className="inline-flex items-center gap-2">
                              <Clock3 className="h-3.5 w-3.5 text-white/35" />
                              {new Date(job.created_at).toLocaleDateString()}
                            </span>
                            <span>
                              {itemPresentation.quantity !== null
                                ? `Qty ${itemPresentation.quantity}`
                                : job.tags.length > 0
                                  ? `${job.tags.length} tag${job.tags.length === 1 ? "" : "s"}`
                                  : "No tags"}
                            </span>
                            {job.tags.length > 0 ? (
                              <span className="truncate text-white/35">{job.tags.join(", ")}</span>
                            ) : null}
                          </div>
                        </div>

                        <ArrowRight className="mt-1 hidden h-4 w-4 shrink-0 text-white/25 sm:block" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <aside className="space-y-4 xl:sticky xl:top-24 xl:self-start">
            <div className="rounded-[30px] border border-white/8 bg-[#15171b] p-5">
              <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">
                {isDmriflesWorkspace ? "Focused part" : "Focused job"}
              </p>
              {focusedJob && focusedItemPresentation ? (
                <div className="mt-4 space-y-4">
                  <div>
                    <h3 className="text-xl font-medium text-white">{focusedItemPresentation.title}</h3>
                    <p className="mt-2 text-sm text-white/55">{focusedItemPresentation.description}</p>
                    {focusedItemPresentation.originalTitle ? (
                      <p className="mt-2 text-xs text-white/35">
                        Source job: {focusedItemPresentation.originalTitle}
                      </p>
                    ) : null}
                  </div>

                  <div className="grid gap-3">
                    <div className="rounded-[22px] border border-white/8 bg-black/20 px-4 py-3">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Status</p>
                      <p className="mt-2 text-sm font-medium text-white">{formatStatusLabel(focusedJob.status)}</p>
                    </div>
                    <div className="rounded-[22px] border border-white/8 bg-black/20 px-4 py-3">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Created</p>
                      <p className="mt-2 text-sm font-medium text-white">
                        {new Date(focusedJob.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <div className="rounded-[22px] border border-white/8 bg-black/20 px-4 py-3">
                      <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                        {focusedItemPresentation.quantity !== null ? "Quantity" : "Tags"}
                      </p>
                      <p className="mt-2 text-sm font-medium text-white">
                        {focusedItemPresentation.quantity !== null
                          ? focusedItemPresentation.quantity
                          : focusedJob.tags.length > 0
                            ? focusedJob.tags.join(", ")
                            : "No tags"}
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-sm text-white/50">
                  Select a {clientItemLabelSingular} to inspect its latest state here.
                </p>
              )}
            </div>

            <div className="rounded-[30px] border border-white/8 bg-[#15171b] p-5">
              <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">Published options</p>
              <div className="mt-4 space-y-3">
                {packagesQuery.isLoading ? (
                  <div className="flex items-center justify-center rounded-[22px] border border-dashed border-white/10 bg-black/20 p-6">
                    <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  </div>
                ) : packagesQuery.isError ? (
                  <div className="rounded-[22px] border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
                    {packagesQuery.error instanceof Error ? packagesQuery.error.message : "Failed to load packages."}
                  </div>
                ) : focusedJobPackages.length > 0 ? (
                  focusedJobPackages.map((pkg) => (
                    <Link
                      key={pkg.id}
                      to={`/client/packages/${pkg.id}`}
                      className="block rounded-[22px] border border-white/10 bg-black/20 p-4 transition hover:border-white/20 hover:bg-white/[0.04]"
                    >
                      <p className="font-medium text-white">Package {pkg.id.slice(0, 8)}</p>
                      <p className="mt-1 text-sm text-white/50">
                        Published {new Date(pkg.published_at).toLocaleDateString()}
                      </p>
                    </Link>
                  ))
                ) : publishedPackages.length > 0 ? (
                  <>
                    <p className="text-sm text-white/50">
                      No package has been published for the focused {clientItemLabelSingular} yet. Recent packages are below.
                    </p>
                    {publishedPackages.slice(0, 3).map((pkg) => (
                      <Link
                        key={pkg.id}
                        to={`/client/packages/${pkg.id}`}
                        className="block rounded-[22px] border border-white/10 bg-black/20 p-4 transition hover:border-white/20 hover:bg-white/[0.04]"
                      >
                        <p className="font-medium text-white">Package {pkg.id.slice(0, 8)}</p>
                        <p className="mt-1 text-sm text-white/50">
                          Published {new Date(pkg.published_at).toLocaleDateString()}
                        </p>
                      </Link>
                    ))}
                  </>
                ) : (
                  <div className="rounded-[22px] border border-dashed border-white/10 bg-black/20 p-6 text-center">
                    <p className="font-medium text-white">No packages published yet</p>
                    <p className="mt-2 text-sm text-white/50">
                      Published quote options appear here after the estimator publishes a package.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </aside>
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
