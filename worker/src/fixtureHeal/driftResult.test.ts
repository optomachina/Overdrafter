import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { XOMETRY_AUTH_PROBE_DRIFT_REFERENCE } from "../xometryAuthProbe.js";
import { buildDriftResult, formatFingerprintLogLine, readFingerprintLogEntries } from "./driftResult.js";
import { defineFingerprintVocabulary, fingerprint, parsePageFingerprint, type DomSnapshot, type PageFingerprint } from "./fingerprint.js";

const VOCABULARY = XOMETRY_AUTH_PROBE_DRIFT_REFERENCE.vocabulary;
/** tsx is a worker dependency only, so the CLI runs from worker/ (as documented), wherever vitest was started. */
const WORKER_DIR = resolve(import.meta.dirname, "../..");
const logMismatch = (observed: string, expected: string) =>
  `drift_fingerprint_vocabulary_mismatch: fingerprint=${observed}, checkout=${expected}; run the drift tool from the deployed image's commit`;
const baselineMismatch = (observed: string, expected: string) =>
  `drift_baseline_vocabulary_mismatch: baseline=${observed}, checkout=${expected}; the baseline's vocabulary digest differs from this checkout, so use a reviewed baseline captured with the deployed vocabulary, or drop --baseline`;

type Tallies = Pick<PageFingerprint, "signalGroups" | "selectorGroups">;
/** Each malformed tally a log line or baseline might carry; every one must be rejected, never normalized. */
const MALFORMED_TALLIES: Array<[string, (fp: Tallies) => void]> = [
  ["signal matched -1", (fp) => { fp.signalGroups.dashboardSignals.matched = -1; }],
  ["signal matched \"broken\"", (fp) => { (fp.signalGroups.dashboardSignals as { matched: unknown }).matched = "broken"; }],
  ["signal matched 999", (fp) => { fp.signalGroups.dashboardSignals.matched = 999; }],
  ["signal matched 1.5", (fp) => { fp.signalGroups.dashboardSignals.matched = 1.5; }],
  ["selector count -5", (fp) => { fp.selectorGroups.dashboardUploadButtons.selectors[0].count = -5; }],
  ["selector count \"x\"", (fp) => { (fp.selectorGroups.dashboardUploadButtons.selectors[0] as { count: unknown }).count = "x"; }],
  ["selector count over the cap", (fp) => {
    fp.selectorGroups.dashboardUploadButtons.selectors[0] = { count: 21, visible: true };
    fp.selectorGroups.dashboardUploadButtons.matched = 1;
  }],
  ["selector matched 77, total 42", (fp) => { Object.assign(fp.selectorGroups.dashboardUploadButtons, { matched: 77, total: 42 }); }],
  ["selector matched disagrees with its counts", (fp) => { fp.selectorGroups.dashboardUploadButtons.matched = 1; }],
  ["selector visible without a match", (fp) => { fp.selectorGroups.dashboardUploadButtons.selectors[0].visible = true; }],
];

function page(overrides: Partial<DomSnapshot> = {}): DomSnapshot {
  return {
    provider: "xometry", page: "upload", source: "session_probe", routeClass: "quote_home",
    bodyText: "Your quotes. Jordan Okafor. Q24-1234-5678. Quotes and orders are now in one place. ".repeat(4),
    landmarks: { main: 1, navigation: 1 },
    headings: ["Your quotes", "Q24-1234-5678 bracket"],
    buttons: ["New quote", "jordan@example.com"], links: ["Orders", "Help"], testIds: ["quote-row-Q24-1234"],
    selectorGroups: { dashboardUploadButtons: [{ count: 0, visible: false }], accountQuoteListStartButtons: [{ count: 0, visible: false }] },
    ...overrides,
  };
}

const logEntries = (line: string, extra: unknown[] = []) => [
  { textPayload: "Container called exit(1)." },
  { jsonPayload: { reason: "ovd419_guard_failed", stage: "probe_result", probeReason: "authenticated_dashboard_not_confirmed" } },
  { textPayload: line },
  ...extra,
];

describe("fixture drift result", () => {
  const fp = fingerprint(page(), VOCABULARY);

  it("reads the one fingerprint line from text or structured job log entries", () => {
    const line = formatFingerprintLogLine("authenticated_dashboard_not_confirmed", fp, VOCABULARY);
    expect(readFingerprintLogEntries(logEntries(line), VOCABULARY)).toEqual({ trigger: "authenticated_dashboard_not_confirmed", fingerprint: fp });
    const structured = [{ jsonPayload: JSON.parse(line) }];
    expect(readFingerprintLogEntries(structured, VOCABULARY).fingerprint).toEqual(fp);
    expect(line).not.toMatch(/"message"|"severity"|preconditionsEnforcedBeforeBrowserNetworkActivation|ovd419_guard_failed/);
  });

  it("fails with a fixed message on a missing, duplicated or edited line", () => {
    const line = formatFingerprintLogLine("authenticated_dashboard_not_confirmed", fp, VOCABULARY);
    expect(() => readFingerprintLogEntries({}, VOCABULARY)).toThrow("drift_log_invalid");
    expect(() => readFingerprintLogEntries(logEntries("{}").slice(0, 2), VOCABULARY)).toThrow("drift_fingerprint_missing");
    expect(() => readFingerprintLogEntries(logEntries(line, [{ textPayload: line }]), VOCABULARY)).toThrow("drift_fingerprint_ambiguous");
    const edited = JSON.parse(line);
    edited.fingerprint.buttons.labels.push("jordan okafor");
    expect(() => readFingerprintLogEntries([{ jsonPayload: edited }], VOCABULARY)).toThrow("drift_fingerprint_invalid");
    const groupKey = JSON.parse(line);
    groupKey.fingerprint.signalGroups.JordanOkaforQ24x1234x5678 = { matched: 1, total: 1 };
    expect(() => readFingerprintLogEntries([{ jsonPayload: groupKey }], VOCABULARY)).toThrow("drift_fingerprint_invalid");
    expect(() => readFingerprintLogEntries([{ jsonPayload: { ...JSON.parse(line), trigger: "login_required" } }], VOCABULARY)).toThrow(
      "drift_fingerprint_invalid",
    );
  });

  it.each([
    { signalGroups: { ...VOCABULARY.signalGroups, dashboardSignals: [...VOCABULARY.signalGroups.dashboardSignals, /dashboard/] } },
    { selectorGroups: { ...VOCABULARY.selectorGroups, startNewQuoteButtons: [...VOCABULARY.selectorGroups.startNewQuoteButtons, "button.new-quote"] } },
    { labels: new Set([...VOCABULARY.labels, "quote dashboard"]) },
    { labels: new Set([...VOCABULARY.labels].filter((label) => label !== "new quote")) },
  ])("reports vocabulary skew before validating a genuine line or baseline (%j)", (change) => {
    const skewed = defineFingerprintVocabulary({ ...VOCABULARY, ...change });
    const message = logMismatch(VOCABULARY.digest, skewed.digest);
    const line = formatFingerprintLogLine("authenticated_dashboard_not_confirmed", fp, VOCABULARY);
    expect(() => readFingerprintLogEntries(logEntries(line), skewed)).toThrow(message);
    expect(() => parsePageFingerprint(JSON.parse(JSON.stringify(fp)), skewed)).toThrow(message);
    // --baseline uses the same parser, before any comparison, but a stale baseline is not a wrong checkout.
    expect(() => parsePageFingerprint(JSON.parse(JSON.stringify(fp)), skewed, "baseline")).toThrow(baselineMismatch(VOCABULARY.digest, skewed.digest));
    const unavailable = formatFingerprintLogLine("authenticated_dashboard_not_confirmed", null, VOCABULARY);
    expect(() => readFingerprintLogEntries(logEntries(unavailable), skewed)).toThrow(message);
  });

  it.each(MALFORMED_TALLIES)("rejects a log line or baseline whose tally is malformed (%s)", (_, edit) => {
    const line = JSON.parse(formatFingerprintLogLine("authenticated_dashboard_not_confirmed", fp, VOCABULARY));
    edit(line.fingerprint);
    expect(() => readFingerprintLogEntries(logEntries(JSON.stringify(line)), VOCABULARY)).toThrow(/^drift_fingerprint_invalid$/);
    // The CLI turns a null baseline into drift_baseline_invalid (end to end below).
    expect(parsePageFingerprint(line.fingerprint, VOCABULARY, "baseline")).toBeNull();
  });

  it("rejects missing or malformed digests without echoing input", () => {
    const line = JSON.parse(formatFingerprintLogLine("authenticated_dashboard_not_confirmed", fp, VOCABULARY));
    for (const vocabularyDigest of [undefined, "Jordan Okafor", "a".repeat(17)]) {
      expect(() => readFingerprintLogEntries([{ jsonPayload: { ...line, vocabularyDigest } }], VOCABULARY)).toThrow(/^drift_fingerprint_invalid$/);
      expect(parsePageFingerprint({ ...fp, vocabularyDigest }, VOCABULARY)).toBeNull();
    }
  });

  it("reports a baseline vocabulary mismatch through the operator CLI", () => {
    const directory = mkdtempSync(join(tmpdir(), "ovd1041-baseline-"));
    try {
      const logsPath = join(directory, "logs.json"), baselinePath = join(directory, "baseline.json");
      const line = formatFingerprintLogLine("authenticated_dashboard_not_confirmed", fp, VOCABULARY);
      writeFileSync(logsPath, JSON.stringify(logEntries(line)));
      const skewed = defineFingerprintVocabulary({ ...VOCABULARY, labels: new Set([...VOCABULARY.labels, "quote dashboard"]) });
      const run = (baseline: unknown) => {
        writeFileSync(baselinePath, JSON.stringify(baseline));
        // `--import tsx` resolves from cwd: worker/node_modules, never a tsx installed above the repository.
        return spawnSync(process.execPath, ["--import", "tsx", "src/tools/xometryDriftResult.ts", logsPath, "--baseline", baselinePath], {
          cwd: WORKER_DIR, encoding: "utf8", timeout: 10_000,
        });
      };
      const matching = run(fp);
      expect(matching.status, matching.stderr).toBe(0);
      expect(JSON.parse(matching.stdout).driftClass).toBe("none");
      const mismatch = run(fingerprint(page(), skewed));
      expect(mismatch.status).toBe(1);
      expect(mismatch.stdout).toBe("");
      expect(mismatch.stderr.trim()).toBe(baselineMismatch(skewed.digest, VOCABULARY.digest));
      const invalid = run({ ...fp, vocabularyDigest: "Jordan Okafor" });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr.trim()).toBe("drift_baseline_invalid");
      const broken = structuredClone(fp);
      (broken.signalGroups.dashboardSignals as { matched: unknown }).matched = "broken";
      const malformed = run(broken);
      expect(malformed.status).toBe(1);
      expect(malformed.stdout).toBe("");
      expect(malformed.stderr.trim()).toBe("drift_baseline_invalid");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("names the unmatched dashboard markers and routes to selector repair", () => {
    const result = buildDriftResult({ trigger: "authenticated_dashboard_not_confirmed", fingerprint: fp, reference: XOMETRY_AUTH_PROBE_DRIFT_REFERENCE });
    expect(result).toMatchObject({
      schema: "fixture-drift-result.v1",
      provider: "xometry",
      nextStep: "selector_repair",
      driftClass: "selector",
      locatorSource: "worker/src/adapters/xometryConstraints.ts XOMETRY_LOCATORS",
      baselineLabelsSha256: null,
      diff: null,
    });
    expect(result.findings).toEqual([
      { code: "confirming_group_unmatched", group: "dashboardSignals", matched: 0, total: 3 },
      { code: "confirming_group_unmatched", group: "accountQuoteListSignals", matched: 0, total: 2 },
      { code: "entry_selectors_unmatched", groups: ["dashboardUploadButtons", "dashboardUploadPanels", "accountQuoteListStartButtons", "startNewQuoteButtons"] },
    ]);
    expect(result.repairTargets).toContain("dashboardSignals");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/jordan|okafor|q24-|example\.com|refresh/i);
  });

  it("flags a partial marker set, an unexpected route, a dialog and a sparse page", () => {
    const partial = fingerprint(page({ bodyText: "My Account", landmarks: { main: 1, dialog: 1 } }), VOCABULARY);
    const result = buildDriftResult({ trigger: "authenticated_dashboard_not_confirmed", fingerprint: partial, reference: XOMETRY_AUTH_PROBE_DRIFT_REFERENCE });
    expect(result.findings).toEqual(expect.arrayContaining([
      { code: "confirming_group_partial", group: "accountQuoteListSignals", matched: 1, total: 2 },
      { code: "dialog_present", count: 1 },
      { code: "page_sparse", textLength: "short" },
    ]));
    const moved = fingerprint(page({ routeClass: "provider_other" }), VOCABULARY);
    const routed = buildDriftResult({ trigger: "authenticated_dashboard_not_confirmed", fingerprint: moved, reference: XOMETRY_AUTH_PROBE_DRIFT_REFERENCE });
    expect(routed.driftClass).toBe("route");
    expect(routed.findings[0]).toEqual({ code: "route_unexpected", expected: "quote_home", observed: "provider_other" });
    expect(routed.repairTargets).toContain("routes");
  });

  it("calls out a logged-out page whose anonymous copy drifted", () => {
    const anonymous = fingerprint(page({ bodyText: "Already have an account? Start a quote." }), VOCABULARY);
    const result = buildDriftResult({ trigger: "authenticated_dashboard_not_confirmed", fingerprint: anonymous, reference: XOMETRY_AUTH_PROBE_DRIFT_REFERENCE });
    expect(result.findings).toContainEqual({ code: "terminal_group_partial", group: "anonymousQuoteHomeSignals", matched: 1, total: 2 });
    expect(result.nextStep).toBe("selector_repair");
  });

  it("uses the baseline diff for the class when a reviewed baseline is given", () => {
    const baseline = fingerprint(page({ bodyText: "Welcome back. Recent quotes. My Account. Part Library.".repeat(5) }), VOCABULARY);
    const result = buildDriftResult({ trigger: "authenticated_dashboard_not_confirmed", fingerprint: fp, baseline, reference: XOMETRY_AUTH_PROBE_DRIFT_REFERENCE });
    expect(result.driftClass).toBe("selector");
    expect(result.baselineLabelsSha256).toBe(baseline.labelsSha256);
    expect(result.diff?.signalGroups).toEqual(expect.arrayContaining([{ group: "dashboardSignals", from: 2, to: 0 }]));
  });

  it("records an unavailable capture without guessing a class", () => {
    const line = formatFingerprintLogLine("authenticated_dashboard_not_confirmed", null, VOCABULARY);
    const { trigger, fingerprint: missing } = readFingerprintLogEntries([{ textPayload: line }], VOCABULARY);
    const result = buildDriftResult({ trigger, fingerprint: missing, reference: XOMETRY_AUTH_PROBE_DRIFT_REFERENCE });
    expect(result).toMatchObject({ driftClass: "unknown", findings: [{ code: "fingerprint_unavailable" }], nextStep: "selector_repair" });
  });

  it("refuses a fingerprint or baseline from another provider or page", () => {
    const other = { ...fp, page: "login" as const };
    expect(() => buildDriftResult({ trigger: "authenticated_dashboard_not_confirmed", fingerprint: other, reference: XOMETRY_AUTH_PROBE_DRIFT_REFERENCE })).toThrow(
      "drift_reference_mismatch",
    );
  });
});
