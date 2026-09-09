// @vitest-environment node

import fs, { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
import { launchOptions } from "camoufox-js";
import { generateFingerprint, fromBrowserforge } from "camoufox-js/dist/fingerprints.js";
import { Impit } from "impit";
import maxmind from "maxmind";
import { INSTALL_DIR, OS_NAME, getPath } from "camoufox-js/dist/pkgman.js";

const { launchPersistentMock } = vi.hoisted(() => ({
  launchPersistentMock: vi.fn(),
}));

vi.mock("playwright", () => ({
  firefox: { launchPersistentContext: launchPersistentMock },
}));

import { launchPersistentCamoufox } from "./camoufoxPersistentContext";

let assetsDir: string | undefined;
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  if (assetsDir) rmSync(assetsDir, { recursive: true, force: true });
});

it("prepares real Camoufox options without GeoIP lookup or download and preserves saved identity", async () => {
  // Exercise the installed library, with synthetic browser resources only.
  const require = createRequire(import.meta.url);
  expect(require("camoufox-js/package.json").version).toBe("0.10.2");
  const forbiddenNetwork = vi.fn(() => {
    throw new Error("Network is forbidden in this offline launch test");
  });
  vi.stubGlobal("fetch", forbiddenNetwork);
  // publicIP uses native Impit instead of global fetch; guard both paths.
  const publicIpNetwork = vi.spyOn(Impit.prototype, "fetch").mockImplementation(forbiddenNetwork);
  const databaseRead = vi.spyOn(maxmind, "open").mockImplementation(async () => {
    throw new Error("GeoIP database access is forbidden");
  });

  const identity = {
    "navigator.userAgent": "Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0",
    timezone: "America/Phoenix",
    "locale:language": "en",
    "locale:region": "US",
    "geolocation:latitude": 32.2,
    "geolocation:longitude": -110.9,
    "geolocation:accuracy": 50,
    fonts: ["Saved Font"],
    "canvas:aaOffset": 17,
  };
  const savedBytes = JSON.stringify(identity);
  const fingerprint = generateFingerprint([1366, 900], { operatingSystems: ["linux"] });
  // Properties metadata is a browser asset. Build a synthetic schema covering
  // the real fingerprint and library-added fields, without reading any cache.
  const propertyValues = {
    ...fromBrowserforge(fingerprint, "135"),
    ...identity,
    "window.history.length": 1,
    "fonts:spacing_seed": 1,
    humanize: true,
    "canvas:aaCapOffset": true,
  };
  const properties = Object.entries(propertyValues).map(([property, value]) => {
    let type = "str";
    if (Array.isArray(value)) type = "array";
    else if (typeof value === "number") type = "double";
    else if (typeof value === "boolean") type = "bool";
    else if (typeof value === "object") type = "dict";
    return { property, type };
  });
  assetsDir = mkdtempSync(join(tmpdir(), "camoufox-no-geoip-"));
  writeFileSync(join(assetsDir, "properties.json"), JSON.stringify(properties));
  // Redirect every cache access to synthetic pinned assets; no real cache read.
  const resources = OS_NAME === "mac" ? "Camoufox.app/Contents/Resources" : "";
  let executable = "camoufox-bin";
  if (OS_NAME === "mac") executable = "Camoufox.app/Contents/MacOS/camoufox";
  else if (OS_NAME === "win") executable = "camoufox.exe";
  fs.mkdirSync(join(assetsDir, resources, "addons/UBO"), { recursive: true });
  fs.mkdirSync(join(assetsDir, executable, ".."), { recursive: true });
  writeFileSync(join(assetsDir, executable), "synthetic", { mode: 0o755 });
  writeFileSync(join(assetsDir, "version.json"), JSON.stringify({ version: "152.0.4", release: "beta.28" }));
  writeFileSync(join(assetsDir, resources, "properties.json"), JSON.stringify(properties));
  writeFileSync(join(assetsDir, resources, "addons/UBO/manifest.json"), '{"version":"1.73.0"}');
  const redirect = (file: unknown) => {
    const value = String(file);
    if (value === String(INSTALL_DIR)) return assetsDir!;
    if (value.startsWith(String(INSTALL_DIR) + "/")) return join(assetsDir!, value.slice(String(INSTALL_DIR).length + 1));
    return file;
  };
  for (const method of ["existsSync", "readFileSync", "readdirSync", "lstatSync", "statSync"] as const) {
    const original = fs[method];
    vi.spyOn(fs, method).mockImplementation(((file: unknown, ...args: unknown[]) =>
      Reflect.apply(original, fs, [redirect(file), ...args])) as never);
  }
  syncBuiltinESMExports();
  // Exercise the resource stub even on macOS, where launchOptions skips it.
  expect(getPath("fontconfig/lin")).toContain("fontconfig");
  const close = vi.fn().mockResolvedValue(undefined);
  launchPersistentMock.mockResolvedValue({ close });

  const result = await launchPersistentCamoufox({
    userDataDir: join(assetsDir, "synthetic-profile"),
    headless: false,
    identityConfig: identity,
    launchOverrides: {
      geoip: true,
      executable_path: join(assetsDir, "synthetic-camoufox"),
      ff_version: "135",
      exclude_addons: ["UBO"],
      block_webgl: true,
      fingerprint,
      i_know_what_im_doing: true,
      env: {},
    },
  });

  expect(JSON.stringify(identity)).toBe(savedBytes);
  expect(JSON.stringify(result.identityConfig)).toBe(savedBytes);
  expect(launchPersistentMock).toHaveBeenCalledOnce();
  const options = launchPersistentMock.mock.calls[0][1];
  expect(options.env.CAMOU_CONFIG_1).toBe(savedBytes);
  expect(options.executablePath).toBe(join(assetsDir, "synthetic-camoufox"));
  expect(publicIpNetwork).not.toHaveBeenCalled();
  expect(databaseRead).not.toHaveBeenCalled();
  expect(forbiddenNetwork).not.toHaveBeenCalled();
  await result.context.close();
  expect(close).toHaveBeenCalledOnce();

  // Negative control: enabling GeoIP directly in the real dependency must hit
  // our blocked Impit boundary, proving the zero-call assertions are meaningful.
  await expect(launchOptions({
    config: structuredClone(identity),
    geoip: true,
    ff_version: "135",
    exclude_addons: ["UBO"],
    fingerprint,
    i_know_what_im_doing: true,
  })).rejects.toThrow("Failed to get a public proxy IP address");
  expect(publicIpNetwork).toHaveBeenCalled();
  expect(databaseRead).not.toHaveBeenCalled();
  expect(forbiddenNetwork).toHaveBeenCalled();
});
