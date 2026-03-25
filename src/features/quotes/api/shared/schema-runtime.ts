import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";

export const PROJECT_COLLABORATION_UNAVAILABLE_MESSAGE =
  "Projects are unavailable in this environment until the shared workspace schema is applied.";
export const JOB_ARCHIVING_UNAVAILABLE_MESSAGE =
  "Part archiving is unavailable in this environment until the archive schema is applied.";
export const ARCHIVED_JOB_DELETE_UNAVAILABLE_MESSAGE =
  "Archived part deletion is unavailable until the latest archive delete migrations are applied and the PostgREST schema cache is refreshed.";
export const PROJECT_NOT_FOUND_MESSAGE = "Project not found.";
export const CLIENT_INTAKE_EXPECTED_MIGRATION = "20260313143000_add_request_service_intent.sql";
export const CLIENT_INTAKE_DRIFT_MESSAGE =
  "This environment is missing the latest client intake schema. Apply the latest Supabase migrations, including " +
  `\`${CLIENT_INTAKE_EXPECTED_MIGRATION}\`, and refresh the PostgREST schema cache.`;
export const CLIENT_QUOTE_WORKSPACE_EXPECTED_MIGRATION =
  "20260319113000_add_client_quote_workspace_projection.sql";
export const CLIENT_QUOTE_WORKSPACE_DRIFT_MESSAGE =
  "Quote comparison data is unavailable in this environment until the latest Supabase migrations are applied, including " +
  `\`${CLIENT_QUOTE_WORKSPACE_EXPECTED_MIGRATION}\`, and the PostgREST schema cache is refreshed.`;

export type ProjectCollaborationSchemaAvailability = "unknown" | "available" | "unavailable";
export type JobArchivingSchemaAvailability = "unknown" | "available" | "unavailable";
export type ClientActivityFeedAvailability = "unknown" | "available" | "unavailable";
export type ClientIntakeSchemaAvailability = "unknown" | "available" | "legacy" | "unavailable";

export type ClientIntakeCompatibilitySnapshot = {
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
let jobArchivingSchemaAvailability: JobArchivingSchemaAvailability = "unknown";
let clientActivityFeedAvailability: ClientActivityFeedAvailability = "unknown";
let clientIntakeSchemaAvailability: ClientIntakeSchemaAvailability = "unknown";
let clientIntakeSchemaMessage = CLIENT_INTAKE_DRIFT_MESSAGE;

export const PROJECT_COLLABORATION_IDENTIFIERS = [
  "public.projects",
  "public.jobs",
  "public.project_memberships",
  "public.project_invites",
  "public.project_jobs",
  "project_jobs",
  "public.user_pinned_projects",
  "api_unarchive_project",
  "api_create_project",
  "api_update_project",
  "api_delete_project",
  "api_invite_project_member",
  "api_accept_project_invite",
  "api_remove_project_member",
  "api_assign_job_to_project",
  "api_remove_job_from_project",
  "api_list_project_assignee_profiles",
  "projects.archived_at",
  "project_row.archived_at",
] as const;

export const JOB_ARCHIVING_IDENTIFIERS = [
  "api_archive_job",
  "api_unarchive_job",
  "api_delete_archived_job",
  "jobs.archived_at",
  "job_row.archived_at",
] as const;

export const DRAWING_PREVIEW_ASSET_IDENTIFIERS = [
  "public.drawing_preview_assets",
  "drawing_preview_assets",
  "page_number",
] as const;

export const DEBUG_EXTRACTION_RUN_IDENTIFIERS = [
  "public.debug_extraction_runs",
  "debug_extraction_runs",
  "requested_model",
] as const;

export const CLIENT_ACTIVITY_IDENTIFIERS = ["api_list_client_activity_events"] as const;
export const QUOTE_REQUEST_IDENTIFIERS = ["public.quote_requests", "quote_requests", "quote_request_status"] as const;
export const CLIENT_PART_METADATA_IDENTIFIERS = ["api_list_client_part_metadata"] as const;
export const CLIENT_QUOTE_WORKSPACE_IDENTIFIERS = ["api_list_client_quote_workspace"] as const;

export const JOB_SELECTION_COLUMN_SETS = [
  "id, selected_vendor_quote_offer_id, requested_service_kinds, primary_service_kind, service_notes, requested_quote_quantities, requested_by_date",
  "id, selected_vendor_quote_offer_id, requested_quote_quantities, requested_by_date",
  "id, selected_vendor_quote_offer_id",
] as const;

export const CLIENT_INTAKE_IDENTIFIERS = [
  "api_create_job",
  "api_create_client_draft",
  "api_get_client_intake_compatibility",
  "requested_service_kinds",
  "primary_service_kind",
  "service_notes",
] as const;

export function markProjectCollaborationSchemaAvailability(
  next: Exclude<ProjectCollaborationSchemaAvailability, "unknown">,
) {
  projectCollaborationSchemaAvailability = next;
}

export function markJobArchivingSchemaAvailability(next: Exclude<JobArchivingSchemaAvailability, "unknown">) {
  jobArchivingSchemaAvailability = next;
}

export function markClientActivityFeedAvailability(next: Exclude<ClientActivityFeedAvailability, "unknown">) {
  clientActivityFeedAvailability = next;
}

export function markClientIntakeSchemaAvailability(
  next: Exclude<ClientIntakeSchemaAvailability, "unknown">,
  message = CLIENT_INTAKE_DRIFT_MESSAGE,
) {
  clientIntakeSchemaAvailability = next;
  clientIntakeSchemaMessage = message;
}

export function getClientIntakeSchemaAvailability(): ClientIntakeSchemaAvailability {
  return clientIntakeSchemaAvailability;
}

export function getClientIntakeSchemaMessage(): string {
  return clientIntakeSchemaMessage;
}

export function isProjectCollaborationSchemaUnavailable(): boolean {
  if (getActiveClientWorkspaceGateway()) {
    return false;
  }

  return projectCollaborationSchemaAvailability === "unavailable";
}

export function isJobArchivingSchemaUnavailable(): boolean {
  if (getActiveClientWorkspaceGateway()) {
    return false;
  }

  return jobArchivingSchemaAvailability === "unavailable";
}

export function isClientActivityFeedUnavailable(): boolean {
  if (getActiveClientWorkspaceGateway()) {
    return false;
  }

  return clientActivityFeedAvailability === "unavailable";
}

export function resetProjectCollaborationSchemaAvailabilityForTests(): void {
  projectCollaborationSchemaAvailability = "unknown";
}

export function resetJobArchivingSchemaAvailabilityForTests(): void {
  jobArchivingSchemaAvailability = "unknown";
}

export function resetClientActivityFeedAvailabilityForTests(): void {
  clientActivityFeedAvailability = "unknown";
}

export function resetClientIntakeSchemaAvailabilityForTests(): void {
  clientIntakeSchemaAvailability = "unknown";
  clientIntakeSchemaMessage = CLIENT_INTAKE_DRIFT_MESSAGE;
}
