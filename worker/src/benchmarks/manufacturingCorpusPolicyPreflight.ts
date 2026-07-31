import type {
  ManufacturingCorpusCase,
  ManufacturingCorpusManifest,
} from "./manufacturingCorpusContract.js";
import { manufacturingCorpusUtcTimestampSchema } from "./manufacturingCorpusVocabulary.js";

export const MANUFACTURING_CORPUS_VALIDATOR_PROCESSOR_ID =
  "overdrafter_corpus_validator";

export const MANUFACTURING_CORPUS_INVALID_CODES = [
  "artifact_root_ambiguous",
  "artifact_root_missing",
  "case_id_ambiguous",
  "customer_case_requires_external_root",
  "private_case_requires_external_root",
  "rights_record_ambiguous",
  "rights_record_missing",
  "rights_source_class_mismatch",
  "root_classification_incompatible",
] as const;

export const MANUFACTURING_CORPUS_POLICY_BLOCKER_CODES = [
  "annotation_redistribution_incompatible",
  "asset_redistribution_incompatible",
  "backup_retention_expired",
  "benchmark_retention_artifact_class_denied",
  "benchmark_retention_denied",
  "benchmark_retention_processor_denied",
  "benchmark_retention_processor_not_local",
  "derived_retention_expired",
  "evaluation_tenant_mismatch",
  "evaluation_tenant_required",
  "governance_not_effective",
  "governance_pending",
  "redaction_pending",
  "rights_approval_not_effective",
  "rights_approval_pending",
  "rights_deletion_requested",
  "rights_expired",
  "rights_not_effective",
  "rights_revoked",
  "source_retention_expired",
] as const;

export type ManufacturingCorpusInvalidCode =
  (typeof MANUFACTURING_CORPUS_INVALID_CODES)[number];
export type ManufacturingCorpusPolicyBlockerCode =
  (typeof MANUFACTURING_CORPUS_POLICY_BLOCKER_CODES)[number];
type ManufacturingCorpusPreflightFindingCode =
  ManufacturingCorpusInvalidCode | ManufacturingCorpusPolicyBlockerCode;
export type ManufacturingCorpusPreflightAuthorizationState =
  "authorized" | "ineligible" | "corpus_invalid";

export type ManufacturingCorpusPolicyPreflightInput = {
  manifest: ManufacturingCorpusManifest;
  evaluationAt: string;
  evaluationTenantRef?: string;
};

export type ManufacturingCorpusPolicyPreflightDecision = {
  caseId: string;
  authorizationState: ManufacturingCorpusPreflightAuthorizationState;
  policyBlockerCodes: ManufacturingCorpusPolicyBlockerCode[];
  corpusInvalidCodes: ManufacturingCorpusInvalidCode[];
};

export type ManufacturingCorpusPolicyPreflightPlan = {
  processorId: typeof MANUFACTURING_CORPUS_VALIDATOR_PROCESSOR_ID;
  evaluationAt: string;
  corpusInvalid: boolean;
  corpusInvalidCodes: ManufacturingCorpusInvalidCode[];
  authorizedCaseIds: string[];
  caseDecisions: ManufacturingCorpusPolicyPreflightDecision[];
};

const CORPUS_INVALID_CODE_SET = new Set<ManufacturingCorpusPreflightFindingCode>(
  MANUFACTURING_CORPUS_INVALID_CODES,
);
const POLICY_BLOCKER_CODE_SET = new Set<ManufacturingCorpusPreflightFindingCode>(
  MANUFACTURING_CORPUS_POLICY_BLOCKER_CODES,
);

function stableCompare(left: string, right: string): number {
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

function getDuplicateValues(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
    }
    seen.add(value);
  }
  return duplicates;
}

function hasReached(evaluationTime: number, timestamp: string | null) {
  return timestamp !== null && Date.parse(timestamp) <= evaluationTime;
}

function getPreflightFindings(input: {
  manifest: ManufacturingCorpusManifest;
  corpusCase: ManufacturingCorpusCase;
  duplicateCaseIds: ReadonlySet<string>;
  evaluationTime: number;
  evaluationTenantRef?: string;
}): ManufacturingCorpusPreflightFindingCode[] {
  const { manifest, corpusCase, duplicateCaseIds, evaluationTime } = input;
  const { evaluationTenantRef } = input;
  const findings: ManufacturingCorpusPreflightFindingCode[] = [];

  if (duplicateCaseIds.has(corpusCase.caseId)) {
    findings.push("case_id_ambiguous");
  }

  const matchingRights = manifest.rights.filter(
    (rights) => rights.rightsId === corpusCase.rightsId,
  );
  if (matchingRights.length === 0) {
    findings.push("rights_record_missing");
  } else if (matchingRights.length > 1) {
    findings.push("rights_record_ambiguous");
  }

  const allArtifacts = [...corpusCase.artifacts, corpusCase.annotationArtifact];
  const rootsByArtifact = allArtifacts.map((artifact) => ({
    artifact,
    roots: manifest.roots.filter((root) => root.rootId === artifact.rootId),
  }));

  for (const { roots } of rootsByArtifact) {
    if (roots.length === 0) {
      findings.push("artifact_root_missing");
      continue;
    }
    if (roots.length > 1) {
      findings.push("artifact_root_ambiguous");
      continue;
    }

    const root = roots[0];
    if (
      !root.allowedDataClassifications.some(
        (classification) =>
          classification === corpusCase.dataClassification,
      )
    ) {
      findings.push("root_classification_incompatible");
    }
    if (
      corpusCase.dataClassification !== "public" &&
      root.kind !== "external_mount"
    ) {
      findings.push("private_case_requires_external_root");
    }
    if (
      corpusCase.sourceClass === "consented_customer" &&
      root.kind !== "external_mount"
    ) {
      findings.push("customer_case_requires_external_root");
    }
  }

  if (corpusCase.redaction.state === "pending") {
    findings.push("redaction_pending");
  }

  if (matchingRights.length !== 1) {
    return sortedUnique(findings);
  }

  const rights = matchingRights[0];
  if (rights.sourceClass !== corpusCase.sourceClass) {
    findings.push("rights_source_class_mismatch");
  }

  if (rights.governance.status === "pending") {
    findings.push("governance_pending");
  } else if (Date.parse(rights.governance.approvedAt) > evaluationTime) {
    findings.push("governance_not_effective");
  }

  if (rights.approval.status === "pending") {
    findings.push("rights_approval_pending");
  } else if (Date.parse(rights.approval.approvedAt) > evaluationTime) {
    findings.push("rights_approval_not_effective");
  }

  if (
    rights.validity.effectiveAt === null ||
    Date.parse(rights.validity.effectiveAt) > evaluationTime
  ) {
    findings.push("rights_not_effective");
  }
  const expirations = [
    ["rights_expired", rights.validity.expiresAt],
    ["source_retention_expired", rights.retention.sourceExpiresAt],
    ["derived_retention_expired", rights.retention.derivedExpiresAt],
    ["backup_retention_expired", rights.retention.backupExpiresAt],
  ] as const;
  for (const [code, timestamp] of expirations) {
    if (hasReached(evaluationTime, timestamp)) {
      findings.push(code);
    }
  }
  if (rights.revocation.state === "revoked") {
    findings.push("rights_revoked");
  }
  if (rights.deletion.state === "requested") {
    findings.push("rights_deletion_requested");
  }
  if (rights.tenantScope.kind === "single_tenant") {
    if (evaluationTenantRef === undefined) {
      findings.push("evaluation_tenant_required");
    } else if (evaluationTenantRef !== rights.tenantScope.tenantRef) {
      findings.push("evaluation_tenant_mismatch");
    }
  }

  for (const { artifact, roots } of rootsByArtifact) {
    if (roots.length !== 1 || roots[0].kind !== "manifest_relative") {
      continue;
    }
    if (
      artifact.artifactClass === "annotation" &&
      rights.redistribution.annotations !== "full_assets"
    ) {
      findings.push("annotation_redistribution_incompatible");
    } else if (
      artifact.artifactClass !== "annotation" &&
      rights.redistribution.assets !== "full_assets"
    ) {
      findings.push("asset_redistribution_incompatible");
    }
  }

  const retentionPermission = rights.permissions.benchmarkRetention;
  if (!retentionPermission.allowed) {
    findings.push("benchmark_retention_denied");
  } else {
    const requiredArtifactClasses = new Set(
      allArtifacts.map((artifact) => artifact.artifactClass),
    );
    if (
      [...requiredArtifactClasses].some(
        (artifactClass) =>
          !retentionPermission.artifactClasses.includes(artifactClass),
      )
    ) {
      findings.push("benchmark_retention_artifact_class_denied");
    }
    if (
      !retentionPermission.processorPolicy.allowedProcessors.includes(
        MANUFACTURING_CORPUS_VALIDATOR_PROCESSOR_ID,
      )
    ) {
      findings.push("benchmark_retention_processor_denied");
    }
    if (
      retentionPermission.processorPolicy.executionLocation !== "local_only"
    ) {
      findings.push("benchmark_retention_processor_not_local");
    }
  }

  return sortedUnique(findings);
}

/**
 * Resolves authorization from manifest metadata before any corpus path is
 * opened. Consumers must pass only `authorizedCaseIds` to filesystem work.
 *
 * A structurally invalid corpus suppresses the entire authorized list, while
 * case decisions retain localized diagnostics for a privacy-safe report.
 */
export function planManufacturingCorpusIntegrityAccess(
  input: ManufacturingCorpusPolicyPreflightInput,
): ManufacturingCorpusPolicyPreflightPlan {
  const evaluationAt = manufacturingCorpusUtcTimestampSchema.parse(
    input.evaluationAt,
  );
  const evaluationTime = Date.parse(evaluationAt);
  const duplicateCaseIds = getDuplicateValues(
    input.manifest.cases.map((corpusCase) => corpusCase.caseId),
  );
  const caseDecisions = input.manifest.cases
    .map((corpusCase): ManufacturingCorpusPolicyPreflightDecision => {
      const findings = getPreflightFindings({
        manifest: input.manifest,
        corpusCase,
        duplicateCaseIds,
        evaluationTime,
        evaluationTenantRef: input.evaluationTenantRef,
      });
      const corpusInvalidCodes = findings.filter(
        (code): code is ManufacturingCorpusInvalidCode =>
          CORPUS_INVALID_CODE_SET.has(code),
      );
      const policyBlockerCodes = findings.filter(
        (code): code is ManufacturingCorpusPolicyBlockerCode =>
          POLICY_BLOCKER_CODE_SET.has(code),
      );
      let authorizationState: ManufacturingCorpusPreflightAuthorizationState =
        "authorized";
      if (corpusInvalidCodes.length > 0) {
        authorizationState = "corpus_invalid";
      } else if (policyBlockerCodes.length > 0) {
        authorizationState = "ineligible";
      }

      return {
        caseId: corpusCase.caseId,
        authorizationState,
        policyBlockerCodes,
        corpusInvalidCodes,
      };
    })
    .sort((left, right) => stableCompare(left.caseId, right.caseId));
  const corpusInvalidCodes = sortedUnique(
    caseDecisions.flatMap((decision) => decision.corpusInvalidCodes),
  );
  const corpusInvalid = corpusInvalidCodes.length > 0;

  return {
    processorId: MANUFACTURING_CORPUS_VALIDATOR_PROCESSOR_ID,
    evaluationAt,
    corpusInvalid,
    corpusInvalidCodes,
    authorizedCaseIds: corpusInvalid
      ? []
      : caseDecisions
          .filter(
            (decision) => decision.authorizationState === "authorized",
          )
          .map((decision) => decision.caseId),
    caseDecisions,
  };
}
