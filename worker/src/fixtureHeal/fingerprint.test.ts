import { describe, expect, it } from "vitest";
import { XOMETRY_AUTH_PROBE_FINGERPRINT_VOCABULARY as VOCABULARY } from "../xometryAuthProbe.js";
import {
  coerceDomStructure,
  defineFingerprintVocabulary,
  diff,
  FINGERPRINT_LANDMARKS,
  FINGERPRINT_PAGES,
  FINGERPRINT_ROUTE_CLASSES,
  FINGERPRINT_SOURCES,
  FINGERPRINT_TEXT_LENGTHS,
  fingerprint,
  normalizeLabel,
  PAGE_FINGERPRINT_SCHEMA,
  parsePageFingerprint,
  type DomSnapshot,
  type PageFingerprint,
  type SelectorMeasure,
} from "./fingerprint.js";

/** Synthetic private values a real account page could show. None may reach a fingerprint. */
const PRIVATE_VALUES = [
  "blaine.wilson@example.com", "j.doe+quotes@acme-fab.co", "an.to@gmail.com", "Q24-1234-5678", "Q26-0099-4410",
  "Jordan Okafor", "Priya Natarajan", "Søren Kierkegaard", "Zhang Wei", "Blaine", "Hana",
  "(555) 867-5309", "$252.97", "1093-05589_bracket_revB.step", "4c1f0d2e-9b7a-4e1c-8f3a-2d6b5e7a9c10",
  "1600 Amphitheatre Pkwy", "Acme Fabrication LLC", "PO-778812", "Order #44821",
];
/** Names made only of ordinary words, which a word-level filter would let through. */
const WORD_NAMES = ["An To", "Go An", "To An", "No Go", "Pick Lead", "More Center", "Ok Yes"];
const LEAKED_NAMES = ["blaine", "hana", "jordan", "okafor", "priya", "natarajan", "søren", "zhang", "acme", "kierkegaard", "an to", "go an", "to an", "no go", "pick lead", "more center", "ok yes"];

const PHRASES = [...VOCABULARY.labels];
const TEST_IDS = [...VOCABULARY.testIds];

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function measures(random: () => number): DomSnapshot["selectorGroups"] {
  return Object.fromEntries(Object.entries(VOCABULARY.selectorGroups).map(([group, selectors]) => [
    group,
    selectors.map((): SelectorMeasure => ({ count: Math.floor(random() * 3), visible: random() < 0.5 })),
  ]));
}

function syntheticPage(seed: number): DomSnapshot {
  const random = rng(seed);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const label = () => {
    const roll = random();
    if (roll < 0.3) return pick(PHRASES);
    if (roll < 0.5) return pick(WORD_NAMES);
    if (roll < 0.7) return `${pick(PHRASES)}${pick([", ", " ", ": ", " - "])}${pick([...WORD_NAMES, ...PRIVATE_VALUES])}`;
    return pick(PRIVATE_VALUES);
  };
  const many = (n: number) => Array.from({ length: Math.floor(random() * n) }, label);
  return {
    provider: "xometry",
    page: "upload",
    source: "session_probe",
    routeClass: pick(FINGERPRINT_ROUTE_CLASSES),
    bodyText: many(40).join("\n"),
    landmarks: { main: 1, navigation: Math.floor(random() * 4), dialog: random() < 0.2 ? 1 : 0 },
    headings: many(30),
    buttons: many(60),
    links: many(60),
    testIds: [
      ...many(10).map((value) => value.replace(/\s+/g, "-")),
      `account-${pick(WORD_NAMES).replace(" ", "-")}`,
      `quote-row-${pick(PRIVATE_VALUES)}`,
      pick(TEST_IDS),
    ],
    selectorGroups: measures(random),
  };
}

function stringLeaves(value: unknown, keys: string[] = [], out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringLeaves(item, keys, out));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      keys.push(key);
      stringLeaves(item, keys, out);
    }
  }
  return out;
}

const ENUM_VALUES = new Set<string>([
  PAGE_FINGERPRINT_SCHEMA, "xometry", ...FINGERPRINT_PAGES, ...FINGERPRINT_SOURCES,
  ...FINGERPRINT_ROUTE_CLASSES, ...FINGERPRINT_TEXT_LENGTHS,
]);
const ALLOWED_KEYS = new Set<string>([
  "schema", "vocabularyDigest", "provider", "page", "source", "routeClass", "textLength", "landmarks", "headings", "buttons",
  "links", "testIds", "labelsSha256", "signalGroups", "selectorGroups", "count", "labels", "values",
  "withheld", "matched", "total", "selectors", "visible", ...FINGERPRINT_LANDMARKS,
  ...Object.keys(VOCABULARY.signalGroups), ...Object.keys(VOCABULARY.selectorGroups),
]);

function expectScrubbed(fp: PageFingerprint) {
  const keys: string[] = [];
  const leaves = stringLeaves(fp, keys);
  expect(keys.filter((key) => !ALLOWED_KEYS.has(key))).toEqual([]);
  for (const leaf of leaves) {
    if (ENUM_VALUES.has(leaf) || leaf === fp.labelsSha256 || leaf === VOCABULARY.digest) continue;
    expect(VOCABULARY.labels.has(leaf) || VOCABULARY.testIds.has(leaf), leaf).toBe(true);
  }
  const serialized = JSON.stringify(fp).toLowerCase();
  for (const value of PRIVATE_VALUES) expect(serialized).not.toContain(value.toLowerCase());
  for (const name of LEAKED_NAMES) expect(leaves).not.toContain(name);
}

describe("fixture page fingerprint", () => {
  it("hashes reviewed vocabulary canonically, retaining selector order and regex semantics", () => {
    const reversed = <T,>(groups: Record<string, T>) => Object.fromEntries(Object.entries(groups).reverse());
    const reordered = defineFingerprintVocabulary({
      ...VOCABULARY,
      signalGroups: reversed(VOCABULARY.signalGroups),
      selectorGroups: reversed(VOCABULARY.selectorGroups),
      labels: new Set([...VOCABULARY.labels].reverse()),
      testIds: new Set([...VOCABULARY.testIds].reverse()),
    });
    expect(VOCABULARY.digest).toMatch(/^[a-f0-9]{16}$/);
    expect(reordered.digest).toBe(VOCABULARY.digest);
    for (const change of [
      { selectorGroups: { ...VOCABULARY.selectorGroups, startNewQuoteButtons: [...VOCABULARY.selectorGroups.startNewQuoteButtons].reverse() } },
      { signalGroups: { ...VOCABULARY.signalGroups, dashboardSignals: [/changed/i] } },
      { signalGroups: { ...VOCABULARY.signalGroups, dashboardSignals: VOCABULARY.signalGroups.dashboardSignals.map((pattern) => new RegExp(pattern.source)) } },
      { testIds: new Set([...VOCABULARY.testIds, "new-reviewed-id"]) },
    ]) expect(defineFingerprintVocabulary({ ...VOCABULARY, ...change }).digest).not.toBe(VOCABULARY.digest);
  });

  it("keeps a label or test ID only when the whole value is reviewed", () => {
    const fp = fingerprint(
      {
        ...syntheticPage(1),
        headings: ["Account: An To", "Go An", "Welcome back, An To", "My Account", "Pick Lead", "an.to@gmail.com"],
        buttons: ["Upload a CAD File", "Upload a CAD File for Jordan", "Ok Yes"],
        links: ["Part Library", "More Center"],
        testIds: ["account-An-To", "user-menu-Go-An", "DashboardGetInstantQuotePrimary-dashboard-get-instant-quote-primary"],
      },
      VOCABULARY,
    );
    expect(fp.headings).toEqual({ count: 6, labels: ["my account"] });
    expect(fp.buttons).toEqual({ count: 3, labels: ["upload a cad file"] });
    expect(fp.links).toEqual({ count: 2, labels: ["part library"] });
    expect(fp.testIds).toEqual({ count: 3, values: ["DashboardGetInstantQuotePrimary-dashboard-get-instant-quote-primary"], withheld: 2 });
    expect(normalizeLabel("  Upload a\nCAD File ")).toBe("upload a cad file");
  });

  it("keeps the vocabulary to reviewed chrome: no digits, no name-shaped phrases", () => {
    for (const label of VOCABULARY.labels) {
      expect(label).toBe(normalizeLabel(label));
      expect(label === "upload 3d files" || !/\d/.test(label), label).toBe(true);
    }
    for (const name of LEAKED_NAMES) expect(VOCABULARY.labels.has(name)).toBe(false);
    for (const id of VOCABULARY.testIds) expect(id).toMatch(/^[A-Za-z][A-Za-z-]*$/);
  });

  it("fuzz: names, emails and quote numbers, alone or next to reviewed phrases, never reach the output", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const fp = fingerprint(syntheticPage(seed), VOCABULARY);
      expectScrubbed(fp);
      expect(parsePageFingerprint(JSON.parse(JSON.stringify(fp)), VOCABULARY)).toEqual(fp);
    }
  });

  it("stays bounded when a page shows every reviewed label and test ID", () => {
    const random = rng(9);
    const fp = fingerprint(
      {
        ...syntheticPage(9),
        headings: [...PHRASES, ...PHRASES], buttons: PHRASES, links: PHRASES,
        testIds: [...TEST_IDS, ...Array.from({ length: 290 }, (_, index) => `x-${index}`)],
        selectorGroups: Object.fromEntries(Object.entries(VOCABULARY.selectorGroups).map(([group, selectors]) => [
          group, selectors.map(() => ({ count: 1e6, visible: random() < 2 })),
        ])),
      },
      VOCABULARY,
    );
    expect(fp.headings.labels).toHaveLength(PHRASES.length);
    expect(JSON.stringify(fp).length).toBeLessThanOrEqual(16_384);
    expect(Object.values(fp.selectorGroups).flatMap(({ selectors }) => selectors).every(({ count }) => count === 20)).toBe(true);
  });

  it("rejects a logged fingerprint carrying anything outside the vocabulary", () => {
    const fp = fingerprint(syntheticPage(11), VOCABULARY);
    const edits: Array<(copy: PageFingerprint & Record<string, unknown>) => void> = [
      (copy) => { copy.buttons.labels = [...copy.buttons.labels, "an to"].sort(); },
      (copy) => { copy.testIds.values = ["account-An-To"]; },
      (copy) => { copy.labelsSha256 = "0".repeat(64); },
      (copy) => { copy.routeClass = "https://www.xometry.com/quoting/home/" as never; },
      (copy) => { copy.signalGroups.JordanOkaforQ24x1234x5678 = { matched: 1, total: 1 }; },
      (copy) => { (copy.selectorGroups as Record<string, unknown>).privateNoteCustomerAcmeCorp = { matched: 0, total: 1, selectors: [] }; },
      (copy) => { copy.signalGroups.dashboardSignals = { matched: 1, total: 99 }; },
      (copy) => { copy.selectorGroups.uploadTriggers.selectors = copy.selectorGroups.uploadTriggers.selectors.slice(1); },
      (copy) => {
        for (let index = 0; index < 20_000; index += 1) copy.signalGroups[`leak${index}PrivateNoteText`] = { matched: 0, total: 1 };
      },
    ];
    for (const edit of edits) {
      const copy = structuredClone(fp) as PageFingerprint & Record<string, unknown>;
      edit(copy);
      expect(parsePageFingerprint(copy, VOCABULARY)).toBeNull();
    }
  });

  it("accepts a consistent tally as written, at its bounds, without clamping or recomputing", () => {
    const valid = structuredClone(fingerprint(syntheticPage(11), VOCABULARY));
    const [signal] = Object.keys(valid.signalGroups);
    const [group] = Object.keys(valid.selectorGroups);
    valid.signalGroups[signal].matched = valid.signalGroups[signal].total;
    valid.selectorGroups[group].selectors = valid.selectorGroups[group].selectors.map((_, index) =>
      (index === 0 ? { count: 20, visible: true } : { count: 0, visible: false }));
    valid.selectorGroups[group].matched = 1;
    expect(parsePageFingerprint(valid, VOCABULARY)).toEqual(valid);
    expect(parsePageFingerprint(valid, VOCABULARY, "baseline")).toEqual(valid);
    // One step past each bound is malformed (the full repro list is in driftResult.test.ts).
    const pastBounds: Array<(copy: PageFingerprint) => void> = [
      (copy) => { copy.signalGroups[signal].matched = copy.signalGroups[signal].total + 1; },
      (copy) => { copy.selectorGroups[group].selectors[0].count = 21; },
      (copy) => { copy.selectorGroups[group].selectors[0].count = -1; },
    ];
    for (const edit of pastBounds) {
      const copy = structuredClone(valid);
      edit(copy);
      expect(parsePageFingerprint(copy, VOCABULARY)).toBeNull();
    }
  });

  it("tallies signal groups and records each selector's count and visibility", () => {
    const fp = fingerprint(
      {
        ...syntheticPage(3),
        bodyText: "My Account · Orders · Welcome back, Jordan",
        selectorGroups: {
          dashboardUploadButtons: [{ count: 0, visible: true }],
          startNewQuoteButtons: [{ count: 2, visible: false }, { count: 1, visible: true }],
          notAVocabularyGroup: [{ count: 1, visible: true }],
        },
      },
      VOCABULARY,
    );
    expect(fp.signalGroups.accountQuoteListSignals).toEqual({ matched: 1, total: 2 });
    expect(fp.signalGroups.dashboardSignals).toEqual({ matched: 1, total: 3 });
    expect(fp.selectorGroups).toEqual({
      dashboardUploadButtons: { matched: 0, total: 1, selectors: [{ count: 0, visible: false }] },
      startNewQuoteButtons: {
        matched: 2,
        total: 4,
        selectors: [{ count: 2, visible: false }, { count: 1, visible: true }, { count: 0, visible: false }, { count: 0, visible: false }],
      },
    });
    expect(JSON.stringify(fp)).not.toMatch(/jordan/i);
  });

  it("bounds whatever a page evaluation returns", () => {
    expect(coerceDomStructure(true)).toBeNull();
    expect(coerceDomStructure(["array"])).toBeNull();
    const coerced = coerceDomStructure({
      landmarks: { main: 1e9, dialog: -3, bogus: 5 },
      headings: ["x".repeat(10_000), null],
      buttons: Array.from({ length: 5_000 }, () => "Edit"),
      links: [42, { toString: () => "blaine" }],
      testIds: "not-an-array",
    });
    expect(coerced?.landmarks.main).toBe(50);
    expect(coerced?.landmarks.dialog).toBe(0);
    expect(coerced?.landmarks).not.toHaveProperty("bogus");
    expect(coerced?.headings).toEqual(["x".repeat(400), ""]);
    expect(coerced?.buttons).toHaveLength(300);
    expect(coerced?.links).toEqual(["", ""]);
    expect(coerced?.testIds).toEqual([]);
  });
});

describe("fixture page fingerprint diff", () => {
  const baseSnapshot: DomSnapshot = {
    provider: "xometry", page: "upload", source: "session_probe", routeClass: "quote_home",
    bodyText: "Welcome back. Recent quotes. My Account. Part Library. ".repeat(5),
    landmarks: { main: 1, navigation: 1 },
    headings: ["Recent quotes"], buttons: ["Upload a CAD File"], links: ["My Account", "Part Library"],
    testIds: ["DashboardGetInstantQuotePrimary-dashboard-get-instant-quote-primary"],
    selectorGroups: { dashboardUploadButtons: [{ count: 1, visible: true }] },
  };
  const base = fingerprint(baseSnapshot, VOCABULARY);
  const variant = (overrides: Partial<DomSnapshot>) => fingerprint({ ...baseSnapshot, ...overrides }, VOCABULARY);

  it("reports none for an identical page", () => {
    expect(diff(base, base)).toMatchObject({ class: "none", route: null, signalGroups: [], selectors: [], labels: { added: [], removed: [] } });
  });

  it("ranks combined changes route, then selector, then label, then cosmetic", () => {
    const cosmetic = { landmarks: { main: 1, navigation: 1, dialog: 1 } };
    const label = { ...cosmetic, headings: ["Your quotes"] };
    const selector = { ...label, selectorGroups: { dashboardUploadButtons: [{ count: 0, visible: false }] } };
    const route = { ...selector, routeClass: "provider_other" as const };
    // Each case adds one more severe change; a reordered check returns the least severe class instead.
    expect(diff(base, variant(route)).class).toBe("route");
    expect(diff(base, variant(selector)).class).toBe("selector");
    expect(diff(base, variant(label)).class).toBe("label");
    expect(diff(base, variant(cosmetic)).class).toBe("cosmetic");
    expect(diff(base, variant(route))).toMatchObject({
      route: { from: "quote_home", to: "provider_other" },
      selectors: [{ group: "dashboardUploadButtons", index: 0, from: { count: 1, visible: true }, to: { count: 0, visible: false } }],
      labels: { added: ["heading:your quotes"], removed: ["heading:recent quotes"] },
      landmarks: [{ role: "dialog", from: 0, to: 1 }],
    });
  });

  it("treats a duplicated or hidden selector match as selector drift", () => {
    const duplicated = variant({ selectorGroups: { dashboardUploadButtons: [{ count: 2, visible: true }] } });
    const hidden = variant({ selectorGroups: { dashboardUploadButtons: [{ count: 1, visible: false }] } });
    expect(diff(base, duplicated)).toMatchObject({ class: "selector", selectors: [{ index: 0, from: { count: 1 }, to: { count: 2 } }] });
    expect(diff(base, hidden)).toMatchObject({ class: "selector", selectors: [{ index: 0, from: { visible: true }, to: { visible: false } }] });
  });

  it("notices a change to any reviewed label, however many the page shows", () => {
    const crowded = variant({ links: PHRASES });
    const changed = variant({ links: PHRASES.filter((phrase) => phrase !== PHRASES.at(-1)) });
    expect(crowded.links.labels).toHaveLength(PHRASES.length);
    expect(diff(crowded, changed)).toMatchObject({ class: "label", labels: { removed: [`link:${PHRASES.at(-1)}`] } });
  });
});
