import { execFile, spawnSync } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function resolveExecutable(name) {
  const result = spawnSync("bash", ["-c", 'command -v -- "$1"', "bash", name], {
    encoding: "utf8",
  });
  const resolved = result.stdout.trim();
  if (result.status !== 0 || !path.isAbsolute(resolved)) {
    throw new Error(`could not resolve ${name} on PATH`);
  }
  return resolved;
}

const realSleep = resolveExecutable("sleep");
const realPkill = resolveExecutable("pkill");

async function fakeDockerFixture({
  lockExitDelaySeconds,
  initiallyRunning = true,
  recordWatchdogSchedule = false,
}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovd373-watchdog-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const fakeDocker = path.join(bin, "docker");
  const stateFile = path.join(root, "lock-state");
  const scheduleLog = path.join(root, "watchdog-schedule");
  const delayCycles = Math.ceil(lockExitDelaySeconds * 10);
  await writeFile(stateFile, initiallyRunning ? "true\n" : "false\n");
  if (recordWatchdogSchedule) {
    // The helper's only timers are `sleep` calls and its escalation steps are
    // `pkill` calls, both resolved through PATH. These shims record every
    // requested sleep and every pkill signal in order, so the test can pin the
    // helper's poll interval and TERM grace budget from its own schedule
    // instead of comparing wall-clock time, which stalls and CPU contention
    // stretch. The shim waits only 10 ms per requested sleep; the schedule,
    // not the elapsed time, is what the assertions check.
    await writeFile(
      path.join(bin, "sleep"),
      `#!/usr/bin/env bash
printf 'sleep %s\\n' "$*" >> ${JSON.stringify(scheduleLog)}
exec ${JSON.stringify(realSleep)} 0.01
`,
    );
    await writeFile(
      path.join(bin, "pkill"),
      `#!/usr/bin/env bash
printf 'pkill %s\\n' "$1" >> ${JSON.stringify(scheduleLog)}
exec ${JSON.stringify(realPkill)} "$@"
`,
    );
    await chmod(path.join(bin, "sleep"), 0o755);
    await chmod(path.join(bin, "pkill"), 0o755);
  }
  await writeFile(
    fakeDocker,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "wait" ]]; then
  for ((_cycle = 0; _cycle < ${delayCycles}; _cycle += 1)); do
    ${JSON.stringify(realSleep)} 0.1
  done
  echo false > ${JSON.stringify(stateFile)}
  echo 1
elif [[ "$1" = "inspect" ]]; then
  cat ${JSON.stringify(stateFile)}
else
  exit 2
fi
`,
  );
  await chmod(fakeDocker, 0o755);
  return { root, scheduleLog, path: `${bin}:${process.env.PATH}` };
}

describe("OVD-373 locked-command watchdog", () => {
  it("terminates a long command when the lock holder exits", async () => {
    const fixture = await fakeDockerFixture({ lockExitDelaySeconds: 0.1 });
    const helper = path.resolve(process.cwd(), "scripts/run-ovd373-locked-command.sh");
    const admissionMarker = path.join(fixture.root, "push-admitted");
    const startedAt = Date.now();

    await expect(
      execFileAsync(
        "bash",
        [
          helper,
          "--admission-marker",
          admissionMarker,
          "fake-lock",
          process.execPath,
          "-e",
          "setTimeout(() => {}, 5000)",
        ],
        { cwd: fixture.root, env: { ...process.env, PATH: fixture.path } },
      ),
    ).rejects.toMatchObject({
      code: 75,
      stderr: expect.stringContaining("lock holder exited"),
    });
    await expect(access(admissionMarker)).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("returns the command result while the lock holder remains alive", async () => {
    const fixture = await fakeDockerFixture({ lockExitDelaySeconds: 10 });
    const helper = path.resolve(process.cwd(), "scripts/run-ovd373-locked-command.sh");

    await expect(
      execFileAsync(
        "bash",
        [helper, "fake-lock", process.execPath, "-e", "process.exit(0)"],
        { cwd: fixture.root, env: { ...process.env, PATH: fixture.path } },
      ),
    ).resolves.toMatchObject({ stdout: "" });
  });

  it("preserves stdin for a guarded command", async () => {
    const fixture = await fakeDockerFixture({ lockExitDelaySeconds: 10 });
    const helper = path.resolve(process.cwd(), "scripts/run-ovd373-locked-command.sh");
    const result = spawnSync(
      "bash",
      [
        helper,
        "fake-lock",
        process.execPath,
        "-e",
        "process.stdin.setEncoding('utf8'); let value=''; process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => process.stdout.write(value));",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: { ...process.env, PATH: fixture.path },
        input: "schema evidence\n",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("schema evidence\n");
  });

  it("does not start a command when the lock holder is already absent", async () => {
    const fixture = await fakeDockerFixture({
      lockExitDelaySeconds: 10,
      initiallyRunning: false,
    });
    const helper = path.resolve(process.cwd(), "scripts/run-ovd373-locked-command.sh");
    const commandMarker = path.join(fixture.root, "started");
    const admissionMarker = path.join(fixture.root, "push-admitted");

    await expect(
      execFileAsync(
        "bash",
        [
          helper,
          "--admission-marker",
          admissionMarker,
          "fake-lock",
          process.execPath,
          "-e",
          `require('fs').writeFileSync(${JSON.stringify(commandMarker)}, 'yes')`,
        ],
        { cwd: fixture.root, env: { ...process.env, PATH: fixture.path } },
      ),
    ).rejects.toMatchObject({
      code: 75,
      stderr: expect.stringContaining("guarded command was not started"),
    });
    await expect(access(admissionMarker)).rejects.toThrow();
    await expect(access(commandMarker)).rejects.toThrow();
  });

  it("force-stops a TERM-resistant command after lock loss", async () => {
    const fixture = await fakeDockerFixture({
      lockExitDelaySeconds: 0.1,
      recordWatchdogSchedule: true,
    });
    const helper = path.resolve(process.cwd(), "scripts/run-ovd373-locked-command.sh");

    await expect(
      execFileAsync(
        "bash",
        [
          helper,
          "fake-lock",
          process.execPath,
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
        ],
        { cwd: fixture.root, env: { ...process.env, PATH: fixture.path } },
      ),
    ).rejects.toMatchObject({ code: 75 });

    // The helper has exited, so its watchdog schedule is complete. Before lock
    // loss the watchdog polls every 0.1 s; after lock loss it sends TERM,
    // waits exactly 20 x 0.1 s (the 2 s TERM grace budget), then escalates
    // to KILL. The final TERM is the helper's own cleanup of the lock waiter.
    const schedule = (await readFile(fixture.scheduleLog, "utf8")).trimEnd().split("\n");
    const termIndex = schedule.indexOf("pkill -TERM");
    expect(termIndex, schedule.join("\n")).toBeGreaterThanOrEqual(0);
    expect(schedule.slice(0, termIndex).every((entry) => entry === "sleep 0.1")).toBe(true);
    expect(schedule.slice(termIndex + 1)).toEqual([
      ...Array.from({ length: 20 }, () => "sleep 0.1"),
      "pkill -KILL",
      "pkill -TERM",
    ]);
  }, 6_000);

  it("preserves a guarded command's nonzero exit while the lock remains alive", async () => {
    const fixture = await fakeDockerFixture({ lockExitDelaySeconds: 10 });
    const helper = path.resolve(process.cwd(), "scripts/run-ovd373-locked-command.sh");

    await expect(
      execFileAsync(
        "bash",
        [helper, "fake-lock", process.execPath, "-e", "process.exit(23)"],
        { cwd: fixture.root, env: { ...process.env, PATH: fixture.path } },
      ),
    ).rejects.toMatchObject({ code: 23 });
  });
});
