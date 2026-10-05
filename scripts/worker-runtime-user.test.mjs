import { readFileSync } from "node:fs";
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
});
