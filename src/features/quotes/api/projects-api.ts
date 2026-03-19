import { supabase } from "@/integrations/supabase/client";
import type {
  AccessibleProjectSummary,
  ArchivedProjectSummary,
  ProjectInviteRecord,
  ProjectInviteSummary,
  ProjectJobRecord,
  ProjectMembershipRecord,
  ProjectRecord,
  ProjectRole,
  SidebarPins,
  UserPinnedJobRecord,
  UserPinnedProjectRecord,
} from "@/features/quotes/types";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";
import { requireCurrentUser } from "./shared/auth";
import { callRpc, upsertUntyped } from "./shared/rpc";
import { ensureData } from "./shared/response";
import {
  isNoRowsError,
  isMissingFunctionError,
  isMissingProjectCollaborationSchemaError,
} from "./shared/schema-errors";
import {
  PROJECT_COLLABORATION_UNAVAILABLE_MESSAGE,
  PROJECT_NOT_FOUND_MESSAGE,
  isProjectCollaborationSchemaUnavailable,
  markProjectCollaborationSchemaAvailability,
} from "./shared/schema-runtime";
import { fetchJobsByIds } from "./jobs-api";

function ensureProjectCollaborationData<T>(data: T | null, error: { message: string } | null | undefined): T {
  if (isMissingProjectCollaborationSchemaError(error)) {
    markProjectCollaborationSchemaAvailability("unavailable");
    throw new Error(PROJECT_COLLABORATION_UNAVAILABLE_MESSAGE);
  }

  return ensureData(data, error);
}

async function createProjectViaEdgeFunction(input: {
  name: string;
  description?: string;
}): Promise<string> {
  const { data, error } = await supabase.functions.invoke("create-project-fallback", {
    body: {
      name: input.name,
      description: input.description ?? null,
    },
  });

  if (error) {
    if (error instanceof FunctionsHttpError && error.context instanceof Response) {
      let message = error.message;

      try {
        const body = (await error.context.clone().json()) as { error?: unknown; message?: unknown };
        message =
          typeof body.error === "string"
            ? body.error
            : typeof body.message === "string"
              ? body.message
              : error.message;
      } catch {
        // Ignore malformed edge-function error bodies and keep the original message.
      }

      throw new Error(message);
    }

    throw error;
  }

  if (!data || typeof data !== "object" || !("projectId" in data) || typeof data.projectId !== "string") {
    throw new Error("Expected a projectId from create-project-fallback.");
  }

  return data.projectId;
}

export function isProjectNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message === PROJECT_NOT_FOUND_MESSAGE;
}

export async function fetchProjectJobMembershipsByJobIds(jobIds: string[]): Promise<ProjectJobRecord[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchProjectJobMembershipsByJobIds(jobIds);
  }

  if (jobIds.length === 0 || isProjectCollaborationSchemaUnavailable()) {
    return [];
  }

  const { data, error } = await supabase.from("project_jobs").select("*").in("job_id", jobIds);

  if (isMissingProjectCollaborationSchemaError(error)) {
    markProjectCollaborationSchemaAvailability("unavailable");
    return [];
  }

  return ensureData(data, error) as ProjectJobRecord[];
}

export async function fetchAccessibleProjects(): Promise<AccessibleProjectSummary[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchAccessibleProjects();
  }

  if (isProjectCollaborationSchemaUnavailable()) {
    return [];
  }

  const currentUser = await requireCurrentUser();
  const { data: projectsData, error: projectsError } = await supabase
    .from("projects")
    .select("*")
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  if (isMissingProjectCollaborationSchemaError(projectsError)) {
    markProjectCollaborationSchemaAvailability("unavailable");
    return [];
  }

  const projects = ensureData(projectsData, projectsError) as ProjectRecord[];

  if (projects.length === 0) {
    markProjectCollaborationSchemaAvailability("available");
    return [];
  }

  const projectIds = projects.map((project) => project.id);
  const [membershipsResult, invitesResult, projectJobsResult] = await Promise.all([
    supabase
      .from("project_memberships")
      .select("*")
      .in("project_id", projectIds)
      .order("created_at", { ascending: true }),
    supabase
      .from("project_invites")
      .select("*")
      .in("project_id", projectIds)
      .order("created_at", { ascending: false }),
    supabase.from("project_jobs").select("*").in("project_id", projectIds),
  ]);

  if (
    isMissingProjectCollaborationSchemaError(membershipsResult.error) ||
    isMissingProjectCollaborationSchemaError(invitesResult.error)
  ) {
    markProjectCollaborationSchemaAvailability("unavailable");
    return [];
  }

  const memberships = ensureData(membershipsResult.data, membershipsResult.error) as ProjectMembershipRecord[];
  const invites = ensureData(invitesResult.data, invitesResult.error) as ProjectInviteRecord[];
  const projectJobs = ensureData(projectJobsResult.data, projectJobsResult.error) as ProjectJobRecord[];
  const projectJobIds = [...new Set(projectJobs.map((projectJob) => projectJob.job_id))];
  const activeJobs =
    projectJobIds.length === 0
      ? []
      : await fetchJobsByIds(projectJobIds, {
          archived: false,
        });
  const activeJobIdSet = new Set(activeJobs.map((job) => job.id));

  markProjectCollaborationSchemaAvailability("available");

  return projects.map((project) => {
    const projectMemberships = memberships.filter((membership) => membership.project_id === project.id);
    const currentMembership = projectMemberships.find((membership) => membership.user_id === currentUser.id);
    const partCount = projectJobs.filter(
      (projectJob) => projectJob.project_id === project.id && activeJobIdSet.has(projectJob.job_id),
    ).length;
    const inviteCount = invites.filter(
      (invite) => invite.project_id === project.id && invite.status === "pending",
    ).length;

    return {
      project,
      currentUserRole: currentMembership?.role ?? "owner",
      memberCount: projectMemberships.length,
      partCount,
      inviteCount,
    };
  });
}

export async function fetchArchivedProjects(): Promise<ArchivedProjectSummary[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchArchivedProjects();
  }

  if (isProjectCollaborationSchemaUnavailable()) {
    return [];
  }

  const currentUser = await requireCurrentUser();
  const { data: projectsData, error: projectsError } = await supabase
    .from("projects")
    .select("*")
    .not("archived_at", "is", null)
    .order("archived_at", { ascending: false });

  if (isMissingProjectCollaborationSchemaError(projectsError)) {
    markProjectCollaborationSchemaAvailability("unavailable");
    return [];
  }

  const projects = ensureData(projectsData, projectsError) as ProjectRecord[];

  if (projects.length === 0) {
    markProjectCollaborationSchemaAvailability("available");
    return [];
  }

  const projectIds = projects.map((project) => project.id);
  const [membershipsResult, projectJobsResult] = await Promise.all([
    supabase
      .from("project_memberships")
      .select("*")
      .in("project_id", projectIds)
      .order("created_at", { ascending: true }),
    supabase.from("project_jobs").select("*").in("project_id", projectIds),
  ]);

  if (isMissingProjectCollaborationSchemaError(membershipsResult.error)) {
    markProjectCollaborationSchemaAvailability("unavailable");
    return [];
  }

  const memberships = ensureData(membershipsResult.data, membershipsResult.error) as ProjectMembershipRecord[];
  const projectJobs = ensureData(projectJobsResult.data, projectJobsResult.error) as ProjectJobRecord[];

  markProjectCollaborationSchemaAvailability("available");

  return projects.map((project) => {
    const projectMemberships = memberships.filter((membership) => membership.project_id === project.id);
    const currentMembership = projectMemberships.find((membership) => membership.user_id === currentUser.id);

    return {
      project,
      currentUserRole: currentMembership?.role ?? "owner",
      partCount: projectJobs.filter((projectJob) => projectJob.project_id === project.id).length,
    };
  });
}

export async function fetchSidebarPins(): Promise<SidebarPins> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchSidebarPins();
  }

  const currentUser = await requireCurrentUser();
  const pinnedJobsRequest = supabase
    .from("user_pinned_jobs")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false });

  if (isProjectCollaborationSchemaUnavailable()) {
    const pinnedJobsResult = await pinnedJobsRequest;
    const pinnedJobs = ensureData(pinnedJobsResult.data, pinnedJobsResult.error) as UserPinnedJobRecord[];

    return {
      projectIds: [],
      jobIds: [...new Set(pinnedJobs.map((record) => record.job_id))],
    };
  }

  const [pinnedProjectsResult, pinnedJobsResult] = await Promise.all([
    supabase
      .from("user_pinned_projects")
      .select("*")
      .eq("user_id", currentUser.id)
      .order("created_at", { ascending: false }),
    pinnedJobsRequest,
  ]);

  if (isMissingProjectCollaborationSchemaError(pinnedProjectsResult.error)) {
    markProjectCollaborationSchemaAvailability("unavailable");
    const pinnedJobs = ensureData(pinnedJobsResult.data, pinnedJobsResult.error) as UserPinnedJobRecord[];

    return {
      projectIds: [],
      jobIds: [...new Set(pinnedJobs.map((record) => record.job_id))],
    };
  }

  const pinnedProjects = ensureData(
    pinnedProjectsResult.data,
    pinnedProjectsResult.error,
  ) as UserPinnedProjectRecord[];
  const pinnedJobs = ensureData(pinnedJobsResult.data, pinnedJobsResult.error) as UserPinnedJobRecord[];

  markProjectCollaborationSchemaAvailability("available");

  return {
    projectIds: [...new Set(pinnedProjects.map((record) => record.project_id))],
    jobIds: [...new Set(pinnedJobs.map((record) => record.job_id))],
  };
}

export async function pinProject(projectId: string): Promise<void> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.pinProject(projectId);
  }

  if (isProjectCollaborationSchemaUnavailable()) {
    throw new Error(PROJECT_COLLABORATION_UNAVAILABLE_MESSAGE);
  }

  const currentUser = await requireCurrentUser();
  const { error } = await upsertUntyped(
    "user_pinned_projects",
    {
      user_id: currentUser.id,
      project_id: projectId,
    },
    {
      onConflict: "user_id,project_id",
      ignoreDuplicates: true,
    },
  );

  if (error) {
    if (isMissingProjectCollaborationSchemaError(error)) {
      markProjectCollaborationSchemaAvailability("unavailable");
      throw new Error(PROJECT_COLLABORATION_UNAVAILABLE_MESSAGE);
    }

    throw error;
  }
}

export async function unpinProject(projectId: string): Promise<void> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.unpinProject(projectId);
  }

  if (isProjectCollaborationSchemaUnavailable()) {
    throw new Error(PROJECT_COLLABORATION_UNAVAILABLE_MESSAGE);
  }

  const currentUser = await requireCurrentUser();
  const { error } = await supabase
    .from("user_pinned_projects")
    .delete()
    .eq("user_id", currentUser.id)
    .eq("project_id", projectId);

  if (error) {
    if (isMissingProjectCollaborationSchemaError(error)) {
      markProjectCollaborationSchemaAvailability("unavailable");
      throw new Error(PROJECT_COLLABORATION_UNAVAILABLE_MESSAGE);
    }

    throw error;
  }
}

export async function pinJob(jobId: string): Promise<void> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.pinJob(jobId);
  }

  const currentUser = await requireCurrentUser();
  const { error } = await upsertUntyped(
    "user_pinned_jobs",
    {
      user_id: currentUser.id,
      job_id: jobId,
    },
    {
      onConflict: "user_id,job_id",
      ignoreDuplicates: true,
    },
  );

  if (error) {
    throw error;
  }
}

export async function unpinJob(jobId: string): Promise<void> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.unpinJob(jobId);
  }

  const currentUser = await requireCurrentUser();
  const { error } = await supabase
    .from("user_pinned_jobs")
    .delete()
    .eq("user_id", currentUser.id)
    .eq("job_id", jobId);

  if (error) {
    throw error;
  }
}

export async function fetchProject(projectId: string): Promise<ProjectRecord> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchProject(projectId);
  }

  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .is("archived_at", null)
    .maybeSingle();

  if (isNoRowsError(error) || (!error && data === null)) {
    throw new Error(PROJECT_NOT_FOUND_MESSAGE);
  }

  return ensureProjectCollaborationData(data, error) as ProjectRecord;
}

export async function fetchProjectMemberships(projectId: string): Promise<ProjectMembershipRecord[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchProjectMemberships(projectId);
  }

  const { data, error } = await supabase
    .from("project_memberships")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  return ensureProjectCollaborationData(data, error) as ProjectMembershipRecord[];
}

export async function fetchProjectInvites(projectId: string): Promise<ProjectInviteSummary[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchProjectInvites(projectId);
  }

  const { data, error } = await supabase
    .from("project_invites")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  const invites = ensureProjectCollaborationData(data, error) as ProjectInviteRecord[];

  return invites.map((invite) => ({
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: invite.status,
    token: invite.token,
    expiresAt: invite.expires_at,
    createdAt: invite.created_at,
  }));
}

export async function fetchJobsByProject(projectId: string) {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchJobsByProject(projectId);
  }

  const { data: membershipRows, error: membershipError } = await supabase
    .from("project_jobs")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  const memberships = ensureData(membershipRows, membershipError) as ProjectJobRecord[];

  if (memberships.length === 0) {
    return [];
  }

  return fetchJobsByIds(
    memberships.map((membership) => membership.job_id),
    {
      archived: false,
    },
  );
}

export async function createProject(input: {
  name: string;
  description?: string;
}): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.createProject(input);
  }

  if (isProjectCollaborationSchemaUnavailable()) {
    throw new Error(PROJECT_COLLABORATION_UNAVAILABLE_MESSAGE);
  }

  const { data, error } = await callRpc("api_create_project", {
    p_name: input.name,
    p_description: input.description ?? null,
  });

  if (!error) {
    markProjectCollaborationSchemaAvailability("available");
    return ensureData(data, null);
  }

  if (isMissingFunctionError(error, "api_create_project")) {
    if (!input.description) {
      const fallbackResult = await callRpc("api_create_project", {
        p_name: input.name,
      });

      if (!fallbackResult.error) {
        markProjectCollaborationSchemaAvailability("available");
        return ensureData(fallbackResult.data, null);
      }

      if (!isMissingFunctionError(fallbackResult.error, "api_create_project")) {
        return ensureProjectCollaborationData(fallbackResult.data, fallbackResult.error);
      }
    }

    try {
      const projectId = await createProjectViaEdgeFunction(input);
      markProjectCollaborationSchemaAvailability("available");
      return projectId;
    } catch (fallbackError) {
      if (isMissingProjectCollaborationSchemaError(fallbackError)) {
        markProjectCollaborationSchemaAvailability("unavailable");
        throw new Error(PROJECT_COLLABORATION_UNAVAILABLE_MESSAGE);
      }

      throw fallbackError;
    }
  }

  return ensureProjectCollaborationData(data, error);
}

export async function updateProject(input: {
  projectId: string;
  name: string;
  description?: string;
}): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.updateProject(input);
  }

  const { data, error } = await callRpc("api_update_project", {
    p_project_id: input.projectId,
    p_name: input.name,
    p_description: input.description ?? null,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function deleteProject(projectId: string): Promise<string> {
  const { data, error } = await callRpc("api_delete_project", {
    p_project_id: projectId,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function archiveProject(projectId: string): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.archiveProject(projectId);
  }

  const { data, error } = await callRpc("api_archive_project", {
    p_project_id: projectId,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function unarchiveProject(projectId: string): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.unarchiveProject(projectId);
  }

  const { data, error } = await callRpc("api_unarchive_project", {
    p_project_id: projectId,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function dissolveProject(projectId: string): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.dissolveProject(projectId);
  }

  const { data, error } = await callRpc("api_dissolve_project", {
    p_project_id: projectId,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function inviteProjectMember(input: {
  projectId: string;
  email: string;
  role?: ProjectRole;
}): Promise<ProjectInviteSummary> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.inviteProjectMember(input);
  }

  const { data, error } = await callRpc("api_invite_project_member", {
    p_project_id: input.projectId,
    p_email: input.email,
    p_role: input.role ?? "editor",
  });

  const invite = ensureProjectCollaborationData(data, error) as {
    id: string;
    email: string;
    role: ProjectRole;
    token: string;
    expiresAt: string;
  };

  return {
    id: invite.id,
    email: invite.email,
    role: invite.role,
    status: "pending",
    token: invite.token,
    expiresAt: invite.expiresAt,
    createdAt: new Date().toISOString(),
  };
}

export async function acceptProjectInvite(token: string): Promise<string> {
  const { data, error } = await callRpc("api_accept_project_invite", {
    p_token: token,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function removeProjectMember(projectMembershipId: string): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.removeProjectMember(projectMembershipId);
  }

  const { data, error } = await callRpc("api_remove_project_member", {
    p_project_membership_id: projectMembershipId,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function assignJobToProject(input: {
  jobId: string;
  projectId: string;
}): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.assignJobToProject(input);
  }

  const { data, error } = await callRpc("api_assign_job_to_project", {
    p_job_id: input.jobId,
    p_project_id: input.projectId,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function removeJobFromProject(jobId: string, projectId: string): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.removeJobFromProject(jobId, projectId);
  }

  const { data, error } = await callRpc("api_remove_job_from_project", {
    p_job_id: jobId,
    p_project_id: projectId,
  });

  return ensureProjectCollaborationData(data, error);
}
