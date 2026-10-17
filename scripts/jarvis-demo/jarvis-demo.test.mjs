import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";

import { claimById, claimOldest, createPlateRequest, createRequest, parseDesignRequest, validatePlateParams } from "./jarvis-demo.mjs";

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

function runCli(args, env, onSpawn) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    onSpawn?.(child);
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", (status) => resolve({ status, out: JSON.parse(stdout) }));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Stand-in Python that runs for `seconds` and starts a grandchild of its own; each
// leaves a marker if it is still alive at the end, so a surviving process shows up.
function slowPython(root, seconds) {
  const file = join(root, "slow-python.sh");
  const mark = join(root, "mark");
  writeFileSync(file, `#!/usr/bin/env bash\ntouch "${mark}.started"\n( sleep ${seconds}; touch "${mark}.grandchild" ) &\nsleep ${seconds}\ntouch "${mark}.child"\n`);
  chmodSync(file, 0o755);
  return { file, survivors: () => ["child", "grandchild"].filter((m) => existsSync(`${mark}.${m}`)), started: () => existsSync(`${mark}.started`) };
}

const queueOf = (root, dir) => (existsSync(join(root, "queue", dir)) ? readdirSync(join(root, "queue", dir)) : []);

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
    const env = { JARVIS_DEMO_ENABLED: "1", JARVIS_CAD_AGENT_ENABLED: "1", JARVIS_DEMO_ROOT: root, JARVIS_DEMO_PYTHON: fakePython };
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

test("a Python run past the worker timeout is killed with its process group and the claim moves to failed", () =>
  withRoot(async (root) => {
    const slow = slowPython(root, 1.5);
    const env = { JARVIS_DEMO_ENABLED: "1", JARVIS_CAD_AGENT_ENABLED: "1", JARVIS_DEMO_ROOT: root, JARVIS_DEMO_PYTHON: slow.file, JARVIS_DEMO_WORKER_TIMEOUT_MS: "300" };
    const { id } = createPlateRequest(root, plate(6.35), "test").request;
    const { status, out } = await runCli(["work", "--id", id], env);
    assert.equal(status, 1);
    assert.deepEqual({ id: out.id, state: out.state, reason: out.reason }, { id, state: "failed", reason: "worker timed out after 300 ms" });
    assert.deepEqual(queueOf(root, "claimed"), []);
    assert.deepEqual(queueOf(root, "failed"), [`${id}.json`]);
    assert.equal(JSON.parse(readFileSync(join(root, "runs", id, "outcome.json"), "utf8")).state, "failed");
    await sleep(2000);
    assert.deepEqual(slow.survivors(), []);
  }), 20_000);

test("SIGTERM to the CLI kills the running Python group and still moves the claim to failed", () =>
  withRoot(async (root) => {
    const slow = slowPython(root, 1.5);
    const env = { JARVIS_DEMO_ENABLED: "1", JARVIS_CAD_AGENT_ENABLED: "1", JARVIS_DEMO_ROOT: root, JARVIS_DEMO_PYTHON: slow.file };
    const { id } = createPlateRequest(root, plate(6.35), "test").request;
    let cliProcess;
    const done = runCli(["work", "--id", id], env, (child) => (cliProcess = child));
    for (let i = 0; i < 200 && !slow.started(); i += 1) await sleep(10);
    assert.ok(slow.started());
    cliProcess.kill("SIGTERM");
    const { status, out } = await done;
    assert.equal(status, 1);
    assert.deepEqual({ state: out.state, reason: out.reason }, { state: "failed", reason: "worker stopped" });
    assert.deepEqual(queueOf(root, "claimed"), []);
    assert.deepEqual(queueOf(root, "failed"), [`${id}.json`]);
    await sleep(2000);
    assert.deepEqual(slow.survivors(), []);
  }), 20_000);

test("a job with an unknown recipe fails with a structured result instead of crashing", () =>
  withRoot(async (root) => {
    const id = "jd-unknown-recipe";
    mkdirSync(join(root, "queue", "pending"), { recursive: true });
    writeFileSync(join(root, "queue", "pending", `${id}.json`), JSON.stringify({ id, params: { recipe: "gear" }, state: "pending" }));
    const { status, out } = await runCli(["work", "--id", id], { JARVIS_DEMO_ENABLED: "1", JARVIS_DEMO_ROOT: root });
    assert.equal(status, 1);
    assert.deepEqual({ ok: out.ok, state: out.state, reason: out.reason }, { ok: false, state: "failed", reason: "unknown recipe" });
    assert.equal(JSON.parse(readFileSync(join(root, "runs", id, "outcome.json"), "utf8")).reason, "unknown recipe");
    assert.deepEqual(queueOf(root, "failed"), [`${id}.json`]);
  }));

test("plate jobs need the CAD agent flag: the plate command files nothing and work hands the job back", () =>
  withRoot(async (root) => {
    const env = { JARVIS_DEMO_ENABLED: "1", JARVIS_CAD_AGENT_ENABLED: "", JARVIS_DEMO_ROOT: root, JARVIS_DEMO_PYTHON: "/nonexistent" };
    const refused = await runCli(["plate", JSON.stringify(plate(6.35))], env);
    assert.deepEqual({ status: refused.status, state: refused.out.state }, { status: 1, state: "disabled" });
    assert.deepEqual(queueOf(root, "claimed"), []);
    const { id } = createPlateRequest(root, plate(6.35), "test").request;
    const handedBack = await runCli(["work", "--id", id], env);
    assert.deepEqual({ state: handedBack.out.state, reason: handedBack.out.reason }, { state: "disabled", reason: "plate jobs need JARVIS_CAD_AGENT_ENABLED=1" });
    assert.deepEqual(queueOf(root, "pending"), [`${id}.json`]);
    assert.equal(existsSync(join(root, "runs")), false);
  }));

test("the plate command files its job already claimed, so a concurrent work never takes it", () =>
  withRoot(async (root) => {
    const fakePython = join(root, "fake-python.sh");
    writeFileSync(fakePython, "#!/usr/bin/env bash\nsleep 0.1\n");
    chmodSync(fakePython, 0o755);
    const env = { JARVIS_DEMO_ENABLED: "1", JARVIS_CAD_AGENT_ENABLED: "1", JARVIS_DEMO_ROOT: root, JARVIS_DEMO_PYTHON: fakePython };
    for (let round = 0; round < 3; round += 1) {
      const [plateRun, ...workers] = await Promise.all([
        runCli(["plate", JSON.stringify(plate(6.35))], env),
        ...Array.from({ length: 6 }, () => runCli(["work"], env)),
      ]);
      assert.equal(plateRun.out.state, "verified", JSON.stringify(plateRun));
      for (const worker of workers) assert.equal(worker.out.idle, true, JSON.stringify(worker));
    }
    assert.deepEqual(queueOf(root, "pending"), []);
  }), 60_000);

test("refusal reasons echo only numbers, never caller-supplied text", () => {
  const secret = "SECRET free text";
  for (const params of [{ ...plate(6.35), edgeMm: secret }, { ...plate(secret) }, { ...plate(6.35), holePattern: secret }]) {
    const { ok, reason } = validatePlateParams(params);
    assert.equal(ok, false);
    assert.ok(!reason.includes("SECRET"), reason);
  }
  assert.match(validatePlateParams(plate(60)).reason, /got 60$/);
  const pin = parseDesignRequest("bracket plate with a 0.5 SECRETinch pin");
  assert.equal(pin.ok, false);
  assert.ok(!pin.reason.toLowerCase().includes("secret"), pin.reason);
});

test.skipIf(!process.env.JARVIS_DEMO_PYTHON)("glb_check.py with no argument prints usage and exits 64 without a traceback", () => {
  const run = spawnSync(process.env.JARVIS_DEMO_PYTHON, [join(process.cwd(), "scripts", "jarvis-demo", "glb_check.py")], {
    encoding: "utf8",
    cwd: tmpdir(),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(run.status, 64);
  assert.match(run.stderr, /^usage: glb_check\.py <file\.glb>\n$/);
});
