import type { ClientExtractionDiagnostics, ClientPartPropertyState } from "@/features/quotes/types";

type PropertyValue = string | number | null | undefined;

// Postgres jsonb renders timestamptz as "2026-11-04T06:18:00.123456+00:00", while
// projectPartProperties.updatedAt is stored as timestamptz::text ("2026-11-04 06:25:00.123456+00").
// Both are normalized to ISO 8601 so every browser parses them the same way.
const TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/i;

/**
 * Microseconds since the epoch, or null when the value is absent, unzoned or unreadable.
 * Postgres keeps microseconds, so a save in the same millisecond as the drawing read
 * still orders correctly. Epoch microseconds stay within Number.MAX_SAFE_INTEGER.
 */
export function parseZonedTimestampMicros(value: string | null | undefined): number | null {
  if (typeof value !== "string") {
    return null;
  }

  const match = TIMESTAMP_PATTERN.exec(value.trim());

  if (!match) {
    return null;
  }

  const [, date, time, fraction, zone] = match;
  let offset = zone.toUpperCase();

  if (offset !== "Z") {
    const digits = offset.slice(1).replace(":", "");
    offset = `${offset[0]}${digits.slice(0, 2)}:${digits.slice(2, 4) || "00"}`;
  }

  const wholeSecondsMs = Date.parse(`${date}T${time}${offset}`);

  if (!Number.isFinite(wholeSecondsMs)) {
    return null;
  }

  const micros = fraction ? Number(fraction.slice(1, 7).padEnd(6, "0")) : 0;
  const result = wholeSecondsMs * 1000 + micros;
  return Number.isSafeInteger(result) ? result : null;
}

function hasValue(field: string, value: PropertyValue) {
  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return false;
  }

  return field !== "material" || trimmed.toLowerCase() !== "unknown material";
}

function readProperty(map: ClientPartPropertyState["defaults"] | undefined, field: string): PropertyValue {
  if (!map || !Object.prototype.hasOwnProperty.call(map, field)) {
    return undefined;
  }

  return (map as Record<string, PropertyValue>)[field];
}

function hasCustomerOverride(propertyState: ClientPartPropertyState | null, field: string) {
  return hasValue(field, readProperty(propertyState?.overrides, field));
}

// Mirrors public.resolve_project_part_property_values: a blank override falls back to
// the default, except an explicit empty threads override, which clears threads.
function hasSavedValue(propertyState: ClientPartPropertyState | null, field: string) {
  const override = readProperty(propertyState?.overrides, field);

  if (hasValue(field, override)) {
    return true;
  }

  if (field === "threads" && override === "") {
    return false;
  }

  return hasValue(field, readProperty(propertyState?.defaults, field));
}

function savedAfterExtraction(
  diagnostics: ClientExtractionDiagnostics,
  propertyState: ClientPartPropertyState | null,
) {
  const savedAt = parseZonedTimestampMicros(propertyState?.updatedAt);
  const extractedAt = parseZonedTimestampMicros(diagnostics.extractedAt);

  if (savedAt === null || extractedAt === null) {
    return false;
  }

  const diagnosticsUpdatedAt = parseZonedTimestampMicros(diagnostics.updatedAt);
  const latestExtractionAt =
    diagnosticsUpdatedAt === null ? extractedAt : Math.max(extractedAt, diagnosticsUpdatedAt);

  return savedAt > latestExtractionAt;
}

/**
 * Applies the customer's saved request details to the drawing review lists shown on
 * the client part page (OVD-1165). The raw extraction review state is unchanged for
 * internal tooling; only a partial lifecycle is affected.
 *
 * A request save after the drawing read confirms the remaining Verify fields and
 * acknowledges extraction warnings; Missing fields with no saved value stay listed.
 * Without such a save, overrides only narrow the lists and warnings keep the notice.
 */
export function resolveClientExtractionReview(
  diagnostics: ClientExtractionDiagnostics | null | undefined,
  propertyState: ClientPartPropertyState | null | undefined,
): ClientExtractionDiagnostics | null {
  if (!diagnostics) {
    return null;
  }

  if (diagnostics.lifecycle !== "partial") {
    return diagnostics;
  }

  const state = propertyState ?? null;
  const confirmed = savedAfterExtraction(diagnostics, state);
  const missingFields = diagnostics.missingFields.filter(
    (field) => !hasCustomerOverride(state, field) && !(confirmed && hasSavedValue(state, field)),
  );
  const reviewFields = confirmed
    ? []
    : (diagnostics.reviewFields ?? []).filter((field) => !hasCustomerOverride(state, field));

  // Warnings alone keep the notice until the customer saves after the drawing read.
  if (missingFields.length > 0 || reviewFields.length > 0 || (!confirmed && diagnostics.warningCount > 0)) {
    return { ...diagnostics, missingFields, reviewFields };
  }

  return { ...diagnostics, lifecycle: "succeeded", missingFields, reviewFields };
}
