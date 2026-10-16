import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { claimById, claimOldest, createPlateRequest, createRequest, parseDesignRequest } from "./jarvis-demo.mjs";

const cli = join(process.cwd(), "scripts", "jarvis-demo", "jarvis-demo.mjs");

async function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "jarvis-demo-"));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const plate = (thicknessMm) => ({ recipe: "plate", edgeMm: 101.6, thicknessMm, holePattern: "none", material: "6061-T6 aluminum" });

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", (status) => resolve({ status, out: JSON.parse(stdout) }));
  });
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
  assert.match(parseDesignRequest("bracket plate with a 0.5 inch pin").reason, /in mm/);
  assert.match(parseDesignRequest("bracket plate with a -8 mm pin").reason, /4 to 20 mm/);
  assert.match(parseDesignRequest("bracket plate with an 8 pin").reason, /in mm/);
  assert.match(parseDesignRequest("a bracket on a template with a pinterest pin").reason, /missing: plate/);
});

test("pending requests are claimed oldest first and each only once", () =>
  withRoot((root) => {
    const first = createRequest(root, "bracket plate 8 mm pin", "test", new Date("2026-10-15T07:00:00Z")).request;
    const second = createRequest(root, "bracket plate 9 mm pin", "test", new Date("2026-10-15T07:01:00Z")).request;
    assert.equal(claimOldest(root).request.id, first.id);
    assert.equal(claimOldest(root).request.id, second.id);
    assert.equal(claimOldest(root), null);
    assert.deepEqual(readdirSync(join(root, "queue", "pending")), []);
  }));

test("claiming by id takes that request even behind a backlog", () =>
  withRoot((root) => {
    const older = createRequest(root, "bracket plate 8 mm pin", "test", new Date("2026-10-15T07:00:00Z")).request;
    const mine = createRequest(root, "bracket plate 9 mm pin", "test", new Date("2026-10-15T07:01:00Z")).request;
    assert.equal(claimById(root, mine.id).request.id, mine.id);
    assert.equal(claimById(root, mine.id), null);
    assert.equal(claimOldest(root).request.id, older.id);
  }));

test("a request still being written is never claimed", () =>
  withRoot((root) => {
    mkdirSync(join(root, "queue", "pending"), { recursive: true });
    writeFileSync(join(root, "queue", "pending", ".jd-partial.tmp"), "{\"id\":");
    assert.equal(claimOldest(root), null);
  }));

test("the phone wrapper exits nonzero on a refused request and creates no run", () =>
  withRoot((root) => {
    const wrapper = join(process.cwd(), "scripts", "jarvis-demo", "jarvis-design.sh");
    const run = spawnSync("bash", [wrapper, "design a gear"], {
      encoding: "utf8",
      env: { ...process.env, JARVIS_DEMO_ROOT: root },
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /refused/);
    assert.equal(existsSync(join(root, "runs")), false);
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

test("P-4 (worker) the queue refuses an out-of-range plate thickness and files nothing", () =>
  withRoot((root) => {
    for (const thicknessMm of [0.1, 60, -3, Number.NaN]) {
      assert.match(createPlateRequest(root, plate(thicknessMm), "test").reason, /thickness must be 0.5 to 50 mm/);
    }
    assert.match(createPlateRequest(root, { ...plate(6.35), edgeMm: 152.4 }, "test").reason, /only a 101.6 mm/);
    assert.equal(existsSync(join(root, "queue")), false);
    assert.equal(createPlateRequest(root, plate(0.5), "test").ok, true);
  }));

test("P-5 a plate job is claimed exactly once under concurrent workers", () =>
  withRoot(async (root) => {
    // Stand-in for the build123d Python: records each invocation, so a double claim
    // would show up as two runs. The claim itself is the real atomic rename.
    const counter = join(root, "invocations.log");
    const fakePython = join(root, "fake-python.sh");
    writeFileSync(fakePython, `#!/usr/bin/env bash\necho "$$ $1" >> "${counter}"\nsleep 0.2\n`);
    chmodSync(fakePython, 0o755);
    const env = { JARVIS_DEMO_ENABLED: "1", JARVIS_DEMO_ROOT: root, JARVIS_DEMO_PYTHON: fakePython };
    for (let round = 0; round < 3; round += 1) {
      const { id } = createPlateRequest(root, plate(6.35), "test").request;
      // Half the workers race for this id, half for "the oldest pending job".
      const workers = Array.from({ length: 8 }, (_, i) => runCli(i % 2 ? ["work", "--id", id] : ["work"], env));
      const results = await Promise.all(workers);
      const winners = results.filter((r) => r.out.state === "verified");
      assert.equal(winners.length, 1, JSON.stringify(results));
      assert.equal(winners[0].out.id, id);
      for (const loser of results.filter((r) => r !== winners[0])) {
        assert.ok(loser.out.state === "not_pending" || loser.out.idle === true, JSON.stringify(loser));
      }
      const runs = readFileSync(counter, "utf8").trim().split("\n");
      assert.equal(runs.length, round + 1);
      assert.match(runs[round], /plate\.py$/);
      assert.ok(existsSync(join(root, "queue", "done", `${id}.json`)));
      assert.deepEqual(readdirSync(join(root, "queue", "pending")), []);
      assert.deepEqual(readdirSync(join(root, "queue", "claimed")), []);
    }
  }), 60_000);
