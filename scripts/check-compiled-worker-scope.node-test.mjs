import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildEvidence, checkScopes } from "./check-compiled-worker-scope.mjs";

test("locked offline build matches retained scopes; same-version stale compiled scope fails", () => {
  const temporary = mkdtempSync(join(tmpdir(), "compiled-scope-test-"));
  try {
    const packetPath = new URL("./fixtures/compiled-worker-scope.json", import.meta.url);
    const packet = JSON.parse(readFileSync(packetPath));
    const output = join(temporary, "evidence");
    assert.throws(() => buildEvidence("0".repeat(40), packetPath, output));
    const manifest = buildEvidence(packet.sourceRevision, packetPath, output);
    assert.equal(manifest.cases.length, packet.cases.length);
    assert.equal(manifest.imageQualified, false);
    const buildRoot = join(output, "source");
    const packagePath = join(buildRoot, "worker/package.json");
    const packageBefore = readFileSync(packagePath, "utf8");
    const modulePath = join(buildRoot, "worker/dist/quoteScope.js");
    const compiled = readFileSync(modulePath, "utf8");
    // Simulate a stale artifact that loses confirmation binding but still reports 0.1.0.
    const stale = compiled.replace("confirmationRevision,", 'confirmationRevision: "999",');
    assert.notEqual(stale, compiled);
    writeFileSync(modulePath, stale);
    assert.equal(readFileSync(packagePath, "utf8"), packageBefore);
    assert.equal(JSON.parse(packageBefore).version, manifest.workerVersion);
    assert.throws(() => checkScopes(buildRoot, packet), /Compiled scope mismatch: confirmed-destination-active-deadline/);
    assert.throws(() => buildEvidence(packet.sourceRevision, packetPath, output), /EEXIST/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
