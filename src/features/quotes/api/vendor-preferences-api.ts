import type { VendorName } from "@/integrations/supabase/types";
import { callUntypedRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";

export type VendorPreferenceState = {
  includedVendors: VendorName[];
  excludedVendors: VendorName[];
  updatedAt: string | null;
};

export type JobVendorPreferenceContext = {
  jobId: string;
  projectId: string | null;
  organizationId: string;
  availableVendors: VendorName[];
  projectVendorPreferences: VendorPreferenceState;
  jobVendorPreferences: VendorPreferenceState;
};

const EMPTY_VENDOR_PREFERENCES: VendorPreferenceState = {
  includedVendors: [],
  excludedVendors: [],
  updatedAt: null,
};

function normalizeVendorArray(value: unknown): VendorName[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((item): item is VendorName => typeof item === "string"))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function normalizeVendorPreferenceState(value: unknown): VendorPreferenceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_VENDOR_PREFERENCES;
  }

  const record = value as Record<string, unknown>;

  return {
    includedVendors: normalizeVendorArray(record.includedVendors),
    excludedVendors: normalizeVendorArray(record.excludedVendors),
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

function normalizeJobVendorPreferenceContext(value: unknown): JobVendorPreferenceContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected vendor preference context payload to be an object.");
  }

  const record = value as Record<string, unknown>;
  const jobId = typeof record.jobId === "string" ? record.jobId : null;
  const organizationId = typeof record.organizationId === "string" ? record.organizationId : null;

  if (!jobId || !organizationId) {
    throw new Error("Vendor preference context payload is missing required identifiers.");
  }

  return {
    jobId,
    projectId: typeof record.projectId === "string" ? record.projectId : null,
    organizationId,
    availableVendors: normalizeVendorArray(record.availableVendors),
    projectVendorPreferences: normalizeVendorPreferenceState(record.projectVendorPreferences),
    jobVendorPreferences: normalizeVendorPreferenceState(record.jobVendorPreferences),
  };
}

/**
 * Fetches the vendor-preference context for a specific job.
 *
 * Calls an untyped RPC payload and normalizes vendors + nested preference state.
 *
 * @param jobId - Job identifier whose project/job preference context should be loaded.
 * @returns Normalized job vendor-preference context for UI/controller use.
 * @throws When the RPC returns missing or malformed required identifiers.
 */
export async function fetchJobVendorPreferenceContext(
  jobId: string,
): Promise<JobVendorPreferenceContext> {
  const { data, error } = await callUntypedRpc("api_get_job_vendor_preferences", {
    p_job_id: jobId,
  });

  return normalizeJobVendorPreferenceContext(ensureData(data, error));
}

/**
 * Persists project-level vendor preference defaults.
 *
 * Calls an untyped RPC and normalizes + de-duplicates returned vendor arrays.
 *
 * @param input - Project identifier and the next included/excluded vendor sets.
 * @returns Normalized project-level vendor preference state.
 * @throws When the RPC response is malformed or missing expected data.
 */
export async function setProjectVendorPreferences(input: {
  projectId: string;
  includedVendors: VendorName[];
  excludedVendors: VendorName[];
}): Promise<VendorPreferenceState> {
  const { data, error } = await callUntypedRpc("api_set_project_vendor_preferences", {
    p_project_id: input.projectId,
    p_included_vendors: input.includedVendors,
    p_excluded_vendors: input.excludedVendors,
  });

  return normalizeVendorPreferenceState(ensureData(data, error));
}

/**
 * Persists job-level vendor preference overrides.
 *
 * Calls an untyped RPC and normalizes + de-duplicates returned vendor arrays.
 *
 * @param input - Job identifier and the next included/excluded vendor sets.
 * @returns Normalized job-level vendor preference state.
 * @throws When the RPC response is malformed or missing expected data.
 */
export async function setJobVendorPreferences(input: {
  jobId: string;
  includedVendors: VendorName[];
  excludedVendors: VendorName[];
}): Promise<VendorPreferenceState> {
  const { data, error } = await callUntypedRpc("api_set_job_vendor_preferences", {
    p_job_id: input.jobId,
    p_included_vendors: input.includedVendors,
    p_excluded_vendors: input.excludedVendors,
  });

  return normalizeVendorPreferenceState(ensureData(data, error));
}
