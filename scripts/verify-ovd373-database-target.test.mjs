import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  OVD373_PRODUCTION_PROJECT_REF,
  validateDatabaseTarget,
} from "./verify-ovd373-database-target.mjs";

const execFileAsync = promisify(execFile);
const temporaryDirectories = [];
const VALID_POOLER_URL =
  `postgresql://postgres.${OVD373_PRODUCTION_PROJECT_REF}`
  + "@aws-1-us-west-1.pooler.supabase.com:5432/postgres";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("OVD-373 database target verifier", () => {
  it("accepts only the exact credential-free production pooler target", () => {
    expect(validateDatabaseTarget({
      projectRef: OVD373_PRODUCTION_PROJECT_REF,
      poolerUrl: VALID_POOLER_URL,
    })).toEqual([]);
  });

  it.each([
    ["wrong ref", "wrong", VALID_POOLER_URL],
    ["wrong username", OVD373_PRODUCTION_PROJECT_REF, VALID_POOLER_URL.replace("postgres.ozuatdcakezjtevztjlr", "postgres.attacker")],
    ["password", OVD373_PRODUCTION_PROJECT_REF, VALID_POOLER_URL.replace("@", ":secret@")],
    ["spoofed host", OVD373_PRODUCTION_PROJECT_REF, VALID_POOLER_URL.replace(".supabase.com", ".supabase.com.attacker.test")],
    ["wrong port", OVD373_PRODUCTION_PROJECT_REF, VALID_POOLER_URL.replace(":5432", ":6543")],
    ["wrong database", OVD373_PRODUCTION_PROJECT_REF, VALID_POOLER_URL.replace("/postgres", "/other")],
    ["wrong protocol", OVD373_PRODUCTION_PROJECT_REF, VALID_POOLER_URL.replace("postgresql:", "https:")],
    ["query", OVD373_PRODUCTION_PROJECT_REF, `${VALID_POOLER_URL}?sslmode=require`],
    ["fragment", OVD373_PRODUCTION_PROJECT_REF, `${VALID_POOLER_URL}#fragment`],
  ])("rejects %s", (_label, projectRef, poolerUrl) => {
    expect(validateDatabaseTarget({ projectRef, poolerUrl })).not.toEqual([]);
  });

  it("rejects symlinked CLI link artifacts", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "ovd373-target-"));
    temporaryDirectories.push(fixtureRoot);
    const tempRoot = path.join(fixtureRoot, "supabase/.temp");
    await mkdir(tempRoot, { recursive: true });
    const actualRef = path.join(fixtureRoot, "actual-project-ref");
    await writeFile(actualRef, OVD373_PRODUCTION_PROJECT_REF);
    await symlink(actualRef, path.join(tempRoot, "project-ref"));
    await writeFile(path.join(tempRoot, "pooler-url"), VALID_POOLER_URL);
    const scriptPath = path.resolve(process.cwd(), "scripts/verify-ovd373-database-target.mjs");

    await expect(execFileAsync(process.execPath, [scriptPath], { cwd: fixtureRoot })).rejects.toMatchObject({
      stderr: expect.stringContaining("must be a regular, non-symlink file"),
    });
  });
});
