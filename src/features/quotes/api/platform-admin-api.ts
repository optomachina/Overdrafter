import type { AppRole, JobStatus } from "@/integrations/supabase/types";
import { callRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";

export type AdminOrganizationSummary = {
  id: string;
  name: string;
  slug: string;
  memberCount: number;
  activeJobCount: number;
  createdAt: string;
};

export type AdminUserSummary = {
  id: string;
  userId: string;
  email: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: AppRole;
  createdAt: string;
};

export type AdminJobSummary = {
  id: string;
  organizationId: string;
  organizationName: string;
  title: string;
  status: JobStatus;
  partCount: number;
  createdAt: string;
};

export type AdminProjectSummary = {
  id: string;
  organizationId: string;
  organizationName: string;
  name: string;
  ownerEmail: string | null;
  memberCount: number;
  jobCount: number;
  createdAt: string;
};

export async function fetchAdminOrganizations(): Promise<AdminOrganizationSummary[]> {
  const { data, error } = await callRpc("api_admin_list_organizations", {});
  return ensureData(data, error) as AdminOrganizationSummary[];
}

export async function fetchAdminAllUsers(): Promise<AdminUserSummary[]> {
  const { data, error } = await callRpc("api_admin_list_all_users", {});
  return ensureData(data, error) as AdminUserSummary[];
}

export async function fetchAdminAllJobs(): Promise<AdminJobSummary[]> {
  const { data, error } = await callRpc("api_admin_list_all_jobs", {});
  return ensureData(data, error) as AdminJobSummary[];
}

export async function fetchAdminAllProjects(): Promise<AdminProjectSummary[]> {
  const { data, error } = await callRpc("api_admin_list_all_projects", {});
  return ensureData(data, error) as AdminProjectSummary[];
}
