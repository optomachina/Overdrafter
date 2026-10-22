import { describe, expect, it } from "vitest";
import { XOMETRY_AUTH_PROBE_DRIFT_REFERENCE } from "../xometryAuthProbe.js";
import { buildDriftResult, formatFingerprintLogLine, readFingerprintLogEntries } from "./driftResult.js";
import { fingerprint, type DomSnapshot } from "./fingerprint.js";

const VOCABULARY = XOMETRY_AUTH_PROBE_DRIFT_REFERENCE.vocabulary;

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
    const line = formatFingerprintLogLine("authenticated_dashboard_not_confirmed", fp);
    expect(readFingerprintLogEntries(logEntries(line), VOCABULARY)).toEqual({ trigger: "authenticated_dashboard_not_confirmed", fingerprint: fp });
    const structured = [{ jsonPayload: JSON.parse(line) }];
    expect(readFingerprintLogEntries(structured, VOCABULARY).fingerprint).toEqual(fp);
    expect(line).not.toMatch(/"message"|"severity"|preconditionsEnforcedBeforeBrowserNetworkActivation|ovd419_guard_failed/);
  });

  it("fails with a fixed message on a missing, duplicated or edited line", () => {
    const line = formatFingerprintLogLine("authenticated_dashboard_not_confirmed", fp);
    expect(() => readFingerprintLogEntries({}, VOCABULARY)).toThrow("drift_log_invalid");
    expect(() => readFingerprintLogEntries(logEntries("{}").slice(0, 2), VOCABULARY)).toThrow("drift_fingerprint_missing");
    expect(() => readFingerprintLogEntries(logEntries(line, [{ textPayload: line }]), VOCABULARY)).toThrow("drift_fingerprint_ambiguous");
    const edited = JSON.parse(line);
    edited.fingerprint.links.labels.push("jordan okafor");
    expect(() => readFingerprintLogEntries([{ jsonPayload: edited }], VOCABULARY)).toThrow("drift_fingerprint_invalid");
    const groupKey = JSON.parse(line);
    groupKey.fingerprint.signalGroups.JordanOkaforQ24x1234x5678 = { matched: 1, total: 1 };
    expect(() => readFingerprintLogEntries([{ jsonPayload: groupKey }], VOCABULARY)).toThrow("drift_fingerprint_invalid");
    expect(() => readFingerprintLogEntries([{ jsonPayload: { ...JSON.parse(line), trigger: "login_required" } }], VOCABULARY)).toThrow(
      "drift_fingerprint_invalid",
    );
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
    const line = formatFingerprintLogLine("authenticated_dashboard_not_confirmed", null);
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
