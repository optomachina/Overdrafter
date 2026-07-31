// @vitest-environment node

import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANUFACTURING_CORPUS_CASE_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_MANIFEST_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_RIGHTS_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
  MANUFACTURING_CORPUS_TARGET_SCHEMA_VERSION,
  createDefaultDenyManufacturingCorpusPermissions,
  type ManufacturingCorpusArtifact,
  type ManufacturingCorpusCase,
  type ManufacturingCorpusManifest,
  type ManufacturingCorpusRights,
} from "./manufacturingCorpusContract.js";
import { verifyManufacturingCorpusArtifactFilesystem } from "./manufacturingCorpusArtifactFilesystem.js";
import {
  prepareManufacturingCorpusFilesystem,
  serializeManufacturingCorpusFilesystemResult,
  validateManufacturingCorpusFilesystem,
} from "./manufacturingCorpusFilesystem.js";

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function makeRights(): ManufacturingCorpusRights {
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
    tenantScope: { kind: "none", crossTenantUse: false },
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
    legalHold: { state: "inactive", reference: null, effectiveAt: null },
  };
}

function artifact(
  artifactId: string,
  relativePath: string,
  content: string,
  artifactClass: "annotation" | "cad_model" = "cad_model",
): ManufacturingCorpusArtifact {
  return {
    artifactId,
    artifactClass,
    rootId: "committed",
    relativePath,
    mediaType:
      artifactClass === "annotation" ? "application/json" : "application/step",
    byteSize: new TextEncoder().encode(content).length,
    sha256: digest(content),
  };
}

function corpusCase(
  caseId: string,
  sourceContent: string,
  annotationContent: string,
): ManufacturingCorpusCase {
  return {
    schemaVersion: MANUFACTURING_CORPUS_CASE_SCHEMA_VERSION,
    caseId,
    processFamilies: ["cnc_milling"],
    qualificationTarget: "broad_estimate",
    sourceClass: "synthetic",
    dataClassification: "public",
    redaction: { state: "not_required", reviewRef: null },
    protectedSourceRef: `synthetic:sentinel:${caseId}`,
    rightsId: "rights-synthetic",
    artifacts: [
      artifact(
        `source-${caseId}`,
        `${caseId}/source.step`,
        sourceContent,
      ),
    ],
    annotationArtifact: artifact(
      `annotation-${caseId}`,
      `${caseId}/annotation.json`,
      annotationContent,
      "annotation",
    ) as ManufacturingCorpusCase["annotationArtifact"],
    executionLimits: {
      maxSourceBytes: 1_000_000,
      maxPackageBytes: 2_000_000,
      maxOutputBytes: 1_000_000,
      maxRecursionDepth: 8,
      timeoutMs: 10_000,
      memoryMb: 256,
    },
  };
}

function manifest(cases: readonly ManufacturingCorpusCase[]) {
  return {
    schemaVersion: MANUFACTURING_CORPUS_MANIFEST_SCHEMA_VERSION,
    manifestClass: "protected_internal",
    corpusVersion: "0.1.0",
    roots: [
      {
        schemaVersion: MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
        rootId: "committed",
        kind: "manifest_relative",
        relativePath: "artifacts",
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
    cases,
  } satisfies ManufacturingCorpusManifest;
}

describe("manufacturing corpus filesystem", () => {
  let directory: string;
  let artifactRoot: string;
  let manifestPath: string;
  const sourceA = "STEP-A";
  const sourceB = "STEP-B";
  const annotationA = '{"case":"a"}';
  const annotationB = '{"case":"b"}';

  beforeEach(async () => {
    directory = await mkdtemp(
      path.join(await realpath(os.tmpdir()), "corpus-filesystem-"),
    );
    artifactRoot = path.join(directory, "artifacts");
    manifestPath = path.join(directory, "manifest.json");
    await mkdir(artifactRoot);
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  async function createCorpus() {
    const cases = [
      corpusCase("case-a", sourceA, annotationA),
      corpusCase("case-b", sourceB, annotationB),
    ];
    for (const [corpusCaseValue, source, annotation] of [
      [cases[0], sourceA, annotationA],
      [cases[1], sourceB, annotationB],
    ] as const) {
      const caseDirectory = path.join(artifactRoot, corpusCaseValue.caseId);
      await mkdir(caseDirectory);
      await writeFile(path.join(caseDirectory, "source.step"), source);
      await writeFile(
        path.join(caseDirectory, "annotation.json"),
        annotation,
      );
    }
    await writeFile(manifestPath, JSON.stringify(manifest(cases)));
  }

  it("rejects duplicate or unknown requested cases before artifact access", async () => {
    await createCorpus();
    const opens: string[] = [];
    const reads: string[] = [];
    const prepared = await prepareManufacturingCorpusFilesystem({
      manifestPath,
      beforeArtifactOpenForTest: (artifactId) => {
        opens.push(artifactId);
      },
      afterArtifactReadForTest: (artifactId) => {
        reads.push(artifactId);
      },
    });
    expect(prepared.state).toBe("prepared");
    if (prepared.state !== "prepared") {
      return;
    }
    await rm(artifactRoot, { recursive: true });

    const result = await prepared.prepared.validateArtifacts([
      "case-a",
      "case-a",
      "unknown-case",
    ]);

    expect(opens).toEqual([]);
    expect(reads).toEqual([]);
    expect(result.caseResults).toEqual([
      {
        caseId: "case-a",
        state: "failed",
        diagnosticCodes: ["duplicate_requested_case_id"],
      },
      {
        caseId: "unknown-case",
        state: "failed",
        diagnosticCodes: ["case_not_found"],
      },
    ]);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "case_not_found",
      "duplicate_requested_case_id",
    ]);
  });

  it("opens only artifacts from the requested valid subset", async () => {
    await createCorpus();
    const opens: string[] = [];
    const prepared = await prepareManufacturingCorpusFilesystem({
      manifestPath,
      beforeArtifactOpenForTest: (artifactId) => {
        opens.push(artifactId);
      },
    });
    expect(prepared.state).toBe("prepared");
    if (prepared.state !== "prepared") {
      return;
    }

    const result = await prepared.prepared.validateArtifacts(["case-b"]);

    expect(opens).toEqual(["source-case-b", "annotation-case-b"]);
    expect(result.caseResults).toEqual([
      { caseId: "case-b", state: "passed", diagnosticCodes: [] },
    ]);
    expect([...result.verifiedAnnotationBytesByCaseId.keys()]).toEqual([
      "case-b",
    ]);
  });

  it("sorts cases and retains annotation bytes only for whole-case passes", async () => {
    await createCorpus();
    const reads: string[] = [];
    const prepared = await prepareManufacturingCorpusFilesystem({
      manifestPath,
      afterArtifactReadForTest: (artifactId, ...rest) => {
        expect(rest).toEqual([]);
        reads.push(artifactId);
      },
    });
    expect(prepared.state).toBe("prepared");
    if (prepared.state !== "prepared") {
      return;
    }
    await writeFile(path.join(artifactRoot, "case-b", "source.step"), "STEP-X");

    const result = await prepared.prepared.validateArtifacts([
      "case-b",
      "case-a",
    ]);

    expect(result.integrityPassed).toBe(false);
    expect(result.caseResults).toEqual([
      { caseId: "case-a", state: "passed", diagnosticCodes: [] },
      {
        caseId: "case-b",
        state: "failed",
        diagnosticCodes: ["artifact_sha256_mismatch"],
      },
    ]);
    expect(reads).toEqual([
      "source-case-a",
      "annotation-case-a",
      "source-case-b",
      "annotation-case-b",
    ]);
    expect(
      new TextDecoder().decode(
        result.verifiedAnnotationBytesByCaseId.get("case-a"),
      ),
    ).toBe(annotationA);
    expect(result.verifiedAnnotationBytesByCaseId.has("case-b")).toBe(false);
    const serialized = serializeManufacturingCorpusFilesystemResult(result);
    expect(serialized).not.toContain(annotationA);
    expect(serialized).not.toContain(directory);
    expect(serialized).not.toContain("sentinel");
  });

  it("validates every case through the all-case convenience", async () => {
    await createCorpus();
    const result = await validateManufacturingCorpusFilesystem({
      manifestPath,
    });
    expect(result.state).toBe("validated");
    if (result.state !== "validated") {
      return;
    }
    expect(result.integrityPassed).toBe(true);
    expect(result.caseResults.map((item) => item.caseId)).toEqual([
      "case-a",
      "case-b",
    ]);
    expect([...result.verifiedAnnotationBytesByCaseId.keys()]).toEqual([
      "case-a",
      "case-b",
    ]);
  });

  it("bounds verified annotation capture with the case output limit", async () => {
    await createCorpus();
    const cases = [
      corpusCase("case-a", sourceA, annotationA),
      corpusCase("case-b", sourceB, annotationB),
    ];
    cases[0].executionLimits.maxOutputBytes = 1;
    await writeFile(manifestPath, JSON.stringify(manifest(cases)));
    const reads: string[] = [];
    const prepared = await prepareManufacturingCorpusFilesystem({
      manifestPath,
      afterArtifactReadForTest: (artifactId) => {
        reads.push(artifactId);
      },
    });
    expect(prepared.state).toBe("prepared");
    if (prepared.state !== "prepared") {
      return;
    }

    const result = await prepared.prepared.validateArtifacts(["case-a"]);

    expect(result.caseResults).toEqual([
      {
        caseId: "case-a",
        state: "failed",
        diagnosticCodes: ["artifact_capture_limit_exceeded"],
      },
    ]);
    expect(reads).toEqual(["source-case-a"]);
    expect(result.verifiedAnnotationBytesByCaseId.size).toBe(0);
  });

  it("composes manifest and root preparation failures without paths", async () => {
    await writeFile(manifestPath, "{");
    const manifestFailure = await prepareManufacturingCorpusFilesystem({
      manifestPath,
    });
    expect(manifestFailure.state).toBe("failed");
    await writeFile(
      manifestPath,
      JSON.stringify(manifest([corpusCase("case-a", sourceA, annotationA)])),
    );
    await rm(artifactRoot, { recursive: true });
    const rootFailure = await prepareManufacturingCorpusFilesystem({
      manifestPath,
    });
    expect(rootFailure.state).toBe("failed");
    if (rootFailure.state !== "failed") {
      return;
    }
    const serialized =
      serializeManufacturingCorpusFilesystemResult(rootFailure);
    expect(serialized).not.toContain(directory);
    expect(serialized).not.toContain("artifacts");
  });

  describe("artifact verification", () => {
    function directArtifact(relativePath: string, content = "artifact") {
      return artifact("artifact-direct", relativePath, content);
    }

    it.each([
      ["missing-root", "artifact_root_missing"],
      ["escape", "artifact_path_escape"],
      ["missing", "artifact_path_missing"],
      ["directory", "artifact_not_regular_file"],
      ["intermediate-symlink", "artifact_symlink"],
      ["final-symlink", "artifact_symlink"],
    ] as const)("rejects %s", async (scenario, code) => {
      const roots =
        scenario === "missing-root"
          ? new Map<string, string>()
          : new Map([["committed", artifactRoot]]);
      let relativePath = "missing.step";
      if (scenario === "escape") {
        relativePath = "../outside.step";
      } else if (scenario === "directory") {
        relativePath = "directory";
        await mkdir(path.join(artifactRoot, relativePath));
      } else if (scenario === "intermediate-symlink") {
        const target = path.join(artifactRoot, "target");
        await mkdir(target);
        await writeFile(path.join(target, "file.step"), "artifact");
        await symlink(target, path.join(artifactRoot, "link"));
        relativePath = "link/file.step";
      } else if (scenario === "final-symlink") {
        await writeFile(path.join(artifactRoot, "target.step"), "artifact");
        await symlink(
          path.join(artifactRoot, "target.step"),
          path.join(artifactRoot, "link.step"),
        );
        relativePath = "link.step";
      }
      const result = await verifyManufacturingCorpusArtifactFilesystem(
        directArtifact(relativePath),
        roots,
      );
      expect(result.diagnostics).toEqual([
        { code, recordKind: "artifact", recordId: "artifact-direct" },
      ]);
    });

    it("rejects a size mismatch before reading artifact bytes", async () => {
      const filePath = path.join(artifactRoot, "file.step");
      await writeFile(filePath, "actual");
      let readHookCalled = false;
      const declared = {
        ...directArtifact("file.step", "expected"),
        byteSize: 99,
      };
      const result = await verifyManufacturingCorpusArtifactFilesystem(
        declared,
        new Map([["committed", artifactRoot]]),
        {
          afterReadForTest: () => {
            readHookCalled = true;
          },
        },
      );
      expect(result.diagnostics.map((item) => item.code)).toEqual([
        "artifact_size_mismatch",
      ]);
      expect(readHookCalled).toBe(false);
    });

    it("maps same-inode post-read mutation to changed", async () => {
      const content = "original";
      const filePath = path.join(artifactRoot, "file.step");
      await writeFile(filePath, content);
      const result = await verifyManufacturingCorpusArtifactFilesystem(
        directArtifact("file.step", content),
        new Map([["committed", artifactRoot]]),
        {
          afterReadForTest: async () => {
            await writeFile(filePath, "mutation");
            const future = new Date(Date.now() + 60_000);
            await utimes(filePath, future, future);
          },
        },
      );
      expect(result.diagnostics[0].code).toBe(
        "artifact_changed_during_validation",
      );
    });

    it("maps post-read pathname replacement to changed", async () => {
      const content = "original";
      const filePath = path.join(artifactRoot, "file.step");
      await writeFile(filePath, content);
      const result = await verifyManufacturingCorpusArtifactFilesystem(
        directArtifact("file.step", content),
        new Map([["committed", artifactRoot]]),
        {
          afterReadForTest: async () => {
            await rename(filePath, path.join(artifactRoot, "old.step"));
            await writeFile(filePath, content);
          },
        },
      );
      expect(result.diagnostics[0].code).toBe(
        "artifact_changed_during_validation",
      );
    });
  });
});
