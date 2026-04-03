import { getActiveClientWorkspaceGateway } from "@/features/quotes/client-workspace-fixtures";
import { callRpc } from "./shared/rpc";
import {
  getClientIntakeSchemaAvailability,
  getClientIntakeSchemaMessage,
  markClientIntakeSchemaAvailability,
  resetClientIntakeSchemaAvailabilityForTests,
} from "./shared/schema-runtime";
import { CLIENT_INTAKE_DRIFT_MESSAGE, type ClientIntakeCompatibilitySnapshot } from "./shared/schema-runtime";
import { isMissingClientIntakeSchemaError, isMissingFunctionError } from "./shared/schema-errors";

export class ClientIntakeCompatibilityError extends Error {
  readonly missing: string[];

  constructor(message = CLIENT_INTAKE_DRIFT_MESSAGE, missing: readonly string[] = []) {
    super(message);
    this.name = "ClientIntakeCompatibilityError";
    this.missing = [...missing];
  }
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

export function toClientIntakeCompatibilityError(
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

  const availability = getClientIntakeSchemaAvailability();

  if (availability === "available" || availability === "legacy") {
    return availability;
  }

  if (availability === "unavailable") {
    throw new Error(getClientIntakeSchemaMessage());
  }

  const { data, error } = await callRpc("api_get_client_intake_compatibility");

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
  return getClientIntakeSchemaMessage();
}

export { resetClientIntakeSchemaAvailabilityForTests };
