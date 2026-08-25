import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  OVD417_BASELINE_LEDGER_FINGERPRINT,
  OVD417_LEDGER_STATES,
  OVD417_MIGRATION_HASHES,
  OVD417_MIGRATION_VERSIONS,
  OVD417_SOURCE_SHA,
} from "./verify-ovd417-applied-prefix.mjs";
import {
  readRegularJsonEvidence,
  verifyOvd418ReleaseState,
} from "./verify-ovd418-release-state.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(process.cwd(), "scripts/verify-ovd418-release-state.mjs");
const runnerPath = path.resolve(process.cwd(), "scripts/run-ovd418-production-release.sh");

function ledger(packageVersions = []) {
  const state = OVD417_LEDGER_STATES[packageVersions.length];
  return {
    sourceSha: OVD417_SOURCE_SHA,
    migrationHashes: OVD417_MIGRATION_HASHES,
    baselineCount: 100,
    baselineHead: "20260817054500",
    baselineFingerprint: OVD417_BASELINE_LEDGER_FINGERPRINT,
    packageVersions,
    unexpectedVersionCount: 0,
    ledgerCount: state.count,
    ledgerHead: state.head,
    ledgerFingerprint: state.fingerprint,
  };
}

describe("OVD-418 qualified release-state verifier", () => {
  it.each([
    ["baseline", ledger(), "baseline"],
    ["partial-one", ledger(OVD417_MIGRATION_VERSIONS.slice(0, 1)), "prefix"],
    ["final", ledger(OVD417_MIGRATION_VERSIONS), "final"],
  ])("admits exact %s evidence", (requiredState, evidence, kind) => {
    expect(verifyOvd418ReleaseState(evidence, requiredState)).toEqual({ ok: true, kind });
  });

  it.each([
    ["partial-two", ledger(OVD417_MIGRATION_VERSIONS.slice(0, 2))],
    ["partial-three", ledger(OVD417_MIGRATION_VERSIONS.slice(0, 3))],
  ])("rejects %s even when a partial checkpoint is requested", (label, evidence) => {
    const result = verifyOvd418ReleaseState(evidence, "partial-one");
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain(label);
    expect(result.violations.join(" ")).toContain("promotion remains blocked; incident review required");
  });

  it.each([
    ["duplicate versions", ledger([OVD417_MIGRATION_VERSIONS[0], OVD417_MIGRATION_VERSIONS[0]])],
    ["extra version", { ...ledger(OVD417_MIGRATION_VERSIONS), unexpectedVersionCount: 1 }],
    ["ledger drift", { ...ledger(), ledgerFingerprint: "f".repeat(32) }],
  ])("fails closed for %s", (_label, evidence) => {
    const result = verifyOvd418ReleaseState(evidence, "baseline");
    expect(result.ok).toBe(false);
    expect(result.violations.join(" ")).toContain("promotion remains blocked; incident review required");
  });

  it("rejects an unknown required state", () => {
    expect(verifyOvd418ReleaseState(ledger(), "recoverable")).toEqual({
      ok: false,
      violations: [
        "OVD-418 promotion remains blocked; incident review required: unknown required state: recoverable",
      ],
    });
  });

  it("reads only regular, well-formed local JSON evidence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ovd418-release-state-"));
    try {
      const validPath = path.join(directory, "ledger.json");
      const malformedPath = path.join(directory, "malformed.json");
      const folderPath = path.join(directory, "not-a-file");
      const linkPath = path.join(directory, "ledger-link.json");
      await writeFile(validPath, JSON.stringify(ledger()));
      await writeFile(malformedPath, "{");
      await mkdir(folderPath);
      await symlink(validPath, linkPath);

      await expect(readRegularJsonEvidence(validPath)).resolves.toEqual(ledger());
      await expect(readRegularJsonEvidence(malformedPath)).rejects.toThrow(SyntaxError);
      await expect(readRegularJsonEvidence(folderPath)).rejects.toThrow("local regular file");
      await expect(readRegularJsonEvidence(linkPath)).rejects.toThrow("local regular file");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails the CLI for malformed local evidence without invoking a provider or database", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "ovd418-release-state-cli-"));
    try {
      const malformedPath = path.join(directory, "malformed.json");
      await writeFile(malformedPath, "{");
      await expect(execFileAsync(process.execPath, [scriptPath, "--ledger-json", malformedPath, "--require-state", "baseline"]))
        .rejects.toMatchObject({ stderr: expect.stringContaining("OVD-418 release-state verification stopped") });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("OVD-418 production runner static safety contract", () => {
  it("admits only explicit database URLs and contains one guarded write path", async () => {
    const runner = await readFile(runnerPath, "utf8");
    const pushLines = runner.split("\n").filter((line) => line.includes("supabase db push"));
    expect(pushLines).toHaveLength(3);
    expect(pushLines.every((line) => line.includes("--db-url"))).toBe(true);
    expect(pushLines.filter((line) => !line.includes("--dry-run"))).toHaveLength(1);
    for (const forbidden of ["--linked", "--include-seed", "migration repair", "db reset", "PGPASSWORD", "gcloud", "curl"]) {
      expect(runner).not.toContain(forbidden);
    }
  });

  it("verifies authorization before dispatch and enforces read-only audits", async () => {
    const runner = await readFile(runnerPath, "utf8");
    const dispatch = runner.lastIndexOf("case \"$OVD418_PHASE\"");
    expect(runner.lastIndexOf("authorization_preflight", dispatch)).toBeLessThan(dispatch);
    expect(runner.lastIndexOf("prepare_authorization_usage", dispatch)).toBeLessThan(dispatch);
    expect(runner).toContain("default_transaction_read_only=on");
    expect(runner).toContain("single-use authorization marker");
    expect(runner).toContain("must be outside the repository and linked main worktree");
    expect(runner).toContain("the two exact dry-runs were not byte-identical");
    expect(runner).toContain("for state in baseline partial-one final");
    expect(runner).toContain("compare_offer_aggregates");
    expect(runner).toContain("next_attempt_directory");
    expect(runner).toContain("trap 'exit 130' INT");
    expect(runner).toContain("trap 'exit 143' TERM");
    expect(runner).toContain("could not release the production lock container");
    expect(runner).toContain("could not confirm temporary credential revocation");
  });
});
