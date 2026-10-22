import { describe, expect, it } from "vitest";
import {
  diff,
  FINGERPRINT_LANDMARKS,
  FINGERPRINT_MASK,
  FINGERPRINT_PAGES,
  FINGERPRINT_ROUTE_CLASSES,
  FINGERPRINT_SOURCES,
  FINGERPRINT_TEXT_LENGTHS,
  fingerprint,
  LABEL_VOCABULARY,
  maskLabel,
  PAGE_FINGERPRINT_SCHEMA,
  parsePageFingerprint,
  safeTestId,
  coerceDomStructure,
  type DomSnapshot,
  type PageFingerprint,
} from "./fingerprint.js";

const SIGNAL_GROUPS = {
  dashboardSignals: [/welcome back/i, /recent quotes/i, /pick up where you left off/i],
  accountQuoteListSignals: [/\bmy account\b/i, /\bpart library\b/i],
};

/** Synthetic private values a real account page could show. None may reach a fingerprint. */
const PRIVATE_VALUES = [
  "blaine.wilson@example.com", "j.doe+quotes@acme-fab.co", "Q24-1234-5678", "Q26-0099-4410",
  "Jordan Okafor", "Priya Natarajan", "Søren Kierkegaard", "Zhang Wei", "Blaine", "Hana",
  "(555) 867-5309", "$252.97", "1093-05589_bracket_revB.step", "4c1f0d2e-9b7a-4e1c-8f3a-2d6b5e7a9c10",
  "1600 Amphitheatre Pkwy", "Acme Fabrication LLC", "PO-778812", "Order #44821",
];
const NAMES = ["blaine", "hana", "jordan", "okafor", "priya", "natarajan", "søren", "zhang", "wei", "acme", "kierkegaard"];

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const VOCAB = [...LABEL_VOCABULARY];

function syntheticPage(seed: number): DomSnapshot {
  const random = rng(seed);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)];
  const phrase = () =>
    Array.from({ length: 1 + Math.floor(random() * 6) }, () => (random() < 0.4 ? pick(PRIVATE_VALUES) : pick(VOCAB))).join(
      pick([" ", ", ", " - ", ": ", "\n"]),
    );
  const many = (n: number) => Array.from({ length: Math.floor(random() * n) }, phrase);
  return {
    provider: "xometry",
    page: "upload",
    source: "session_probe",
    routeClass: pick(FINGERPRINT_ROUTE_CLASSES),
    bodyText: many(40).join("\n"),
    landmarks: { main: 1, navigation: Math.floor(random() * 4), dialog: random() < 0.2 ? 1 : 0 },
    headings: many(30).map((label) => ({ level: 1 + Math.floor(random() * 6), label })),
    buttons: many(60),
    links: many(60),
    testIds: [
      ...many(20).map((value) => value.replace(/\s+/g, "-")),
      `quote-row-${pick(PRIVATE_VALUES)}`,
      "DashboardGetInstantQuotePrimary-dashboard-get-instant-quote-primary",
    ],
    selectorGroups: { dashboardUploadButtons: { matched: Math.floor(random() * 2), total: 1 } },
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
  "schema", "provider", "page", "source", "routeClass", "textLength", "landmarks", "headings", "buttons",
  "links", "testIds", "labelsSha256", "signalGroups", "selectorGroups", "count", "labels", "omitted",
  "values", "withheld", "matched", "total", ...FINGERPRINT_LANDMARKS, ...Object.keys(SIGNAL_GROUPS),
  "dashboardUploadButtons",
]);

function expectScrubbed(fp: PageFingerprint) {
  const keys: string[] = [];
  const leaves = stringLeaves(fp, keys);
  expect(keys.filter((key) => !ALLOWED_KEYS.has(key))).toEqual([]);
  for (const leaf of leaves) {
    if (ENUM_VALUES.has(leaf) || leaf === fp.labelsSha256) continue;
    expect(leaf).not.toMatch(/@|\$|\d{2,}/);
    if (safeTestId(leaf)) continue;
    const label = leaf.replace(/^[0-6]:/, "");
    for (const word of label.split(" ")) {
      expect(word === FINGERPRINT_MASK || LABEL_VOCABULARY.has(word), `${word} in ${leaf}`).toBe(true);
    }
  }
  const serialized = JSON.stringify(fp).toLowerCase();
  for (const value of PRIVATE_VALUES) expect(serialized).not.toContain(value.toLowerCase());
  for (const name of NAMES) expect(serialized).not.toMatch(new RegExp(`(^|[^a-z])${name}([^a-z]|$)`));
}

describe("fixture page fingerprint", () => {
  it("masks every word outside the UI vocabulary and collapses masked runs", () => {
    expect(maskLabel("Welcome back, Blaine Wilson")).toBe("welcome back *");
    expect(maskLabel("Q24-1234-5678 · 1093-05589_bracket")).toBe("*");
    expect(maskLabel("Upload a CAD File")).toBe("upload a cad file");
    expect(maskLabel("MyAccount")).toBe("my account");
    expect(maskLabel("Søren's recent quotes")).toBe("* recent quotes");
    expect(maskLabel("view quote edit share delete export csv download")).toBe("view quote edit share delete *");
  });

  it("keeps a test ID only when it is letters and every word is vocabulary", () => {
    expect(safeTestId("DashboardGetInstantQuotePrimary-dashboard-get-instant-quote-primary")).toBe(true);
    expect(safeTestId("UploadView-instant-quote-continue")).toBe(true);
    expect(safeTestId("quote-row-Q24-1234")).toBe(false);
    expect(safeTestId("user-menu-blaine")).toBe(false);
    expect(safeTestId("part-card-bracket")).toBe(false);
  });

  it("keeps the vocabulary free of digits and of personal names used in the fuzz corpus", () => {
    for (const word of LABEL_VOCABULARY) expect(word === "3d" || !/\d/.test(word)).toBe(true);
    for (const name of [...NAMES, "price", "page", "grant", "mark", "will", "bill", "rose", "hunter"]) {
      expect(LABEL_VOCABULARY.has(name)).toBe(false);
    }
  });

  it("fuzz: synthetic pages with emails, quote numbers and names yield no text or identifiers", () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      const fp = fingerprint(syntheticPage(seed), SIGNAL_GROUPS);
      expectScrubbed(fp);
      expect(JSON.stringify(fp).length).toBeLessThanOrEqual(16_384);
    }
  });

  it("is deterministic and survives a log round trip through re-validation", () => {
    const page = syntheticPage(7);
    const fp = fingerprint(page, SIGNAL_GROUPS);
    expect(fingerprint(page, SIGNAL_GROUPS)).toEqual(fp);
    expect(parsePageFingerprint(JSON.parse(JSON.stringify(fp)))).toEqual(fp);
  });

  it("rejects a logged fingerprint whose labels or hash were edited", () => {
    const fp = fingerprint(syntheticPage(11), SIGNAL_GROUPS);
    const withName = structuredClone(fp);
    withName.buttons.labels = [...withName.buttons.labels, "blaine wilson"].sort();
    expect(parsePageFingerprint(withName)).toBeNull();
    const withHash = { ...structuredClone(fp), labelsSha256: "0".repeat(64) };
    expect(parsePageFingerprint(withHash)).toBeNull();
    const withTestId = structuredClone(fp);
    withTestId.testIds.values = ["quote-row-Q24-1234"];
    expect(parsePageFingerprint(withTestId)).toBeNull();
    expect(parsePageFingerprint({ ...structuredClone(fp), routeClass: "https://www.xometry.com/quoting/home/" })).toBeNull();
  });

  it("tallies signal and selector groups without copying the body text", () => {
    const fp = fingerprint(
      { ...syntheticPage(3), bodyText: "My Account · Orders · Welcome back, Jordan", selectorGroups: { dashboardUploadButtons: { matched: 0, total: 1 } } },
      SIGNAL_GROUPS,
    );
    expect(fp.signalGroups).toEqual({
      accountQuoteListSignals: { matched: 1, total: 2 },
      dashboardSignals: { matched: 1, total: 3 },
    });
    expect(fp.selectorGroups).toEqual({ dashboardUploadButtons: { matched: 0, total: 1 } });
    expect(JSON.stringify(fp)).not.toMatch(/jordan/i);
  });

  it("bounds whatever a page evaluation returns", () => {
    expect(coerceDomStructure(true)).toBeNull();
    expect(coerceDomStructure(["array"])).toBeNull();
    const coerced = coerceDomStructure({
      landmarks: { main: 1e9, dialog: -3, bogus: 5 },
      headings: [{ level: 99, label: "x".repeat(10_000) }, null],
      buttons: Array.from({ length: 5_000 }, () => "Edit"),
      links: [42, { toString: () => "blaine" }],
      testIds: "not-an-array",
    });
    expect(coerced?.landmarks.main).toBe(50);
    expect(coerced?.landmarks.dialog).toBe(0);
    expect(coerced?.landmarks).not.toHaveProperty("bogus");
    expect(coerced?.headings[0]).toEqual({ level: 6, label: "x".repeat(400) });
    expect(coerced?.buttons).toHaveLength(300);
    expect(coerced?.links).toEqual(["", ""]);
    expect(coerced?.testIds).toEqual([]);
  });
});

describe("fixture page fingerprint diff", () => {
  const base = fingerprint(
    {
      provider: "xometry", page: "upload", source: "session_probe", routeClass: "quote_home",
      bodyText: "Welcome back. Recent quotes. My Account. Part Library.",
      landmarks: { main: 1, navigation: 1 },
      headings: [{ level: 2, label: "Recent quotes" }],
      buttons: ["Upload a CAD File"], links: ["My Account", "Part Library"], testIds: [],
      selectorGroups: { dashboardUploadButtons: { matched: 1, total: 1 } },
    },
    SIGNAL_GROUPS,
  );

  it("reports none for an identical page", () => {
    expect(diff(base, base)).toMatchObject({ class: "none", route: null, signalGroups: [], labels: { added: [], removed: [] } });
  });

  it("orders classes route, selector, label, cosmetic", () => {
    expect(diff(base, { ...base, routeClass: "provider_other" }).class).toBe("route");
    const lost = { ...base, signalGroups: { ...base.signalGroups, dashboardSignals: { matched: 0, total: 3 } } };
    expect(diff(base, lost)).toMatchObject({ class: "selector", signalGroups: [{ group: "dashboardSignals", from: 2, to: 0 }] });
    const relabeled = fingerprint(
      { provider: "xometry", page: "upload", source: "session_probe", routeClass: "quote_home",
        bodyText: "Welcome back. Recent quotes. My Account. Part Library.", landmarks: { main: 1, navigation: 1 },
        headings: [{ level: 2, label: "Your recent quotes" }], buttons: ["Upload a CAD File"],
        links: ["My Account", "Part Library"], testIds: [], selectorGroups: { dashboardUploadButtons: { matched: 1, total: 1 } } },
      SIGNAL_GROUPS,
    );
    expect(diff(base, relabeled)).toMatchObject({
      class: "label",
      labels: { added: ["heading:2:your recent quotes"], removed: ["heading:2:recent quotes"] },
    });
    expect(diff(base, { ...base, landmarks: { ...base.landmarks, dialog: 1 } })).toMatchObject({
      class: "cosmetic",
      landmarks: [{ role: "dialog", from: 0, to: 1 }],
    });
  });
});
