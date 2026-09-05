import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(path.resolve(process.cwd(), "worker/Dockerfile"), "utf8");
const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
const fullSha = "0123456789abcdef0123456789abcdef01234567";

// Execute only the Dockerfile's metadata validator, never Docker or the worker.
function validateVersion(value) {
  const instruction = runtimeStage.split("\n").find(
    (line) => line.startsWith('RUN ["node", "-e", ') && line.includes("WORKER_BUILD_VERSION"),
  );
  expect(instruction).toBeDefined();
  const [command, ...args] = JSON.parse(instruction.slice(4));
  expect(command).toBe("node");
  return spawnSync(process.execPath, args, {
    env: { WORKER_BUILD_VERSION: value },
    encoding: "utf8",
    timeout: 5_000,
  });
}

describe("worker image build version", () => {
  it("bakes the exact argument into the final image with an unqualified default", () => {
    const lines = runtimeStage.split("\n");
    const argumentIndex = lines.indexOf("ARG WORKER_BUILD_VERSION=unknown");
    const environmentIndex = lines.indexOf("ENV WORKER_BUILD_VERSION=${WORKER_BUILD_VERSION}");
    expect(argumentIndex).toBeGreaterThan(-1);
    expect(environmentIndex).toBeGreaterThan(argumentIndex);
    expect(lines.filter((line) => line.startsWith("ENV WORKER_BUILD_VERSION="))).toHaveLength(1);
    expect(lines[environmentIndex + 1]).toMatch(/^RUN \["node", "-e", /);
    expect(runtimeStage).toContain('CMD ["node", "dist/index.js"]');
  });

  it.each([fullSha, "unknown"])("accepts %s without output or normalization", (value) => {
    const result = validateVersion(value);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it.each([
    "",
    fullSha.slice(0, 7),
    fullSha.slice(0, 39),
    `${fullSha}0`,
    fullSha.toUpperCase(),
    `${fullSha}-dirty`,
    ` ${fullSha}`,
    `${fullSha} `,
    `${fullSha}\n`,
    `${fullSha.slice(0, 39)}\n`,
    "main",
    "v1.0",
    "UNKNOWN",
    "unknown\n",
    "$(exit 0)",
  ])("rejects malformed version %j without echoing it", (value) => {
    const result = validateVersion(value);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "WORKER_BUILD_VERSION must be unknown or a full lowercase Git SHA\n",
    );
  });
});
