import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { cleanupOwnedResource } from "./ovd510-owned-cleanup.mjs";
import { transferCliInput } from "./ovd570-cli-input.mjs";

test("CLI transfer binds captured bytes despite later caller mutation, and rejects transfer corruption", () => {
  const source = Buffer.from("select 1;\n");
  const expected = Buffer.from(source);
  let transferred;
  const exec = (_container, args, input) => {
    if (input) {
      source.fill(42); // Simulates the original staging mutation during Docker work.
      transferred = Buffer.from(input);
      return { stdout: "" };
    }
    assert.equal(args[0], "sha256sum");
    return { stdout: createHash("sha256").update(transferred).digest("hex") + "  /target" };
  };
  const receipt = transferCliInput(exec, "owned", "/target", source);
  assert.deepEqual(transferred, expected);
  assert.equal(receipt.sha256, createHash("sha256").update(expected).digest("hex"));
  assert.throws(() => transferCliInput(() => ({ stdout: "bad  /target" }), "owned", "/target", expected), /cli_transferred_input_mismatch/);
});

test("lost creation replies reconcile all four exact owned resource names without returned IDs", () => {
  for (const [kind, name] of [["container", "auth"], ["container", "storage"], ["container", "database"], ["network", "network"]]) {
    const calls = [];
    const call = (args, options) => {
      calls.push(args);
      assert.equal(options.allowAfterDeadline, true);
      return { status: 0, stdout: args.includes("inspect") ? "fixture-id\n" : "", stderr: "" };
    };
    assert.equal(cleanupOwnedResource({ call, kind, name, fixtureId: "fixture-id", attempted: true }), "removed_owned");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].at(-1), name);
    assert.deepEqual(calls[1], kind === "network" ? ["network", "rm", name] : ["rm", "--force", name]);
  }
});

test("cleanup never removes mismatched ownership or mistakes unavailable Docker for absence", () => {
  for (const [response, expected] of [
    [{ status: 0, stdout: "another-fixture" }, "ownership_mismatch"],
    [{ status: 1, stderr: "Cannot connect to Docker daemon" }, "unproved"],
    [{ status: null, error: new Error("ETIMEDOUT"), stderr: "No such container" }, "unproved"],
    [{ status: 1, stderr: "Error: No such container: owned" }, "absent_after_attempt"],
  ]) {
    let calls = 0;
    assert.equal(cleanupOwnedResource({ call: () => { calls++; return response; }, kind: "container", name: "owned", fixtureId: "fixture-id", attempted: true }), expected);
    assert.equal(calls, 1);
  }
});
