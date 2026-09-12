// @vitest-environment node
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createEngineeringInboxFixturePlan, runEngineeringInboxFixturePlanCli } from "./engineering-inbox-fixture-plan.mjs";

const id = (digit) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const fixture = () => ({
  sourceRevision: "a".repeat(40),
  ownerTaskId: id("1"),
  runId: id("2"),
  databaseImage: `sha256:${"3".repeat(64)}`,
  postgrestImage: `sha256:${"4".repeat(64)}`,
  migrations: [
    { path: "supabase/migrations/20260910045917_engineering_durable_inbox.sql", sha256: "5".repeat(64) },
    { path: "supabase/migrations/20260910055556_engineering_ordered_changes.sql", sha256: "6".repeat(64) },
  ],
});

function expectCode(action, code) {
  try {
    action();
    throw new Error("expected rejection");
  } catch (error) {
    expect(error.message).toBe(code);
  }
}

describe("engineering inbox fixture plan", () => {
  it("returns a deeply immutable plan with fixed limits, ordered stages and unverified claims", () => {
    const plan = createEngineeringInboxFixturePlan(fixture());
    expect(plan).toMatchObject({ mode: "plan_only", qualification: "not_run",
      identity: { runIdFreshness: "unverified" },
      resourcePolicy: { maxContainers: 2, maxNetworks: 1, network: "exclusive_internal",
        persistentVolumes: 0, retryAttempts: 0 },
      receiptPolicy: { destination: "stdout_only", content: "value_free", successRequiresCleanupComplete: true },
    });
    expect(plan.futureStages.at(-2)).toBe("cleanup");
    expect(plan.futureStages.at(-1)).toBe("final_receipt");
    expect(plan.unverifiedClaims).toEqual(expect.arrayContaining(["run_id_freshness", "migration_bytes", "cleanup"]));
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.resourcePolicy.containers.database.tmpfs)).toBe(true);
  });

  it.each([
    ["unknown input key", (value) => { value.outputPath = "/tmp/report"; }, "invalid_input_shape"],
    ["source revision", (value) => { value.sourceRevision = "main"; }, "invalid_source_revision"],
    ["owner task", (value) => { value.ownerTaskId = "owner"; }, "invalid_owner_task_id"],
    ["run id", (value) => { value.runId = value.ownerTaskId; }, "invalid_run_id"],
    ["mutable image", (value) => { value.databaseImage = "postgres:latest"; }, "invalid_image_identity"],
    ["same images", (value) => { value.postgrestImage = value.databaseImage; }, "invalid_image_identity"],
    ["empty manifest", (value) => { value.migrations = []; }, "invalid_migration_manifest"],
    ["migration outside tree", (value) => { value.migrations[0].path = "private/bootstrap.sql"; }, "invalid_migration_entry"],
    ["migration URL", (value) => { value.migrations[0].path = "https://example.test/x.sql"; }, "invalid_migration_entry"],
    ["migration digest", (value) => { value.migrations[0].sha256 = "unknown"; }, "invalid_migration_entry"],
    ["migration order", (value) => { value.migrations.reverse(); }, "invalid_migration_entry"],
    ["migration extra key", (value) => { value.migrations[0].credential = "rejected-value"; }, "invalid_migration_entry"],
  ])("rejects invalid %s without echoing the value", (_label, mutate, code) => {
    const value = fixture();
    mutate(value);
    expectCode(() => createEngineeringInboxFixturePlan(value), code);
  });

  it.each([
    ["source revision", (value) => { value.sourceRevision = [value.sourceRevision]; }, "invalid_source_revision"],
    ["owner task", (value) => { value.ownerTaskId = [value.ownerTaskId]; }, "invalid_owner_task_id"],
    ["run id", (value) => { value.runId = [value.runId]; }, "invalid_run_id"],
    ["database image", (value) => { value.databaseImage = [value.databaseImage]; }, "invalid_image_identity"],
    ["postgrest image", (value) => { value.postgrestImage = [value.postgrestImage]; }, "invalid_image_identity"],
    ["migration path", (value) => { value.migrations[0].path = [value.migrations[0].path]; }, "invalid_migration_entry"],
    ["migration digest", (value) => { value.migrations[0].sha256 = [value.migrations[0].sha256]; }, "invalid_migration_entry"],
  ])("rejects an array-wrapped %s", (_label, mutate, code) => {
    const value = fixture();
    mutate(value);
    expectCode(() => createEngineeringInboxFixturePlan(value), code);
  });

  it("accepts UUIDv7 syntax while leaving freshness unverified", () => {
    const value = fixture();
    value.ownerTaskId = "11111111-1111-7111-8111-111111111111";
    value.runId = "22222222-2222-7222-8222-222222222222";
    expect(createEngineeringInboxFixturePlan(value).identity).toMatchObject({
      ownerTaskId: value.ownerTaskId, runId: value.runId, runIdFreshness: "unverified",
    });
  });

  it("does not accept a command dependency", () => {
    const command = vi.fn();
    const value = { ...fixture(), command };
    expectCode(() => createEngineeringInboxFixturePlan(value), "invalid_input_shape");
    expect(command).not.toHaveBeenCalled();
  });

  it("prints only the plan in plan mode", async () => {
    let output = "";
    const plan = await runEngineeringInboxFixturePlanCli({ argv: ["--plan"], stdin: Readable.from(JSON.stringify(fixture())),
      stdout: { write: (chunk) => { output += chunk; } } });
    expect(JSON.parse(output)).toEqual(plan);
    expect(output).not.toContain("credential");
  });

  it("refuses execute before reading input or calling a command", async () => {
    const command = vi.fn();
    const stdin = { [Symbol.asyncIterator]: () => { command(); throw new Error("stdin was read"); } };
    await expect(runEngineeringInboxFixturePlanCli({ argv: ["--execute"], stdin, stdout: { write: vi.fn() } }))
      .rejects.toThrow("execution_unavailable_in_plan_slice");
    expect(command).not.toHaveBeenCalled();
  });

  it("bounds input and reports fixed errors without rejected raw values", async () => {
    await expect(runEngineeringInboxFixturePlanCli({ argv: ["--plan"], stdin: Readable.from("x".repeat(65 * 1024)),
      stdout: { write: vi.fn() } })).rejects.toThrow("input_too_large");
    await expect(runEngineeringInboxFixturePlanCli({ argv: ["--plan"], stdin: Readable.from("sensitive rejected input"),
      stdout: { write: vi.fn() } })).rejects.toThrow("invalid_json_input");
  });
});
