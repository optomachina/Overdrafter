import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import {
  Archive,
  FolderPlus,
  Globe2,
  Loader2,
  MapPin,
  MoveRight,
  Pencil,
  PlusSquare,
  RotateCcw,
  Search as SearchIcon,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { WorkspaceAccountMenu } from "@/components/chat/WorkspaceAccountMenu";
import { ChatWorkspaceLayout } from "@/components/chat/ChatWorkspaceLayout";
import { ProjectMembersDialog } from "@/components/chat/ProjectMembersDialog";
import { PromptComposer } from "@/components/chat/PromptComposer";
import { SearchPartsDialog } from "@/components/chat/SearchPartsDialog";
import { ProjectNameDialog } from "@/components/projects/ProjectNameDialog";
import { ActivityLog, type ActivityLogEntry } from "@/components/quotes/ActivityLog";
import { ClientPartRequestEditor } from "@/components/quotes/ClientPartRequestEditor";
import {
  ClientCadPreviewPanel,
  ClientDrawingPreviewPanel,
} from "@/components/quotes/ClientQuoteAssetPanels";
import { RequestSummaryBadges } from "@/components/quotes/RequestSummaryBadges";
import {
  WorkspaceSidebar,
  type WorkspaceSidebarProject,
} from "@/components/chat/WorkspaceSidebar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAppSession } from "@/hooks/use-app-session";
import {
  archiveJob,
  archiveProject,
  assignJobToProject,
  createClientDraft,
  createJobsFromUploadFiles,
  createProject,
  deleteArchivedJob,
  dissolveProject,
  fetchAccessibleJobs,
  fetchAccessibleProjects,
  fetchArchivedJobs,
  fetchArchivedProjects,
  fetchClientQuoteWorkspaceByJobIds,
  fetchJobPartSummariesByJobIds,
  fetchProjectJobMembershipsByJobIds,
  fetchJobsByProject,
  fetchProject,
  fetchProjectInvites,
  fetchProjectMemberships,
  fetchSidebarPins,
  inviteProjectMember,
  isProjectCollaborationSchemaUnavailable,
  pinJob,
  pinProject,
  reconcileJobParts,
  removeJobFromProject,
  removeProjectMember,
  requestExtraction,
  setJobSelectedVendorQuoteOffer,
  unarchiveJob,
  unarchiveProject,
  unpinJob,
  unpinProject,
  updateClientPartRequest,
  updateProject,
  uploadFilesToJob,
} from "@/features/quotes/api";
import { useArchiveUndo } from "@/features/quotes/archive-undo";
import { getClientItemPresentation, matchesClientJobSearch } from "@/features/quotes/client-presentation";
import {
  buildDmriflesProjects,
  buildSeedProjectId,
  DMRIFLES_EMAIL,
  findImportedBatchProjectId,
  resolveImportedBatch,
  syncImportedBatchProjects,
} from "@/features/quotes/client-workspace";
import {
  formatRequestedQuoteQuantitiesInput,
  parseRequestIntake,
  parseRequestedQuoteQuantitiesInput,
} from "@/features/quotes/request-intake";
import { getSharedRequestMetadata } from "@/features/quotes/request-scenarios";
import {
  applyBulkPresetSelection,
  buildClientQuoteSelectionOptions,
  buildVendorLabelMap,
  getSelectedOption,
  revertBulkPresetSelection,
  sortQuoteOptionsForPreset,
  summarizeSelectedQuoteOptions,
  type BulkSelectionChange,
  type ClientQuoteSelectionOption,
  type QuotePreset,
} from "@/features/quotes/selection";
import type { ClientPartRequestUpdateInput } from "@/features/quotes/types";
import { buildProjectNameFromLabels, normalizeUploadStem } from "@/features/quotes/upload-groups";
import { useClientJobFilePicker } from "@/features/quotes/use-client-job-file-picker";
import { readExcludedVendorKeys, toggleExcludedVendorKey } from "@/features/quotes/vendor-exclusions";
import {
  buildRequirementDraft,
  formatCurrency,
  formatLeadTime,
  formatStatusLabel,
} from "@/features/quotes/utils";
import type { VendorName } from "@/integrations/supabase/types";
import { cn } from "@/lib/utils";

type JobFilter = "all" | "needs_attention" | "quoting" | "published";

const clientFilterOptions: { id: JobFilter; label: string }[] = [
  { id: "all", label: "All parts" },
  { id: "needs_attention", label: "Needs attention" },
  { id: "quoting", label: "Quoting" },
  { id: "published", label: "Published" },
];

function matchesJobFilter(status: string, filter: JobFilter) {
  switch (filter) {
    case "needs_attention":
      return status === "needs_spec_review" || status === "internal_review";
    case "quoting":
      return status === "quoting";
    case "published":
      return status === "published";
    case "all":
    default:
      return true;
  }
}

const ClientProject = () => {
  const { projectId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, activeMembership, signOut } = useAppSession();
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<JobFilter>("all");
  const [focusedJobId, setFocusedJobId] = useState<string | null>(null);
  const [showAddPart, setShowAddPart] = useState(false);
  const [showRename, setShowRename] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [showDissolve, setShowDissolve] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [projectName, setProjectName] = useState("");
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [selectedOfferOverrides, setSelectedOfferOverrides] = useState<Record<string, string | null>>({});
  const [lastBulkAction, setLastBulkAction] = useState<BulkSelectionChange[]>([]);
  const [excludedVendorKeysByJobId, setExcludedVendorKeysByJobId] = useState<Record<string, VendorName[]>>({});
  const [requestDraftsByJobId, setRequestDraftsByJobId] = useState<Record<string, ClientPartRequestUpdateInput>>({});
  const [quoteQuantityInputsByJobId, setQuoteQuantityInputsByJobId] = useState<Record<string, string>>({});
  const isMobile = useIsMobile();
  const normalizedEmail = user?.email?.toLowerCase() ?? "";
  const isDmriflesWorkspace = normalizedEmail === DMRIFLES_EMAIL;
  const isSeededProject = projectId.startsWith("seed-");
  const registerArchiveUndo = useArchiveUndo();
  const [hasAttemptedDmriflesProjectSync, setHasAttemptedDmriflesProjectSync] = useState(false);

  const accessibleProjectsQuery = useQuery({
    queryKey: ["client-projects"],
    queryFn: fetchAccessibleProjects,
    enabled: Boolean(user),
  });
  const accessibleJobsQuery = useQuery({
    queryKey: ["client-jobs"],
    queryFn: fetchAccessibleJobs,
    enabled: Boolean(user),
  });
  const sidebarPinsQuery = useQuery({
    queryKey: ["sidebar-pins", user?.id],
    queryFn: fetchSidebarPins,
    enabled: Boolean(user),
  });
  const archivedProjectsQuery = useQuery({
    queryKey: ["archived-projects"],
    queryFn: fetchArchivedProjects,
    enabled: Boolean(user),
  });
  const archivedJobsQuery = useQuery({
    queryKey: ["archived-jobs"],
    queryFn: fetchArchivedJobs,
    enabled: Boolean(user),
  });
  const projectCollaborationUnavailable = isProjectCollaborationSchemaUnavailable();
  const newJobFilePicker = useClientJobFilePicker({
    isSignedIn: Boolean(user),
    onRequireAuth: () => navigate("/?auth=signin"),
    onFilesSelected: async (files) => {
      const result = await createJobsFromUploadFiles({
        files,
        projectId: isSeededProject ? null : projectId,
      });

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
        queryClient.invalidateQueries({ queryKey: ["client-project-job-memberships"] }),
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["sidebar-pins", user?.id] }),
      ]);

      if (result.projectId && result.jobIds.length > 1) {
        navigate(`/projects/${result.projectId}`);
        return;
      }

      navigate(`/parts/${result.jobIds[0]}`);
    },
  });
  const attachFilesPicker = useClientJobFilePicker({
    isSignedIn: Boolean(user),
    onRequireAuth: () => navigate("/?auth=signin"),
    onFilesSelected: async (files) => {
      if (!focusedJobId) {
        throw new Error("Select a line item before uploading a revision.");
      }

      const workspaceItem = workspaceItemsByJobId.get(focusedJobId) ?? null;
      const normalizedStem = workspaceItem?.part?.normalized_key;

      if (!normalizedStem) {
        throw new Error("This line item is not ready for attachments yet.");
      }

      const invalid = files.find((file) => normalizeUploadStem(file.name) !== normalizedStem);

      if (invalid) {
        throw new Error(`"${invalid.name}" does not match this line item's filename stem.`);
      }

      const uploadSummary = await uploadFilesToJob(focusedJobId, files);

      if (uploadSummary.uploadedCount > 0 || uploadSummary.reusedCount > 0) {
        await reconcileJobParts(focusedJobId);
        await requestExtraction(focusedJobId);
      }

      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-quote-workspace", projectJobIds] }),
        queryClient.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
      ]);

      if (uploadSummary.uploadedCount > 0 || uploadSummary.reusedCount > 0) {
        toast.success("Files attached to line item.");
      }
    },
  });
  const canLoadRemoteProjectData =
    Boolean(user) && !isSeededProject && !accessibleProjectsQuery.isLoading && !projectCollaborationUnavailable;

  const accessibleJobIds = useMemo(
    () => (accessibleJobsQuery.data ?? []).map((job) => job.id),
    [accessibleJobsQuery.data],
  );
  const partSummariesQuery = useQuery({
    queryKey: ["client-part-summaries", accessibleJobIds],
    queryFn: () => fetchJobPartSummariesByJobIds(accessibleJobIds),
    enabled: Boolean(user) && accessibleJobIds.length > 0,
  });
  const sidebarProjectJobMembershipsQuery = useQuery({
    queryKey: ["client-project-job-memberships", accessibleJobIds],
    queryFn: () => fetchProjectJobMembershipsByJobIds(accessibleJobIds),
    enabled: Boolean(user) && accessibleJobIds.length > 0 && !projectCollaborationUnavailable,
  });

  const projectQuery = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => fetchProject(projectId),
    enabled: canLoadRemoteProjectData,
  });
  const projectJobsQuery = useQuery({
    queryKey: ["project-jobs", projectId],
    queryFn: () => fetchJobsByProject(projectId),
    enabled: canLoadRemoteProjectData,
  });
  const projectMembershipsQuery = useQuery({
    queryKey: ["project-memberships", projectId],
    queryFn: () => fetchProjectMemberships(projectId),
    enabled: canLoadRemoteProjectData && showMembers,
  });
  const projectInvitesQuery = useQuery({
    queryKey: ["project-invites", projectId],
    queryFn: () => fetchProjectInvites(projectId),
    enabled: canLoadRemoteProjectData && showMembers,
  });

  const summariesByJobId = useMemo(
    () => new Map((partSummariesQuery.data ?? []).map((summary) => [summary.jobId, summary])),
    [partSummariesQuery.data],
  );
  const accessibleJobsById = useMemo(
    () => new Map((accessibleJobsQuery.data ?? []).map((job) => [job.id, job])),
    [accessibleJobsQuery.data],
  );
  const sidebarProjectIdsByJobId = useMemo(() => {
    const next = new Map<string, string[]>();

    (sidebarProjectJobMembershipsQuery.data ?? []).forEach((membership) => {
      const projectIds = next.get(membership.job_id) ?? [];

      if (!projectIds.includes(membership.project_id)) {
        projectIds.push(membership.project_id);
      }

      next.set(membership.job_id, projectIds);
    });

    return next;
  }, [sidebarProjectJobMembershipsQuery.data]);

  const seededProjects = useMemo(() => {
    if (!isDmriflesWorkspace) {
      return [] as WorkspaceSidebarProject[];
    }

    const summaryMap = new Map((partSummariesQuery.data ?? []).map((summary) => [summary.jobId, summary]));

    return buildDmriflesProjects(accessibleJobsQuery.data ?? [], summaryMap).map((project) => ({
      id: project.id,
      name: project.name,
      partCount: project.jobIds.length,
      roleLabel: "batch",
      isReadOnly: true,
      canManage: false,
      createdAt: project.createdAt,
      updatedAt: project.createdAt,
    }));
  }, [accessibleJobsQuery.data, isDmriflesWorkspace, partSummariesQuery.data]);

  const remoteProjects = useMemo(
    () =>
      (accessibleProjectsQuery.data ?? []).map((project) => ({
        id: project.project.id,
        name: project.project.name,
        partCount: project.partCount,
        inviteCount: project.inviteCount,
        roleLabel: project.currentUserRole,
        canRename: project.currentUserRole === "owner" || project.currentUserRole === "editor",
        canDelete: project.currentUserRole === "owner",
        createdAt: project.project.created_at,
        updatedAt: project.project.updated_at,
      })),
    [accessibleProjectsQuery.data],
  );
  const remoteProjectsByName = useMemo(
    () => new Map(remoteProjects.map((project) => [project.name.trim().toUpperCase(), project.id])),
    [remoteProjects],
  );
  const sidebarProjects = isDmriflesWorkspace
    ? [
        ...seededProjects.filter((project) => !remoteProjectsByName.has(project.name.trim().toUpperCase())),
        ...remoteProjects,
      ]
    : remoteProjects;
  const redirectedSeedProjectId = useMemo(() => {
    if (!isSeededProject) {
      return null;
    }

    const batchName = projectId.replace(/^seed-/i, "").toUpperCase();
    return remoteProjectsByName.get(batchName) ?? null;
  }, [isSeededProject, projectId, remoteProjectsByName]);

  const seededProject = useMemo(() => {
    if (!isSeededProject) {
      return null;
    }

    const summaryMap = new Map((partSummariesQuery.data ?? []).map((summary) => [summary.jobId, summary]));
    return buildDmriflesProjects(accessibleJobsQuery.data ?? [], summaryMap).find(
      (project) => project.id === projectId,
    );
  }, [accessibleJobsQuery.data, isSeededProject, partSummariesQuery.data, projectId]);

  const projectJobs = useMemo(() => {
    if (seededProject) {
      const jobsById = new Map((accessibleJobsQuery.data ?? []).map((job) => [job.id, job]));
      return seededProject.jobIds
        .map((jobId) => jobsById.get(jobId))
        .filter((job): job is NonNullable<typeof job> => Boolean(job));
    }

    return projectJobsQuery.data ?? [];
  }, [accessibleJobsQuery.data, projectJobsQuery.data, seededProject]);
  const projectJobIds = useMemo(() => projectJobs.map((job) => job.id), [projectJobs]);
  const projectWorkspaceItemsQuery = useQuery({
    queryKey: ["client-quote-workspace", projectJobIds],
    queryFn: () => fetchClientQuoteWorkspaceByJobIds(projectJobIds),
    enabled: Boolean(user) && projectJobIds.length > 0,
  });
  const workspaceItemsByJobId = useMemo(
    () => new Map((projectWorkspaceItemsQuery.data ?? []).map((item) => [item.job.id, item])),
    [projectWorkspaceItemsQuery.data],
  );
  const currentSelectedOfferIdsByJobId = useMemo(
    () =>
      Object.fromEntries(
        projectJobs.map((job) => [job.id, selectedOfferOverrides[job.id] ?? job.selected_vendor_quote_offer_id ?? null]),
      ),
    [projectJobs, selectedOfferOverrides],
  );
  const optionsByJobId = useMemo(
    () =>
      Object.fromEntries(
        projectJobIds.map((jobId) => {
          const workspaceItem = workspaceItemsByJobId.get(jobId);

          if (!workspaceItem?.part) {
            return [jobId, [] as ClientQuoteSelectionOption[]];
          }

          const requestedByDate =
            requestDraftsByJobId[jobId]?.requestedByDate ??
            workspaceItem.summary?.requestedByDate ??
            workspaceItem.job.requested_by_date ??
            null;
          const vendorLabels = buildVendorLabelMap(workspaceItem.part.vendorQuotes.map((quote) => quote.vendor));

          return [
            jobId,
            sortQuoteOptionsForPreset(
              buildClientQuoteSelectionOptions({
                vendorQuotes: workspaceItem.part.vendorQuotes,
                requestedByDate,
                excludedVendorKeys: excludedVendorKeysByJobId[jobId] ?? [],
                vendorLabels,
              }),
              "cheapest",
            ),
          ];
        }),
      ) as Record<string, ClientQuoteSelectionOption[]>,
    [excludedVendorKeysByJobId, projectJobIds, requestDraftsByJobId, workspaceItemsByJobId],
  );
  const selectedOptionsByJobId = useMemo(
    () =>
      Object.fromEntries(
        projectJobIds.map((jobId) => [
          jobId,
          getSelectedOption(optionsByJobId[jobId] ?? [], currentSelectedOfferIdsByJobId[jobId]),
        ]),
      ) as Record<string, ClientQuoteSelectionOption | null>,
    [currentSelectedOfferIdsByJobId, optionsByJobId, projectJobIds],
  );
  const projectSelectionSummary = useMemo(
    () => summarizeSelectedQuoteOptions(projectJobIds.map((jobId) => selectedOptionsByJobId[jobId])),
    [projectJobIds, selectedOptionsByJobId],
  );

  const filteredJobs = useMemo(
    () =>
      projectJobs.filter(
        (job) => matchesJobFilter(job.status, activeFilter) && matchesClientJobSearch(job, search),
      ),
    [activeFilter, projectJobs, search],
  );

  useEffect(() => {
    if (filteredJobs.length === 0) {
      setFocusedJobId(null);
      return;
    }

    if (!focusedJobId || !filteredJobs.some((job) => job.id === focusedJobId)) {
      setFocusedJobId(filteredJobs[0].id);
    }
  }, [filteredJobs, focusedJobId]);

  const focusedJob = useMemo(
    () => filteredJobs.find((job) => job.id === focusedJobId) ?? null,
    [filteredJobs, focusedJobId],
  );
  const focusedWorkspaceItem = focusedJob ? workspaceItemsByJobId.get(focusedJob.id) ?? null : null;
  const focusedSummary = focusedWorkspaceItem?.summary ?? (focusedJob ? summariesByJobId.get(focusedJob.id) ?? null : null);
  const focusedSelectedOption = focusedJob ? selectedOptionsByJobId[focusedJob.id] ?? null : null;
  const focusedQuoteOptions = focusedJob ? optionsByJobId[focusedJob.id] ?? [] : [];
  const sharedRequestSummary = useMemo(
    () => getSharedRequestMetadata(projectJobs.map((job) => summariesByJobId.get(job.id) ?? null)),
    [projectJobs, summariesByJobId],
  );
  const projectSummary = accessibleProjectsQuery.data?.find((project) => project.project.id === projectId) ?? null;
  const canRenameProject = !isSeededProject && ["owner", "editor"].includes(projectSummary?.currentUserRole ?? "editor");
  const canArchiveProject = canRenameProject;
  const canDissolveProject = !isSeededProject && (projectSummary?.currentUserRole ?? "editor") === "owner";
  const canManageMembers = canDissolveProject;

  useEffect(() => {
    if ((projectWorkspaceItemsQuery.data ?? []).length === 0) {
      return;
    }

    setExcludedVendorKeysByJobId((current) => {
      const next = { ...current };

      projectWorkspaceItemsQuery.data?.forEach((item) => {
        next[item.job.id] = readExcludedVendorKeys(item.job.id);
      });

      return next;
    });

    setRequestDraftsByJobId((current) => {
      const next = { ...current };

      projectWorkspaceItemsQuery.data?.forEach((item) => {
        if (!item.part) {
          return;
        }

        const requirement = buildRequirementDraft(item.part, {
          requested_quote_quantities: item.job.requested_quote_quantities ?? [],
          requested_by_date: item.job.requested_by_date ?? null,
        });

        next[item.job.id] = {
          jobId: item.job.id,
          description: requirement.description ?? null,
          partNumber: requirement.partNumber ?? null,
          revision: requirement.revision ?? null,
          material: requirement.material,
          finish: requirement.finish ?? null,
          tightestToleranceInch: requirement.tightestToleranceInch ?? null,
          process: requirement.process ?? null,
          notes: requirement.notes ?? null,
          quantity: requirement.quantity,
          requestedQuoteQuantities: requirement.quoteQuantities,
          requestedByDate: requirement.requestedByDate ?? null,
        };
      });

      return next;
    });

    setQuoteQuantityInputsByJobId((current) => {
      const next = { ...current };

      projectWorkspaceItemsQuery.data?.forEach((item) => {
        if (!item.part) {
          return;
        }

        const requirement = buildRequirementDraft(item.part, {
          requested_quote_quantities: item.job.requested_quote_quantities ?? [],
          requested_by_date: item.job.requested_by_date ?? null,
        });

        next[item.job.id] = formatRequestedQuoteQuantitiesInput(requirement.quoteQuantities);
      });

      return next;
    });
  }, [projectWorkspaceItemsQuery.data]);

  const updateProjectMutation = useMutation({
    mutationFn: (name: string) => updateProject({ projectId, name }),
    onSuccess: async () => {
      toast.success("Project updated.");
      setShowRename(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
      ]);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update project.");
    },
  });
  const archiveProjectMutation = useMutation({
    mutationFn: () => archiveProject(projectId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["client-ungrouped-parts"] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
        queryClient.invalidateQueries({ queryKey: ["client-project-job-memberships"] }),
        queryClient.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["archived-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["archived-jobs"] }),
      ]);
      registerArchiveUndo({
        label: "Project",
        undo: async () => {
          await unarchiveProject(projectId);
          await invalidateSidebarQueries();
        },
      });
      toast.success("Project archived. Press Ctrl+Z to undo.");
      navigate("/");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to archive project.");
    },
  });
  const syncDmriflesProjectsMutation = useMutation({
    mutationFn: async () =>
      syncImportedBatchProjects({
        jobs: accessibleJobsQuery.data ?? [],
        partSummariesByJobId: summariesByJobId,
        projects: (accessibleProjectsQuery.data ?? []).map((project) => ({
          id: project.project.id,
          name: project.project.name,
        })),
        resolveProjectIdsForJob: (jobId: string) => sidebarProjectIdsByJobId.get(jobId) ?? [],
      }),
    onSuccess: async (mutated) => {
      setHasAttemptedDmriflesProjectSync(true);

      if (!mutated) {
        return;
      }

      await invalidateSidebarQueries();
    },
    onError: () => {
      setHasAttemptedDmriflesProjectSync(true);
    },
  });
  const dissolveProjectMutation = useMutation({
    mutationFn: () => dissolveProject(projectId),
    onSuccess: async () => {
      toast.success("Project dissolved.");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
        queryClient.invalidateQueries({ queryKey: ["client-ungrouped-parts"] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
        queryClient.invalidateQueries({ queryKey: ["client-project-job-memberships"] }),
        queryClient.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["archived-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["archived-jobs"] }),
      ]);
      navigate("/");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to dissolve project.");
    },
  });
  const removeProjectMemberMutation = useMutation({
    mutationFn: removeProjectMember,
    onSuccess: async () => {
      toast.success("Member removed.");
      await queryClient.invalidateQueries({ queryKey: ["project-memberships", projectId] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to remove member.");
    },
  });
  const saveRequestMutation = useMutation({
    mutationFn: (input: ClientPartRequestUpdateInput) => updateClientPartRequest(input),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-quote-workspace", projectJobIds] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
        queryClient.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
      ]);
      toast.success("Line item updated.");
    },
    onError: (error: Error) => {
      toast.error(error.message || "Failed to update line item.");
    },
  });

  const resolveSidebarProjectIdsForJob = (job: { id: string; project_id: string | null; source: string }) => {
    const projectIds = [...new Set([...(sidebarProjectIdsByJobId.get(job.id) ?? []), ...(job.project_id ? [job.project_id] : [])])];

    if (!isDmriflesWorkspace) {
      return projectIds;
    }

    const importedBatch = resolveImportedBatch(job, summariesByJobId.get(job.id));
    if (!importedBatch) {
      return projectIds;
    }

    const importedBatchProjectId =
      findImportedBatchProjectId(importedBatch, remoteProjects) ?? buildSeedProjectId(importedBatch);
    return [...new Set([...projectIds, importedBatchProjectId])];
  };

  const invalidateSidebarQueries = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
      queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
      queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
      queryClient.invalidateQueries({ queryKey: ["client-project-job-memberships"] }),
      queryClient.invalidateQueries({ queryKey: ["client-ungrouped-parts"] }),
      queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] }),
      queryClient.invalidateQueries({ queryKey: ["project-jobs"] }),
      queryClient.invalidateQueries({ queryKey: ["project"] }),
      queryClient.invalidateQueries({ queryKey: ["part-detail"] }),
      queryClient.invalidateQueries({ queryKey: ["archived-projects"] }),
      queryClient.invalidateQueries({ queryKey: ["archived-jobs"] }),
    ]);
  };

  const handlePinProject = async (targetProjectId: string) => {
    try {
      await pinProject(targetProjectId);
      await queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to pin project.");
      throw error;
    }
  };

  const handleUnpinProject = async (targetProjectId: string) => {
    try {
      await unpinProject(targetProjectId);
      await queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to unpin project.");
      throw error;
    }
  };

  const handlePinPart = async (jobId: string) => {
    try {
      await pinJob(jobId);
      await queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to pin part.");
      throw error;
    }
  };

  const handleUnpinPart = async (jobId: string) => {
    try {
      await unpinJob(jobId);
      await queryClient.invalidateQueries({ queryKey: ["sidebar-pins"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to unpin part.");
      throw error;
    }
  };

  const handleAssignPartToProject = async (jobId: string, targetProjectId: string) => {
    try {
      await assignJobToProject({ jobId, projectId: targetProjectId });
      await invalidateSidebarQueries();
      toast.success("Part moved to project.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to move part.");
      throw error;
    }
  };

  const handleRemovePartFromProject = async (jobId: string, targetProjectId: string) => {
    try {
      await removeJobFromProject(jobId, targetProjectId);
      await invalidateSidebarQueries();
      toast.success("Part removed from project.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove part.");
      throw error;
    }
  };

  const handleRenameProject = async (targetProjectId: string, name: string) => {
    try {
      await updateProject({ projectId: targetProjectId, name });
      if (targetProjectId === projectId) {
        setProjectName(name);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
        queryClient.invalidateQueries({ queryKey: ["project", targetProjectId] }),
      ]);
      toast.success("Project updated.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update project.");
      throw error;
    }
  };

  const handleArchivePart = async (targetJobId: string) => {
    try {
      await archiveJob(targetJobId);
      await invalidateSidebarQueries();
      registerArchiveUndo({
        label: "Part",
        undo: async () => {
          await unarchiveJob(targetJobId);
          await invalidateSidebarQueries();
        },
      });
      toast.success("Part archived. Press Ctrl+Z to undo.");
      if (targetJobId === focusedJobId) {
        setFocusedJobId(null);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to archive part.");
      throw error;
    }
  };

  const handleArchiveProject = async (targetProjectId: string) => {
    try {
      if (targetProjectId.startsWith("seed-")) {
        const batchJobs =
          buildDmriflesProjects(accessibleJobsQuery.data ?? [], summariesByJobId).find((project) => project.id === targetProjectId)?.jobIds ?? [];

        await Promise.all(batchJobs.map((jobId) => archiveJob(jobId)));
        await invalidateSidebarQueries();
        registerArchiveUndo({
          label: "Project",
          undo: async () => {
            await Promise.all(batchJobs.map((jobId) => unarchiveJob(jobId)));
            await invalidateSidebarQueries();
          },
        });
        toast.success("Project archived. Press Ctrl+Z to undo.");
        if (targetProjectId === projectId) {
          navigate("/");
        }
        return;
      }

      await archiveProject(targetProjectId);
      await invalidateSidebarQueries();
      registerArchiveUndo({
        label: "Project",
        undo: async () => {
          await unarchiveProject(targetProjectId);
          await invalidateSidebarQueries();
        },
      });
      toast.success("Project archived. Press Ctrl+Z to undo.");
      if (targetProjectId === projectId) {
        navigate("/");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to archive project.");
      throw error;
    }
  };

  const handleUnarchivePart = async (targetJobId: string) => {
    try {
      await unarchiveJob(targetJobId);
      await invalidateSidebarQueries();
      toast.success("Part restored.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to unarchive part.");
      throw error;
    }
  };

  const handleDeleteArchivedPart = async (targetJobId: string) => {
    try {
      await deleteArchivedJob(targetJobId);
      await invalidateSidebarQueries();
      toast.success("Archived part deleted.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete archived part.");
      throw error;
    }
  };

  const handleDissolveProject = async (targetProjectId: string) => {
    try {
      await dissolveProject(targetProjectId);
      await invalidateSidebarQueries();
      toast.success("Project dissolved.");
      if (targetProjectId === projectId) {
        navigate("/");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to dissolve project.");
      throw error;
    }
  };

  const handleCreateProjectFromSelection = async (jobIds: string[]) => {
    try {
      const labels = jobIds
        .map((selectedJobId) => {
          const job = accessibleJobsById.get(selectedJobId);
          return job ? getClientItemPresentation(job, summariesByJobId.get(selectedJobId)).title : null;
        })
        .filter((label): label is string => Boolean(label));
      const nextProjectId = await createProject({
        name: buildProjectNameFromLabels(labels),
      });

      await Promise.all(
        jobIds.map((selectedJobId) => assignJobToProject({ jobId: selectedJobId, projectId: nextProjectId })),
      );
      await invalidateSidebarQueries();
      toast.success("Project created.");
      navigate(`/projects/${nextProjectId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to create project.");
      throw error;
    }
  };

  const handleOpenJobDrawer = (jobId: string) => {
    setFocusedJobId(jobId);

    if (isMobile) {
      setMobileDrawerOpen(true);
    }
  };

  const handleToggleVendorExclusion = (jobId: string, vendorKey: VendorName, shouldExclude: boolean) => {
    setExcludedVendorKeysByJobId((current) => ({
      ...current,
      [jobId]: toggleExcludedVendorKey(jobId, vendorKey, shouldExclude),
    }));
  };

  const handleSelectQuoteOption = async (jobId: string, option: ClientQuoteSelectionOption) => {
    if (!option.persistedOfferId) {
      toast.error("This quote option is not ready to select yet.");
      return;
    }

    const previousOfferId = currentSelectedOfferIdsByJobId[jobId] ?? null;

    setSelectedOfferOverrides((current) => ({
      ...current,
      [jobId]: option.persistedOfferId,
    }));

    try {
      await setJobSelectedVendorQuoteOffer(jobId, option.persistedOfferId);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-quote-workspace", projectJobIds] }),
        queryClient.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
      ]);
    } catch (error) {
      setSelectedOfferOverrides((current) => ({
        ...current,
        [jobId]: previousOfferId,
      }));
      toast.error(error instanceof Error ? error.message : "Failed to update selected quote.");
    }
  };

  const handleBulkPreset = async (preset: QuotePreset) => {
    const result = applyBulkPresetSelection({
      optionsByJobId,
      currentSelectedOfferIdsByJobId,
      preset,
    });

    if (result.changes.length === 0) {
      toast.error(
        result.unavailableJobIds.length > 0
          ? "No eligible project quotes were available for that preset."
          : "Selections already match this preset.",
      );
      return;
    }

    setSelectedOfferOverrides((current) => ({
      ...current,
      ...Object.fromEntries(result.changes.map((change) => [change.jobId, change.appliedOfferId])),
    }));
    setLastBulkAction(result.changes);

    try {
      await Promise.all(
        result.changes.map((change) => setJobSelectedVendorQuoteOffer(change.jobId, change.appliedOfferId)),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-quote-workspace", projectJobIds] }),
        queryClient.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
      ]);
      toast.success(
        `${preset === "cheapest" ? "Cheapest" : preset === "fastest" ? "Fastest" : "Domestic"} preset applied to ${result.changes.length} part${result.changes.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      setSelectedOfferOverrides((current) => ({
        ...current,
        ...Object.fromEntries(result.changes.map((change) => [change.jobId, change.previousOfferId])),
      }));
      toast.error(error instanceof Error ? error.message : "Bulk preset failed.");
    }
  };

  const handleRevertBulk = async () => {
    if (lastBulkAction.length === 0) {
      return;
    }

    const result = revertBulkPresetSelection({
      currentSelectedOfferIdsByJobId,
      lastBulkAction,
    });

    if (result.restoredJobIds.length === 0) {
      toast.error("Nothing could be restored from the last bulk action.");
      return;
    }

    setSelectedOfferOverrides((current) => ({
      ...current,
      ...Object.fromEntries(
        result.restoredJobIds.map((jobId) => [jobId, result.nextSelectedOfferIdsByJobId[jobId] ?? null]),
      ),
    }));

    try {
      await Promise.all(
        result.restoredJobIds.map((jobId) =>
          setJobSelectedVendorQuoteOffer(jobId, result.nextSelectedOfferIdsByJobId[jobId] ?? null),
        ),
      );
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["client-quote-workspace", projectJobIds] }),
        queryClient.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
        queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
      ]);
      setLastBulkAction([]);
      toast.success("Bulk selection reverted.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to revert bulk selection.");
    }
  };

  const handleRequestDraftChange = (
    jobId: string,
    next: Partial<ClientPartRequestUpdateInput>,
  ) => {
    setRequestDraftsByJobId((current) => {
      const existing = current[jobId];

      if (!existing) {
        return current;
      }

      return {
        ...current,
        [jobId]: {
          ...existing,
          ...next,
        },
      };
    });
  };

  const handleQuoteQuantityInputChange = (jobId: string, value: string) => {
    setQuoteQuantityInputsByJobId((current) => ({
      ...current,
      [jobId]: value,
    }));
  };

  const handleSaveRequest = (jobId: string) => {
    const draft = requestDraftsByJobId[jobId];

    if (!draft) {
      return;
    }

    const requestedQuoteQuantities = parseRequestedQuoteQuantitiesInput(
      quoteQuantityInputsByJobId[jobId] ?? "",
      draft.quantity,
    );
    const nextDraft = {
      ...draft,
      requestedQuoteQuantities,
    } satisfies ClientPartRequestUpdateInput;

    setRequestDraftsByJobId((current) => ({
      ...current,
      [jobId]: nextDraft,
    }));
    setQuoteQuantityInputsByJobId((current) => ({
      ...current,
      [jobId]: formatRequestedQuoteQuantitiesInput(requestedQuoteQuantities),
    }));
    saveRequestMutation.mutate(nextDraft);
  };

  useEffect(() => {
    if (projectQuery.data) {
      setProjectName(projectQuery.data.name);
    }
  }, [projectQuery.data]);

  useEffect(() => {
    if (!redirectedSeedProjectId) {
      return;
    }

    navigate(`/projects/${redirectedSeedProjectId}`, { replace: true });
  }, [navigate, redirectedSeedProjectId]);

  useEffect(() => {
    if (
      !user ||
      !isDmriflesWorkspace ||
      projectCollaborationUnavailable ||
      hasAttemptedDmriflesProjectSync ||
      syncDmriflesProjectsMutation.isPending ||
      accessibleProjectsQuery.isLoading ||
      accessibleJobsQuery.isLoading ||
      partSummariesQuery.isLoading
    ) {
      return;
    }

    syncDmriflesProjectsMutation.mutate();
  }, [
    accessibleJobsQuery.isLoading,
    accessibleProjectsQuery.isLoading,
    hasAttemptedDmriflesProjectSync,
    isDmriflesWorkspace,
    partSummariesQuery.isLoading,
    projectCollaborationUnavailable,
    syncDmriflesProjectsMutation,
    user,
  ]);

  useEffect(() => {
    if (!user) {
      navigate("/?auth=signin", { replace: true });
    }
  }, [navigate, user]);

  const focusedDraft = focusedJob ? requestDraftsByJobId[focusedJob.id] ?? null : null;
  const focusedQuoteQuantityInput = focusedJob ? quoteQuantityInputsByJobId[focusedJob.id] ?? "" : "";
  const focusedActivityEntries = useMemo<ActivityLogEntry[]>(() => {
    if (!focusedWorkspaceItem) {
      return [];
    }

    return [
      {
        id: "parsing",
        label: "Parsing drawing notes",
        detail: focusedWorkspaceItem.part?.drawingFile
          ? `Drawing ${focusedWorkspaceItem.part.drawingFile.original_name} attached for ${focusedWorkspaceItem.job.title}.`
          : "No drawing PDF is attached to this line item.",
        tone: focusedWorkspaceItem.part?.drawingFile ? "active" : "attention",
      },
      {
        id: "matching",
        label: "Matching vendor options",
        detail:
          focusedQuoteOptions.length > 0
            ? `${focusedQuoteOptions.length} quote option${focusedQuoteOptions.length === 1 ? "" : "s"} available for review.`
            : "No quote options available for this line item yet.",
        tone: focusedQuoteOptions.length > 0 ? "active" : "attention",
      },
      {
        id: "selection",
        label: "Ranking cheapest eligible quotes",
        detail: focusedSelectedOption
          ? `${focusedSelectedOption.vendorLabel} selected at ${formatCurrency(focusedSelectedOption.totalPriceUsd)} total.`
          : "No quote has been selected for this line item.",
        tone: focusedSelectedOption ? "active" : "attention",
      },
    ];
  }, [focusedQuoteOptions.length, focusedSelectedOption, focusedWorkspaceItem]);

  const renderDetailDrawer = () => {
    if (!focusedJob || !focusedWorkspaceItem) {
      return (
        <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5 text-sm text-white/45">
          Select a line item to inspect quotes, files, and extracted metadata.
        </div>
      );
    }

    const focusedPresentation = getClientItemPresentation(focusedJob, focusedSummary);

    return (
      <div className="space-y-4">
        <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">Line item</p>
          <p className="mt-2 text-xl font-semibold text-white">{focusedPresentation.title}</p>
          <p className="mt-2 text-sm text-white/55">{focusedPresentation.description}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Badge className="border border-white/10 bg-white/6 text-white/70">
              {formatStatusLabel(focusedJob.status)}
            </Badge>
            {focusedSelectedOption ? (
              <Badge className="border border-emerald-400/20 bg-emerald-500/10 text-emerald-100">
                {focusedSelectedOption.vendorLabel}
              </Badge>
            ) : null}
          </div>
          <RequestSummaryBadges
            quantity={focusedDraft?.quantity ?? focusedSummary?.quantity ?? null}
            requestedQuoteQuantities={
              parseRequestedQuoteQuantitiesInput(
                focusedQuoteQuantityInput,
                focusedDraft?.quantity ?? focusedSummary?.quantity ?? 1,
              )
            }
            requestedByDate={focusedDraft?.requestedByDate ?? focusedSummary?.requestedByDate ?? null}
            className="mt-4"
          />
        </div>

        <ClientDrawingPreviewPanel
          drawingFile={focusedWorkspaceItem.part?.drawingFile ?? null}
          drawingPreview={focusedWorkspaceItem.drawingPreview}
        />
        <ClientCadPreviewPanel cadFile={focusedWorkspaceItem.part?.cadFile ?? null} />

        <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
          <p className="text-xs uppercase tracking-[0.18em] text-white/35">Quote options</p>
          <div className="mt-4 space-y-3">
            {focusedQuoteOptions.length === 0 ? (
              <p className="text-sm text-white/45">No quote options available for this line item.</p>
            ) : (
              focusedQuoteOptions.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => {
                    void handleSelectQuoteOption(focusedJob.id, option);
                  }}
                  className={cn(
                    "block w-full rounded-2xl border px-4 py-3 text-left transition",
                    focusedSelectedOption?.key === option.key
                      ? "border-emerald-500/30 bg-emerald-500/10"
                      : "border-white/8 bg-black/20 hover:bg-white/4",
                  )}
                  disabled={!option.isSelectable}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-white">{option.vendorLabel}</p>
                      <p className="mt-1 text-xs text-white/45">
                        Qty {option.requestedQuantity} ·{" "}
                        {option.resolvedDeliveryDate ?? formatLeadTime(option.leadTimeBusinessDays)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-white">{formatCurrency(option.totalPriceUsd)}</p>
                      <Button
                        type="button"
                        variant="ghost"
                        className="mt-1 h-auto p-0 text-xs text-white/60 hover:bg-transparent hover:text-white"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleToggleVendorExclusion(focusedJob.id, option.vendorKey, !option.excluded);
                        }}
                      >
                        {option.excluded ? "Include vendor" : "Exclude vendor"}
                      </Button>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {focusedDraft ? (
          <div className="rounded-[26px] border border-white/8 bg-[#262626] p-5">
            <p className="text-xs uppercase tracking-[0.18em] text-white/35">Metadata and RFQ details</p>
            <div className="mt-4">
              <ClientPartRequestEditor
                draft={focusedDraft}
                quoteQuantityInput={focusedQuoteQuantityInput}
                onQuoteQuantityInputChange={(value) => handleQuoteQuantityInputChange(focusedJob.id, value)}
                onChange={(next) => handleRequestDraftChange(focusedJob.id, next)}
                onSave={() => handleSaveRequest(focusedJob.id)}
                onUploadRevision={attachFilesPicker.openFilePicker}
                isSaving={saveRequestMutation.isPending}
              />
            </div>
          </div>
        ) : null}

        <ActivityLog entries={focusedActivityEntries} />
      </div>
    );
  };

  if (!user) {
    return null;
  }

  return (
    <>
      <ChatWorkspaceLayout
        onLogoClick={() => navigate("/")}
        sidebarRailActions={[
          { label: "New Job", icon: PlusSquare, onClick: newJobFilePicker.openFilePicker },
          { label: "Search", icon: SearchIcon, onClick: () => setIsSearchOpen(true) },
        ]}
        sidebarContent={
          <WorkspaceSidebar
            projects={sidebarProjects}
            jobs={accessibleJobsQuery.data ?? []}
            summariesByJobId={summariesByJobId}
            activeProjectId={projectId}
            onCreateJob={newJobFilePicker.openFilePicker}
            onCreateProject={projectCollaborationUnavailable ? undefined : newJobFilePicker.openFilePicker}
            onSearch={() => setIsSearchOpen(true)}
            storageScopeKey={user?.id}
            pinnedProjectIds={sidebarPinsQuery.data?.projectIds ?? []}
            pinnedJobIds={sidebarPinsQuery.data?.jobIds ?? []}
            onPinProject={handlePinProject}
            onUnpinProject={handleUnpinProject}
            onPinPart={handlePinPart}
            onUnpinPart={handleUnpinPart}
            onAssignPartToProject={isDmriflesWorkspace ? undefined : handleAssignPartToProject}
            onRemovePartFromProject={isDmriflesWorkspace ? undefined : handleRemovePartFromProject}
            onCreateProjectFromSelection={projectCollaborationUnavailable ? undefined : handleCreateProjectFromSelection}
            onRenameProject={handleRenameProject}
            onArchivePart={handleArchivePart}
            onArchiveProject={handleArchiveProject}
            onDissolveProject={handleDissolveProject}
            onSelectProject={(nextProjectId) => navigate(`/projects/${nextProjectId}`)}
            onSelectPart={(jobId) => navigate(`/parts/${jobId}`)}
            resolveProjectIdsForJob={resolveSidebarProjectIdsForJob}
          />
        }
        sidebarFooter={
          <WorkspaceAccountMenu
            user={user}
            activeMembership={activeMembership}
            onSignOut={signOut}
            onSignedOut={() => navigate("/", { replace: true })}
            archivedProjects={archivedProjectsQuery.data}
            archivedJobs={archivedJobsQuery.data}
            isArchiveLoading={archivedProjectsQuery.isLoading || archivedJobsQuery.isLoading}
            onUnarchivePart={handleUnarchivePart}
            onDeleteArchivedPart={handleDeleteArchivedPart}
          />
        }
      >
        <div className="mx-auto flex w-full max-w-[1380px] flex-1 flex-col gap-6 px-6 pb-10 pt-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] text-white/35">Project workspace</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">
                {seededProject?.name ?? projectQuery.data?.name ?? "Project"}
              </h1>
              <p className="mt-2 text-sm text-white/55">
                {isSeededProject
                  ? "Read-only imported batch project."
                  : "Dense procurement workspace tuned for fast quote selection."}
              </p>
              {sharedRequestSummary ? (
                <RequestSummaryBadges
                  quantity={sharedRequestSummary.requestedQuoteQuantities[0] ?? null}
                  requestedQuoteQuantities={sharedRequestSummary.requestedQuoteQuantities}
                  requestedByDate={sharedRequestSummary.requestedByDate}
                  className="mt-4"
                />
              ) : null}
            </div>

            <div className="flex flex-wrap gap-2">
              {!isSeededProject && !projectCollaborationUnavailable ? (
                <Button type="button" className="rounded-full" onClick={() => setShowAddPart(true)}>
                  <FolderPlus className="mr-2 h-4 w-4" />
                  Add part
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                onClick={() => handleBulkPreset("cheapest")}
              >
                Cheapest
              </Button>
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                onClick={() => handleBulkPreset("fastest")}
              >
                Fastest
              </Button>
              <Button
                type="button"
                variant="outline"
                className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                onClick={() => handleBulkPreset("domestic")}
              >
                Domestic
              </Button>
              {lastBulkAction.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                  onClick={() => {
                    void handleRevertBulk();
                  }}
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Revert bulk
                </Button>
              ) : null}
              <Button type="button" className="rounded-full" onClick={() => navigate(`/projects/${projectId}/review`)}>
                Review order
                <MoveRight className="ml-2 h-4 w-4" />
              </Button>
              {canManageMembers ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                    onClick={() => setShowMembers(true)}
                  >
                    <Users className="mr-2 h-4 w-4" />
                    Members
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                    onClick={() => setShowRename(true)}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    Rename
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-full border-white/10 bg-transparent text-white hover:bg-white/6"
                    onClick={() => setShowArchive(true)}
                  >
                    <Archive className="mr-2 h-4 w-4" />
                    Archive
                  </Button>
                </>
              ) : null}
              {canDissolveProject ? (
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full border-white/10 bg-transparent text-white hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setShowDissolve(true)}
                >
                  Dissolve
                </Button>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 md:grid-cols-4">
            <div className="rounded-[22px] border border-white/8 bg-[#262626] px-4 py-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Selected total</p>
              <p className="mt-2 text-2xl font-semibold text-white">{formatCurrency(projectSelectionSummary.totalPriceUsd)}</p>
            </div>
            <div className="rounded-[22px] border border-white/8 bg-[#262626] px-4 py-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Selected lines</p>
              <p className="mt-2 text-2xl font-semibold text-white">
                {projectSelectionSummary.selectedCount}/{projectJobs.length}
              </p>
            </div>
            <div className="rounded-[22px] border border-white/8 bg-[#262626] px-4 py-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Domestic</p>
              <p className="mt-2 text-2xl font-semibold text-white">{projectSelectionSummary.domesticCount}</p>
            </div>
            <div className="rounded-[22px] border border-white/8 bg-[#262626] px-4 py-4">
              <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Foreign / unknown</p>
              <p className="mt-2 text-2xl font-semibold text-white">
                {projectSelectionSummary.foreignCount + projectSelectionSummary.unknownCount}
              </p>
            </div>
          </div>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className="space-y-4">
              <div className="flex flex-col gap-3 rounded-[26px] border border-white/8 bg-[#262626] p-4">
                <div className="flex flex-col gap-3 md:flex-row">
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Search parts in this project"
                    className="border-white/10 bg-[#1f1f1f] text-white placeholder:text-white/35"
                  />
                  <div className="flex flex-wrap gap-2">
                    {clientFilterOptions.map((option) => (
                      <Button
                        key={option.id}
                        type="button"
                        variant={activeFilter === option.id ? "default" : "outline"}
                        className={cn(
                          "rounded-full border-white/10",
                          activeFilter === option.id
                            ? "bg-white text-black hover:bg-white/90"
                            : "bg-transparent text-white hover:bg-white/6",
                        )}
                        onClick={() => setActiveFilter(option.id)}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                </div>

                <p className="text-sm text-white/45">{filteredJobs.length} visible parts</p>
              </div>

              <div className="overflow-hidden rounded-[26px] border border-white/8 bg-[#262626]">
                {projectJobsQuery.isLoading || projectWorkspaceItemsQuery.isLoading ? (
                  <div className="flex min-h-[240px] items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-white/60" />
                  </div>
                ) : filteredJobs.length === 0 ? (
                  <div className="px-6 py-12 text-center text-white/45">No parts match this view.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow className="border-white/10 hover:bg-transparent">
                          <TableHead className="text-white/45">Part</TableHead>
                          <TableHead className="text-white/45">Rev</TableHead>
                          <TableHead className="text-white/45">Qty</TableHead>
                          <TableHead className="text-white/45">Process</TableHead>
                          <TableHead className="text-white/45">Material</TableHead>
                          <TableHead className="text-white/45">Finish</TableHead>
                          <TableHead className="text-white/45">Source</TableHead>
                          <TableHead className="text-white/45">Vendor</TableHead>
                          <TableHead className="text-white/45">Price</TableHead>
                          <TableHead className="text-white/45">Lead time</TableHead>
                          <TableHead className="text-white/45">Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredJobs.map((job) => {
                          const workspaceItem = workspaceItemsByJobId.get(job.id) ?? null;
                          const summary = workspaceItem?.summary ?? summariesByJobId.get(job.id) ?? null;
                          const draft = requestDraftsByJobId[job.id] ?? null;
                          const selectedOption = selectedOptionsByJobId[job.id] ?? null;
                          const presentation = getClientItemPresentation(job, summary);
                          const sourceIcon =
                            selectedOption?.domesticStatus === "domestic" ? (
                              <MapPin className="h-4 w-4 text-emerald-300" />
                            ) : (
                              <Globe2 className="h-4 w-4 text-sky-300" />
                            );

                          return (
                            <TableRow
                              key={job.id}
                              className={cn(
                                "cursor-pointer border-white/8 hover:bg-white/4",
                                focusedJobId === job.id && "bg-white/6",
                              )}
                              onClick={() => handleOpenJobDrawer(job.id)}
                            >
                              <TableCell className="min-w-[220px]">
                                <div className="flex items-center gap-3">
                                  <div className="h-10 w-10 overflow-hidden rounded-xl border border-white/10 bg-black/20">
                                    {workspaceItem?.drawingPreview.thumbnail ? (
                                      <div className="flex h-full items-center justify-center text-[10px] text-white/45">
                                        PDF
                                      </div>
                                    ) : (
                                      <div className="flex h-full items-center justify-center text-[10px] text-white/45">
                                        CAD
                                      </div>
                                    )}
                                  </div>
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-white">{presentation.title}</p>
                                    <p className="truncate text-xs text-white/45">{presentation.description}</p>
                                  </div>
                                </div>
                              </TableCell>
                              <TableCell className="text-white/70">{draft?.revision ?? summary?.revision ?? "—"}</TableCell>
                              <TableCell className="text-white/70">{draft?.quantity ?? summary?.quantity ?? "—"}</TableCell>
                              <TableCell className="text-white/70">{draft?.process ?? "—"}</TableCell>
                              <TableCell className="text-white/70">{draft?.material ?? "—"}</TableCell>
                              <TableCell className="text-white/70">{draft?.finish ?? "—"}</TableCell>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  {sourceIcon}
                                  <span className="text-white/70">
                                    {selectedOption?.domesticStatus === "domestic" ? "USA" : "Global"}
                                  </span>
                                </div>
                              </TableCell>
                              <TableCell className="text-white/70">{selectedOption?.vendorLabel ?? "Unselected"}</TableCell>
                              <TableCell className="text-white/70">{formatCurrency(selectedOption?.totalPriceUsd ?? null)}</TableCell>
                              <TableCell className="text-white/70">
                                {selectedOption
                                  ? selectedOption.resolvedDeliveryDate ?? formatLeadTime(selectedOption.leadTimeBusinessDays)
                                  : "—"}
                              </TableCell>
                              <TableCell>
                                <Badge className="border border-white/10 bg-white/6 text-white/70">
                                  {formatStatusLabel(job.status)}
                                </Badge>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </div>
            </div>

            {!isMobile ? <aside className="space-y-4">{renderDetailDrawer()}</aside> : null}
          </div>
        </div>
      </ChatWorkspaceLayout>

      <Sheet open={mobileDrawerOpen && Boolean(focusedJobId)} onOpenChange={setMobileDrawerOpen}>
        <SheetContent side="right" className="w-[min(96vw,38rem)] overflow-y-auto border-white/10 bg-[#1f1f1f] p-0 text-white sm:max-w-[38rem]">
          <SheetHeader className="border-b border-white/10 px-6 py-5">
            <SheetTitle className="text-white">Line item detail</SheetTitle>
            <SheetDescription className="text-white/55">
              Review previews, metadata, and quote options for the selected project row.
            </SheetDescription>
          </SheetHeader>
          <div className="px-6 py-5">{renderDetailDrawer()}</div>
        </SheetContent>
      </Sheet>

      <SearchPartsDialog
        open={isSearchOpen}
        onOpenChange={setIsSearchOpen}
        projects={sidebarProjects}
        jobs={accessibleJobsQuery.data ?? []}
        summariesByJobId={summariesByJobId}
        onSelectProject={(nextProjectId) => navigate(`/projects/${nextProjectId}`)}
        onSelectPart={(jobId) => navigate(`/parts/${jobId}`)}
      />

      <input
        ref={newJobFilePicker.inputRef}
        type="file"
        multiple
        accept={newJobFilePicker.accept}
        onChange={(event) => {
          void newJobFilePicker.handleFileInputChange(event);
        }}
        className="hidden"
        aria-label="Create new job from files"
      />
      <input
        ref={attachFilesPicker.inputRef}
        type="file"
        multiple
        accept={attachFilesPicker.accept}
        onChange={(event) => {
          void attachFilesPicker.handleFileInputChange(event);
        }}
        className="hidden"
        aria-label="Attach files to selected project line item"
      />

      <Dialog open={showAddPart} onOpenChange={setShowAddPart}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Add part</DialogTitle>
            <DialogDescription className="text-white/55">
              Create a new draft directly inside this project.
            </DialogDescription>
          </DialogHeader>
          <PromptComposer
            isSignedIn={Boolean(user)}
            onSubmit={async ({ prompt, files, clear }) => {
              const result =
                files.length > 0
                  ? await createJobsFromUploadFiles({
                      files,
                      prompt,
                      projectId: isSeededProject ? null : projectId,
                    })
                  : {
                      projectId: isSeededProject ? null : projectId,
                      jobIds: [
                        await (() => {
                          const requestIntake = parseRequestIntake(prompt);
                          return createClientDraft({
                            title: prompt.trim().split("\n")[0].slice(0, 120) || "Untitled part",
                            description: prompt.trim() || undefined,
                            projectId: isSeededProject ? undefined : projectId,
                            requestedQuoteQuantities: requestIntake.requestedQuoteQuantities,
                            requestedByDate: requestIntake.requestedByDate,
                          });
                        })(),
                      ],
                    };

              clear();
              setShowAddPart(false);
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ["project-jobs", projectId] }),
                queryClient.invalidateQueries({ queryKey: ["client-jobs"] }),
                queryClient.invalidateQueries({ queryKey: ["client-part-summaries"] }),
                queryClient.invalidateQueries({ queryKey: ["client-project-job-memberships"] }),
                queryClient.invalidateQueries({ queryKey: ["client-projects"] }),
              ]);
              if (result.projectId && result.jobIds.length > 1) {
                navigate(`/projects/${result.projectId}`);
                return;
              }

              navigate(`/parts/${result.jobIds[0]}`);
            }}
          />
        </DialogContent>
      </Dialog>

      <ProjectNameDialog
        open={showRename}
        onOpenChange={setShowRename}
        title="Rename project"
        description="Update the project name shown throughout this project workspace."
        value={projectName}
        onValueChange={setProjectName}
        submitLabel="Save"
        isPending={updateProjectMutation.isPending}
        isSubmitDisabled={projectName.trim().length === 0}
        onSubmit={() => updateProjectMutation.mutate(projectName.trim())}
      />

      <Dialog open={showArchive} onOpenChange={setShowArchive}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Archive project</DialogTitle>
            <DialogDescription className="text-white/55">
              Parts only in this project will also be archived.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => setShowArchive(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={archiveProjectMutation.isPending}
              onClick={() => archiveProjectMutation.mutate()}
            >
              {archiveProjectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Archive"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDissolve} onOpenChange={setShowDissolve}>
        <DialogContent className="border-white/10 bg-[#1f1f1f] text-white">
          <DialogHeader>
            <DialogTitle>Dissolve project</DialogTitle>
            <DialogDescription className="text-white/55">
              This deletes the project and leaves its parts in the main Parts list.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              className="border-white/10 bg-transparent text-white hover:bg-white/6"
              onClick={() => setShowDissolve(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={dissolveProjectMutation.isPending}
              onClick={() => dissolveProjectMutation.mutate()}
            >
              {dissolveProjectMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : "Dissolve"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProjectMembersDialog
        open={showMembers}
        onOpenChange={setShowMembers}
        currentUserId={user?.id ?? ""}
        memberships={projectMembershipsQuery.data ?? []}
        invites={projectInvitesQuery.data ?? []}
        canRename={canRenameProject}
        canDelete={canDissolveProject}
        onInvite={async (email) => {
          const invite = await inviteProjectMember({ projectId, email });
          toast.success(`Invite created for ${invite.email}.`);
          await queryClient.invalidateQueries({ queryKey: ["project-invites", projectId] });
        }}
        onRemoveMembership={async (membershipId) => {
          await removeProjectMemberMutation.mutateAsync(membershipId);
        }}
      />

    </>
  );
};

export default ClientProject;
