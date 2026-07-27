import type { AppRole, JobStatus } from "@/integrations/supabase/types";
import { callRpc, callUntypedRpc } from "./shared/rpc";
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
  const { data, error } = await callRpc("api_admin_list_organizations");
  return ensureData(data, error) as AdminOrganizationSummary[];
}

export async function fetchAdminAllUsers(): Promise<AdminUserSummary[]> {
  const { data, error } = await callRpc("api_admin_list_all_users");
  return ensureData(data, error) as AdminUserSummary[];
}

export async function fetchAdminAllJobs(): Promise<AdminJobSummary[]> {
  const { data, error } = await callRpc("api_admin_list_all_jobs");
  return ensureData(data, error) as AdminJobSummary[];
}

export async function fetchAdminAllProjects(): Promise<AdminProjectSummary[]> {
  const { data, error } = await callRpc("api_admin_list_all_projects");
  return ensureData(data, error) as AdminProjectSummary[];
}

export type SpendSummary = {
  /** Start of the UTC calendar day the ceiling is enforced against. */
  since: string;
  totalSpendUsd: number;
  globalDailyCeilingUsd: number;
  perRunCeilingUsd: number;
  killSwitch: boolean;
  byCategory: Record<string, number>;
  byOrganization: Array<{
    organizationId: string | null;
    organizationName: string | null;
    spendUsd: number;
    dailyCeilingUsd: number | null;
  }>;
};

/**
 * Spend is observed and configured here, but enforced in the worker. A ceiling
 * the UI applied would only bound spending the UI initiated, which is not the
 * shape a runaway takes.
 */
export async function fetchSpendSummary(): Promise<SpendSummary> {
  // Untyped: these functions post-date the last generated Database types.
  // No window argument: the summary measures the same UTC calendar day the
  // ceiling is enforced against, so the figure shown is the figure gating.
  const { data, error } = await callUntypedRpc("api_spend_summary");
  return ensureData(data, error) as SpendSummary;
}

export async function setGlobalSpendCap(input: {
  dailyCeilingUsd?: number;
  perRunCeilingUsd?: number;
  killSwitch?: boolean;
}) {
  const { data, error } = await callUntypedRpc("api_set_global_spend_cap", {
    p_daily_ceiling_usd: input.dailyCeilingUsd ?? null,
    p_per_run_ceiling_usd: input.perRunCeilingUsd ?? null,
    p_kill_switch: input.killSwitch ?? null,
  });
  return ensureData(data, error) as {
    dailyCeilingUsd: number;
    perRunCeilingUsd: number;
    killSwitch: boolean;
  };
}
