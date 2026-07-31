// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  MANUFACTURING_CORPUS_CASE_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_MANIFEST_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION,
  type ManufacturingCorpusCase,
  type ManufacturingCorpusManifest,
} from "./manufacturingCorpusTopology.js";
import {
  MANUFACTURING_CORPUS_RIGHTS_SCHEMA_VERSION,
  type ManufacturingCorpusRights,
} from "./manufacturingCorpusRightsContract.js";
import {
  MANUFACTURING_CORPUS_INVALID_CODES,
  MANUFACTURING_CORPUS_POLICY_BLOCKER_CODES,
  MANUFACTURING_CORPUS_VALIDATOR_PROCESSOR_ID,
  planManufacturingCorpusIntegrityAccess,
} from "./manufacturingCorpusPolicyPreflight.js";
import { createDefaultDenyManufacturingCorpusPermissions } from "./manufacturingCorpusVocabulary.js";

const EVALUATION_AT = "2026-08-01T00:00:00Z";
const SHA256 = "a".repeat(64);

function makeRights(): ManufacturingCorpusRights {
  const permissions = createDefaultDenyManufacturingCorpusPermissions();
  permissions.benchmarkRetention = {
    allowed: true,
    artifactClasses: ["cad_model", "annotation"],
    processorPolicy: {
      executionLocation: "local_only",
      allowedProcessors: [MANUFACTURING_CORPUS_VALIDATOR_PROCESSOR_ID],
      rawOutputRetentionAllowed: false,
    },
  };
  return {
    schemaVersion: MANUFACTURING_CORPUS_RIGHTS_SCHEMA_VERSION,
    rightsId: "rights-synthetic",
    sourceClass: "synthetic",
    rightsBasisCode: "project_authored_synthetic",
    governance: {
      status: "approved",
      policyRef: "governance:private-reference",
      policyVersion: "1",
      approvedByRef: "user:private-governor",
      approvedAt: "2026-07-01T00:00:00Z",
    },
    evidence: {
      reference: "evidence:private-reference",
      sha256: null,
      basisVersion: "project-authored.v1",
    },
    approval: {
      status: "approved",
      approvedByRole: "data_governance",
      approvedByRef: "user:private-approver",
      approvedAt: "2026-07-01T00:00:00Z",
    },
    validity: {
      effectiveAt: "2026-07-01T00:00:00Z",
      expiresAt: null,
    },
    tenantScope: {
      kind: "none",
      crossTenantUse: false,
    },
    permissions,
    redistribution: {
      assets: "full_assets",
      annotations: "full_assets",
      derivedOutputs: "full_assets",
    },
    retention: {
      policyRef: "retention:private-reference",
      sourceExpiresAt: null,
      derivedExpiresAt: null,
      backupExpiresAt: null,
    },
    revocation: {
      state: "active",
      revokedAt: null,
      reasonCode: null,
      evidenceRef: null,
    },
    deletion: {
      state: "none",
      requestRef: null,
      requestedAt: null,
      sourcePurgedAt: null,
      derivedPurgedAt: null,
      backupPurgedAt: null,
      auditTombstoneRef: null,
      purgeVerification: null,
    },
    legalHold: {
      state: "inactive",
      reference: null,
      effectiveAt: null,
    },
  };
}

function makeCase(caseId = "case-1"): ManufacturingCorpusCase {
  return {
    schemaVersion: MANUFACTURING_CORPUS_CASE_SCHEMA_VERSION,
    caseId,
    processFamilies: ["cnc_milling"],
    qualificationTarget: "broad_estimate",
    sourceClass: "synthetic",
    dataClassification: "public",
    redaction: {
      state: "not_required",
      reviewRef: null,
    },
    protectedSourceRef: "source:private-reference",
    rightsId: "rights-synthetic",
    artifacts: [
      {
        artifactId: `cad-${caseId}`,
        artifactClass: "cad_model",
        rootId: "committed",
        relativePath: `fixtures/${caseId}.step`,
        mediaType: "application/step",
        byteSize: 128,
        sha256: SHA256,
      },
    ],
    annotationArtifact: {
      artifactId: `annotation-${caseId}`,
      artifactClass: "annotation",
      rootId: "committed",
      relativePath: `annotations/${caseId}.json`,
      mediaType: "application/json",
      byteSize: 128,
      sha256: SHA256,
    },
    executionLimits: {
      maxSourceBytes: 250_000_000,
      maxPackageBytes: 2_000_000_000,
      maxOutputBytes: 250_000_000,
      maxRecursionDepth: 32,
      timeoutMs: 60_000,
      memoryMb: 1024,
    },
  };
}

function makeManifest(): ManufacturingCorpusManifest {
  return {
    schemaVersion: MANUFACTURING_CORPUS_MANIFEST_SCHEMA_VERSION,
    manifestClass: "protected_internal",
    corpusVersion: "0.1.0",
    roots: [
      {
        schemaVersion: MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
        rootId: "committed",
        kind: "manifest_relative",
        relativePath: ".",
        accessClass: "redistributable",
        allowedDataClassifications: ["public"],
      },
    ],
    rights: [makeRights()],
    targets: [
      {
        schemaVersion: MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION,
        processFamily: "cnc_milling",
        qualificationTarget: "broad_estimate",
        minimumPackages: 1,
        minimumConsentedRealPackages: 0,
      },
    ],
    cases: [makeCase()],
  };
}

function makeCustomerManifest(): ManufacturingCorpusManifest {
  const manifest = makeManifest();
  manifest.roots = [
    {
      schemaVersion: MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
      rootId: "customer-root",
      kind: "external_mount",
      accessClass: "internal_only",
      allowedDataClassifications: ["confidential"],
    },
  ];
  manifest.cases[0] = {
    ...manifest.cases[0],
    sourceClass: "consented_customer",
    dataClassification: "confidential",
    protectedSourceRef: "customer:private-source",
    rightsId: "rights-customer",
    artifacts: manifest.cases[0].artifacts.map((artifact) => ({
      ...artifact,
      rootId: "customer-root",
    })),
    annotationArtifact: {
      ...manifest.cases[0].annotationArtifact,
      rootId: "customer-root",
    },
  };
  manifest.rights[0] = {
    ...manifest.rights[0],
    rightsId: "rights-customer",
    sourceClass: "consented_customer",
    evidence: {
      ...manifest.rights[0].evidence,
      sha256: SHA256,
    },
    tenantScope: {
      kind: "single_tenant",
      tenantRef: "tenant:private-reference",
      crossTenantUse: false,
    },
    redistribution: {
      assets: "internal_only",
      annotations: "internal_only",
      derivedOutputs: "internal_only",
    },
  };
  return manifest;
}

function plan(
  manifest: ManufacturingCorpusManifest,
  evaluationTenantRef?: string,
) {
  return planManufacturingCorpusIntegrityAccess({
    manifest,
    evaluationAt: EVALUATION_AT,
    evaluationTenantRef,
  });
}

describe("manufacturing corpus policy preflight", () => {
  it("exports disjoint closed invalid and ordinary blocker vocabularies", () => {
    const invalidCodes = new Set<string>(MANUFACTURING_CORPUS_INVALID_CODES);
    expect(
      MANUFACTURING_CORPUS_POLICY_BLOCKER_CODES.filter((code) =>
        invalidCodes.has(code),
      ),
    ).toEqual([]);
  });

  it("authorizes an eligible case for only the fixed local validator", () => {
    const result = plan(makeManifest());

    expect(result.processorId).toBe("overdrafter_corpus_validator");
    expect(result.corpusInvalid).toBe(false);
    expect(result.authorizedCaseIds).toEqual(["case-1"]);
    expect(result.caseDecisions).toEqual([
      {
        caseId: "case-1",
        authorizationState: "authorized",
        policyBlockerCodes: [],
        corpusInvalidCodes: [],
      },
    ]);
  });

  it("distinguishes root declaration failures from ordinary ineligibility", () => {
    const invalid = makeManifest();
    invalid.cases[0].artifacts[0].rootId = "missing-root";
    const invalidResult = plan(invalid);

    expect(invalidResult.corpusInvalid).toBe(true);
    expect(invalidResult.corpusInvalidCodes).toEqual([
      "artifact_root_missing",
    ]);
    expect(invalidResult.caseDecisions[0]).toMatchObject({
      authorizationState: "corpus_invalid",
      policyBlockerCodes: [],
      corpusInvalidCodes: ["artifact_root_missing"],
    });

    const ineligible = makeManifest();
    ineligible.cases[0].redaction = {
      state: "pending",
      reviewRef: "review:private-reference",
    };
    const ineligibleResult = plan(ineligible);

    expect(ineligibleResult.corpusInvalid).toBe(false);
    expect(ineligibleResult.authorizedCaseIds).toEqual([]);
    expect(ineligibleResult.caseDecisions[0]).toMatchObject({
      authorizationState: "ineligible",
      policyBlockerCodes: ["redaction_pending"],
      corpusInvalidCodes: [],
    });
  });

  it("classifies private data on a committed root as corpus-invalid", () => {
    const manifest = makeManifest();
    manifest.cases[0].dataClassification = "internal";

    const result = plan(manifest);

    expect(result.corpusInvalid).toBe(true);
    expect(result.caseDecisions[0].corpusInvalidCodes).toEqual([
      "private_case_requires_external_root",
      "root_classification_incompatible",
    ]);
    expect(result.caseDecisions[0].policyBlockerCodes).toEqual([]);
  });

  it("suppresses all file access when any case makes the corpus invalid", () => {
    const manifest = makeManifest();
    const ineligible = makeCase("case-ineligible");
    ineligible.redaction = {
      state: "pending",
      reviewRef: "review:private-reference",
    };
    const invalid = makeCase("case-invalid");
    invalid.annotationArtifact.rootId = "missing-root";
    manifest.cases = [makeCase("case-authorized"), ineligible, invalid];

    const result = plan(manifest);

    expect(result.corpusInvalid).toBe(true);
    expect(result.authorizedCaseIds).toEqual([]);
    expect(
      result.caseDecisions.map((decision) => [
        decision.caseId,
        decision.authorizationState,
      ]),
    ).toEqual([
      ["case-authorized", "authorized"],
      ["case-ineligible", "ineligible"],
      ["case-invalid", "corpus_invalid"],
    ]);
  });

  it("requires an exact tenant without exposing the tenant reference", () => {
    const manifest = makeCustomerManifest();
    const missing = plan(manifest);
    const mismatched = plan(manifest, "tenant:wrong-private-reference");
    const exact = plan(manifest, "tenant:private-reference");

    expect(missing.caseDecisions[0].policyBlockerCodes).toEqual([
      "evaluation_tenant_required",
    ]);
    expect(mismatched.caseDecisions[0].policyBlockerCodes).toEqual([
      "evaluation_tenant_mismatch",
    ]);
    expect(exact.authorizedCaseIds).toEqual(["case-1"]);
    expect(JSON.stringify(mismatched)).not.toContain("wrong-private");
    expect(JSON.stringify(exact)).not.toContain("private-reference");
  });

  it.each([
    ["rights", "rights_expired"],
    ["source", "source_retention_expired"],
    ["derived", "derived_retention_expired"],
    ["backup", "backup_retention_expired"],
  ] as const)("blocks %s expiry at the exact evaluation instant", (kind, code) => {
    const manifest = makeManifest();
    const rights = manifest.rights[0];
    if (kind === "rights") {
      rights.validity.expiresAt = EVALUATION_AT;
    } else if (kind === "source") {
      rights.retention.sourceExpiresAt = EVALUATION_AT;
    } else if (kind === "derived") {
      rights.retention.derivedExpiresAt = EVALUATION_AT;
    } else {
      rights.retention.backupExpiresAt = EVALUATION_AT;
    }

    expect(plan(manifest).caseDecisions[0].policyBlockerCodes).toContain(code);
  });

  it("allows effective equality but blocks declared revocation and deletion immediately", () => {
    const manifest = makeManifest();
    const rights = manifest.rights[0];
    rights.governance = {
      ...rights.governance,
      approvedAt: EVALUATION_AT,
    };
    rights.approval = {
      ...rights.approval,
      approvedAt: EVALUATION_AT,
    };
    rights.validity.effectiveAt = EVALUATION_AT;
    rights.revocation = {
      state: "revoked",
      revokedAt: "2026-08-02T00:00:00Z",
      reasonCode: "future_revocation",
      evidenceRef: "revocation:private-reference",
    };
    rights.deletion = {
      state: "requested",
      requestRef: "deletion:private-reference",
      requestedAt: "2026-08-02T00:00:00Z",
      sourcePurgedAt: null,
      derivedPurgedAt: null,
      backupPurgedAt: null,
      auditTombstoneRef: null,
      purgeVerification: null,
    };

    expect(plan(manifest).caseDecisions[0].policyBlockerCodes).toEqual([
      "rights_deletion_requested",
      "rights_revoked",
    ]);
  });

  it("keeps legal hold neutral and never lets it restore expired rights", () => {
    const manifest = makeManifest();
    manifest.rights[0].validity.expiresAt = EVALUATION_AT;
    manifest.rights[0].legalHold = {
      state: "active",
      reference: "hold:private-reference",
      effectiveAt: "2026-07-01T00:00:00Z",
    };

    expect(plan(manifest).caseDecisions[0].policyBlockerCodes).toEqual([
      "rights_expired",
    ]);
  });

  it("keeps pending and not-yet-effective governance ordinary ineligibility", () => {
    const pending = makeManifest();
    pending.rights[0].governance = {
      status: "pending",
      policyRef: "governance:private-reference",
      policyVersion: null,
      approvedByRef: null,
      approvedAt: null,
    };
    pending.rights[0].approval = {
      status: "pending",
      approvedByRole: null,
      approvedByRef: null,
      approvedAt: null,
    };
    pending.rights[0].validity.effectiveAt = null;

    expect(plan(pending).caseDecisions[0]).toMatchObject({
      authorizationState: "ineligible",
      corpusInvalidCodes: [],
      policyBlockerCodes: [
        "governance_pending",
        "rights_approval_pending",
        "rights_not_effective",
      ],
    });

    const future = makeManifest();
    future.rights[0].governance = {
      ...future.rights[0].governance,
      approvedAt: "2026-08-02T00:00:00Z",
    };
    future.rights[0].approval = {
      ...future.rights[0].approval,
      approvedAt: "2026-08-02T00:00:00Z",
    };
    future.rights[0].validity.effectiveAt = "2026-08-02T00:00:00Z";

    expect(plan(future).caseDecisions[0].policyBlockerCodes).toEqual([
      "governance_not_effective",
      "rights_approval_not_effective",
      "rights_not_effective",
    ]);
  });

  it("uses only benchmark retention permission and accepts extra processors", () => {
    const allowed = makeManifest();
    allowed.rights[0].permissions.localParserEvaluation.allowed = false;
    allowed.rights[0].permissions.geometrySdkEvaluation.allowed = false;
    allowed.rights[0].permissions.benchmarkRetention.processorPolicy
      .allowedProcessors.push("another_local_processor");
    expect(plan(allowed).authorizedCaseIds).toEqual(["case-1"]);

    const lookalike = makeManifest();
    lookalike.rights[0].permissions.benchmarkRetention.processorPolicy
      .allowedProcessors = ["overdrafter-corpus-validator"];
    expect(plan(lookalike).caseDecisions[0].policyBlockerCodes).toEqual([
      "benchmark_retention_processor_denied",
    ]);
  });

  it("checks all artifact classes, committed redistribution, and local execution", () => {
    const manifest = makeManifest();
    const grant = manifest.rights[0].permissions.benchmarkRetention;
    grant.artifactClasses = ["cad_model"];
    grant.processorPolicy.executionLocation = "approved_service";
    manifest.rights[0].redistribution.assets = "metadata_only";
    manifest.rights[0].redistribution.annotations = "metadata_only";

    expect(plan(manifest).caseDecisions[0].policyBlockerCodes).toEqual([
      "annotation_redistribution_incompatible",
      "asset_redistribution_incompatible",
      "benchmark_retention_artifact_class_denied",
      "benchmark_retention_processor_not_local",
    ]);
  });

  it("sorts decisions and closed diagnostics deterministically", () => {
    const manifest = makeManifest();
    const second = makeCase("a-case");
    second.artifacts[0].rootId = "missing-root";
    second.annotationArtifact.rootId = "missing-root";
    manifest.cases = [makeCase("z-case"), second];
    manifest.rights[0].permissions.benchmarkRetention.allowed = false;
    manifest.rights[0].permissions.benchmarkRetention.artifactClasses = [];
    manifest.rights[0].permissions.benchmarkRetention.processorPolicy
      .allowedProcessors = [];

    const first = plan(manifest);
    const secondRun = plan(structuredClone(manifest));

    expect(first).toEqual(secondRun);
    expect(first.caseDecisions.map((decision) => decision.caseId)).toEqual([
      "a-case",
      "z-case",
    ]);
    expect(first.caseDecisions[0]).toMatchObject({
      authorizationState: "corpus_invalid",
      corpusInvalidCodes: ["artifact_root_missing"],
      policyBlockerCodes: ["benchmark_retention_denied"],
    });
  });

  it("returns a privacy-safe plan and rejects a missing or non-UTC evaluation time", () => {
    const serialized = JSON.stringify(plan(makeCustomerManifest(), "tenant:private-reference"));
    for (const secret of [
      "tenant:private-reference",
      "source:private",
      "evidence:private",
      "fixtures/",
      "annotations/",
    ]) {
      expect(serialized).not.toContain(secret);
    }

    expect(() =>
      planManufacturingCorpusIntegrityAccess({
        manifest: makeManifest(),
        evaluationAt: "2026-08-01T00:00:00-07:00",
      }),
    ).toThrow();
    expect(() =>
      planManufacturingCorpusIntegrityAccess({
        manifest: makeManifest(),
        evaluationAt: undefined as unknown as string,
      }),
    ).toThrow();
  });
});
