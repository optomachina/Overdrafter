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
  type ManufacturingCorpusManifest,
  type ManufacturingCorpusRights,
} from "./manufacturingCorpusContract.js";
import { serializeManufacturingCorpusManifestDiagnostics } from "./manufacturingCorpusFilesystemDiagnostics.js";
import {
  DEFAULT_MANUFACTURING_CORPUS_MANIFEST_BYTE_LIMIT,
  loadManufacturingCorpusManifest,
  serializeManufacturingCorpusManifestLoadResult,
} from "./manufacturingCorpusManifestLoader.js";

const SHA256 = "a".repeat(64);

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

function makeManifest(): ManufacturingCorpusManifest {
  const artifact = {
    artifactId: "artifact-cad",
    artifactClass: "cad_model" as const,
    rootId: "committed",
    relativePath: "fixtures/case-1.step",
    mediaType: "application/step",
    byteSize: 128,
    sha256: SHA256,
  };
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
        minimumPackages: 25,
        minimumConsentedRealPackages: 10,
      },
    ],
    cases: [
      {
        schemaVersion: MANUFACTURING_CORPUS_CASE_SCHEMA_VERSION,
        caseId: "case-1",
        processFamilies: ["cnc_milling"],
        qualificationTarget: "broad_estimate",
        sourceClass: "synthetic",
        dataClassification: "public",
        redaction: { state: "not_required", reviewRef: null },
        protectedSourceRef: "synthetic:ovd-263:case-1",
        rightsId: "rights-synthetic",
        artifacts: [artifact],
        annotationArtifact: {
          ...artifact,
          artifactId: "annotation-case-1",
          artifactClass: "annotation",
          relativePath: "annotations/case-1.json",
          mediaType: "application/json",
        },
        executionLimits: {
          maxSourceBytes: 250_000_000,
          maxPackageBytes: 2_000_000_000,
          maxOutputBytes: 250_000_000,
          maxRecursionDepth: 32,
          timeoutMs: 60_000,
          memoryMb: 1024,
        },
      },
    ],
  };
}

describe("manufacturing corpus manifest loader", () => {
  let directory: string;
  let manifestPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      path.join(await realpath(os.tmpdir()), "corpus-manifest-"),
    );
    manifestPath = path.join(directory, "manifest.json");
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  async function writeManifest(value: unknown = makeManifest()) {
    const serialized = JSON.stringify(value);
    await writeFile(manifestPath, serialized);
    return serialized;
  }

  it("returns a strictly parsed manifest and same-handle digest", async () => {
    const serialized = await writeManifest();
    const result = await loadManufacturingCorpusManifest(manifestPath);

    expect(result.state).toBe("loaded");
    if (result.state !== "loaded") {
      return;
    }
    expect(result.manifest).toEqual(makeManifest());
    expect(result.manifestSha256).toBe(
      createHash("sha256").update(serialized).digest("hex"),
    );
    expect(result.canonicalManifestDirectory).toBe(directory);
    expect(serializeManufacturingCorpusManifestLoadResult(result)).toBe(
      `${JSON.stringify(
        {
          state: "loaded",
          manifestSha256: result.manifestSha256,
          diagnostics: [],
        },
        null,
        2,
      )}\n`,
    );
  });

  it.each([
    ["missing", "manifest_missing"],
    ["directory", "manifest_not_regular_file"],
    ["symlink", "manifest_symlink"],
    ["oversized", "manifest_too_large"],
    ["malformed-json", "manifest_json_invalid"],
    ["malformed-utf8", "manifest_json_invalid"],
    ["invalid-schema", "manifest_schema_invalid"],
  ] as const)("fails closed for a %s manifest", async (scenario, code) => {
    if (scenario === "directory") {
      await mkdir(manifestPath);
    } else if (scenario === "symlink") {
      await writeFile(path.join(directory, "real.json"), "{}");
      await symlink("real.json", manifestPath);
    } else if (scenario === "oversized") {
      await writeFile(
        manifestPath,
        new Uint8Array(
          DEFAULT_MANUFACTURING_CORPUS_MANIFEST_BYTE_LIMIT + 1,
        ),
      );
    } else if (scenario === "malformed-json") {
      await writeFile(manifestPath, "{");
    } else if (scenario === "malformed-utf8") {
      await writeFile(manifestPath, new Uint8Array([0xc3, 0x28]));
    } else if (scenario === "invalid-schema") {
      await writeManifest({});
    }

    const result = await loadManufacturingCorpusManifest(manifestPath);
    expect(result).toEqual({
      state: "failed",
      diagnostics: [{ code, recordKind: "manifest", recordId: null }],
    });
  });

  it("validates and applies an explicit manifest byte limit", async () => {
    const ordinary = await writeManifest();
    const limited = await loadManufacturingCorpusManifest(manifestPath, {
      manifestByteLimit: 1,
    });
    const invalid = await loadManufacturingCorpusManifest(manifestPath, {
      manifestByteLimit: 0,
    });
    const oversizedButValid =
      ordinary +
      " ".repeat(
        DEFAULT_MANUFACTURING_CORPUS_MANIFEST_BYTE_LIMIT -
          ordinary.length +
          1,
      );
    await writeFile(manifestPath, oversizedButValid);
    const defaultResult =
      await loadManufacturingCorpusManifest(manifestPath);
    const raisedResult = await loadManufacturingCorpusManifest(
      manifestPath,
      { manifestByteLimit: oversizedButValid.length },
    );
    expect(limited.state === "failed" && limited.diagnostics[0].code).toBe(
      "manifest_too_large",
    );
    expect(invalid.state === "failed" && invalid.diagnostics[0].code).toBe(
      "manifest_byte_limit_invalid",
    );
    expect(
      defaultResult.state === "failed" &&
        defaultResult.diagnostics[0].code,
    ).toBe("manifest_too_large");
    expect(raisedResult.state).toBe("loaded");
  });

  it("reports every duplicate identity before strict schema rejection", async () => {
    const manifest = structuredClone(makeManifest());
    manifest.roots.push(structuredClone(manifest.roots[0]));
    manifest.rights.push(structuredClone(manifest.rights[0]));
    manifest.targets.push(structuredClone(manifest.targets[0]));
    const duplicateCase = structuredClone(manifest.cases[0]);
    duplicateCase.artifacts.push({
      ...duplicateCase.artifacts[0],
      artifactId: duplicateCase.annotationArtifact.artifactId,
    });
    manifest.cases.push(duplicateCase);
    await writeManifest(manifest);

    const result = await loadManufacturingCorpusManifest(manifestPath);
    expect(result.state).toBe("failed");
    if (result.state !== "failed") {
      return;
    }
    expect(result.diagnostics).toEqual([
      {
        code: "duplicate_artifact_id",
        recordKind: "artifact",
        recordId: "annotation-case-1",
      },
      {
        code: "duplicate_artifact_id",
        recordKind: "artifact",
        recordId: "artifact-cad",
      },
      {
        code: "duplicate_case_id",
        recordKind: "case",
        recordId: "case-1",
      },
      {
        code: "duplicate_rights_id",
        recordKind: "rights",
        recordId: "rights-synthetic",
      },
      {
        code: "duplicate_root_id",
        recordKind: "root",
        recordId: "committed",
      },
      {
        code: "duplicate_target_identity",
        recordKind: "target",
        recordId: "cnc_milling.broad_estimate",
      },
      {
        code: "manifest_schema_invalid",
        recordKind: "manifest",
        recordId: null,
      },
    ]);
  });

  it("uses code-point ordering for stable diagnostics", () => {
    const serialized = serializeManufacturingCorpusManifestDiagnostics(
      ["a_1", "a1", "a.1", "a-1"].map((recordId) => ({
        code: "duplicate_root_id",
        recordKind: "root",
        recordId,
      })),
    );
    expect(JSON.parse(serialized).map(
      (item: { recordId: string }) => item.recordId,
    )).toEqual(["a-1", "a.1", "a1", "a_1"]);
  });

  it("detects same-inode mutation while reading", async () => {
    const serialized = await writeManifest();
    const result = await loadManufacturingCorpusManifest(manifestPath, {
      afterOpenForTest: async () => {
        await writeFile(manifestPath, `${serialized} `);
      },
    });
    expect(result.state).toBe("failed");
    expect(
      result.state === "failed" ? result.diagnostics[0].code : null,
    ).toBe("manifest_changed_during_validation");
  });

  it("detects same-length in-place mutation after opening", async () => {
    const serialized = await writeManifest();
    const replacement = serialized.replace('"0.1.0"', '"0.1.1"');
    expect(replacement).toHaveLength(serialized.length);
    const result = await loadManufacturingCorpusManifest(manifestPath, {
      afterOpenForTest: async () => {
        await writeFile(manifestPath, replacement);
        const future = new Date(Date.now() + 60_000);
        await utimes(manifestPath, future, future);
      },
    });
    expect(result.state === "failed" && result.diagnostics[0].code).toBe(
      "manifest_changed_during_validation",
    );
  });

  it("fails closed when the opened pathname is replaced", async () => {
    await writeManifest();
    const originalPath = path.join(directory, "original.json");
    const result = await loadManufacturingCorpusManifest(manifestPath, {
      afterOpenForTest: async () => {
        await rename(manifestPath, originalPath);
        await writeFile(manifestPath, "{}");
      },
    });
    expect(result.state === "failed" && result.diagnostics[0].code).toBe(
      "manifest_changed_during_validation",
    );
  });

  it("serializes equivalent failures identically without sensitive text", async () => {
    const manifest = makeManifest();
    manifest.cases[0].protectedSourceRef = "source:sentinel-secret";
    await writeManifest({ ...manifest, unexpected: "/private/sentinel-path" });

    const first = await loadManufacturingCorpusManifest(manifestPath);
    const second = await loadManufacturingCorpusManifest(manifestPath);
    const firstSerialized =
      serializeManufacturingCorpusManifestLoadResult(first);
    expect(firstSerialized).toBe(
      serializeManufacturingCorpusManifestLoadResult(second),
    );
    expect(firstSerialized).not.toContain(directory);
    expect(firstSerialized).not.toContain("sentinel");
    expect(firstSerialized).not.toContain("ENOENT");
    expect(firstSerialized).not.toContain("unrecognized");
  });
});
