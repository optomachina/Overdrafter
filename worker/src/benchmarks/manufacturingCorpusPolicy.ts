import type {
  ManufacturingCorpusAnnotation,
  ManufacturingCorpusManifest,
  ManufacturingProcessFamily,
  ManufacturingQualificationTarget,
} from "./manufacturingCorpusContract.js";
import {
  MANUFACTURING_CORPUS_FILESYSTEM_DIAGNOSTIC_CODES,
  type ManufacturingCorpusFilesystemDiagnosticCode,
} from "./manufacturingCorpusFilesystemDiagnostics.js";
import {
  MANUFACTURING_CORPUS_VALIDATOR_PROCESSOR_ID,
  type ManufacturingCorpusInvalidCode,
  type ManufacturingCorpusPolicyBlockerCode,
  type ManufacturingCorpusPolicyPreflightDecision,
  type ManufacturingCorpusPolicyPreflightPlan,
} from "./manufacturingCorpusPolicyPreflight.js";

export const MANUFACTURING_CORPUS_POLICY_REPORT_SCHEMA_VERSION =
  "manufacturing-corpus-policy-report.v1";
export const MANUFACTURING_CORPUS_INTEGRITY_EVALUATION_CODES = [
  "integrity_diagnostic_invalid",
  "integrity_result_ambiguous",
  "integrity_result_inconsistent",
  "integrity_result_missing",
] as const;
export const MANUFACTURING_CORPUS_ANNOTATION_EVALUATION_CODES = [
  "annotation_case_mismatch",
  "annotation_result_ambiguous",
  "annotation_result_missing",
  "annotation_review_not_effective",
  "annotation_review_pending",
  "annotation_unverified",
] as const;
export const MANUFACTURING_CORPUS_COVERAGE_GAP_CODES = [
  "minimum_consented_real_packages_not_met",
  "minimum_packages_not_met",
] as const;

export type ManufacturingCorpusIntegrityEvaluationCode =
  (typeof MANUFACTURING_CORPUS_INTEGRITY_EVALUATION_CODES)[number];
export type ManufacturingCorpusAnnotationEvaluationCode =
  (typeof MANUFACTURING_CORPUS_ANNOTATION_EVALUATION_CODES)[number];
export type ManufacturingCorpusCoverageGapCode =
  (typeof MANUFACTURING_CORPUS_COVERAGE_GAP_CODES)[number];
export type ManufacturingCorpusIntegrityState =
  "passed" | "failed" | "not_evaluated";
export type ManufacturingCorpusAnnotationState =
  "approved" | "case_mismatch" | "missing" | "not_evaluated" | "pending";

export type DeclaredCaseIntegrityResult = {
  caseId: string;
  state: "passed" | "failed";
  diagnosticCodes: ManufacturingCorpusFilesystemDiagnosticCode[];
};
export type VerifiedManufacturingCorpusAnnotation = {
  caseId: string;
  annotationArtifactId: string;
  annotation: ManufacturingCorpusAnnotation;
};
export type EvaluateManufacturingCorpusPolicyInput = {
  manifest: ManufacturingCorpusManifest;
  preflightPlan: ManufacturingCorpusPolicyPreflightPlan;
  integrityResults: DeclaredCaseIntegrityResult[];
  verifiedAnnotations: VerifiedManufacturingCorpusAnnotation[];
};
export type ManufacturingCorpusPolicyCaseResult = {
  caseId: string;
  authorizationState:
    ManufacturingCorpusPolicyPreflightDecision["authorizationState"];
  policyBlockerCodes: ManufacturingCorpusPolicyBlockerCode[];
  corpusInvalidCodes: ManufacturingCorpusInvalidCode[];
  integrityState: ManufacturingCorpusIntegrityState;
  integrityEvaluationCodes: ManufacturingCorpusIntegrityEvaluationCode[];
  integrityDiagnosticCodes: ManufacturingCorpusFilesystemDiagnosticCode[];
  annotationState: ManufacturingCorpusAnnotationState;
  annotationEvaluationCodes: ManufacturingCorpusAnnotationEvaluationCode[];
  countedForCoverage: boolean;
};
export type ManufacturingCorpusCoverageGap = {
  code: ManufacturingCorpusCoverageGapCode;
  required: number;
  actual: number;
  deficit: number;
};
export type ManufacturingCorpusCoverageResult = {
  processFamily: ManufacturingProcessFamily;
  qualificationTarget: ManufacturingQualificationTarget;
  minimumPackages: number;
  minimumConsentedRealPackages: number;
  presentPackages: number;
  integrityPassedPackages: number;
  eligiblePackages: number;
  eligibleConsentedRealPackages: number;
  promotionBlocked: boolean;
  gaps: ManufacturingCorpusCoverageGap[];
};
export type ManufacturingCorpusPolicyReport = {
  schemaVersion: typeof MANUFACTURING_CORPUS_POLICY_REPORT_SCHEMA_VERSION;
  processorId: typeof MANUFACTURING_CORPUS_VALIDATOR_PROCESSOR_ID;
  corpusVersion: string;
  evaluationAt: string;
  corpusInvalid: boolean;
  corpusInvalidCodes: ManufacturingCorpusInvalidCode[];
  promotionBlocked: boolean;
  caseResults: ManufacturingCorpusPolicyCaseResult[];
  coverage: ManufacturingCorpusCoverageResult[];
};

const FILESYSTEM_DIAGNOSTIC_CODE_SET = new Set<string>(
  MANUFACTURING_CORPUS_FILESYSTEM_DIAGNOSTIC_CODES,
);

function stableCompare(left: string, right: string) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(stableCompare);
}

function normalizeIntegrityDiagnostics(
  values: readonly ManufacturingCorpusFilesystemDiagnosticCode[],
): {
  diagnosticCodes: ManufacturingCorpusFilesystemDiagnosticCode[];
  evaluationCodes: ManufacturingCorpusIntegrityEvaluationCode[];
} {
  const valid = values.filter(
    (value): value is ManufacturingCorpusFilesystemDiagnosticCode =>
      typeof value === "string" &&
      FILESYSTEM_DIAGNOSTIC_CODE_SET.has(value),
  );
  return {
    diagnosticCodes: sortedUnique(valid),
    evaluationCodes:
      valid.length !== values.length
        ? ["integrity_diagnostic_invalid"]
        : [],
  };
}

function evaluateCase(input: {
  decision: ManufacturingCorpusPolicyPreflightDecision;
  globallyAuthorized: ReadonlySet<string>;
  integrityResults: readonly DeclaredCaseIntegrityResult[];
  verifiedAnnotations: readonly VerifiedManufacturingCorpusAnnotation[];
  expectedAnnotationArtifactId?: string;
  evaluationTime: number;
}): ManufacturingCorpusPolicyCaseResult {
  const { decision } = input;
  const base = {
    caseId: decision.caseId,
    authorizationState: decision.authorizationState,
    policyBlockerCodes: sortedUnique(decision.policyBlockerCodes),
    corpusInvalidCodes: sortedUnique(decision.corpusInvalidCodes),
  };
  if (
    decision.authorizationState !== "authorized" ||
    !input.globallyAuthorized.has(decision.caseId)
  ) {
    return {
      ...base,
      integrityState: "not_evaluated",
      integrityEvaluationCodes: [],
      integrityDiagnosticCodes: [],
      annotationState: "not_evaluated",
      annotationEvaluationCodes: [],
      countedForCoverage: false,
    };
  }

  const integrityMatches = input.integrityResults.filter(
    (result) => result.caseId === decision.caseId,
  );
  if (integrityMatches.length !== 1) {
    const integrityEvaluationCodes: ManufacturingCorpusIntegrityEvaluationCode[] =
      integrityMatches.length === 0
        ? ["integrity_result_missing"]
        : ["integrity_result_ambiguous"];
    return {
      ...base,
      integrityState:
        integrityMatches.length === 0 ? "not_evaluated" : "failed",
      integrityEvaluationCodes,
      integrityDiagnosticCodes: [],
      annotationState: "not_evaluated",
      annotationEvaluationCodes: [],
      countedForCoverage: false,
    };
  }

  const integrity = integrityMatches[0];
  const normalizedDiagnostics = normalizeIntegrityDiagnostics(
    integrity.diagnosticCodes,
  );
  if (integrity.state === "failed") {
    return {
      ...base,
      integrityState: "failed",
      integrityEvaluationCodes: normalizedDiagnostics.evaluationCodes,
      integrityDiagnosticCodes: normalizedDiagnostics.diagnosticCodes,
      annotationState: "not_evaluated",
      annotationEvaluationCodes: [],
      countedForCoverage: false,
    };
  }
  if (integrity.diagnosticCodes.length > 0) {
    return {
      ...base,
      integrityState: "failed",
      integrityEvaluationCodes: sortedUnique([
        "integrity_result_inconsistent",
        ...normalizedDiagnostics.evaluationCodes,
      ]),
      integrityDiagnosticCodes: [],
      annotationState: "not_evaluated",
      annotationEvaluationCodes: [],
      countedForCoverage: false,
    };
  }
  const annotationMatches = input.verifiedAnnotations.filter(
    (entry) => entry.caseId === decision.caseId,
  );
  let annotationState: ManufacturingCorpusAnnotationState = "not_evaluated";
  let annotationEvaluationCodes: ManufacturingCorpusAnnotationEvaluationCode[] =
    [];
  if (annotationMatches.length === 0) {
    annotationState = "missing";
    annotationEvaluationCodes = ["annotation_result_missing"];
  } else if (annotationMatches.length > 1) {
    annotationEvaluationCodes = ["annotation_result_ambiguous"];
  } else {
    const annotation = annotationMatches[0].annotation;
    if (annotation.caseId !== decision.caseId) {
      annotationState = "case_mismatch";
      annotationEvaluationCodes = ["annotation_case_mismatch"];
    } else if (
      annotationMatches[0].annotationArtifactId !==
      input.expectedAnnotationArtifactId
    ) {
      annotationEvaluationCodes = ["annotation_unverified"];
    } else if (annotation.review.state === "pending_manufacturing_review") {
      annotationState = "pending";
      annotationEvaluationCodes = ["annotation_review_pending"];
    } else if (
      Date.parse(annotation.review.reviewedAt) > input.evaluationTime
    ) {
      annotationState = "pending";
      annotationEvaluationCodes = ["annotation_review_not_effective"];
    } else {
      annotationState = "approved";
    }
  }

  return {
    ...base,
    integrityState: "passed",
    integrityEvaluationCodes: normalizedDiagnostics.evaluationCodes,
    integrityDiagnosticCodes: normalizedDiagnostics.diagnosticCodes,
    annotationState,
    annotationEvaluationCodes,
    countedForCoverage: annotationState === "approved",
  };
}

function buildCoverage(
  manifest: ManufacturingCorpusManifest,
  caseResults: readonly ManufacturingCorpusPolicyCaseResult[],
) {
  const byCaseId = new Map(caseResults.map((result) => [result.caseId, result]));
  return manifest.targets
    .map((target): ManufacturingCorpusCoverageResult => {
      const present = manifest.cases.filter(
        (corpusCase) =>
          corpusCase.qualificationTarget === target.qualificationTarget &&
          corpusCase.processFamilies.includes(target.processFamily),
      );
      const integrityPassed = present.filter(
        (corpusCase) =>
          byCaseId.get(corpusCase.caseId)?.integrityState === "passed",
      );
      const eligible = present.filter(
        (corpusCase) =>
          byCaseId.get(corpusCase.caseId)?.countedForCoverage === true,
      );
      const eligibleConsentedRealPackages = eligible.filter(
        (corpusCase) => corpusCase.sourceClass === "consented_customer",
      ).length;
      const gaps: ManufacturingCorpusCoverageGap[] = [];
      if (eligibleConsentedRealPackages < target.minimumConsentedRealPackages) {
        gaps.push({
          code: "minimum_consented_real_packages_not_met",
          required: target.minimumConsentedRealPackages,
          actual: eligibleConsentedRealPackages,
          deficit:
            target.minimumConsentedRealPackages -
            eligibleConsentedRealPackages,
        });
      }
      if (eligible.length < target.minimumPackages) {
        gaps.push({
          code: "minimum_packages_not_met",
          required: target.minimumPackages,
          actual: eligible.length,
          deficit: target.minimumPackages - eligible.length,
        });
      }
      return {
        processFamily: target.processFamily,
        qualificationTarget: target.qualificationTarget,
        minimumPackages: target.minimumPackages,
        minimumConsentedRealPackages: target.minimumConsentedRealPackages,
        presentPackages: present.length,
        integrityPassedPackages: integrityPassed.length,
        eligiblePackages: eligible.length,
        eligibleConsentedRealPackages,
        promotionBlocked: gaps.length > 0,
        gaps,
      };
    })
    .sort((left, right) =>
      stableCompare(
        `${left.processFamily}\0${left.qualificationTarget}`,
        `${right.processFamily}\0${right.qualificationTarget}`,
      ),
    );
}

/** Combines authorized integrity results with verified annotations in memory. */
export function evaluateManufacturingCorpusPolicy(
  input: EvaluateManufacturingCorpusPolicyInput,
): ManufacturingCorpusPolicyReport {
  const globallyAuthorized = new Set(input.preflightPlan.authorizedCaseIds);
  const evaluationTime = Date.parse(input.preflightPlan.evaluationAt);
  const casesById = new Map(
    input.manifest.cases.map((corpusCase) => [
      corpusCase.caseId,
      corpusCase,
    ]),
  );
  const caseResults = input.preflightPlan.caseDecisions
    .map((decision) =>
      evaluateCase({
        decision,
        globallyAuthorized,
        integrityResults: input.integrityResults,
        verifiedAnnotations: input.verifiedAnnotations,
        expectedAnnotationArtifactId: casesById.get(decision.caseId)
          ?.annotationArtifact.artifactId,
        evaluationTime,
      }),
    )
    .sort((left, right) => stableCompare(left.caseId, right.caseId));
  const coverage = buildCoverage(input.manifest, caseResults);
  return {
    schemaVersion: MANUFACTURING_CORPUS_POLICY_REPORT_SCHEMA_VERSION,
    processorId: MANUFACTURING_CORPUS_VALIDATOR_PROCESSOR_ID,
    corpusVersion: input.manifest.corpusVersion,
    evaluationAt: input.preflightPlan.evaluationAt,
    corpusInvalid: input.preflightPlan.corpusInvalid,
    corpusInvalidCodes: sortedUnique(input.preflightPlan.corpusInvalidCodes),
    promotionBlocked:
      input.preflightPlan.corpusInvalid ||
      coverage.some((result) => result.promotionBlocked),
    caseResults,
    coverage,
  };
}

/** Serializes only the closed, path-free report shape deterministically. */
export function serializeManufacturingCorpusPolicyReport(
  report: ManufacturingCorpusPolicyReport,
) {
  const sanitized: ManufacturingCorpusPolicyReport = {
    schemaVersion: MANUFACTURING_CORPUS_POLICY_REPORT_SCHEMA_VERSION,
    processorId: MANUFACTURING_CORPUS_VALIDATOR_PROCESSOR_ID,
    corpusVersion: report.corpusVersion,
    evaluationAt: report.evaluationAt,
    corpusInvalid: report.corpusInvalid,
    corpusInvalidCodes: sortedUnique(report.corpusInvalidCodes),
    promotionBlocked: report.promotionBlocked,
    caseResults: report.caseResults
      .map((result) => {
        const integrity = normalizeIntegrityDiagnostics(
          result.integrityDiagnosticCodes,
        );
        return {
          caseId: result.caseId,
          authorizationState: result.authorizationState,
          policyBlockerCodes: sortedUnique(result.policyBlockerCodes),
          corpusInvalidCodes: sortedUnique(result.corpusInvalidCodes),
          integrityState: result.integrityState,
          integrityEvaluationCodes: sortedUnique([
            ...result.integrityEvaluationCodes,
            ...integrity.evaluationCodes,
          ]),
          integrityDiagnosticCodes: integrity.diagnosticCodes,
          annotationState: result.annotationState,
          annotationEvaluationCodes: sortedUnique(
            result.annotationEvaluationCodes,
          ),
          countedForCoverage: result.countedForCoverage,
        };
      })
      .sort((left, right) => stableCompare(left.caseId, right.caseId)),
    coverage: report.coverage
      .map((result) => ({
        processFamily: result.processFamily,
        qualificationTarget: result.qualificationTarget,
        minimumPackages: result.minimumPackages,
        minimumConsentedRealPackages: result.minimumConsentedRealPackages,
        presentPackages: result.presentPackages,
        integrityPassedPackages: result.integrityPassedPackages,
        eligiblePackages: result.eligiblePackages,
        eligibleConsentedRealPackages: result.eligibleConsentedRealPackages,
        promotionBlocked: result.promotionBlocked,
        gaps: result.gaps
          .map((gap) => ({
            code: gap.code,
            required: gap.required,
            actual: gap.actual,
            deficit: gap.deficit,
          }))
          .sort((left, right) => stableCompare(left.code, right.code)),
      }))
      .sort((left, right) =>
        stableCompare(
          `${left.processFamily}\0${left.qualificationTarget}`,
          `${right.processFamily}\0${right.qualificationTarget}`,
        ),
      ),
  };
  return `${JSON.stringify(sanitized, null, 2)}\n`;
}
