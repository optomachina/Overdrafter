/**
 * OVD-814 (OVD-796 slice 3): validated locator data inside Fixture. Code tables
 * remain the seed/fallback (D7). No portal I/O or flow interpreter: hooks stay
 * TypeScript. Bundle rejection is observable once per provider per process.
 */
import type { ProviderPortalDefinition } from "../adapters/providerPortalKernel.js";
import type { UsdOfferCardLocators } from "../adapters/usdOfferCards.js";
import { PROVIDER_LOCATOR_PACKS } from "../generated/providerLocatorPacks.js";
import { canonicalLocatorPackJson, locatorPackRevisionNumber, locatorPackSha256, parseLocatorPack, type LocatorFlowStep, type LocatorPack, type LocatorPackRejection } from "./locatorPackValidation.js";
export * from "./locatorPackValidation.js";

export type BundledLocatorPack = { readonly provider: string; readonly file: string; readonly sha256: string; readonly pack: unknown };
type ActivePack = { revision: string; sha256: string };
type Resolution = { ok: true; pack: LocatorPack } | { ok: false; reason: LocatorPackRejection };
type LoadOptions = { envelopeRevision?: string; bundle?: readonly BundledLocatorPack[]; active?: ActivePack | null };
export function acceptLocatorPackCandidate(candidate: { pack: LocatorPack; sha256: string }, active: ActivePack | null): Resolution {
  const n = locatorPackRevisionNumber(candidate.pack.revision);
  if (n === null) return { ok: false, reason: "locator_pack_schema_invalid" };
  if (active) {
    const previous = locatorPackRevisionNumber(active.revision);
    if (previous === null) return { ok: false, reason: "locator_pack_schema_invalid" };
    if (n < previous) return { ok: false, reason: "locator_pack_revision_stale" };
    if (n === previous && (candidate.sha256 !== active.sha256 || candidate.pack.revision !== active.revision)) return { ok: false, reason: "locator_pack_revision_conflict" };
  }
  return { ok: true, pack: candidate.pack };
}
export function resolveLocatorPack(provider: string, options: LoadOptions = {}): Resolution {
  const entries = (options.bundle ?? PROVIDER_LOCATOR_PACKS).filter(e => e.provider === provider);
  if (!entries.length) return { ok: false, reason: "locator_pack_missing" };
  if (entries.length !== 1) return { ok: false, reason: "locator_pack_duplicate" };
  const entry = entries[0];
  try {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || locatorPackSha256(entry.pack) !== entry.sha256) return { ok: false, reason: "locator_pack_sha256_mismatch" };
  } catch { return { ok: false, reason: "locator_pack_schema_invalid" }; }
  const parsed = parseLocatorPack(entry.pack);
  if (!parsed.ok) return parsed;
  if (parsed.pack.provider !== provider) return { ok: false, reason: "locator_pack_provider_mismatch" };
  const file = /^provider-integrations\/([a-z][a-z0-9]*)\/locators\.v(0|[1-9]\d{0,5})\.json$/.exec(entry.file);
  if (!file || file[1] !== provider || Number(file[2]) !== locatorPackRevisionNumber(parsed.pack.revision)) return { ok: false, reason: "locator_pack_schema_invalid" };
  if (options.envelopeRevision !== undefined && parsed.pack.envelopeRevision !== options.envelopeRevision) return { ok: false, reason: "locator_pack_envelope_mismatch" };
  return acceptLocatorPackCandidate({ pack: parsed.pack, sha256: entry.sha256 }, options.active ?? null);
}
function freezePack<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezePack(child);
    Object.freeze(value);
  }
  return value;
}
const memo = new Map<string, LocatorPack | null>();
const warned = new Set<string>();
export function loadLocatorPack(provider: string, options: LoadOptions = {}): LocatorPack | null {
  const key = JSON.stringify([provider, options.envelopeRevision, options.active?.revision, options.active?.sha256]);
  if (!options.bundle && memo.has(key)) return memo.get(key)!;
  const result = resolveLocatorPack(provider, options);
  if (!result.ok && result.reason !== "locator_pack_missing" && !warned.has(provider)) {
    warned.add(provider);
    console.warn(JSON.stringify({ level: "warn", source: "locatorPack", provider, reason: result.reason }));
  }
  // Freeze an independent value so callers cannot mutate the bundle or validated cache.
  const pack = result.ok ? freezePack(structuredClone(result.pack)) : null;
  if (!options.bundle) memo.set(key, pack);
  return pack;
}
export type PortalLocators = Pick<ProviderPortalDefinition, "routes" | "allowedHosts" | "offHostAllowlist" | "terminalSignals"> & {
  selectors: Omit<ProviderPortalDefinition["selectors"], "quantityAwaitMs">;
};
export function hydratePortalLocators(pack: LocatorPack): PortalLocators {
  const selectors: PortalLocators["selectors"] = { cadUpload: pack.selectors.cadUpload };
  for (const key of ["drawingUpload", "quantity"] as const) if (Object.hasOwn(pack.selectors, key)) selectors[key] = pack.selectors[key];
  const configuration: Record<string, { selector: string; operation: "fill" | "select" | "click" }> = {};
  for (const step of pack.flow) {
    if (step.op !== "fill" && step.op !== "select" && step.op !== "click" && step.op !== "chooseByLabel") continue;
    if (["cadUpload", "drawingUpload", "quantity"].includes(step.selector) || Object.hasOwn(configuration, step.selector)) continue;
    configuration[step.selector] = { selector: pack.selectors[step.selector], operation: step.op === "chooseByLabel" ? "click" : step.op };
  }
  if (Object.keys(configuration).length) selectors.configuration = configuration;
  if (pack.cleanup?.row) selectors.cleanupRow = pack.selectors[pack.cleanup.row];
  if (pack.cleanup?.rowFileName) selectors.cleanupRowFileName = pack.selectors[pack.cleanup.rowFileName];
  if (pack.cleanup?.rules) selectors.cleanup = Object.fromEntries(Object.entries(pack.cleanup.rules).map(([key, rule]) => [key, {
    selector: pack.selectors[rule.selector],
    ...(rule.scope !== undefined ? { scope: pack.selectors[rule.scope] } : {}),
    ...(rule.uploadedRows !== undefined ? { uploadedRows: rule.uploadedRows } : {}),
    ...(rule.reportOnly !== undefined ? { reportOnly: rule.reportOnly } : {}),
  }]));
  const signals = (key: keyof LocatorPack["terminalSignals"]) => pack.terminalSignals[key].map(s => new RegExp(s.pattern, s.flags));
  return {
    routes: { ...pack.routes }, allowedHosts: [...pack.allowedHosts],
    ...(pack.offHostAllowlist !== undefined ? { offHostAllowlist: [...pack.offHostAllowlist] } : {}),
    selectors,
    terminalSignals: { login: signals("login"), captcha: signals("captcha"), manualReview: signals("manualReview"), configurationRequired: signals("configurationRequired"), unavailable: signals("unavailable") },
  };
}
export type OfferCardLocators = Omit<UsdOfferCardLocators, "priceFormat" | "fieldJoin"> & Partial<Pick<UsdOfferCardLocators, "priceFormat" | "fieldJoin">>;
export function hydrateOfferCardLocators(pack: LocatorPack): OfferCardLocators | null {
  return pack.offerCards ? { revision: pack.revision, ...structuredClone(pack.offerCards) } : null;
}
export function hydrateUsdOfferCardLocators(pack: LocatorPack): UsdOfferCardLocators | null {
  const cards = hydrateOfferCardLocators(pack);
  return cards?.priceFormat !== undefined && cards.fieldJoin !== undefined ? { ...cards, priceFormat: cards.priceFormat, fieldJoin: cards.fieldJoin } : null;
}
export function locatorPackFlowStep<Op extends LocatorFlowStep["op"]>(pack: LocatorPack, op: Op): Extract<LocatorFlowStep, { op: Op }> | undefined {
  return pack.flow.find(step => step.op === op) as Extract<LocatorFlowStep, { op: Op }> | undefined;
}
export function hydratePriceCellLocators(pack: LocatorPack): { revision: string; singlePrice: string; extendedPrice: string } | null {
  const step = locatorPackFlowStep(pack, "readPrice");
  return step ? { revision: pack.revision, singlePrice: pack.selectors[step.unit], extendedPrice: pack.selectors[step.total] } : null;
}
export function locatorPackLabel(pack: LocatorPack, map: string, key: string): string | null {
  return pack.labels && Object.hasOwn(pack.labels, map) && Object.hasOwn(pack.labels[map], key) ? pack.labels[map][key] : null;
}
export type LocatorPackChange = { path: string; surface: string; minimumClass: "S" | "P" | "F" | "E" };
export function locatorPackChangeSurfaces(base: LocatorPack, next: LocatorPack): LocatorPackChange[] {
  const changes: LocatorPackChange[] = [];
  const equal = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : canonicalLocatorPackJson(a) === canonicalLocatorPackJson(b);
  const visit = (a: unknown, b: unknown, path: string) => {
    if (equal(a, b) || path === "revision" || path === "evidence" || path.startsWith("evidence.")) return;
    const add = (minimumClass: LocatorPackChange["minimumClass"], surface = path.split(".")[0]) => changes.push({ path, surface, minimumClass });
    if (["schema", "provider", "kernelRevision", "envelopeRevision"].includes(path)) { add("E"); return; }
    if (path.startsWith("terminalSignals.")) {
      const previous = (a ?? []) as { pattern: string; flags: string }[];
      const remaining = (b ?? []) as typeof previous;
      let cursor = 0;
      // Additions preserve the old sequence. Reordering is not an addition.
      const onlyAdded = previous.every(signal => {
        const index = remaining.findIndex((s, i) => i >= cursor && equal(s, signal));
        if (index < 0) return false;
        cursor = index + 1;
        return true;
      });
      add(onlyAdded ? "S" : "F"); return;
    }
    if (["flow", "allowedHosts", "offHostAllowlist"].includes(path)) { add("F"); return; }
    const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
    if (isObject(a) || isObject(b)) {
      const left = isObject(a) ? a : {}, right = isObject(b) ? b : {};
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) visit(left[key], right[key], path ? `${path}.${key}` : key);
      return;
    }
    if (path.startsWith("labels.") || path === "offerCards.priceFormat") add("P");
    else if (path.startsWith("selectors.") || path.startsWith("fingerprint.") || path.startsWith("offerCards.") && path !== "offerCards.fieldJoin") add("S", /^(selectors\.(unitPrice|extendedPrice)|offerCards\.fields\.(unitPrice|totalPrice))$/.test(path) ? "priceCell" : path.split(".")[0]);
    else add("F");
  };
  visit(base, next, ""); return changes;
}
export function minimumLocatorPackChangeClass(changes: readonly LocatorPackChange[]): "none" | "S" | "P" | "F" | "E" {
  for (const level of ["E", "F", "P", "S"] as const) if (changes.some(c => c.minimumClass === level)) return level;
  return "none";
}
