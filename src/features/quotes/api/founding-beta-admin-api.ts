import { callRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FoundingBetaEnrollment = {
  organizationId: string;
  enrolled: boolean;
  latestAction: "grant" | "revoke" | null;
  latestEventId: number | null;
  latestEventAt: string | null;
  policyRevision: string;
  termsPath: string;
  privacyPath: string;
};

export type SetFoundingBetaEnrollmentResult = {
  eventId: number;
  replayed: boolean;
  organizationId: string;
  enrolled: boolean;
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }

  return value;
}

function requireUuid(value: unknown, label: string): string {
  const result = requireString(value, label);

  if (!UUID_PATTERN.test(result)) {
    throw new TypeError(`${label} must be a UUID.`);
  }

  return result;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean.`);
  }

  return value;
}

function requireEventId(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }

  return value as number;
}

function requireNullableEventId(value: unknown, label: string): number | null {
  return value === null ? null : requireEventId(value, label);
}

function requireNullableDate(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }

  const result = requireString(value, label);

  if (Number.isNaN(Date.parse(result))) {
    throw new TypeError(`${label} must be a timestamp.`);
  }

  return result;
}

function requireLatestAction(value: unknown): "grant" | "revoke" | null {
  if (value === null) {
    return null;
  }

  if (value === "grant" || value === "revoke") {
    return value;
  }

  throw new TypeError("Founding Beta latest action is invalid.");
}

function parseEnrollment(value: unknown): FoundingBetaEnrollment {
  const record = requireRecord(value, "Founding Beta enrollment response");
  const latestAction = requireLatestAction(record.latestAction);
  const latestEventId = requireNullableEventId(
    record.latestEventId,
    "Founding Beta latest event ID",
  );
  const latestEventAt = requireNullableDate(
    record.latestEventAt,
    "Founding Beta latest event time",
  );

  const allEventFieldsAreEmpty =
    latestAction === null && latestEventId === null && latestEventAt === null;
  const allEventFieldsArePresent =
    latestAction !== null && latestEventId !== null && latestEventAt !== null;

  if (!allEventFieldsAreEmpty && !allEventFieldsArePresent) {
    throw new TypeError("Founding Beta latest event fields are inconsistent.");
  }

  const enrolled = requireBoolean(record.enrolled, "Founding Beta enrollment");

  if (
    (latestAction === "grant" && !enrolled)
    || (latestAction !== "grant" && enrolled)
  ) {
    throw new TypeError("Founding Beta enrollment and latest action disagree.");
  }

  return {
    organizationId: requireUuid(
      record.organizationId,
      "Founding Beta organization ID",
    ),
    enrolled,
    latestAction,
    latestEventId,
    latestEventAt,
    policyRevision: requireString(
      record.policyRevision,
      "Founding Beta policy revision",
    ),
    termsPath: requireString(record.termsPath, "Founding Beta terms path"),
    privacyPath: requireString(record.privacyPath, "Founding Beta privacy path"),
  };
}

function parseSetResult(value: unknown): SetFoundingBetaEnrollmentResult {
  const record = requireRecord(value, "Founding Beta mutation response");

  return {
    eventId: requireEventId(record.eventId, "Founding Beta event ID"),
    replayed: requireBoolean(record.replayed, "Founding Beta replay status"),
    organizationId: requireUuid(
      record.organizationId,
      "Founding Beta organization ID",
    ),
    enrolled: requireBoolean(record.enrolled, "Founding Beta enrollment"),
  };
}

/** Reads an organization's authoritative, append-only Founding Beta state. */
export async function fetchFoundingBetaEnrollment(
  organizationId: string,
): Promise<FoundingBetaEnrollment> {
  const { data, error } = await callRpc(
    "api_admin_get_founding_beta_enrollment",
    { p_organization_id: organizationId },
  );

  const result = parseEnrollment(ensureData(data, error));

  if (result.organizationId.toLowerCase() !== organizationId.toLowerCase()) {
    throw new TypeError("Founding Beta enrollment returned a different organization.");
  }

  return result;
}

/** Records one MFA-protected grant or revocation through the audited server RPC. */
export async function setFoundingBetaEnrollment(input: {
  organizationId: string;
  enrolled: boolean;
  reason: string;
  idempotencyKey: string;
}): Promise<SetFoundingBetaEnrollmentResult> {
  const { data, error } = await callRpc(
    "api_admin_set_founding_beta_enrollment",
    {
      p_organization_id: input.organizationId,
      p_enrolled: input.enrolled,
      p_reason: input.reason,
      p_idempotency_key: input.idempotencyKey,
    },
  );

  const result = parseSetResult(ensureData(data, error));

  if (
    result.organizationId.toLowerCase() !== input.organizationId.toLowerCase()
    || result.enrolled !== input.enrolled
  ) {
    throw new TypeError("Founding Beta mutation returned a different operation.");
  }

  return result;
}
