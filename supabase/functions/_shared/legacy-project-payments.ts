/**
 * Returns whether the server-only legacy project-payment path is explicitly
 * enabled.
 *
 * Only the trimmed, case-insensitive value `true` enables the path. Missing
 * values and all other strings keep legacy project payments disabled.
 */
export function isLegacyProjectPaymentsEnabled(
  value: string | undefined,
): boolean {
  return value?.trim().toLowerCase() === "true";
}
