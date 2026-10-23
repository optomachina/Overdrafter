// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertOutsideRepository,
  checkoutRoots,
  readVendorLoginConfig,
  REPOSITORY_ROOT,
  resolveLogPath,
  resolveStateDir,
} from "./vendorLoginConfig";

let dir: string;
let fakeRepo: string;

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ovd-vendor-login-config-")));
  fakeRepo = path.join(dir, "repo");
  await fs.mkdir(fakeRepo);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeConfig(content: unknown, mode = 0o600, name = "vendor-login.json"): Promise<string> {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, typeof content === "string" ? content : JSON.stringify(content), { mode });
  await fs.chmod(filePath, mode);
  return filePath;
}

const validConfig = { vendors: { quickparts: { item: "fixture-item" } } };

describe("vendor login config", () => {
  it("resolves the repository root of this checkout", async () => {
    await expect(fs.stat(path.join(REPOSITORY_ROOT, "worker", "package.json"))).resolves.toBeTruthy();
  });

  it("reads an owner-only config and applies safe defaults", async () => {
    const config = await readVendorLoginConfig({ path: await writeConfig(validConfig), repositoryRoot: fakeRepo });
    expect(config).toEqual({
      headless: true,
      bitwarden: { cliPath: "bw", unlock: "session-env" },
      vendors: { quickparts: { item: "fixture-item" } },
    });
  });

  it("refuses group or world permission bits, symlinks, and files inside the checkout", async () => {
    await expect(readVendorLoginConfig({ path: await writeConfig(validConfig, 0o644), repositoryRoot: fakeRepo }))
      .rejects.toThrow(/owner-only/);

    const target = await writeConfig(validConfig, 0o600, "target.json");
    const link = path.join(dir, "link.json");
    await fs.symlink(target, link);
    await expect(readVendorLoginConfig({ path: link, repositoryRoot: fakeRepo })).rejects.toThrow(/not a symlink/);

    const inside = path.join(fakeRepo, "vendor-login.json");
    await fs.writeFile(inside, JSON.stringify(validConfig), { mode: 0o600 });
    await expect(readVendorLoginConfig({ path: inside, repositoryRoot: fakeRepo })).rejects.toThrow(/outside the repository/);
  });

  it("uses OVD_VENDOR_LOGIN_CONFIG when no path is given", async () => {
    const filePath = await writeConfig(validConfig);
    const config = await readVendorLoginConfig({ env: { OVD_VENDOR_LOGIN_CONFIG: filePath }, repositoryRoot: fakeRepo });
    expect(config.vendors.quickparts?.item).toBe("fixture-item");
  });

  it("rejects unknown keys, a password field, and keychain unlock without a service", async () => {
    const cases = [
      { vendors: { quickparts: { item: "x", password: "fixture-password-SENTINEL" } } },
      { ...validConfig, unexpected: true },
      { ...validConfig, bitwarden: { unlock: "keychain" } },
      { vendors: { quickparts: { item: "" } } },
      "not json",
    ];
    for (const content of cases) {
      const failure = await readVendorLoginConfig({ path: await writeConfig(content), repositoryRoot: fakeRepo })
        .catch((error: unknown) => error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).not.toContain("fixture-password-SENTINEL");
    }
  });

  it("resolves the session directory from the flag, then the environment, then the config", () => {
    const config = { stateDir: "/from/config" };
    expect(resolveStateDir({ flag: "/from/flag", env: { QUOTE_VENDOR_STORAGE_STATE_DIR: "/from/env" }, config })).toBe("/from/flag");
    expect(resolveStateDir({ flag: null, env: { QUOTE_VENDOR_STORAGE_STATE_DIR: "/from/env" }, config })).toBe("/from/env");
    expect(resolveStateDir({ flag: null, env: {}, config })).toBe("/from/config");
    expect(resolveStateDir({ flag: null, env: {}, config: { stateDir: "~/state" } })).toBe(path.join(os.homedir(), "state"));
    expect(() => resolveStateDir({ flag: null, env: {}, config: null })).toThrow(/No session directory/);
  });

  it("resolves a symlinked parent before deciding a path is outside the checkout", async () => {
    const linkedDir = path.join(dir, "looks-outside");
    await fs.symlink(fakeRepo, linkedDir);
    const inside = path.join(linkedDir, "vendor-login.json");
    await fs.writeFile(inside, JSON.stringify(validConfig), { mode: 0o600 });
    await expect(readVendorLoginConfig({ path: inside, repositoryRoot: fakeRepo })).rejects.toThrow(/outside the repository/);
    expect(() => resolveLogPath({ logFile: path.join(linkedDir, "logs", "new.log") }, fakeRepo)).toThrow(/outside the repository/);
  });

  it("treats the main checkout of a linked worktree as part of the repository", async () => {
    const main = path.join(dir, "main");
    const worktree = path.join(main, ".claude", "worktrees", "wt");
    await fs.mkdir(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    await fs.mkdir(worktree, { recursive: true });
    await fs.writeFile(path.join(worktree, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
    expect(checkoutRoots(worktree)).toEqual([worktree, main]);
    expect(() => assertOutsideRepository(path.join(main, "worker", "x.json"), "thing", worktree)).toThrow();
    expect(() => assertOutsideRepository(path.join(dir, "elsewhere", "x.json"), "thing", worktree)).not.toThrow();
  });

  it("keeps the status log outside the checkout", () => {
    expect(resolveLogPath({ logFile: path.join(dir, "logs", "login.log") }, fakeRepo)).toBe(path.join(dir, "logs", "login.log"));
    expect(() => resolveLogPath({ logFile: path.join(fakeRepo, "login.log") }, fakeRepo)).toThrow(/outside the repository/);
    expect(() => assertOutsideRepository(fakeRepo, "thing", fakeRepo)).toThrow();
    expect(() => assertOutsideRepository(`${fakeRepo}-sibling/file`, "thing", fakeRepo)).not.toThrow();
  });
});
