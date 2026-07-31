// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  MANUFACTURING_CORPUS_RIGHTS_SCHEMA_VERSION,
  type ManufacturingCorpusRights,
} from "./manufacturingCorpusRightsContract.js";
import {
  MANUFACTURING_CORPUS_CASE_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_MANIFEST_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION,
  manufacturingCorpusArtifactSchema,
  manufacturingCorpusCaseSchema,
  manufacturingCorpusManifestSchema,
  manufacturingCorpusRootSchema,
  manufacturingCorpusTargetSchema,
  portableRelativeFilePathSchema,
  portableRelativeRootPathSchema,
} from "./manufacturingCorpusTopology.js";
import { createDefaultDenyManufacturingCorpusPermissions } from "./manufacturingCorpusVocabulary.js";

const SHA256 = "a".repeat(64);

function makeValidRights(): ManufacturingCorpusRights {
  return {
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

function makeValidTarget() {
  return {
    schemaVersion: MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION,
    processFamily: "cnc_milling" as const,
    qualificationTarget: "broad_estimate" as const,
    minimumPackages: 25,
    minimumConsentedRealPackages: 10,
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

describe("manufacturing corpus topology", () => {
  it("parses complete topology records", () => {
    expect(
      manufacturingCorpusArtifactSchema.parse(makeValidArtifact()),
    ).toEqual(makeValidArtifact());
    expect(manufacturingCorpusRootSchema.parse(makeValidRoot())).toEqual(
      makeValidRoot(),
    );
    expect(manufacturingCorpusTargetSchema.parse(makeValidTarget())).toEqual(
      makeValidTarget(),
    );
    expect(manufacturingCorpusCaseSchema.parse(makeValidCase())).toEqual(
      makeValidCase(),
    );
    expect(
      manufacturingCorpusManifestSchema.parse(makeValidManifest()),
    ).toEqual(makeValidManifest());
  });

  it.each([
    [
      manufacturingCorpusManifestSchema,
      makeValidManifest(),
      "manufacturing-corpus-manifest.v2",
    ],
    [
      manufacturingCorpusRootSchema,
      makeValidRoot(),
      "manufacturing-corpus-root.v2",
    ],
    [
      manufacturingCorpusCaseSchema,
      makeValidCase(),
      "manufacturing-corpus-case.v2",
    ],
    [
      manufacturingCorpusTargetSchema,
      makeValidTarget(),
      "manufacturing-corpus-target.v2",
    ],
  ] as const)("rejects an unknown schema version", (schema, value, version) => {
    expect(
      schema.safeParse({
        ...value,
        schemaVersion: version,
      }).success,
    ).toBe(false);
  });

  it("rejects future fields at every versioned boundary", () => {
    for (const [schema, value] of [
      [manufacturingCorpusManifestSchema, makeValidManifest()],
      [manufacturingCorpusRootSchema, makeValidRoot()],
      [manufacturingCorpusCaseSchema, makeValidCase()],
      [manufacturingCorpusTargetSchema, makeValidTarget()],
    ] as const) {
      expect(schema.safeParse({ ...value, futureField: true }).success).toBe(
        false,
      );
    }
  });

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

  it("keeps manifest-relative roots public and external roots internal", () => {
    expect(
      manufacturingCorpusRootSchema.safeParse({
        ...makeValidRoot(),
        accessClass: "internal_only",
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusRootSchema.safeParse({
        schemaVersion: MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
        rootId: "private",
        kind: "external_mount",
        accessClass: "internal_only",
        allowedDataClassifications: ["confidential", "controlled"],
      }).success,
    ).toBe(true);
    expect(
      manufacturingCorpusRootSchema.safeParse({
        schemaVersion: MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
        rootId: "private",
        kind: "external_mount",
        accessClass: "internal_only",
        allowedDataClassifications: ["confidential", "confidential"],
      }).success,
    ).toBe(false);
  });

  it("requires complete artifact identity", () => {
    const artifact = makeValidArtifact();
    const { sha256: _sha256, ...missingHash } = artifact;
    expect(
      manufacturingCorpusArtifactSchema.safeParse(missingHash).success,
    ).toBe(false);
    expect(
      manufacturingCorpusArtifactSchema.safeParse({
        ...artifact,
        mediaType: "not-a-media-type",
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusArtifactSchema.safeParse({
        ...artifact,
        byteSize: -1,
      }).success,
    ).toBe(false);
  });

  it("rejects contradictory targets, cases, and execution limits", () => {
    expect(
      manufacturingCorpusTargetSchema.safeParse({
        ...makeValidTarget(),
        minimumPackages: 5,
        minimumConsentedRealPackages: 10,
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusCaseSchema.safeParse({
        ...makeValidCase(),
        processFamilies: ["cnc_milling", "cnc_milling"],
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusCaseSchema.safeParse({
        ...makeValidCase(),
        executionLimits: {
          ...makeValidCase().executionLimits,
          maxSourceBytes: 3_000,
          maxPackageBytes: 2_000,
        },
      }).success,
    ).toBe(false);
  });

  it("keeps the protected annotation outside source artifacts", () => {
    expect(
      manufacturingCorpusCaseSchema.safeParse({
        ...makeValidCase(),
        annotationArtifact: makeValidArtifact(
          "annotation-case-1",
          "cad_model",
        ),
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusCaseSchema.safeParse({
        ...makeValidCase(),
        artifacts: [makeValidArtifact("source-annotation", "annotation")],
      }).success,
    ).toBe(false);
  });

  it("requires exactly one matching rights record per manifest case", () => {
    const manifest = makeValidManifest();
    expect(
      manufacturingCorpusManifestSchema.safeParse({
        ...manifest,
        rights: [],
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusManifestSchema.safeParse({
        ...manifest,
        rights: [makeValidRights(), makeValidRights()],
      }).success,
    ).toBe(false);
    expect(
      manufacturingCorpusManifestSchema.safeParse({
        ...manifest,
        cases: [
          {
            ...makeValidCase(),
            sourceClass: "company_owned",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires a protected internal manifest", () => {
    expect(
      manufacturingCorpusManifestSchema.safeParse({
        ...makeValidManifest(),
        manifestClass: "public",
      }).success,
    ).toBe(false);
  });
});
