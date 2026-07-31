// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  MANUFACTURING_CORPUS_ANNOTATION_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_CASE_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_MANIFEST_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_RIGHTS_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION,
  createDefaultDenyManufacturingCorpusPermissions,
  type ManufacturingCorpusAnnotation,
  type ManufacturingCorpusCase,
  type ManufacturingCorpusManifest,
  type ManufacturingCorpusRights,
} from "./manufacturingCorpusContract.js";
import {
  evaluateManufacturingCorpusPolicy,
  serializeManufacturingCorpusPolicyReport,
  type DeclaredCaseIntegrityResult,
  type VerifiedManufacturingCorpusAnnotation,
} from "./manufacturingCorpusPolicy.js";
import {
  MANUFACTURING_CORPUS_VALIDATOR_PROCESSOR_ID,
  planManufacturingCorpusIntegrityAccess,
} from "./manufacturingCorpusPolicyPreflight.js";

const EVALUATION_AT = "2026-08-01T00:00:00Z";
const SHA256 = "a".repeat(64);

function makeRights(
  rightsId = "rights-synthetic",
  sourceClass: "synthetic" | "consented_customer" = "synthetic",
): ManufacturingCorpusRights {
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
  const tenantScope =
    sourceClass === "consented_customer"
      ? {
          kind: "single_tenant" as const,
          tenantRef: "tenant:private-allowed",
          crossTenantUse: false as const,
        }
      : {
          kind: "none" as const,
          crossTenantUse: false as const,
        };
  const redistribution =
    sourceClass === "consented_customer"
      ? {
          assets: "internal_only" as const,
          annotations: "internal_only" as const,
          derivedOutputs: "internal_only" as const,
        }
      : {
          assets: "full_assets" as const,
          annotations: "full_assets" as const,
          derivedOutputs: "full_assets" as const,
        };
  return {
    schemaVersion: MANUFACTURING_CORPUS_RIGHTS_SCHEMA_VERSION,
    rightsId,
    sourceClass,
    rightsBasisCode: "approved_basis",
    governance: {
      status: "approved",
      policyRef: "governance:private-reference",
      policyVersion: "1",
      approvedByRef: "user:private-governor",
      approvedAt: "2026-07-01T00:00:00Z",
    },
    evidence: {
      reference: "evidence:private-reference",
      sha256: sourceClass === "consented_customer" ? SHA256 : null,
      basisVersion: "basis.v1",
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
    tenantScope,
    permissions,
    redistribution,
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

function makeCase(
  caseId: string,
  options: {
    customer?: boolean;
    processFamilies?: ManufacturingCorpusCase["processFamilies"];
  } = {},
): ManufacturingCorpusCase {
  const customer = options.customer ?? false;
  const rootId = customer ? "customer-root" : "committed";
  return {
    schemaVersion: MANUFACTURING_CORPUS_CASE_SCHEMA_VERSION,
    caseId,
    processFamilies: options.processFamilies ?? ["cnc_milling"],
    qualificationTarget: "broad_estimate",
    sourceClass: customer ? "consented_customer" : "synthetic",
    dataClassification: customer ? "confidential" : "public",
    redaction: {
      state: "not_required",
      reviewRef: null,
    },
    protectedSourceRef: `source:private-${caseId}`,
    rightsId: customer ? "rights-customer" : "rights-synthetic",
    artifacts: [
      {
        artifactId: `cad-${caseId}`,
        artifactClass: "cad_model",
        rootId,
        relativePath: `fixtures/private-${caseId}.step`,
        mediaType: "application/step",
        byteSize: 128,
        sha256: SHA256,
      },
    ],
    annotationArtifact: {
      artifactId: `annotation-${caseId}`,
      artifactClass: "annotation",
      rootId,
      relativePath: `annotations/private-${caseId}.json`,
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

function makeManifest(
  cases: ManufacturingCorpusCase[] = [makeCase("case-1")],
): ManufacturingCorpusManifest {
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
      {
        schemaVersion: MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
        rootId: "customer-root",
        kind: "external_mount",
        accessClass: "internal_only",
        allowedDataClassifications: ["confidential"],
      },
    ],
    rights: [
      makeRights(),
      makeRights("rights-customer", "consented_customer"),
    ],
    targets: [
      {
        schemaVersion: MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION,
        processFamily: "cnc_milling",
        qualificationTarget: "broad_estimate",
        minimumPackages: 1,
        minimumConsentedRealPackages: 0,
      },
    ],
    cases,
  };
}

function makeAnnotation(
  caseId: string,
  review:
    | "pending_manufacturing_review"
    | "approved" = "approved",
  reviewedAt = "2026-07-15T00:00:00Z",
): ManufacturingCorpusAnnotation {
  const evidence = [
    {
      artifactId: `cad-${caseId}`,
      locator: `private-locator:${caseId}`,
    },
  ];
  return {
    schemaVersion: MANUFACTURING_CORPUS_ANNOTATION_SCHEMA_VERSION,
    annotationRevision: "1",
    caseId,
    review:
      review === "approved"
        ? {
            state: "approved",
            reviewerRole: "manufacturing_reviewer",
            reviewerRef: "reviewer:private-reference",
            reviewedAt,
            reviewRef: "review:private-reference",
            reviewPolicyVersion: "1",
          }
        : {
            state: "pending_manufacturing_review",
            reviewerRole: null,
            reviewerRef: null,
            reviewedAt: null,
            reviewRef: null,
            reviewPolicyVersion: null,
          },
    expected: {
      productStructure: {
        definitionCount: {
          state: "known",
          value: 1,
          evidence,
        },
        occurrenceCount: {
          state: "known",
          value: 1,
          evidence,
        },
      },
      units: {
        length: {
          state: "known",
          value: "mm",
          evidence,
        },
      },
      commonFeatures: [],
      requirements: [],
      candidateRoutes: [],
      unsupportedStates: [],
      execution: {
        outcome: "success",
        diagnosticCodes: [],
      },
    },
  };
}

function verified(
  caseId: string,
  annotation = makeAnnotation(caseId),
  annotationArtifactId = `annotation-${caseId}`,
): VerifiedManufacturingCorpusAnnotation {
  return {
    caseId,
    annotationArtifactId,
    annotation,
  };
}

function passed(caseId: string): DeclaredCaseIntegrityResult {
  return {
    caseId,
    state: "passed",
    diagnosticCodes: [],
  };
}

function evaluate(
  manifest: ManufacturingCorpusManifest,
  integrityResults: DeclaredCaseIntegrityResult[],
  verifiedAnnotations: VerifiedManufacturingCorpusAnnotation[],
) {
  return evaluateManufacturingCorpusPolicy({
    manifest,
    preflightPlan: planManufacturingCorpusIntegrityAccess({
      manifest,
      evaluationAt: EVALUATION_AT,
      evaluationTenantRef: "tenant:private-allowed",
    }),
    integrityResults,
    verifiedAnnotations,
  });
}

describe("manufacturing corpus policy report", () => {
  it("counts only an authorized, integrity-passed, approved annotation", () => {
    const report = evaluate(
      makeManifest(),
      [passed("case-1")],
      [verified("case-1")],
    );

    expect(report.caseResults[0]).toMatchObject({
      integrityState: "passed",
      annotationState: "approved",
      countedForCoverage: true,
    });
    expect(report.coverage[0]).toMatchObject({
      presentPackages: 1,
      integrityPassedPackages: 1,
      eligiblePackages: 1,
      promotionBlocked: false,
      gaps: [],
    });
    const serialized = serializeManufacturingCorpusPolicyReport(report);
    expect(serialized).not.toContain("private-locator");
    expect(serialized).not.toContain("reviewer:private-reference");
  });

  it("gives policy precedence and ignores erroneous downstream inputs", () => {
    const manifest = makeManifest();
    manifest.cases[0].redaction = {
      state: "pending",
      reviewRef: "review:private-pending",
    };
    const report = evaluate(
      manifest,
      [
        passed("case-1"),
        {
          caseId: "case-1",
          state: "failed",
          diagnosticCodes: ["/private/integrity/path"],
        },
      ],
      [
        verified(
          "case-1",
          makeAnnotation("different-private-case"),
          "private-artifact",
        ),
      ],
    );

    expect(report.caseResults[0]).toMatchObject({
      authorizationState: "ineligible",
      integrityState: "not_evaluated",
      integrityEvaluationCodes: [],
      integrityDiagnosticCodes: [],
      annotationState: "not_evaluated",
      annotationEvaluationCodes: [],
      countedForCoverage: false,
    });
    expect(serializeManufacturingCorpusPolicyReport(report)).not.toContain(
      "private/integrity",
    );
  });

  it("suppresses every integrity result when preflight marks the corpus invalid", () => {
    const manifest = makeManifest([
      makeCase("case-authorized"),
      makeCase("case-invalid"),
    ]);
    manifest.cases[1].annotationArtifact.rootId = "missing-root";
    const report = evaluate(
      manifest,
      [passed("case-authorized"), passed("case-invalid")],
      [verified("case-authorized"), verified("case-invalid")],
    );

    expect(report.corpusInvalid).toBe(true);
    expect(
      report.caseResults.map((result) => result.integrityState),
    ).toEqual(["not_evaluated", "not_evaluated"]);
    expect(
      report.caseResults.map((result) => result.annotationEvaluationCodes),
    ).toEqual([[], []]);
  });

  it("fails closed for missing, failed, and duplicate integrity results", () => {
    const manifest = makeManifest([
      makeCase("case-duplicate"),
      makeCase("case-failed"),
      makeCase("case-missing"),
    ]);
    const report = evaluate(
      manifest,
      [
        passed("case-duplicate"),
        passed("case-duplicate"),
        {
          caseId: "case-failed",
          state: "failed",
          diagnosticCodes: [
            "artifact_size_mismatch",
            "artifact_sha256_mismatch",
            "artifact_size_mismatch",
          ],
        },
      ],
      [
        verified("case-duplicate"),
        verified("case-failed"),
        verified("case-missing"),
      ],
    );

    expect(report.caseResults).toMatchObject([
      {
        caseId: "case-duplicate",
        integrityState: "failed",
        integrityEvaluationCodes: ["integrity_result_ambiguous"],
        annotationState: "not_evaluated",
        annotationEvaluationCodes: [],
      },
      {
        caseId: "case-failed",
        integrityState: "failed",
        integrityDiagnosticCodes: [
          "artifact_sha256_mismatch",
          "artifact_size_mismatch",
        ],
        annotationState: "not_evaluated",
        annotationEvaluationCodes: [],
      },
      {
        caseId: "case-missing",
        integrityState: "not_evaluated",
        integrityEvaluationCodes: ["integrity_result_missing"],
        annotationState: "not_evaluated",
        annotationEvaluationCodes: [],
      },
    ]);
  });

  it("rejects diagnostics on a declared passed integrity result", () => {
    const report = evaluate(
      makeManifest(),
      [
        {
          caseId: "case-1",
          state: "passed",
          diagnosticCodes: ["artifact_size_mismatch"],
        },
      ],
      [verified("case-1")],
    );

    expect(report.caseResults[0]).toMatchObject({
      integrityState: "failed",
      integrityEvaluationCodes: ["integrity_result_inconsistent"],
      integrityDiagnosticCodes: [],
      annotationState: "not_evaluated",
      annotationEvaluationCodes: [],
      countedForCoverage: false,
    });
  });

  it.each(["unknown_stable_code", "/private/path?token=secret"])(
    "rejects non-canonical filesystem diagnostic %s",
    (diagnosticCode) => {
      const report = evaluate(
        makeManifest(),
        [
          {
            caseId: "case-1",
            state: "failed",
            diagnosticCodes: [
              diagnosticCode as DeclaredCaseIntegrityResult["diagnosticCodes"][number],
            ],
          },
        ],
        [verified("case-1")],
      );

      expect(report.caseResults[0]).toMatchObject({
        integrityState: "failed",
        integrityEvaluationCodes: ["integrity_diagnostic_invalid"],
        integrityDiagnosticCodes: [],
        annotationState: "not_evaluated",
      });
      expect(serializeManufacturingCorpusPolicyReport(report)).not.toContain(
        diagnosticCode,
      );
    },
  );

  it("distinguishes every passed-integrity annotation outcome", () => {
    const caseIds = [
      "approved",
      "artifact-unverified",
      "duplicate",
      "future",
      "mismatch",
      "missing",
      "pending",
    ];
    const manifest = makeManifest(caseIds.map((caseId) => makeCase(caseId)));
    const annotations = [
      verified("approved"),
      verified(
        "artifact-unverified",
        makeAnnotation("artifact-unverified"),
        "annotation-wrong",
      ),
      verified("duplicate"),
      verified("duplicate"),
      verified(
        "future",
        makeAnnotation("future", "approved", "2026-08-02T00:00:00Z"),
      ),
      verified("mismatch", makeAnnotation("different-case")),
      verified("pending", makeAnnotation("pending", "pending_manufacturing_review")),
    ];
    const report = evaluate(
      manifest,
      caseIds.map(passed),
      annotations,
    );
    const outcomes = Object.fromEntries(
      report.caseResults.map((result) => [
        result.caseId,
        [result.annotationState, result.annotationEvaluationCodes],
      ]),
    );

    expect(outcomes).toEqual({
      approved: ["approved", []],
      "artifact-unverified": ["not_evaluated", ["annotation_unverified"]],
      duplicate: ["not_evaluated", ["annotation_result_ambiguous"]],
      future: ["pending", ["annotation_review_not_effective"]],
      mismatch: ["case_mismatch", ["annotation_case_mismatch"]],
      missing: ["missing", ["annotation_result_missing"]],
      pending: ["pending", ["annotation_review_pending"]],
    });
  });

  it("counts multi-process cohorts once and emits sorted quantified gaps", () => {
    const manifest = makeManifest([
      makeCase("customer", {
        customer: true,
        processFamilies: ["cnc_milling"],
      }),
      makeCase("synthetic", {
        processFamilies: ["cnc_milling", "cnc_turning"],
      }),
    ]);
    manifest.targets = [
      {
        schemaVersion: MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION,
        processFamily: "cnc_turning",
        qualificationTarget: "broad_estimate",
        minimumPackages: 1,
        minimumConsentedRealPackages: 0,
      },
      {
        schemaVersion: MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION,
        processFamily: "cnc_milling",
        qualificationTarget: "broad_estimate",
        minimumPackages: 3,
        minimumConsentedRealPackages: 2,
      },
    ];
    const report = evaluate(
      manifest,
      [passed("customer"), passed("synthetic")],
      [verified("customer"), verified("synthetic")],
    );

    expect(report.coverage).toEqual([
      {
        processFamily: "cnc_milling",
        qualificationTarget: "broad_estimate",
        minimumPackages: 3,
        minimumConsentedRealPackages: 2,
        presentPackages: 2,
        integrityPassedPackages: 2,
        eligiblePackages: 2,
        eligibleConsentedRealPackages: 1,
        promotionBlocked: true,
        gaps: [
          {
            code: "minimum_consented_real_packages_not_met",
            required: 2,
            actual: 1,
            deficit: 1,
          },
          {
            code: "minimum_packages_not_met",
            required: 3,
            actual: 2,
            deficit: 1,
          },
        ],
      },
      {
        processFamily: "cnc_turning",
        qualificationTarget: "broad_estimate",
        minimumPackages: 1,
        minimumConsentedRealPackages: 0,
        presentPackages: 1,
        integrityPassedPackages: 1,
        eligiblePackages: 1,
        eligibleConsentedRealPackages: 0,
        promotionBlocked: false,
        gaps: [],
      },
    ]);
  });

  it("sanitizes free-form diagnostics and rebuilds a private canonical report", () => {
    const oversizedCode = `x${"a".repeat(128)}`;
    const report = evaluate(
      makeManifest(),
      [
        {
          caseId: "case-1",
          state: "failed",
          diagnosticCodes: [
            "artifact_read_failed",
            oversizedCode as DeclaredCaseIntegrityResult["diagnosticCodes"][number],
            "/private/path?token=secret" as DeclaredCaseIntegrityResult["diagnosticCodes"][number],
          ],
        },
      ],
      [verified("case-1")],
    );
    const unsafeReport = report as typeof report & {
      secretPath: string;
    };
    unsafeReport.secretPath = "/private/report/path";
    (
      unsafeReport.caseResults[0] as typeof unsafeReport.caseResults[0] & {
        tenantRef: string;
      }
    ).tenantRef = "tenant:private-leak";

    const serialized = serializeManufacturingCorpusPolicyReport(unsafeReport);

    expect(report.caseResults[0]).toMatchObject({
      integrityState: "failed",
      integrityEvaluationCodes: ["integrity_diagnostic_invalid"],
      integrityDiagnosticCodes: ["artifact_read_failed"],
      annotationState: "not_evaluated",
      countedForCoverage: false,
    });
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("tenantRef");
    expect(serialized).not.toContain(oversizedCode);
    expect(serialized).toBe(
      `${JSON.stringify(JSON.parse(serialized), null, 2)}\n`,
    );
  });

  it("is byte-stable when verified and integrity inputs are shuffled", () => {
    const manifest = makeManifest([makeCase("case-b"), makeCase("case-a")]);
    const integrity = [passed("case-b"), passed("case-a")];
    const annotations = [verified("case-b"), verified("case-a")];
    const first = evaluate(manifest, integrity, annotations);
    const second = evaluate(
      structuredClone(manifest),
      [...integrity].reverse(),
      [...annotations].reverse(),
    );

    expect(serializeManufacturingCorpusPolicyReport(first)).toBe(
      serializeManufacturingCorpusPolicyReport(second),
    );
    expect(first.caseResults.map((result) => result.caseId)).toEqual([
      "case-a",
      "case-b",
    ]);
  });
});
