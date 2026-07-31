export const MANUFACTURING_CORPUS_MANIFEST_DIAGNOSTIC_CODES = [
  "artifact_capture_limit_exceeded",
  "artifact_changed_during_validation",
  "artifact_not_regular_file",
  "artifact_open_failed",
  "artifact_path_escape",
  "artifact_path_missing",
  "artifact_read_failed",
  "artifact_root_missing",
  "artifact_sha256_mismatch",
  "artifact_size_mismatch",
  "artifact_symlink",
  "case_not_found",
  "duplicate_artifact_id",
  "duplicate_case_id",
  "duplicate_requested_case_id",
  "duplicate_rights_id",
  "duplicate_root_id",
  "duplicate_target_identity",
  "external_root_binding_not_absolute",
  "external_root_missing",
  "external_root_not_directory",
  "external_root_symlink",
  "external_root_unknown_binding",
  "external_root_unmounted",
  "manifest_byte_limit_invalid",
  "manifest_changed_during_validation",
  "manifest_json_invalid",
  "manifest_missing",
  "manifest_not_regular_file",
  "manifest_read_failed",
  "manifest_root_escape",
  "manifest_root_missing",
  "manifest_root_not_directory",
  "manifest_root_symlink",
  "manifest_schema_invalid",
  "manifest_symlink",
  "manifest_too_large",
] as const;

export type ManufacturingCorpusManifestDiagnosticCode =
  (typeof MANUFACTURING_CORPUS_MANIFEST_DIAGNOSTIC_CODES)[number];
export type ManufacturingCorpusManifestDiagnosticRecordKind =
  | "artifact"
  | "case"
  | "manifest"
  | "rights"
  | "root"
  | "target";
export type ManufacturingCorpusManifestDiagnostic = Readonly<{
  code: ManufacturingCorpusManifestDiagnosticCode;
  recordKind: ManufacturingCorpusManifestDiagnosticRecordKind;
  recordId: string | null;
}>;

const stableIdPattern = /^[a-z0-9][a-z0-9._-]*$/;
const keyFor = (value: ManufacturingCorpusManifestDiagnostic) =>
  `${value.code}\0${value.recordKind}\0${value.recordId ?? ""}`;

export function createManufacturingCorpusManifestDiagnostic(
  code: ManufacturingCorpusManifestDiagnosticCode,
  recordKind: ManufacturingCorpusManifestDiagnosticRecordKind,
  recordId: string | null = null,
): ManufacturingCorpusManifestDiagnostic {
  return {
    code,
    recordKind,
    recordId:
      recordId !== null && stableIdPattern.test(recordId) ? recordId : null,
  };
}

export function normalizeManufacturingCorpusManifestDiagnostics(
  diagnostics: readonly ManufacturingCorpusManifestDiagnostic[],
) {
  const unique = new Map<string, ManufacturingCorpusManifestDiagnostic>();
  for (const value of diagnostics) {
    const sanitized = createManufacturingCorpusManifestDiagnostic(
      value.code,
      value.recordKind,
      value.recordId,
    );
    unique.set(keyFor(sanitized), sanitized);
  }
  return [...unique.values()].sort((left, right) => {
    const leftKey = keyFor(left);
    const rightKey = keyFor(right);
    if (leftKey < rightKey) {
      return -1;
    }
    if (leftKey > rightKey) {
      return 1;
    }
    return 0;
  });
}

/** Emits only the closed, path-free diagnostic contract. */
export function serializeManufacturingCorpusManifestDiagnostics(
  diagnostics: readonly ManufacturingCorpusManifestDiagnostic[],
) {
  return `${JSON.stringify(
    normalizeManufacturingCorpusManifestDiagnostics(diagnostics),
    null,
    2,
  )}\n`;
}

// Canonical aliases for consumers of the composed filesystem boundary. The
// original manifest-prefixed exports remain source-compatible with OVD-276.
export const MANUFACTURING_CORPUS_FILESYSTEM_DIAGNOSTIC_CODES =
  MANUFACTURING_CORPUS_MANIFEST_DIAGNOSTIC_CODES;
export type ManufacturingCorpusFilesystemDiagnosticCode =
  ManufacturingCorpusManifestDiagnosticCode;
export type ManufacturingCorpusFilesystemDiagnosticRecordKind =
  ManufacturingCorpusManifestDiagnosticRecordKind;
export type ManufacturingCorpusFilesystemDiagnostic =
  ManufacturingCorpusManifestDiagnostic;
export const createManufacturingCorpusFilesystemDiagnostic =
  createManufacturingCorpusManifestDiagnostic;
export const normalizeManufacturingCorpusFilesystemDiagnostics =
  normalizeManufacturingCorpusManifestDiagnostics;
export const serializeManufacturingCorpusFilesystemDiagnostics =
  serializeManufacturingCorpusManifestDiagnostics;
