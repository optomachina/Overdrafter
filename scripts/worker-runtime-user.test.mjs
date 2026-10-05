import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(path.resolve(process.cwd(), "worker/Dockerfile"), "utf8");
const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
const logicalLines = runtimeStage.replace(/\\\n\s*/g, " ").split("\n");

describe("worker image runtime user", () => {
  it("runs the worker and its browsers as the non-root Playwright user", () => {
    const userLines = logicalLines.filter((line) => line.startsWith("USER "));
    expect(userLines).toEqual(["USER pwuser"]);
    const userIndex = logicalLines.indexOf("USER pwuser");
    const cmdIndex = logicalLines.findIndex((line) => line.startsWith("CMD "));
    expect(cmdIndex).toBeGreaterThan(userIndex);
    // No build step may run after the switch; image setup stays root-owned.
    expect(logicalLines.slice(userIndex).some((line) => line.startsWith("RUN "))).toBe(false);
  });

  it("installs Camoufox where the runtime user's cache lookup finds it, with root-owned files", () => {
    expect(runtimeStage).not.toContain("/root/.cache/camoufox");
    const install = logicalLines.find((line) => line.includes("camoufox-bin"));
    expect(install).toContain("unzip -q /tmp/camoufox.zip -d /home/pwuser/.cache/camoufox");
    expect(install).toContain("chown -R root:root /home/pwuser/.cache/camoufox");
    expect(install).toContain("chmod -R a+rX,go-w /home/pwuser/.cache/camoufox");
    // The parent stays pwuser-owned, so the files cannot be edited in place but
    // the tree as a whole is not tamper-proof against the runtime user.
    expect(install).toContain("chown pwuser:pwuser /home/pwuser/.cache");
    const homeIndex = logicalLines.indexOf("ENV HOME=/home/pwuser");
    expect(homeIndex).toBeGreaterThan(-1);
    expect(homeIndex).toBeLessThan(logicalLines.indexOf("USER pwuser"));
  });

  it("keeps the pinned worker temp directory writable only by the runtime user", () => {
    const tempDir = logicalLines.find((line) => line.includes("mkdir -p /root/.cache/overdrafter-worker"));
    expect(tempDir).toContain("chown pwuser:pwuser /root/.cache/overdrafter-worker");
    expect(tempDir).toContain("chmod 0700 /root/.cache/overdrafter-worker");
    expect(tempDir).toContain("chmod 0711 /root /root/.cache");
    const deployScript = readFileSync(path.resolve(process.cwd(), "worker/scripts/deploy-cloud-run.sh"), "utf8");
    expect(deployScript).toContain('"WORKER_TEMP_DIR=/root/.cache/overdrafter-worker"');
  });

  it("keeps the recovery-host launcher on uid 0 because its mounts are root-owned", () => {
    // The image default is pwuser, but the OVD-410/420 recovery launcher bind
    // mounts a root-owned 0700 phase directory and credential directory, and
    // the in-container phase reporter requires a uid-0 marker. Pin the explicit
    // exception so the image switch cannot silently break recovery.
    const control = readFileSync(
      path.resolve(process.cwd(), "scripts/ovd420-recovery-egress-control.sh"),
      "utf8",
    );
    const launch = control.slice(control.indexOf("docker run --rm -it"));
    const launchArgs = launch.slice(0, launch.indexOf("node dist/tools/xometryAuth.js"));
    expect(launchArgs).toMatch(/docker run --rm -it \\\n\s+--user 0:0 \\/);
    expect(launchArgs).toContain("--cap-drop ALL");
    expect(launchArgs).toContain("--security-opt no-new-privileges");
    expect(control).toContain("install -d -o root -g root -m 0700 \"$RECOVERY_PHASE_DIR\"");
    const reporter = readFileSync(path.resolve(process.cwd(), "worker/src/ovd410RecoveryPhase.ts"), "utf8");
    expect(reporter).toContain("options?.expectedUid ?? 0");
    // With every capability dropped, uid 0 has no DAC override, so pwuser's
    // home (0750 in the base image) must be traverse-only for the launcher to
    // reach the Camoufox assets through HOME=/home/pwuser.
    const install = logicalLines.find((line) => line.includes("camoufox-bin"));
    expect(install).toContain("chmod 0711 /home/pwuser");
  });

  it("keeps the documented credential/profile export on uid 0 because it reads and writes the root-owned credential directory", () => {
    const runbook = readFileSync(
      path.resolve(process.cwd(), "docs/workflows/ovd410-stable-egress.md"),
      "utf8",
    );
    const exportRun = workerImageDockerRuns(runbook).find((command) =>
      command.includes("node dist/tools/exportXometryProfile.js"),
    );
    expect(exportRun).toBeDefined();
    expect(exportRun).toMatch(/^sudo docker run --rm --user 0:0 /);
    expect(exportRun).toContain("--network none");
    expect(exportRun).toContain("--volume /var/lib/ovd410-credential:/credential");
    const startup = readFileSync(path.resolve(process.cwd(), "scripts/ovd410-recovery-host-startup.sh"), "utf8");
    expect(startup).toContain('install -d -m 0700 "$CREDENTIAL_DIR"');
  });

  it("gives every documented or scripted docker run of the worker image an explicit uid 0 override", () => {
    // Every documented or scripted run of the worker image on a recovery host
    // writes into root-owned bind mounts, so each one must override the pwuser
    // default. A new run that relies on the image default fails here.
    const sources = [
      ...listFiles("docs").filter((file) => file.endsWith(".md")),
      ...listFiles("scripts").filter((file) => file.endsWith(".sh")),
      ...listFiles("worker/scripts"),
      "worker/README.md",
      "README.md",
    ];
    const runs = sources.flatMap((file) =>
      workerImageDockerRuns(readFileSync(path.resolve(process.cwd(), file), "utf8")).map((command) => ({
        file,
        command,
      })),
    );
    expect(runs.map(({ file }) => file).sort()).toEqual([
      "docs/workflows/ovd410-stable-egress.md",
      "scripts/ovd420-recovery-egress-control.sh",
    ]);
    for (const { file, command } of runs) {
      expect(command, file).toMatch(/docker run --rm (-it )?--user 0:0 /);
    }
  });
});

function listFiles(directory) {
  return readdirSync(path.resolve(process.cwd(), directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(process.cwd(), path.join(entry.parentPath, entry.name)));
}

// Returns each `docker run` command that starts the worker image (it executes a
// compiled worker entry point under dist/), joined across line continuations.
function workerImageDockerRuns(source) {
  const lines = source.split("\n");
  const commands = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/\bdocker run\b/.test(lines[index]) || lines[index].trimStart().startsWith("#")) continue;
    const parts = [lines[index].trim()];
    while (parts.at(-1).endsWith("\\") && index + 1 < lines.length) {
      parts[parts.length - 1] = parts.at(-1).slice(0, -1).trimEnd();
      index += 1;
      parts.push(lines[index].trim());
    }
    const command = parts.join(" ");
    if (/\bdist\/(tools\/|index\.js)/.test(command)) commands.push(command);
  }
  return commands;
}
