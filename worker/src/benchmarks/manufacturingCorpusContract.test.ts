// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS,
  MANUFACTURING_CORPUS_ANNOTATION_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_CASE_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_MANIFEST_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_PERMISSION_PURPOSES,
  MANUFACTURING_CORPUS_RIGHTS_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION,
  createDefaultDenyManufacturingCorpusPermissions,
  manufacturingCorpusAnnotationSchema,
  manufacturingCorpusArtifactSchema,
  manufacturingCorpusCaseSchema,
  manufacturingCorpusManifestSchema,
  manufacturingCorpusPermissionGrantSchema,
  manufacturingCorpusRightsSchema,
  manufacturingCorpusRootSchema,
  manufacturingCorpusTargetSchema,
  portableRelativeFilePathSchema,
  portableRelativeRootPathSchema,
} from "./manufacturingCorpusContract.js";

const SHA256 = "a".repeat(64);

function makeDeniedPermissions() {
  return createDefaultDenyManufacturingCorpusPermissions();
}

function makeAllowedGrant(
  artifactClasses: Array<
    "cad_model" | "drawing" | "bom" | "annotation" | "quote_outcome" | "other"
  >,
) {
  return {
    allowed: true,
    artifactClasses,
    processorPolicy: {
      executionLocation: "local_only" as const,
      allowedProcessors: ["geometry_sdk"],
      rawOutputRetentionAllowed: false,
    },
  };
}

function makeValidRights() {
  return {
    schemaVersion: MANUFACTURING_CORPUS_RIGHTS_SCHEMA_VERSION,
    rightsId: "rights-synthetic",
    sourceClass: "synthetic" as const,
    rightsBasisCode: "project_authored_synthetic",
    governance: {
      status: "approved" as const,
      policyRef: "governance:ovd-242",
      policyVersion: "1",
      approvedByRef: "user:data-governance",
      approvedAt: "2026-07-30T00:00:00Z",
    },
    evidence: {
      reference: "repo:ovd-263:synthetic",
      sha256: null,
      basisVersion: "project-authored.v1",
    },
    approval: {
      status: "approved" as const,
      approvedByRole: "data_governance",
      approvedByRef: "user:data-governance",
      approvedAt: "2026-07-30T00:00:00Z",
    },
    validity: {
      effectiveAt: "2026-07-30T00:00:00Z",
      expiresAt: null,
    },
    tenantScope: {
      kind: "none" as const,
      crossTenantUse: false as const,
    },
    permissions: makeDeniedPermissions(),
    redistribution: {
      assets: "full_assets" as const,
      annotations: "full_assets" as const,
      derivedOutputs: "full_assets" as const,
    },
    retention: {
      policyRef: "retention:ovd-242:pending",
      sourceExpiresAt: null,
      derivedExpiresAt: null,
      backupExpiresAt: null,
    },
    revocation: {
      state: "active" as const,
      revokedAt: null,
      reasonCode: null,
      evidenceRef: null,
    },
    deletion: {
      state: "none" as const,
      requestRef: null,
      requestedAt: null,
      sourcePurgedAt: null,
      derivedPurgedAt: null,
      backupPurgedAt: null,
      auditTombstoneRef: null,
      purgeVerification: null,
    },
    legalHold: {
      state: "inactive" as const,
      reference: null,
      effectiveAt: null,
    },
  };
}

function makeValidRoot() {
  return {
    schemaVersion: MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
    rootId: "committed",
    kind: "manifest_relative" as const,
    relativePath: ".",
    accessClass: "redistributable" as const,
    allowedDataClassifications: ["public" as const],
  };
}

function makeValidTarget() {
  return {
    schemaVersion: MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION,
    processFamily: "cnc_milling" as const,
    qualificationTarget: "broad_estimate" as const,
    minimumPackages: 25,
    minimumConsentedRealPackages: 10,
  };
}

function makeValidArtifact(
  artifactId = "artifact-cad",
  artifactClass:
    | "cad_model"
    | "drawing"
    | "bom"
    | "annotation"
    | "quote_outcome"
    | "other" = "cad_model",
) {
  return {
    artifactId,
    artifactClass,
    rootId: "committed",
    relativePath:
      artifactClass === "annotation"
        ? "annotations/case-1.json"
        : "fixtures/case-1.step",
    mediaType:
      artifactClass === "annotation" ? "application/json" : "application/step",
    byteSize: 128,
    sha256: SHA256,
  };
}

function makeValidCase() {
  return {
    schemaVersion: MANUFACTURING_CORPUS_CASE_SCHEMA_VERSION,
    caseId: "case-1",
    processFamilies: ["cnc_milling" as const],
    qualificationTarget: "broad_estimate" as const,
    sourceClass: "synthetic" as const,
    dataClassification: "public" as const,
    redaction: {
      state: "not_required" as const,
      reviewRef: null,
    },
    protectedSourceRef: "synthetic:ovd-263:case-1",
    rightsId: "rights-synthetic",
    artifacts: [makeValidArtifact()],
    annotationArtifact: makeValidArtifact("annotation-case-1", "annotation"),
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

function makeValidAnnotation() {
  const evidence = [
    {
      artifactId: "artifact-cad",
      locator: "face-012",
    },
  ];
  return {
    schemaVersion: MANUFACTURING_CORPUS_ANNOTATION_SCHEMA_VERSION,
    annotationRevision: "1.0.0",
    caseId: "case-1",
    review: {
      state: "approved" as const,
      reviewerRole: "manufacturing_reviewer",
      reviewerRef: "user:manufacturing-reviewer",
      reviewedAt: "2026-07-30T00:00:00Z",
      reviewRef: "review:case-1:v1",
      reviewPolicyVersion: "manufacturing-review.v1",
    },
    expected: {
      productStructure: {
        definitionCount: {
          state: "known" as const,
          value: 1,
          evidence,
        },
        occurrenceCount: {
          state: "known" as const,
          value: 1,
          evidence,
        },
      },
      units: {
        length: {
          state: "known" as const,
          value: "mm" as const,
          evidence,
        },
      },
      commonFeatures: [
        {
          label: "through_hole",
          count: 2,
          parameters: {
            nominalDiameterMm: 6.35,
          },
          evidence,
        },
      ],
      requirements: [],
      candidateRoutes: [
        {
          processFamily: "cnc_milling" as const,
          state: "applicable" as const,
          evidence,
        },
      ],
      unsupportedStates: [],
      execution: {
        outcome: "success" as const,
        diagnosticCodes: [],
      },
    },
  };
}

function makeValidManifest() {
  return {
    schemaVersion: MANUFACTURING_CORPUS_MANIFEST_SCHEMA_VERSION,
    manifestClass: "protected_internal" as const,
    corpusVersion: "0.1.0",
    roots: [makeValidRoot()],
    rights: [makeValidRights()],
    targets: [makeValidTarget()],
    cases: [makeValidCase()],
  };
}

describe("manufacturing corpus versioned contracts", () => {
  it("parses each fully populated v1 record independently", () => {
    expect(
      manufacturingCorpusArtifactSchema.parse(makeValidArtifact()),
    ).toEqual(makeValidArtifact());
    expect(manufacturingCorpusRootSchema.parse(makeValidRoot())).toEqual(
      makeValidRoot(),
    );
    expect(manufacturingCorpusRightsSchema.parse(makeValidRights())).toEqual(
      makeValidRights(),
    );
    expect(manufacturingCorpusTargetSchema.parse(makeValidTarget())).toEqual(
      makeValidTarget(),
    );
    expect(manufacturingCorpusCaseSchema.parse(makeValidCase())).toEqual(
      makeValidCase(),
    );
    expect(
      manufacturingCorpusAnnotationSchema.parse(makeValidAnnotation()),
    ).toEqual(makeValidAnnotation());
    expect(
      manufacturingCorpusManifestSchema.parse(makeValidManifest()),
    ).toEqual(makeValidManifest());
  });

  it("rejects unknown schema versions", () => {
    const manifest = makeValidManifest();
    expect(
      manufacturingCorpusManifestSchema.safeParse({
        ...manifest,
        schemaVersion: "manufacturing-corpus-manifest.v2",
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...makeValidAnnotation(),
        schemaVersion: "manufacturing-corpus-annotation.v2",
      }).success,
    ).toBe(false);

    for (const [schema, value] of [
      [
        manufacturingCorpusRightsSchema,
        {
          ...makeValidRights(),
          schemaVersion: "manufacturing-corpus-rights.v2",
        },
      ],
      [
        manufacturingCorpusRootSchema,
        {
          ...makeValidRoot(),
          schemaVersion: "manufacturing-corpus-root.v2",
        },
      ],
      [
        manufacturingCorpusCaseSchema,
        {
          ...makeValidCase(),
          schemaVersion: "manufacturing-corpus-case.v2",
        },
      ],
      [
        manufacturingCorpusTargetSchema,
        {
          ...makeValidTarget(),
          schemaVersion: "manufacturing-corpus-target.v2",
        },
      ],
    ] as const) {
      expect(schema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects unknown fields instead of stripping future shapes", () => {
    expect(
      manufacturingCorpusManifestSchema.safeParse({
        ...makeValidManifest(),
        futureField: true,
      }).success,
    ).toBe(false);

    const rights = makeValidRights();
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        permissions: {
          ...rights.permissions,
          futurePurpose: {
            allowed: true,
          },
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        governance: {
          ...rights.governance,
          futureField: true,
        },
      }).success,
    ).toBe(false);
  });
});

describe("purpose-specific rights", () => {
  it("ships an explicit deny-all example for every purpose", () => {
    expect(Object.keys(DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS)).toEqual([
      ...MANUFACTURING_CORPUS_PERMISSION_PURPOSES,
    ]);
    for (const purpose of MANUFACTURING_CORPUS_PERMISSION_PURPOSES) {
      expect(
        DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS[purpose],
      ).toMatchObject({
        allowed: false,
        artifactClasses: [],
        processorPolicy: {
          executionLocation: "local_only",
          allowedProcessors: [],
          rawOutputRetentionAllowed: false,
        },
      });
    }
  });

  it("deep-freezes the exported defaults and creates independent examples", () => {
    expect(
      Reflect.set(
        DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS.publication,
        "allowed",
        true,
      ),
    ).toBe(false);

    const permissions = createDefaultDenyManufacturingCorpusPermissions();
    permissions.publication.allowed = true;
    expect(permissions.humanAnnotation.allowed).toBe(false);
  });

  it("keeps geometry SDK and local parser permission independent", () => {
    const rights = makeValidRights();
    rights.permissions.geometrySdkEvaluation = makeAllowedGrant(["cad_model"]);

    const parsed = manufacturingCorpusRightsSchema.parse(rights);
    expect(parsed.permissions.geometrySdkEvaluation.allowed).toBe(true);
    expect(parsed.permissions.localParserEvaluation.allowed).toBe(false);
  });

  it("rejects missing permission keys and contradictory grants", () => {
    const permissions = makeDeniedPermissions();
    const { publication: _publication, ...missingPublication } = permissions;
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...makeValidRights(),
        permissions: missingPublication,
      }).success,
    ).toBe(false);

    expect(
      manufacturingCorpusPermissionGrantSchema.safeParse({
        allowed: false,
        artifactClasses: ["cad_model"],
        processorPolicy: {
          executionLocation: "local_only",
          allowedProcessors: [],
          rawOutputRetentionAllowed: false,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusPermissionGrantSchema.safeParse({
        allowed: true,
        artifactClasses: ["cad_model"],
        processorPolicy: {
          executionLocation: "approved_service",
          allowedProcessors: [],
          rawOutputRetentionAllowed: false,
        },
      }).success,
    ).toBe(false);
  });
});

describe("customer-origin and lifecycle contracts", () => {
  function makeCustomerRights() {
    return {
      ...makeValidRights(),
      rightsId: "rights-customer",
      sourceClass: "consented_customer" as const,
      evidence: {
        reference: "consent:opaque-reference",
        sha256: SHA256,
        basisVersion: "customer-consent.v1",
      },
      tenantScope: {
        kind: "single_tenant" as const,
        tenantRef: "tenant:opaque-reference",
        crossTenantUse: false as const,
      },
      redistribution: {
        assets: "internal_only" as const,
        annotations: "internal_only" as const,
        derivedOutputs: "internal_only" as const,
      },
    };
  }

  it("requires hashed evidence and one tenant for customer-origin rights", () => {
    expect(
      manufacturingCorpusRightsSchema.parse(makeCustomerRights()),
    ).toBeDefined();
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...makeCustomerRights(),
        evidence: {
          ...makeCustomerRights().evidence,
          sha256: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...makeCustomerRights(),
        tenantScope: {
          kind: "none",
          crossTenantUse: false,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...makeCustomerRights(),
        tenantScope: {
          kind: "single_tenant",
          tenantRef: "tenant:opaque-reference",
          crossTenantUse: true,
        },
      }).success,
    ).toBe(false);
  });

  it("binds each customer case to exactly one matching rights record", () => {
    const customerRights = makeCustomerRights();
    const customerCase = {
      ...makeValidCase(),
      sourceClass: "consented_customer" as const,
      dataClassification: "confidential" as const,
      rightsId: customerRights.rightsId,
    };
    const manifest = {
      ...makeValidManifest(),
      rights: [customerRights],
      cases: [customerCase],
    };

    expect(manufacturingCorpusManifestSchema.safeParse(manifest).success).toBe(
      true,
    );
    expect(
      manufacturingCorpusManifestSchema.safeParse({
        ...manifest,
        rights: [],
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusManifestSchema.safeParse({
        ...manifest,
        rights: [
          {
            ...customerRights,
            sourceClass: "synthetic",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects contradictory approval, validity, revocation, and deletion data", () => {
    const rights = makeValidRights();
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        validity: {
          effectiveAt: null,
          expiresAt: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        governance: {
          status: "pending",
          policyRef: "governance:ovd-242",
          policyVersion: null,
          approvedByRef: null,
          approvedAt: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        governance: {
          ...rights.governance,
          approvedAt: "2026-07-31T00:00:00Z",
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        approval: {
          status: "pending",
          approvedByRole: null,
          approvedByRef: null,
          approvedAt: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        validity: {
          effectiveAt: "2026-07-30T00:00:00Z",
          expiresAt: "2026-07-29T00:00:00Z",
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        revocation: {
          state: "revoked",
          revokedAt: null,
          reasonCode: null,
          evidenceRef: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        deletion: {
          state: "requested",
          requestRef: "deletion:request",
          requestedAt: "2026-07-30T00:00:00Z",
          sourcePurgedAt: "2026-07-29T00:00:00Z",
          derivedPurgedAt: null,
          backupPurgedAt: null,
          auditTombstoneRef: null,
          purgeVerification: null,
        },
      }).success,
    ).toBe(false);
  });

  it("orders purge verification and blocks purge records during legal holds", () => {
    const rights = makeValidRights();
    const completedDeletion = {
      state: "requested" as const,
      requestRef: "deletion:request",
      requestedAt: "2026-07-30T01:00:00Z",
      sourcePurgedAt: "2026-07-30T02:00:00Z",
      derivedPurgedAt: null,
      backupPurgedAt: null,
      auditTombstoneRef: "audit:tombstone",
      purgeVerification: {
        reference: "purge:verification",
        verifiedByRef: "user:data-governance",
        verifiedAt: "2026-07-30T03:00:00Z",
      },
    };

    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        deletion: {
          ...completedDeletion,
          sourcePurgedAt: null,
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        deletion: {
          ...completedDeletion,
          purgeVerification: {
            ...completedDeletion.purgeVerification,
            verifiedAt: "2026-07-30T01:30:00Z",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRightsSchema.safeParse({
        ...rights,
        deletion: completedDeletion,
        legalHold: {
          state: "active",
          reference: "legal-hold:case-1",
          effectiveAt: "2026-07-30T01:30:00Z",
        },
      }).success,
    ).toBe(false);
  });

  it("keeps an internally consistent expired record representable", () => {
    const expired = {
      ...makeValidRights(),
      validity: {
        effectiveAt: "2025-01-01T00:00:00Z",
        expiresAt: "2026-01-01T00:00:00Z",
      },
      retention: {
        policyRef: "retention:historical",
        sourceExpiresAt: "2026-01-01T00:00:00Z",
        derivedExpiresAt: "2026-02-01T00:00:00Z",
        backupExpiresAt: "2026-03-01T00:00:00Z",
      },
    };

    expect(manufacturingCorpusRightsSchema.parse(expired).validity).toEqual(
      expired.validity,
    );
  });
});

describe("portable paths and record contradictions", () => {
  it.each([
    "",
    ".",
    "..",
    "../secret.step",
    "nested/../../secret.step",
    "/absolute.step",
    "C:\\absolute.step",
    "\\\\server\\share\\part.step",
    "nested\\part.step",
    "nested//part.step",
    "nested/./part.step",
  ])("rejects unsafe file path %s", (value) => {
    expect(portableRelativeFilePathSchema.safeParse(value).success).toBe(false);
  });

  it("accepts portable file paths and only permits dot for a root", () => {
    expect(portableRelativeFilePathSchema.parse("fixtures/part.step")).toBe(
      "fixtures/part.step",
    );
    expect(portableRelativeRootPathSchema.parse(".")).toBe(".");
    expect(portableRelativeRootPathSchema.parse("private/corpus")).toBe(
      "private/corpus",
    );
  });

  it("rejects duplicate process labels, misplaced annotations, and impossible targets", () => {
    expect(
      manufacturingCorpusCaseSchema.safeParse({
        ...makeValidCase(),
        processFamilies: ["cnc_milling", "cnc_milling"],
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusCaseSchema.safeParse({
        ...makeValidCase(),
        annotationArtifact: makeValidArtifact("annotation-case-1", "cad_model"),
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusTargetSchema.safeParse({
        ...makeValidTarget(),
        minimumPackages: 5,
        minimumConsentedRealPackages: 10,
      }).success,
    ).toBe(false);
  });

  it("requires provenance for expected structure, units, and routes", () => {
    const annotation = makeValidAnnotation();
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        expected: {
          ...annotation.expected,
          productStructure: {
            ...annotation.expected.productStructure,
            definitionCount: {
              state: "known",
              value: 1,
              evidence: [],
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...annotation,
        expected: {
          ...annotation.expected,
          candidateRoutes: [
            {
              processFamily: "cnc_milling",
              state: "applicable",
              evidence: [],
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("preserves conflicting-unit states and rejects non-JSON values", () => {
    const annotation = makeValidAnnotation();
    const conflictingUnits = {
      ...annotation,
      expected: {
        ...annotation.expected,
        units: {
          length: {
            state: "conflicting",
            reasonCode: "drawing_model_unit_conflict",
            evidence: annotation.expected.units.length.evidence,
          },
        },
      },
    };
    expect(
      manufacturingCorpusAnnotationSchema.safeParse(conflictingUnits).success,
    ).toBe(true);

    const nonJson = {
      ...annotation,
      expected: {
        ...annotation.expected,
        commonFeatures: [
          {
            ...annotation.expected.commonFeatures[0],
            parameters: {
              invalid: new Date("2026-07-30T00:00:00Z"),
            },
          },
        ],
      },
    };
    expect(manufacturingCorpusAnnotationSchema.safeParse(nonJson).success).toBe(
      false,
    );
  });
});
