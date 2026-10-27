/**
 * Turns the fingerprint line a hosted session probe writes to its job log into
 * the finite drift result that selector repair starts from
 * (docs/provider-integration.md §"Selector repair"). Pure.
 *
 * A probe that cannot confirm the authenticated page is treated as possible
 * site drift, never as an expired session: the session paths (OVD-763) own
 * only the login, CAPTCHA and anonymous results the probe does classify.
 */
import {
  diff,
  matchesFingerprintVocabulary,
  parsePageFingerprint,
  PAGE_FINGERPRINT_SCHEMA,
  type FingerprintDiff,
  type FingerprintDiffClass,
  type FingerprintPage,
  type FingerprintRouteClass,
  type FingerprintVocabulary,
  type PageFingerprint,
} from "./fingerprint.js";

export const FINGERPRINT_LOG_KEY = "fixtureHealFingerprint";
export const DRIFT_RESULT_SCHEMA = "fixture-drift-result.v1";
export const DRIFT_TRIGGERS = ["authenticated_dashboard_not_confirmed"] as const;
export type DriftTrigger = (typeof DRIFT_TRIGGERS)[number];

/** What the probe's classifier needs to see, mirrored from its code. */
export type DriftReference = {
  provider: string;
  page: FingerprintPage;
  routeClass: FingerprintRouteClass;
  /** Groups that confirm the page. `need` mirrors the classifier: any one pattern, or all of them. */
  confirming: ReadonlyArray<{ group: string; need: "any" | "all" }>;
  /** Groups that classify the page as something else (login, CAPTCHA, anonymous, error). */
  terminal: ReadonlyArray<{ group: string; need: "any" | "all" }>;
  /** Selector groups that offer the page's entry point; at least one should match. */
  entrySelectors: readonly string[];
  /** Where the groups live, so the repair brief names the file. */
  locatorSource: string;
  /** The reviewed strings the probe's fingerprint may contain; log lines are re-validated against it. */
  vocabulary: FingerprintVocabulary;
};

export type DriftFinding =
  | { code: "fingerprint_unavailable" }
  | { code: "route_unexpected"; expected: FingerprintRouteClass; observed: FingerprintRouteClass }
  | { code: "confirming_group_unmatched" | "confirming_group_partial" | "terminal_group_partial"; group: string; matched: number; total: number }
  | { code: "entry_selectors_unmatched"; groups: string[] }
  | { code: "dialog_present"; count: number }
  | { code: "page_sparse"; textLength: PageFingerprint["textLength"] };

export type DriftResult = {
  schema: typeof DRIFT_RESULT_SCHEMA;
  provider: string;
  page: FingerprintPage;
  trigger: DriftTrigger;
  /** Always selector repair: the session-refresh path never receives this trigger. */
  nextStep: "selector_repair";
  driftClass: FingerprintDiffClass | "unknown";
  findings: DriftFinding[];
  /** Locator groups the repair should review first. */
  repairTargets: string[];
  locatorSource: string;
  fingerprint: PageFingerprint | null;
  baselineLabelsSha256: string | null;
  diff: FingerprintDiff | null;
};

/** One JSON line for the job log. A null fingerprint records that capture failed. */
export function formatFingerprintLogLine(trigger: DriftTrigger, fingerprint: PageFingerprint | null, vocabulary: FingerprintVocabulary): string {
  return JSON.stringify({ [FINGERPRINT_LOG_KEY]: PAGE_FINGERPRINT_SCHEMA, vocabularyDigest: vocabulary.digest, trigger, fingerprint });
}

function payloadOf(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return null;
  const { textPayload, jsonPayload } = entry as { textPayload?: unknown; jsonPayload?: unknown };
  if (typeof textPayload !== "string") return jsonPayload ?? null;
  try {
    return JSON.parse(textPayload);
  } catch {
    return null;
  }
}

/**
 * Read the one fingerprint line from `gcloud logging read --format=json`
 * output. Checks vocabulary identity before strict validation, including null captures.
 * Errors contain fixed text and, for vocabulary skew only, bounded hex digests.
 */
export function readFingerprintLogEntries(
  entries: unknown,
  vocabulary: FingerprintVocabulary,
): { trigger: DriftTrigger; fingerprint: PageFingerprint | null } {
  if (!Array.isArray(entries)) throw new Error("drift_log_invalid");
  const lines = entries
    .map(payloadOf)
    .filter((payload): payload is Record<string, unknown> =>
      Boolean(payload) && typeof payload === "object" && FINGERPRINT_LOG_KEY in (payload as object));
  if (lines.length === 0) throw new Error("drift_fingerprint_missing");
  if (lines.length > 1) throw new Error("drift_fingerprint_ambiguous");
  const [line] = lines;
  if (!matchesFingerprintVocabulary(line.vocabularyDigest, vocabulary)) throw new Error("drift_fingerprint_invalid");
  if (line[FINGERPRINT_LOG_KEY] !== PAGE_FINGERPRINT_SCHEMA || !DRIFT_TRIGGERS.includes(line.trigger as DriftTrigger)) {
    throw new Error("drift_fingerprint_invalid");
  }
  if (line.fingerprint === null) return { trigger: line.trigger as DriftTrigger, fingerprint: null };
  const fingerprint = parsePageFingerprint(line.fingerprint, vocabulary);
  if (!fingerprint) throw new Error("drift_fingerprint_invalid");
  return { trigger: line.trigger as DriftTrigger, fingerprint };
}

function referenceFindings(fp: PageFingerprint, reference: DriftReference): DriftFinding[] {
  const findings: DriftFinding[] = [];
  if (fp.routeClass !== reference.routeClass) {
    findings.push({ code: "route_unexpected", expected: reference.routeClass, observed: fp.routeClass });
  }
  for (const { group, need } of reference.confirming) {
    const tally = fp.signalGroups[group] ?? { matched: 0, total: 0 };
    if (tally.matched === 0) findings.push({ code: "confirming_group_unmatched", group, ...tally });
    else if (need === "all" && tally.matched < tally.total) findings.push({ code: "confirming_group_partial", group, ...tally });
  }
  for (const { group, need } of reference.terminal) {
    const tally = fp.signalGroups[group];
    // A partial anonymous page match suggests a logged-out page whose copy drifted.
    if (need === "all" && tally && tally.matched > 0 && tally.matched < tally.total) {
      findings.push({ code: "terminal_group_partial", group, ...tally });
    }
  }
  if (reference.entrySelectors.every((group) => (fp.selectorGroups[group]?.matched ?? 0) === 0)) {
    findings.push({ code: "entry_selectors_unmatched", groups: [...reference.entrySelectors] });
  }
  if (fp.landmarks.dialog > 0) findings.push({ code: "dialog_present", count: fp.landmarks.dialog });
  if (fp.textLength !== "normal") findings.push({ code: "page_sparse", textLength: fp.textLength });
  return findings;
}

function repairTargets(findings: readonly DriftFinding[]) {
  const targets = new Set<string>();
  for (const finding of findings) {
    if ("group" in finding) targets.add(finding.group);
    if (finding.code === "entry_selectors_unmatched") finding.groups.forEach((group) => targets.add(group));
    if (finding.code === "route_unexpected") targets.add("routes");
  }
  return [...targets];
}

/** Build the finite drift result. With a reviewed baseline, the class comes from `diff`. */
export function buildDriftResult(input: {
  trigger: DriftTrigger;
  fingerprint: PageFingerprint | null;
  reference: DriftReference;
  baseline?: PageFingerprint | null;
}): DriftResult {
  const { fingerprint: fp, reference } = input;
  for (const candidate of [fp, input.baseline]) {
    if (candidate && (candidate.provider !== reference.provider || candidate.page !== reference.page)) {
      throw new Error("drift_reference_mismatch");
    }
  }
  const findings = fp ? referenceFindings(fp, reference) : [{ code: "fingerprint_unavailable" as const }];
  const baseline = input.baseline ?? null;
  const fingerprintDiff = fp && baseline ? diff(baseline, fp) : null;
  let driftClass: DriftResult["driftClass"] = "unknown";
  if (fingerprintDiff) driftClass = fingerprintDiff.class;
  else if (fp) {
    driftClass = findings.some((finding) => finding.code === "route_unexpected") ? "route"
      : findings.some((finding) => finding.code !== "dialog_present" && finding.code !== "page_sparse") ? "selector"
      : "label";
  }
  return {
    schema: DRIFT_RESULT_SCHEMA,
    provider: reference.provider,
    page: reference.page,
    trigger: input.trigger,
    nextStep: "selector_repair",
    driftClass,
    findings,
    repairTargets: repairTargets(findings),
    locatorSource: reference.locatorSource,
    fingerprint: fp,
    baselineLabelsSha256: baseline?.labelsSha256 ?? null,
    diff: fingerprintDiff,
  };
}
