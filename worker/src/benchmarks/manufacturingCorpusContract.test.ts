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
  MANUFACTURING_PROCESS_FAMILIES,
  MANUFACTURING_QUALIFICATION_TARGETS,
  createDefaultDenyManufacturingCorpusPermissions,
  manufacturingCorpusAnnotationSchema,
  manufacturingCorpusArtifactClassSchema,
  manufacturingCorpusArtifactSchema,
  manufacturingCorpusCaseSchema,
  manufacturingCorpusDataClassificationSchema,
  manufacturingCorpusManifestSchema,
  manufacturingCorpusPermissionGrantSchema,
  manufacturingCorpusPermissionPurposeSchema,
  manufacturingCorpusPurposePermissionsSchema,
  manufacturingCorpusRedistributionLevelSchema,
  manufacturingCorpusRightsSchema,
  manufacturingCorpusRootSchema,
  manufacturingCorpusSourceClassSchema,
  manufacturingCorpusTargetSchema,
  manufacturingProcessFamilySchema,
  manufacturingQualificationTargetSchema,
  portableRelativeFilePathSchema,
  portableRelativeRootPathSchema,
  type ManufacturingCorpusAnnotation,
  type ManufacturingCorpusArtifact,
  type ManufacturingCorpusCase,
  type ManufacturingCorpusManifest,
  type ManufacturingCorpusPermissionGrant,
  type ManufacturingCorpusPurposePermissions,
  type ManufacturingCorpusRights,
  type ManufacturingCorpusRoot,
  type ManufacturingCorpusTarget,
  type ManufacturingProcessFamily,
  type ManufacturingQualificationTarget,
} from "./manufacturingCorpusContract.js";
import {
  manufacturingCorpusAnnotationSchema as directAnnotationSchema,
} from "./manufacturingCorpusAnnotationContract.js";
import {
  manufacturingCorpusRightsSchema as directRightsSchema,
} from "./manufacturingCorpusRightsContract.js";
import {
  manufacturingCorpusArtifactSchema as directArtifactSchema,
  manufacturingCorpusCaseSchema as directCaseSchema,
  manufacturingCorpusManifestSchema as directManifestSchema,
  manufacturingCorpusRootSchema as directRootSchema,
  manufacturingCorpusTargetSchema as directTargetSchema,
  portableRelativeFilePathSchema as directFilePathSchema,
  portableRelativeRootPathSchema as directRootPathSchema,
} from "./manufacturingCorpusTopology.js";
import {
  DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS as DIRECT_DEFAULT_DENY,
  MANUFACTURING_CORPUS_PERMISSION_PURPOSES as DIRECT_PERMISSION_PURPOSES,
  MANUFACTURING_PROCESS_FAMILIES as DIRECT_PROCESS_FAMILIES,
  MANUFACTURING_QUALIFICATION_TARGETS as DIRECT_QUALIFICATION_TARGETS,
  createDefaultDenyManufacturingCorpusPermissions as directCreateDefaultDeny,
  manufacturingCorpusArtifactClassSchema as directArtifactClassSchema,
  manufacturingCorpusDataClassificationSchema as directDataClassificationSchema,
  manufacturingCorpusPermissionGrantSchema as directPermissionGrantSchema,
  manufacturingCorpusPermissionPurposeSchema as directPermissionPurposeSchema,
  manufacturingCorpusPurposePermissionsSchema as directPurposePermissionsSchema,
  manufacturingCorpusRedistributionLevelSchema as directRedistributionLevelSchema,
  manufacturingCorpusSourceClassSchema as directSourceClassSchema,
  manufacturingProcessFamilySchema as directProcessFamilySchema,
  manufacturingQualificationTargetSchema as directQualificationTargetSchema,
} from "./manufacturingCorpusVocabulary.js";

const SHA256 = "a".repeat(64);

function makeIntegratedExample() {
  const rights: ManufacturingCorpusRights = {
    schemaVersion: MANUFACTURING_CORPUS_RIGHTS_SCHEMA_VERSION,
    rightsId: "rights-synthetic",
    sourceClass: "synthetic",
    rightsBasisCode: "project_authored_synthetic",
    governance: {
      status: "approved",
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
      status: "approved",
      approvedByRole: "data_governance",
      approvedByRef: "user:data-governance",
      approvedAt: "2026-07-30T00:00:00Z",
    },
    validity: {
      effectiveAt: "2026-07-30T00:00:00Z",
      expiresAt: null,
    },
    tenantScope: {
      kind: "none",
      crossTenantUse: false,
    },
    permissions: createDefaultDenyManufacturingCorpusPermissions(),
    redistribution: {
      assets: "full_assets",
      annotations: "full_assets",
      derivedOutputs: "full_assets",
    },
    retention: {
      policyRef: "retention:ovd-242:pending",
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
  const root: ManufacturingCorpusRoot = {
    schemaVersion: MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
    rootId: "committed",
    kind: "manifest_relative",
    relativePath: ".",
    accessClass: "redistributable",
    allowedDataClassifications: ["public"],
  };
  const artifact: ManufacturingCorpusArtifact = {
    artifactId: "artifact-cad",
    artifactClass: "cad_model",
    rootId: root.rootId,
    relativePath: "fixtures/case-1.step",
    mediaType: "application/step",
    byteSize: 128,
    sha256: SHA256,
  };
  const annotationArtifact: ManufacturingCorpusArtifact = {
    ...artifact,
    artifactId: "annotation-case-1",
    artifactClass: "annotation",
    relativePath: "annotations/case-1.json",
    mediaType: "application/json",
  };
  const target: ManufacturingCorpusTarget = {
    schemaVersion: MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION,
    processFamily: "cnc_milling",
    qualificationTarget: "broad_estimate",
    minimumPackages: 25,
    minimumConsentedRealPackages: 10,
  };
  const corpusCase: ManufacturingCorpusCase = {
    schemaVersion: MANUFACTURING_CORPUS_CASE_SCHEMA_VERSION,
    caseId: "case-1",
    processFamilies: ["cnc_milling"],
    qualificationTarget: "broad_estimate",
    sourceClass: rights.sourceClass,
    dataClassification: "public",
    redaction: {
      state: "not_required",
      reviewRef: null,
    },
    protectedSourceRef: "synthetic:ovd-263:case-1",
    rightsId: rights.rightsId,
    artifacts: [artifact],
    annotationArtifact,
    executionLimits: {
      maxSourceBytes: 250_000_000,
      maxPackageBytes: 2_000_000_000,
      maxOutputBytes: 250_000_000,
      maxRecursionDepth: 32,
      timeoutMs: 60_000,
      memoryMb: 1024,
    },
  };
  const manifest: ManufacturingCorpusManifest = {
    schemaVersion: MANUFACTURING_CORPUS_MANIFEST_SCHEMA_VERSION,
    manifestClass: "protected_internal",
    corpusVersion: "0.1.0",
    roots: [root],
    rights: [rights],
    targets: [target],
    cases: [corpusCase],
  };
  const evidence = [{ artifactId: artifact.artifactId, locator: "face-012" }];
  const annotation: ManufacturingCorpusAnnotation = {
    schemaVersion: MANUFACTURING_CORPUS_ANNOTATION_SCHEMA_VERSION,
    annotationRevision: "1.0.0",
    caseId: corpusCase.caseId,
    review: {
      state: "approved",
      reviewerRole: "manufacturing_reviewer",
      reviewerRef: "user:manufacturing-reviewer",
      reviewedAt: "2026-07-30T00:00:00Z",
      reviewRef: "review:case-1:v1",
      reviewPolicyVersion: "manufacturing-review.v1",
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
      commonFeatures: [
        {
          label: "through_hole",
          count: 2,
          parameters: { nominalDiameterMm: 6.35 },
          evidence,
        },
      ],
      requirements: [
        {
          key: "surface_finish",
          value: { maximumRa: 1.6 },
          unit: "um",
          governing: true,
          evidence,
        },
      ],
      candidateRoutes: [
        {
          processFamily: target.processFamily,
          state: "applicable",
          evidence,
        },
      ],
      unsupportedStates: [],
      execution: {
        outcome: "success",
        diagnosticCodes: [],
      },
    },
  };

  return { annotation, artifact, corpusCase, manifest, rights, root, target };
}

describe("manufacturing corpus compatibility facade", () => {
  it("re-exports the exact reviewed values and schema bindings", () => {
    for (const [facade, direct] of [
      [MANUFACTURING_PROCESS_FAMILIES, DIRECT_PROCESS_FAMILIES],
      [MANUFACTURING_QUALIFICATION_TARGETS, DIRECT_QUALIFICATION_TARGETS],
      [MANUFACTURING_CORPUS_PERMISSION_PURPOSES, DIRECT_PERMISSION_PURPOSES],
      [
        DEFAULT_DENY_MANUFACTURING_CORPUS_PERMISSIONS,
        DIRECT_DEFAULT_DENY,
      ],
      [
        createDefaultDenyManufacturingCorpusPermissions,
        directCreateDefaultDeny,
      ],
      [manufacturingProcessFamilySchema, directProcessFamilySchema],
      [
        manufacturingQualificationTargetSchema,
        directQualificationTargetSchema,
      ],
      [manufacturingCorpusSourceClassSchema, directSourceClassSchema],
      [manufacturingCorpusArtifactClassSchema, directArtifactClassSchema],
      [
        manufacturingCorpusDataClassificationSchema,
        directDataClassificationSchema,
      ],
      [
        manufacturingCorpusRedistributionLevelSchema,
        directRedistributionLevelSchema,
      ],
      [
        manufacturingCorpusPermissionPurposeSchema,
        directPermissionPurposeSchema,
      ],
      [manufacturingCorpusPermissionGrantSchema, directPermissionGrantSchema],
      [
        manufacturingCorpusPurposePermissionsSchema,
        directPurposePermissionsSchema,
      ],
      [manufacturingCorpusRightsSchema, directRightsSchema],
      [portableRelativeFilePathSchema, directFilePathSchema],
      [portableRelativeRootPathSchema, directRootPathSchema],
      [manufacturingCorpusRootSchema, directRootSchema],
      [manufacturingCorpusArtifactSchema, directArtifactSchema],
      [manufacturingCorpusTargetSchema, directTargetSchema],
      [manufacturingCorpusCaseSchema, directCaseSchema],
      [manufacturingCorpusManifestSchema, directManifestSchema],
      [manufacturingCorpusAnnotationSchema, directAnnotationSchema],
    ]) {
      expect(facade).toBe(direct);
    }
  });

  it("keeps every intended inferred type available from the facade", () => {
    const process: ManufacturingProcessFamily = "cnc_milling";
    const qualification: ManufacturingQualificationTarget = "broad_estimate";
    const grant: ManufacturingCorpusPermissionGrant =
      createDefaultDenyManufacturingCorpusPermissions().modelValidation;
    const permissions: ManufacturingCorpusPurposePermissions =
      createDefaultDenyManufacturingCorpusPermissions();

    expect([process, qualification, grant.allowed, permissions.publication.allowed])
      .toEqual(["cnc_milling", "broad_estimate", false, false]);
  });

  it("parses a complete cross-module example through the facade", () => {
    const example = makeIntegratedExample();
    expect(manufacturingCorpusRightsSchema.parse(example.rights)).toEqual(
      example.rights,
    );
    expect(manufacturingCorpusRootSchema.parse(example.root)).toEqual(
      example.root,
    );
    expect(manufacturingCorpusArtifactSchema.parse(example.artifact)).toEqual(
      example.artifact,
    );
    expect(manufacturingCorpusTargetSchema.parse(example.target)).toEqual(
      example.target,
    );
    expect(manufacturingCorpusCaseSchema.parse(example.corpusCase)).toEqual(
      example.corpusCase,
    );
    expect(manufacturingCorpusManifestSchema.parse(example.manifest)).toEqual(
      example.manifest,
    );
    expect(
      manufacturingCorpusAnnotationSchema.parse(example.annotation),
    ).toEqual(example.annotation);
  });

  it("preserves representative fail-closed behavior", () => {
    const example = makeIntegratedExample();
    expect(
      manufacturingCorpusManifestSchema.safeParse({
        ...example.manifest,
        schemaVersion: "manufacturing-corpus-manifest.v2",
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...example.annotation,
        schemaVersion: "manufacturing-corpus-annotation.v2",
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusManifestSchema.safeParse({
        ...example.manifest,
        futureField: true,
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusAnnotationSchema.safeParse({
        ...example.annotation,
        review: {
          ...example.annotation.review,
          futureField: true,
        },
      }).success,
    ).toBe(false);
  });
});
