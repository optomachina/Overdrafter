import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BLOCKED_PUBLIC_ASSET_BASENAMES,
  BLOCKED_PUBLIC_ASSET_SHA256,
  inspectPublicAsset,
  scanPublicAssetRoots,
} from "./verify-public-assets.mjs";

describe("public validation-asset containment", () => {
  it("keeps every known former public validation identity in the policy", () => {
    expect(BLOCKED_PUBLIC_ASSET_BASENAMES).toHaveProperty("size", 3);
    expect(BLOCKED_PUBLIC_ASSET_SHA256).toHaveProperty("size", 3);
    expect(BLOCKED_PUBLIC_ASSET_BASENAMES.has("1093-05589-02.step")).toBe(true);
    expect(
      BLOCKED_PUBLIC_ASSET_SHA256.has(
        "4111602b512ea575c010184f904675c92b8977028088c372033a7754d1e9f043",
      ),
    ).toBe(true);
    expect(
      BLOCKED_PUBLIC_ASSET_SHA256.has(
        "4c1a151a9c642137a2d98c2ea1d2b1381db0ef28b8ca819d3fa360e26f861962",
      ),
    ).toBe(true);
  });

  it("accepts only the intended synthetic public demo bytes", async () => {
    const contents = await readFile(
      path.resolve(process.cwd(), "public/fixtures/demo-bracket.step"),
    );
    expect(
      inspectPublicAsset(
        path.join("public", "fixtures", "demo-bracket.step"),
        contents,
      ),
    ).toEqual([]);
  });

  it("rejects different bytes under an approved public demo name", () => {
    expect(
      inspectPublicAsset(
        path.join("public", "fixtures", "demo-bracket.step"),
        Buffer.from("customer bytes renamed as the demo"),
      ),
    ).toContain("approved public binary hash mismatch: demo-bracket.step");
  });

  it("rejects a prohibited filename regardless of case", () => {
    expect(inspectPublicAsset("1093-05589-02.StEp", Buffer.from("different bytes"))).toContain(
      "blocked filename: 1093-05589-02.step",
    );
  });

  it("rejects renamed prohibited bytes", () => {
    const contents = Buffer.from("known prohibited bytes");
    const blockedHashes = new Set([
      createHash("sha256").update(contents).digest("hex"),
    ]);

    expect(
      inspectPublicAsset("renamed.bin", contents, {
        blockedBasenames: new Set(),
        blockedHashes,
        blockedMarkers: [],
      }),
    ).toHaveLength(1);
  });

  it("rejects a prohibited identity embedded in a shipped bundle", () => {
    expect(inspectPublicAsset("app.js", Buffer.from("sample=1093-05589-02"))).toContain(
      "blocked validation-package identity marker",
    );
  });

  it("rejects any new CAD or PDF binary anywhere in a public root", () => {
    expect(
      inspectPublicAsset(
        path.join("public", "assets", "private-candidate.x_t"),
        Buffer.from("different bytes"),
      ),
    ).toContain("unapproved public binary: private-candidate.x_t");
  });

  it("scans every supplied public or build root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "overdrafter-public-assets-"));
    const publicRoot = path.join(root, "public");
    const distRoot = path.join(root, "dist");
    await mkdir(publicRoot);
    await mkdir(distRoot);
    await writeFile(path.join(publicRoot, "safe.txt"), "synthetic demo");
    await writeFile(path.join(distRoot, "app.js"), "sample=1093-05589-A");

    const violations = await scanPublicAssetRoots([publicRoot, distRoot]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("dist/app.js");
  });

  it("fails closed when a required root is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "overdrafter-public-assets-"));

    const violations = await scanPublicAssetRoots([path.join(root, "missing")]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("required scan root does not exist");
  });

  it("fails closed on symlinks inside a publication root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "overdrafter-public-assets-"));
    const publicRoot = path.join(root, "public");
    const safeTarget = path.join(root, "safe.step");
    await mkdir(publicRoot);
    await writeFile(safeTarget, "synthetic demo");
    await symlink(safeTarget, path.join(publicRoot, "linked.step"));

    const violations = await scanPublicAssetRoots([publicRoot]);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("unsupported filesystem entry");
  });
});
