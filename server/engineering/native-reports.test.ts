// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NativeJob, NativeResult } from "../../src/lib/engineering-cumulative";
import { validatePreparedReports } from "./native-reports";

type Data = Record<string, unknown>;
const object = (value: unknown) => value as Data;
const array = (value: unknown) => value as unknown[];
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function fixture() {
  // Sanitized observations from the retained synthetic b643 5→8 mm run.
  // These fixtures exercise report validation, not a fresh CAD or storage run.
  const data = JSON.parse(readFileSync("server/engineering/fixtures/prepared-reports.json", "utf8")) as {
    job: NativeJob; result: NativeResult; native: Data; identity: Data; preservation: Data[];
  };
  const process = { nativePid: 42, helperPid: 43, nativeStartTicks: "639246000000000000", candidateRoot: "C:\\OverDrafter\\fixture\\candidate" };
  // Simulated handle identities, not a Windows filesystem qualification receipt.
  const filesystem = {
    input: { path: String(data.identity.packageRoot), volumeSerial: "0000000000000001", fileId: "1".repeat(32) },
    candidate: { path: process.candidateRoot, volumeSerial: "0000000000000001", fileId: "2".repeat(32) },
  };
  function input(nativeText = JSON.stringify(data.native)) {
    const reports = {
      native: new TextEncoder().encode(nativeText),
      identity: new TextEncoder().encode(JSON.stringify(data.identity)),
      preservation: new TextEncoder().encode(JSON.stringify(data.preservation)),
    };
    const checks = data.result.checks.map((check, index) => {
      let evidence = reports.native;
      if (index === 0) evidence = reports.identity;
      else if (index === 6) evidence = reports.preservation;
      return { ...check, evidenceSha256: hash(evidence) };
    });
    return { job: data.job, result: { ...data.result, checks }, reports, process, filesystem };
  }
  return { data, input, process, filesystem };
}

describe("prepared native report verification", () => {
  it("accepts all seven checks backed by complete bound synthetic observations", () => {
    const f = fixture(), input = f.input();
    const result = validatePreparedReports(input);
    expect(result.policy).toBe("prepared-native-reports-v2");
    expect(result.evidenceSha256).toHaveLength(3);
    expect(Object.isFrozen(result.evidenceSha256)).toBe(true);
    expect(result).not.toHaveProperty("stopAdmission");
  });

  it("rejects every omitted native predicate even when the worker recomputes its evidence digest", () => {
    const names = Object.keys(object(fixture().data.native.checks));
    expect(names.length).toBeGreaterThan(100);
    for (const name of names) {
      const f = fixture(); delete object(f.data.native.checks)[name];
      expect(() => validatePreparedReports(f.input()), name).toThrow("predicate set");
    }
  });

  const corruptions: [string, (native: Data) => void][] = [
    ["empty predicates", (n) => { n.checks = {}; }],
    ["failed predicate", (n) => { object(n.checks).native_binary = false; }],
    ["unknown predicate", (n) => { object(n.checks).new_check = true; }],
    ["failed outcome", (n) => { n.outcome = "failed"; }],
    ["native error", (n) => { n.error = "failure"; }],
    ["release error", (n) => { n.releaseErrors = ["leak"]; }],
    ["wrong attempt", (n) => { n.attemptId = "00000000-0000-0000-0000-000000000000"; }],
    ["wrong request", (n) => { n.requestSha256 = "a".repeat(64); }],
    ["wrong process", (n) => { n.nativePid = 99; }],
    ["PID reuse", (n) => { n.nativeStartTicks = "639246000000000001"; }],
    ["foreign helper", (n) => { n.helperPid = 44; }],
    ["wrong package", (n) => { n.candidateRoot = "C:\\another"; }],
    ["missing native check", (n) => { n.verifiedChecks = ["dimension"]; }],
    ["changed result measurement", (n) => { object(n.measurements).afterDepthMm = 9; }],
    ["rebuild contradiction", (n) => { object(n.after_dimension).rebuild = false; }],
    ["feature error", (n) => { object(n.after_dimension).featureError = 1; }],
    ["wrong extrusion", (n) => { object(n.after_dimension).thin = true; }],
    ["wrong units", (n) => { object(n.after_dimension).depthM = 8; }],
    ["wrong mass volume", (n) => { array(object(n.after_dimension).massProperties)[3] = 0; }],
    ["nonfinite diagnostic", (n) => { array(object(n.after_dimension).massProperties)[11] = null; }],
    ["changed companion", (n) => { object(n.final_reopen_geometry_1).depthMm = 9; }],
    ["missing reopen", (n) => { delete n.final_reopen_geometry_0; }],
    ["save failed", (n) => { object(n.assembly_save).saved = false; }],
    ["dirty saved part", (n) => { object(n.part_save).dirty = true; }],
    ["read-only save target", (n) => { object(n.edit_targetOpen).options = 3; }],
    ["open errors", (n) => { object(n.final_reopen_assemblyOpen).errors = 1; }],
    ["unexpected warnings", (n) => { object(n.before_assemblyOpen).warnings = 64; }],
    ["external dependency", (n) => { n.before_geometry_0Dependencies = ["other", "C:\\other.SLDPRT"]; }],
    ["assembly dependency mismatch", (n) => { array(n.final_reopen_assemblyDependencies)[1] = "C:\\other.SLDPRT"; }],
    ["duplicate occurrence", (n) => { array(n.updatedOccurrences)[1] = array(n.updatedOccurrences)[0]; }],
    ["moved occurrence", (n) => { array(object(array(n.final_reopenOccurrences)[0]).transform)[9] = .1; }],
    ["wrong configuration", (n) => { object(array(n.final_reopenOccurrences)[0]).configuration = "Other"; }],
    ["suppressed component", (n) => { object(array(n.final_reopenOccurrences)[0]).suppression = 0; }],
  ];
  it.each(corruptions)("rejects %s despite all high-level pass flags", (_name, corrupt) => {
    const f = fixture(); corrupt(f.data.native);
    expect(() => validatePreparedReports(f.input())).toThrow();
  });

  it("rejects duplicate JSON fields instead of accepting the last value", () => {
    const f = fixture(), text = JSON.stringify(f.data.native).replace('"outcome":"passed"', '"outcome":"failed","outcome":"passed"');
    expect(() => validatePreparedReports(f.input(text))).toThrow("duplicate JSON key");
  });
  it("detects escaped duplicate keys", () => {
    const f = fixture(), text = JSON.stringify(f.data.native).replace('"outcome":"passed"', '"outcome":"passed","\\u006futcome":"passed"');
    expect(() => validatePreparedReports(f.input(text))).toThrow("duplicate JSON key");
  });
  it("rejects changed report bytes when the claimed digest is unchanged", () => {
    const input = fixture().input();
    input.reports.native = new TextEncoder().encode(new TextDecoder().decode(input.reports.native).replace('"helperPid":43', '"helperPid":44'));
    expect(() => validatePreparedReports(input)).toThrow("evidence role");
  });
  it("rejects matching but incorrect summary measurements", () => {
    const f = fixture(); object(f.data.native.measurements).afterDepthMm = 9;
    f.data.result = { ...f.data.result, measurements: { ...f.data.result.measurements, afterDepthMm: 9 } };
    expect(() => validatePreparedReports(f.input())).toThrow("after depth");
  });
  it("requires the correct evidence role for each mandatory check", () => {
    const input = fixture().input(); input.result.checks[0].evidenceSha256 = input.result.checks[1].evidenceSha256;
    expect(() => validatePreparedReports(input)).toThrow("evidence role");
  });
  it.each(["before", "after"])("rejects changed %s source bytes", (phase) => {
    const f = fixture(), row = f.data.preservation.find((v) => v.phase === phase)!;
    object(array(row.files)[0]).sha256 = "a".repeat(64);
    expect(() => validatePreparedReports(f.input())).toThrow("source preserved");
  });
  it("rejects a missing preservation observation", () => {
    const f = fixture(); f.data.preservation.pop();
    expect(() => validatePreparedReports(f.input())).toThrow("preservation observations");
  });
  it("rejects copying into the original package", () => {
    const f = fixture(); f.data.identity.packageRoot = f.process.candidateRoot;
    expect(() => validatePreparedReports(f.input())).toThrow("private path");
  });
  it.each(["C:\\junction\\candidate", "D:\\substituted\\candidate", "C:\\symbolic\\candidate"])(
    "rejects distinct path %s when trusted handles identify the same directory", (alias) => {
      const f = fixture();
      f.filesystem.candidate.path = alias; f.process.candidateRoot = alias;
      f.filesystem.candidate.fileId = f.filesystem.input.fileId;
      expect(() => validatePreparedReports(f.input())).toThrow("private input copy");
    },
  );
  it("does not accept a report-controlled input root with matching report hashes", () => {
    const f = fixture(); f.data.identity.packageRoot = "C:\\different\\input";
    expect(() => validatePreparedReports(f.input())).toThrow("private path");
  });
  it("requires filesystem admission even for otherwise complete evidence", () => {
    const f = fixture();
    expect(() => validatePreparedReports({ ...f.input(), filesystem: undefined! })).toThrow("filesystem admission");
  });
  it("binds the candidate filesystem path to the admitted process", () => {
    const f = fixture(); f.filesystem.candidate.path = "C:\\different\\candidate";
    expect(() => validatePreparedReports(f.input())).toThrow("private path");
  });
  it("rejects traversal in an admitted path rather than resolving it", () => {
    const f = fixture(); f.process.candidateRoot = "C:\\fixture\\..\\original";
    expect(() => validatePreparedReports(f.input())).toThrow("Windows path segments");
  });
  it("bounds report size", () => {
    const f = fixture();
    expect(() => validatePreparedReports(f.input(" ".repeat(4_000_001)))).toThrow("report size");
  });
});
