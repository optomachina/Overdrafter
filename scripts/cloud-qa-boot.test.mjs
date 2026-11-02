// @vitest-environment node
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

// prepare_unprivileged_copy runs as root against the host's user database and
// docker socket, so every command that would touch them is a stub on PATH. The
// stubs log what ran and where; a state file stands for the running stack, and
// the `supabase stop` stub removes it. The script is sourced, not executed, so
// the function under test runs without the boot steps.
const script = resolve("scripts/cloud-qa-boot.sh");
const PROJECT_ID = "stubproject";
const dirs = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function stub(bin, name, body) {
  const file = join(bin, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

function fixture({ previousCopy = true, stackRunning = true, stopFails = false, stopLeavesContainers = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cloud-qa-boot-"));
  dirs.push(dir);
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  const checkout = join(dir, "checkout");
  const copy = join(dir, "qa-repo");
  const log = join(dir, "calls.log");
  mkdirSync(bin);
  mkdirSync(state);
  // A head is a checkout with a Supabase config and a marker naming the head.
  const head = (root, marker) => {
    mkdirSync(join(root, "supabase/functions/hello"), { recursive: true });
    writeFileSync(join(root, "supabase/config.toml"), `project_id = "${PROJECT_ID}"\n`);
    writeFileSync(join(root, "HEAD_MARKER"), marker);
  };
  head(checkout, "new");
  if (previousCopy) head(copy, "old");
  if (stackRunning) writeFileSync(join(state, "running"), "");
  // `docker ps` answers from the state file; every other docker call is a no-op.
  stub(bin, "docker", `echo "docker $*" >> "$STUB_LOG"
if [[ "$1" = ps ]]; then [[ -f "$STUB_STATE/running" ]] && echo c0ffee; exit 0; fi`);
  // Logs the directory it ran in and which head's copy was there at the time.
  stub(bin, "supabase", `echo "supabase $* cwd=$PWD head=$(cat HEAD_MARKER 2>/dev/null || echo none)" >> "$STUB_LOG"
if [[ "$1" = stop ]]; then
  [[ -z "\${STUB_STOP_FAILS:-}" ]] || exit 1
  [[ -n "\${STUB_STOP_LEAVES_CONTAINERS:-}" ]] || rm -f "$STUB_STATE/running"
fi
exit 0`);
  // as_qa runs `sudo -u <user> -H env VAR=... bash -c "cd ... && ..."`: drop the
  // user switch and run the rest as this user.
  stub(bin, "sudo", `while [[ $# -gt 0 ]]; do case "$1" in -u) shift 2 ;; -H) shift ;; *) break ;; esac; done
exec "$@"`);
  for (const name of ["useradd", "usermod", "groupadd", "chgrp", "chmod", "chown"]) {
    stub(bin, name, `echo "${name} $*" >> "$STUB_LOG"`);
  }
  const run = () => {
    const result = spawnSync("bash", ["-c", 'source "$1" && prepare_unprivileged_copy', "harness", script], {
      cwd: checkout,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        QA_SHIM_DIR: bin,
        QA_COPY_DIR: copy,
        QA_USER: "cloud-qa-boot-test-user",
        STUB_LOG: log,
        STUB_STATE: state,
        ...(stopFails ? { STUB_STOP_FAILS: "1" } : {}),
        ...(stopLeavesContainers ? { STUB_STOP_LEAVES_CONTAINERS: "1" } : {}),
      },
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
    return { status: result.status, output: result.stdout + result.stderr, calls };
  };
  const marker = () => (existsSync(join(copy, "HEAD_MARKER")) ? readFileSync(join(copy, "HEAD_MARKER"), "utf8") : null);
  return { run, marker, copy };
}

const PS = `docker ps -q --filter label=com.supabase.cli.project=${PROJECT_ID}`;
const stopCall = (calls) => calls.find((call) => call.startsWith("supabase stop"));

test("stops the previous copy's running stack, as qa from that copy, before replacing it", () => {
  const { run, marker, copy } = fixture();
  const { status, output, calls } = run();
  expect(status, output).toBe(0);
  expect(output).toContain("stop-previous: ");
  expect(output).toContain("ok (stopped the previous copy's stack)");
  expect(output).toContain("copy: ");
  expect(calls).toContain(PS);
  // The stop ran in the old copy while it still held the old head.
  expect(stopCall(calls)).toBe(`supabase stop --project-id ${PROJECT_ID} cwd=${copy} head=old`);
  expect(calls.indexOf(stopCall(calls))).toBeGreaterThan(calls.indexOf(PS));
  expect(calls.indexOf(stopCall(calls))).toBeLessThan(calls.findIndex((call) => call.startsWith("chown -R")));
  // The stack was re-checked after the stop, and the copy now holds the new head.
  expect(calls.filter((call) => call === PS)).toHaveLength(2);
  expect(marker()).toBe("new");
}, 20_000);

test("does not call supabase stop when no stack is running", () => {
  const { run, marker } = fixture({ stackRunning: false });
  const { status, output, calls } = run();
  expect(status, output).toBe(0);
  expect(output).toContain(`ok (no stack running for ${PROJECT_ID})`);
  expect(calls).toContain(PS);
  expect(stopCall(calls)).toBeUndefined();
  expect(marker()).toBe("new");
}, 20_000);

test("skips the stack check when there is no previous copy", () => {
  const { run, marker } = fixture({ previousCopy: false, stackRunning: false });
  const { status, output, calls } = run();
  expect(status, output).toBe(0);
  expect(output).toContain("ok (no previous copy)");
  expect(calls.some((call) => call.startsWith("docker ") || call.startsWith("supabase "))).toBe(false);
  expect(marker()).toBe("new");
}, 20_000);

test.each([
  ["supabase stop fails", { stopFails: true }, "FAIL: supabase stop failed in the previous copy"],
  ["containers survive supabase stop", { stopLeavesContainers: true }, `FAIL: containers of ${PROJECT_ID} still run after supabase stop`],
])("aborts before touching the copy when %s", (_name, options, message) => {
  const { run, marker } = fixture(options);
  const { status, output, calls } = run();
  expect(status, output).not.toBe(0);
  expect(output).toContain(message);
  expect(output).toContain("one head per container");
  expect(stopCall(calls)).toBeDefined();
  expect(calls.some((call) => call.startsWith("chown -R"))).toBe(false);
  // The old copy and its live stack are left as they were.
  expect(marker()).toBe("old");
}, 20_000);

test("parses, and still runs main when executed rather than sourced", () => {
  expect(spawnSync("bash", ["-n", script], { encoding: "utf8" }).status).toBe(0);
  const dir = mkdtempSync(join(tmpdir(), "cloud-qa-boot-empty-"));
  dirs.push(dir);
  const result = spawnSync("bash", [script, "check"], { cwd: dir, encoding: "utf8" });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("run from the repo root after npm ci");
}, 20_000);
