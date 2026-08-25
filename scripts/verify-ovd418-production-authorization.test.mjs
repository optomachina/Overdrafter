import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  parseArguments,
  readPrivateAuthorizationFile,
  sha256,
  validateAuthorization,
  verifyProductionAuthorization,
} from "./verify-ovd418-production-authorization.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(process.cwd(), "scripts/verify-ovd418-production-authorization.mjs");
const expectedHead = "267a7d3d655a1d83ac4b6366a4052c5254fb3989";

function authorization() {
  return {
    schemaVersion: 1,
    issue: "OVD-418",
    repository: "optomachina/Overdrafter",
    projectRef: "ozuatdcakezjtevztjlr",
    deployCommit: expectedHead,
    sourceCommit: "5c3b6864e63ada75561f4ff7019bde70962d6e39",
    supabaseCliVersion: "2.78.1",
    baseline: { count: 100, head: "20260817054500", fingerprint: "5dabebda8a0fc1a3cf697e00de64418b" },
    final: { count: 104, head: "20260822213330", fingerprint: "6dd6911df342f253a303e837d8881f7a" },
    migrations: [
      { version: "20260817133902", filename: "20260817133902_add_quote_provider_admission_registry.sql", sha256: "331ee2d9282142ab7134f179a9b7d8b93ce64027ad6d909c0a183a2874a64d2b" },
      { version: "20260821223849", filename: "20260821223849_add_emachineshop_manual_vendor.sql", sha256: "0e2981089cf0a0d32de2c5a147cc59603269e27be37eb59a4574e677a4aae0f0" },
      { version: "20260821223851", filename: "20260821223851_configure_emachineshop_manual_vendor.sql", sha256: "18130f708bff981e7eb8ce5100baa0031ed89904c89918f47a9cc6ce94c8ec09" },
      { version: "20260822213330", filename: "20260822213330_add_vendor_quote_offer_geographic_origin.sql", sha256: "65acdfaff16524eda49f15544989662b52c9dba44e4fd18ba538ca2052d1dc86" },
    ],
    commands: { preaudit: "bash scripts/run-ovd418-production-release.sh preaudit", apply: "bash scripts/run-ovd418-production-release.sh apply", postaudit: "bash scripts/run-ovd418-production-release.sh postaudit" },
    recovery: { baseline: "apply", partialOne: "resume", final: "postaudit", other: "incident-review" },
    evidenceBoundary: { customerRows: "private-backup-only", customerIdentifiers: "private-backup-only", secrets: "private-only", aggregateCounts: "private-only" },
    singleUse: true,
  };
}

async function writePrivateJson(directory, value, mode = 0o600) {
  const file = path.join(directory, "authorization.json");
  await writeFile(file, JSON.stringify(value));
  await chmod(file, mode);
  return file;
}

describe("OVD-418 production authorization verifier", () => {
  it("accepts the complete exact authorization envelope", () => {
    expect(validateAuthorization(authorization(), expectedHead)).toEqual([]);
  });

  it.each([
    ["identity", (value) => { value.issue = "OVD-419"; }],
    ["expected deployment head", (value) => { value.deployCommit = "A".repeat(40); }],
    ["source commit", (value) => { value.sourceCommit = "0".repeat(40); }],
    ["baseline", (value) => { value.baseline.count += 1; }],
    ["final", (value) => { value.final.fingerprint = "0".repeat(32); }],
    ["ordered migration package", (value) => { [value.migrations[0], value.migrations[1]] = [value.migrations[1], value.migrations[0]]; }],
    ["commands", (value) => { value.commands.apply = "bash anything-else.sh"; }],
    ["recovery", (value) => { value.recovery.partialOne = "apply"; }],
    ["private evidence boundary", (value) => { value.evidenceBoundary.customerRows = "allowed"; }],
    ["single-use requirement", (value) => { value.singleUse = false; }],
  ])("rejects %s drift", (_label, mutate) => {
    const value = authorization();
    mutate(value);
    expect(validateAuthorization(value, expectedHead)).not.toEqual([]);
  });

  it.each([
    ["top-level", (value) => { value.unapprovedScope = true; }],
    ["ledger", (value) => { value.baseline.extra = true; }],
    ["migration", (value) => { value.migrations[0].extra = true; }],
    ["commands", (value) => { value.commands.extra = "bash extra.sh"; }],
    ["recovery", (value) => { value.recovery.extra = "apply"; }],
    ["evidence boundary", (value) => { value.evidenceBoundary.extra = "private-only"; }],
  ])("rejects an extra %s key", (_label, mutate) => {
    const value = authorization();
    mutate(value);
    expect(validateAuthorization(value, expectedHead)).not.toEqual([]);
  });

  it("rejects unknown, duplicate, relative, and malformed CLI inputs", () => {
    expect(() => parseArguments([])).toThrow("Usage:");
    expect(() => parseArguments(["--authorization-file", "relative.json", "--expected-sha256", "0".repeat(64), "--expected-head", expectedHead])).toThrow("absolute");
    expect(() => parseArguments(["--authorization-file", "/tmp/a", "--expected-sha256", "0".repeat(64), "--expected-head", expectedHead, "--expected-head", expectedHead])).toThrow("duplicate");
    expect(() => parseArguments(["--unknown", "x"])).toThrow("Unknown");
  });

  it("hashes exact bytes and verifies a private authorization without external commands", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ovd418-auth-"));
    try {
      const file = await writePrivateJson(directory, authorization());
      const bytes = await readPrivateAuthorizationFile(file);
      await expect(verifyProductionAuthorization({ authorizationFile: file, expectedSha256: sha256(bytes), expectedHead })).resolves.toEqual(authorization());
      await expect(verifyProductionAuthorization({ authorizationFile: file, expectedSha256: "0".repeat(64), expectedHead })).rejects.toThrow("SHA-256");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unsafe files: loose mode, symlink, directory, and repository location", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ovd418-auth-security-"));
    const repositoryFile = path.resolve(process.cwd(), "scripts/.ovd418-authorization-test.json");
    try {
      const file = await writePrivateJson(directory, authorization());
      const link = path.join(directory, "authorization-link.json");
      const folder = path.join(directory, "folder");
      await symlink(file, link);
      await mkdir(folder);
      await expect(readPrivateAuthorizationFile(link)).rejects.toThrow("non-symlink");
      await expect(readPrivateAuthorizationFile(folder)).rejects.toThrow("regular non-symlink");
      await chmod(file, 0o640);
      await expect(readPrivateAuthorizationFile(file)).rejects.toThrow("0600");
      await writeFile(repositoryFile, JSON.stringify(authorization()), { mode: 0o600 });
      await chmod(repositoryFile, 0o600);
      await expect(readPrivateAuthorizationFile(repositoryFile)).rejects.toThrow("outside the repository");
    } finally {
      await rm(repositoryFile, { force: true });
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed in the CLI before any provider or database operation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ovd418-auth-cli-"));
    try {
      const file = await writePrivateJson(directory, authorization());
      const bytes = await readPrivateAuthorizationFile(file);
      await expect(execFileAsync(process.execPath, [scriptPath, "--authorization-file", file, "--expected-sha256", sha256(bytes), "--expected-head", "0".repeat(40)]))
        .rejects.toMatchObject({ stderr: expect.stringContaining("verification stopped") });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
