// @vitest-environment node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished, test } from "vitest";
import { installationPlan, installCamoufox } from "../worker/scripts/install-camoufox.mjs";

const require = createRequire(new URL("../worker/package.json", import.meta.url));
const AdmZip = createRequire(require.resolve("camoufox-js"))("adm-zip");

function archive(entries) {
  const zip = new AdmZip();
  for (const [name, value] of Object.entries(entries)) zip.addFile(name, Buffer.from(value));
  return zip.toBuffer();
}

async function fixture(t, platform = "linux", arch = "x64", extraFiles = {}) {
  const home = await mkdtemp(path.join(tmpdir(), "ovd-camoufox-offline-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const plan = installationPlan(platform, arch, home);
  const archives = [
    archive({ [plan.launcher]: "offline launcher", ...extraFiles }),
    archive({ "manifest.json": JSON.stringify({ version: "1.73.0" }) }),
  ];
  plan.assets = plan.assets.map((asset, index) => ({ ...asset, sha256: createHash("sha256").update(archives[index]).digest("hex") }));
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const index = plan.assets.findIndex((asset) => asset.url === url);
    assert.notEqual(index, -1, `Unexpected network request: ${url}`);
    return new Response(archives[index]);
  };
  return { plan, archives, requests, fetchImpl };
}

test("every supported platform has exact reviewed browser and UBO assets", () => {
  for (const [platform, arch] of [["linux", "x64"], ["linux", "arm64"], ["darwin", "x64"], ["darwin", "arm64"], ["win32", "x64"], ["win32", "ia32"]]) {
    const plan = installationPlan(platform, arch, "/fixture");
    assert.equal(plan.assets.length, 2);
    assert.match(plan.assets[0].url, /\/v152\.0\.4-beta\.28\/camoufox-152\.0\.4-beta\.28-/);
    assert.equal(plan.assets[1].url, "https://addons.mozilla.org/firefox/downloads/file/4940584/ublock_origin-1.73.0.xpi");
    for (const asset of plan.assets) {
      assert.match(asset.sha256, /^[a-f0-9]{64}$/);
      assert.doesNotMatch(asset.url, /latest|geoip|geolite|mmdb/i);
    }
  }
  assert.throws(() => installationPlan("linux", "ia32"), /No pinned/);
});

for (const [platform, arch] of [["linux", "x64"], ["darwin", "arm64"], ["win32", "x64"]]) {
  test(`${platform} installs only the pinned browser and addon with correct cache layout, then reuses without network`, async (t) => {
    const f = await fixture(t, platform, arch);
    assert.equal((await installCamoufox(f)).reused, false);
    assert.deepEqual(f.requests, f.plan.assets.map((asset) => asset.url));
    assert.deepEqual(JSON.parse(await readFile(path.join(f.plan.installDir, "version.json"), "utf8")), { version: "152.0.4", release: "beta.28" });
    assert.equal(JSON.parse(await readFile(path.join(f.plan.installDir, f.plan.addonDir, "manifest.json"), "utf8")).version, "1.73.0");
    assert.ok((await readFile(path.join(f.plan.installDir, f.plan.launcher), "utf8")).includes("offline launcher"));
    const files = await readdir(f.plan.installDir, { recursive: true });
    assert.ok(files.every((name) => !/\.mmdb$/i.test(name)));
    assert.equal((await installCamoufox({ plan: f.plan, fetchImpl: () => assert.fail("reuse attempted download") })).reused, true);
  });
}

test("checksum mismatch fails before extraction and leaves no installation", async (t) => {
  const f = await fixture(t);
  f.plan.assets[0].sha256 = "0".repeat(64);
  await assert.rejects(installCamoufox(f), /SHA-256 mismatch/);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(await readdir(path.dirname(f.plan.installDir)), []);
});

test("HTTP failure stops without fetching addons or installing files", async (t) => {
  const f = await fixture(t);
  await assert.rejects(installCamoufox({ plan: f.plan, fetchImpl: async () => new Response("missing", { status: 404 }) }), /HTTP 404/);
  assert.deepEqual(await readdir(path.dirname(f.plan.installDir)), []);
});

test("database-bearing browser archive is rejected even when its checksum matches", async (t) => {
  const f = await fixture(t, "linux", "x64", { "nested/GeoLite2-City.MMDB": "not allowed" });
  await assert.rejects(installCamoufox(f), /GeoIP database in/);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(await readdir(path.dirname(f.plan.installDir)), []);
});

test("database-bearing addon archive is rejected and staged browser is discarded", async (t) => {
  const f = await fixture(t);
  f.archives[1] = archive({ "manifest.json": '{"version":"1.73.0"}', "GeoLite2-City.mmdb": "not allowed" });
  f.plan.assets[1].sha256 = createHash("sha256").update(f.archives[1]).digest("hex");
  await assert.rejects(installCamoufox(f), /GeoIP database in/);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(await readdir(path.dirname(f.plan.installDir)), []);
});

test("incomplete browser archive cannot publish a partially working installation", async (t) => {
  const f = await fixture(t);
  f.archives[0] = archive({ "unrelated-file": "missing launcher" });
  f.plan.assets[0].sha256 = createHash("sha256").update(f.archives[0]).digest("hex");
  await assert.rejects(installCamoufox(f), { code: "ENOENT" });
  assert.deepEqual(await readdir(path.dirname(f.plan.installDir)), []);
});

test("database-bearing existing cache is preserved and fails before all downloads", async (t) => {
  const f = await fixture(t);
  await mkdir(f.plan.installDir, { recursive: true });
  const database = path.join(f.plan.installDir, "GeoLite2-City.mmdb");
  await writeFile(database, "retained evidence");
  await assert.rejects(installCamoufox(f), /separately approved retirement/);
  assert.deepEqual(f.requests, []);
  assert.equal(await readFile(database, "utf8"), "retained evidence");
});

test("existing wrong browser or addon pin fails without rewriting or downloading", async (t) => {
  const f = await fixture(t);
  await installCamoufox(f);
  const versionPath = path.join(f.plan.installDir, "version.json");
  await writeFile(versionPath, JSON.stringify({ version: "old", release: "old" }));
  await assert.rejects(installCamoufox(f), /version differs/);
  assert.equal(f.requests.length, 2);
  assert.equal(JSON.parse(await readFile(versionPath, "utf8")).version, "old");
  await writeFile(versionPath, JSON.stringify({ version: "152.0.4", release: "beta.28" }));
  const manifest = path.join(f.plan.installDir, f.plan.addonDir, "manifest.json");
  await writeFile(manifest, JSON.stringify({ version: "old" }));
  await assert.rejects(installCamoufox(f), /pinned uBlock/);
  assert.equal(f.requests.length, 2);
  assert.equal(JSON.parse(await readFile(manifest, "utf8")).version, "old");
});
