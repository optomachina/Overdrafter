// @vitest-environment node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildBlindedRunPlan,
  isCorpusContractError,
  MANUFACTURING_ANNOTATION_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_SCHEMA_VERSION,
  serializeManufacturingBenchmark,
  validateManufacturingCorpus,
} from "./manufacturingCorpus.js";

const checkedInManifestPath = fileURLToPath(
  new URL(
    "../../../benchmarks/manufacturing-characterization/manifest.v1.json",
    import.meta.url,
  ),
);

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function buildApprovedRights() {
  return {
    id: "approved-synthetic",
    sourceClass: "synthetic",
    reviewStatus: "approved",
    rightsBasis: "Project-authored synthetic fixture",
    evidenceRef: "repo:test/project-authored",
    evidenceSha256: null,
    effectiveAt: "2026-07-30T00:00:00Z",
    expiresAt: null,
    approvedByRole: "data_governance",
    approvedAt: "2026-07-30T00:00:00Z",
    permissions: {
      humanAnnotation: true,
      localParserEvaluation: true,
      geometrySdkEvaluation: true,
      modelValidation: true,
      modelTraining: true,
      commercialProductImprovement: true,
      internalDemonstration: true,
      publication: true,
    },
    processorPolicy: {
      mode: "local_only",
      allowedProcessors: [],
      rawOutputRetentionAllowed: false,
    },
    tenantScopeRefs: [],
    crossTenantUse: false,
    redistribution: {
      assets: "full_assets",
      annotations: "full_assets",
    },
    lifecycle: {
      sourceExpiresAt: null,
      derivedExpiresAt: null,
      revokedAt: null,
      deletionRequestRef: null,
      purgeVerifiedAt: null,
      legalHold: false,
    },
  };
}

async function writeApprovedCorpus(
  mutateManifest?: (manifest: Record<string, unknown>) => void,
) {
  const corpusDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "overdrafter-manufacturing-corpus-"),
  );
  const fixtureDirectory = path.join(corpusDirectory, "fixtures");
  const annotationDirectory = path.join(corpusDirectory, "annotations");
  await fs.mkdir(fixtureDirectory, { recursive: true });
  await fs.mkdir(annotationDirectory, { recursive: true });

  const artifactText = "ISO-10303-21;\nEND-ISO-10303-21;\n";
  const annotation = {
    schemaVersion: MANUFACTURING_ANNOTATION_SCHEMA_VERSION,
    annotationVersion: "1.0.0",
    caseId: "approved-case",
    review: {
      state: "approved",
      reviewerRole: "manufacturing_reviewer",
      reviewedAt: "2026-07-30T00:00:00Z",
    },
    expected: {
      productStructure: {
        definitionCount: 1,
        occurrenceCount: 1,
      },
      units: {
        length: "millimeter",
      },
      commonFeatures: [],
      requirements: [],
      candidateRoutes: [],
      unsupportedStates: [],
    },
  };
  const annotationText = `${JSON.stringify(annotation, null, 2)}\n`;
  await fs.writeFile(path.join(fixtureDirectory, "approved.step"), artifactText);
  await fs.writeFile(
    path.join(annotationDirectory, "approved-case.json"),
    annotationText,
  );

  const manifest: Record<string, unknown> = {
    schemaVersion: MANUFACTURING_CORPUS_SCHEMA_VERSION,
    corpusVersion: "test.1",
    roots: [
      {
        id: "committed",
        kind: "manifest_relative",
        path: ".",
        access: "redistributable",
      },
    ],
    targets: [
      {
        processFamily: "other",
        supportTarget: "characterization_only",
        minimumPackages: 1,
        minimumConsentedRealPackages: 0,
      },
    ],
    rights: [buildApprovedRights()],
    cases: [
      {
        id: "approved-case",
        processFamilies: ["other"],
        supportTarget: "characterization_only",
        sourceClass: "synthetic",
        dataClassification: "public",
        opaqueSourceRef: "synthetic:test:approved",
        redactionStatus: "not_required",
        rightsId: "approved-synthetic",
        artifacts: [
          {
            role: "cad_model",
            rootId: "committed",
            path: "fixtures/approved.step",
            mediaType: "application/step",
            byteSize: Buffer.byteLength(artifactText),
            sha256: sha256(artifactText),
          },
        ],
        annotation: {
          rootId: "committed",
          path: "annotations/approved-case.json",
          byteSize: Buffer.byteLength(annotationText),
          sha256: sha256(annotationText),
        },
        executionLimits: {
          maxSourceBytes: 1024,
          maxPackageBytes: 2048,
          timeoutMs: 1000,
          memoryMb: 64,
        },
        expectedExecution: {
          outcome: "success",
          diagnosticCodes: [],
        },
        tags: ["synthetic"],
      },
    ],
  };

  mutateManifest?.(manifest);
  const manifestPath = path.join(corpusDirectory, "manifest.v1.json");
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  return {
    corpusDirectory,
    manifestPath,
  };
}

describe("validateManufacturingCorpus", () => {
  it("validates the checked-in corpus and reports every promotion gap", async () => {
    const first = await validateManufacturingCorpus({
      manifestPath: checkedInManifestPath,
      now: new Date("2026-07-30T12:00:00Z"),
    });
    const second = await validateManufacturingCorpus({
      manifestPath: checkedInManifestPath,
      now: new Date("2026-07-30T12:00:00Z"),
    });

    expect(first.integrityPassed).toBe(true);
    expect(first.caseResults).toHaveLength(2);
    expect(first.caseResults.every((result) => !result.eligibleForCoverage)).toBe(
      true,
    );
    expect(first.coverage).toHaveLength(10);
    expect(first.coverage.every((cohort) => cohort.promotionBlocked)).toBe(true);
    expect(serializeManufacturingBenchmark(second)).toBe(
      serializeManufacturingBenchmark(first),
    );
  });

  it("builds a deterministic blinded plan without ground truth or rights", async () => {
    const { corpusDirectory, manifestPath } = await writeApprovedCorpus();
    try {
      const report = await validateManufacturingCorpus({ manifestPath });
      const first = await buildBlindedRunPlan({ manifestPath });
      const second = await buildBlindedRunPlan({ manifestPath });
      const externalProcessorPlan = await buildBlindedRunPlan({
        manifestPath,
        processor: "external-sdk",
      });
      const serialized = serializeManufacturingBenchmark(first);

      expect(report.integrityPassed).toBe(true);
      expect(report.coverage[0]).toMatchObject({
        eligiblePackages: 1,
        promotionBlocked: false,
      });
      expect(first.cases).toHaveLength(1);
      expect(first.excludedCases).toEqual([]);
      expect(serialized).toBe(serializeManufacturingBenchmark(second));
      expect(serialized).not.toContain("annotation");
      expect(serialized).not.toContain("rights");
      expect(serialized).not.toContain("processFamily");
      expect(serialized).not.toContain("expectedExecution");
      expect(externalProcessorPlan.cases).toEqual([]);
      expect(externalProcessorPlan.excludedCases).toEqual([
        {
          caseId: "approved-case",
          reasonCodes: ["processor_not_permitted"],
        },
      ]);
    } finally {
      await fs.rm(corpusDirectory, { recursive: true, force: true });
    }
  });

  it("fails integrity when an artifact hash changes", async () => {
    const { corpusDirectory, manifestPath } = await writeApprovedCorpus(
      (manifest) => {
        const cases = manifest.cases as Array<Record<string, unknown>>;
        const artifacts = cases[0]?.artifacts as Array<Record<string, unknown>>;
        if (artifacts[0]) {
          artifacts[0].sha256 = "0".repeat(64);
        }
      },
    );
    try {
      const report = await validateManufacturingCorpus({ manifestPath });

      expect(report.integrityPassed).toBe(false);
      expect(report.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "artifact_integrity_failed",
            caseId: "approved-case",
          }),
        ]),
      );
    } finally {
      await fs.rm(corpusDirectory, { recursive: true, force: true });
    }
  });

  it("rejects path traversal before reading corpus assets", async () => {
    const { corpusDirectory, manifestPath } = await writeApprovedCorpus(
      (manifest) => {
        const cases = manifest.cases as Array<Record<string, unknown>>;
        const artifacts = cases[0]?.artifacts as Array<Record<string, unknown>>;
        if (artifacts[0]) {
          artifacts[0].path = "../outside.step";
        }
      },
    );
    try {
      await expect(
        validateManufacturingCorpus({ manifestPath }),
      ).rejects.toSatisfy((error: unknown) => {
        if (!isCorpusContractError(error)) {
          return false;
        }
        return error.diagnostics.some(
          (diagnostic) => diagnostic.code === "manifest_schema_invalid",
        );
      });
    } finally {
      await fs.rm(corpusDirectory, { recursive: true, force: true });
    }
  });

  it("fails closed when a case has no rights record", async () => {
    const { corpusDirectory, manifestPath } = await writeApprovedCorpus(
      (manifest) => {
        manifest.rights = [];
      },
    );
    try {
      const report = await validateManufacturingCorpus({ manifestPath });

      expect(report.integrityPassed).toBe(false);
      expect(report.caseResults[0]).toMatchObject({
        eligibleForCoverage: false,
        rightsReview: "unavailable",
      });
      expect(report.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "rights_record_missing",
          }),
        ]),
      );
    } finally {
      await fs.rm(corpusDirectory, { recursive: true, force: true });
    }
  });

  it("rejects duplicate case identifiers deterministically", async () => {
    const { corpusDirectory, manifestPath } = await writeApprovedCorpus(
      (manifest) => {
        const cases = manifest.cases as Array<Record<string, unknown>>;
        cases.push(structuredClone(cases[0]));
      },
    );
    try {
      const report = await validateManufacturingCorpus({ manifestPath });

      expect(report.integrityPassed).toBe(false);
      expect(report.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "duplicate_id",
            detail: "cases contains duplicate id approved-case",
          }),
        ]),
      );
    } finally {
      await fs.rm(corpusDirectory, { recursive: true, force: true });
    }
  });
});
