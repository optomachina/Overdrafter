import { compareEvidenceText } from "./native-evidence-order";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { NATIVE_CHECKS, type NativeContext, type NativeJob, type NativeResult } from "../../src/lib/engineering-cumulative";
import type { CumulativePreview } from "../../src/lib/engineering-cumulative-preview";
import { PREPARED_PREVIEW_PREDICATES } from "./native-preview-policy";
import { PREPARED_NATIVE_PREDICATES } from "./native-report-policy";

export const NATIVE_REPORT_POLICY = "prepared-native-reports-v2";
const REPORT_LIMIT = 4_000_000;
type RecordValue = Record<string, unknown>;
export type NativeReportBytes = Readonly<{
  identity: Uint8Array; preservation: Uint8Array; native: Uint8Array;
}>;
/** These identities must come from a trusted process admission, never the reports. */
export type AdmittedReportProcess = Readonly<{
  nativePid: number; nativeStartTicks: string; helperPid: number; candidateRoot: string;
}>;
/** FILE_ID_INFO captured from open directory handles on the same Windows host.
 * The trusted admission writer must follow aliases, bind both handles to this
 * attempt, and prevent/reject identity changes during native work. These fields
 * must never be populated from report claims or normalized path strings.
 */
type AdmittedDirectory = Readonly<{ path: string; volumeSerial: string; fileId: string }>;
export type NativeFilesystemAdmission = Readonly<{ input: AdmittedDirectory; candidate: AdmittedDirectory }>;

function need(condition: unknown, label: string): asserts condition {
  if (!condition) throw new TypeError(`Invalid prepared evidence: ${label}.`);
}
function record(value: unknown, label: string): RecordValue {
  need(value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype, label);
  return value as RecordValue;
}
function exact(value: unknown, keys: readonly string[], label: string): RecordValue {
  const object = record(value, label);
  need(isDeepStrictEqual(Object.keys(object).sort(compareEvidenceText), [...keys].sort(compareEvidenceText)), `${label} fields`);
  return object;
}
function same(actual: unknown, expected: unknown, label: string): void {
  need(isDeepStrictEqual(actual, expected), label);
}
function finite(value: unknown, label: string): number {
  need(typeof value === "number" && Number.isFinite(value), label); return value;
}
function near(value: unknown, expected: number, tolerance: number, label: string): void {
  need(Math.abs(finite(value, label) - expected) <= tolerance, label);
}
function windowsPath(value: unknown): string {
  need(typeof value === "string" && /^[A-Za-z]:\\[^<>:"|?*/]+$/.test(value)
    && [...value].every((character) => character.codePointAt(0)! >= 32), "Windows path");
  const segments = value.slice(3).split("\\");
  need(segments.every((part) => part.length > 0 && part !== "." && part !== ".."
    && !/[. ]$/.test(part)), "Windows path segments");
  return value.toLowerCase();
}
/** Validate trusted process metadata before attributing a defect to evidence. */
export function validateAdmittedReportProcess(process: AdmittedReportProcess): void {
  exact(process, ["nativePid", "nativeStartTicks", "helperPid", "candidateRoot"], "admitted process fields");
  need(Number.isSafeInteger(process.nativePid) && process.nativePid > 0 && Number.isSafeInteger(process.helperPid)
    && process.helperPid > 0 && process.nativePid !== process.helperPid && typeof process.nativeStartTicks === "string"
    && /^[1-9]\d{16,18}$/.test(process.nativeStartTicks), "admitted process identity");
  windowsPath(process.candidateRoot);
}
function pathSame(actual: unknown, expected: string): void {
  same(windowsPath(actual), windowsPath(expected), "private path");
}
/** Validate separately admitted handle identities before any evidence reads.
 * This checks their binding/shape, not their provenance: there is deliberately
 * no production admission writer or public entrypoint in this source slice.
 */
export function validateNativeFilesystemAdmission(filesystem: NativeFilesystemAdmission, candidateRoot: string): void {
  exact(filesystem, ["input", "candidate"], "filesystem admission");
  for (const directory of [filesystem.input, filesystem.candidate]) {
    exact(directory, ["path", "volumeSerial", "fileId"], "filesystem directory");
    windowsPath(directory.path);
    need(typeof directory.volumeSerial === "string" && /^[0-9a-f]{16}$/.test(directory.volumeSerial)
      && typeof directory.fileId === "string" && /^[0-9a-f]{32}$/.test(directory.fileId)
      && directory.fileId !== "0".repeat(32), "filesystem handle identity");
  }
  pathSame(filesystem.candidate.path, candidateRoot);
  need(windowsPath(filesystem.input.path) !== windowsPath(filesystem.candidate.path), "private input copy");
  // FILE_ID_INFO's volume serial + 128-bit file ID identify a file on one host.
  // A junction, symlink or substituted drive cannot make identical IDs distinct.
  need(filesystem.input.volumeSerial !== filesystem.candidate.volumeSerial
    || filesystem.input.fileId !== filesystem.candidate.fileId, "private input copy");
}
/** Bound parsing before inspecting claims; reject ambiguous duplicate JSON keys. */
export function parsePreparedEvidenceJson(bytes: Uint8Array): unknown {
  need(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= REPORT_LIMIT, "report size");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}[\]:,]/g) ?? [];
  const stack: (Set<string> | null)[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{" || token === "[") {
      stack.push(token === "{" ? new Set() : null);
      need(stack.length <= 32, "report nesting");
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else if (token.startsWith('"') && tokens[i + 1] === ":") {
      const keys = stack.at(-1); const key = JSON.parse(token) as string;
      need(keys && !keys.has(key), "duplicate JSON key"); keys.add(key);
    }
  }
  return value;
}
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function snapshot(bytes: Uint8Array): Uint8Array {
  need(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= REPORT_LIMIT, "report size");
  return new Uint8Array(bytes);
}

function validateGeometry(raw: unknown, depthMm: number): void {
  const g = exact(raw, ["depthM", "isBase", "isBossDiagnostic", "thin", "bothDirections", "endCondition",
    "fromType", "reverse", "rebuild", "featureError", "featureWarning", "massProperties", "testDensity", "volumeMm3", "depthMm"], "geometry");
  for (const field of ["isBase", "rebuild"]) same(g[field], true, field);
  for (const field of ["thin", "bothDirections", "reverse", "featureWarning"]) same(g[field], false, field);
  for (const field of ["endCondition", "fromType", "featureError"]) same(g[field], 0, field);
  need(typeof g.isBossDiagnostic === "boolean", "boss diagnostic"); same(g.testDensity, 1, "test density");
  const height = depthMm / 1000;
  near(g.depthM, height, 1e-10, "extrusion depth"); near(g.depthMm, depthMm, 1e-7, "depth units");
  need(Array.isArray(g.massProperties) && g.massProperties.length >= 12 && g.massProperties.length <= 16, "mass properties");
  const mass = g.massProperties.map((v) => finite(v, "mass property"));
  near(mass[0], 0, 1e-8, "centroid x"); near(mass[1], 0, 1e-8, "centroid y");
  near(mass[2], height / 2, 1e-8, "centroid z");
  near(mass[3], Math.PI * .01 * .01 * height, 1e-10, "cylinder volume");
  near(mass[4], 2 * Math.PI * .01 * (.01 + height), 1e-9, "cylinder area");
  near(g.volumeMm3, mass[3] * 1e9, 1e-7, "volume units");
}
function validateOpen(raw: unknown, path: string, options: number, assembly: boolean): void {
  const o = exact(raw, ["path", "options", "errors", "warnings", "returned"], "open");
  pathSame(o.path, path); same(o.options, options, "open options"); same(o.errors, 0, "open errors");
  need(o.warnings === 0 || (assembly && o.warnings === 32), "open warnings"); same(o.returned, true, "open result");
}
function validateSave(raw: unknown, path: string): void {
  const s = exact(raw, ["saved", "errors", "warnings", "path", "dirty"], "save");
  pathSame(s.path, path); same(s.saved, true, "saved"); same(s.dirty, false, "saved state");
  same(s.errors, 0, "save errors"); same(s.warnings, 0, "save warnings");
}
function validateOccurrences(raw: unknown, paths: readonly string[]): void {
  need(Array.isArray(raw) && raw.length === 2, "two occurrences");
  const seen = new Set<string>();
  for (const value of raw) {
    const o = exact(value, ["name", "path", "modelPath", "configuration", "fixedState", "suppression", "readOnly", "transform"], "occurrence");
    const path = windowsPath(o.path), index = paths.findIndex((p) => windowsPath(p) === path);
    need(index >= 0 && !seen.has(path), "distinct private occurrences"); seen.add(path);
    pathSame(o.modelPath, paths[index]); same(o.configuration, "Default", "occurrence configuration");
    same(o.name, ["baseline-5mm-1", "candidate-8mm-1"][index], "occurrence name");
    same(o.fixedState, true, "fixed occurrence"); same(o.readOnly, true, "read-only occurrence");
    need(o.suppression === 2 || o.suppression === 3, "occurrence suppression");
    need(Array.isArray(o.transform) && o.transform.length === 16, "transform length");
    const expected = [1, 0, 0, 0, 1, 0, 0, 0, 1, index * .04, 0, 0, 1];
    o.transform.forEach((v, i) => {
      finite(v, "transform value");
      if (i < 13) near(v, expected[i], i >= 9 && i <= 11 ? 1e-8 : 1e-10, "component movement");
    });
  }
}
function validateDependencies(raw: unknown, paths: readonly string[]): void {
  need(Array.isArray(raw) && raw.length === 4, "assembly dependencies");
  need(typeof raw[0] === "string" && raw[0].length > 0 && typeof raw[2] === "string" && raw[2].length > 0, "dependency labels");
  same([windowsPath(raw[1]), windowsPath(raw[3])].sort(compareEvidenceText), paths.map(windowsPath).sort(compareEvidenceText), "dependency closure");
}

/** Check the read-only export observations against an independently finalized
 * context and admitted exporter process. This cannot authenticate a worker,
 * establish process shutdown, or grant native verification/release authority.
 */
export function validatePreparedPreviewReport(input: {
  context: NativeContext; preview: CumulativePreview; process: AdmittedReportProcess; report: Uint8Array;
}): void {
  const { context, preview, process } = input;
  validateAdmittedReportProcess(process);
  const n = exact(parsePreparedEvidenceJson(input.report), ["outcome", "checks", "releaseErrors", "helperPid", "role",
    "contextSha256", "requestSha256", "resultSha256", "depthMm", "candidateRoot", "nativePid", "nativeStartTicks",
    "nativeVersion", "beforeNativeFiles", "stage", "preview_part_0Open", "preview_geometry_0Dependencies",
    "preview_geometry_0", "preview_part_1Open", "preview_geometry_1Dependencies", "preview_geometry_1",
    "preview_assemblyOpen", "previewOccurrences", "preview_part_0Dependencies", "preview_part_1Dependencies",
    "preview_assemblyDependencies", "stepPreferencesBefore", "stepSave", "stepPreferencesAfter",
    "after_exportOccurrences", "after_export_part_0Dependencies", "after_export_part_1Dependencies",
    "after_export_assemblyDependencies", "step", "afterNativeFiles"], "preview report");
  same(n.outcome, "passed", "export outcome"); same(n.releaseErrors, [], "export release errors");
  same(n.stage, "GetDocuments", "export final observation");
  for (const key of ["role", "contextSha256", "requestSha256", "resultSha256"] as const) same(n[key], preview[key], key);
  same(n.depthMm, context.depthMm, "preview depth"); same(n.nativeVersion, "30.5.0", "export version");
  for (const key of ["nativePid", "helperPid", "nativeStartTicks"] as const) same(n[key], process[key], key);
  pathSame(n.candidateRoot, process.candidateRoot);
  same(n.beforeNativeFiles, context.files, "pre-export native identity");
  same(n.afterNativeFiles, context.files, "post-export native identity");
  const predicates = exact(n.checks, PREPARED_PREVIEW_PREDICATES, "export predicate set");
  for (const key of PREPARED_PREVIEW_PREDICATES) same(predicates[key], true, `export predicate ${key}`);
  const parts = context.files.slice(1).map((file) => `${process.candidateRoot}\\${file.path.replaceAll("/", "\\")}`);
  for (let i = 0; i < 2; i++) {
    validateOpen(n[`preview_part_${i}Open`], parts[i], 3, false);
    validateGeometry(n[`preview_geometry_${i}`], i === 0 ? context.depthMm : 8);
    same(n[`preview_geometry_${i}Dependencies`], [], "preview geometry dependencies");
  }
  validateOpen(n.preview_assemblyOpen, `${process.candidateRoot}\\${context.assemblyPath}`, 67, true);
  for (const phase of ["preview", "after_export"]) {
    validateOccurrences(n[`${phase}Occurrences`], parts);
    validateDependencies(n[`${phase}_assemblyDependencies`], parts);
    for (let i = 0; i < 2; i++) same(n[`${phase}_part_${i}Dependencies`], [], "preview part dependencies");
  }
  const preferences = exact(n.stepPreferencesBefore, ["geometry", "ap", "configurationData", "outputCoordinateSystem"], "STEP preferences");
  same(preferences.geometry, 0, "STEP solid and surface mode");
  need(preferences.ap === 203 || preferences.ap === 214, "STEP application protocol");
  same(preferences.configurationData, false, "STEP configuration prompt");
  same(preferences.outputCoordinateSystem, "", "STEP coordinate override");
  same(n.stepPreferencesAfter, preferences, "STEP preferences preserved");
  same(n.stepSave, { returned: true, errors: 0, warnings: 0 }, "STEP save");
  same(n.step, { fileName: preview.step.fileName, bytes: preview.step.bytes, sha256: preview.step.sha256 }, "exported STEP identity");
  same(digest(input.report), preview.export.reportSha256, "export report identity");
}
function validateNativeGeometry(n: RecordValue, job: NativeJob, root: string): void {
  const assembly = String.raw`${root}\synthetic-assembly.SLDASM`;
  const parts = [String.raw`${root}\parts\baseline-5mm.SLDPRT`, String.raw`${root}\parts\candidate-8mm.SLDPRT`];
  for (const phase of ["before", "updated", "final_reopen"]) {
    const targetDepth = phase === "before" ? job.expectedDepthMm : job.depthMm;
    for (let i = 0; i < 2; i++) {
      validateOpen(n[`${phase}_part_${i}Open`], parts[i], 3, false);
      validateGeometry(n[`${phase}_geometry_${i}`], i === 0 ? targetDepth : 8);
      same(n[`${phase}_geometry_${i}Dependencies`], [], "part geometry dependencies");
      same(n[`${phase}_part_${i}Dependencies`], [], "part dependencies");
    }
    validateOpen(n[`${phase}_assemblyOpen`], assembly, phase === "updated" ? 65 : 67, true);
    validateOccurrences(n[`${phase}Occurrences`], parts);
    validateDependencies(n[`${phase}_assemblyDependencies`], parts);
  }
  for (const phase of ["before_dimension", "after_edit", "after_dimension"]) {
    validateGeometry(n[phase], phase === "before_dimension" ? job.expectedDepthMm : job.depthMm);
    same(n[`${phase}Dependencies`], [], "dimension dependencies");
  }
  validateOpen(n.edit_targetOpen, parts[0], 1, false); validateOpen(n.saved_part_reopenOpen, parts[0], 3, false);
  validateSave(n.part_save, parts[0]); validateSave(n.assembly_save, assembly);
}
function validateNative(raw: unknown, job: NativeJob, result: NativeResult, process: AdmittedReportProcess): void {
  const n = record(raw, "native report");
  same(n.outcome, "passed", "native outcome"); same(n.releaseErrors, [], "release errors");
  need(!Object.hasOwn(n, "error") && !Object.hasOwn(n, "hresult"), "native exception");
  for (const key of ["jobId", "attemptId", "contextSha256", "depthMm", "expectedDepthMm"] as const) same(n[key], job[key], key);
  same(n.requestSha256, result.requestSha256, "native request digest");
  for (const key of ["nativePid", "helperPid", "nativeStartTicks"] as const) same(n[key], process[key], key);
  validateAdmittedReportProcess(process);
  pathSame(n.candidateRoot, process.candidateRoot); pathSame(result.candidateRoot, process.candidateRoot);
  const checks = record(n.checks, "native predicates");
  const required = [...PREPARED_NATIVE_PREDICATES];
  if (job.expectedDepthMm === 5) required.push("pinned_seed");
  required.sort(compareEvidenceText);
  same(Object.keys(checks).sort(compareEvidenceText), required, "complete native predicate set");
  for (const key of required) same(checks[key], true, `native predicate ${key}`);
  same(n.verifiedChecks, NATIVE_CHECKS.slice(1, 6), "native check coverage");
  same(n.measurements, result.measurements, "native result measurements");
  const measurements = exact(n.measurements, ["beforeDepthMm", "afterDepthMm", "beforeVolumeMm3", "afterVolumeMm3"], "measurements");
  near(measurements.beforeDepthMm, job.expectedDepthMm, 1e-7, "before depth");
  near(measurements.afterDepthMm, job.depthMm, 1e-7, "after depth");
  near(measurements.beforeVolumeMm3, Math.PI * 100 * job.expectedDepthMm, .1, "before volume");
  near(measurements.afterVolumeMm3, Math.PI * 100 * job.depthMm, .1, "after volume");
  validateNativeGeometry(n, job, process.candidateRoot);
}

/**
 * Validate stored report content against already validated v2 job/result and
 * trusted process admission. This pure result grants no database, stop or retry
 * authority and does not verify native artifact bytes; the finalizer must do so.
 */
export function validatePreparedReports(input: {
  job: NativeJob; result: NativeResult; process: AdmittedReportProcess; reports: NativeReportBytes;
  filesystem: NativeFilesystemAdmission;
}): Readonly<{ policy: typeof NATIVE_REPORT_POLICY; evidenceSha256: readonly string[] }> {
  const { job, result } = input;
  validateAdmittedReportProcess(input.process);
  validateNativeFilesystemAdmission(input.filesystem, input.process.candidateRoot);
  const reports = { identity: snapshot(input.reports.identity), preservation: snapshot(input.reports.preservation), native: snapshot(input.reports.native) };
  const identityReport = parsePreparedEvidenceJson(reports.identity), preservationReport = parsePreparedEvidenceJson(reports.preservation), nativeReport = parsePreparedEvidenceJson(reports.native);
  const hashes = { identity: digest(reports.identity), preservation: digest(reports.preservation), native: digest(reports.native) };
  same(result.checks.map((c) => c.id), NATIVE_CHECKS, "required check order");
  result.checks.forEach((c, i) => {
    let expected = hashes.native;
    if (i === 0) expected = hashes.identity;
    else if (i === 6) expected = hashes.preservation;
    same(c.verdict, "pass", "check verdict"); same(c.evidenceSha256, expected, "check evidence role");
  });
  const identity = exact(identityReport, ["files", "requestSha256", "contextSha256", "packageRoot"], "input identity");
  same(identity.files, job.inputFiles, "input files"); same(identity.requestSha256, result.requestSha256, "input request");
  same(identity.contextSha256, job.contextSha256, "input context");
  pathSame(identity.packageRoot, input.filesystem.input.path);
  const history = preservationReport;
  need(Array.isArray(history) && history.length === 2, "preservation observations");
  history.forEach((value, index) => {
    const h = exact(value, ["phase", "files", "error"], "preservation");
    same(h.phase, ["before", "after"][index], "preservation phase");
    same(h.files, job.inputFiles, "source preserved"); same(h.error, null, "source observation error");
  });
  validateNative(nativeReport, job, result, input.process);
  return Object.freeze({ policy: NATIVE_REPORT_POLICY, evidenceSha256: Object.freeze(Object.values(hashes)) });
}
