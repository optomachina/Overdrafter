// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { PROVIDER_LOCATOR_PACKS } from "../generated/providerLocatorPacks.js";
import { PROVIDER_PORTAL_KERNEL_REVISION, type ProviderPortalDefinition } from "../adapters/providerPortalKernel.js";
import { buildQuickpartsProductionPortalDefinition, QUICKPARTS_PRODUCTION_LOCATORS } from "../adapters/quickpartsPortal.js";
import { buildWeergProductionPortalDefinition, WEERG_PRODUCTION_LOCATORS, WEERG_PRODUCTION_MATERIAL_OPTION } from "../adapters/weergPortal.js";
import { buildGeomiqProductionPortalDefinition, GEOMIQ_PRODUCTION_LOCATORS } from "../adapters/geomiqProductionPortal.js";
import { buildOshcutProductionPortalDefinition, OSHCUT_PRODUCTION_LOCATORS, OSHCUT_PRODUCTION_MATERIAL_LABEL, OSHCUT_PRICE_WAIT_MS } from "../adapters/oshcutProductionPortal.js";
import { applyLocatorPackEdits, malformedLocatorPackCases } from "../../test-support/locatorPackCases.js";
import { acceptLocatorPackCandidate, canonicalLocatorPackJson, hydrateOfferCardLocators, hydratePortalLocators, hydratePriceCellLocators, hydrateUsdOfferCardLocators, loadLocatorPack, LOCATOR_FLOW_OPS, LOCATOR_PACK_KERNEL_REVISION, locatorPackChangeSurfaces, locatorPackFlowStep, locatorPackLabel, locatorPackRevisionNumber, locatorPackSha256, minimumLocatorPackChangeClass, parseLocatorPack, resolveLocatorPack, type LocatorPack } from "./locatorPack.js";
const entry = (provider = "quickparts") => PROVIDER_LOCATOR_PACKS.find(e => e.provider === provider)!;
const pack = (provider = "quickparts") => structuredClone(entry(provider).pack) as LocatorPack;
const bundle = (p: LocatorPack) => [{ provider: p.provider, file: `provider-integrations/${p.provider}/locators.v${locatorPackRevisionNumber(p.revision)}.json`, pack: p, sha256: locatorPackSha256(p) }];

describe("locator pack validation", () => {
  it("pack_schema_rejects_unknown_op", () => {
    expect(parseLocatorPack(applyLocatorPackEdits(pack(), [{ path: "flow.2.op", value: "execute" }]))).toMatchObject({ ok: false, reason: "locator_pack_flow_op_unknown" });
  });
  it("kernel revision equals the kernel contract and vocabulary is closed", () => {
    expect(LOCATOR_PACK_KERNEL_REVISION).toBe(PROVIDER_PORTAL_KERNEL_REVISION);
    expect(LOCATOR_FLOW_OPS).toHaveLength(10);
  });
  it.each(malformedLocatorPackCases)("rejects $name", ({ provider, edits, reason }) => {
    expect(parseLocatorPack(applyLocatorPackEdits(pack(provider), edits))).toMatchObject({ ok: false, reason, path: expect.any(String) });
  });
  it("pack_envelope_revision_mismatch_rejected", () => {
    expect(resolveLocatorPack("quickparts", { envelopeRevision: "quickparts-quote-envelope.v2" })).toEqual({ ok: false, reason: "locator_pack_envelope_mismatch" });
  });
  it("forged_pack_sha256_mismatch_rejected", () => {
    const forged = structuredClone(entry());
    (forged.pack as LocatorPack).selectors.cadUpload = "#different";
    expect(resolveLocatorPack("quickparts", { bundle: [forged] })).toEqual({ ok: false, reason: "locator_pack_sha256_mismatch" });
  });
  it("stale_pack_revision_older_than_active_rejected", () => {
    expect(resolveLocatorPack("quickparts", { active: { revision: "quickparts-production-locators.v2", sha256: "a".repeat(64) } })).toEqual({ ok: false, reason: "locator_pack_revision_stale" });
  });
  it("equal-N sha or revision conflict rejected; identical and newer accepted", () => {
    const p = pack(), candidate = { pack: p, sha256: locatorPackSha256(p) };
    expect(acceptLocatorPackCandidate(candidate, { revision: p.revision, sha256: "a".repeat(64) })).toMatchObject({ ok: false, reason: "locator_pack_revision_conflict" });
    expect(acceptLocatorPackCandidate(candidate, { revision: `${p.revision}-other`, sha256: candidate.sha256 })).toMatchObject({ ok: false, reason: "locator_pack_revision_conflict" });
    expect(acceptLocatorPackCandidate(candidate, { revision: p.revision, sha256: candidate.sha256 }).ok).toBe(true);
    expect(acceptLocatorPackCandidate(candidate, { revision: "quickparts-production-locators.v0", sha256: "a".repeat(64) }).ok).toBe(true);
  });
  it("missing, duplicate, provider and file mismatches fail closed", () => {
    expect(resolveLocatorPack("missing")).toMatchObject({ ok: false, reason: "locator_pack_missing" });
    expect(resolveLocatorPack("quickparts", { bundle: [entry(), entry()] })).toMatchObject({ ok: false, reason: "locator_pack_duplicate" });
    expect(resolveLocatorPack("weerg", { bundle: [{ ...entry(), provider: "weerg" }] })).toMatchObject({ ok: false, reason: "locator_pack_provider_mismatch" });
    expect(resolveLocatorPack("quickparts", { bundle: [{ ...entry(), file: "provider-integrations/quickparts/locators.v2.json" }] })).toMatchObject({ ok: false, reason: "locator_pack_schema_invalid" });
  });
  it("fallback warns once per provider, missing is quiet, custom bundles bypass memoization", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(loadLocatorPack("absent", { bundle: [] })).toBeNull();
      expect(warn).not.toHaveBeenCalled();
      const bad = [{ ...entry(), sha256: "0".repeat(64) }];
      expect(loadLocatorPack("quickparts", { bundle: bad })).toBeNull();
      expect(loadLocatorPack("quickparts", { bundle: bad })).toBeNull();
      expect(warn).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ level: "warn", source: "locatorPack", provider: "quickparts", reason: "locator_pack_sha256_mismatch" }));
      expect(loadLocatorPack("quickparts", { bundle: [entry()] })).toEqual(pack());
      expect(loadLocatorPack("quickparts")).toBe(loadLocatorPack("quickparts"));
    } finally { warn.mockRestore(); }
  });
  it("memoized packs cannot be mutated after validation and flow lookups retain their types", () => {
    const p = loadLocatorPack("weerg")!;
    expect(() => { p.selectors.cadUpload = "#tampered"; }).toThrow(TypeError);
    expect(() => { p.allowedHosts.push("outside.example.com"); }).toThrow(TypeError);
    expect(loadLocatorPack("weerg")?.selectors.cadUpload).toBe(pack("weerg").selectors.cadUpload);
    const fill: string | undefined = locatorPackFlowStep(p, "fill")?.value;
    const select: string | undefined = locatorPackFlowStep(p, "select")?.value;
    expect(fill).toBe("$qty");
    expect(select).toBe("labels.material[aluminium-6082]");
  });
  it("canonical JSON sorts recursively by UTF-16, preserves arrays and hashes deterministically", () => {
    expect(canonicalLocatorPackJson({ z: [2, 1], a: { z: 2, a: 1 }, "10": 10, "2": 2 })).toBe('{"10":10,"2":2,"a":{"a":1,"z":2},"z":[2,1]}');
    expect(locatorPackSha256({ b: 2, a: 1 })).toBe(locatorPackSha256({ a: 1, b: 2 }));
    for (const value of ["quickparts-locators.v01", "quickparts-locators.v1000000", "bad"]) expect(locatorPackRevisionNumber(value)).toBeNull();
  });
  it("optional sections hydrate without inventing keys; dynamic labels and cleanup references validate", () => {
    const p = pack("weerg");
    p.selectors.drawingUpload = "#drawing";
    p.offHostAllowlist = ["static.example.com"];
    p.flow.splice(3, 0, { op: "upload", selector: "drawingUpload" });
    p.flow.push({ op: "readEcho", material: "material", quantity: "quantity" });
    p.flow.push({ op: "select", selector: "material", value: "labels.material[$material]" });
    p.fingerprint = { upload: { readySelector: "cadUpload" }, mask: ["quantity"] };
    p.cleanup = { mode: "delete", row: "quantity", rules: { ownRow: { selector: "quantity", scope: "material", uploadedRows: false } }, steps: [{ op: "click", selector: "quantity", scope: "$itemId" }], verify: "quantity" };
    expect(parseLocatorPack(p).ok).toBe(true);
    const hydrated = hydratePortalLocators(p);
    expect(hydrated.offHostAllowlist).toEqual(p.offHostAllowlist);
    expect(hydrated.selectors.drawingUpload).toBe("#drawing");
    expect(hydrated.selectors.cleanup).toEqual({ ownRow: { selector: p.selectors.quantity, scope: p.selectors.material, uploadedRows: false } });
    expect(hydrateUsdOfferCardLocators(p)).toBeNull();
    expect(hydratePriceCellLocators(p)).toBeNull();
    expect(hydrateOfferCardLocators(pack("oshcut"))).toBeNull();
    expect(locatorPackLabel(p, "missing", "x")).toBeNull();
    expect(resolveLocatorPack("weerg", { bundle: bundle(p) }).ok).toBe(true);
  });
});

describe("pack change surfaces", () => {
  const classify = (edits: Parameters<typeof applyLocatorPackEdits>[1], provider = "quickparts") => minimumLocatorPackChangeClass(locatorPackChangeSurfaces(pack(provider), applyLocatorPackEdits(pack(provider), edits) as LocatorPack));
  it("pack_offhost_change_requires_class_F", () => expect(classify([{ path: "offHostAllowlist", value: ["static.example.com"] }])).toBe("F"));
  it("selector-only changes are S and price cells are tagged", () => {
    expect(classify([{ path: "selectors.cadUpload", value: "#upload" }])).toBe("S");
    const next = pack("oshcut"); next.selectors.unitPrice = "#price";
    expect(locatorPackChangeSurfaces(pack("oshcut"), next)).toEqual([{ path: "selectors.unitPrice", surface: "priceCell", minimumClass: "S" }]);
  });
  it("labels are P; envelope is E", () => {
    expect(classify([{ path: "labels.material.aluminium-6082", value: "other" }], "weerg")).toBe("P");
    expect(classify([{ path: "envelopeRevision", value: "quickparts-quote-envelope.v2" }])).toBe("E");
  });
  it("signal removal/change is F and addition is S", () => {
    expect(classify([{ path: "terminalSignals.login", value: [] }])).toBe("F");
    expect(classify([{ path: "terminalSignals.login.0.pattern", value: "other" }])).toBe("F");
    expect(classify([{ path: "terminalSignals.login.1", value: { pattern: "expired", flags: "i" } }])).toBe("S");
  });
  it("signal reorder is F, while insertion preserving the old sequence is S", () => {
    const base = pack("oshcut"), next = structuredClone(base);
    next.terminalSignals.configurationRequired.reverse();
    expect(minimumLocatorPackChangeClass(locatorPackChangeSurfaces(base, next))).toBe("F");
    const added = structuredClone(base);
    added.terminalSignals.configurationRequired.splice(1, 0, { pattern: "choose settings", flags: "i" });
    expect(minimumLocatorPackChangeClass(locatorPackChangeSurfaces(base, added))).toBe("S");
  });
  it("revision and evidence are ignored; highest class wins", () => {
    expect(classify([{ path: "revision", value: "quickparts-production-locators.v2" }, { path: "evidence.note", value: "new note" }])).toBe("none");
    expect(classify([{ path: "selectors.cadUpload", value: "#upload" }, { path: "allowedHosts", value: ["other.example.com"] }, { path: "kernelRevision", value: "provider-portal-kernel.v2" }])).toBe("E");
  });
});

const providers = [
  ["quickparts", buildQuickpartsProductionPortalDefinition, QUICKPARTS_PRODUCTION_LOCATORS],
  ["weerg", buildWeergProductionPortalDefinition, WEERG_PRODUCTION_LOCATORS],
  ["geomiq", buildGeomiqProductionPortalDefinition, GEOMIQ_PRODUCTION_LOCATORS],
  ["oshcut", buildOshcutProductionPortalDefinition, OSHCUT_PRODUCTION_LOCATORS],
] as const;
describe.each(providers)("%s", (provider, build, locators) => {
  it("browser_tests_byte_identical_before_after", () => {
    const p = loadLocatorPack(provider);
    expect(p).not.toBeNull();
    if (!p) throw new Error("missing bundled pack");
    const seed = build({ locatorPack: null });
    const { quantityAwaitMs: _wait, ...selectors } = seed.selectors;
    expect(hydratePortalLocators(p)).toEqual({ routes: seed.routes, allowedHosts: seed.allowedHosts, selectors, terminalSignals: seed.terminalSignals });
    expect(provider === "oshcut" ? hydratePriceCellLocators(p) : hydrateOfferCardLocators(p)).toEqual(locators);
    if (provider === "quickparts") expect(hydrateUsdOfferCardLocators(p)).toEqual(locators);
    const withoutHooks = ({ hooks: _hooks, ...definition }: ProviderPortalDefinition) => definition;
    expect(withoutHooks(build({ locatorPack: p }))).toStrictEqual(withoutHooks(seed));
    expect(withoutHooks(build())).toStrictEqual(withoutHooks(seed));
    if (provider === "weerg") expect(locatorPackLabel(p, "material", "aluminium-6082")).toBe(WEERG_PRODUCTION_MATERIAL_OPTION);
    if (provider === "oshcut") {
      expect(locatorPackLabel(p, "material", "aluminum-6061-t6")).toBe(OSHCUT_PRODUCTION_MATERIAL_LABEL);
      expect(locatorPackFlowStep(p, "waitPrice")?.timeoutMs).toBe(OSHCUT_PRICE_WAIT_MS);
    }
  });
  it("classification hooks preserve seed outcomes offline", async () => {
    const current = build(), seed = build({ locatorPack: null });
    for (const url of [seed.routes.uploadUrl, "https://outside.example.com/"]) for (const bodyText of ["", "captcha login", "session expired", "Sign In", "Select material", "maintenance", "engineering review"]) {
      const snapshot = { url, bodyText };
      expect(await current.hooks.classifyPortalState(snapshot)).toBe(await seed.hooks.classifyPortalState(snapshot));
    }
  });
});
