import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(path.resolve(process.cwd(), "worker/Dockerfile"), "utf8");
const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
const lines = runtimeStage.split("\n");
const pinnedUrl = "https://github.com/P3TERX/GeoLite.mmdb/releases/download/2026.09.04/GeoLite2-City.mmdb";
const pinnedSha = "85974cd715333c1dab9e23fa0685483a8c9316d372e69164f836d1f812c41ff8";
const rejection = "GeoIP build inputs require an exact dated P3TERX URL and lowercase SHA-256\n";

function validatorInstruction() {
  const instructions = lines.filter(
    (line) => line.startsWith('RUN ["node", "-e", ') && line.includes("CAMOUFOX_GEOIP_URL"),
  );
  expect(instructions).toHaveLength(1);
  return instructions[0];
}

// Execute only the exact metadata validator, with no inherited credentials or worker code.
function validateInputs(url = pinnedUrl, sha = pinnedSha, omit = []) {
  const [command, ...args] = JSON.parse(validatorInstruction().slice(4));
  expect(command).toBe("node");
  const env = { CAMOUFOX_GEOIP_URL: url, CAMOUFOX_GEOIP_SHA256: sha };
  for (const key of omit) delete env[key];
  return spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 5_000 });
}

function expectRejected(result) {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(rejection);
}

describe("worker GeoIP build inputs", () => {
  it("pins the independently verified dated URL and checksum together before runtime network commands", () => {
    expect(lines.filter((line) => line.startsWith("ARG CAMOUFOX_GEOIP_URL=")))
      .toEqual([`ARG CAMOUFOX_GEOIP_URL=${pinnedUrl}`]);
    expect(lines.filter((line) => line.startsWith("ARG CAMOUFOX_GEOIP_SHA256=")))
      .toEqual([`ARG CAMOUFOX_GEOIP_SHA256=${pinnedSha}`]);
    const validatorIndex = runtimeStage.indexOf(validatorInstruction());
    expect(validatorIndex).toBeGreaterThan(runtimeStage.indexOf(`ARG CAMOUFOX_GEOIP_SHA256=${pinnedSha}`));
    expect(validatorIndex).toBeLessThan(runtimeStage.indexOf("RUN apt-get update"));
    expect(validatorIndex).toBeLessThan(runtimeStage.indexOf("RUN ./node_modules/.bin/playwright"));
  });

  it.each([pinnedUrl, pinnedUrl.replace("2026.09.04", "2024.02.29"), pinnedUrl.replace("2026.09.04", "2000.02.29")])(
    "accepts an exact real-date URL without normalization: %s", (url) => {
      const result = validateInputs(url);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    },
  );

  it.each([
    "", "latest", pinnedUrl.replace("2026.09.04", "latest"),
    pinnedUrl.replace("https:", "http:"), pinnedUrl.replace("https:", "file:"),
    pinnedUrl.replace("github.com", "example.com"),
    pinnedUrl.replace("github.com", "github.com.example.com"),
    pinnedUrl.replace("github.com", "github.com:443"),
    pinnedUrl.replace("github.com", "user:secret@github.com"),
    pinnedUrl.replace("P3TERX", "another-owner"),
    pinnedUrl.replace("GeoLite.mmdb", "another-repository"),
    pinnedUrl.replace("GeoLite2-City.mmdb", "GeoLite2-Country.mmdb"),
    pinnedUrl.replace("/releases/download/", "/releases/latest/download/"),
    pinnedUrl.replace("2026.09.04", "2026.02.29"),
    pinnedUrl.replace("2026.09.04", "1900.02.29"),
    pinnedUrl.replace("2026.09.04", "2026.04.31"),
    pinnedUrl.replace("2026.09.04", "2026.00.04"),
    pinnedUrl.replace("2026.09.04", "2026.13.04"),
    pinnedUrl.replace("2026.09.04", "2026.09.00"),
    pinnedUrl.replace("2026.09.04", "2026.09.31"),
    pinnedUrl.replace("2026.09.04", "2026.9.4"),
    pinnedUrl.replace("2026.09.04", "2026-09-04"),
    pinnedUrl.replace("2026.09.04", "2026%2E09%2E04"),
    pinnedUrl.replace("/2026.09.04/", "/other/../2026.09.04/"),
    `${pinnedUrl}?token=secret`, `${pinnedUrl}#secret`, `${pinnedUrl}/`,
    ` ${pinnedUrl}`, `${pinnedUrl} `, `${pinnedUrl}\n`, `${pinnedUrl}\r\n`,
    `\n${pinnedUrl}`, "$(exit 0)",
  ])("rejects non-exact URL %j without echoing its contents", (url) => {
    expectRejected(validateInputs(url));
  });

  it.each([
    "", pinnedSha.slice(0, 63), `${pinnedSha}0`, pinnedSha.toUpperCase(),
    "g".repeat(64), ` ${pinnedSha}`, `${pinnedSha} `, `${pinnedSha}\n`,
    `${pinnedSha.slice(0, 63)}\n`, `sha256:${pinnedSha}`, "$(exit 0)",
  ])("rejects malformed checksum %j without echoing it", (sha) => {
    expectRejected(validateInputs(pinnedUrl, sha));
  });

  it.each(["CAMOUFOX_GEOIP_URL", "CAMOUFOX_GEOIP_SHA256"])("rejects absent %s", (key) => {
    expectRejected(validateInputs(pinnedUrl, pinnedSha, [key]));
  });
});

// Isolate two exact Docker shell commands. Fake curl never opens a network socket;
// the checksum command adapter verifies fixture bytes using Node's SHA-256 implementation.
function geoipDownloadBlock() {
  const index = lines.findIndex((line) => line.includes('curl ') && line.includes('"$CAMOUFOX_GEOIP_URL"'));
  expect(index).toBeGreaterThan(-1);
  const download = lines[index].trim();
  const checksum = lines[index + 1].trim();
  expect(download).toMatch(/^&& curl /);
  expect(download).toContain("-fsSL");
  expect(download).toContain("--proto '=https'");
  expect(download).toContain("--proto-redir '=https'");
  expect(download).toContain("--connect-timeout 15");
  expect(download).toContain("--max-time 120");
  expect(download).not.toMatch(/--retry|\|\|/);
  expect(checksum).toBe('&& echo "$CAMOUFOX_GEOIP_SHA256  /root/.cache/camoufox/GeoLite2-City.mmdb" | sha256sum -c - \\');
  return `${download.replace(/^&& /, "").replace(/\\$/, "")} ${checksum.replace(/\\$/, "")}`
    .replaceAll("/root/.cache/camoufox/GeoLite2-City.mmdb", "$GEOIP_TEST_DEST");
}

function runDownload(mode) {
  const root = mkdtempSync(path.join(tmpdir(), "worker-geoip-contract-"));
  const fixture = Buffer.from("synthetic offline GeoIP fixture\n");
  const fixturePath = path.join(root, "fixture.mmdb");
  const marker = path.join(root, "continued");
  const calls = path.join(root, "calls");
  try {
    writeFileSync(fixturePath, fixture);
    const curl = path.join(root, "curl");
    writeFileSync(curl, `#!${process.execPath}\n` +
      "const fs = require('node:fs'); fs.appendFileSync(process.env.GEOIP_TEST_CALLS, 'curl\\n');\n" +
      "if (process.env.GEOIP_TEST_MODE === 'download-failure') process.exit(22);\n" +
      "const args = process.argv.slice(2); const output = args[args.indexOf('-o') + 1];\n" +
      "if (!output) process.exit(2); fs.copyFileSync(process.env.GEOIP_TEST_FIXTURE, output);\n");
    chmodSync(curl, 0o700);
    const checksum = path.join(root, "sha256sum");
    writeFileSync(checksum, `#!${process.execPath}\n` +
      "const fs = require('node:fs'); const crypto = require('node:crypto');\n" +
      "fs.appendFileSync(process.env.GEOIP_TEST_CALLS, 'sha256sum\\n');\n" +
      "if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(['-c', '-'])) process.exit(2);\n" +
      "const row = fs.readFileSync(0, 'utf8'); const match = /^([a-f0-9]{64})  (.+)\\n$/.exec(row);\n" +
      "if (!match) process.exit(2); const hash = crypto.createHash('sha256').update(fs.readFileSync(match[2])).digest('hex');\n" +
      "process.exit(hash === match[1] ? 0 : 1);\n");
    chmodSync(checksum, 0o700);
    const expectedSha = mode === "wrong-bytes" ? "0".repeat(64) : createHash("sha256").update(fixture).digest("hex");
    const result = spawnSync("/bin/sh", ["-c", `${geoipDownloadBlock()} && : > "$GEOIP_TEST_MARKER"`], {
      env: {
        PATH: root,
        CAMOUFOX_GEOIP_URL: pinnedUrl,
        CAMOUFOX_GEOIP_SHA256: expectedSha,
        GEOIP_TEST_DEST: path.join(root, "download.mmdb"),
        GEOIP_TEST_MARKER: marker,
        GEOIP_TEST_CALLS: calls,
        GEOIP_TEST_MODE: mode,
        GEOIP_TEST_FIXTURE: fixturePath,
      },
      encoding: "utf8", timeout: 5_000,
    });
    return { result, continued: existsSync(marker), calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("worker GeoIP offline download/checksum control flow", () => {
  it("stops at a download failure without checksum or subsequent work", () => {
    const { result, continued, calls } = runDownload("download-failure");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(22);
    expect(continued).toBe(false);
    expect(calls).toBe("curl\n");
  });

  it("rejects downloaded bytes with the wrong hash before subsequent work", () => {
    const { result, continued, calls } = runDownload("wrong-bytes");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(continued).toBe(false);
    expect(calls).toBe("curl\nsha256sum\n");
  });

  it("continues only after downloaded fixture bytes match the checksum", () => {
    const { result, continued, calls } = runDownload("correct-bytes");
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(continued).toBe(true);
    expect(calls).toBe("curl\nsha256sum\n");
  });
});
