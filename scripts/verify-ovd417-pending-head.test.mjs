import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EXPECTED_SOURCE_COMMIT, FROZEN_PENDING_HEAD_FILENAMES, inspectPendingHead, validateManifestShape, verifyPendingHead } from "./verify-ovd417-pending-head.mjs";

const manifestPath = path.resolve(process.cwd(), "docs/release/ovd-417-four-migration-manifest.json");
const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const manifest = async () => JSON.parse(await readFile(manifestPath, "utf8"));
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ovd417-pending-")); roots.push(root);
  const value = await manifest();
  for (const entry of value.pendingHead) await writeFile(path.join(root, entry.filename), await readFile(path.join(process.cwd(), "supabase/migrations", entry.filename)));
  return { root, value };
}

describe("OVD-417 pending-head manifest", () => {
  it("freezes the exact source commit, four filenames, byte lengths, and hashes", async () => {
    const value = await manifest();
    expect(value.sourceCommit).toBe(EXPECTED_SOURCE_COMMIT);
    expect(value.pendingHead.map((entry) => entry.filename)).toEqual(FROZEN_PENDING_HEAD_FILENAMES);
    expect(value.pendingHead.map((entry) => entry.bytes)).toEqual([17405, 443, 7992, 5791]);
    expect(validateManifestShape(value)).toEqual([]);
  });
  it("accepts only the exact four-file fixture", async () => {
    const { root, value } = await fixture();
    expect(await inspectPendingHead(root, value, { sourceMigrationFilenames: FROZEN_PENDING_HEAD_FILENAMES })).toEqual([]);
  });
  it("fails closed on missing, extra, reordered, and content-drift migration trees", async () => {
    const { root, value } = await fixture();
    await unlink(path.join(root, FROZEN_PENDING_HEAD_FILENAMES[0]));
    await writeFile(path.join(root, "20260822213331_extra.sql"), "select 1;\n");
    const violations = await inspectPendingHead(root, value, { sourceMigrationFilenames: FROZEN_PENDING_HEAD_FILENAMES });
    expect(violations).toEqual(expect.arrayContaining([expect.stringContaining("migration directory: missing"), expect.stringContaining("migration directory: extra"), expect.stringContaining("migration is missing")]));
    const reordered = { ...value, pendingHead: [...value.pendingHead].reverse() };
    expect(validateManifestShape(reordered)).toContain("manifest pending-head: files are reordered");
  });
  it("rejects byte and digest drift", async () => {
    const { root, value } = await fixture();
    await writeFile(path.join(root, FROZEN_PENDING_HEAD_FILENAMES[0]), "select drift;\n");
    expect(await inspectPendingHead(root, value)).toEqual(expect.arrayContaining([expect.stringContaining("expected 17405 bytes"), expect.stringContaining("SHA-256 does not match manifest")]));
  });
  it("proves local source ancestry, source blobs, and the full source migration tree", async () => {
    expect(await verifyPendingHead()).toEqual([]);
  });
});
