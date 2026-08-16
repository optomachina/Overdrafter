import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

async function fakeDockerFixture({ lockExitDelaySeconds, initiallyRunning = true }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ovd373-watchdog-"));
  temporaryDirectories.push(root);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const fakeDocker = path.join(bin, "docker");
  const stateFile = path.join(root, "lock-state");
  const delayCycles = Math.ceil(lockExitDelaySeconds * 10);
  await writeFile(stateFile, initiallyRunning ? "true\n" : "false\n");
  await writeFile(
    fakeDocker,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "wait" ]]; then
  for ((_cycle = 0; _cycle < ${delayCycles}; _cycle += 1)); do
    sleep 0.1
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
  return { root, path: `${bin}:${process.env.PATH}` };
}

describe("OVD-373 locked-command watchdog", () => {
  it("terminates a long command when the lock holder exits", async () => {
    const fixture = await fakeDockerFixture({ lockExitDelaySeconds: 0.1 });
    const helper = path.resolve(process.cwd(), "scripts/run-ovd373-locked-command.sh");
    const startedAt = Date.now();

    await expect(
      execFileAsync(
        "bash",
        [helper, "fake-lock", process.execPath, "-e", "setTimeout(() => {}, 5000)"],
        { cwd: fixture.root, env: { ...process.env, PATH: fixture.path } },
      ),
    ).rejects.toMatchObject({
      code: 75,
      stderr: expect.stringContaining("lock holder exited"),
    });
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

  it("does not start a command when the lock holder is already absent", async () => {
    const fixture = await fakeDockerFixture({
      lockExitDelaySeconds: 10,
      initiallyRunning: false,
    });
    const helper = path.resolve(process.cwd(), "scripts/run-ovd373-locked-command.sh");
    const marker = path.join(fixture.root, "started");

    await expect(
      execFileAsync(
        "bash",
        [helper, "fake-lock", process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'yes')`],
        { cwd: fixture.root, env: { ...process.env, PATH: fixture.path } },
      ),
    ).rejects.toMatchObject({
      code: 75,
      stderr: expect.stringContaining("guarded command was not started"),
    });
    await expect(access(marker)).rejects.toThrow();
  });

  it("force-stops a TERM-resistant command after lock loss", async () => {
    const fixture = await fakeDockerFixture({ lockExitDelaySeconds: 0.1 });
    const helper = path.resolve(process.cwd(), "scripts/run-ovd373-locked-command.sh");
    const startedAt = Date.now();

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
    expect(Date.now() - startedAt).toBeLessThan(4_000);
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
