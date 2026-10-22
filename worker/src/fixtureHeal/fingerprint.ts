/**
 * OVD-796 slice 5, first part: the scrubbed page fingerprint. Pure: no I/O,
 * no clock. `fingerprint` normalizes a structural DOM snapshot into a
 * PageFingerprint and `diff` compares two of them into a finite class (§4.3
 * of the fixture self-healing design).
 *
 * Page text never leaves this module. A label survives only as words from
 * the fixed UI vocabulary below; every other word is masked as "*". Test IDs
 * survive only when every word is in the vocabulary. Everything else is a
 * fixed enum value or a count. The one hash covers scrubbed values only, so it
 * cannot confirm a guessed name, email or quote number.
 */
import { createHash } from "node:crypto";

export const PAGE_FINGERPRINT_SCHEMA = "fixture-page-fingerprint.v1";
export const FINGERPRINT_MASK = "*";

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
const MAX_GROUP_SIZE = 50;
const MAX_LABELS = 30;
const MAX_LABEL_TOKENS = 6;
const MAX_TEST_IDS = 30;
const MAX_TEST_ID_LENGTH = 80;
const MAX_RAW_ITEMS = 300;
const MAX_RAW_TEXT = 400;
const SHORT_TEXT_CHARS = 200;
const PROVIDER_KEY = /^[a-z][a-z0-9_]{1,40}$/;
const GROUP_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/;

/**
 * Words a provider's UI chrome uses: navigation, buttons, headings, the auth
 * probe's own signal phrases. Reviewed by hand. Never add personal names,
 * surnames that are also words (price, page, grant, mark, will), or any token
 * that contains digits other than "3d".
 */
export const LABEL_VOCABULARY: ReadonlySet<string> = new Set([
  "3d", "a", "able", "about", "access", "account", "activity", "add", "again", "all", "already", "an",
  "and", "anodize", "any", "apply", "are", "as", "assembly", "at", "back", "be", "blocked", "browse",
  "business", "button", "by", "cad", "cancel", "captcha", "cart", "catalog", "center", "change",
  "checkout", "choose", "clear", "close", "cnc", "company", "configuration", "configure", "confirm",
  "contact", "content", "continue", "control", "controlled", "copy", "create", "csv", "current",
  "dashboard", "delete", "denied", "design", "details", "dfm", "dialog", "discount", "dismiss", "done",
  "download", "drafts", "drag", "drawing", "drawings", "drop", "edit", "email", "enter", "error",
  "explore", "export", "favorites", "feedback", "file", "files", "filter", "finish", "for", "from",
  "get", "go", "got", "guide", "have", "help", "here", "hide", "history", "home", "how", "human", "if",
  "in", "info", "instant", "is", "it", "itar", "item", "items", "lead", "learn", "left", "library",
  "list", "load", "loading", "log", "login", "logout", "machining", "manage", "manufacturing",
  "material", "materials", "menu", "message", "messages", "model", "models", "more", "my", "name",
  "navigate", "navigation", "need", "new", "newly", "next", "no", "not", "notifications", "now", "of",
  "off", "ok", "okay", "on", "open", "option", "options", "or", "order", "orders", "our", "out",
  "overview", "panel", "part", "parts", "password", "pending", "personal", "pick", "please", "popup",
  "previous", "primary", "pricing", "privacy", "process", "processes", "profile", "quantity", "quote",
  "quotes", "quoting", "recaptcha", "recent", "register", "regulation", "rename", "request", "requests",
  "required", "requirements", "resources", "review", "row", "save", "saved", "search", "secondary",
  "see", "select", "selected", "settings", "share", "shipping", "show", "sign", "something", "sort",
  "start", "status", "step", "subject", "submit", "summary", "support", "tab", "table", "tabs", "team",
  "terms", "the", "there", "this", "tier", "time", "to", "toggle", "tools", "track", "try", "type",
  "up", "update", "upload", "uploads", "use", "verify", "view", "was", "welcome", "went", "what",
  "where", "with", "workspace", "wrong", "yes", "you", "your",
]);

export type GroupTally = { matched: number; total: number };
export type LabelSet = { count: number; labels: string[]; omitted: number };

/** What the page showed, collected read-only. Held in memory only; never logged. */
export type DomSnapshot = {
  provider: string;
  page: FingerprintPage;
  source: FingerprintSource;
  routeClass: FingerprintRouteClass;
  /** Visible body text. Used only to tally signal groups. */
  bodyText: string;
  landmarks: Readonly<Record<string, number>>;
  headings: ReadonlyArray<{ level: number; label: string }>;
  buttons: readonly string[];
  links: readonly string[];
  testIds: readonly string[];
  /** Per locator group: how many of its selectors matched at least one element. */
  selectorGroups: Readonly<Record<string, GroupTally>>;
};

export type PageFingerprint = {
  schema: typeof PAGE_FINGERPRINT_SCHEMA;
  provider: string;
  page: FingerprintPage;
  source: FingerprintSource;
  routeClass: FingerprintRouteClass;
  textLength: (typeof FINGERPRINT_TEXT_LENGTHS)[number];
  landmarks: Record<FingerprintLandmark, number>;
  headings: LabelSet;
  buttons: LabelSet;
  links: LabelSet;
  testIds: { count: number; values: string[]; withheld: number };
  /** sha256 of the scrubbed labels and test IDs, for a quick equality check. */
  labelsSha256: string;
  /** Per text-signal group: how many of its patterns matched the body text. */
  signalGroups: Record<string, GroupTally>;
  selectorGroups: Record<string, GroupTally>;
};

const compareCodeUnits = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function clampCount(value: unknown, max = MAX_COUNT) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.trunc(value))) : 0;
}

function words(raw: string) {
  return raw
    .slice(0, MAX_RAW_TEXT)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Keep vocabulary words, mask every other run of words as one "*". */
export function maskLabel(raw: string): string {
  const out: string[] = [];
  for (const token of words(raw)) {
    const word = LABEL_VOCABULARY.has(token) ? token : FINGERPRINT_MASK;
    if (word !== FINGERPRINT_MASK || out.at(-1) !== FINGERPRINT_MASK) out.push(word);
  }
  if (out.length <= MAX_LABEL_TOKENS) return out.join(" ");
  const kept = out.slice(0, MAX_LABEL_TOKENS - 1);
  if (kept.at(-1) !== FINGERPRINT_MASK) kept.push(FINGERPRINT_MASK);
  return kept.join(" ");
}

const informative = (label: string) => label.split(" ").some((word) => word !== FINGERPRINT_MASK && word !== "");

function labelSet(masked: readonly string[], count: number): LabelSet {
  const distinct = [...new Set(masked.filter(informative))].sort(compareCodeUnits);
  return { count: clampCount(count), labels: distinct.slice(0, MAX_LABELS), omitted: Math.max(0, distinct.length - MAX_LABELS) };
}

/** A test ID is kept verbatim only when it is letters and separators and every word is vocabulary. */
export function safeTestId(value: string): boolean {
  if (value.length === 0 || value.length > MAX_TEST_ID_LENGTH || !/^[A-Za-z][A-Za-z_-]*$/.test(value)) return false;
  const tokens = value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_-]+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => LABEL_VOCABULARY.has(token));
}

function testIdSet(raw: readonly string[]): PageFingerprint["testIds"] {
  const distinct = [...new Set(raw)];
  const safe = distinct.filter(safeTestId).sort(compareCodeUnits);
  const values = safe.slice(0, MAX_TEST_IDS);
  return { count: clampCount(raw.length), values, withheld: distinct.length - values.length };
}

function headingLabel(level: unknown, label: string) {
  const masked = maskLabel(label);
  return informative(masked) ? `${clampCount(level, 6)}:${masked}` : "";
}

function groupTallies(groups: Readonly<Record<string, GroupTally>>) {
  const out: Record<string, GroupTally> = {};
  for (const name of Object.keys(groups).filter((key) => GROUP_NAME.test(key)).sort(compareCodeUnits)) {
    const total = clampCount(groups[name]?.total, MAX_GROUP_SIZE);
    out[name] = { matched: Math.min(total, clampCount(groups[name]?.matched, MAX_GROUP_SIZE)), total };
  }
  return out;
}

function tallySignals(bodyText: string, groups: Readonly<Record<string, readonly RegExp[]>>) {
  const tallies: Record<string, GroupTally> = {};
  for (const [name, patterns] of Object.entries(groups)) {
    // Fresh non-global copies so a shared pattern's lastIndex never skews the tally.
    const matched = patterns.filter((pattern) => new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).test(bodyText)).length;
    tallies[name] = { matched, total: patterns.length };
  }
  return groupTallies(tallies);
}

function labelsHash(fp: Pick<PageFingerprint, "headings" | "buttons" | "links" | "testIds">) {
  const scrubbed = [fp.headings.labels, fp.buttons.labels, fp.links.labels, fp.testIds.values];
  return createHash("sha256").update(JSON.stringify(scrubbed)).digest("hex");
}

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}

/** Normalize a snapshot into the scrubbed fingerprint. Signal groups are tallied against the body text. */
export function fingerprint(
  snapshot: DomSnapshot,
  signalGroups: Readonly<Record<string, readonly RegExp[]>>,
): PageFingerprint {
  if (!PROVIDER_KEY.test(snapshot.provider)) throw new Error("fingerprint provider key is invalid");
  const trimmedLength = snapshot.bodyText.trim().length;
  const landmarks = Object.fromEntries(
    FINGERPRINT_LANDMARKS.map((role) => [role, clampCount(snapshot.landmarks[role], 50)]),
  ) as Record<FingerprintLandmark, number>;
  const scrubbed = {
    headings: labelSet(snapshot.headings.map(({ level, label }) => headingLabel(level, label)), snapshot.headings.length),
    buttons: labelSet(snapshot.buttons.map(maskLabel), snapshot.buttons.length),
    links: labelSet(snapshot.links.map(maskLabel), snapshot.links.length),
    testIds: testIdSet(snapshot.testIds),
  };
  return {
    schema: PAGE_FINGERPRINT_SCHEMA,
    provider: snapshot.provider,
    page: oneOf(FINGERPRINT_PAGES, snapshot.page, "upload"),
    source: oneOf(FINGERPRINT_SOURCES, snapshot.source, "session_probe"),
    routeClass: oneOf(FINGERPRINT_ROUTE_CLASSES, snapshot.routeClass, "invalid"),
    textLength: trimmedLength === 0 ? "empty" : trimmedLength < SHORT_TEXT_CHARS ? "short" : "normal",
    landmarks,
    ...scrubbed,
    labelsSha256: labelsHash(scrubbed),
    signalGroups: tallySignals(snapshot.bodyText, signalGroups),
    selectorGroups: groupTallies(snapshot.selectorGroups),
  };
}

const rawStrings = (value: unknown) =>
  (Array.isArray(value) ? value.slice(0, MAX_RAW_ITEMS) : []).map((item) => (typeof item === "string" ? item.slice(0, MAX_RAW_TEXT) : ""));

/** Coerce what a page evaluation returned into bounded snapshot fields. A page can return anything. */
export function coerceDomStructure(value: unknown): Pick<DomSnapshot, "landmarks" | "headings" | "buttons" | "links" | "testIds"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const landmarks = raw.landmarks && typeof raw.landmarks === "object" ? (raw.landmarks as Record<string, unknown>) : {};
  return {
    landmarks: Object.fromEntries(FINGERPRINT_LANDMARKS.map((role) => [role, clampCount(landmarks[role], 50)])),
    headings: (Array.isArray(raw.headings) ? raw.headings.slice(0, MAX_RAW_ITEMS) : []).map((heading) => ({
      level: clampCount((heading as { level?: unknown } | null)?.level, 6),
      label: rawStrings([(heading as { label?: unknown } | null)?.label])[0],
    })),
    buttons: rawStrings(raw.buttons),
    links: rawStrings(raw.links),
    testIds: rawStrings(raw.testIds),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** True when a logged label could only have come from `maskLabel`: vocabulary words and single masks. */
function isMaskedLabel(label: string) {
  const parts = label.split(" ");
  return (
    informative(label) &&
    parts.length <= MAX_LABEL_TOKENS &&
    parts.every((word, index) =>
      word === FINGERPRINT_MASK ? parts[index - 1] !== FINGERPRINT_MASK : LABEL_VOCABULARY.has(word))
  );
}

function parseLabelSet(value: unknown, heading: boolean): LabelSet | null {
  if (!isRecord(value) || !Array.isArray(value.labels)) return null;
  const valid = value.labels.every((label) =>
    typeof label === "string" && isMaskedLabel(heading ? (/^[0-6]:(.*)$/.exec(label)?.[1] ?? "") : label));
  if (!valid) return null;
  const set = labelSet(value.labels as string[], clampCount(value.count));
  return { ...set, omitted: clampCount(value.omitted) };
}

/**
 * Re-validate a fingerprint read back from a log line. Every label and test ID
 * is re-checked against the vocabulary rule and the hash is recomputed, so a
 * malformed or hand-edited line cannot carry page text into a drift result.
 * Returns null when anything fails.
 */
export function parsePageFingerprint(value: unknown): PageFingerprint | null {
  if (!isRecord(value) || value.schema !== PAGE_FINGERPRINT_SCHEMA || typeof value.provider !== "string") return null;
  if (!PROVIDER_KEY.test(value.provider)) return null;
  const headings = parseLabelSet(value.headings, true);
  const buttons = parseLabelSet(value.buttons, false);
  const links = parseLabelSet(value.links, false);
  const rawTestIds = isRecord(value.testIds) && Array.isArray(value.testIds.values) ? value.testIds.values : null;
  if (!headings || !buttons || !links || !rawTestIds || !isRecord(value.testIds)) return null;
  if (!rawTestIds.every((id) => typeof id === "string" && safeTestId(id))) return null;
  const testIds = {
    count: clampCount(value.testIds.count),
    values: [...new Set(rawTestIds as string[])].sort(compareCodeUnits).slice(0, MAX_TEST_IDS),
    withheld: clampCount(value.testIds.withheld),
  };
  if (
    !FINGERPRINT_PAGES.includes(value.page as FingerprintPage) ||
    !FINGERPRINT_SOURCES.includes(value.source as FingerprintSource) ||
    !FINGERPRINT_ROUTE_CLASSES.includes(value.routeClass as FingerprintRouteClass) ||
    !FINGERPRINT_TEXT_LENGTHS.includes(value.textLength as PageFingerprint["textLength"]) ||
    !isRecord(value.landmarks) || !isRecord(value.signalGroups) || !isRecord(value.selectorGroups)
  ) {
    return null;
  }
  const landmarks = value.landmarks;
  const scrubbed = { headings, buttons, links, testIds };
  const parsed: PageFingerprint = {
    schema: PAGE_FINGERPRINT_SCHEMA,
    provider: value.provider,
    page: value.page as FingerprintPage,
    source: value.source as FingerprintSource,
    routeClass: value.routeClass as FingerprintRouteClass,
    textLength: value.textLength as PageFingerprint["textLength"],
    landmarks: Object.fromEntries(FINGERPRINT_LANDMARKS.map((role) => [role, clampCount(landmarks[role], 50)])) as Record<FingerprintLandmark, number>,
    ...scrubbed,
    labelsSha256: labelsHash(scrubbed),
    signalGroups: groupTallies(value.signalGroups as Record<string, GroupTally>),
    selectorGroups: groupTallies(value.selectorGroups as Record<string, GroupTally>),
  };
  return parsed.labelsSha256 === value.labelsSha256 ? parsed : null;
}

export type FingerprintDiffClass = "none" | "cosmetic" | "label" | "selector" | "route";
export type GroupChange = { group: string; from: number | null; to: number | null };

export type FingerprintDiff = {
  class: FingerprintDiffClass;
  route: { from: FingerprintRouteClass; to: FingerprintRouteClass } | null;
  signalGroups: GroupChange[];
  selectorGroups: GroupChange[];
  labels: { added: string[]; removed: string[] };
  testIds: { added: string[]; removed: string[] };
  landmarks: Array<{ role: FingerprintLandmark; from: number; to: number }>;
};

function groupChanges(base: Record<string, GroupTally>, next: Record<string, GroupTally>): GroupChange[] {
  const names = [...new Set([...Object.keys(base), ...Object.keys(next)])].sort(compareCodeUnits);
  return names
    .map((group) => ({ group, from: base[group]?.matched ?? null, to: next[group]?.matched ?? null }))
    .filter(({ from, to }) => from !== to);
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
  const signalGroups = groupChanges(base.signalGroups, next.signalGroups);
  const selectorGroups = groupChanges(base.selectorGroups, next.selectorGroups);
  const labels = setChanges(allLabels(base), allLabels(next));
  const testIds = setChanges(base.testIds.values, next.testIds.values);
  const landmarks = FINGERPRINT_LANDMARKS
    .filter((role) => base.landmarks[role] !== next.landmarks[role])
    .map((role) => ({ role, from: base.landmarks[role], to: next.landmarks[role] }));
  const route = base.routeClass === next.routeClass ? null : { from: base.routeClass, to: next.routeClass };
  const cosmetic = landmarks.length > 0 || base.textLength !== next.textLength ||
    (["headings", "buttons", "links"] as const).some((kind) => base[kind].count !== next[kind].count);
  const kind: FingerprintDiffClass = route ? "route"
    : signalGroups.length + selectorGroups.length > 0 ? "selector"
    : base.labelsSha256 !== next.labelsSha256 ? "label"
    : cosmetic ? "cosmetic"
    : "none";
  return { class: kind, route, signalGroups, selectorGroups, labels, testIds, landmarks };
}
