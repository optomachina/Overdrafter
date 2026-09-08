import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync("worker/Dockerfile", "utf8");
const logicalLines = dockerfile.replace(/\\\n\s*/g, " ").split("\n");
const absenceGuard = logicalLines.find((line) => line.startsWith("RUN find ") && line.includes("worker-mmdb-inventory"));

function checkImageFixture(databasePath) {
  const root = mkdtempSync(path.join(tmpdir(), "worker-no-geoip-"));
  try {
    for (const name of ["app", "cache", "browsers"]) mkdirSync(path.join(root, name));
    if (databasePath) {
      mkdirSync(path.dirname(path.join(root, databasePath)), { recursive: true });
      writeFileSync(path.join(root, databasePath), "synthetic database sentinel");
    }
    const command = absenceGuard.slice(4)
      .replace("/app /root/.cache /ms-playwright", '"$FIXTURE_ROOT/app" "$FIXTURE_ROOT/cache" "$FIXTURE_ROOT/browsers"')
      .replaceAll("/tmp/worker-mmdb-inventory", '"$FIXTURE_ROOT/inventory"');
    return spawnSync("/bin/sh", ["-c", command], {
      env: { PATH: process.env.PATH, FIXTURE_ROOT: root }, encoding: "utf8", timeout: 5000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("GeoIP-free worker image contract", () => {
  it("removes database sources and the acquiring CLI while preserving browser pins", () => {
    expect(dockerfile).not.toMatch(/CAMOUFOX_GEOIP|P3TERX|GeoLite2-City/);
    expect(dockerfile).toContain("camoufox-152.0.4-beta.28-lin.x86_64.zip");
    expect(dockerfile).toContain("924f3109ccd6d47cd6a0384d67a345fadf975d48b6319f8dbbd5954c588982bd");
    expect(dockerfile).toContain("ublock_origin-1.73.0.xpi");
    expect(dockerfile).toContain("bccc51a773150af4af6e1fd62c7bfdeb7238b79ff2381b998fa9f2e38f64786a");
    const pkg = JSON.parse(readFileSync("worker/package.json", "utf8"));
    expect(pkg.scripts["install:camoufox"]).toBe("node scripts/install-camoufox.mjs");
    expect(Object.values(pkg.scripts).join("\n")).not.toMatch(/camoufox.*fetch/);
    expect(absenceGuard).toBeDefined();
    expect(dockerfile.indexOf(absenceGuard.split(" &&")[0])).toBeGreaterThan(dockerfile.indexOf("COPY --from=build /app/dist ./dist"));
  });

  it("accepts a database-free image filesystem", () => {
    const result = checkImageFixture();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
  });

  it.each(["cache/camoufox/GeoLite2-City.mmdb", "app/node_modules/nested/database.mmdb", "browsers/hidden.MMDB"])(
    "rejects a database at %s without relying on its checksum", (file) => {
      const result = checkImageFixture(file);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
    },
  );
});
