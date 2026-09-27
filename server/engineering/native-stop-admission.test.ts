// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { admitNativeProcessStop, replayStoppedJournal, type NativeStopAttempt,
  type NativeStopRepository, type TrustedStopEvidence } from "./native-stop-admission";

const u = (n: number) => `56200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const h = (text: string) => createHash("sha256").update(text).digest("hex");
function canon(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${canon(key)}:${canon(record[key])}`).join(",")}}`;
  }
  throw Error("unsupported fixture");
}
const claimedAt = "2026-09-27T09:00:00.000Z";
const observedAt = "2026-09-27T09:00:03.000Z";
const attempt: NativeStopAttempt = {
  taskId: u(1), attemptId: u(2), organizationId: u(3), projectId: u(4), workerId: u(5),
  installationId: u(6), bootId: u(7), sessionId: u(8), runtimeAdmissionId: u(9), fence: 3,
  jobSha256: "a".repeat(64), contextSha256: "b".repeat(64), claimedAt,
  current: true, slotOccupiedByAttempt: true,
};
function fixture() {
  const binding = { organizationId: attempt.organizationId, projectId: attempt.projectId, workerId: attempt.workerId,
    installationId: attempt.installationId, bootId: attempt.bootId, taskId: attempt.taskId,
    attemptId: attempt.attemptId, jobId: u(10), fence: attempt.fence, jobSha256: attempt.jobSha256,
    runtimeAdmissionId: attempt.runtimeAdmissionId };
  const intent = { launchId: u(11), role: "native", executablePath: "C:\\synthetic.exe", executableSha256: "c".repeat(64),
    workingDirectory: "C:\\synthetic", argumentsSha256: "d".repeat(64), parentLaunchId: null };
  const started = { launchId: intent.launchId, pid: 123, creationTicks: "638000000000000000", sessionId: 1,
    executablePath: intent.executablePath, executableSha256: intent.executableSha256 };
  const exited = { launchId: intent.launchId, pid: 123, creationTicks: started.creationTicks, sessionId: 1,
    exitCode: 0, terminationRequested: false };
  const bindingSha256 = h(canon(binding)); let previous = bindingSha256;
  const records = [
    { kind: "launch_intent", data: intent, at: "2026-09-27T09:00:00.500Z" },
    { kind: "process_started", data: started, at: "2026-09-27T09:00:01.000Z" },
    { kind: "process_exited", data: exited, at: "2026-09-27T09:00:02.000Z" },
  ].map((entry, index) => {
    const body = { sequence: index + 1, previousSha256: previous, bindingSha256, ...entry };
    const record = { ...body, sha256: h(canon(body)) };
    previous = record.sha256; return record;
  });
  const journalText = canon({ schema: "overdrafter.native-attempt-journal.v1", binding, records, headSha256: previous });
  const terminalProcesses = [{ launchId: intent.launchId, pid: 123, creationTicks: started.creationTicks,
    sessionId: 1, executableSha256: intent.executableSha256, exitCode: 0, terminationRequested: false }];
  const manifest = { schema: "overdrafter.native-stop-evidence.v1", attemptId: attempt.attemptId, fence: attempt.fence,
    journalSha256: h(journalText), journalHeadSha256: previous, observedAt,
    observingAuthority: "qualified_worker_validator", processBoundaryComplete: true,
    terminalProcesses, executionOutcome: "native_exit_succeeded", failureCode: null,
    validatorVersion: "synthetic-v1" };
  const evidenceManifestText = canon(manifest);
  const evidence: TrustedStopEvidence = { evidenceId: u(12), attemptId: attempt.attemptId, fence: attempt.fence,
    journalText, journalSha256: h(journalText), journalHeadSha256: previous,
    evidenceManifestText, evidenceSha256: h(evidenceManifestText), observedAt,
    observingAuthority: "qualified_worker_validator", processBoundaryComplete: true,
    terminalProcesses, executionOutcome: "native_exit_succeeded", failureCode: null,
    validatorVersion: "synthetic-v1" };
  const repository: NativeStopRepository = {
    loadRecordedStop: vi.fn(async () => null),
    loadCurrentAttempt: vi.fn(async () => attempt), loadTrustedEvidence: vi.fn(async () => evidence),
    admitAndRecord: vi.fn(async () => ({ attemptId: attempt.attemptId, resultEligible: true,
      phase: "awaiting_result", verification: "unverified" })),
  };
  const input = { taskId: attempt.taskId, attemptId: attempt.attemptId, evidenceId: evidence.evidenceId,
    revision: 1, idempotencyKey: u(13), repository, now: new Date("2026-09-27T09:00:04.000Z") };
  return { evidence, repository, input };
}
describe("trusted native stop admission", () => {
  it("binds complete terminal evidence and keeps occupancy release distinct from result eligibility", async () => {
    const { evidence, repository, input } = fixture();
    expect(replayStoppedJournal(evidence.journalText, attempt).terminals).toEqual(evidence.terminalProcesses);
    const outcome = await admitNativeProcessStop(input);
    expect(outcome.admission.attemptId).toBe(attempt.attemptId);
    expect(outcome.admission.fence).toBe(3);
    expect(outcome.admission.verdict).toBe("all_owned_processes_exited");
    expect(outcome.receipt.verification).toBe("unverified");
    expect(repository.admitAndRecord).toHaveBeenCalledOnce();
  });
  it("rejects missing evidence, changed fence and occupied-slot mismatch before admission", async () => {
    const missing = fixture();
    vi.mocked(missing.repository.loadTrustedEvidence).mockResolvedValue(null);
    await expect(admitNativeProcessStop(missing.input)).rejects.toThrow("Trusted stop evidence");
    const foreign = fixture();
    vi.mocked(foreign.repository.loadTrustedEvidence).mockResolvedValue({ ...foreign.evidence, fence: 4 });
    await expect(admitNativeProcessStop(foreign.input)).rejects.toThrow("Trusted stop evidence");
    const released = fixture();
    vi.mocked(released.repository.loadCurrentAttempt).mockResolvedValue({ ...attempt, slotOccupiedByAttempt: false });
    await expect(admitNativeProcessStop(released.input)).rejects.toThrow("Exact native occupancy");
    expect(released.repository.admitAndRecord).not.toHaveBeenCalled();
  });
  it("replays an exact committed stop after occupancy was released", async () => {
    const f = fixture();
    const committed = await admitNativeProcessStop(f.input);
    vi.mocked(f.repository.loadCurrentAttempt).mockResolvedValue({ ...attempt, slotOccupiedByAttempt: false });
    vi.mocked(f.repository.loadRecordedStop).mockResolvedValue(committed);
    expect(await admitNativeProcessStop(f.input)).toEqual(committed);
    expect(f.repository.admitAndRecord).toHaveBeenCalledOnce();
    await expect(admitNativeProcessStop({ ...f.input, expectedScope: { workerId: u(99), bootId: attempt.bootId,
      fence: attempt.fence } })).rejects.toThrow("Recorded stop replay differs");
  });
  it("rejects a newly hashed journal with malformed process identity or launch authority", () => {
    const mutate = (change: (records: Array<{ kind: string; data: Record<string, unknown> }>) => void) => {
      const parsed = JSON.parse(fixture().evidence.journalText);
      change(parsed.records);
      const bindingHash = h(canon(parsed.binding)); let previous = bindingHash;
      parsed.records = parsed.records.map((record: Record<string, unknown>, index: number) => {
        const body = { sequence: index + 1, previousSha256: previous, bindingSha256: bindingHash,
          at: record.at, kind: record.kind, data: record.data };
        previous = h(canon(body)); return { ...body, sha256: previous };
      });
      parsed.headSha256 = previous;
      expect(() => replayStoppedJournal(canon(parsed), attempt)).toThrow();
    };
    mutate((records) => { records[1].data.pid = -1; records[2].data.pid = -1; });
    mutate((records) => { records[1].data.creationTicks = "not-a-time"; records[2].data.creationTicks = "not-a-time"; });
    mutate((records) => { records[1].data.executablePath = "C:\\other.exe"; });
    mutate((records) => { records[0].data.parentLaunchId = u(98); });
  });
  it("rejects forged bytes, manifests, incomplete process sets and late observations", async () => {
    const cases: Array<(e: TrustedStopEvidence) => TrustedStopEvidence> = [
      (e) => ({ ...e, journalText: e.journalText.replace("synthetic.exe", "foreign.exe") }),
      (e) => ({ ...e, evidenceManifestText: e.evidenceManifestText.replace("synthetic-v1", "fake-v1") }),
      (e) => ({ ...e, terminalProcesses: [] }),
      (e) => ({ ...e, processBoundaryComplete: false as true }),
      (e) => ({ ...e, observedAt: "2026-09-27T09:30:00.000Z" }),
    ];
    for (const mutate of cases) {
      const f = fixture(); vi.mocked(f.repository.loadTrustedEvidence).mockResolvedValue(mutate(f.evidence));
      await expect(admitNativeProcessStop(f.input)).rejects.toThrow();
      expect(f.repository.admitAndRecord).not.toHaveBeenCalled();
    }
  });
  it("rejects a later/newer attempt even when old evidence is otherwise complete", async () => {
    const f = fixture();
    vi.mocked(f.repository.loadCurrentAttempt).mockResolvedValue({ ...attempt, attemptId: u(99), fence: 4 });
    await expect(admitNativeProcessStop(f.input)).rejects.toThrow();
    expect(f.repository.admitAndRecord).not.toHaveBeenCalled();
  });
});
