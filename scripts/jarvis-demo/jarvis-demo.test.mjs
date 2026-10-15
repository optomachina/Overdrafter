import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { claimOldest, createRequest, parseDesignRequest } from "./jarvis-demo.mjs";

const cli = join(process.cwd(), "scripts", "jarvis-demo", "jarvis-demo.mjs");

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "jarvis-demo-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a bracket, plate and pin request reads the pin diameter", () => {
  assert.deepEqual(parseDesignRequest("Design a bracket on a base plate with an 8 mm pin").params.pinDiameterMm, 8);
  assert.equal(parseDesignRequest("bracket + plate + pin of 12.5 mm").params.pinDiameterMm, 12.5);
  assert.equal(parseDesignRequest("bracket, plate and pin").params.pinDiameterMm, 10);
});

test("a request missing a part or with an out of range pin is refused", () => {
  assert.match(parseDesignRequest("design a bracket and a pin").reason, /missing: plate/);
  assert.match(parseDesignRequest("bracket plate 40 mm pin").reason, /4 to 20 mm/);
  assert.equal(parseDesignRequest(undefined).ok, false);
});

test("each pending request is claimed exactly once, oldest first", () =>
  withRoot((root) => {
    const first = createRequest(root, "bracket plate 8 mm pin", "test", new Date("2026-10-15T07:00:00Z")).request;
    const second = createRequest(root, "bracket plate 9 mm pin", "test", new Date("2026-10-15T07:01:00Z")).request;
    assert.equal(claimOldest(root).id, first.id);
    assert.equal(claimOldest(root).id, second.id);
    assert.equal(claimOldest(root), null);
    assert.deepEqual(readdirSync(join(root, "queue", "pending")), []);
  }));

test("the CLI refuses to run unless the admin flag is on", () =>
  withRoot((root) => {
    const run = spawnSync(process.execPath, [cli, "request", "bracket plate pin"], {
      encoding: "utf8",
      env: { ...process.env, JARVIS_DEMO_ENABLED: "", JARVIS_DEMO_ROOT: root },
    });
    assert.equal(run.status, 3);
    assert.match(run.stderr, /Jarvis demo is off/);
    assert.deepEqual(readdirSync(root), []);
  }));
