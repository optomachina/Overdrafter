import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const runnerPath = resolve(process.cwd(), "scripts/qualify-ovd417-four-migration-suffix.sh");
const runner = readFileSync(runnerPath, "utf8");
const postconditions = readFileSync(resolve(process.cwd(), "scripts/verify-ovd417-qualification-postconditions.sql"), "utf8");
const runbook = readFileSync(resolve(process.cwd(), "docs/workflows/ovd417-four-migration-qualification.md"), "utf8");

function offset(fragment) {
  const value = runner.indexOf(fragment);
  expect(value, `missing ${fragment}`).toBeGreaterThanOrEqual(0);
  return value;
}

function validationFailure({ clean, recovery, restored, dirtyEvidence = false }) {
  const root = mkdtempSync(join(tmpdir(), "ovd417-validation-"));
  const project = join(root, "project");
  const evidence = join(root, "evidence");
  mkdirSync(project);
  mkdirSync(evidence);
  if (dirtyEvidence) writeFileSync(join(evidence, "stale.txt"), "stale");
  try {
    execFileSync("bash", [runnerPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OVD417_CLEAN_DATABASE_URL: clean,
        OVD417_RECOVERY_DATABASE_URL: recovery,
        OVD417_RESTORED_DATABASE_URL: restored,
        OVD417_TEMP_PROJECT_DIR: project,
        OVD417_EVIDENCE_DIR: evidence,
      },
      stdio: "pipe",
    });
    throw new Error("qualification unexpectedly passed input validation");
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("OVD-417 local qualification harness", () => {
  it("parses without running a database qualification", () => {
    expect(() => execFileSync("bash", ["-n", runnerPath])).not.toThrow();
  });

  it("forbids hosted, linked, credential, and history-repair paths structurally", () => {
    for (const forbidden of ["--linked", "migration repair", "supabase link", "supabase projects", "supabase.com", "http://", "https://", "PGPASSWORD"]) {
      expect(runner, forbidden).not.toContain(forbidden);
    }
    expect(runner).toContain("assert_disposable_url");
    expect(runner).toContain("'localhost', '127.0.0.1', '[::1]'");
    expect(runner).toContain("database name must be an unescaped ovd417_ identifier");
    expect(runner).not.toContain("OVD417_CLONE_SCHEMA_SQL");
    expect(runner).not.toContain("OVD417_CLONE_LEDGER_SQL");
    expect(runner).not.toContain("supabase db reset");
    expect(runner).toContain("if rg --quiet");
    expect(runner.match(/dry-run\.txt\" 2>&1/g)).toHaveLength(2);
  });

  it("rejects routing overrides, duplicate databases, and non-empty evidence before qualification", () => {
    const clean = "postgresql://postgres:postgres@127.0.0.1:54322/ovd417_clean";
    const recovery = "postgresql://postgres:postgres@localhost:54322/ovd417_recovery";
    const restored = "postgresql://postgres:postgres@[::1]:54322/ovd417_restored";
    expect(validationFailure({ clean: `${clean}?hostaddr=203.0.113.10`, recovery, restored })).toContain(
      "must not contain connection query or fragment parameters",
    );
    expect(validationFailure({ clean, recovery: clean.replace("127.0.0.1", "localhost"), restored })).toContain(
      "must be pairwise distinct",
    );
    expect(validationFailure({ clean, recovery, restored, dirtyEvidence: true })).toContain(
      "local evidence directory must be empty",
    );
  });

  it("injects immediately after the first migration and refuses promotion from a one-row prefix", () => {
    const injection = offset("OVD-417 injected local qualification failure");
    const interruptedPush = runner.indexOf('supabase db push --db-url "$OVD417_RECOVERY_DATABASE_URL"', injection);
    expect(interruptedPush).toBeGreaterThanOrEqual(0);
    const oneRow = offset("--require-state partial-one");
    const promotionBlock = runner.indexOf("--require-state final", oneRow);
    const removal = runner.indexOf('rm -f -- "$OVD417_INJECTED_FAILURE_FILE"', promotionBlock);
    expect(removal).toBeGreaterThanOrEqual(0);
    const rehash = runner.indexOf("verify_frozen_source_and_hashes", removal);
    const fixForward = runner.indexOf('supabase db push --db-url "$OVD417_RECOVERY_DATABASE_URL"', removal);
    expect(injection).toBeLessThan(interruptedPush);
    expect(interruptedPush).toBeLessThan(oneRow);
    expect(oneRow).toBeLessThan(promotionBlock);
    expect(promotionBlock).toBeLessThan(removal);
    expect(removal).toBeLessThan(rehash);
    expect(rehash).toBeLessThan(fixForward);
    expect(runner).toContain("partial prefix incorrectly admitted worker promotion");
  });

  it("pins source, baseline, exact suffix hashes, and local backup/restore evidence", () => {
    expect(runner).toContain("5c3b6864e63ada75561f4ff7019bde70962d6e39");
    expect(runner).toContain("5dabebda8a0fc1a3cf697e00de64418b");
    expect(runner.match(/verify_frozen_source_and_hashes/g)).toHaveLength(3);
    expect(runner).toContain("public.ecr.aws/supabase/postgres@sha256:a554cd5d22208934b1b282a17fd68dca8f3fa8b8bda3a59949fbdd37cd2cd144");
    expect(runner).toContain("db_dump");
    expect(runner).toContain("db_superuser_psql");
    expect(runner).toContain("prepare-ovd373-schema-restore.mjs");
    expect(runner).toContain("recovered-ledger-data.sql");
    expect(runner).toContain('--schema-only --no-owner \\\n');
    expect(runner).toContain("host.docker.internal");
    expect(runner).toContain("url.username = 'supabase_admin'");
    expect(runner.match(/docker run --rm --interactive/g)).toHaveLength(2);
    expect(runner).toContain("sanitized-aggregate-counts");
    expect(runner.match(/--require-state baseline/g)).toHaveLength(4);
    expect(runner.match(/run_qualification_pgtap "\$OVD417_[A-Z_]*DATABASE_URL"/g)).toHaveLength(3);
    for (const testFile of [
      "quote_provider_admission_registry.sql",
      "manual_quote_request_lifecycle.sql",
      "manual_quote_admin_inbox.sql",
      "vendor_quote_offer_geographic_origin.sql",
    ]) {
      expect(runner).toContain(testFile);
    }
    expect(runner).toContain('compare clean "$OVD417_CLEAN_DATABASE_URL" recovered');
    expect(runner).toContain('compare_ledger recovered "$OVD417_RECOVERY_DATABASE_URL" restored');
  });

  it("keeps final postconditions independent, ledger-only, and read-only", () => {
    expect(postconditions).toContain("begin read only;");
    expect(postconditions).toContain("expected 104 migrations through 20260822213330");
    expect(postconditions).toContain("5dabebda8a0fc1a3cf697e00de64418b");
    expect(postconditions).not.toMatch(/from\s+(auth|storage|public|private)\./i);
    expect(runbook).toContain("never targets a linked Supabase target");
    expect(runbook).toContain("reads customer rows");
  });
});
