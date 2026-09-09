// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { assertCamoufoxAssetsPresent } from "./camoufoxAssets";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(platform: "lin" | "mac" | "win" = "lin") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ovd-cache-guard-")); roots.push(root);
  const resources = platform === "mac" ? path.join(root, "Camoufox.app/Contents/Resources") : root;
  const executable = platform === "mac" ? path.join(root, "Camoufox.app/Contents/MacOS/camoufox") : path.join(root, platform === "win" ? "camoufox.exe" : "camoufox-bin");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.join(resources, "addons/UBO"), { recursive: true });
  fs.writeFileSync(executable, "synthetic", { mode: 0o755 });
  fs.writeFileSync(path.join(root, "version.json"), JSON.stringify({version:"152.0.4",release:"beta.28"}));
  fs.writeFileSync(path.join(resources, "properties.json"), "[]");
  fs.writeFileSync(path.join(resources, "addons/UBO/manifest.json"), JSON.stringify({version:"1.73.0"}));
  return {root,resources,executable,platform};
}
it.each(["lin","mac","win"] as const)("accepts existing pinned %s assets without writes", (platform) => {
  const f=fixture(platform); const writes=vi.spyOn(fs,"writeFileSync");
  expect(()=>assertCamoufoxAssetsPresent(f.root,platform)).not.toThrow();
  expect(writes).not.toHaveBeenCalled();
});
it.each(["missing-addon","wrong-version","symlink-file","symlink-directory","missing-browser","invalid-json","not-executable"])("rejects %s with a fixed safe error", (mode) => {
  const f=fixture();
  if(mode==="missing-addon") fs.rmSync(path.join(f.resources,"addons/UBO"),{recursive:true});
  if(mode==="wrong-version") fs.writeFileSync(path.join(f.root,"version.json"),'{"version":"old","release":"old"}');
  if(mode==="missing-browser") fs.unlinkSync(f.executable);
  if(mode==="invalid-json") fs.writeFileSync(path.join(f.root,"version.json"),'private invalid content');
  if(mode==="not-executable") fs.chmodSync(f.executable,0o600);
  if(mode==="symlink-file") { fs.unlinkSync(f.executable); fs.symlinkSync(path.join(f.root,"version.json"),f.executable); }
  if(mode==="symlink-directory") { fs.renameSync(path.join(f.resources,"addons/UBO"),path.join(f.resources,"saved")); fs.symlinkSync(path.join(f.resources,"saved"),path.join(f.resources,"addons/UBO")); }
  expect(()=>assertCamoufoxAssetsPresent(f.root,f.platform)).toThrow("Camoufox pinned assets are unavailable or invalid; run the reviewed installer before launch.");
});
