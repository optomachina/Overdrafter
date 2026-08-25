import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  OVD417_MIGRATION_HASHES, OVD417_SOURCE_SHA, OVD418_PRODUCTION_CONTINUITY,
  OVD418_PRODUCTION_LEDGER_STATES, OVD418_SUFFIX_STATEMENT_HASHES,
} from "./ovd418-production-ledger-contract.mjs";
import {
  parseArguments, readPrivateAuthorizationFile, sha256, validateAuthorization,
  verifyProductionAuthorization,
} from "./verify-ovd418-production-authorization.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(process.cwd(), "scripts/verify-ovd418-production-authorization.mjs");
const expectedHead = "267a7d3d655a1d83ac4b6366a4052c5254fb3989";
const filenames = ["20260817133902_add_quote_provider_admission_registry.sql", "20260821223849_add_emachineshop_manual_vendor.sql", "20260821223851_configure_emachineshop_manual_vendor.sql", "20260822213330_add_vendor_quote_offer_geographic_origin.sql"];

function authorization() {
  return {
    schemaVersion: 2, issue: "OVD-418", repository: "optomachina/Overdrafter",
    projectRef: "ozuatdcakezjtevztjlr", deployCommit: expectedHead,
    sourceCommit: OVD417_SOURCE_SHA, supabaseCliVersion: "2.78.1",
    productionLedger: {
      continuity: {
        ovd373Prefix: { ...OVD418_PRODUCTION_CONTINUITY.ovd373Prefix },
        ovd373OriginalSubset: { ...OVD418_PRODUCTION_CONTINUITY.ovd373OriginalSubset },
        row100: { ...OVD418_PRODUCTION_CONTINUITY.row100 },
      },
      states: ["baseline", "partial-one", "partial-two", "partial-three", "final"].map((name, index) => ({ name, packagePrefixLength: index, ...OVD418_PRODUCTION_LEDGER_STATES[index] })),
    },
    migrations: OVD417_MIGRATION_HASHES.map((migration, index) => ({ ...migration, filename: filenames[index], statementHash: OVD418_SUFFIX_STATEMENT_HASHES[index].statementHash })),
    commands: { preaudit: "bash scripts/run-ovd418-production-release.sh preaudit", apply: "bash scripts/run-ovd418-production-release.sh apply", postaudit: "bash scripts/run-ovd418-production-release.sh postaudit" },
    recovery: { baseline: "apply", partialOne: "resume", final: "postaudit", other: "incident-review" },
    evidenceBoundary: { customerRows: "private-backup-only", customerIdentifiers: "private-backup-only", secrets: "private-only", aggregateCounts: "private-only" }, singleUse: true,
  };
}

async function writePrivateJson(directory, value, mode = 0o600) {
  const file = path.join(directory, "authorization.json");
  await writeFile(file, JSON.stringify(value));
  await chmod(file, mode);
  return file;
}

describe("OVD-418 production authorization v2 verifier", () => {
  it("accepts the complete exact v2 authorization envelope", () => {
    expect(validateAuthorization(authorization(), expectedHead)).toEqual([]);
  });

  it.each([
    ["v1 authorization", (value) => { value.schemaVersion = 1; value.baseline = { count: 100 }; }],
    ["continuity", (value) => { value.productionLedger.continuity.ovd373Prefix.count += 1; }],
    ["named ledger state", (value) => { value.productionLedger.states[2].fingerprint = "0".repeat(32); }],
    ["state ordering", (value) => { [value.productionLedger.states[1], value.productionLedger.states[2]] = [value.productionLedger.states[2], value.productionLedger.states[1]]; }],
    ["local lineage", (value) => { value.productionLedger.states[0].fingerprint = "5dabebda8a0fc1a3cf697e00de64418b"; }],
    ["migration statement hash", (value) => { value.migrations[0].statementHash = "0".repeat(32); }],
    ["migration ordering", (value) => { [value.migrations[0], value.migrations[1]] = [value.migrations[1], value.migrations[0]]; }],
    ["identity", (value) => { value.issue = "OVD-419"; }],
    ["single-use requirement", (value) => { value.singleUse = false; }],
  ])("rejects %s drift", (_label, mutate) => {
    const value = authorization(); mutate(value);
    expect(validateAuthorization(value, expectedHead)).not.toEqual([]);
  });

  it.each([
    ["top-level", (value) => { value.unapprovedScope = true; }],
    ["production ledger", (value) => { value.productionLedger.extra = true; }],
    ["continuity", (value) => { value.productionLedger.continuity.row100.extra = true; }],
    ["state", (value) => { value.productionLedger.states[0].extra = true; }],
    ["migration", (value) => { value.migrations[0].extra = true; }],
  ])("rejects an extra %s key", (_label, mutate) => {
    const value = authorization(); mutate(value);
    expect(validateAuthorization(value, expectedHead)).not.toEqual([]);
  });

  it("rejects unknown, duplicate, relative, and malformed CLI inputs", () => {
    expect(() => parseArguments([])).toThrow("Usage:");
    expect(() => parseArguments(["--authorization-file", "relative.json", "--expected-sha256", "0".repeat(64), "--expected-head", expectedHead])).toThrow("absolute");
    expect(() => parseArguments(["--authorization-file", "/tmp/a", "--expected-sha256", "0".repeat(64), "--expected-head", expectedHead, "--expected-head", expectedHead])).toThrow("duplicate");
  });

  it("hashes exact bytes and verifies a private v2 authorization", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ovd418-auth-v2-"));
    try {
      const file = await writePrivateJson(directory, authorization());
      const bytes = await readPrivateAuthorizationFile(file);
      await expect(verifyProductionAuthorization({ authorizationFile: file, expectedSha256: sha256(bytes), expectedHead })).resolves.toEqual(authorization());
      await expect(verifyProductionAuthorization({ authorizationFile: file, expectedSha256: "0".repeat(64), expectedHead })).rejects.toThrow("SHA-256");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("rejects unsafe files: loose mode, symlink, directory, and repository location", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ovd418-auth-v2-security-"));
    const repositoryFile = path.resolve(process.cwd(), "scripts/.ovd418-authorization-test.json");
    try {
      const file = await writePrivateJson(directory, authorization());
      const link = path.join(directory, "authorization-link.json"); const folder = path.join(directory, "folder");
      await symlink(file, link); await mkdir(folder);
      await expect(readPrivateAuthorizationFile(link)).rejects.toThrow("non-symlink");
      await expect(readPrivateAuthorizationFile(folder)).rejects.toThrow("regular non-symlink");
      await chmod(file, 0o640); await expect(readPrivateAuthorizationFile(file)).rejects.toThrow("0600");
      await writeFile(repositoryFile, JSON.stringify(authorization()), { mode: 0o600 }); await chmod(repositoryFile, 0o600);
      await expect(readPrivateAuthorizationFile(repositoryFile)).rejects.toThrow("outside the repository");
    } finally { await rm(repositoryFile, { force: true }); await rm(directory, { recursive: true, force: true }); }
  });

  it("fails closed in the CLI before any provider or database operation", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ovd418-auth-v2-cli-"));
    try {
      const file = await writePrivateJson(directory, authorization()); const bytes = await readPrivateAuthorizationFile(file);
      await expect(execFileAsync(process.execPath, [scriptPath, "--authorization-file", file, "--expected-sha256", sha256(bytes), "--expected-head", "0".repeat(40)])).rejects.toMatchObject({ stderr: expect.stringContaining("verification stopped") });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
