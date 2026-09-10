import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RegisteredResultObject, ResultReadAdmission } from "./native-result-bytes";

const directory = "server/engineering/fixtures/";
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/**
 * Read retained synthetic native bytes and rebind report identities for a test.
 * Optional inputs connect disjoint database fixtures; their process admission
 * and rebound reports are simulations, never new native qualification evidence.
 */
export function storedNativeFixture(input?: { contextText: string; jobText: string }) {
  const data = JSON.parse(readFileSync(directory + "prepared-reports.json", "utf8"));
  if (input) { data.context = JSON.parse(input.contextText); data.job = JSON.parse(input.jobText); }
  const contextText = input?.contextText ?? JSON.stringify(data.context);
  data.job.contextSha256 = hash(new TextEncoder().encode(contextText));
  const jobText = input?.jobText ?? JSON.stringify(data.job), requestSha256 = hash(new TextEncoder().encode(jobText));
  for (const report of [data.native, data.result]) {
    report.jobId = data.job.jobId; report.attemptId = data.job.attemptId;
  }
  Object.assign(data.result, { scope: data.job.scope, fence: data.job.fence, inputSnapshotId: data.job.inputSnapshotId,
    outputSnapshotId: data.job.outputSnapshotId, completedAt: data.job.createdAt });
  for (const report of [data.result, data.identity, data.native]) {
    report.requestSha256 = requestSha256; report.contextSha256 = data.job.contextSha256;
  }
  const bytes = {
    assembly: new Uint8Array(readFileSync(directory + "candidate/synthetic-assembly.SLDASM")),
    target: new Uint8Array(readFileSync(directory + "candidate/parts/baseline-5mm.SLDPRT")),
    companion: new Uint8Array(readFileSync(directory + "candidate/parts/candidate-8mm.SLDPRT")),
    identity: encode(data.identity), preservation: encode(data.preservation), native: encode(data.native), result: new Uint8Array(),
  };
  data.result.checks.forEach((check: { evidenceSha256: string }, index: number) => {
    let report = bytes.native;
    if (index === 0) report = bytes.identity;
    else if (index === 6) report = bytes.preservation;
    check.evidenceSha256 = hash(report);
  });
  bytes.result = encode(data.result);
  const objects: RegisteredResultObject[] = Object.entries(bytes).map(([role, content], index) => ({
    id: input ? randomUUID() : `11111111-1111-4111-8111-00000000000${index}`, scope: data.job.scope,
    attemptId: data.job.attemptId, role: role as RegisteredResultObject["role"], bytes: content.byteLength, sha256: hash(content),
  }));
  const admission: ResultReadAdmission = { contextText, jobText,
    active: { scope: data.job.scope, jobId: data.job.jobId, attemptId: data.job.attemptId, fence: data.job.fence,
      inputSnapshotId: data.job.inputSnapshotId, contextSha256: data.job.contextSha256, outputSnapshotId: data.job.outputSnapshotId },
    process: { nativePid: 42, helperPid: 43, nativeStartTicks: "639246000000000000", candidateRoot: data.native.candidateRoot }, objects };
  const reader = async (id: string) => {
    const object = objects.find((entry) => entry.id === id)!;
    return new Response(bytes[object.role]);
  };
  return { admission, bytes, reader, objects, data };
}
