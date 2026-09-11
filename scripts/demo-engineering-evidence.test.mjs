// @vitest-environment node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("retained evidence demo trust anchor", () => {
  it("rejects a jointly replaced report and matching bundle before producing evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "jarvis-demo-"));
    try {
      symlinkSync(fileURLToPath(new URL("../node_modules/", import.meta.url)), join(root, "node_modules"), "dir");
      const fixture = "server/engineering/fixtures/preview-7mm/";
      for (const file of ["context.json", "preview.json", "native-step.stdout.txt"]) {
        mkdirSync(join(root, fixture), { recursive: true });
        copyFileSync(fixture + file, join(root, fixture, file));
      }
      mkdirSync(join(root, "e2e/fixtures"), { recursive: true });
      copyFileSync("e2e/fixtures/prepared-assembly-context.json", join(root, "e2e/fixtures/prepared-assembly-context.json"));
      const report = JSON.parse(readFileSync(join(root, fixture, "native-step.stdout.txt"), "utf8"));
      report.helperPid += 100;
      const reportText = JSON.stringify(report);
      const bundle = JSON.parse(readFileSync(join(root, fixture, "preview.json"), "utf8"));
      bundle.export.reportSha256 = createHash("sha256").update(reportText).digest("hex");
      writeFileSync(join(root, fixture, "native-step.stdout.txt"), reportText);
      writeFileSync(join(root, fixture, "preview.json"), JSON.stringify(bundle));
      let failure;
      try {
        execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/vite-node/vite-node.mjs", import.meta.url)),
          "--config", fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
          fileURLToPath(new URL("./demo-engineering-evidence.ts", import.meta.url))], { cwd: root, encoding: "utf8", timeout: 10_000, stdio: "pipe" });
      } catch (error) { failure = error; }
      expect(failure?.status).toBe(1);
      expect(failure?.stderr).toContain("retained report identity");
      expect(existsSync(join(root, "output/validation/jarvis-evidence-demo/result.json"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }, 15_000);
});
