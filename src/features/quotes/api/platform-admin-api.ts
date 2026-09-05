import type { AppRole, JobStatus } from "@/integrations/supabase/types";
import { isMissingFunctionError } from "./shared/schema-errors";
import { callRpc, callUntypedRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";

export type PlatformAdminNotificationRecord = {
  admissionState: "disabled";
  eventType: "provider.integration_added";
  genericDispatchEnabled: false;
  id: string;
  occurredAt: string;
  policyRevision: string;
  providerKey: string;
};

function isPlatformAdminNotificationRecord(value: unknown): value is PlatformAdminNotificationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const occurredAt = typeof record.occurredAt === "string" ? Date.parse(record.occurredAt) : Number.NaN;
  return (
    record.eventType === "provider.integration_added" &&
    record.admissionState === "disabled" &&
    record.genericDispatchEnabled === false &&
    typeof record.id === "string" && record.id.length > 0 &&
    Number.isFinite(occurredAt) &&
    typeof record.policyRevision === "string" && record.policyRevision.length > 0 &&
    typeof record.providerKey === "string" && record.providerKey.length > 0
  );
}

/**
 * Reads the minimal, append-only provider onboarding feed exposed only to
 * authenticated platform admins. A missing RPC is treated as an empty feed so
 * the web deployment can remain compatible while its migration is pending.
 */
export async function fetchPlatformAdminNotifications(
  limit = 20,
): Promise<PlatformAdminNotificationRecord[]> {
  const { data, error } = await callUntypedRpc("api_admin_list_platform_notifications", {
    p_limit: limit,
  });

  if (isMissingFunctionError(error, "api_admin_list_platform_notifications")) {
    return [];
  }

  const rows = ensureData(data, error);
  if (!Array.isArray(rows) || !rows.every(isPlatformAdminNotificationRecord)) {
    throw new TypeError("Platform admin notifications returned an invalid response.");
  }

  return rows;
}

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

/**
 * Updates the platform-wide cap. Omitted fields are left unchanged, so the
 * caller can flip the kill switch without restating the ceilings.
 */
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
