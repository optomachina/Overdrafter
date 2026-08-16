import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPECTED_SOURCE_COMMIT,
  FROZEN_PENDING_HEAD_FILENAMES,
  FROZEN_RETIRED_ALIASES,
  QUALIFICATION_MIGRATION_FILENAMES,
  PRODUCTION_HISTORY_RECONCILIATIONS,
  inspectPendingHead,
  validateManifestShape,
} from "./verify-ovd372-pending-head.mjs";

const manifestPath = path.resolve(
  process.cwd(),
  "docs/release/ovd-372-pending-head-manifest.json",
);

async function readManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function makePendingRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "overdrafter-ovd372-pending-"));
  const sourceRoot = path.resolve(process.cwd(), "supabase/migrations");
  const manifest = await readManifest();
  for (const entry of [
    ...manifest.pendingHead,
    ...manifest.qualificationMigrations,
  ]) {
    const contents = await readFile(path.join(sourceRoot, entry.filename));
    await writeFile(path.join(root, entry.filename), contents);
  }
  return { manifest, root };
}

describe("OVD-372 pending-head manifest", () => {
  it("freezes the source commit, ordered 23-file head, and retired aliases", async () => {
    const manifest = await readManifest();

    expect(manifest.sourceCommit).toBe(EXPECTED_SOURCE_COMMIT);
    expect(manifest.pendingHead).toHaveLength(23);
    expect(manifest.pendingHead.map((entry) => entry.filename)).toEqual(
      FROZEN_PENDING_HEAD_FILENAMES,
    );
    expect(manifest.retiredAliases).toEqual(FROZEN_RETIRED_ALIASES);
    expect(manifest.qualificationMigrations.map((entry) => entry.filename)).toEqual(
      QUALIFICATION_MIGRATION_FILENAMES,
    );
    expect(manifest.productionHistoryReconciliations).toEqual(
      PRODUCTION_HISTORY_RECONCILIATIONS,
    );
    expect(validateManifestShape(manifest)).toEqual([]);
  });

  it("accepts the exact pending file set and hashes", async () => {
    const { manifest, root } = await makePendingRoot();

    expect(
      await inspectPendingHead(root, manifest, {
        sourceMigrationFilenames: [
          ...FROZEN_PENDING_HEAD_FILENAMES,
          ...QUALIFICATION_MIGRATION_FILENAMES,
        ],
      }),
    ).toEqual([]);
  });

  it("reports missing and extra files", async () => {
    const { manifest, root } = await makePendingRoot();
    await unlink(path.join(root, FROZEN_PENDING_HEAD_FILENAMES[0]));
    await writeFile(path.join(root, "20260816020000_unexpected.sql"), "select 1;\n");

    const violations = await inspectPendingHead(root, manifest, {
      sourceMigrationFilenames: [
        ...FROZEN_PENDING_HEAD_FILENAMES,
        ...QUALIFICATION_MIGRATION_FILENAMES,
      ],
    });

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("migration directory: missing"),
        expect.stringContaining("migration directory: extra"),
        expect.stringContaining("migration is missing"),
      ]),
    );
  });

  it("reports a reordered manifest entry", async () => {
    const { manifest, root } = await makePendingRoot();
    const reordered = { ...manifest, pendingHead: [...manifest.pendingHead] };
    [reordered.pendingHead[0], reordered.pendingHead[1]] = [
      reordered.pendingHead[1],
      reordered.pendingHead[0],
    ];

    const violations = await inspectPendingHead(root, reordered, {
      sourceMigrationFilenames: [
        ...FROZEN_PENDING_HEAD_FILENAMES,
        ...QUALIFICATION_MIGRATION_FILENAMES,
      ],
    });

    expect(violations).toContain("manifest pending-head: files are reordered");
  });

  it("reports byte and SHA-256 drift", async () => {
    const { manifest, root } = await makePendingRoot();
    const filename = manifest.pendingHead[0].filename;
    await writeFile(path.join(root, filename), "select drift;\n");

    const violations = await inspectPendingHead(root, manifest, {
      sourceMigrationFilenames: [
        ...FROZEN_PENDING_HEAD_FILENAMES,
        ...QUALIFICATION_MIGRATION_FILENAMES,
      ],
    });

    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining("expected 10895 bytes"),
        expect.stringContaining("expected SHA-256"),
      ]),
    );
  });

  it("rejects reintroduced retired aliases", async () => {
    const { manifest, root } = await makePendingRoot();
    const retiredAlias = FROZEN_RETIRED_ALIASES[0];
    await writeFile(path.join(root, retiredAlias), "select 1;\n");

    const violations = await inspectPendingHead(root, manifest);

    expect(violations).toContain(`${retiredAlias}: retired migration alias is present`);
  });
});
