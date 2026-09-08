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
import { INSTALL_DIR, getPath } from "camoufox-js/dist/pkgman.js";

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
  // Linux also resolves fontconfig through the library's installed-resource
  // cache. Supply only synthetic version metadata at that boundary on all OSes.
  // Never read or write the user's actual browser cache.
  const existsSync = fs.existsSync;
  const readFileSync = fs.readFileSync;
  const readdirSync = fs.readdirSync;
  vi.spyOn(fs, "existsSync").mockImplementation((path) => {
    if (String(path) === INSTALL_DIR || String(path) === join(INSTALL_DIR, "version.json")) return true;
    return existsSync(path);
  });
  vi.spyOn(fs, "readdirSync").mockImplementation(((path, options) => {
    if (String(path) === INSTALL_DIR) return ["version.json"];
    return readdirSync(path, options);
  }) as typeof fs.readdirSync);
  vi.spyOn(fs, "readFileSync").mockImplementation((path, options) => {
    if (String(path) === join(INSTALL_DIR, "version.json")) {
      return JSON.stringify({ version: "135.0.1", release: "beta.24" });
    }
    return readFileSync(path, options);
  });
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
