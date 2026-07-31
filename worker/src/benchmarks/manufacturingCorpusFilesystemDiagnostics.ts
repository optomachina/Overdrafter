export const MANUFACTURING_CORPUS_MANIFEST_DIAGNOSTIC_CODES = [
  "duplicate_artifact_id",
  "duplicate_case_id",
  "duplicate_rights_id",
  "duplicate_root_id",
  "duplicate_target_identity",
  "manifest_byte_limit_invalid",
  "manifest_changed_during_validation",
  "manifest_json_invalid",
  "manifest_missing",
  "manifest_not_regular_file",
  "manifest_read_failed",
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
