import path from "node:path";
import {
  manufacturingCorpusAnnotationSchema,
  type ManufacturingCorpusAnnotation,
} from "../benchmarks/manufacturingCorpusContract.js";
import {
  prepareManufacturingCorpusFilesystem,
  type ManufacturingCorpusFilesystemPreparationResult,
  type PrepareManufacturingCorpusFilesystemOptions,
} from "../benchmarks/manufacturingCorpusFilesystem.js";
import {
  MANUFACTURING_CORPUS_FILESYSTEM_DIAGNOSTIC_CODES,
  type ManufacturingCorpusFilesystemDiagnostic,
  type ManufacturingCorpusFilesystemDiagnosticCode,
  type ManufacturingCorpusFilesystemDiagnosticRecordKind,
} from "../benchmarks/manufacturingCorpusFilesystemDiagnostics.js";
import {
  evaluateManufacturingCorpusPolicy,
  serializeManufacturingCorpusPolicyReport,
  type EvaluateManufacturingCorpusPolicyInput,
  type ManufacturingCorpusPolicyReport,
  type VerifiedManufacturingCorpusAnnotation,
} from "../benchmarks/manufacturingCorpusPolicy.js";
import {
  MANUFACTURING_CORPUS_INVALID_CODES,
  planManufacturingCorpusIntegrityAccess,
  type ManufacturingCorpusInvalidCode,
  type ManufacturingCorpusPolicyPreflightInput,
  type ManufacturingCorpusPolicyPreflightPlan,
} from "../benchmarks/manufacturingCorpusPolicyPreflight.js";
import {
  manufacturingCorpusOpaqueReferenceSchema,
  manufacturingCorpusUtcTimestampSchema,
} from "../benchmarks/manufacturingCorpusVocabulary.js";

export const MANUFACTURING_CORPUS_CLI_ERROR_SCHEMA_VERSION =
  "manufacturing-corpus-cli-error.v1";
export const MANUFACTURING_CORPUS_CLI_ARGUMENT_ERROR_CODES = [
  "cli_duplicate_option",
  "cli_evaluation_at_invalid",
  "cli_evaluation_at_required",
  "cli_evaluation_tenant_invalid",
  "cli_manifest_path_invalid",
  "cli_manifest_required",
  "cli_missing_option_value",
  "cli_root_binding_invalid",
  "cli_root_id_duplicate",
  "cli_root_id_invalid",
  "cli_root_path_not_absolute",
  "cli_unknown_argument",
] as const;
export const MANUFACTURING_CORPUS_CLI_ANNOTATION_ERROR_CODES = [
  "annotation_case_mismatch",
  "annotation_json_invalid",
  "annotation_schema_invalid",
] as const;

export type ManufacturingCorpusCliArgumentErrorCode =
  (typeof MANUFACTURING_CORPUS_CLI_ARGUMENT_ERROR_CODES)[number];
export type ManufacturingCorpusCliAnnotationErrorCode =
  (typeof MANUFACTURING_CORPUS_CLI_ANNOTATION_ERROR_CODES)[number];
export type ManufacturingCorpusCliErrorCode =
  | ManufacturingCorpusCliAnnotationErrorCode
  | ManufacturingCorpusCliArgumentErrorCode
  | ManufacturingCorpusFilesystemDiagnosticCode
  | ManufacturingCorpusInvalidCode
  | "cli_internal_failure";
export type ManufacturingCorpusCliErrorSource =
  "annotation" | "argument" | "filesystem" | "internal" | "policy";
export type ManufacturingCorpusCliOption =
  | "evaluation_at"
  | "evaluation_tenant"
  | "manifest"
  | "root"
  | "strict_coverage";
export type ManufacturingCorpusCliRecordKind =
  ManufacturingCorpusFilesystemDiagnosticRecordKind | "annotation" | null;
export type ManufacturingCorpusCliError = Readonly<{
  source: ManufacturingCorpusCliErrorSource;
  code: ManufacturingCorpusCliErrorCode;
  option: ManufacturingCorpusCliOption | null;
  recordKind: ManufacturingCorpusCliRecordKind;
  recordId: string | null;
}>;
export type ManufacturingCorpusCliResult = Readonly<{
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
}>;
export type ParsedManufacturingCorpusCliArguments = Readonly<{
  manifestPath: string;
  evaluationAt: string;
  evaluationTenantRef?: string;
  externalBindings: ReadonlyMap<string, string>;
  strictCoverage: boolean;
}>;
export type ManufacturingCorpusCliDependencies = Readonly<{
  prepareFilesystem: (
    options: PrepareManufacturingCorpusFilesystemOptions,
  ) => Promise<ManufacturingCorpusFilesystemPreparationResult>;
  planIntegrityAccess: (
    input: ManufacturingCorpusPolicyPreflightInput,
  ) => ManufacturingCorpusPolicyPreflightPlan;
  evaluatePolicy: (
    input: EvaluateManufacturingCorpusPolicyInput,
  ) => ManufacturingCorpusPolicyReport;
  serializePolicyReport: (
    report: ManufacturingCorpusPolicyReport,
  ) => string;
}>;

export const DEFAULT_MANUFACTURING_CORPUS_CLI_DEPENDENCIES:
  ManufacturingCorpusCliDependencies = {
    prepareFilesystem: prepareManufacturingCorpusFilesystem,
    planIntegrityAccess: planManufacturingCorpusIntegrityAccess,
    evaluatePolicy: evaluateManufacturingCorpusPolicy,
    serializePolicyReport: serializeManufacturingCorpusPolicyReport,
  };

type ParseResult =
  | Readonly<{ state: "invalid"; errors: readonly ManufacturingCorpusCliError[] }>
  | Readonly<{
    state: "parsed";
    value: ParsedManufacturingCorpusCliArguments;
  }>;

const stableIdPattern = /^[a-z0-9][a-z0-9._-]*$/;
const filesystemCodes = new Set<string>(
  MANUFACTURING_CORPUS_FILESYSTEM_DIAGNOSTIC_CODES,
);
const filesystemRecordKinds = new Set<string>([
  "artifact",
  "case",
  "manifest",
  "rights",
  "root",
  "target",
]);
const policyInvalidCodes = new Set<string>(MANUFACTURING_CORPUS_INVALID_CODES);

function compareText(left: string, right: string) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function cliError(
  source: ManufacturingCorpusCliErrorSource,
  code: ManufacturingCorpusCliErrorCode,
  option: ManufacturingCorpusCliOption | null = null,
  recordKind: ManufacturingCorpusCliRecordKind = null,
  recordId: string | null = null,
): ManufacturingCorpusCliError {
  return {
    source,
    code,
    option,
    recordKind,
    recordId:
      recordId !== null && stableIdPattern.test(recordId) ? recordId : null,
  };
}

function errorKey(error: ManufacturingCorpusCliError) {
  return [
    error.source,
    error.code,
    error.option ?? "",
    error.recordKind ?? "",
    error.recordId ?? "",
  ].join("\0");
}

function normalizeErrors(errors: readonly ManufacturingCorpusCliError[]) {
  const unique = new Map<string, ManufacturingCorpusCliError>();
  for (const error of errors) {
    const sanitized = cliError(
      error.source,
      error.code,
      error.option,
      error.recordKind,
      error.recordId,
    );
    unique.set(errorKey(sanitized), sanitized);
  }
  return [...unique.values()].sort((left, right) =>
    compareText(errorKey(left), errorKey(right)),
  );
}

function invalidResult(
  errors: readonly ManufacturingCorpusCliError[],
): ManufacturingCorpusCliResult {
  return {
    exitCode: 2,
    stdout: "",
    stderr: `${JSON.stringify(
      {
        schemaVersion: MANUFACTURING_CORPUS_CLI_ERROR_SCHEMA_VERSION,
        status: "invalid",
        errors: normalizeErrors(errors),
      },
      null,
      2,
    )}\n`,
  };
}

function argumentError(
  code: ManufacturingCorpusCliArgumentErrorCode,
  option: ManufacturingCorpusCliOption | null = null,
) {
  return cliError("argument", code, option);
}

function optionForToken(token: string): ManufacturingCorpusCliOption | null {
  const options = {
    "--evaluation-at": "evaluation_at",
    "--evaluation-tenant": "evaluation_tenant",
    "--manifest": "manifest",
    "--root": "root",
    "--strict-coverage": "strict_coverage",
  } as const;
  return options[token as keyof typeof options] ?? null;
}

function readOptionValue(
  args: readonly string[],
  index: number,
  option: ManufacturingCorpusCliOption,
  errors: ManufacturingCorpusCliError[],
) {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    errors.push(argumentError("cli_missing_option_value", option));
    return null;
  }
  return value;
}

function validPathSyntax(value: string) {
  return value.length > 0 && !value.includes("\0");
}

/** Parses the frozen spaced-option CLI grammar without filesystem access. */
export function parseValidateManufacturingCorpusCliArguments(
  args: readonly string[],
): ParseResult {
  const errors: ManufacturingCorpusCliError[] = [];
  const seen = new Map<ManufacturingCorpusCliOption, number>();
  const roots = new Map<string, string>();
  let manifestPath: string | undefined;
  let evaluationAt: string | undefined;
  let evaluationTenantRef: string | undefined;
  let strictCoverage = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const option = optionForToken(token);
    if (option === null) {
      errors.push(argumentError("cli_unknown_argument"));
      continue;
    }
    const occurrences = (seen.get(option) ?? 0) + 1;
    seen.set(option, occurrences);
    if (option === "strict_coverage") {
      if (occurrences > 1) {
        errors.push(argumentError("cli_duplicate_option", option));
      }
      strictCoverage = true;
      continue;
    }
    if (option !== "root" && occurrences > 1) {
      errors.push(argumentError("cli_duplicate_option", option));
    }
    const value = readOptionValue(args, index, option, errors);
    if (value === null) {
      continue;
    }
    index += 1;

    if (option === "manifest") {
      if (!validPathSyntax(value)) {
        errors.push(argumentError("cli_manifest_path_invalid", option));
      } else if (manifestPath === undefined) {
        manifestPath = value;
      }
    } else if (option === "evaluation_at") {
      const parsed = manufacturingCorpusUtcTimestampSchema.safeParse(value);
      if (!parsed.success) {
        errors.push(argumentError("cli_evaluation_at_invalid", option));
      } else if (evaluationAt === undefined) {
        evaluationAt = parsed.data;
      }
    } else if (option === "evaluation_tenant") {
      const parsed =
        manufacturingCorpusOpaqueReferenceSchema.safeParse(value);
      if (!parsed.success) {
        errors.push(
          argumentError("cli_evaluation_tenant_invalid", option),
        );
      } else if (evaluationTenantRef === undefined) {
        evaluationTenantRef = value;
      }
    } else {
      const separator = value.indexOf("=");
      if (
        separator <= 0 ||
        separator === value.length - 1 ||
        value.includes("\0")
      ) {
        errors.push(argumentError("cli_root_binding_invalid", option));
        continue;
      }
      const rootId = value.slice(0, separator);
      const rootPath = value.slice(separator + 1);
      if (!stableIdPattern.test(rootId)) {
        errors.push(argumentError("cli_root_id_invalid", option));
      } else if (roots.has(rootId)) {
        errors.push(argumentError("cli_root_id_duplicate", option));
      } else if (!path.isAbsolute(rootPath)) {
        errors.push(argumentError("cli_root_path_not_absolute", option));
      } else {
        roots.set(rootId, rootPath);
      }
    }
  }

  if (!seen.has("manifest")) {
    errors.push(argumentError("cli_manifest_required", "manifest"));
  }
  if (!seen.has("evaluation_at")) {
    errors.push(
      argumentError("cli_evaluation_at_required", "evaluation_at"),
    );
  }
  if (errors.length > 0 || manifestPath === undefined || evaluationAt === undefined) {
    return { state: "invalid", errors: normalizeErrors(errors) };
  }
  return {
    state: "parsed",
    value: {
      manifestPath,
      evaluationAt,
      evaluationTenantRef,
      externalBindings: roots,
      strictCoverage,
    },
  };
}

function filesystemErrors(
  diagnostics: readonly ManufacturingCorpusFilesystemDiagnostic[],
) {
  return diagnostics.map((diagnostic) => {
    const valid =
      filesystemCodes.has(diagnostic.code) &&
      filesystemRecordKinds.has(diagnostic.recordKind);
    if (!valid) {
      return cliError("internal", "cli_internal_failure");
    }
    return cliError(
      "filesystem",
      diagnostic.code,
      null,
      diagnostic.recordKind,
      diagnostic.recordId,
    );
  });
}

function policyErrors(plan: ManufacturingCorpusPolicyPreflightPlan) {
  const errors: ManufacturingCorpusCliError[] = [];
  const localizedCodes = new Set<string>();
  for (const decision of plan.caseDecisions) {
    for (const code of decision.corpusInvalidCodes) {
      localizedCodes.add(code);
      errors.push(cliError("policy", code, null, "case", decision.caseId));
    }
  }
  for (const code of plan.corpusInvalidCodes) {
    if (policyInvalidCodes.has(code) && !localizedCodes.has(code)) {
      errors.push(cliError("policy", code));
    }
  }
  if (errors.length === 0) {
    errors.push(cliError("internal", "cli_internal_failure"));
  }
  return errors;
}

function parseVerifiedAnnotations(input: {
  authorizedCaseIds: readonly string[];
  manifest: ManufacturingCorpusPolicyPreflightInput["manifest"];
  bytesByCaseId: ReadonlyMap<string, Uint8Array>;
}) {
  const errors: ManufacturingCorpusCliError[] = [];
  const verified: VerifiedManufacturingCorpusAnnotation[] = [];
  const cases = new Map(
    input.manifest.cases.map((corpusCase) => [
      corpusCase.caseId,
      corpusCase,
    ]),
  );
  for (const caseId of input.authorizedCaseIds) {
    const corpusCase = cases.get(caseId);
    const bytes = input.bytesByCaseId.get(caseId);
    if (corpusCase === undefined || bytes === undefined) {
      errors.push(cliError("internal", "cli_internal_failure"));
      continue;
    }
    let raw: unknown;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      raw = JSON.parse(text);
    } catch {
      errors.push(
        cliError(
          "annotation",
          "annotation_json_invalid",
          null,
          "annotation",
          corpusCase.annotationArtifact.artifactId,
        ),
      );
      continue;
    }
    const parsed = manufacturingCorpusAnnotationSchema.safeParse(raw);
    if (!parsed.success) {
      errors.push(
        cliError(
          "annotation",
          "annotation_schema_invalid",
          null,
          "annotation",
          corpusCase.annotationArtifact.artifactId,
        ),
      );
      continue;
    }
    const annotation: ManufacturingCorpusAnnotation = parsed.data;
    if (annotation.caseId !== caseId) {
      errors.push(
        cliError(
          "annotation",
          "annotation_case_mismatch",
          null,
          "case",
          caseId,
        ),
      );
      continue;
    }
    verified.push({
      caseId,
      annotationArtifactId: corpusCase.annotationArtifact.artifactId,
      annotation,
    });
  }
  return { errors, verified };
}

/**
 * Runs offline corpus validation without mutating process state.
 *
 * Dependencies are injectable so ordering and privacy boundaries can be
 * verified without filesystem, network, database, or process side effects.
 */
export async function runValidateManufacturingCorpusCli(
  args: readonly string[],
  dependencies: ManufacturingCorpusCliDependencies =
    DEFAULT_MANUFACTURING_CORPUS_CLI_DEPENDENCIES,
): Promise<ManufacturingCorpusCliResult> {
  try {
    const parsed = parseValidateManufacturingCorpusCliArguments(args);
    if (parsed.state === "invalid") {
      return invalidResult(parsed.errors);
    }
    const prepared = await dependencies.prepareFilesystem({
      manifestPath: parsed.value.manifestPath,
      externalBindings: parsed.value.externalBindings,
    });
    if (prepared.state === "failed") {
      return invalidResult(filesystemErrors(prepared.diagnostics));
    }
    const plan = dependencies.planIntegrityAccess({
      manifest: prepared.prepared.manifest,
      evaluationAt: parsed.value.evaluationAt,
      evaluationTenantRef: parsed.value.evaluationTenantRef,
    });
    if (plan.corpusInvalid) {
      return invalidResult(policyErrors(plan));
    }
    const integrity = await prepared.prepared.validateArtifacts(
      plan.authorizedCaseIds,
    );
    if (!integrity.integrityPassed) {
      const errors = filesystemErrors(integrity.diagnostics);
      return invalidResult(
        errors.length > 0
          ? errors
          : [cliError("internal", "cli_internal_failure")],
      );
    }
    const annotations = parseVerifiedAnnotations({
      authorizedCaseIds: plan.authorizedCaseIds,
      manifest: prepared.prepared.manifest,
      bytesByCaseId: integrity.verifiedAnnotationBytesByCaseId,
    });
    if (annotations.errors.length > 0) {
      return invalidResult(annotations.errors);
    }
    const report = dependencies.evaluatePolicy({
      manifest: prepared.prepared.manifest,
      preflightPlan: plan,
      integrityResults: integrity.caseResults.map((caseResult) => ({
        caseId: caseResult.caseId,
        state: caseResult.state,
        diagnosticCodes: [...caseResult.diagnosticCodes],
      })),
      verifiedAnnotations: annotations.verified,
    });
    const stdout = dependencies.serializePolicyReport(report);
    const hasCoverageGaps = report.coverage.some(
      (coverage) => coverage.gaps.length > 0,
    );
    return {
      exitCode: parsed.value.strictCoverage && hasCoverageGaps ? 1 : 0,
      stdout,
      stderr: "",
    };
  } catch {
    return invalidResult([
      cliError("internal", "cli_internal_failure"),
    ]);
  }
}
