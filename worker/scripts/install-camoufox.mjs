import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
// Resolve the existing locked archive dependency without loading browser/GeoIP code.
const AdmZip = createRequire(require.resolve("camoufox-js"))("adm-zip");
const VERSION = { version: "152.0.4", release: "beta.28" };
const RELEASE = `${VERSION.version}-${VERSION.release}`;
// GitHub's exact v152.0.4-beta.28 release-asset SHA-256 metadata; no latest fallback.
const BROWSER_HASHES = {
  "linux:x64": ["lin.x86_64", "924f3109ccd6d47cd6a0384d67a345fadf975d48b6319f8dbbd5954c588982bd"],
  "linux:arm64": ["lin.arm64", "3a105a2fc929e80a79b4b7fce2c93ed62c4fb2c877f3c1ed2a5d66a1c4fe968f"],
  "darwin:x64": ["mac.x86_64", "6e0efd66f6db46bece072827cb2c5a4851bca822ff4fed95b8a0c2fb6f61a3d4"],
  "darwin:arm64": ["mac.arm64", "8b7680a61818245cf4eb0150edab811d4ed937b6723514569e74c3e7df9685bd"],
  "win32:x64": ["win.x86_64", "386fc2f41139685f9a1a9cef0d024bc041d899c315ea538d561171b5b282e57d"],
  "win32:ia32": ["win.i686", "a713aca14f4ef0429eab502bacf42548fe6202bb4e29da1ca64761ed08d409af"],
};

/** Returns only the two reviewed assets and the cache layout used by camoufox-js. */
export function installationPlan(platform = process.platform, arch = process.arch, home = homedir()) {
  const pin = BROWSER_HASHES[`${platform}:${arch}`];
  if (!pin) throw new Error(`No pinned Camoufox asset for ${platform}/${arch}`);
  let installDir = path.join(home, ".cache", "camoufox");
  let launcher = "camoufox-bin";
  let resources = "";
  if (platform === "darwin") {
    installDir = path.join(home, "Library", "Caches", "camoufox");
    launcher = "Camoufox.app/Contents/MacOS/camoufox";
    resources = "Camoufox.app/Contents/Resources";
  } else if (platform === "win32") {
    installDir = path.join(home, "AppData", "Local", "camoufox", "camoufox", "Cache");
    launcher = "camoufox.exe";
  }
  return {
    platform, installDir, launcher,
    addonDir: path.join(resources, "addons", "UBO"),
    assets: [
      { url: `https://github.com/daijro/camoufox/releases/download/v${RELEASE}/camoufox-${RELEASE}-${pin[0]}.zip`, sha256: pin[1], destination: "" },
      { url: "https://addons.mozilla.org/firefox/downloads/file/4940584/ublock_origin-1.73.0.xpi", sha256: "bccc51a773150af4af6e1fd62c7bfdeb7238b79ff2381b998fa9f2e38f64786a", destination: path.join(resources, "addons", "UBO") },
    ],
  };
}

async function exists(target) {
  try { await lstat(target); return true; } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function inspectTree(directory, executable = false) {
  const info = await lstat(directory);
  if (info.isSymbolicLink()) throw new Error(`Camoufox cache contains a symbolic link: ${directory}`);
  if (/\.mmdb$/i.test(directory)) throw new Error(`GeoIP database present: ${directory}; preserve it for separately approved retirement`);
  if (executable) await chmod(directory, 0o755);
  if (info.isDirectory()) {
    for (const name of await readdir(directory)) await inspectTree(path.join(directory, name), executable);
  }
}

async function validateInstallation(directory, plan) {
  await inspectTree(directory);
  const version = JSON.parse(await readFile(path.join(directory, "version.json"), "utf8"));
  if (version.version !== VERSION.version || version.release !== VERSION.release) throw new Error("Existing Camoufox version differs from the reviewed pin");
  const binary = await lstat(path.join(directory, plan.launcher));
  if (!binary.isFile() || (plan.platform !== "win32" && !(binary.mode & 0o111))) throw new Error("Pinned Camoufox launcher is missing or not executable");
  const addon = JSON.parse(await readFile(path.join(directory, plan.addonDir, "manifest.json"), "utf8"));
  if (addon.version !== "1.73.0") throw new Error("Camoufox requires the pinned uBlock Origin 1.73.0 addon");
}

async function downloadVerified(asset, fetchImpl) {
  const response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`Camoufox asset download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) throw new Error("Camoufox asset SHA-256 mismatch");
  return bytes;
}

function extractChecked(bytes, destination) {
  const zip = new AdmZip(bytes);
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replaceAll("\\", "/");
    if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").includes("..")) throw new Error("Unsafe Camoufox archive path");
    if (/\.mmdb\/?$/i.test(name)) throw new Error("GeoIP database in Camoufox archive");
  }
  zip.extractAllTo(destination, true);
}

/** Install verified browser/addon archives only, preserving existing caches on any failure.
 * Plan and fetch injection allow complete offline installation regression tests.
 */
export async function installCamoufox({ plan = installationPlan(), fetchImpl = globalThis.fetch } = {}) {
  if (await exists(plan.installDir)) {
    await validateInstallation(plan.installDir, plan);
    return { reused: true, installDir: plan.installDir };
  }
  await mkdir(path.dirname(plan.installDir), { recursive: true });
  const stage = await mkdtemp(`${plan.installDir}-install-`);
  try {
    for (const asset of plan.assets) {
      const bytes = await downloadVerified(asset, fetchImpl);
      extractChecked(bytes, path.join(stage, asset.destination));
    }
    await writeFile(path.join(stage, "version.json"), JSON.stringify(VERSION));
    // Match upstream executable permissions without invoking its installer or geolocation code.
    await inspectTree(stage, plan.platform !== "win32");
    await validateInstallation(stage, plan);
    if (await exists(plan.installDir)) throw new Error("Camoufox cache appeared during installation; leaving it unchanged");
    await rename(stage, plan.installDir);
    return { reused: false, installDir: plan.installDir };
  } finally {
    // This directory belongs only to this invocation; never remove the user's existing cache.
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error("install-camoufox accepts no asset or version overrides");
    const result = await installCamoufox();
    console.log(`${result.reused ? "Verified existing" : "Installed"} Camoufox ${RELEASE} and uBlock Origin 1.73.0 without GeoIP`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
