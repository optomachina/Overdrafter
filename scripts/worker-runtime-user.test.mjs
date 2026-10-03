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

  it("installs Camoufox where the runtime user's cache lookup finds it, read-only to that user", () => {
    expect(runtimeStage).not.toContain("/root/.cache/camoufox");
    const install = logicalLines.find((line) => line.includes("camoufox-bin"));
    expect(install).toContain("unzip -q /tmp/camoufox.zip -d /home/pwuser/.cache/camoufox");
    expect(install).toContain("chown -R root:root /home/pwuser/.cache/camoufox");
    expect(install).toContain("chmod -R a+rX,go-w /home/pwuser/.cache/camoufox");
  });

  it("keeps the pinned worker temp directory writable only by the runtime user", () => {
    const tempDir = logicalLines.find((line) => line.includes("mkdir -p /root/.cache/overdrafter-worker"));
    expect(tempDir).toContain("chown pwuser:pwuser /root/.cache/overdrafter-worker");
    expect(tempDir).toContain("chmod 0700 /root/.cache/overdrafter-worker");
    expect(tempDir).toContain("chmod 0711 /root /root/.cache");
    const deployScript = readFileSync(path.resolve(process.cwd(), "worker/scripts/deploy-cloud-run.sh"), "utf8");
    expect(deployScript).toContain('"WORKER_TEMP_DIR=/root/.cache/overdrafter-worker"');
  });
});
