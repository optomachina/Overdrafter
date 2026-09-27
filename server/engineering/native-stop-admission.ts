import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_JOURNAL_BYTES = 2_000_000;
const MAX_OBSERVATION_AGE_MS = 300_000;
const POLICY = "prepared-native-failure-v1";
export type NativeStopAttempt = Readonly<{
  taskId: string; attemptId: string; organizationId: string; projectId: string; workerId: string;
  installationId: string; bootId: string; sessionId: string; runtimeAdmissionId: string;
  fence: number; jobSha256: string; contextSha256: string; claimedAt: string;
  current: boolean; slotOccupiedByAttempt: boolean;
}>;
export type TerminalProcess = Readonly<{
  launchId: string; pid: number; creationTicks: string; sessionId: number;
  executableSha256: string; exitCode: number; terminationRequested: boolean;
}>;
/** This record is loaded from a separately qualified, immutable evidence store,
 * never accepted from the worker request body. Its observation must be made by
 * the qualified process-boundary validator, not inferred from journal hashes. */
export type TrustedStopEvidence = Readonly<{
  evidenceId: string; attemptId: string; fence: number; journalText: string;
  journalSha256: string; journalHeadSha256: string; evidenceManifestText: string;
  evidenceSha256: string; observedAt: string;
  observingAuthority: "qualified_worker_validator";
  processBoundaryComplete: true; terminalProcesses: readonly TerminalProcess[];
  executionOutcome: "native_exit_succeeded" | "native_failed";
  failureCode: string | null; validatorVersion: string;
}>;
export type NativeStopAdmission = Readonly<{
  id: string; attemptId: string; organizationId: string; projectId: string; workerId: string;
  installationId: string; bootId: string; sessionId: string; runtimeAdmissionId: string;
  fence: number; jobSha256: string; contextSha256: string; journalSha256: string;
  evidenceSha256: string; verdict: "all_owned_processes_exited";
  authority: "qualified_worker_validator"; terminalProcesses: readonly TerminalProcess[];
  executionOutcome: "native_exit_succeeded" | "native_failed";
  failureCode: string | null; failurePolicyVersion: typeof POLICY;
  validatorVersion: string; stoppedAt: string; observedAt: string;
}>;
export type NativeStopRepository = Readonly<{
  /** Exact committed request lookup. This is a durable server record, never
   * reconstructed from a released slot or a worker supplied receipt. */
  loadRecordedStop: (taskId: string, attemptId: string, evidenceId: string,
    revision: number, key: string) => Promise<{ admission: NativeStopAdmission;
      receipt: { attemptId: string; resultEligible: boolean; phase: string; verification: string } } | null>;
  loadCurrentAttempt: (taskId: string, attemptId: string) => Promise<NativeStopAttempt | null>;
  loadTrustedEvidence: (evidenceId: string) => Promise<TrustedStopEvidence | null>;
  /** Owner-only insertion; the existing SQL API independently rechecks exact
   * current attempt/fence and releases occupancy without granting verification. */
  admitAndRecord: (admission: NativeStopAdmission, revision: number, key: string) => Promise<{
    attemptId: string; resultEligible: boolean; phase: string; verification: string;
  }>;
}>;
function hash(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value === "string") {
    let result = '"';
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code === 34) result += '\\"';
      else if (code === 92) result += '\\\\';
      else if (code < 32 || code > 126) result += `\\u${code.toString(16).padStart(4, "0")}`;
      else result += value[i];
    }
    return result + '"';
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort((left, right) => left.localeCompare(right)).map((key) =>
      canonical(key) + ":" + canonical(record[key]));
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Unsupported journal value.");
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function id(value: unknown): value is string { return typeof value === "string" && UUID.test(value) && value !== "00000000-0000-0000-0000-000000000000"; }
function time(value: unknown): number { return typeof value === "string" ? Date.parse(value) : Number.NaN; }
function processIdentity(data: Record<string, unknown>): boolean {
  const ticks = typeof data.creationTicks === "string" && /^[1-9]\d{0,18}$/.test(data.creationTicks)
    ? BigInt(data.creationTicks) : 0n;
  return Number.isInteger(data.pid) && Number(data.pid) >= 1 && Number(data.pid) <= 2147483647
    && Number.isInteger(data.sessionId) && Number(data.sessionId) >= 0 && Number(data.sessionId) <= 2147483647
    && ticks >= 1n && ticks <= 3155378975999999999n;
}
function windowsPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 260 && !Array.from(value).some((char) => char.charCodeAt(0) < 32)
    && /^[A-Za-z]:\\[^<>:"/|?*]+$/.test(value)
    && !/\\\\|\\\.\.?(\\|$)|[. ](\\|$)/.test(value);
}
function sameBinding(binding: Record<string, unknown>, attempt: NativeStopAttempt): boolean {
  return binding.organizationId === attempt.organizationId && binding.projectId === attempt.projectId
    && binding.workerId === attempt.workerId && binding.installationId === attempt.installationId
    && binding.bootId === attempt.bootId && binding.taskId === attempt.taskId
    && binding.attemptId === attempt.attemptId && binding.runtimeAdmissionId === attempt.runtimeAdmissionId
    && binding.fence === attempt.fence && binding.jobSha256 === attempt.jobSha256;
}
/** Replays the immutable journal and requires complete launch/creation/exit
 * pairs. It does not claim that a hash chain proves actual Windows process exit. */
export function replayStoppedJournal(text: string, attempt: NativeStopAttempt): {
  headSha256: string; terminals: TerminalProcess[]; stoppedAt: string;
} {
  if (Buffer.byteLength(text, "utf8") < 1 || Buffer.byteLength(text, "utf8") > MAX_JOURNAL_BYTES) throw new Error("Journal size invalid.");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error("Journal JSON invalid."); }
  if (!object(parsed) || parsed.schema !== "overdrafter.native-attempt-journal.v1" || !object(parsed.binding)
    || !sameBinding(parsed.binding, attempt) || !Array.isArray(parsed.records) || parsed.records.length > 2048
    || typeof parsed.headSha256 !== "string" || !SHA.test(parsed.headSha256)
    || canonical(parsed) !== text) throw new Error("Journal envelope or binding invalid.");
  const bindingHash = hash(canonical(parsed.binding));
  let previous = bindingHash, lastAt = time(attempt.claimedAt);
  const launches = new Map<string, { intent: Record<string, unknown>; started?: Record<string, unknown>; exited?: Record<string, unknown>; at?: string }>();
  for (let i = 0; i < parsed.records.length; i++) {
    const record = parsed.records[i];
    if (!object(record) || !object(record.data) || record.sequence !== i + 1 || record.previousSha256 !== previous
      || record.bindingSha256 !== bindingHash || !SHA.test(String(record.sha256))) throw new Error("Journal chain invalid.");
    const at = time(record.at);
    if (!Number.isFinite(at) || at < lastAt) throw new Error("Journal time invalid.");
    const body = { sequence: record.sequence, previousSha256: record.previousSha256,
      bindingSha256: record.bindingSha256, at: record.at, kind: record.kind, data: record.data };
    if (hash(canonical(body)) !== record.sha256) throw new Error("Journal digest invalid.");
    lastAt = at; previous = record.sha256 as string;
    const data = record.data;
    if (record.kind === "uncertain") throw new Error("Journal process uncertainty retained.");
    if (record.kind === "launch_intent") {
      if (!id(data.launchId) || launches.has(data.launchId) || !SHA.test(String(data.executableSha256))
        || !SHA.test(String(data.argumentsSha256)) || !windowsPath(data.executablePath)
        || !windowsPath(data.workingDirectory) || data.parentLaunchId !== null
        || !["compiler", "native", "lifecycle", "operation"].includes(String(data.role))) throw new Error("Journal launch invalid.");
      launches.set(data.launchId, { intent: data });
    } else if (record.kind === "process_started") {
      const launch = launches.get(String(data.launchId));
      if (!launch || launch.started || !processIdentity(data)
        || !windowsPath(data.executablePath) || data.executablePath.toLowerCase() !== String(launch.intent.executablePath).toLowerCase()
        || data.executableSha256 !== launch.intent.executableSha256
        || BigInt(String(data.creationTicks)) > BigInt(at) * 10000n + 621355968000000000n) throw new Error("Journal creation invalid.");
      launch.started = data;
    } else if (record.kind === "process_exited") {
      const launch = launches.get(String(data.launchId));
      if (!launch?.started || launch.exited || !processIdentity(data) || data.pid !== launch.started.pid
        || data.creationTicks !== launch.started.creationTicks || data.sessionId !== launch.started.sessionId
        || !Number.isInteger(data.exitCode) || Number(data.exitCode) < -2147483648
        || Number(data.exitCode) > 2147483647 || typeof data.terminationRequested !== "boolean") throw new Error("Journal terminal identity invalid.");
      launch.exited = data; launch.at = record.at as string;
    }
  }
  if (previous !== parsed.headSha256 || launches.size < 1 || launches.size > 128) throw new Error("Journal head or launch set invalid.");
  const terminals: TerminalProcess[] = [];
  let stoppedAt = "";
  for (const [launchId, launch] of launches) {
    if (!launch.started || !launch.exited || !launch.at) throw new Error("Journal has unresolved process.");
    terminals.push({ launchId, pid: launch.started.pid as number,
      creationTicks: launch.started.creationTicks as string, sessionId: launch.started.sessionId as number,
      executableSha256: launch.intent.executableSha256 as string,
      exitCode: launch.exited.exitCode as number, terminationRequested: launch.exited.terminationRequested as boolean });
    if (!stoppedAt || time(launch.at) > time(stoppedAt)) stoppedAt = launch.at;
  }
  terminals.sort((a, b) => a.launchId.localeCompare(b.launchId));
  return { headSha256: previous, terminals, stoppedAt };
}
/** Request supplies an opaque evidence ID only. Neither worker JSON nor a
 * journal can insert an admission or release a slot. */
export async function admitNativeProcessStop(input: {
  taskId: string; attemptId: string; evidenceId: string; revision: number; idempotencyKey: string;
  repository: NativeStopRepository; now?: Date;
  expectedScope?: Readonly<{ workerId: string; bootId: string; fence: number }>;
}) {
  if (![input.taskId, input.attemptId, input.evidenceId, input.idempotencyKey].every(id)
    || !Number.isSafeInteger(input.revision) || input.revision < 0) throw new TypeError("Stop request identity invalid.");
  const recorded = await input.repository.loadRecordedStop(input.taskId, input.attemptId,
    input.evidenceId, input.revision, input.idempotencyKey);
  if (recorded) {
    if (recorded.admission.id !== input.evidenceId || recorded.admission.attemptId !== input.attemptId
      || recorded.receipt.attemptId !== input.attemptId || recorded.receipt.verification !== "unverified"
      || (input.expectedScope && (recorded.admission.workerId !== input.expectedScope.workerId
        || recorded.admission.bootId !== input.expectedScope.bootId
        || recorded.admission.fence !== input.expectedScope.fence))) throw new Error("Recorded stop replay differs.");
    return recorded;
  }
  const attempt = await input.repository.loadCurrentAttempt(input.taskId, input.attemptId);
  if (!attempt || !attempt.current || !attempt.slotOccupiedByAttempt) throw new Error("Exact native occupancy unavailable.");
  if (input.expectedScope && (input.expectedScope.workerId !== attempt.workerId
    || input.expectedScope.bootId !== attempt.bootId || input.expectedScope.fence !== attempt.fence)) {
    throw new Error("Stop request differs from exact attempt and fence.");
  }
  const evidence = await input.repository.loadTrustedEvidence(input.evidenceId);
  if (!evidence || evidence.evidenceId !== input.evidenceId || evidence.attemptId !== attempt.attemptId
    || evidence.fence !== attempt.fence || evidence.observingAuthority !== "qualified_worker_validator"
    || evidence.processBoundaryComplete !== true || !SHA.test(evidence.journalSha256)
    || !SHA.test(evidence.journalHeadSha256)
    || !SHA.test(evidence.evidenceSha256) || !Array.isArray(evidence.terminalProcesses)
    || evidence.terminalProcesses.length < 1 || evidence.terminalProcesses.length > 128
    || typeof evidence.validatorVersion !== "string" || evidence.validatorVersion.length < 1
    || evidence.validatorVersion.length > 100) throw new Error("Trusted stop evidence unavailable.");
  const observation = time(evidence.observedAt), now = (input.now ?? new Date()).getTime();
  if (!Number.isFinite(observation) || observation < time(attempt.claimedAt)
    || observation > now || now - observation > MAX_OBSERVATION_AGE_MS) throw new Error("Stop observation is late or invalid.");
  const journal = replayStoppedJournal(evidence.journalText, attempt);
  let manifest: unknown;
  try { manifest = JSON.parse(evidence.evidenceManifestText); }
  catch { throw new Error("Stop evidence manifest invalid."); }
  if (!object(manifest) || manifest.schema !== "overdrafter.native-stop-evidence.v1"
    || canonical(manifest) !== evidence.evidenceManifestText
    || hash(evidence.evidenceManifestText) !== evidence.evidenceSha256
    || manifest.attemptId !== attempt.attemptId || manifest.fence !== attempt.fence
    || manifest.journalSha256 !== evidence.journalSha256 || manifest.journalHeadSha256 !== evidence.journalHeadSha256
    || manifest.observedAt !== evidence.observedAt || manifest.observingAuthority !== evidence.observingAuthority
    || manifest.processBoundaryComplete !== true || manifest.executionOutcome !== evidence.executionOutcome
    || manifest.failureCode !== evidence.failureCode || manifest.validatorVersion !== evidence.validatorVersion
    || !isDeepStrictEqual(manifest.terminalProcesses, evidence.terminalProcesses)) {
    throw new Error("Stop evidence manifest binding invalid.");
  }
  if (hash(evidence.journalText) !== evidence.journalSha256 || journal.headSha256 !== evidence.journalHeadSha256
    || time(journal.stoppedAt) > observation
    || !isDeepStrictEqual(journal.terminals, [...evidence.terminalProcesses].sort((a, b) => a.launchId.localeCompare(b.launchId)))) {
    throw new Error("Complete process-stop evidence differs.");
  }
  const success = evidence.executionOutcome === "native_exit_succeeded";
  if (success ? evidence.failureCode !== null || journal.terminals.some((process) => process.exitCode !== 0 || process.terminationRequested)
    : evidence.executionOutcome !== "native_failed" || !evidence.failureCode
      || !["native_startup_timeout","input_invalid","runtime_mismatch","native_operation_failed","artifact_invalid",
        "deadline_exceeded","authority_lost","process_uncertain","unclassified"].includes(evidence.failureCode)) {
    throw new Error("Stop outcome differs from complete process evidence.");
  }
  const admission: NativeStopAdmission = {
    id: evidence.evidenceId, attemptId: attempt.attemptId, organizationId: attempt.organizationId,
    projectId: attempt.projectId, workerId: attempt.workerId, installationId: attempt.installationId,
    bootId: attempt.bootId, sessionId: attempt.sessionId, runtimeAdmissionId: attempt.runtimeAdmissionId,
    fence: attempt.fence, jobSha256: attempt.jobSha256, contextSha256: attempt.contextSha256,
    journalSha256: evidence.journalSha256, evidenceSha256: evidence.evidenceSha256,
    verdict: "all_owned_processes_exited", authority: "qualified_worker_validator",
    terminalProcesses: journal.terminals, executionOutcome: evidence.executionOutcome,
    failureCode: evidence.failureCode, failurePolicyVersion: POLICY,
    validatorVersion: evidence.validatorVersion, stoppedAt: journal.stoppedAt, observedAt: evidence.observedAt,
  };
  const receipt = await input.repository.admitAndRecord(admission, input.revision, input.idempotencyKey);
  if (receipt.attemptId !== attempt.attemptId || receipt.verification !== "unverified"
    || typeof receipt.resultEligible !== "boolean") throw new Error("Invalid stop transition receipt.");
  return { admission, receipt };
}
