// @vitest-environment node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assertLocatorPacks, canonicalLocatorPackJson, locatorPackSha256, readLocatorPacks, readLocatorPackSchema, renderLocatorPackBundle, validateLocatorPack } from "./provider-check-locator-packs.mjs";
import { readProviderManifests } from "./provider-manifest.mjs";
import { parseLocatorPack, locatorPackSha256 as runtimeSha, canonicalLocatorPackJson as runtimeJson } from "../worker/src/fixtureHeal/locatorPack.ts";
import { applyLocatorPackEdits, malformedLocatorPackCases } from "../worker/test-support/locatorPackCases.ts";
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifests = await readProviderManifests(rootDir);
const packs = await assertLocatorPacks({ rootDir, manifests });
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ovd814-locators-")); roots.push(root);
  await fs.cp(path.join(rootDir, "provider-integrations"), path.join(root, "provider-integrations"), { recursive: true });
  await fs.mkdir(path.join(root, "worker/src"), { recursive: true });
  await fs.copyFile(path.join(rootDir, "worker/src/providerDispatchEnvelope.ts"), path.join(root, "worker/src/providerDispatchEnvelope.ts"));
  return root;
}
async function change(root, fn, file = "provider-integrations/quickparts/locators.v1.json") {
  const target = path.join(root, file), p = JSON.parse(await fs.readFile(target, "utf8"));
  fn(p); await fs.writeFile(target, JSON.stringify(p));
}
describe("locator pack build validation", () => {
  it("real packs validate with canonical hash parity", async () => {
    expect(packs.map(p => p.provider)).toEqual(["geomiq", "oshcut", "quickparts", "weerg"]);
    expect(packs.filter(p => p.envelopeReviewed).map(p => p.provider)).toEqual(["quickparts", "weerg"]);
    expect(await readLocatorPackSchema(rootDir)).toMatchObject({ title: "ProviderLocatorPackV1", additionalProperties: false });
    for (const entry of packs) {
      expect(validateLocatorPack(entry.pack, entry)).toEqual(entry.pack);
      expect(parseLocatorPack(entry.pack).ok).toBe(true);
      expect(locatorPackSha256(entry.pack)).toBe(runtimeSha(entry.pack));
      expect(canonicalLocatorPackJson(entry.pack)).toBe(runtimeJson(entry.pack));
    }
  });
  it.each(malformedLocatorPackCases)("validator parity: $name", ({ provider = "quickparts", edits, reason }) => {
    const entry = packs.find(p => p.provider === provider);
    const bad = applyLocatorPackEdits(entry.pack, edits);
    const result = parseLocatorPack(bad);
    expect(result).toMatchObject({ ok: false, reason });
    expect(() => validateLocatorPack(bad, entry)).toThrow(`${result.path}: ${reason}`);
  });
  it("file-name/revision mismatch fails", async () => {
    const root = await fixture(); await change(root, p => { p.revision = "quickparts-production-locators.v2"; });
    await expect(assertLocatorPacks({ rootDir: root, manifests })).rejects.toThrow("file/revision mismatch");
  });
  it("duplicate revision fails", async () => {
    const root = await fixture();
    await fs.copyFile(path.join(root, "provider-integrations/quickparts/locators.v1.json"), path.join(root, "provider-integrations/quickparts/locators.v2.json"));
    await expect(assertLocatorPacks({ rootDir: root, manifests })).rejects.toThrow("duplicate revision");
  });
  it.each(["locators.json.backup", "locators.v01.json", "locators.v1.txt", "locators.v1000000.json"])("bad file name fails: %s", async name => {
    const root = await fixture(); await fs.writeFile(path.join(root, "provider-integrations/quickparts", name), "{}");
    await expect(assertLocatorPacks({ rootDir: root, manifests })).rejects.toThrow("invalid locator pack file name");
  });
  it("host outside manifest domains fails", async () => {
    const root = await fixture(); await change(root, p => { p.allowedHosts.push("outside.example.com"); });
    await expect(assertLocatorPacks({ rootDir: root, manifests })).rejects.toThrow("host outside manifest domains");
  });
  it("reviewed-envelope mismatch fails", async () => {
    const root = await fixture(); await change(root, p => { p.envelopeRevision = "quickparts-quote-envelope.v2"; });
    await expect(assertLocatorPacks({ rootDir: root, manifests })).rejects.toThrow("locator_pack_envelope_mismatch");
  });
  it("empty reviewed registry keeps packs unreviewed", async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, "worker/src/providerDispatchEnvelope.ts"), "export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES = [];\n");
    expect((await assertLocatorPacks({ rootDir: root, manifests })).every(p => p.envelopeReviewed === false)).toBe(true);
  });
  it("a pack needs its provider manifest", async () => {
    await expect(assertLocatorPacks({ rootDir, manifests: manifests.filter(m => m.manifest.key !== "weerg") })).rejects.toThrow("missing manifest");
  });
  it("schema missing, malformed and open contracts fail", async () => {
    const root = await fixture(), schemaFile = path.join(root, "provider-integrations/provider-locator-pack.v1.schema.json");
    await fs.writeFile(schemaFile, "{}");
    await expect(readLocatorPackSchema(root)).rejects.toThrow("closed V1 contract");
    await fs.writeFile(schemaFile, "not json");
    await expect(readLocatorPackSchema(root)).rejects.toThrow("missing or invalid");
    await fs.rm(schemaFile);
    await expect(readLocatorPackSchema(root)).rejects.toThrow("missing or invalid");
  });
  it("only the active (highest) revision must bind the reviewed envelope", async () => {
    const root = await fixture();
    const next = structuredClone(packs.find(p => p.provider === "quickparts").pack);
    next.revision = "quickparts-production-locators.v2";
    await fs.writeFile(path.join(root, "provider-integrations/quickparts/locators.v2.json"), JSON.stringify(next));
    await change(root, p => { p.envelopeRevision = "quickparts-quote-envelope.v9"; });
    expect((await assertLocatorPacks({ rootDir: root, manifests })).filter(p => p.provider === "quickparts").map(p => p.revision))
      .toEqual(["quickparts-production-locators.v1", "quickparts-production-locators.v2"]);
    await change(root, p => { p.envelopeRevision = "quickparts-quote-envelope.v9"; }, "provider-integrations/quickparts/locators.v2.json");
    await expect(assertLocatorPacks({ rootDir: root, manifests })).rejects.toThrow("locators.v2.json: envelopeRevision: locator_pack_envelope_mismatch");
  });
  it("bundle is deterministic, newest-only and contains no authority language", async () => {
    const root = await fixture();
    const next = structuredClone(packs.find(p => p.provider === "quickparts").pack);
    next.revision = "quickparts-production-locators.v2";
    await fs.writeFile(path.join(root, "provider-integrations/quickparts/locators.v2.json"), JSON.stringify(next));
    const all = await assertLocatorPacks({ rootDir: root, manifests });
    expect((await readLocatorPacks(root)).find(p => p.provider === "quickparts").revisions.map(p => p.fileRevisionNumber)).toEqual([1, 2]);
    const output = renderLocatorPackBundle(all);
    expect(output).toBe(renderLocatorPackBundle([...all].reverse()));
    expect(output).toContain("quickparts-production-locators.v2");
    expect(output).not.toContain("quickparts-production-locators.v1");
    expect(output).not.toMatch(/certified|admission|dispatchEnabled|productionAuthorized/i);
    expect(output).toMatch(/^\/\/ Generated by npm run provider:sync\. Do not edit directly\./);
  });
});
