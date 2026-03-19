import {
  CLIENT_ACTIVITY_IDENTIFIERS,
  CLIENT_INTAKE_IDENTIFIERS,
  CLIENT_PART_METADATA_IDENTIFIERS,
  CLIENT_QUOTE_WORKSPACE_IDENTIFIERS,
  DEBUG_EXTRACTION_RUN_IDENTIFIERS,
  DRAWING_PREVIEW_ASSET_IDENTIFIERS,
  JOB_ARCHIVING_IDENTIFIERS,
  PROJECT_COLLABORATION_IDENTIFIERS,
  QUOTE_REQUEST_IDENTIFIERS,
} from "./schema-runtime";

export function isNoRowsError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const value = error as { code?: unknown; details?: unknown };
  return value.code === "PGRST116" && value.details === "The result contains 0 rows";
}

export function isDeletedAuthUserError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const value = error as { code?: unknown; message?: unknown };
  return value.code === "user_not_found" || value.message === "User from sub claim in JWT does not exist";
}

export function isInvalidRefreshTokenError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const value = error as { name?: unknown; message?: unknown };
  const name = typeof value.name === "string" ? value.name : error instanceof Error ? error.name : "";
  const message = typeof value.message === "string" ? value.message : error instanceof Error ? error.message : "";
  const blob = `${name} ${message}`.toLowerCase();

  return blob.includes("invalid refresh token") || blob.includes("refresh token not found");
}

export function getSchemaErrorMetadata(error: unknown) {
  if (!error) {
    return null;
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
  return {
    code,
    blob: `${message} ${details} ${hint}`.toLowerCase(),
  };
}

export function isMissingSchemaIdentifierError(error: unknown, identifiers: readonly string[]): boolean {
  const metadata = getSchemaErrorMetadata(error);

  if (!metadata) {
    return false;
  }

  if (!identifiers.some((identifier) => metadata.blob.includes(identifier))) {
    return false;
  }

  return (
    metadata.code === "42P01" ||
    metadata.code === "42703" ||
    metadata.code === "42883" ||
    metadata.code === "PGRST202" ||
    metadata.code === "PGRST204" ||
    metadata.code === "PGRST205" ||
    metadata.blob.includes("unexpected table") ||
    metadata.blob.includes("does not exist") ||
    metadata.blob.includes("schema cache")
  );
}

export function isMissingProjectCollaborationSchemaError(error: unknown): boolean {
  return isMissingSchemaIdentifierError(error, PROJECT_COLLABORATION_IDENTIFIERS);
}

export function isMissingJobArchivingSchemaError(error: unknown): boolean {
  return isMissingSchemaIdentifierError(error, JOB_ARCHIVING_IDENTIFIERS);
}

export function isMissingDrawingPreviewSchemaError(error: unknown): boolean {
  return isMissingSchemaIdentifierError(error, DRAWING_PREVIEW_ASSET_IDENTIFIERS);
}

export function isMissingDebugExtractionSchemaError(error: unknown): boolean {
  return isMissingSchemaIdentifierError(error, DEBUG_EXTRACTION_RUN_IDENTIFIERS);
}

export function isMissingClientActivitySchemaError(error: unknown): boolean {
  return isMissingSchemaIdentifierError(error, CLIENT_ACTIVITY_IDENTIFIERS);
}

export function isMissingQuoteRequestSchemaError(error: unknown): boolean {
  return isMissingSchemaIdentifierError(error, QUOTE_REQUEST_IDENTIFIERS);
}

export function isMissingClientPartMetadataSchemaError(error: unknown): boolean {
  return isMissingSchemaIdentifierError(error, CLIENT_PART_METADATA_IDENTIFIERS);
}

export function isMissingClientQuoteWorkspaceSchemaError(error: unknown): boolean {
  return isMissingSchemaIdentifierError(error, CLIENT_QUOTE_WORKSPACE_IDENTIFIERS);
}

export function isMissingClientIntakeSchemaError(error: unknown): boolean {
  return isMissingSchemaIdentifierError(error, CLIENT_INTAKE_IDENTIFIERS);
}

export function isMissingFunctionError(error: unknown, functionName: string): boolean {
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
