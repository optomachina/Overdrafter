import { supabase } from "@/integrations/supabase/client";
import { hasVerifiedAuth } from "@/lib/auth-status";
import { buildAuthRedirectUrl } from "@/lib/auth-redirect";
import type {
  AccessibleProjectSummary,
  AppMembership,
  AppSessionData,
  ArchivedJobSummary,
  ArchivedProjectSummary,
  ApprovedPartRequirement,
  ClientPackageAggregate,
  ClientActivityEvent,
  ClientDraftInput,
  ClientPartRequestUpdateInput,
  ClientQuoteWorkspaceItem,
  DrawingPreviewAssetRecord,
  JobAggregate,
  JobFileRecord,
  JobPartSummary,
  JobRecord,
  ManualQuoteArtifactInput,
  ManualQuoteOfferInput,
  ManualQuoteRecordResult,
  WorkerReadinessSnapshot,
  OrganizationMembershipSummary,
  PrepareJobFileUploadResult,
  PublishedQuotePackageRecord,
  PublishedQuoteOptionRecord,
  ProjectInviteRecord,
  ProjectInviteSummary,
  ProjectJobRecord,
  ProjectMembershipRecord,
  PartDetailAggregate,
  ProjectRecord,
  QuoteRunReadiness,
  SidebarPins,
  UploadFilesToJobSummary,
  ClientSelectionRecord,
  VendorQuoteArtifactRecord,
  WorkQueueRecord,
} from "@/features/quotes/types";
import type {
  AppRole,
  Database,
  JobFileKind,
  Json,
  ProjectRole,
  VendorName,
  VendorStatus,
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
import { buildAutoProjectName, groupUploadFiles, normalizeUploadStem } from "@/features/quotes/upload-groups";
import { buildDraftTitleFromPrompt } from "@/features/quotes/file-validation";
import { normalizeRequestedQuoteQuantities, parseRequestIntake } from "@/features/quotes/request-intake";
import { sanitizeClientVisibleSpecSnapshot } from "@/features/quotes/rfq-metadata";
import { normalizeRequestedServiceIntent } from "@/features/quotes/service-intent";
import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";
import { getImportedVendorOffers, normalizeDrawingPreview } from "@/features/quotes/utils";
import { toast } from "sonner";

const untypedSupabase = supabase as typeof supabase & {
  from: (relation: string) => unknown;
  rpc: (fn: string, args?: Record<string, unknown>) => Promise<PostgrestSingleResponse<unknown>>;
};

type RpcName = keyof Database["public"]["Functions"];

function callRpc<Name extends RpcName>(
  fn: Name,
  args: Database["public"]["Functions"][Name]["Args"],
): Promise<PostgrestSingleResponse<Database["public"]["Functions"][Name]["Returns"]>> {
  return untypedSupabase.rpc(fn, args) as Promise<
    PostgrestSingleResponse<Database["public"]["Functions"][Name]["Returns"]>
  >;
}

function callUntypedRpc(
  fn: string,
  args?: Record<string, unknown>,
): Promise<PostgrestSingleResponse<unknown>> {
  return untypedSupabase.rpc(fn, args);
}

function upsertUntyped(
  relation: string,
  values: Record<string, unknown>,
  options?: { onConflict?: string; ignoreDuplicates?: boolean },
): Promise<{ error: unknown }> {
  return (
    untypedSupabase.from(relation) as unknown as {
      upsert: (
        nextValues: Record<string, unknown>,
        nextOptions?: { onConflict?: string; ignoreDuplicates?: boolean },
      ) => Promise<{ error: unknown }>;
    }
  ).upsert(values, options);
}

function insertUntyped(
  relation: string,
  values: Record<string, unknown>,
): {
  select: (columns: string) => {
    single: () => Promise<PostgrestSingleResponse<unknown>>;
  };
} {
  return (
    untypedSupabase.from(relation) as unknown as {
      insert: (nextValues: Record<string, unknown>) => {
        select: (columns: string) => {
          single: () => Promise<PostgrestSingleResponse<unknown>>;
        };
      };
    }
  ).insert(values);
}

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
    quote_quantities: number[] | null;
    requested_by_date: string | null;
    spec_snapshot: Json | null;
  } | null;
};

type JobFileSummaryRow = {
  job_id: string;
  normalized_name: string;
  original_name: string;
  file_kind: JobFileKind;
};

type JobSelectedOfferRow = {
  id: string;
  selected_vendor_quote_offer_id: string | null;
  requested_quote_quantities: number[];
  requested_by_date: string | null;
  requested_service_kinds: string[] | null;
  primary_service_kind: string | null;
  service_notes: string | null;
};

type HashedUploadFile = {
  file: File;
  contentSha256: string;
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
const PROJECT_NOT_FOUND_MESSAGE = "Project not found.";
const CLIENT_INTAKE_EXPECTED_MIGRATION = "20260313143000_add_request_service_intent.sql";
const CLIENT_INTAKE_DRIFT_MESSAGE =
  "This environment is missing the latest client intake schema. Apply the latest Supabase migrations, including " +
  `\`${CLIENT_INTAKE_EXPECTED_MIGRATION}\`, and refresh the PostgREST schema cache.`;

type ProjectCollaborationSchemaAvailability = "unknown" | "available" | "unavailable";
type ClientIntakeSchemaAvailability = "unknown" | "available" | "legacy" | "unavailable";
type ClientIntakeCompatibilitySnapshot = {
  supportsCurrentCreateJob?: boolean | null;
  supportsLegacyCreateJobV2?: boolean | null;
  supportsLegacyCreateJobV1?: boolean | null;
  supportsLegacyCreateJobV0?: boolean | null;
  supportsCurrentCreateClientDraft?: boolean | null;
  supportsLegacyCreateClientDraftV1?: boolean | null;
  supportsLegacyCreateClientDraftV0?: boolean | null;
  hasRequestedServiceKindsColumn?: boolean | null;
  hasPrimaryServiceKindColumn?: boolean | null;
  hasServiceNotesColumn?: boolean | null;
  missing?: string[] | null;
};

let projectCollaborationSchemaAvailability: ProjectCollaborationSchemaAvailability = "unknown";
let clientIntakeSchemaAvailability: ClientIntakeSchemaAvailability = "unknown";
let clientIntakeSchemaMessage = CLIENT_INTAKE_DRIFT_MESSAGE;

const PROJECT_COLLABORATION_IDENTIFIERS = [
  "public.projects",
  "public.jobs",
  "public.project_memberships",
  "public.project_invites",
  "public.user_pinned_projects",
  "api_archive_job",
  "api_unarchive_job",
  "api_delete_archived_job",
  "api_unarchive_project",
  "api_create_project",
  "api_update_project",
  "api_delete_project",
  "api_invite_project_member",
  "api_accept_project_invite",
  "api_remove_project_member",
  "api_assign_job_to_project",
  "api_remove_job_from_project",
] as const;
const CLIENT_INTAKE_IDENTIFIERS = [
  "api_create_job",
  "api_create_client_draft",
  "api_get_client_intake_compatibility",
  "requested_service_kinds",
  "primary_service_kind",
  "service_notes",
] as const;

export class ClientIntakeCompatibilityError extends Error {
  readonly missing: string[];

  constructor(message = CLIENT_INTAKE_DRIFT_MESSAGE, missing: readonly string[] = []) {
    super(message);
    this.name = "ClientIntakeCompatibilityError";
    this.missing = [...missing];
  }
}

function ensureData<T>(data: T | null, error: { message: string } | null | undefined): T {
  if (error) {
    throw error;
  }

  if (data === null) {
    throw new Error("Expected data but query returned null.");
  }

  return data;
}

function isNoRowsError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const value = error as { code?: unknown; details?: unknown };
  return value.code === "PGRST116" && value.details === "The result contains 0 rows";
}

function isDeletedAuthUserError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const value = error as { code?: unknown; message?: unknown };
  return value.code === "user_not_found" || value.message === "User from sub claim in JWT does not exist";
}

function isInvalidRefreshTokenError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const value = error as { name?: unknown; message?: unknown };
  const name = typeof value.name === "string" ? value.name : error instanceof Error ? error.name : "";
  const message = typeof value.message === "string" ? value.message : error instanceof Error ? error.message : "";
  const blob = `${name} ${message}`.toLowerCase();

  return blob.includes("invalid refresh token") || blob.includes("refresh token not found");
}

function markProjectCollaborationSchemaAvailability(next: Exclude<ProjectCollaborationSchemaAvailability, "unknown">) {
  projectCollaborationSchemaAvailability = next;
}

function markClientIntakeSchemaAvailability(
  next: Exclude<ClientIntakeSchemaAvailability, "unknown">,
  message = CLIENT_INTAKE_DRIFT_MESSAGE,
) {
  clientIntakeSchemaAvailability = next;
  clientIntakeSchemaMessage = message;
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

function isMissingClientIntakeSchemaError(error: unknown): boolean {
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

  if (!CLIENT_INTAKE_IDENTIFIERS.some((identifier) => blob.includes(identifier))) {
    return false;
  }

  return (
    code === "42703" ||
    code === "42883" ||
    code === "42P01" ||
    code === "PGRST202" ||
    code === "PGRST204" ||
    code === "PGRST205" ||
    blob.includes("does not exist") ||
    blob.includes("schema cache")
  );
}

function formatClientIntakeDriftMessage(missing: readonly string[] = []): string {
  const normalizedMissing = missing
    .filter((item): item is string => Boolean(item))
    .map((item) => item.trim())
    .filter(Boolean);

  if (normalizedMissing.length === 0) {
    return CLIENT_INTAKE_DRIFT_MESSAGE;
  }

  return `${CLIENT_INTAKE_DRIFT_MESSAGE} Missing: ${normalizedMissing.join(", ")}.`;
}

export function isClientIntakeCompatibilityError(error: unknown): error is ClientIntakeCompatibilityError {
  return error instanceof ClientIntakeCompatibilityError;
}

function toClientIntakeCompatibilityError(
  error: unknown,
  missing: readonly string[] = [],
): ClientIntakeCompatibilityError | Error {
  if (isClientIntakeCompatibilityError(error)) {
    return error;
  }

  if (error instanceof Error && !isMissingClientIntakeSchemaError(error) && missing.length === 0) {
    return error;
  }

  return new ClientIntakeCompatibilityError(formatClientIntakeDriftMessage(missing), missing);
}

function ensureProjectCollaborationData<T>(data: T | null, error: { message: string } | null | undefined): T {
  if (isMissingProjectCollaborationSchemaError(error)) {
    markProjectCollaborationSchemaAvailability("unavailable");
    throw new Error(PROJECT_COLLABORATION_UNAVAILABLE_MESSAGE);
  }

  return ensureData(data, error);
}

export function isProjectCollaborationSchemaUnavailable(): boolean {
  if (getActiveClientWorkspaceGateway()) {
    return false;
  }

  return projectCollaborationSchemaAvailability === "unavailable";
}

export function resetProjectCollaborationSchemaAvailabilityForTests(): void {
  projectCollaborationSchemaAvailability = "unknown";
}

export function resetClientIntakeSchemaAvailabilityForTests(): void {
  clientIntakeSchemaAvailability = "unknown";
  clientIntakeSchemaMessage = CLIENT_INTAKE_DRIFT_MESSAGE;
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

function supportsCurrentClientIntakeCompatibility(snapshot: ClientIntakeCompatibilitySnapshot): boolean {
  return (
    snapshot.supportsCurrentCreateJob === true &&
    snapshot.supportsCurrentCreateClientDraft === true &&
    snapshot.hasRequestedServiceKindsColumn === true &&
    snapshot.hasPrimaryServiceKindColumn === true &&
    snapshot.hasServiceNotesColumn === true
  );
}

function supportsLegacyClientIntakeCompatibility(snapshot: ClientIntakeCompatibilitySnapshot): boolean {
  const hasLegacyCreateJob =
    snapshot.supportsLegacyCreateJobV2 === true ||
    snapshot.supportsLegacyCreateJobV1 === true ||
    snapshot.supportsLegacyCreateJobV0 === true;
  const hasLegacyCreateClientDraft =
    snapshot.supportsLegacyCreateClientDraftV1 === true ||
    snapshot.supportsLegacyCreateClientDraftV0 === true;

  return hasLegacyCreateJob && hasLegacyCreateClientDraft;
}

export async function checkClientIntakeCompatibility(): Promise<"available" | "legacy"> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return "available";
  }

  if (clientIntakeSchemaAvailability === "available" || clientIntakeSchemaAvailability === "legacy") {
    return clientIntakeSchemaAvailability;
  }

  if (clientIntakeSchemaAvailability === "unavailable") {
    throw new Error(clientIntakeSchemaMessage);
  }

  const { data, error } = await callRpc("api_get_client_intake_compatibility", {});

  if (error) {
    if (isMissingFunctionError(error, "api_get_client_intake_compatibility")) {
      markClientIntakeSchemaAvailability("legacy");
      return "legacy";
    }

    if (isMissingClientIntakeSchemaError(error)) {
      const compatibilityError = toClientIntakeCompatibilityError(error);
      markClientIntakeSchemaAvailability("unavailable", compatibilityError.message);
      throw compatibilityError;
    }

    throw error;
  }

  const snapshot = (data ?? {}) as ClientIntakeCompatibilitySnapshot;

  if (supportsCurrentClientIntakeCompatibility(snapshot)) {
    markClientIntakeSchemaAvailability("available");
    return "available";
  }

  if (supportsLegacyClientIntakeCompatibility(snapshot)) {
    markClientIntakeSchemaAvailability("legacy", formatClientIntakeDriftMessage(snapshot.missing ?? []));
    return "legacy";
  }

  const compatibilityError = toClientIntakeCompatibilityError(null, snapshot.missing ?? []);
  markClientIntakeSchemaAvailability("unavailable", compatibilityError.message);
  throw compatibilityError;
}

export function getClientIntakeCompatibilityMessage(): string {
  return clientIntakeSchemaMessage;
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

export function isProjectNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message === PROJECT_NOT_FOUND_MESSAGE;
}

function asObject(value: Json | null | undefined): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function sanitizeApprovedRequirementForClient(
  requirement: ApprovedPartRequirementRecord | null,
): ApprovedPartRequirementRecord | null {
  if (!requirement) {
    return null;
  }

  return {
    ...requirement,
    spec_snapshot: sanitizeClientVisibleSpecSnapshot(requirement.spec_snapshot),
  };
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

async function computeFileSha256(file: File): Promise<string> {
  const fileBuffer =
    typeof file.arrayBuffer === "function"
      ? await file.arrayBuffer()
      : new TextEncoder().encode(await file.text()).buffer;
  const hashBuffer = await crypto.subtle.digest("SHA-256", fileBuffer);
  return Array.from(new Uint8Array(hashBuffer), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function hashUploadFiles(files: File[]): Promise<HashedUploadFile[]> {
  return Promise.all(
    files.map(async (file) => ({
      file,
      contentSha256: await computeFileSha256(file),
    })),
  );
}

export async function findDuplicateUploadSelections(files: File[]): Promise<string[]> {
  const hashedFiles = await hashUploadFiles(files);
  const seenHashes = new Set<string>();
  const duplicates: string[] = [];

  for (const hashedFile of hashedFiles) {
    if (seenHashes.has(hashedFile.contentSha256)) {
      duplicates.push(hashedFile.file.name);
      continue;
    }

    seenHashes.add(hashedFile.contentSha256);
  }

  return duplicates;
}

function isStorageObjectExistsError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const value = error as { message?: unknown; statusCode?: unknown; error?: unknown };
  const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
  const errorCode = typeof value.error === "string" ? value.error.toLowerCase() : "";
  const statusCode = typeof value.statusCode === "string" ? value.statusCode : "";

  return (
    statusCode === "409" ||
    message.includes("already exists") ||
    message.includes("duplicate") ||
    errorCode.includes("duplicate")
  );
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

function buildJobPartSummary(
  input: {
    row: ApprovedRequirementJoinRow;
    existing: JobPartSummary | undefined;
    requestedServiceKinds: string[];
    primaryServiceKind: string | null;
    serviceNotes: string | null;
    requestedQuoteQuantities: number[];
    requestedByDate: string | null;
  },
): JobPartSummary {
  const specSnapshot = asObject(input.row.approved_part_requirements?.spec_snapshot);
  const normalizedQuoteQuantities = normalizeRequestedQuoteQuantities(
    input.row.approved_part_requirements?.quote_quantities ?? [],
    input.row.quantity ?? undefined,
  );
  const importedBatch =
    typeof specSnapshot.importedBatch === "string" && specSnapshot.importedBatch.trim().length > 0
      ? specSnapshot.importedBatch.trim().toUpperCase()
      : null;
  const serviceIntent = normalizeRequestedServiceIntent({
    requestedServiceKinds:
      (Array.isArray(specSnapshot.requestedServiceKinds) ? specSnapshot.requestedServiceKinds : [])
        .filter((value): value is string => typeof value === "string")
        .concat(input.requestedServiceKinds),
    primaryServiceKind:
      (typeof specSnapshot.primaryServiceKind === "string" ? specSnapshot.primaryServiceKind : null) ??
      input.primaryServiceKind,
    serviceNotes:
      (typeof specSnapshot.serviceNotes === "string" ? specSnapshot.serviceNotes : null) ??
      input.serviceNotes,
  });

  return {
    jobId: input.row.job_id,
    partNumber: input.row.approved_part_requirements?.part_number ?? null,
    revision: input.row.approved_part_requirements?.revision ?? null,
    description: input.row.approved_part_requirements?.description ?? null,
    requestedServiceKinds: serviceIntent.requestedServiceKinds,
    primaryServiceKind: serviceIntent.primaryServiceKind,
    serviceNotes: serviceIntent.serviceNotes,
    quantity: input.row.quantity ?? null,
    requestedQuoteQuantities:
      normalizedQuoteQuantities.length > 0 ? normalizedQuoteQuantities : input.requestedQuoteQuantities,
    requestedByDate:
      input.row.approved_part_requirements?.requested_by_date ?? input.requestedByDate ?? null,
    importedBatch,
    selectedSupplier: input.existing?.selectedSupplier ?? null,
    selectedPriceUsd: input.existing?.selectedPriceUsd ?? null,
    selectedLeadTimeBusinessDays: input.existing?.selectedLeadTimeBusinessDays ?? null,
  };
}

async function fetchJobSelectionStateByJobIds(jobIds: string[]) {
  if (jobIds.length === 0) {
    return {
      selectedOffersByJobId: new Map<string, VendorQuoteOfferRecord>(),
      requestByJobId: new Map<
        string,
        {
          requestedServiceKinds: string[];
          primaryServiceKind: string | null;
          serviceNotes: string | null;
          requestedQuoteQuantities: number[];
          requestedByDate: string | null;
        }
      >(),
    };
  }

  const { data: jobsData, error: jobsError } = await supabase
    .from("jobs")
    .select(
      "id, selected_vendor_quote_offer_id, requested_service_kinds, primary_service_kind, service_notes, requested_quote_quantities, requested_by_date",
    )
    .in("id", jobIds);

  const jobsWithSelection = ensureData(jobsData, jobsError) as JobSelectedOfferRow[];
  const offerIds = jobsWithSelection
    .map((job) => job.selected_vendor_quote_offer_id)
    .filter((value): value is string => Boolean(value));

  if (offerIds.length === 0) {
    return {
      selectedOffersByJobId: new Map<string, VendorQuoteOfferRecord>(),
      requestByJobId: new Map(
        jobsWithSelection.map((job) => [
          job.id,
          {
            ...normalizeRequestedServiceIntent({
              requestedServiceKinds: job.requested_service_kinds ?? [],
              primaryServiceKind: job.primary_service_kind ?? null,
              serviceNotes: job.service_notes ?? null,
            }),
            requestedQuoteQuantities: normalizeRequestedQuoteQuantities(job.requested_quote_quantities ?? []),
            requestedByDate: job.requested_by_date ?? null,
          },
        ]),
      ),
    };
  }

  const { data: offersData, error: offersError } = await supabase
    .from("vendor_quote_offers")
    .select("*")
    .in("id", offerIds);

  const offers = ensureData(offersData, offersError) as VendorQuoteOfferRecord[];
  const offersById = new Map(offers.map((offer) => [offer.id, offer]));

  return {
    selectedOffersByJobId: new Map(
      jobsWithSelection.flatMap((job) => {
        if (!job.selected_vendor_quote_offer_id) {
          return [];
        }

        const offer = offersById.get(job.selected_vendor_quote_offer_id);
        return offer ? [[job.id, offer] as const] : [];
      }),
    ),
    requestByJobId: new Map(
      jobsWithSelection.map((job) => [
        job.id,
        {
          ...normalizeRequestedServiceIntent({
            requestedServiceKinds: job.requested_service_kinds ?? [],
            primaryServiceKind: job.primary_service_kind ?? null,
            serviceNotes: job.service_notes ?? null,
          }),
          requestedQuoteQuantities: normalizeRequestedQuoteQuantities(job.requested_quote_quantities ?? []),
          requestedByDate: job.requested_by_date ?? null,
        },
      ]),
    ),
  };
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

export async function fetchAppSessionData(): Promise<AppSessionData> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.getSessionData();
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) {
    const authErrorName =
      typeof (userError as { name?: unknown })?.name === "string"
        ? (userError as { name: string }).name
        : userError instanceof Error
          ? userError.name
          : "";

    if (
      (isAuthError(userError) && authErrorName === "AuthSessionMissingError") ||
      authErrorName === "AuthSessionMissingError" ||
      isDeletedAuthUserError(userError) ||
      isInvalidRefreshTokenError(userError)
    ) {
      return {
        user: null,
        memberships: [],
        isVerifiedAuth: false,
        authState:
          isDeletedAuthUserError(userError) || isInvalidRefreshTokenError(userError)
            ? "invalid_session"
            : "anonymous",
      };
    }

    throw userError;
  }

  if (!user) {
    return {
      user: null,
      memberships: [],
      isVerifiedAuth: false,
      authState: "anonymous",
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
    authState: "authenticated",
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
  const [partsResult, filesResult, jobsResult] = await Promise.all([
    supabase
      .from("parts")
      .select(
        "job_id, quantity, approved_part_requirements(part_number, revision, description, quote_quantities, requested_by_date, spec_snapshot)",
      )
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
    supabase
      .from("job_files")
      .select("job_id, normalized_name, original_name, file_kind")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: true }),
    supabase
      .from("jobs")
      .select(
        "id, selected_vendor_quote_offer_id, requested_service_kinds, primary_service_kind, service_notes, requested_quote_quantities, requested_by_date",
      )
      .eq("organization_id", organizationId),
  ]);

  const approvedRequirements = ensureData(
    partsResult.data as unknown as ApprovedRequirementJoinRow[] | null,
    partsResult.error,
  );
  const fileRows = ensureData(filesResult.data as unknown as JobFileSummaryRow[] | null, filesResult.error);
  const jobs = ensureData(jobsResult.data, jobsResult.error) as JobSelectedOfferRow[];
  const { selectedOffersByJobId, requestByJobId } = await fetchJobSelectionStateByJobIds(jobs.map((job) => job.id));

  const summariesByJobId = new Map<string, JobPartSummary>();

  for (const row of approvedRequirements) {
    const selectedOffer = selectedOffersByJobId.get(row.job_id) ?? null;
    const requestDefaults = requestByJobId.get(row.job_id) ?? {
      requestedServiceKinds: [],
      primaryServiceKind: null,
      serviceNotes: null,
      requestedQuoteQuantities: [],
      requestedByDate: null,
    };
    summariesByJobId.set(row.job_id, {
      ...buildJobPartSummary({
        row,
        existing: summariesByJobId.get(row.job_id),
        requestedServiceKinds: requestDefaults.requestedServiceKinds,
        primaryServiceKind: requestDefaults.primaryServiceKind,
        serviceNotes: requestDefaults.serviceNotes,
        requestedQuoteQuantities: requestDefaults.requestedQuoteQuantities,
        requestedByDate: requestDefaults.requestedByDate,
      }),
      selectedSupplier: selectedOffer?.supplier ?? null,
      selectedPriceUsd: selectedOffer?.total_price_usd ?? null,
      selectedLeadTimeBusinessDays: selectedOffer?.lead_time_business_days ?? null,
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
      requestedServiceKinds:
        existingSummary?.requestedServiceKinds ?? requestByJobId.get(row.job_id)?.requestedServiceKinds ?? [],
      primaryServiceKind:
        existingSummary?.primaryServiceKind ?? requestByJobId.get(row.job_id)?.primaryServiceKind ?? null,
      serviceNotes:
        existingSummary?.serviceNotes ?? requestByJobId.get(row.job_id)?.serviceNotes ?? null,
      quantity: existingSummary?.quantity ?? null,
      requestedQuoteQuantities: existingSummary?.requestedQuoteQuantities ?? requestByJobId.get(row.job_id)?.requestedQuoteQuantities ?? [],
      requestedByDate: existingSummary?.requestedByDate ?? requestByJobId.get(row.job_id)?.requestedByDate ?? null,
      importedBatch: existingSummary?.importedBatch ?? null,
      selectedSupplier: existingSummary?.selectedSupplier ?? null,
      selectedPriceUsd: existingSummary?.selectedPriceUsd ?? null,
      selectedLeadTimeBusinessDays: existingSummary?.selectedLeadTimeBusinessDays ?? null,
    });
  }

  return Array.from(summariesByJobId.values());
}

export async function fetchJobPartSummariesByJobIds(jobIds: string[]): Promise<JobPartSummary[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchJobPartSummariesByJobIds(jobIds);
  }

  if (jobIds.length === 0) {
    return [];
  }

  const [partsResult, filesResult, jobSelectionState] = await Promise.all([
    supabase
      .from("parts")
      .select(
        "job_id, quantity, approved_part_requirements(part_number, revision, description, quote_quantities, requested_by_date, spec_snapshot)",
      )
      .in("job_id", jobIds)
      .order("created_at", { ascending: true }),
    supabase
      .from("job_files")
      .select("job_id, normalized_name, original_name, file_kind")
      .in("job_id", jobIds)
      .order("created_at", { ascending: true }),
    fetchJobSelectionStateByJobIds(jobIds),
  ]);

  const approvedRequirements = ensureData(
    partsResult.data as unknown as ApprovedRequirementJoinRow[] | null,
    partsResult.error,
  );
  const fileRows = ensureData(filesResult.data as unknown as JobFileSummaryRow[] | null, filesResult.error);
  const { selectedOffersByJobId, requestByJobId } = jobSelectionState;
  const summariesByJobId = new Map<string, JobPartSummary>();

  for (const row of approvedRequirements) {
    const selectedOffer = selectedOffersByJobId.get(row.job_id) ?? null;
    const requestDefaults = requestByJobId.get(row.job_id) ?? {
      requestedServiceKinds: [],
      primaryServiceKind: null,
      serviceNotes: null,
      requestedQuoteQuantities: [],
      requestedByDate: null,
    };
    summariesByJobId.set(row.job_id, {
      ...buildJobPartSummary({
        row,
        existing: summariesByJobId.get(row.job_id),
        requestedServiceKinds: requestDefaults.requestedServiceKinds,
        primaryServiceKind: requestDefaults.primaryServiceKind,
        serviceNotes: requestDefaults.serviceNotes,
        requestedQuoteQuantities: requestDefaults.requestedQuoteQuantities,
        requestedByDate: requestDefaults.requestedByDate,
      }),
      selectedSupplier: selectedOffer?.supplier ?? null,
      selectedPriceUsd: selectedOffer?.total_price_usd ?? null,
      selectedLeadTimeBusinessDays: selectedOffer?.lead_time_business_days ?? null,
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
      requestedServiceKinds:
        existingSummary?.requestedServiceKinds ?? requestByJobId.get(row.job_id)?.requestedServiceKinds ?? [],
      primaryServiceKind:
        existingSummary?.primaryServiceKind ?? requestByJobId.get(row.job_id)?.primaryServiceKind ?? null,
      serviceNotes:
        existingSummary?.serviceNotes ?? requestByJobId.get(row.job_id)?.serviceNotes ?? null,
      quantity: existingSummary?.quantity ?? null,
      requestedQuoteQuantities: existingSummary?.requestedQuoteQuantities ?? requestByJobId.get(row.job_id)?.requestedQuoteQuantities ?? [],
      requestedByDate: existingSummary?.requestedByDate ?? requestByJobId.get(row.job_id)?.requestedByDate ?? null,
      importedBatch: existingSummary?.importedBatch ?? null,
      selectedSupplier: existingSummary?.selectedSupplier ?? null,
      selectedPriceUsd: existingSummary?.selectedPriceUsd ?? null,
      selectedLeadTimeBusinessDays: existingSummary?.selectedLeadTimeBusinessDays ?? null,
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

export async function fetchClientActivityEventsByJobIds(
  jobIds: string[],
  limitPerJob = 6,
): Promise<ClientActivityEvent[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchClientActivityEventsByJobIds(jobIds, limitPerJob);
  }

  if (jobIds.length === 0) {
    return [];
  }

  const { data, error } = await callRpc("api_list_client_activity_events", {
    p_job_ids: jobIds,
    p_limit_per_job: limitPerJob,
  });

  const events = ensureData(data, error);

  if (!Array.isArray(events)) {
    throw new Error("Expected client activity events to be returned as an array.");
  }

  return events as ClientActivityEvent[];
}

export async function fetchJobAggregate(jobId: string): Promise<JobAggregate> {
  const { data: jobData, error: jobError } = await supabase
    .from("jobs")
    .select("*")
    .eq("id", jobId)
    .single();

  const job = ensureData(jobData as JobRecord | null, jobError);

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
  const vendorArtifactResultResolved =
    vendorQuoteIds.length > 0
      ? await supabase.from("vendor_quote_artifacts").select("*").in("vendor_quote_result_id", vendorQuoteIds)
      : await emptyResponse<VendorQuoteArtifactRecord>();
  const vendorOffersResultResolved =
    vendorQuoteIds.length > 0
      ? await supabase.from("vendor_quote_offers").select("*").in("vendor_quote_result_id", vendorQuoteIds)
      : await emptyResponse<VendorQuoteOfferRecord>();
  const vendorArtifacts = ensureData(
    vendorArtifactResultResolved.data,
    vendorArtifactResultResolved.error,
  ) as VendorQuoteArtifactRecord[];
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
  const artifactMap = new Map<string, VendorQuoteArtifactRecord[]>();

  vendorOffers.forEach((offer) => {
    const current = offerMap.get(offer.vendor_quote_result_id) ?? [];
    current.push(offer);
    offerMap.set(offer.vendor_quote_result_id, current);
  });

  vendorArtifacts.forEach((artifact) => {
    const current = artifactMap.get(artifact.vendor_quote_result_id) ?? [];
    current.push(artifact);
    artifactMap.set(artifact.vendor_quote_result_id, current);
  });

  const vendorQuoteAggregates: VendorQuoteAggregate[] = vendorQuotes.map((quote) => ({
    ...quote,
    artifacts: [...(artifactMap.get(quote.id) ?? [])].sort((left, right) =>
      left.created_at.localeCompare(right.created_at),
    ),
    offers:
      (offerMap.get(quote.id) ?? []).sort((left, right) => {
        if (left.sort_rank !== right.sort_rank) {
          return left.sort_rank - right.sort_rank;
        }

        return (left.total_price_usd ?? Number.MAX_SAFE_INTEGER) - (right.total_price_usd ?? Number.MAX_SAFE_INTEGER);
      }),
  })).sort((left, right) => {
    if (left.requested_quantity !== right.requested_quantity) {
      return left.requested_quantity - right.requested_quantity;
    }

    if (left.part_id !== right.part_id) {
      return left.part_id.localeCompare(right.part_id);
    }

    return left.vendor.localeCompare(right.vendor);
  });
  const sortedOptions = [...options].sort((left, right) => {
    if (left.requested_quantity !== right.requested_quantity) {
      return left.requested_quantity - right.requested_quantity;
    }

    return left.created_at.localeCompare(right.created_at);
  });

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
    options: sortedOptions.filter((option) => option.package_id === pkg.id),
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

async function fetchLatestQuoteRunsByJobIds(jobIds: string[]): Promise<Map<string, QuoteRunRecord>> {
  if (jobIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from("quote_runs")
    .select("*")
    .in("job_id", jobIds)
    .order("created_at", { ascending: false });

  const runs = ensureData(data, error) as QuoteRunRecord[];
  const latestByJobId = new Map<string, QuoteRunRecord>();

  runs.forEach((run) => {
    if (!latestByJobId.has(run.job_id)) {
      latestByJobId.set(run.job_id, run);
    }
  });

  return latestByJobId;
}

export async function fetchClientQuoteWorkspaceByJobIds(
  jobIds: string[],
): Promise<ClientQuoteWorkspaceItem[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchClientQuoteWorkspaceByJobIds(jobIds);
  }

  if (jobIds.length === 0) {
    return [];
  }

  const [jobsResult, filesResult, partsResult, summaries, projectMemberships, latestQuoteRunsByJobId] =
    await Promise.all([
      supabase.from("jobs").select("*").in("id", jobIds).is("archived_at", null),
      supabase.from("job_files").select("*").in("job_id", jobIds).order("created_at", { ascending: true }),
      supabase.from("parts").select("*").in("job_id", jobIds).order("created_at", { ascending: true }),
      fetchJobPartSummariesByJobIds(jobIds),
      fetchProjectJobMembershipsByJobIds(jobIds),
      fetchLatestQuoteRunsByJobIds(jobIds),
    ]);

  const jobs = ensureData(jobsResult.data, jobsResult.error) as JobRecord[];
  const files = ensureData(filesResult.data, filesResult.error) as JobFileRecord[];
  const parts = ensureData(partsResult.data, partsResult.error) as PartRecord[];
  const partIds = parts.map((part) => part.id);
  const latestQuoteRunIds = [...new Set(Array.from(latestQuoteRunsByJobId.values()).map((run) => run.id))];

  const [extractionResult, approvedResult, previewResult, vendorQuoteResult] = await Promise.all([
    partIds.length > 0
      ? supabase.from("drawing_extractions").select("*").in("part_id", partIds)
      : emptyResponse<DrawingExtractionRecord>(),
    partIds.length > 0
      ? supabase.from("approved_part_requirements").select("*").in("part_id", partIds)
      : emptyResponse<ApprovedPartRequirementRecord>(),
    partIds.length > 0
      ? supabase
          .from("drawing_preview_assets")
          .select("*")
          .in("part_id", partIds)
          .order("page_number", { ascending: true })
      : emptyResponse<DrawingPreviewAssetRecord>(),
    latestQuoteRunIds.length > 0
      ? supabase.from("vendor_quote_results").select("*").in("quote_run_id", latestQuoteRunIds)
      : emptyResponse<VendorQuoteResultRecord>(),
  ]);

  const extractions = ensureData(extractionResult.data, extractionResult.error) as DrawingExtractionRecord[];
  const approvedRequirements = ensureData(
    approvedResult.data,
    approvedResult.error,
  ) as ApprovedPartRequirementRecord[];
  const previewAssets = ensureData(
    previewResult.data,
    previewResult.error,
  ) as DrawingPreviewAssetRecord[];
  const vendorQuotes = ensureData(
    vendorQuoteResult.data,
    vendorQuoteResult.error,
  ) as VendorQuoteResultRecord[];
  const vendorQuoteIds = vendorQuotes.map((quote) => quote.id);

  const [artifactResult, offerResult] = await Promise.all([
    vendorQuoteIds.length > 0
      ? supabase.from("vendor_quote_artifacts").select("*").in("vendor_quote_result_id", vendorQuoteIds)
      : emptyResponse<VendorQuoteArtifactRecord>(),
    vendorQuoteIds.length > 0
      ? supabase.from("vendor_quote_offers").select("*").in("vendor_quote_result_id", vendorQuoteIds)
      : emptyResponse<VendorQuoteOfferRecord>(),
  ]);

  const vendorArtifacts = ensureData(
    artifactResult.data,
    artifactResult.error,
  ) as VendorQuoteArtifactRecord[];
  const vendorOffers = ensureData(offerResult.data, offerResult.error) as VendorQuoteOfferRecord[];

  const summariesByJobId = new Map(summaries.map((summary) => [summary.jobId, summary]));
  const filesByJobId = new Map<string, JobFileRecord[]>();
  const partsByJobId = new Map<string, PartRecord[]>();
  const extractionByPartId = new Map(extractions.map((item) => [item.part_id, item]));
  const approvedByPartId = new Map(
    approvedRequirements.map((item) => [item.part_id, sanitizeApprovedRequirementForClient(item)]),
  );
  const previewAssetsByPartId = new Map<string, DrawingPreviewAssetRecord[]>();
  const fileById = new Map(files.map((file) => [file.id, file]));
  const projectIdsByJobId = new Map<string, string[]>();
  const vendorOffersByQuoteId = new Map<string, VendorQuoteOfferRecord[]>();
  const vendorArtifactsByQuoteId = new Map<string, VendorQuoteArtifactRecord[]>();

  files.forEach((file) => {
    const jobFiles = filesByJobId.get(file.job_id) ?? [];
    jobFiles.push(file);
    filesByJobId.set(file.job_id, jobFiles);
  });

  parts.forEach((part) => {
    const jobParts = partsByJobId.get(part.job_id) ?? [];
    jobParts.push(part);
    partsByJobId.set(part.job_id, jobParts);
  });

  previewAssets.forEach((asset) => {
    const assets = previewAssetsByPartId.get(asset.part_id) ?? [];
    assets.push(asset);
    previewAssetsByPartId.set(asset.part_id, assets);
  });

  projectMemberships.forEach((membership) => {
    const projectIds = projectIdsByJobId.get(membership.job_id) ?? [];
    if (!projectIds.includes(membership.project_id)) {
      projectIds.push(membership.project_id);
    }
    projectIdsByJobId.set(membership.job_id, projectIds);
  });

  vendorOffers.forEach((offer) => {
    const offers = vendorOffersByQuoteId.get(offer.vendor_quote_result_id) ?? [];
    offers.push(offer);
    vendorOffersByQuoteId.set(offer.vendor_quote_result_id, offers);
  });

  vendorArtifacts.forEach((artifact) => {
    const artifacts = vendorArtifactsByQuoteId.get(artifact.vendor_quote_result_id) ?? [];
    artifacts.push(artifact);
    vendorArtifactsByQuoteId.set(artifact.vendor_quote_result_id, artifacts);
  });

  const vendorQuoteAggregates: VendorQuoteAggregate[] = vendorQuotes
    .map((quote) => ({
      ...quote,
      artifacts: [...(vendorArtifactsByQuoteId.get(quote.id) ?? [])].sort((left, right) =>
        left.created_at.localeCompare(right.created_at),
      ),
      offers: [...(vendorOffersByQuoteId.get(quote.id) ?? [])].sort((left, right) => {
        if (left.sort_rank !== right.sort_rank) {
          return left.sort_rank - right.sort_rank;
        }

        return (left.total_price_usd ?? Number.MAX_SAFE_INTEGER) - (right.total_price_usd ?? Number.MAX_SAFE_INTEGER);
      }),
    }))
    .sort((left, right) => {
      if (left.requested_quantity !== right.requested_quantity) {
        return left.requested_quantity - right.requested_quantity;
      }

      if (left.part_id !== right.part_id) {
        return left.part_id.localeCompare(right.part_id);
      }

      return left.vendor.localeCompare(right.vendor);
    });

  const jobById = new Map(jobs.map((job) => [job.id, job]));

  return jobIds.flatMap((jobId) => {
    const job = jobById.get(jobId);

    if (!job) {
      return [];
    }

    const jobFiles = filesByJobId.get(jobId) ?? [];
    const jobParts = partsByJobId.get(jobId) ?? [];
    const primaryPart = jobParts[0] ?? null;
    const partWithRelations =
      primaryPart === null
        ? null
        : {
            ...primaryPart,
            cadFile: primaryPart.cad_file_id ? fileById.get(primaryPart.cad_file_id) ?? null : null,
            drawingFile: primaryPart.drawing_file_id ? fileById.get(primaryPart.drawing_file_id) ?? null : null,
            extraction: extractionByPartId.get(primaryPart.id) ?? null,
            approvedRequirement: approvedByPartId.get(primaryPart.id) ?? null,
            vendorQuotes: vendorQuoteAggregates.filter((quote) => quote.part_id === primaryPart.id),
          };

    return [
      {
        job,
        files: jobFiles,
        summary: summariesByJobId.get(jobId) ?? null,
        part: partWithRelations,
        projectIds: projectIdsByJobId.get(jobId) ?? [],
        drawingPreview:
          primaryPart === null
            ? normalizeDrawingPreview(null, [])
            : normalizeDrawingPreview(
                extractionByPartId.get(primaryPart.id) ?? null,
                previewAssetsByPartId.get(primaryPart.id) ?? [],
              ),
        latestQuoteRun: latestQuoteRunsByJobId.get(jobId) ?? null,
      } satisfies ClientQuoteWorkspaceItem,
    ];
  });
}

export async function fetchClientPackage(packageId: string): Promise<ClientPackageAggregate> {
  const { data: packageData, error: packageError } = await supabase
    .from("published_quote_packages")
    .select("*")
    .eq("id", packageId)
    .single();

  const pkg = ensureData(packageData as PublishedQuotePackageRecord | null, packageError);

  const [jobResult, optionsResult, selectionResult] = await Promise.all([
    supabase.from("jobs").select("*").eq("id", pkg.job_id).single(),
    supabase
      .from("published_quote_options")
      .select("*")
      .eq("package_id", packageId)
      .order("requested_quantity", { ascending: true })
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
  const { data, error } = await callRpc("api_create_self_service_organization", {
    p_organization_name: organizationName,
  });

  return ensureData(data, error);
}

export async function fetchOrganizationMemberships(
  organizationId: string,
): Promise<OrganizationMembershipSummary[]> {
  const { data, error } = await callRpc("api_list_organization_memberships", {
    p_organization_id: organizationId,
  });

  return ensureData(data, error) as OrganizationMembershipSummary[];
}

export async function updateOrganizationMembershipRole(input: {
  membershipId: string;
  role: AppRole;
}): Promise<string> {
  const { data, error } = await callRpc("api_update_organization_membership_role", {
    p_membership_id: input.membershipId,
    p_role: input.role,
  });

  return ensureData(data, error);
}

async function fetchAllAccessibleJobs(options: { archived?: boolean } = {}): Promise<JobRecord[]> {
  const query = supabase
    .from("jobs")
    .select("*")
    .order(options.archived ? "archived_at" : "created_at", { ascending: false });

  const { data, error } = await (options.archived
    ? query.not("archived_at", "is", null)
    : query.is("archived_at", null));
  return ensureData(data, error);
}

export async function fetchAccessibleJobs(): Promise<JobRecord[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchAccessibleJobs();
  }

  return fetchAllAccessibleJobs({ archived: false });
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

async function fetchJobsByIds(jobIds: string[], options: { archived: boolean }): Promise<JobRecord[]> {
  if (jobIds.length === 0) {
    return [];
  }

  const query = supabase.from("jobs").select("*").in("id", jobIds);
  const { data, error } = await (options.archived
    ? query.not("archived_at", "is", null)
    : query.is("archived_at", null));
  return ensureData(data, error) as JobRecord[];
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

export async function fetchArchivedJobs(): Promise<ArchivedJobSummary[]> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchArchivedJobs();
  }

  const jobs = await fetchAllAccessibleJobs({ archived: true });

  if (jobs.length === 0) {
    return [];
  }

  const jobIds = jobs.map((job) => job.id);
  const [summaries, projectMemberships] = await Promise.all([
    fetchJobPartSummariesByJobIds(jobIds),
    fetchProjectJobMembershipsByJobIds(jobIds),
  ]);

  const projectIds = [...new Set(projectMemberships.map((membership) => membership.project_id))];
  const projectNamesResult =
    projectIds.length === 0
      ? { data: [], error: null }
      : await supabase.from("projects").select("id, name").in("id", projectIds);
  const projectNamesById =
    projectIds.length === 0
      ? new Map<string, string>()
      : new Map(
          (ensureData(projectNamesResult.data, projectNamesResult.error) as Array<{ id: string; name: string }>).map(
            (project) => [project.id, project.name],
          ),
        );
  const summariesByJobId = new Map(summaries.map((summary) => [summary.jobId, summary]));

  return jobs.map((job) => ({
    job,
    summary: summariesByJobId.get(job.id) ?? null,
    projectNames: [
      ...new Set(
        projectMemberships
          .filter((membership) => membership.job_id === job.id)
          .map((membership) => projectNamesById.get(membership.project_id))
          .filter((value): value is string => Boolean(value)),
      ),
    ],
  }));
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

export async function fetchJobsByProject(projectId: string): Promise<JobRecord[]> {
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

  const { data, error } = await supabase
    .from("jobs")
    .select("*")
    .in(
      "id",
      memberships.map((membership) => membership.job_id),
    )
    .is("archived_at", null)
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
    .is("archived_at", null)
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

export async function fetchPartDetail(jobId: string): Promise<PartDetailAggregate> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.fetchPartDetail(jobId);
  }

  const [jobAggregate, partSummaries, projectMemberships] = await Promise.all([
    fetchJobAggregate(jobId),
    fetchJobPartSummariesByJobIds([jobId]),
    fetchProjectJobMembershipsByJobIds([jobId]),
  ]);

  if (jobAggregate.job.archived_at) {
    throw new Error("Archived parts are only available from the Archive panel.");
  }

  const part = jobAggregate.parts[0] ?? null;
  const previewAssets =
    part !== null
      ? ((await supabase.from("drawing_preview_assets").select("*").eq("part_id", part.id).order("page_number", {
          ascending: true,
        })).data as DrawingPreviewAssetRecord[] | null) ?? []
      : [];

  const summary = partSummaries[0] ?? null;
  const [allSummaries, activeJobs] = await Promise.all([
    fetchJobPartSummariesByOrganization(jobAggregate.job.organization_id),
    fetchAccessibleJobs(),
  ]);
  const activeJobIdSet = new Set(activeJobs.map((job) => job.id));
  const revisionSiblings =
    summary?.partNumber
      ? allSummaries
          .filter(
            (candidate) =>
              candidate.partNumber === summary.partNumber &&
              candidate.jobId !== jobId &&
              activeJobIdSet.has(candidate.jobId),
          )
          .map((candidate) => ({
            jobId: candidate.jobId,
            revision: candidate.revision,
            title: `${candidate.partNumber}${candidate.revision ? ` rev ${candidate.revision}` : ""}`,
          }))
          .sort((left, right) => (left.revision ?? "").localeCompare(right.revision ?? ""))
      : [];

  return {
    job: jobAggregate.job,
    files: jobAggregate.files,
    summary,
    packages: jobAggregate.packages.map((pkg) => pkg as PublishedQuotePackageRecord),
    part,
    projectIds: projectMemberships.map((membership) => membership.project_id),
    drawingPreview: normalizeDrawingPreview(part?.extraction ?? null, previewAssets),
    latestQuoteRun: jobAggregate.quoteRuns[0] ?? null,
    revisionSiblings,
  };
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
    // Backward-compatible fallback for environments that still expose the
    // older one-argument function signature.
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

type CreateJobInput = {
  organizationId: string;
  title: string;
  description?: string;
  source: string;
  tags?: string[];
  requestedServiceKinds?: string[];
  primaryServiceKind?: string | null;
  serviceNotes?: string | null;
  requestedQuoteQuantities?: number[];
  requestedByDate?: string | null;
};

function buildCurrentCreateJobArgs(input: CreateJobInput) {
  return {
    p_organization_id: input.organizationId,
    p_title: input.title,
    p_description: input.description ?? null,
    p_source: input.source,
    p_tags: input.tags ?? [],
    p_requested_service_kinds: input.requestedServiceKinds ?? [],
    p_primary_service_kind: input.primaryServiceKind ?? null,
    p_service_notes: input.serviceNotes ?? null,
    p_requested_quote_quantities: input.requestedQuoteQuantities ?? [],
    p_requested_by_date: input.requestedByDate ?? null,
  };
}

async function callLegacyCreateJob(input: CreateJobInput): Promise<PostgrestSingleResponse<unknown>> {
  const attempts: Array<Record<string, unknown>> = [
    {
      p_organization_id: input.organizationId,
      p_title: input.title,
      p_description: input.description ?? null,
      p_source: input.source,
      p_tags: input.tags ?? [],
      p_requested_quote_quantities: input.requestedQuoteQuantities ?? [],
      p_requested_by_date: input.requestedByDate ?? null,
    },
    {
      p_organization_id: input.organizationId,
      p_title: input.title,
      p_description: input.description ?? null,
      p_source: input.source,
      p_tags: input.tags ?? [],
    },
    {
      p_organization_id: input.organizationId,
      p_title: input.title,
      p_description: input.description ?? null,
      p_source: input.source,
    },
  ];

  let lastResponse: PostgrestSingleResponse<unknown> = {
    data: null,
    error: null,
    count: null,
    status: 200,
    statusText: "OK",
  };

  for (const args of attempts) {
    const response = await callUntypedRpc("api_create_job", args);
    lastResponse = response;

    if (!response.error || !isMissingFunctionError(response.error, "api_create_job")) {
      return response;
    }
  }

  return lastResponse;
}

type CreateClientDraftRpcInput = {
  title: string;
  description?: string;
  projectId?: string | null;
  tags?: string[];
  requestedServiceKinds?: string[];
  primaryServiceKind?: string | null;
  serviceNotes?: string | null;
  requestedQuoteQuantities?: number[];
  requestedByDate?: string | null;
};

async function callLegacyCreateClientDraft(
  input: CreateClientDraftRpcInput,
): Promise<PostgrestSingleResponse<unknown>> {
  const attempts: Array<Record<string, unknown>> = [
    {
      p_title: input.title,
      p_description: input.description ?? null,
      p_project_id: input.projectId ?? null,
      p_tags: input.tags ?? [],
      p_requested_quote_quantities: input.requestedQuoteQuantities ?? [],
      p_requested_by_date: input.requestedByDate ?? null,
    },
    {
      p_title: input.title,
      p_description: input.description ?? null,
      p_project_id: input.projectId ?? null,
      p_tags: input.tags ?? [],
    },
  ];

  let lastResponse: PostgrestSingleResponse<unknown> = {
    data: null,
    error: null,
    count: null,
    status: 200,
    statusText: "OK",
  };

  for (const args of attempts) {
    const response = await callUntypedRpc("api_create_client_draft", args);
    lastResponse = response;

    if (!response.error || !isMissingFunctionError(response.error, "api_create_client_draft")) {
      return response;
    }
  }

  return lastResponse;
}

export async function createClientDraft(input: ClientDraftInput): Promise<string> {
  const { data, error } = await callRpc("api_create_client_draft", {
    p_title: input.title,
    p_description: input.description ?? null,
    p_project_id: input.projectId ?? null,
    p_tags: input.tags ?? [],
    p_requested_service_kinds: input.requestedServiceKinds ?? [],
    p_primary_service_kind: input.primaryServiceKind ?? null,
    p_service_notes: input.serviceNotes ?? null,
    p_requested_quote_quantities: input.requestedQuoteQuantities ?? [],
    p_requested_by_date: input.requestedByDate ?? null,
  });

  if (!error) {
    return ensureData(data, null);
  }

  if (isMissingFunctionError(error, "api_create_client_draft")) {
    const legacyResponse = await callLegacyCreateClientDraft(input);

    if (!legacyResponse.error) {
      return ensureData(legacyResponse.data as string | null, null);
    }

    if (!input.projectId && isMissingFunctionError(legacyResponse.error, "api_create_client_draft")) {
      const appSession = await fetchAppSessionData();
      const fallbackMembership =
        appSession.memberships.find((membership) => membership.role === "client") ??
        appSession.memberships[0];

      if (!fallbackMembership) {
        throw legacyResponse.error;
      }

      return createJob({
        organizationId: fallbackMembership.organizationId,
        title: input.title,
        description: input.description,
        source: "client_home",
        tags: input.tags,
        requestedServiceKinds: input.requestedServiceKinds,
        primaryServiceKind: input.primaryServiceKind,
        serviceNotes: input.serviceNotes,
        requestedQuoteQuantities: input.requestedQuoteQuantities,
        requestedByDate: input.requestedByDate,
      });
    }

    if (isMissingClientIntakeSchemaError(legacyResponse.error)) {
      throw toClientIntakeCompatibilityError(legacyResponse.error);
    }

    throw legacyResponse.error;
  }

  // Backward-compatible fallback for environments that have not applied
  // the shared-project migration with api_create_client_draft yet.
  if (!input.projectId && isMissingClientIntakeSchemaError(error)) {
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
      requestedServiceKinds: input.requestedServiceKinds,
      primaryServiceKind: input.primaryServiceKind,
      serviceNotes: input.serviceNotes,
      requestedQuoteQuantities: input.requestedQuoteQuantities,
      requestedByDate: input.requestedByDate,
    });
  }

  if (isMissingClientIntakeSchemaError(error)) {
    throw toClientIntakeCompatibilityError(error);
  }

  throw error;
}

export async function updateClientPartRequest(input: ClientPartRequestUpdateInput): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.updateClientPartRequest(input);
  }

  const { data, error } = await callRpc("api_update_client_part_request", {
    p_job_id: input.jobId,
    p_requested_service_kinds: input.requestedServiceKinds,
    p_primary_service_kind: input.primaryServiceKind ?? null,
    p_service_notes: input.serviceNotes ?? null,
    p_description: input.description ?? null,
    p_part_number: input.partNumber ?? null,
    p_revision: input.revision ?? null,
    p_material: input.material,
    p_finish: input.finish ?? null,
    p_tightest_tolerance_inch: input.tightestToleranceInch ?? null,
    p_process: input.process ?? null,
    p_notes: input.notes ?? null,
    p_quantity: input.quantity,
    p_requested_quote_quantities: input.requestedQuoteQuantities,
    p_requested_by_date: input.requestedByDate ?? null,
    p_shipping: input.shipping,
    p_certifications: input.certifications,
    p_sourcing: input.sourcing,
    p_release: input.release,
  });

  return ensureData(data, error);
}

export async function createJobsFromUploadFiles(input: {
  files: File[];
  prompt?: string;
  projectId?: string | null;
}): Promise<{ jobIds: string[]; projectId: string | null }> {
  const groups = groupUploadFiles(input.files);
  const requestIntake = parseRequestIntake(input.prompt ?? "");

  if (groups.length === 0) {
    return { jobIds: [], projectId: input.projectId ?? null };
  }

  let targetProjectId = input.projectId ?? null;

  if (!targetProjectId && groups.length > 1) {
    targetProjectId = await createProject({
      name: buildAutoProjectName(input.prompt ?? "", groups),
    });
  }

  const jobIds: string[] = [];

  for (const group of groups) {
    const title = buildDraftTitleFromPrompt("", group.files);
    const jobId = await createClientDraft({
      title,
      description: input.prompt?.trim() || undefined,
      projectId: targetProjectId,
      tags: [],
      requestedServiceKinds: requestIntake.requestedServiceKinds,
      primaryServiceKind: requestIntake.primaryServiceKind,
      serviceNotes: requestIntake.serviceNotes,
      requestedQuoteQuantities: requestIntake.requestedQuoteQuantities,
      requestedByDate: requestIntake.requestedByDate,
    });

    await uploadFilesToJob(jobId, group.files);
    await reconcileJobParts(jobId);
    await requestExtraction(jobId);
    jobIds.push(jobId);
  }

  return { jobIds, projectId: targetProjectId };
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

export async function archiveJob(jobId: string): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.archiveJob(jobId);
  }

  const { data, error } = await callRpc("api_archive_job", {
    p_job_id: jobId,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function unarchiveJob(jobId: string): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.unarchiveJob(jobId);
  }

  const { data, error } = await callRpc("api_unarchive_job", {
    p_job_id: jobId,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function deleteArchivedJob(jobId: string): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.deleteArchivedJob(jobId);
  }

  const { data, error } = await callRpc("api_delete_archived_job", {
    p_job_id: jobId,
  });

  return ensureProjectCollaborationData(data, error);
}

export async function setJobSelectedVendorQuoteOffer(jobId: string, offerId: string | null): Promise<string> {
  const fixtureGateway = getActiveClientWorkspaceGateway();

  if (fixtureGateway) {
    return fixtureGateway.setJobSelectedVendorQuoteOffer(jobId, offerId);
  }

  const { data, error } = await callRpc("api_set_job_selected_vendor_quote_offer", {
    p_job_id: jobId,
    p_vendor_quote_offer_id: offerId,
  });

  return ensureData(data, error);
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

export async function createJob(input: CreateJobInput): Promise<string> {
  const { data, error } = await callRpc("api_create_job", buildCurrentCreateJobArgs(input));

  if (!error) {
    return ensureData(data, null);
  }

  if (isMissingFunctionError(error, "api_create_job")) {
    const legacyResponse = await callLegacyCreateJob(input);

    if (!legacyResponse.error) {
      return ensureData(legacyResponse.data as string | null, null);
    }

    if (isMissingClientIntakeSchemaError(legacyResponse.error)) {
      throw toClientIntakeCompatibilityError(legacyResponse.error);
    }

    throw legacyResponse.error;
  }

  if (isMissingClientIntakeSchemaError(error)) {
    throw toClientIntakeCompatibilityError(error);
  }

  throw error;
}

export async function uploadFilesToJob(jobId: string, files: File[]): Promise<UploadFilesToJobSummary> {
  const hashedFiles = await hashUploadFiles(files);
  const seenHashes = new Set<string>();
  const duplicateNames: string[] = [];
  let uploadedCount = 0;
  let reusedCount = 0;

  for (const hashedFile of hashedFiles) {
    const { file, contentSha256 } = hashedFile;

    if (seenHashes.has(contentSha256)) {
      duplicateNames.push(file.name);
      toast.error(`${file.name} is duplicated in this upload batch and was skipped.`);
      continue;
    }

    seenHashes.add(contentSha256);

    const fileKind = inferFileKind(file.name);
    const { data, error } = await callRpc("api_prepare_job_file_upload", {
      p_job_id: jobId,
      p_original_name: file.name,
      p_file_kind: fileKind,
      p_mime_type: file.type || null,
      p_size_bytes: file.size,
      p_content_sha256: contentSha256,
    });

    const prepareResult = ensureData(data, error) as PrepareJobFileUploadResult;

    if (prepareResult.status === "duplicate_in_job") {
      duplicateNames.push(file.name);
      toast.error(`${file.name} is already attached to this part.`);
      continue;
    }

    if (prepareResult.status === "reused") {
      reusedCount += 1;
      continue;
    }

    const { error: storageError } = await supabase.storage
      .from(prepareResult.storageBucket)
      .upload(prepareResult.storagePath, file, { upsert: false });

    if (storageError && !isStorageObjectExistsError(storageError)) {
      throw storageError;
    }

    const { error: finalizeError } = await callRpc("api_finalize_job_file_upload", {
      p_job_id: jobId,
      p_storage_bucket: prepareResult.storageBucket,
      p_storage_path: prepareResult.storagePath,
      p_original_name: file.name,
      p_file_kind: fileKind,
      p_mime_type: file.type || null,
      p_size_bytes: file.size,
      p_content_sha256: contentSha256,
    });

    if (finalizeError) {
      throw finalizeError;
    }

    uploadedCount += 1;
  }

  if (reusedCount > 0) {
    toast.success(`Reused ${reusedCount} existing file${reusedCount === 1 ? "" : "s"} from your workspace.`);
  }

  return {
    uploadedCount,
    reusedCount,
    duplicateNames,
  };
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
  const { data, error } = await callRpc("api_reconcile_job_parts", {
    p_job_id: jobId,
  });

  return ensureData(data, error) as Record<string, number>;
}

export async function requestExtraction(jobId: string): Promise<number> {
  const { data, error } = await callRpc("api_request_extraction", {
    p_job_id: jobId,
  });

  return ensureData(data, error);
}

export async function approveJobRequirements(
  jobId: string,
  requirements: ApprovedPartRequirement[],
): Promise<number> {
  const { data, error } = await callRpc("api_approve_job_requirements", {
    p_job_id: jobId,
    p_requirements: requirements,
  });

  return ensureData(data, error);
}

export async function startQuoteRun(
  jobId: string,
  autoPublishRequested = false,
): Promise<string> {
  const { data, error } = await callRpc("api_start_quote_run", {
    p_job_id: jobId,
    p_auto_publish_requested: autoPublishRequested,
  });

  return ensureData(data, error);
}

export async function enqueueDebugVendorQuote(input: {
  jobId: string;
  quoteRunId: string;
  partId: string;
  vendor: VendorName;
  requestedQuantity: number;
}): Promise<string> {
  const { data: quoteResultData, error: quoteResultError } = await untypedSupabase
    .from("vendor_quote_results")
    .select("id, organization_id, status")
    .eq("quote_run_id", input.quoteRunId)
    .eq("part_id", input.partId)
    .eq("vendor", input.vendor)
    .eq("requested_quantity", input.requestedQuantity)
    .maybeSingle();

  if (quoteResultError) {
    throw quoteResultError;
  }

  const quoteResult = quoteResultData as Pick<VendorQuoteResultRecord, "id" | "organization_id" | "status"> | null;

  if (!quoteResult) {
    throw new Error("No matching vendor quote lane exists for this part and quantity.");
  }

  const { data: queueRows, error: queueError } = await untypedSupabase
    .from("work_queue")
    .select("id, status, payload")
    .eq("job_id", input.jobId)
    .eq("quote_run_id", input.quoteRunId)
    .eq("part_id", input.partId)
    .eq("task_type", "run_vendor_quote")
    .in("status", ["queued", "running"]);

  const existingTasks = ensureData(queueRows, queueError) as Pick<
    WorkQueueRecord,
    "id" | "status" | "payload"
  >[];

  const matchingTask = existingTasks.find((task) => {
    const payload = task.payload && typeof task.payload === "object" && !Array.isArray(task.payload)
      ? (task.payload as Record<string, unknown>)
      : {};

    return (
      payload.vendor === input.vendor &&
      Number(payload.requestedQuantity ?? 0) === input.requestedQuantity
    );
  });

  if (matchingTask) {
    throw new Error("A Xometry quote task is already queued or running for this part and quantity.");
  }

  const { data: insertedTaskData, error: insertError } = await (insertUntyped("work_queue", {
      organization_id: quoteResult.organization_id,
      job_id: input.jobId,
      part_id: input.partId,
      quote_run_id: input.quoteRunId,
      task_type: "run_vendor_quote",
      status: "queued",
      payload: {
        quoteRunId: input.quoteRunId,
        partId: input.partId,
        vendor: input.vendor,
        vendorQuoteResultId: quoteResult.id,
        requestedQuantity: input.requestedQuantity,
        source: "xometry-debug-submit",
      },
    })
    .select("id")
    .single() as Promise<PostgrestSingleResponse<Pick<WorkQueueRecord, "id">>>);

  return ensureData(insertedTaskData?.id ?? null, insertError);
}

export async function fetchWorkerReadiness(): Promise<WorkerReadinessSnapshot> {
  const baseUrl = import.meta.env.VITE_WORKER_BASE_URL?.trim();

  if (!baseUrl) {
    return {
      reachable: false,
      ready: null,
      workerName: null,
      workerMode: null,
      status: null,
      readinessIssues: [],
      message: "Set VITE_WORKER_BASE_URL to enable the worker readiness probe.",
      url: null,
    };
  }

  const targetUrl = new URL("/readyz", baseUrl).toString();
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      signal: controller.signal,
    });
    const payload = (await response.json()) as Record<string, unknown>;

    return {
      reachable: true,
      ready: typeof payload.ready === "boolean" ? payload.ready : response.ok,
      workerName: typeof payload.workerName === "string" ? payload.workerName : null,
      workerMode: typeof payload.workerMode === "string" ? payload.workerMode : null,
      status: typeof payload.status === "string" ? payload.status : null,
      readinessIssues: Array.isArray(payload.readinessIssues)
        ? payload.readinessIssues.map(String)
        : [],
      message: response.ok ? null : `Worker readiness probe returned HTTP ${response.status}.`,
      url: targetUrl,
    };
  } catch (error) {
    return {
      reachable: false,
      ready: null,
      workerName: null,
      workerMode: null,
      status: null,
      readinessIssues: [],
      message: error instanceof Error ? error.message : "Unable to reach the worker readiness probe.",
      url: targetUrl,
    };
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function getQuoteRunReadiness(
  quoteRunId: string,
): Promise<QuoteRunReadiness> {
  const { data, error } = await callRpc("api_get_quote_run_readiness", {
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
  const { data, error } = await callRpc("api_publish_quote_package", {
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
  const { data, error } = await callRpc("api_record_manual_vendor_quote", {
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
  const { data, error } = await callRpc("api_select_quote_option", {
    p_package_id: input.packageId,
    p_option_id: input.optionId,
    p_note: input.note ?? null,
  });

  return ensureData(data, error);
}
