/**
 * OVD-796 slice 5, first part: the scrubbed page fingerprint. Pure: no I/O,
 * no clock. `fingerprint` normalizes a structural DOM snapshot into a
 * PageFingerprint and `diff` compares two of them into a finite class (§4.3
 * of the fixture self-healing design).
 *
 * Page text never leaves this module. A label survives only when the whole
 * label is a reviewed UI phrase, and a test ID only when it is a reviewed test
 * ID: word-by-word filtering cannot work, because any vocabulary word ("An",
 * "Go", "More") can also be a name. Group names come from the caller's
 * reviewed locator groups. Everything else is a fixed enum value or a count.
 */
import { createHash } from "node:crypto";

export const PAGE_FINGERPRINT_SCHEMA = "fixture-page-fingerprint.v1";

export const FINGERPRINT_PAGES = ["login", "upload", "pricing", "public"] as const;
export const FINGERPRINT_SOURCES = ["daily_job", "session_probe", "live_quote", "certification"] as const;
/** The final URL as a path class. The URL itself is never kept. */
export const FINGERPRINT_ROUTE_CLASSES = [
  "quote_home", "quote_new", "quote_page", "login", "provider_other", "external", "invalid",
] as const;
export const FINGERPRINT_LANDMARKS = [
  "banner", "navigation", "main", "contentinfo", "complementary", "search", "form", "region", "dialog", "alert",
] as const;
export const FINGERPRINT_TEXT_LENGTHS = ["empty", "short", "normal"] as const;

export type FingerprintPage = (typeof FINGERPRINT_PAGES)[number];
export type FingerprintSource = (typeof FINGERPRINT_SOURCES)[number];
export type FingerprintRouteClass = (typeof FINGERPRINT_ROUTE_CLASSES)[number];
export type FingerprintLandmark = (typeof FINGERPRINT_LANDMARKS)[number];

const MAX_COUNT = 500;
const MAX_SELECTOR_COUNT = 20;
const MAX_RAW_ITEMS = 300;
const MAX_RAW_TEXT = 400;
const SHORT_TEXT_CHARS = 200;
const PROVIDER_KEY = /^[a-z][a-z0-9_]{1,40}$/;

/**
 * Complete UI labels common to supplier portals, normalized (lowercase words,
 * single spaces). Reviewed by hand: add whole chrome labels only, never a
 * phrase that could be someone's name. Providers add their own locator text.
 */
export const UI_LABEL_PHRASES: readonly string[] = [
  "account", "account settings", "back", "cancel", "cart", "close", "close menu", "contact us", "continue",
  "dashboard", "delete", "download", "drafts", "edit", "export csv", "favorites", "get a quote", "get started",
  "help", "help center", "home", "instant quote", "log in", "log out", "logout", "menu", "messages",
  "my account", "my orders", "my quotes", "new quote", "next", "notifications", "open menu", "order history",
  "orders", "part library", "parts", "personal quotes", "privacy policy", "profile", "quote history", "quotes",
  "recent quotes", "register", "resources", "save", "search", "see all", "settings", "share", "sign in",
  "sign out", "skip to content", "skip to main content", "submit", "support", "team", "terms and conditions",
  "terms of use", "tools", "upload", "upload parts", "view all", "view quote", "welcome back", "your quotes",
];

/** The reviewed strings a fingerprint may contain. Built by the caller from its locator constants. */
export type FingerprintVocabulary = {
  /** Short hash of reviewed constants, computed when the vocabulary is defined. */
  readonly digest: string;
  /** Text-signal groups tallied against the body text. */
  signalGroups: Readonly<Record<string, readonly RegExp[]>>;
  /** Selector groups the caller measures on the page, in this order. */
  selectorGroups: Readonly<Record<string, readonly string[]>>;
  /** Complete labels kept verbatim, normalized with `normalizeLabel`. */
  labels: ReadonlySet<string>;
  /** Test IDs kept verbatim. */
  testIds: ReadonlySet<string>;
};

export type GroupTally = { matched: number; total: number };
export type SelectorMeasure = { count: number; visible: boolean };
export type SelectorGroupTally = GroupTally & { selectors: SelectorMeasure[] };
export type LabelSet = { count: number; labels: string[] };

/** What the page showed, collected read-only. Held in memory only; never logged. */
export type DomSnapshot = {
  provider: string;
  page: FingerprintPage;
  source: FingerprintSource;
  routeClass: FingerprintRouteClass;
  /** Visible body text. Used only to tally signal groups. */
  bodyText: string;
  landmarks: Readonly<Record<string, number>>;
  headings: readonly string[];
  buttons: readonly string[];
  links: readonly string[];
  testIds: readonly string[];
  /** Per selector group, one measure per selector in vocabulary order. */
  selectorGroups: Readonly<Record<string, readonly SelectorMeasure[]>>;
};

export type PageFingerprint = {
  schema: typeof PAGE_FINGERPRINT_SCHEMA;
  vocabularyDigest: string;
  provider: string;
  page: FingerprintPage;
  source: FingerprintSource;
  routeClass: FingerprintRouteClass;
  textLength: (typeof FINGERPRINT_TEXT_LENGTHS)[number];
  landmarks: Record<FingerprintLandmark, number>;
  /** All elements of each kind are counted; only reviewed labels are listed. */
  headings: LabelSet;
  buttons: LabelSet;
  links: LabelSet;
  testIds: { count: number; values: string[]; withheld: number };
  /** sha256 of every listed label and test ID, for a quick equality check. */
  labelsSha256: string;
  /** Per text-signal group: how many of its patterns matched the body text. */
  signalGroups: Record<string, GroupTally>;
  /** Per selector group: per-selector element count (capped) and first-match visibility. */
  selectorGroups: Record<string, SelectorGroupTally>;
};

const compareCodeUnits = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Canonical keys/sets; array order is retained because selector indices have meaning. No page data. */
export function defineFingerprintVocabulary(vocabulary: Omit<FingerprintVocabulary, "digest">): FingerprintVocabulary {
  const canonical = {
    signalGroups: Object.keys(vocabulary.signalGroups).sort(compareCodeUnits).map((name) =>
      [name, vocabulary.signalGroups[name].map((pattern) => [pattern.source, pattern.flags])]),
    selectorGroups: Object.keys(vocabulary.selectorGroups).sort(compareCodeUnits).map((name) =>
      [name, vocabulary.selectorGroups[name]]),
    labels: [...vocabulary.labels].sort(compareCodeUnits),
    testIds: [...vocabulary.testIds].sort(compareCodeUnits),
  };
  return { ...vocabulary, digest: createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16) };
}

/** Which artifact carried the digest: the job's log line, or a reviewed baseline passed with `--baseline`. */
export type FingerprintArtifact = "fingerprint" | "baseline";

export class FingerprintVocabularyMismatchError extends Error {
  constructor(observed: string, expected: string, artifact: FingerprintArtifact = "fingerprint") {
    // The log line carries the deployed vocabulary, so a checkout that differs is the wrong commit. The drift tool checks a
    // baseline only after the log line matched this checkout, so a baseline that differs is stale; switching commits
    // would only make the log line mismatch instead.
    super(artifact === "baseline"
      ? `drift_baseline_vocabulary_mismatch: baseline=${observed}, checkout=${expected}; the baseline's vocabulary digest differs from this checkout, so use a reviewed baseline captured with the deployed vocabulary, or drop --baseline`
      : `drift_fingerprint_vocabulary_mismatch: fingerprint=${observed}, checkout=${expected}; run the drift tool from the deployed image's commit`);
  }
}

/** Malformed/missing digests are invalid; only bounded hex digests may appear in diagnostics. */
export function matchesFingerprintVocabulary(
  observed: unknown,
  vocabulary: FingerprintVocabulary,
  artifact: FingerprintArtifact = "fingerprint",
): boolean {
  if (typeof observed !== "string" || !/^[a-f0-9]{16}$/.test(observed)) return false;
  if (observed !== vocabulary.digest) throw new FingerprintVocabularyMismatchError(observed, vocabulary.digest, artifact);
  return true;
}

function clampCount(value: unknown, max = MAX_COUNT) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.trunc(value))) : 0;
}

/** A read-back count is valid only as the producer writes it: an integer in 0..max. Never normalized. */
const isCount = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

/** Lowercase words joined by single spaces: the form reviewed phrases are written in. */
export function normalizeLabel(raw: string): string {
  return (raw.slice(0, MAX_RAW_TEXT).normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join(" ");
}

function labelSet(raw: readonly string[], phrases: ReadonlySet<string>): LabelSet {
  const labels = [...new Set(raw.map(normalizeLabel).filter((label) => phrases.has(label)))].sort(compareCodeUnits);
  return { count: clampCount(raw.length), labels };
}

function testIdSet(raw: readonly string[], known: ReadonlySet<string>): PageFingerprint["testIds"] {
  const distinct = [...new Set(raw)];
  const values = distinct.filter((id) => known.has(id)).sort(compareCodeUnits);
  return { count: clampCount(raw.length), values, withheld: clampCount(distinct.length - values.length) };
}

function tallySignals(bodyText: string, groups: FingerprintVocabulary["signalGroups"]) {
  const tallies: Record<string, GroupTally> = {};
  for (const name of Object.keys(groups).sort(compareCodeUnits)) {
    // Fresh non-global copies so a shared pattern's lastIndex never skews the tally.
    const matched = groups[name].filter((pattern) => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(bodyText)).length;
    tallies[name] = { matched, total: groups[name].length };
  }
  return tallies;
}

function selectorTally(measures: readonly unknown[], total: number): SelectorGroupTally {
  const selectors = Array.from({ length: total }, (_, index) => {
    const measure = measures[index] as Partial<SelectorMeasure> | undefined;
    const count = clampCount(measure?.count, MAX_SELECTOR_COUNT);
    return { count, visible: count > 0 && measure?.visible === true };
  });
  return { matched: selectors.filter(({ count }) => count > 0).length, total, selectors };
}

function selectorTallies(measured: DomSnapshot["selectorGroups"], groups: FingerprintVocabulary["selectorGroups"]) {
  const tallies: Record<string, SelectorGroupTally> = {};
  for (const name of Object.keys(groups).sort(compareCodeUnits)) {
    if (measured[name]) tallies[name] = selectorTally(measured[name], groups[name].length);
  }
  return tallies;
}

function labelsHash(fp: Pick<PageFingerprint, "headings" | "buttons" | "links" | "testIds">) {
  const listed = [fp.headings.labels, fp.buttons.labels, fp.links.labels, fp.testIds.values];
  return createHash("sha256").update(JSON.stringify(listed)).digest("hex");
}

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}

function landmarkCounts(source: Readonly<Record<string, unknown>>) {
  return Object.fromEntries(
    FINGERPRINT_LANDMARKS.map((role) => [role, clampCount(source[role], 50)]),
  ) as Record<FingerprintLandmark, number>;
}

/** Normalize a snapshot into the scrubbed fingerprint, keeping only what the vocabulary names. */
export function fingerprint(snapshot: DomSnapshot, vocabulary: FingerprintVocabulary): PageFingerprint {
  if (!PROVIDER_KEY.test(snapshot.provider)) throw new Error("fingerprint provider key is invalid");
  const trimmedLength = snapshot.bodyText.trim().length;
  const listed = {
    headings: labelSet(snapshot.headings, vocabulary.labels),
    buttons: labelSet(snapshot.buttons, vocabulary.labels),
    links: labelSet(snapshot.links, vocabulary.labels),
    testIds: testIdSet(snapshot.testIds, vocabulary.testIds),
  };
  return {
    schema: PAGE_FINGERPRINT_SCHEMA,
    vocabularyDigest: vocabulary.digest,
    provider: snapshot.provider,
    page: oneOf(FINGERPRINT_PAGES, snapshot.page, "upload"),
    source: oneOf(FINGERPRINT_SOURCES, snapshot.source, "session_probe"),
    routeClass: oneOf(FINGERPRINT_ROUTE_CLASSES, snapshot.routeClass, "invalid"),
    textLength: trimmedLength === 0 ? "empty" : trimmedLength < SHORT_TEXT_CHARS ? "short" : "normal",
    landmarks: landmarkCounts(snapshot.landmarks),
    ...listed,
    labelsSha256: labelsHash(listed),
    signalGroups: tallySignals(snapshot.bodyText, vocabulary.signalGroups),
    selectorGroups: selectorTallies(snapshot.selectorGroups, vocabulary.selectorGroups),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const rawStrings = (value: unknown) =>
  (Array.isArray(value) ? value.slice(0, MAX_RAW_ITEMS) : []).map((item) => (typeof item === "string" ? item.slice(0, MAX_RAW_TEXT) : ""));

/** Coerce what a page evaluation returned into bounded snapshot fields. A page can return anything. */
export function coerceDomStructure(value: unknown): Pick<DomSnapshot, "landmarks" | "headings" | "buttons" | "links" | "testIds"> | null {
  if (!isRecord(value)) return null;
  return {
    landmarks: landmarkCounts(isRecord(value.landmarks) ? value.landmarks : {}),
    headings: rawStrings(value.headings),
    buttons: rawStrings(value.buttons),
    links: rawStrings(value.links),
    testIds: rawStrings(value.testIds),
  };
}

function parseLabelSet(value: unknown, phrases: ReadonlySet<string>): LabelSet | null {
  if (!isRecord(value) || !Array.isArray(value.labels)) return null;
  if (!value.labels.every((label) => typeof label === "string" && phrases.has(label))) return null;
  return { count: clampCount(value.count), labels: [...new Set(value.labels as string[])].sort(compareCodeUnits) };
}

/** Only the vocabulary's group names, each with a well-formed tally of the expected size. */
function parseGroups<T>(value: unknown, names: readonly string[], parse: (tally: Record<string, unknown>, name: string) => T | null) {
  if (!isRecord(value) || !Object.keys(value).every((name) => names.includes(name))) return null;
  const out: Record<string, T> = {};
  for (const name of Object.keys(value).sort(compareCodeUnits)) {
    const tally = value[name];
    const parsed = isRecord(tally) ? parse(tally, name) : null;
    if (!parsed) return null;
    out[name] = parsed;
  }
  return out;
}

/**
 * Re-validate a fingerprint read back from a log line (or a reviewed baseline)
 * against the same vocabulary that produced it. Any label, test ID or group
 * name outside the vocabulary, any malformed tally, or a hash that no longer
 * matches makes the line invalid, so an edited line cannot carry text into a
 * drift result. A tally is malformed unless `total` is the vocabulary group's
 * size and `matched` is an integer in 0..total; a selector tally also needs
 * one measure per selector, each an integer count in 0..20 with a boolean
 * `visible` (never visible without a match), and `matched` must equal the
 * number of selectors with a match. Tallies are never clamped or recomputed
 * into validity; landmark, heading/button/link and test-ID counts are still
 * clamped to their bounds (numbers only, no page text). Throws on vocabulary skew before validating page fields (naming
 * `artifact`); otherwise returns null when anything fails.
 */
export function parsePageFingerprint(
  value: unknown,
  vocabulary: FingerprintVocabulary,
  artifact: FingerprintArtifact = "fingerprint",
): PageFingerprint | null {
  if (!isRecord(value) || value.schema !== PAGE_FINGERPRINT_SCHEMA) return null;
  if (!matchesFingerprintVocabulary(value.vocabularyDigest, vocabulary, artifact)) return null;
  if (typeof value.provider !== "string" || !PROVIDER_KEY.test(value.provider)) return null;
  const headings = parseLabelSet(value.headings, vocabulary.labels);
  const buttons = parseLabelSet(value.buttons, vocabulary.labels);
  const links = parseLabelSet(value.links, vocabulary.labels);
  const rawTestIds = isRecord(value.testIds) && Array.isArray(value.testIds.values) ? value.testIds.values : null;
  if (!headings || !buttons || !links || !rawTestIds || !isRecord(value.testIds)) return null;
  if (!rawTestIds.every((id) => typeof id === "string" && vocabulary.testIds.has(id))) return null;
  const testIds = {
    count: clampCount(value.testIds.count),
    values: [...new Set(rawTestIds as string[])].sort(compareCodeUnits),
    withheld: clampCount(value.testIds.withheld),
  };
  const signalGroups = parseGroups(value.signalGroups, Object.keys(vocabulary.signalGroups), (tally, name): GroupTally | null => {
    const total = vocabulary.signalGroups[name].length;
    return tally.total === total && isCount(tally.matched, total) ? { matched: tally.matched, total } : null;
  });
  const selectorGroups = parseGroups(value.selectorGroups, Object.keys(vocabulary.selectorGroups), (tally, name): SelectorGroupTally | null => {
    const total = vocabulary.selectorGroups[name].length;
    if (tally.total !== total || !Array.isArray(tally.selectors) || tally.selectors.length !== total) return null;
    const selectors: SelectorMeasure[] = [];
    for (const measure of tally.selectors as unknown[]) {
      if (!isRecord(measure) || !isCount(measure.count, MAX_SELECTOR_COUNT) || typeof measure.visible !== "boolean") return null;
      if (measure.visible && measure.count === 0) return null;
      selectors.push({ count: measure.count, visible: measure.visible });
    }
    const matched = selectors.filter(({ count }) => count > 0).length;
    return tally.matched === matched ? { matched, total, selectors } : null;
  });
  if (
    !signalGroups || !selectorGroups || !isRecord(value.landmarks) ||
    !FINGERPRINT_PAGES.includes(value.page as FingerprintPage) ||
    !FINGERPRINT_SOURCES.includes(value.source as FingerprintSource) ||
    !FINGERPRINT_ROUTE_CLASSES.includes(value.routeClass as FingerprintRouteClass) ||
    !FINGERPRINT_TEXT_LENGTHS.includes(value.textLength as PageFingerprint["textLength"])
  ) {
    return null;
  }
  const listed = { headings, buttons, links, testIds };
  const parsed: PageFingerprint = {
    schema: PAGE_FINGERPRINT_SCHEMA,
    vocabularyDigest: vocabulary.digest,
    provider: value.provider,
    page: value.page as FingerprintPage,
    source: value.source as FingerprintSource,
    routeClass: value.routeClass as FingerprintRouteClass,
    textLength: value.textLength as PageFingerprint["textLength"],
    landmarks: landmarkCounts(value.landmarks),
    ...listed,
    labelsSha256: labelsHash(listed),
    signalGroups,
    selectorGroups,
  };
  return parsed.labelsSha256 === value.labelsSha256 ? parsed : null;
}

export type FingerprintDiffClass = "none" | "cosmetic" | "label" | "selector" | "route";
export type GroupChange = { group: string; from: number | null; to: number | null };
export type SelectorChange = { group: string; index: number; from: SelectorMeasure | null; to: SelectorMeasure | null };

export type FingerprintDiff = {
  class: FingerprintDiffClass;
  route: { from: FingerprintRouteClass; to: FingerprintRouteClass } | null;
  signalGroups: GroupChange[];
  /** Per-selector count or visibility changes, the §4.3 selector signal. */
  selectors: SelectorChange[];
  labels: { added: string[]; removed: string[] };
  testIds: { added: string[]; removed: string[] };
  landmarks: Array<{ role: FingerprintLandmark; from: number; to: number }>;
};

const groupNames = (base: Record<string, unknown>, next: Record<string, unknown>) =>
  [...new Set([...Object.keys(base), ...Object.keys(next)])].sort(compareCodeUnits);

function signalChanges(base: Record<string, GroupTally>, next: Record<string, GroupTally>): GroupChange[] {
  return groupNames(base, next)
    .map((group) => ({ group, from: base[group]?.matched ?? null, to: next[group]?.matched ?? null }))
    .filter(({ from, to }) => from !== to);
}

function selectorChanges(base: Record<string, SelectorGroupTally>, next: Record<string, SelectorGroupTally>): SelectorChange[] {
  return groupNames(base, next).flatMap((group) => {
    const length = Math.max(base[group]?.selectors.length ?? 0, next[group]?.selectors.length ?? 0);
    return Array.from({ length }, (_, index) => ({
      group,
      index,
      from: base[group]?.selectors[index] ?? null,
      to: next[group]?.selectors[index] ?? null,
    })).filter(({ from, to }) => from?.count !== to?.count || from?.visible !== to?.visible);
  });
}

const allLabels = (fp: PageFingerprint) => [
  ...fp.headings.labels.map((label) => `heading:${label}`),
  ...fp.buttons.labels.map((label) => `button:${label}`),
  ...fp.links.labels.map((label) => `link:${label}`),
];

function setChanges(base: readonly string[], next: readonly string[]) {
  const before = new Set(base), after = new Set(next);
  return {
    added: [...after].filter((item) => !before.has(item)).sort(compareCodeUnits),
    removed: [...before].filter((item) => !after.has(item)).sort(compareCodeUnits),
  };
}

/** Compare a reviewed baseline with a new fingerprint. The class is the most severe change found. */
export function diff(base: PageFingerprint, next: PageFingerprint): FingerprintDiff {
  const signalGroups = signalChanges(base.signalGroups, next.signalGroups);
  const selectors = selectorChanges(base.selectorGroups, next.selectorGroups);
  const labels = setChanges(allLabels(base), allLabels(next));
  const testIds = setChanges(base.testIds.values, next.testIds.values);
  const landmarks = FINGERPRINT_LANDMARKS
    .filter((role) => base.landmarks[role] !== next.landmarks[role])
    .map((role) => ({ role, from: base.landmarks[role], to: next.landmarks[role] }));
  const route = base.routeClass === next.routeClass ? null : { from: base.routeClass, to: next.routeClass };
  const cosmetic = landmarks.length > 0 || base.textLength !== next.textLength ||
    base.testIds.count !== next.testIds.count || base.testIds.withheld !== next.testIds.withheld ||
    (["headings", "buttons", "links"] as const).some((kind) => base[kind].count !== next[kind].count);
  let kind: FingerprintDiffClass = "none";
  if (route) kind = "route";
  else if (signalGroups.length + selectors.length > 0) kind = "selector";
  else if (base.labelsSha256 !== next.labelsSha256) kind = "label";
  else if (cosmetic) kind = "cosmetic";
  return { class: kind, route, signalGroups, selectors, labels, testIds, landmarks };
}
