import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  OVD417_MIGRATION_HASHES,
  OVD417_MIGRATION_VERSIONS,
  OVD417_SOURCE_SHA,
  OVD418_PRODUCTION_CONTINUITY,
  OVD418_PRODUCTION_LEDGER_STATES,
  OVD418_SUFFIX_STATEMENT_HASHES,
} from "./ovd418-production-ledger-contract.mjs";
import {
  readRegularJsonEvidence,
  verifyOvd418ReleaseState,
} from "./verify-ovd418-release-state.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = path.resolve(process.cwd(), "scripts/verify-ovd418-release-state.mjs");
const runnerPath = path.resolve(process.cwd(), "scripts/run-ovd418-production-release.sh");
const capturePath = path.resolve(process.cwd(), "scripts/capture-ovd418-production-ledger.sql");
const preconditionsPath = path.resolve(process.cwd(), "scripts/verify-ovd418-production-preconditions.sql");
const postconditionsPath = path.resolve(process.cwd(), "scripts/verify-ovd418-production-postconditions.sql");

function ledger(packageVersions = []) {
  const state = OVD418_PRODUCTION_LEDGER_STATES[packageVersions.length];
  return {
    sourceSha: OVD417_SOURCE_SHA,
    migrationHashes: OVD417_MIGRATION_HASHES,
    productionContinuity: OVD418_PRODUCTION_CONTINUITY,
    baselineCount: 100,
    baselineHead: "20260817054500",
    baselineFingerprint: OVD418_PRODUCTION_LEDGER_STATES[0].fingerprint,
    packageVersions,
    packageStatementHashes: OVD418_SUFFIX_STATEMENT_HASHES.slice(0, packageVersions.length),
    unexpectedVersionCount: 0,
    ledgerCount: state.count,
    ledgerHead: state.head,
    ledgerFingerprint: state.fingerprint,
  };
}

function expectBlocked(result) {
  expect(result.ok).toBe(false);
  expect(result.violations.join(" ")).toContain("promotion remains blocked; incident review required");
}

function capturedJsonFixture(packageVersions = [], { preconditions = false } = {}) {
  const evidence = ledger(packageVersions);
  if (preconditions) {
    Object.assign(evidence, {
      active_quote_request_count: 0,
      active_quote_run_count: 0,
      active_vendor_quote_result_count: 0,
      active_work_queue_count: 0,
      enabled_rollout_control_count: 0,
      rollout_control_count: 4,
      total_vendor_quote_offers: 0,
    });
  }
  return JSON.parse(JSON.stringify(evidence));
}

describe("OVD-418 production release-state verifier", () => {
  it.each([
    ["baseline", ledger(), "baseline"],
    ["partial-one", ledger(OVD417_MIGRATION_VERSIONS.slice(0, 1)), "prefix"],
    ["final", ledger(OVD417_MIGRATION_VERSIONS), "final"],
  ])("admits exact production %s evidence", (requiredState, evidence, kind) => {
    expect(verifyOvd418ReleaseState(evidence, requiredState)).toEqual({ ok: true, kind });
  });

  it.each([
    ["partial-two", ledger(OVD417_MIGRATION_VERSIONS.slice(0, 2))],
    ["partial-three", ledger(OVD417_MIGRATION_VERSIONS.slice(0, 3))],
  ])("rejects exact production %s", (label, evidence) => {
    const result = verifyOvd418ReleaseState(evidence, "partial-one");
    expectBlocked(result);
    expect(result.violations.join(" ")).toContain(label);
  });

  it("rejects the old local lineage", () => {
    const evidence = ledger();
    evidence.baselineFingerprint = "5dabebda8a0fc1a3cf697e00de64418b";
    evidence.ledgerFingerprint = "5dabebda8a0fc1a3cf697e00de64418b";
    expectBlocked(verifyOvd418ReleaseState(evidence, "baseline"));
  });

  it.each([
    ["mixed lineage", { ...ledger(OVD417_MIGRATION_VERSIONS.slice(0, 1)), ledgerFingerprint: "237b68dd5f9cbfaa353c8ee32e1133f1" }],
    ["continuity drift", { ...ledger(), productionContinuity: { ...OVD418_PRODUCTION_CONTINUITY, row100: { ...OVD418_PRODUCTION_CONTINUITY.row100, statementHash: "f".repeat(32) } } }],
    ["suffix hash drift", { ...ledger(OVD417_MIGRATION_VERSIONS.slice(0, 1)), packageStatementHashes: [] }],
    ["suffix hash gap", { ...ledger(OVD417_MIGRATION_VERSIONS.slice(0, 2)), packageStatementHashes: [OVD418_SUFFIX_STATEMENT_HASHES[1]] }],
    ["suffix hash duplicate", { ...ledger(OVD417_MIGRATION_VERSIONS.slice(0, 2)), packageStatementHashes: [OVD418_SUFFIX_STATEMENT_HASHES[0], OVD418_SUFFIX_STATEMENT_HASHES[0]] }],
    ["suffix hash extra", { ...ledger(), packageStatementHashes: [OVD418_SUFFIX_STATEMENT_HASHES[0]] }],
    ["package duplicate", ledger([OVD417_MIGRATION_VERSIONS[0], OVD417_MIGRATION_VERSIONS[0]])],
    ["unexpected migration", { ...ledger(), unexpectedVersionCount: 1 }],
  ])("fails closed for %s", (_label, evidence) => {
    expectBlocked(verifyOvd418ReleaseState(evidence, "baseline"));
  });

  it("rejects an unknown required state", () => {
    expect(verifyOvd418ReleaseState(ledger(), "recoverable")).toEqual({
      ok: false,
      violations: ["OVD-418 promotion remains blocked; incident review required: unknown required state: recoverable"],
    });
  });

  it("accepts captured production JSON from baseline through final and rejects an unexpected suffix", async () => {
    const [captureSql, preconditionsSql, postconditionsSql] = await Promise.all([
      readFile(capturePath, "utf8"),
      readFile(preconditionsPath, "utf8"),
      readFile(postconditionsPath, "utf8"),
    ]);
    for (const sql of [captureSql, preconditionsSql, postconditionsSql]) {
      expect(sql).toContain("begin read only;");
    }
    for (const field of ["productionContinuity", "packageStatementHashes", "baselineFingerprint", "ledgerFingerprint"]) {
      expect(captureSql).toContain(field);
      expect(preconditionsSql).toContain(field);
    }
    expect(postconditionsSql).toContain("OVD-418 reviewed migration suffix or per-row statement hashes drifted");
    expect(postconditionsSql).toContain("OVD-418 OVD-373 prefix continuity drifted");

    expect(verifyOvd418ReleaseState(capturedJsonFixture(), "baseline")).toEqual({ ok: true, kind: "baseline" });
    expect(verifyOvd418ReleaseState(
      capturedJsonFixture(OVD417_MIGRATION_VERSIONS.slice(0, 1), { preconditions: true }),
      "partial-one",
    )).toEqual({ ok: true, kind: "prefix" });
    expect(verifyOvd418ReleaseState(
      capturedJsonFixture(OVD417_MIGRATION_VERSIONS, { preconditions: true }),
      "final",
    )).toEqual({ ok: true, kind: "final" });

    const unexpected = capturedJsonFixture();
    unexpected.unexpectedVersionCount = 1;
    expectBlocked(verifyOvd418ReleaseState(unexpected, "baseline"));
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
    const [runner, capture] = await Promise.all([
      readFile(runnerPath, "utf8"),
      readFile(capturePath, "utf8"),
    ]);
    const pushLines = runner.split("\n").filter((line) => line.includes("supabase db push"));
    expect(pushLines).toHaveLength(3);
    expect(pushLines.every((line) => line.includes("--db-url"))).toBe(true);
    expect(pushLines.filter((line) => !line.includes("--dry-run"))).toHaveLength(1);
    expect(runner).toContain("capture-ovd418-production-ledger.sql");
    expect(capture).toContain("productionContinuity");
    expect(capture).toContain("packageStatementHashes");
    expect(runner).toContain("ledger_contract_sha256=");
    expect(runner).not.toContain("5dabebda8a0fc1a3cf697e00de64418b");
    for (const forbidden of ["--linked", "--include-seed", "migration repair", "db reset", "PGPASSWORD", "gcloud", "curl"]) {
      expect(runner).not.toContain(forbidden);
    }
  });

  it("verifies authorization and the bound ledger contract before dispatch", async () => {
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
    expect(runner).toContain("verify_ledger_contract_anchor");
    expect(runner).toContain("production ledger continuity changed since preaudit");
    expect(runner).toContain("next_attempt_directory");
    expect(runner).toContain("trap 'exit 130' INT");
    expect(runner).toContain("trap 'exit 143' TERM");
    expect(runner).toContain("could not release the production lock container");
    expect(runner).toContain("could not confirm temporary credential revocation");
  });
});
