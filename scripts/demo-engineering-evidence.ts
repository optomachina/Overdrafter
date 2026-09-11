import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import occtImport from "occt-import-js";
import { importContext } from "../src/features/engineering/prepared-workflow";
import { interpretPreparedMessage } from "../src/features/engineering/prepared-conversation";
import { cumulativePreviewSource } from "../src/lib/engineering-cumulative-preview";
import { verifyStoredNativePreview, type NativePreviewAdmission } from "../server/engineering/native-preview-bytes";

/** Reproduce a bounded retained-evidence demonstration, never dispatch CAD.
 * Process/registry admission is explicitly simulated. The interpreted proposal
 * and retained export are separate observations, not a connected execution.
 */
async function main() {
  const request = "set depth to 7 mm";
  const workbench = await importContext(readFileSync("e2e/fixtures/prepared-assembly-context.json", "utf8"));
  const reply = interpretPreparedMessage(request, workbench);
  assert.equal(reply.kind, "proposal");
  if (reply.kind !== "proposal") throw new Error("Expected one supported proposal.");
  assert.equal(reply.proposal.depthMm, 7);

  const root = "server/engineering/fixtures/preview-7mm/";
  const contextText = readFileSync(root + "context.json", "utf8"), context = JSON.parse(contextText);
  const bytes = { bundle: new Uint8Array(readFileSync(root + "preview.json")),
    report: new Uint8Array(readFileSync(root + "native-step.stdout.txt")) };
  const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  // Independent pins from the retained context and documented sanitized export.
  // A jointly rewritten report/bundle must not re-issue its own demo admission.
  assert.equal(hash(new TextEncoder().encode(contextText)),
    "7a180e25dab6203a3c07a715c5006785bd9c4b085da256b34fca0c52a6115e31", "retained context identity");
  assert.equal(hash(bytes.report),
    "a7cf12896045d4c1c2df3ed881fbf5bce46a901209ebdad1447a300dee6333cd", "retained report identity");
  assert.equal(hash(bytes.bundle),
    "e584aacdb417f209c4fbfe5944e018ba9fa6164a2e09954a5900404e9707adf5", "retained bundle identity");
  const report = JSON.parse(new TextDecoder().decode(bytes.report));
  const bundle = JSON.parse(new TextDecoder().decode(bytes.bundle));
  const admission: NativePreviewAdmission = {
    exportId: "11111111-1111-4111-8111-000000000001", scope: context.scope, snapshotId: context.snapshotId,
    contextSha256: hash(new TextEncoder().encode(contextText)), sourceCommit: bundle.export.sourceCommit,
    process: { nativePid: report.nativePid, nativeStartTicks: report.nativeStartTicks,
      helperPid: report.helperPid, candidateRoot: report.candidateRoot },
    objects: (["bundle", "report"] as const).map((role, index) => ({
      id: `11111111-1111-4111-8111-00000000000${index + 2}`, role, bytes: bytes[role].length, sha256: hash(bytes[role]),
    })),
  };
  const result = await verifyStoredNativePreview(contextText, admission, async (id) => {
    const object = admission.objects.find((entry) => entry.id === id);
    assert.ok(object, "Only registered fixture objects can be read.");
    return new Response(bytes[object.role]);
  });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("Missing retained preview.");
  assert.equal(context.depthMm, reply.proposal.depthMm);
  const step = await cumulativePreviewSource(result.preview).loadStepBuffer();
  const occt = await occtImport();
  const geometry = occt.ReadStepFile(step, { linearUnit: "millimeter",
    linearDeflectionType: "bounding_box_ratio", linearDeflection: 0.0025, angularDeflection: 0.35 });
  assert.ok(geometry.success); assert.equal(geometry.meshes.length, 2);
  const meshes = geometry.meshes.map((mesh) => {
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity];
    mesh.attributes.position.array.forEach((coordinate, index) => {
      assert.ok(Number.isFinite(coordinate));
      minimum[index % 3] = Math.min(minimum[index % 3], coordinate);
      maximum[index % 3] = Math.max(maximum[index % 3], coordinate);
    });
    return { name: mesh.name, minimumMm: minimum, maximumMm: maximum,
      depthMm: maximum[2] - minimum[2], triangles: mesh.index.array.length / 3 };
  });
  const target = meshes.find((mesh) => mesh.name === "baseline-5mm");
  const companion = meshes.find((mesh) => mesh.name === "candidate-8mm");
  assert.ok(target && companion);
  assert.ok(Math.abs(target.depthMm - 7) < 1e-6 && Math.abs(companion.depthMm - 8) < 1e-6);
  assert.ok(Math.abs(companion.minimumMm[0] - target.minimumMm[0] - 40) < 1e-6);

  const evidence = {
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingTreeDirty: execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).length > 0,
    request, interpretation: "local proposal only", targetPart: "parts/baseline-5mm.SLDPRT",
    status: "retained-preview-verified", connectedExecution: false, freshNativeRun: false,
    admission: "simulated fixture registry and process", requestResultLineage: "not established",
    snapshotId: result.snapshotId, contextSha256: result.contextSha256,
    qualifiedExportSource: admission.sourceCommit, derivedReportSha256: hash(bytes.report),
    bundleSha256: hash(bytes.bundle), step: { bytes: step.length, sha256: hash(step) }, meshes,
  };
  const output = "output/validation/jarvis-evidence-demo";
  mkdirSync(output, { recursive: true });
  writeFileSync(output + "/preview-7mm.step", step);
  writeFileSync(output + "/result.json", JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
}

await main();
