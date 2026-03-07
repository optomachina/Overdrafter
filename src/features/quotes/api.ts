import { supabase } from "@/integrations/supabase/client";
import { hasVerifiedAuth } from "@/lib/auth-status";
import { buildAuthRedirectUrl } from "@/lib/auth-redirect";
import type {
  AccessibleProjectSummary,
  AppMembership,
  AppSessionData,
  ApprovedPartRequirement,
  ClientPackageAggregate,
  ClientDraftInput,
  JobAggregate,
  JobFileRecord,
  JobPartSummary,
  JobRecord,
  ManualQuoteArtifactInput,
  ManualQuoteOfferInput,
  ManualQuoteRecordResult,
  OrganizationMembershipSummary,
  PublishedQuotePackageRecord,
  ProjectInviteRecord,
  ProjectInviteSummary,
  ProjectMembershipRecord,
  ProjectRecord,
  QuoteRunReadiness,
  SidebarPins,
} from "@/features/quotes/types";
import type {
  AppRole,
  ClientSelectionRecord,
  JobFileKind,
  Json,
  PublishedQuoteOptionRecord,
  ProjectRole,
  VendorName,
  VendorStatus,
  WorkQueueRecord,
} from "@/integrations/supabase/types";
import type {
  ApprovedPartRequirementRecord,
  DrawingExtractionRecord,
  PartRecord,
  PricingPolicyRecord,
  PublishedPackageAggregate,
  QuoteRunAggregate,
  QuoteRunRecord,
  UserPinnedJobRecord,
  UserPinnedProjectRecord,
  VendorQuoteAggregate,
  VendorQuoteOfferRecord,
  VendorQuoteResultRecord,
} from "@/features/quotes/types";
import { FunctionsHttpError, isAuthError } from "@supabase/supabase-js";
import type { PostgrestSingleResponse, PostgrestResponse } from "@supabase/supabase-js";

const CAD_EXTENSIONS = new Set([
  "step",
  "stp",
  "iges",
  "igs",
  "sldprt",
  "prt",
  "sldasm",
  "asm",
  "x_t",
  "xt",
]);

const DRAWING_EXTENSIONS = new Set(["pdf"]);

type MembershipJoinRow = {
  id: string;
  organization_id: string;
  role: AppMembership["role"];
  organizations: {
    id: string;
    name: string;
    slug: string;
  } | null;
};

type ApprovedRequirementJoinRow = {
  job_id: string;
  quantity: number | null;
  approved_part_requirements: {
    part_number: string | null;
    revision: string | null;
    description: string | null;
    spec_snapshot: Json | null;
  } | null;
};

type JobFileSummaryRow = {
  job_id: string;
  normalized_name: string;
  original_name: string;
  file_kind: JobFileKind;
};

function emptyResponse<T>(): Promise<PostgrestResponse<T>> {
  return Promise.resolve({
    data: [],
    error: null,
    count: null,
    status: 200,
    statusText: "OK",
  });
}

function emptySingleResponse<T>(data: T | null = null): Promise<PostgrestSingleResponse<T>> {
  return Promise.resolve({
    data,
    error: null,
    count: null,
    status: 200,
    statusText: "OK",
  });
}

const PROJECT_COLLABORATION_UNAVAILABLE_MESSAGE =
  "Projects are unavailable in this environment until the shared workspace schema is applied.";

type ProjectCollaborationSchemaAvailability = "unknown" | "available" | "unavailable";

let projectCollaborationSchemaAvailability: ProjectCollaborationSchemaAvailability = "unknown";

const PROJECT_COLLABORATION_IDENTIFIERS = [
  "public.projects",
  "public.project_memberships",
  "public.project_invites",
  "public.user_pinned_projects",
  "api_create_project",
  "api_update_project",
  "api_delete_project",
  "api_invite_project_member",
  "api_accept_project_invite",
  "api_remove_project_member",
  "api_assign_job_to_project",
  "api_remove_job_from_project",
] as const;

function ensureData<T>(data: T | null, error: { message: string } | null | undefined): T {
  if (error) {
    throw error;
  }

  if (data === null) {
    throw new Error("Expected data but query returned null.");
  }

  return data;
}

function markProjectCollaborationSchemaAvailability(next: Exclude<ProjectCollaborationSchemaAvailability, "unknown">) {
  projectCollaborationSchemaAvailability = next;
}

function isMissingProjectCollaborationSchemaError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const value = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
    hint?: unknown;
  };
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.message === "string" ? value.message : error instanceof Error ? error.message : "";
  const details = typeof value.details === "string" ? value.details : "";
  const hint = typeof value.hint === "string" ? value.hint : "";
  const blob = `${message} ${details} ${hint}`.toLowerCase();

  if (!PROJECT_COLLABORATION_IDENTIFIERS.some((identifier) => blob.includes(identifier))) {
    return false;
  }

  return (
    code === "42P01" ||
    code === "42883" ||
    code === "PGRST202" ||
    code === "PGRST205" ||
    blob.includes("does not exist") ||
    blob.includes("schema cache")
  );
}

function ensureProjectCollaborationData<T>(data: T | null, error: { message: string } | null | undefined): T {
  if (isMissingProjectCollaborationSchemaError(error)) {
    markProjectCollaborationSchemaAvailability("unavailable");
    throw new Error(PROJECT_COLLABORATION_UNAVAILABLE_MESSAGE);
  }

  return ensureData(data, error);
}

export function isProjectCollaborationSchemaUnavailable(): boolean {
  return projectCollaborationSchemaAvailability === "unavailable";
}

export function resetProjectCollaborationSchemaAvailabilityForTests(): void {
  projectCollaborationSchemaAvailability = "unknown";
}

function isMissingFunctionError(error: unknown, functionName: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const value = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
  const functionPattern = functionName.toLowerCase();
  const code = typeof value.code === "string" ? value.code : "";
  const message = typeof value.message === "string" ? value.message : "";
  const details = typeof value.details === "string" ? value.details : "";
  const hint = typeof value.hint === "string" ? value.hint : "";
  const blob = `${message} ${details} ${hint}`.toLowerCase();

  return (code === "42883" || code === "PGRST202") && blob.includes(functionPattern);
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

async function requireCurrentUser() {
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    throw error;
  }

  if (!user) {
    throw new Error("You must be signed in to continue.");
  }

  return user;
}

function asObject(value: Json | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sanitizeStorageFileName(fileName: string): string {
  return fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function inferFileKind(fileName: string): JobFileKind {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";

  if (DRAWING_EXTENSIONS.has(extension)) {
    return "drawing";
  }

  if (CAD_EXTENSIONS.has(extension)) {
    return "cad";
  }

  return "other";
}

function parsePartReference(value: string | null | undefined): Pick<JobPartSummary, "partNumber" | "revision"> | null {
  if (!value) {
    return null;
  }

  const normalizedValue = value.trim();

  const fileMatch = normalizedValue.match(/^(\d{4}-\d{5})(?:[-_\s]?([A-Za-z0-9]+))?$/);
  if (fileMatch) {
    return {
      partNumber: fileMatch[1] ?? null,
      revision: fileMatch[2] ?? null,
    };
  }

  const titleMatch = normalizedValue.match(/^(\d{4}-\d{5})(?:\s+rev(?:ision)?\s+([A-Za-z0-9]+))?/i);
  if (titleMatch) {
    return {
      partNumber: titleMatch[1] ?? null,
      revision: titleMatch[2] ?? null,
    };
  }

  return null;
}

export async function fetchAppSessionData(): Promise<AppSessionData> {
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) {
    if (isAuthError(userError) && userError.name === "AuthSessionMissingError") {
      return {
        user: null,
        memberships: [],
        isVerifiedAuth: false,
      };
    }

    throw userError;
  }

  if (!user) {
    return {
      user: null,
      memberships: [],
      isVerifiedAuth: false,
    };
  }

  const membershipQuery = supabase
    .from("organization_memberships")
    .select("id, organization_id, role, organizations(id, name, slug)")
    .eq("user_id", user.id)
    .order("created_at", { ascending: true });

  const { data, error } = (await membershipQuery) as PostgrestResponse<MembershipJoinRow>;

  if (error) {
    throw error;
  }

  const memberships: AppMembership[] = (data ?? []).map((row) => ({
    id: row.id,
    role: row.role,
    organizationId: row.organization_id,
    organizationName: row.organizations?.name ?? "Unassigned organization",
    organizationSlug: row.organizations?.slug ?? "unassigned",
  }));

  return {
    user,
    memberships,
    isVerifiedAuth: hasVerifiedAuth(user),
  };
}

export async function fetchJobsByOrganization(organizationId: string): Promise<JobRecord[]> {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });

  return ensureData(data, error);
}

export async function fetchJobPartSummariesByOrganization(
  organizationId: string,
): Promise<JobPartSummary[]> {
  const [partsResult, filesResult] = await Promise.all([
    supabase
      .from("parts")
      .select("job_id, quantity, approved_part_requirements(part_number, revision, description, spec_snapshot)")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
    supabase
      .from("job_files")
      .select("job_id, normalized_name, original_name, file_kind")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
  ]);

  const approvedRequirements = ensureData(
    partsResult.data as unknown as ApprovedRequirementJoinRow[] | null,
    partsResult.error,
  );
  const fileRows = ensureData(filesResult.data as unknown as JobFileSummaryRow[] | null, filesResult.error);

  const summariesByJobId = new Map<string, JobPartSummary>();

  for (const row of approvedRequirements) {
    const specSnapshot = asObject(row.approved_part_requirements?.spec_snapshot);
    const importedBatch =
      typeof specSnapshot.importedBatch === "string" && specSnapshot.importedBatch.trim().length > 0
        ? specSnapshot.importedBatch.trim().toUpperCase()
        : null;

    summariesByJobId.set(row.job_id, {
      jobId: row.job_id,
      partNumber: row.approved_part_requirements?.part_number ?? null,
      revision: row.approved_part_requirements?.revision ?? null,
      description: row.approved_part_requirements?.description ?? null,
      quantity: row.quantity ?? null,
      importedBatch,
    });
  }

  for (const row of fileRows) {
    const existingSummary = summariesByJobId.get(row.job_id);

    if (existingSummary?.partNumber) {
      continue;
    }

    const parsedReference =
      parsePartReference(row.normalized_name) ?? parsePartReference(row.original_name);

    if (!parsedReference && existingSummary) {
      continue;
    }

    summariesByJobId.set(row.job_id, {
      jobId: row.job_id,
      partNumber: parsedReference?.partNumber ?? existingSummary?.partNumber ?? null,
      revision: parsedReference?.revision ?? existingSummary?.revision ?? null,
      description: existingSummary?.description ?? null,
      quantity: existingSummary?.quantity ?? null,
      importedBatch: existingSummary?.importedBatch ?? null,
    });
  }

  return Array.from(summariesByJobId.values());
}

export async function fetchJobPartSummariesByJobIds(jobIds: string[]): Promise<JobPartSummary[]> {
  if (jobIds.length === 0) {
    return [];
  }

  const [partsResult, filesResult] = await Promise.all([
    supabase
      .from("parts")
      .select("job_id, quantity, approved_part_requirements(part_number, revision, description, spec_snapshot)")
      .in("job_id", jobIds)
      .order("created_at", { ascending: true }),
    supabase
      .from("job_files")
      .select("job_id, normalized_name, original_name, file_kind")
      .in("job_id", jobIds)
      .order("created_at", { ascending: true }),
  ]);

  const approvedRequirements = ensureData(
    partsResult.data as unknown as ApprovedRequirementJoinRow[] | null,
    partsResult.error,
  );
  const fileRows = ensureData(filesResult.data as unknown as JobFileSummaryRow[] | null, filesResult.error);
  const summariesByJobId = new Map<string, JobPartSummary>();

  for (const row of approvedRequirements) {
    const specSnapshot = asObject(row.approved_part_requirements?.spec_snapshot);
    const importedBatch =
      typeof specSnapshot.importedBatch === "string" && specSnapshot.importedBatch.trim().length > 0
        ? specSnapshot.importedBatch.trim().toUpperCase()
        : null;

    summariesByJobId.set(row.job_id, {
      jobId: row.job_id,
      partNumber: row.approved_part_requirements?.part_number ?? null,
      revision: row.approved_part_requirements?.revision ?? null,
      description: row.approved_part_requirements?.description ?? null,
      quantity: row.quantity ?? null,
      importedBatch,
    });
  }

  for (const row of fileRows) {
    const existingSummary = summariesByJobId.get(row.job_id);

    if (existingSummary?.partNumber) {
      continue;
    }

    const parsedReference =
      parsePartReference(row.normalized_name) ?? parsePartReference(row.original_name);

    if (!parsedReference && existingSummary) {
      continue;
    }

    summariesByJobId.set(row.job_id, {
      jobId: row.job_id,
      partNumber: parsedReference?.partNumber ?? existingSummary?.partNumber ?? null,
      revision: parsedReference?.revision ?? existingSummary?.revision ?? null,
      description: existingSummary?.description ?? null,
      quantity: existingSummary?.quantity ?? null,
      importedBatch: existingSummary?.importedBatch ?? null,
    });
  }

  return Array.from(summariesByJobId.values());
}

export async function fetchPublishedPackagesByOrganization(
  organizationId: string,
): Promise<PublishedQuotePackageRecord[]> {
  const { data, error } = await supabase
    .from("published_quote_packages")
    .select("*")
    .eq("organization_id", organizationId)
    .order("published_at", { ascending: false });

  return ensureData(data, error);
}

export async function fetchPublishedPackagesByJobIds(
  jobIds: string[],
): Promise<PublishedQuotePackageRecord[]> {
  if (jobIds.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from("published_quote_packages")
    .select("*")
    .in("job_id", jobIds)
    .order("published_at", { ascending: false });

  return ensureData(data, error);
}

export async function fetchJobAggregate(jobId: string): Promise<JobAggregate> {
  const { data: jobData, error: jobError } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  const job = ensureData(jobData, jobError);

  const [
    filesResult,
    partsResult,
    quoteRunsResult,
    packagesResult,
    workQueueResult,
  ] = await Promise.all([
    supabase.from("job_files").select("*").eq("job_id", jobId).order("created_at", { ascending: true }),
    supabase.from("parts").select("*").eq("job_id", jobId).order("created_at", { ascending: true }),
    supabase.from("quote_runs").select("*").eq("job_id", jobId).order("created_at", { ascending: false }),
    supabase
      .from("published_quote_packages")
      .select("*")
      .eq("job_id", jobId)
      .order("published_at", { ascending: false }),
    supabase
      .from("work_queue")
      .select("*")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false }),
  ]);

  const files = ensureData(filesResult.data, filesResult.error) as JobFileRecord[];
  const parts = ensureData(partsResult.data, partsResult.error) as PartRecord[];
  const quoteRuns = ensureData(quoteRunsResult.data, quoteRunsResult.error) as QuoteRunRecord[];
  const packages = ensureData(packagesResult.data, packagesResult.error) as PublishedQuotePackageRecord[];
  const workQueue = ensureData(workQueueResult.data, workQueueResult.error) as WorkQueueRecord[];

  const partIds = parts.map((part) => part.id);
  const quoteRunIds = quoteRuns.map((run) => run.id);
  const packageIds = packages.map((pkg) => pkg.id);

  const [
    extractionResult,
    approvedResult,
    vendorQuoteResult,
    optionResult,
    selectionResult,
  ] = await Promise.all([
    partIds.length > 0
      ? supabase.from("drawing_extractions").select("*").in("part_id", partIds)
      : emptyResponse<DrawingExtractionRecord>(),
    partIds.length > 0
      ? supabase.from("approved_part_requirements").select("*").in("part_id", partIds)
      : emptyResponse<ApprovedPartRequirementRecord>(),
    quoteRunIds.length > 0
      ? supabase.from("vendor_quote_results").select("*").in("quote_run_id", quoteRunIds)
      : emptyResponse<VendorQuoteResultRecord>(),
    packageIds.length > 0
      ? supabase.from("published_quote_options").select("*").in("package_id", packageIds)
      : emptyResponse<PublishedQuoteOptionRecord>(),
    packageIds.length > 0
      ? supabase.from("client_selections").select("*").in("package_id", packageIds).order("created_at", { ascending: false })
      : emptyResponse<ClientSelectionRecord>(),
  ]);

  const pricingPolicyId = job.active_pricing_policy_id;

  const pricingPolicyPromise = pricingPolicyId
    ? supabase.from("pricing_policies").select("*").eq("id", pricingPolicyId).single()
    : supabase
        .from("pricing_policies")
        .select("*")
        .eq("organization_id", job.organization_id)
        .eq("is_active", true)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

  const pricingPolicyResult = pricingPolicyId
    ? ((await pricingPolicyPromise) as PostgrestSingleResponse<PricingPolicyRecord>)
    : ((await pricingPolicyPromise) as PostgrestSingleResponse<PricingPolicyRecord | null>);

  const extractions = ensureData(extractionResult.data, extractionResult.error) as DrawingExtractionRecord[];
  const approvedRequirements = ensureData(
    approvedResult.data,
    approvedResult.error,
  ) as ApprovedPartRequirementRecord[];
  const vendorQuotes = ensureData(
    vendorQuoteResult.data,
    vendorQuoteResult.error,
  ) as VendorQuoteResultRecord[];
  const vendorQuoteIds = vendorQuotes.map((quote) => quote.id);
  const vendorOffersResultResolved =
    vendorQuoteIds.length > 0
      ? await supabase.from("vendor_quote_offers").select("*").in("vendor_quote_result_id", vendorQuoteIds)
      : await emptyResponse<VendorQuoteOfferRecord>();
  const vendorOffers = ensureData(
    vendorOffersResultResolved.data,
    vendorOffersResultResolved.error,
  ) as VendorQuoteOfferRecord[];
  const options = ensureData(
    optionResult.data,
    optionResult.error,
  ) as PublishedQuoteOptionRecord[];
  const selections = ensureData(
    selectionResult.data,
    selectionResult.error,
  ) as ClientSelectionRecord[];
  const pricingPolicy = pricingPolicyResult.data as PricingPolicyRecord | null;

  const fileMap = new Map(files.map((file) => [file.id, file]));
  const extractionMap = new Map(extractions.map((item) => [item.part_id, item]));
  const approvedMap = new Map(approvedRequirements.map((item) => [item.part_id, item]));
  const offerMap = new Map<string, VendorQuoteOfferRecord[]>();

  vendorOffers.forEach((offer) => {
    const current = offerMap.get(offer.vendor_quote_result_id) ?? [];
    current.push(offer);
    offerMap.set(offer.vendor_quote_result_id, current);
  });

  const vendorQuoteAggregates: VendorQuoteAggregate[] = vendorQuotes.map((quote) => ({
    ...quote,
    offers:
      (offerMap.get(quote.id) ?? []).sort((left, right) => {
        if (left.sort_rank !== right.sort_rank) {
          return left.sort_rank - right.sort_rank;
        }

        return (left.total_price_usd ?? Number.MAX_SAFE_INTEGER) - (right.total_price_usd ?? Number.MAX_SAFE_INTEGER);
      }),
  }));

  const partsWithRelations = parts.map((part) => ({
    ...part,
    cadFile: part.cad_file_id ? fileMap.get(part.cad_file_id) ?? null : null,
    drawingFile: part.drawing_file_id ? fileMap.get(part.drawing_file_id) ?? null : null,
    extraction: extractionMap.get(part.id) ?? null,
    approvedRequirement: approvedMap.get(part.id) ?? null,
    vendorQuotes: vendorQuoteAggregates.filter((quote) => quote.part_id === part.id),
  }));

  const quoteRunsWithResults: QuoteRunAggregate[] = quoteRuns.map((run) => ({
    ...run,
    vendorQuotes: vendorQuoteAggregates.filter((quote) => quote.quote_run_id === run.id),
  }));

  const packagesWithOptions: PublishedPackageAggregate[] = packages.map((pkg) => ({
    ...pkg,
    options: options.filter((option) => option.package_id === pkg.id),
    selections: selections.filter((selection) => selection.package_id === pkg.id),
  }));

  return {
    job,
    files,
    parts: partsWithRelations,
    quoteRuns: quoteRunsWithResults,
    packages: packagesWithOptions,
    pricingPolicy,
    workQueue,
  };
}

export async function fetchClientPackage(packageId: string): Promise<ClientPackageAggregate> {
  const { data: packageData, error: packageError } = await supabase
    .from("published_quote_packages")
    .select("*")
    .eq("id", packageId)
    .single();

  const pkg = ensureData(packageData, packageError);

  const [jobResult, optionsResult, selectionResult] = await Promise.all([
    supabase.from("jobs").select("*").eq("id", pkg.job_id).single(),
    supabase
      .from("published_quote_options")
      .select("*")
      .eq("package_id", packageId)
      .order("created_at", { ascending: true }),
    supabase
      .from("client_selections")
      .select("*")
      .eq("package_id", packageId)
      .order("created_at", { ascending: false }),
  ]);

  return {
    package: pkg,
    job: ensureData(jobResult.data, jobResult.error) as JobRecord,
    options: ensureData(optionsResult.data, optionsResult.error) as PublishedQuoteOptionRecord[],
    selections: ensureData(selectionResult.data, selectionResult.error) as ClientSelectionRecord[],
  };
}

export async function createSelfServiceOrganization(organizationName: string): Promise<string> {
  const { data, error } = await supabase.rpc("api_create_self_service_organization", {
    p_organization_name: organizationName,
  });

  return ensureData(data, error);
}

export async function fetchOrganizationMemberships(
  organizationId: string,
): Promise<OrganizationMembershipSummary[]> {
  const { data, error } = await supabase.rpc("api_list_organization_memberships", {
    p_organization_id: organizationId,
  });

  return ensureData(data, error) as OrganizationMembershipSummary[];
}

export async function updateOrganizationMembershipRole(input: {
  membershipId: string;
  role: AppRole;
}): Promise<string> {
  const { data, error } = await supabase.rpc("api_update_organization_membership_role", {
    p_membership_id: input.membershipId,
    p_role: input.role,
  });

  return ensureData(data, error);
}

async function fetchAllAccessibleJobs(): Promise<JobRecord[]> {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .order("created_at", { ascending: false });

  return ensureData(data, error);
}

export async function fetchAccessibleJobs(): Promise<JobRecord[]> {
  return fetchAllAccessibleJobs();
}

export async function fetchAccessibleProjects(): Promise<AccessibleProjectSummary[]> {
  if (isProjectCollaborationSchemaUnavailable()) {
    return [];
  }

  const currentUser = await requireCurrentUser();
  const { data: projectsData, error: projectsError } = await supabase
    .from("projects")
    .select("*")
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
  const [membershipsResult, invitesResult, jobs] = await Promise.all([
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
    fetchAllAccessibleJobs(),
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

  markProjectCollaborationSchemaAvailability("available");

  return projects.map((project) => {
    const projectMemberships = memberships.filter((membership) => membership.project_id === project.id);
    const currentMembership = projectMemberships.find((membership) => membership.user_id === currentUser.id);
    const partCount = jobs.filter((job) => job.project_id === project.id).length;
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

export async function fetchSidebarPins(): Promise<SidebarPins> {
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
  if (isProjectCollaborationSchemaUnavailable()) {
    throw new Error(PROJECT_COLLABORATION_UNAVAILABLE_MESSAGE);
  }

  const currentUser = await requireCurrentUser();
  const { error } = await supabase.from("user_pinned_projects").upsert(
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
  const currentUser = await requireCurrentUser();
  const { error } = await supabase.from("user_pinned_jobs").upsert(
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
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();

  return ensureProjectCollaborationData(data, error) as ProjectRecord;
}

export async function fetchProjectMemberships(projectId: string): Promise<ProjectMembershipRecord[]> {
  const { data, error } = await supabase
    .from("project_memberships")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  return ensureProjectCollaborationData(data, error) as ProjectMembershipRecord[];
}

export async function fetchProjectInvites(projectId: string): Promise<ProjectInviteSummary[]> {
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

export async function fetchJobsByProject(projectId: string): Promise<JobRecord[]> {
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  return ensureData(data, error);
}

export async function fetchUngroupedParts(): Promise<JobRecord[]> {
  const currentUser = await requireCurrentUser();
  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .eq("created_by", currentUser.id)
    .is("project_id", null)
    .order("created_at", { ascending: false });

  return ensureData(data, error);
}

export async function searchAccessibleParts(query: string): Promise<JobRecord[]> {
  const normalizedQuery = query.trim().toLowerCase();

  if (!normalizedQuery) {
    return [];
  }

  const jobs = await fetchAllAccessibleJobs();

  return jobs.filter((job) =>
    [job.title, job.description ?? "", job.tags.join(" ")]
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery),
  );
}

export async function fetchPartDetail(jobId: string): Promise<{
  job: JobRecord;
  files: JobFileRecord[];
  summary: JobPartSummary | null;
  packages: PublishedQuotePackageRecord[];
}> {
  const [jobResult, filesResult, partSummaries, packages] = await Promise.all([
    supabase.from("jobs").select("*").eq("id", jobId).single(),
    supabase.from("job_files").select("*").eq("job_id", jobId).order("created_at", { ascending: true }),
    fetchJobPartSummariesByJobIds([jobId]),
    fetchPublishedPackagesByJobIds([jobId]),
  ]);

  return {
    job: ensureData(jobResult.data, jobResult.error) as JobRecord,
    files: ensureData(filesResult.data, filesResult.error) as JobFileRecord[],
    summary: partSummaries[0] ?? null,
    packages,
  };
}

export async function createProject(input: {
  name: string;
  description?: string;
}): Promise<string> {
  if (isProjectCollaborationSchemaUnavailable()) {
    throw new Error(PROJECT_COLLABORATION_UNAVAILABLE_MESSAGE);
  }

  const { data, error } = await supabase.rpc("api_create_project", {
    p_name: input.name,
    p_description: input.description ?? null,
  });

  if (!error) {
    markProjectCollaborationSchemaAvailability("available");
    return ensureData(data, null);
  }

  if (isMissingFunctionError(error, "api_create_project")) {
    // Backward-compatible fallback for environments that still expose the
    // older one-argument function signature.
    if (!input.description) {
      const fallbackResult = await supabase.rpc("api_create_project", {
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

    // Last-resort fallback for environments where the shared-project RPC
    // has not been applied to Postgres at all yet.
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
  const { data, error } = await supabase.rpc("api_update_project", {
    p_project_id: input.projectId,
    p_name: input.name,
    p_description: input.description ?? null,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function deleteProject(projectId: string): Promise<string> {
  const { data, error } = await supabase.rpc("api_delete_project", {
    p_project_id: projectId,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function inviteProjectMember(input: {
  projectId: string;
  email: string;
  role?: ProjectRole;
}): Promise<ProjectInviteSummary> {
  const { data, error } = await supabase.rpc("api_invite_project_member", {
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
  const { data, error } = await supabase.rpc("api_accept_project_invite", {
    p_token: token,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function removeProjectMember(projectMembershipId: string): Promise<string> {
  const { data, error } = await supabase.rpc("api_remove_project_member", {
    p_project_membership_id: projectMembershipId,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function createClientDraft(input: ClientDraftInput): Promise<string> {
  const { data, error } = await supabase.rpc("api_create_client_draft", {
    p_title: input.title,
    p_description: input.description ?? null,
    p_project_id: input.projectId ?? null,
    p_tags: input.tags ?? [],
  });

  if (!error) {
    return ensureData(data, null);
  }

  // Backward-compatible fallback for environments that have not applied
  // the shared-project migration with api_create_client_draft yet.
  if (!input.projectId && isMissingFunctionError(error, "api_create_client_draft")) {
    const appSession = await fetchAppSessionData();
    const fallbackMembership =
      appSession.memberships.find((membership) => membership.role === "client") ??
      appSession.memberships[0];

    if (!fallbackMembership) {
      throw error;
    }

    return createJob({
      organizationId: fallbackMembership.organizationId,
      title: input.title,
      description: input.description,
      source: "client_home",
      tags: input.tags,
    });
  }

  throw error;
}

export async function assignJobToProject(input: {
  jobId: string;
  projectId: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("api_assign_job_to_project", {
    p_job_id: input.jobId,
    p_project_id: input.projectId,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function removeJobFromProject(jobId: string): Promise<string> {
  const { data, error } = await supabase.rpc("api_remove_job_from_project", {
    p_job_id: jobId,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function requestPasswordReset(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: buildAuthRedirectUrl("/signin?mode=recovery"),
  });

  if (error) {
    throw error;
  }
}

export async function resendSignupConfirmation(email: string): Promise<void> {
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: {
      emailRedirectTo: buildAuthRedirectUrl("/"),
    },
  });

  if (error) {
    throw error;
  }
}

export async function updateCurrentUserPassword(password: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({
    password,
  });

  if (error) {
    throw error;
  }
}

export async function createJob(input: {
  organizationId: string;
  title: string;
  description?: string;
  source: string;
  tags?: string[];
}): Promise<string> {
  const { data, error } = await supabase.rpc("api_create_job", {
    p_organization_id: input.organizationId,
    p_title: input.title,
    p_description: input.description ?? null,
    p_source: input.source,
    p_tags: input.tags ?? [],
  });

  return ensureData(data, error);
}

export async function uploadFilesToJob(jobId: string, files: File[]): Promise<void> {
  for (const file of files) {
    const storagePath = `${jobId}/${Date.now()}-${file.name}`;
    const fileKind = inferFileKind(file.name);

    const { error: storageError } = await supabase.storage
      .from("job-files")
      .upload(storagePath, file, { upsert: false });

    if (storageError) {
      throw storageError;
    }

    const { error } = await supabase.rpc("api_attach_job_file", {
      p_job_id: jobId,
      p_storage_bucket: "job-files",
      p_storage_path: storagePath,
      p_original_name: file.name,
      p_file_kind: fileKind,
      p_mime_type: file.type || null,
      p_size_bytes: file.size,
    });

    if (error) {
      throw error;
    }
  }
}

export async function uploadManualQuoteEvidence(
  jobId: string,
  files: File[],
): Promise<ManualQuoteArtifactInput[]> {
  const uploadedArtifacts: ManualQuoteArtifactInput[] = [];

  for (const file of files) {
    const storagePath = `manual-quotes/${jobId}/${Date.now()}-${crypto.randomUUID()}-${sanitizeStorageFileName(file.name)}`;

    const { error: storageError } = await supabase.storage
      .from("quote-artifacts")
      .upload(storagePath, file, {
        upsert: false,
        contentType: file.type || undefined,
      });

    if (storageError) {
      throw storageError;
    }

    uploadedArtifacts.push({
      artifactType: "uploaded_evidence",
      storageBucket: "quote-artifacts",
      storagePath,
      metadata: {
        originalName: file.name,
        mimeType: file.type || null,
        sizeBytes: file.size,
        uploadedAt: new Date().toISOString(),
      } satisfies Json,
    });
  }

  return uploadedArtifacts;
}

export async function reconcileJobParts(jobId: string): Promise<Record<string, number>> {
  const { data, error } = await supabase.rpc("api_reconcile_job_parts", {
    p_job_id: jobId,
  });

  return ensureData(data, error) as Record<string, number>;
}

export async function requestExtraction(jobId: string): Promise<number> {
  const { data, error } = await supabase.rpc("api_request_extraction", {
    p_job_id: jobId,
  });

  return ensureData(data, error);
}

export async function approveJobRequirements(
  jobId: string,
  requirements: ApprovedPartRequirement[],
): Promise<number> {
  const { data, error } = await supabase.rpc("api_approve_job_requirements", {
    p_job_id: jobId,
    p_requirements: requirements,
  });

  return ensureData(data, error);
}

export async function startQuoteRun(
  jobId: string,
  autoPublishRequested = false,
): Promise<string> {
  const { data, error } = await supabase.rpc("api_start_quote_run", {
    p_job_id: jobId,
    p_auto_publish_requested: autoPublishRequested,
  });

  return ensureData(data, error);
}

export async function getQuoteRunReadiness(
  quoteRunId: string,
): Promise<QuoteRunReadiness> {
  const { data, error } = await supabase.rpc("api_get_quote_run_readiness", {
    p_quote_run_id: quoteRunId,
  });

  const readiness = ensureData(data, error) as QuoteRunReadiness;

  return {
    ready: Boolean(readiness.ready),
    successfulVendorQuotes: Number(readiness.successfulVendorQuotes ?? 0),
    failedVendorQuotes: Number(readiness.failedVendorQuotes ?? 0),
    blockingVendorStates: Number(readiness.blockingVendorStates ?? 0),
    unapprovedExtractions: Number(readiness.unapprovedExtractions ?? 0),
    repairTasks: Number(readiness.repairTasks ?? 0),
    priorRequirementsMatch: Boolean(readiness.priorRequirementsMatch),
    reasons: readiness.reasons ?? [],
  };
}

export async function publishQuotePackage(input: {
  jobId: string;
  quoteRunId: string;
  clientSummary?: string;
  force?: boolean;
}): Promise<string> {
  const { data, error } = await supabase.rpc("api_publish_quote_package", {
    p_job_id: input.jobId,
    p_quote_run_id: input.quoteRunId,
    p_client_summary: input.clientSummary ?? null,
    p_force: Boolean(input.force),
  });

  return ensureData(data, error);
}

export async function recordManualVendorQuote(input: {
  jobId: string;
  partId: string;
  vendor: VendorName;
  status?: VendorStatus;
  summaryNote?: string;
  sourceText?: string;
  quoteUrl?: string;
  offers: ManualQuoteOfferInput[];
  artifacts?: ManualQuoteArtifactInput[];
}): Promise<ManualQuoteRecordResult> {
  const { data, error } = await supabase.rpc("api_record_manual_vendor_quote", {
    p_job_id: input.jobId,
    p_part_id: input.partId,
    p_vendor: input.vendor,
    p_status: input.status ?? "official_quote_received",
    p_summary_note: input.summaryNote ?? null,
    p_source_text: input.sourceText ?? null,
    p_quote_url: input.quoteUrl ?? null,
    p_offers: input.offers,
    p_artifacts: input.artifacts ?? [],
  });

  return ensureData(data, error) as ManualQuoteRecordResult;
}

export async function selectQuoteOption(input: {
  packageId: string;
  optionId: string;
  note?: string;
}): Promise<string> {
  const { data, error } = await supabase.rpc("api_select_quote_option", {
    p_package_id: input.packageId,
    p_option_id: input.optionId,
    p_note: input.note ?? null,
  });

  return ensureData(data, error);
}
