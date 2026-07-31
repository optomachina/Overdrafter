// @vitest-environment node

import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
  type ManufacturingCorpusRoot,
} from "./manufacturingCorpusContract.js";
import { serializeManufacturingCorpusManifestDiagnostics } from "./manufacturingCorpusFilesystemDiagnostics.js";
import type { LoadedManufacturingCorpusManifest } from "./manufacturingCorpusManifestLoader.js";
import {
  resolveManufacturingCorpusRootBindings,
  serializeManufacturingCorpusRootBindingsResult,
} from "./manufacturingCorpusRootBindings.js";

function manifestRoot(
  rootId: string,
  relativePath: string,
): ManufacturingCorpusRoot {
  return {
    schemaVersion: MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
    rootId,
    kind: "manifest_relative",
    relativePath,
    accessClass: "redistributable",
    allowedDataClassifications: ["public"],
  };
}

function externalRoot(rootId: string): ManufacturingCorpusRoot {
  return {
    schemaVersion: MANUFACTURING_CORPUS_ROOT_SCHEMA_VERSION,
    rootId,
    kind: "external_mount",
    accessClass: "internal_only",
    allowedDataClassifications: ["internal"],
  };
}

function loadedContext(
  canonicalManifestDirectory: string,
  roots: readonly ManufacturingCorpusRoot[],
): LoadedManufacturingCorpusManifest {
  return {
    state: "loaded",
    manifest: { roots } as LoadedManufacturingCorpusManifest["manifest"],
    manifestSha256: "a".repeat(64),
    canonicalManifestDirectory,
    diagnostics: [],
  };
}

describe("manufacturing corpus root bindings", () => {
  let directory: string;
  let manifestDirectory: string;

  beforeEach(async () => {
    directory = await mkdtemp(
      path.join(await realpath(os.tmpdir()), "corpus-roots-"),
    );
    manifestDirectory = path.join(directory, "manifest");
    await mkdir(manifestDirectory);
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("resolves contained manifest and explicitly bound external roots", async () => {
    const nested = path.join(manifestDirectory, "fixtures", "nested");
    const external = path.join(directory, "external");
    await mkdir(nested, { recursive: true });
    await mkdir(external);
    const loaded = loadedContext(manifestDirectory, [
      manifestRoot("manifest-base", "."),
      manifestRoot("manifest-root", "fixtures/nested"),
      externalRoot("external-root"),
    ]);

    const result = await resolveManufacturingCorpusRootBindings(
      loaded,
      new Map([["external-root", external]]),
    );

    expect(result.state).toBe("resolved");
    if (result.state !== "resolved") {
      return;
    }
    expect([...result.canonicalDirectoriesByRootId.entries()]).toEqual([
      ["manifest-base", manifestDirectory],
      ["manifest-root", nested],
      ["external-root", external],
    ]);
    expect(serializeManufacturingCorpusRootBindingsResult(result)).toBe(
      '{\n  "state": "resolved",\n  "diagnostics": []\n}\n',
    );
    expect(serializeManufacturingCorpusRootBindingsResult(result)).not.toContain(
      directory,
    );
  });

  it.each([
    ["missing", "manifest_root_missing"],
    ["non-directory", "manifest_root_not_directory"],
    ["intermediate-symlink", "manifest_root_symlink"],
    ["middle-symlink", "manifest_root_symlink"],
    ["final-symlink", "manifest_root_symlink"],
    ["intermediate-file", "manifest_root_not_directory"],
    ["escape", "manifest_root_escape"],
    ["absolute-escape", "manifest_root_escape"],
  ] as const)("rejects a %s manifest-relative root", async (scenario, code) => {
    let relativePath = "missing";
    if (scenario === "non-directory") {
      relativePath = "file";
      await writeFile(path.join(manifestDirectory, relativePath), "x");
    } else if (scenario === "intermediate-symlink") {
      await mkdir(path.join(manifestDirectory, "target", "child"), {
        recursive: true,
      });
      await symlink(
        path.join(manifestDirectory, "target"),
        path.join(manifestDirectory, "link"),
      );
      relativePath = "link/child";
    } else if (scenario === "middle-symlink") {
      await mkdir(path.join(manifestDirectory, "parent", "target", "child"), {
        recursive: true,
      });
      await symlink(
        path.join(manifestDirectory, "parent", "target"),
        path.join(manifestDirectory, "parent", "link"),
      );
      relativePath = "parent/link/child";
    } else if (scenario === "final-symlink") {
      await mkdir(path.join(manifestDirectory, "target"));
      await symlink(
        path.join(manifestDirectory, "target"),
        path.join(manifestDirectory, "link"),
      );
      relativePath = "link";
    } else if (scenario === "intermediate-file") {
      await writeFile(path.join(manifestDirectory, "file"), "x");
      relativePath = "file/child";
    } else if (scenario === "escape") {
      relativePath = "../outside";
    } else if (scenario === "absolute-escape") {
      relativePath = path.join(directory, "outside");
    }
    const tamperedRoot = {
      ...manifestRoot("manifest-root", "."),
      relativePath,
    } as ManufacturingCorpusRoot;
    const result = await resolveManufacturingCorpusRootBindings(
      loadedContext(manifestDirectory, [tamperedRoot]),
      new Map(),
    );

    expect(result).toEqual({
      state: "failed",
      diagnostics: [
        { code, recordKind: "root", recordId: "manifest-root" },
      ],
    });
  });

  it("rejects unknown, unmounted, and relative external bindings", async () => {
    const loaded = loadedContext(manifestDirectory, [
      manifestRoot("committed", "."),
      externalRoot("unmounted"),
      externalRoot("relative"),
    ]);
    const result = await resolveManufacturingCorpusRootBindings(
      loaded,
      new Map([
        ["committed", manifestDirectory],
        ["relative", "relative/path"],
        ["unknown", manifestDirectory],
      ]),
    );

    expect(result).toEqual({
      state: "failed",
      diagnostics: [
        {
          code: "external_root_binding_not_absolute",
          recordKind: "root",
          recordId: "relative",
        },
        {
          code: "external_root_unknown_binding",
          recordKind: "root",
          recordId: "committed",
        },
        {
          code: "external_root_unknown_binding",
          recordKind: "root",
          recordId: "unknown",
        },
        {
          code: "external_root_unmounted",
          recordKind: "root",
          recordId: "unmounted",
        },
      ],
    });
  });

  it("rejects a canonical manifest-root escape after component inspection", async () => {
    const rootPath = path.join(manifestDirectory, "race-root");
    const movedPath = path.join(manifestDirectory, "race-root-original");
    const outside = path.join(directory, "outside");
    await mkdir(rootPath);
    await mkdir(outside);
    const result = await resolveManufacturingCorpusRootBindings(
      loadedContext(manifestDirectory, [
        manifestRoot("manifest-root", "race-root"),
      ]),
      new Map(),
      {
        afterComponentInspectionForTest: async () => {
          await rename(rootPath, movedPath);
          await symlink(outside, rootPath);
        },
      },
    );
    expect(result).toEqual({
      state: "failed",
      diagnostics: [
        {
          code: "manifest_root_escape",
          recordKind: "root",
          recordId: "manifest-root",
        },
      ],
    });
  });

  it.each([
    ["missing", "external_root_missing"],
    ["non-directory", "external_root_not_directory"],
    ["intermediate-symlink", "external_root_symlink"],
    ["final-symlink", "external_root_symlink"],
    ["intermediate-file", "external_root_not_directory"],
  ] as const)("rejects a %s external root", async (scenario, code) => {
    let binding = path.join(directory, "missing");
    if (scenario === "non-directory") {
      binding = path.join(directory, "file");
      await writeFile(binding, "x");
    } else if (scenario === "intermediate-symlink") {
      const target = path.join(directory, "target");
      await mkdir(path.join(target, "child"), { recursive: true });
      const link = path.join(directory, "link");
      await symlink(target, link);
      binding = path.join(link, "child");
    } else if (scenario === "final-symlink") {
      const target = path.join(directory, "target");
      await mkdir(target);
      binding = path.join(directory, "link");
      await symlink(target, binding);
    } else if (scenario === "intermediate-file") {
      binding = path.join(directory, "file", "child");
      await writeFile(path.join(directory, "file"), "x");
    }
    const result = await resolveManufacturingCorpusRootBindings(
      loadedContext(manifestDirectory, [externalRoot("external")]),
      new Map([["external", binding]]),
    );

    expect(result).toEqual({
      state: "failed",
      diagnostics: [{ code, recordKind: "root", recordId: "external" }],
    });
  });

  it("returns deterministic diagnostics without paths or partial roots", async () => {
    const sentinel = path.join(directory, "sentinel-private-path");
    const loaded = loadedContext(manifestDirectory, [
      manifestRoot("missing-manifest", "sentinel-missing"),
      externalRoot("missing-external"),
    ]);
    const bindings = new Map([["missing-external", sentinel]]);
    const first = await resolveManufacturingCorpusRootBindings(
      loaded,
      bindings,
    );
    const second = await resolveManufacturingCorpusRootBindings(
      loaded,
      bindings,
    );
    expect(first.state).toBe("failed");
    expect("canonicalDirectoriesByRootId" in first).toBe(false);
    if (first.state !== "failed" || second.state !== "failed") {
      return;
    }
    const serialized = serializeManufacturingCorpusManifestDiagnostics(
      first.diagnostics,
    );
    expect(serialized).toBe(
      serializeManufacturingCorpusManifestDiagnostics(second.diagnostics),
    );
    expect(serialized).not.toContain(directory);
    expect(serialized).not.toContain("sentinel");
  });
});
