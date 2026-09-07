import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const dockerfile = readFileSync(path.join(root, "worker/Dockerfile"), "utf8");
const instructions = dockerfile.replace(/\\\n\s*/g, " ").split("\n").map((line) => line.replace(/\s+/g, " ").trim());
const checksumPath = "/tmp/worker-package-inputs.sha256";
const directories = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ovd419-package-inputs-test-"));
  directories.push(directory);
  for (const name of ["package.json", "package-lock.json"]) {
    writeFileSync(path.join(directory, name), readFileSync(path.join(root, "worker", name)));
  }
  return directory;
}
function shell(command, cwd) {
  return spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8", timeout: 5_000 });
}
function snapshot(directory) {
  return shell("sha256sum package.json package-lock.json > inputs.sha256", directory);
}
function check(directory) {
  return shell("sha256sum -c inputs.sha256", directory);
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("worker package-input immutability", () => {
  it("snapshots before npm ci, checks after install and no-save production prune", () => {
    expect(instructions).toContain("RUN sha256sum package.json package-lock.json > " + checksumPath +
      " && npm ci && sha256sum -c " + checksumPath);
    const prune = "RUN npm prune --omit=dev --no-save && sha256sum -c " + checksumPath;
    expect(instructions).toContain(prune);
    expect(instructions.indexOf("RUN npm run build")).toBeLessThan(instructions.indexOf(prune));
    expect(dockerfile).toContain("COPY --from=build /app/package.json /app/package-lock.json ./");
    expect(dockerfile).not.toContain("--package-lock=false");
  });

  it("accepts unchanged source bytes without rewriting expectations", () => {
    const directory = fixture();
    expect(snapshot(directory).status).toBe(0);
    expect(check(directory).status).toBe(0);
  });

  it("rejects precisely the observed three peer metadata additions (+60 bytes)", () => {
    const directory = fixture();
    const lockPath = path.join(directory, "package-lock.json");
    const before = readFileSync(lockPath);
    expect(snapshot(directory).status).toBe(0);
    const lock = JSON.parse(before);
    for (const name of ["browserslist", "playwright-core", "zod"]) {
      expect(lock.packages["node_modules/" + name].peer).toBeUndefined();
      lock.packages["node_modules/" + name].peer = true;
    }
    const after = Buffer.from(JSON.stringify(lock, null, 2) + "\n");
    expect(after.length - before.length).toBe(60);
    writeFileSync(lockPath, after);
    expect(check(directory).status).not.toBe(0);
  });

  it.each(["version", "integrity"])("rejects a same-size real dependency %s change", (field) => {
    const directory = fixture();
    expect(snapshot(directory).status).toBe(0);
    const lockPath = path.join(directory, "package-lock.json");
    const before = readFileSync(lockPath);
    const lock = JSON.parse(before);
    const entry = lock.packages["node_modules/zod"];
    if (field === "version") entry.version = entry.version.replace(/\d/, (digit) => digit === "9" ? "8" : "9");
    else entry.integrity = entry.integrity.replace(/.$/, (last) => last === "=" ? "A" : "=");
    const after = Buffer.from(JSON.stringify(lock, null, 2) + "\n");
    expect(after.length).toBe(before.length);
    expect(hash(after)).not.toBe(hash(before));
    writeFileSync(lockPath, after);
    expect(check(directory).status).not.toBe(0);
  });

  it("rejects changed package.json as well as the lockfile", () => {
    const directory = fixture();
    expect(snapshot(directory).status).toBe(0);
    writeFileSync(path.join(directory, "package.json"), "{}\n");
    expect(check(directory).status).not.toBe(0);
  });

  it("still prunes a real offline dev-only fixture without changing production identity or package inputs", () => {
    const directory = fixture();
    const prod = "ovd419-production-fixture";
    const dev = "ovd419-development-fixture";
    const packageJson = { name: "ovd419-prune-fixture", version: "1.0.0",
      dependencies: { [prod]: "1.0.0" }, devDependencies: { [dev]: "1.0.0" } };
    const packages = { "": packageJson,
      ["node_modules/" + prod]: { version: "1.0.0" },
      ["node_modules/" + dev]: { version: "1.0.0", dev: true } };
    writeFileSync(path.join(directory, "package.json"), JSON.stringify(packageJson));
    writeFileSync(path.join(directory, "package-lock.json"), JSON.stringify({
      name: packageJson.name, version: "1.0.0", lockfileVersion: 3, requires: true, packages,
    }));
    for (const name of [prod, dev]) {
      mkdirSync(path.join(directory, "node_modules", name), { recursive: true });
      writeFileSync(path.join(directory, "node_modules", name, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
    }
    const prodPath = path.join(directory, "node_modules", prod, "package.json");
    const prodHash = hash(readFileSync(prodPath));
    for (const name of ["user.npmrc", "global.npmrc"]) writeFileSync(path.join(directory, name), "");
    expect(snapshot(directory).status).toBe(0);
    const prune = instructions.find((line) => line.startsWith("RUN npm prune "));
    expect(prune).toBeDefined();
    const pruneArgs = prune.split(" && ")[0].slice("RUN npm ".length).split(" ");
    const result = spawnSync("npm", [...pruneArgs, "--offline", "--ignore-scripts", "--no-audit",
      "--no-fund", "--update-notifier=false", "--registry=http://127.0.0.1:9",
      "--cache=" + directory + "/cache", "--userconfig=" + directory + "/user.npmrc",
      "--globalconfig=" + directory + "/global.npmrc"], {
      cwd: directory, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(directory, "node_modules", dev))).toBe(false);
    expect(hash(readFileSync(prodPath))).toBe(prodHash);
    expect(check(directory).status).toBe(0);
  });
});
