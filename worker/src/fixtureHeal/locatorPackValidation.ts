/** OVD-814 (OVD-796 slice 3): shared, pure pack contract for runtime and offline tooling. */
import { createHash } from "node:crypto";

export const LOCATOR_PACK_SCHEMA = "provider-locator-pack.v1";
export const LOCATOR_PACK_KERNEL_REVISION = "provider-portal-kernel.v1";
export const LOCATOR_FLOW_OPS = ["goto", "upload", "fill", "select", "click", "chooseByLabel", "waitPrice", "readPrice", "readOfferCards", "readEcho"] as const;
export type LocatorFlowStep =
  | { op: "goto"; route: "publicUrl" | "loginUrl" | "uploadUrl" }
  | { op: "upload"; selector: "cadUpload" | "drawingUpload" }
  | { op: "fill"; selector: string; value: string }
  | { op: "select"; selector: string; value: string }
  | { op: "click"; selector: string; label?: string }
  | { op: "chooseByLabel"; selector: string; label: string; within?: string }
  | { op: "waitPrice"; selector: string; notShape?: "dash"; timeoutMs: number }
  | { op: "readPrice"; unit: string; total: string }
  | { op: "readOfferCards" }
  | { op: "readEcho"; material?: string; thickness?: string; quantity?: string };
export type LocatorPack = {
  schema: typeof LOCATOR_PACK_SCHEMA; provider: string; revision: string;
  kernelRevision: typeof LOCATOR_PACK_KERNEL_REVISION; envelopeRevision: string;
  routes: { publicUrl: string; loginUrl: string; uploadUrl: string };
  allowedHosts: string[]; offHostAllowlist?: string[];
  selectors: Record<string, string> & { cadUpload: string };
  labels?: Record<string, Record<string, string>>;
  flow: LocatorFlowStep[];
  offerCards?: {
    card: string; optionIdAttribute: string;
    fields: { label: string; quantity: string; unitPrice: string; totalPrice: string; currency: string; leadBusinessDays: string };
    priceFormat?: "plain" | "display"; fieldJoin?: " " | " >> ";
  };
  cleanup?: {
    mode: "none" | "reportOnly" | "delete" | "archive" | "expire";
    row?: string; rowFileName?: string;
    rules?: Record<string, { selector: string; scope?: string; uploadedRows?: boolean; reportOnly?: boolean }>;
    steps?: { op: "click"; selector: string; scope?: "$itemId" }[]; verify?: string;
  };
  terminalSignals: Record<"login" | "captcha" | "manualReview" | "configurationRequired" | "unavailable", { pattern: string; flags: string }[]>;
  fingerprint?: { [page: string]: { readySelector: string } | string[] };
  evidence: { capturedAt: string | null; issue: string; captureSha256: string | null; note?: string };
};
export type LocatorPackRejection =
  | "locator_pack_schema_invalid" | "locator_pack_flow_op_unknown" | "locator_pack_reference_unknown"
  | "locator_pack_host_invalid" | "locator_pack_route_invalid" | "locator_pack_signal_invalid"
  | "locator_pack_configuration_prohibited" | "locator_pack_envelope_mismatch" | "locator_pack_sha256_mismatch"
  | "locator_pack_revision_stale" | "locator_pack_revision_conflict" | "locator_pack_provider_mismatch"
  | "locator_pack_missing" | "locator_pack_duplicate";
const REVISION = /^([a-z][a-z0-9]*)-(?:[a-z0-9]+-)*locators\.v(0|[1-9]\d{0,5})(?:-[a-z0-9]+)*$/;
const NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
const LABEL_KEY = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SIGNALS = ["login", "captcha", "manualReview", "configurationRequired", "unavailable"] as const;
const own = (object: object, key: string) => Object.hasOwn(object, key);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
class InvalidPack extends Error {
  readonly reason: LocatorPackRejection;
  readonly path: string;
  constructor(reason: LocatorPackRejection, path: string) { super(`${reason}: ${path}`); this.reason = reason; this.path = path; }
}
function check(ok: unknown, path: string, reason: LocatorPackRejection = "locator_pack_schema_invalid"): asserts ok {
  if (!ok) throw new InvalidPack(reason, path);
}
function object(value: unknown, path: string, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  check(record(value), path);
  check(required.every(k => own(value, k)), path);
  check(Object.keys(value).every(k => required.includes(k) || optional.includes(k)), path);
}
function text(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function selector(value: unknown): value is string {
  return text(value, 512) && !Array.from(value).some(c => c.charCodeAt(0) < 32 || (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159));
}
export function locatorPackRevisionNumber(revision: string): number | null {
  const match = REVISION.exec(revision); return match ? Number(match[2]) : null;
}
export function canonicalLocatorPackJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalLocatorPackJson).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalLocatorPackJson(value[k])}`).join(",")}}`;
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  throw new TypeError("Locator pack canonicalization requires JSON data");
}
export function locatorPackSha256(value: unknown): string { return createHash("sha256").update(canonicalLocatorPackJson(value)).digest("hex"); }

export function parseLocatorPack(value: unknown): { ok: true; pack: LocatorPack } | { ok: false; reason: LocatorPackRejection; path: string } {
  try {
    object(value, "$", ["schema", "provider", "revision", "kernelRevision", "envelopeRevision", "routes", "allowedHosts", "selectors", "flow", "terminalSignals", "evidence"], ["offHostAllowlist", "labels", "offerCards", "cleanup", "fingerprint"]);
    check(value.schema === LOCATOR_PACK_SCHEMA, "schema");
    check(value.kernelRevision === LOCATOR_PACK_KERNEL_REVISION, "kernelRevision");
    check(typeof value.provider === "string" && /^[a-z][a-z0-9]*$/.test(value.provider), "provider", "locator_pack_provider_mismatch");
    check(typeof value.revision === "string" && REVISION.test(value.revision), "revision");
    check(REVISION.exec(value.revision)?.[1] === value.provider, "revision", "locator_pack_provider_mismatch");
    check(typeof value.envelopeRevision === "string" && /^([a-z0-9]+(?:-[a-z0-9]+)*)\.v([1-9]\d{0,8})$/.test(value.envelopeRevision), "envelopeRevision");
    for (const key of ["allowedHosts", "offHostAllowlist"]) {
      if (key === "offHostAllowlist" && !own(value, key)) continue;
      const hosts = value[key];
      check(Array.isArray(hosts) && hosts.every(h => typeof h === "string" && HOST.test(h)) && new Set(hosts).size === hosts.length, key, "locator_pack_host_invalid");
      if (key === "allowedHosts") check(hosts.length >= 1 && hosts.length <= 10, key, "locator_pack_host_invalid");
    }
    const hosts = value.allowedHosts as string[];
    check(!(value.offHostAllowlist as string[] | undefined)?.some(h => hosts.includes(h)), "offHostAllowlist", "locator_pack_host_invalid");
    object(value.routes, "routes", ["publicUrl", "loginUrl", "uploadUrl"]);
    for (const [key, route] of Object.entries(value.routes)) {
      let valid = false;
      if (typeof route === "string") {
        try {
          const url = new URL(route);
          // URL.port normalizes explicit :443 away; reject it in the original authority too.
          const authority = /^https:\/\/([^/?#]+)/.exec(route)?.[1];
          valid = url.protocol === "https:" && !url.username && !url.password && !url.port
            && !!authority && !authority.includes(":") && !authority.includes("@") && hosts.includes(url.hostname);
        } catch { /* Invalid URL is a route rejection. */ }
      }
      check(valid, `routes.${key}`, "locator_pack_route_invalid");
    }
    check(record(value.selectors), "selectors");
    const selectors = value.selectors;
    check(own(selectors, "cadUpload"), "selectors.cadUpload");
    for (const [key, sel] of Object.entries(selectors)) check(NAME.test(key) && selector(sel), `selectors.${key}`);
    const ref = (name: unknown, path: string) => check(typeof name === "string" && own(selectors, name), path, "locator_pack_reference_unknown");
    if (own(value, "labels")) {
      check(record(value.labels), "labels");
      for (const [map, entries] of Object.entries(value.labels)) {
        check(NAME.test(map) && record(entries), `labels.${map}`);
        for (const [key, label] of Object.entries(entries)) {
          // priceKinds keys are selector names, intentionally camelCase.
          check((map === "priceKinds" ? NAME : LABEL_KEY).test(key) && text(label, 200), `labels.${map}.${key}`);
          if (map === "priceKinds") { ref(key, `labels.${map}.${key}`); check(label === "unit" || label === "total", `labels.${map}.${key}`); }
        }
      }
    }
    const labelRef = (v: unknown, path: string) => {
      if (v === "$qty" || v === "$material" || v === "$thickness") return;
      const match = typeof v === "string" ? /^labels\.([a-z][A-Za-z0-9]{0,63})\[([a-z0-9][a-z0-9.-]{0,63}|\$material|\$thickness)\]$/.exec(v) : null;
      const labels = value.labels as LocatorPack["labels"];
      check(match && labels && own(labels, match[1]) && (match[2].startsWith("$") || own(labels[match[1]], match[2])), path, "locator_pack_reference_unknown");
    };
    check(Array.isArray(value.flow) && value.flow.length > 0, "flow");
    let uploads = 0, reads = 0;
    const operations = new Map<string, string>();
    for (const [index, step] of value.flow.entries()) {
      const p = `flow[${index}]`;
      check(record(step), p);
      check(LOCATOR_FLOW_OPS.includes(step.op as typeof LOCATOR_FLOW_OPS[number]), `${p}.op`, "locator_pack_flow_op_unknown");
      switch (step.op) {
        case "goto": object(step, p, ["op", "route"]); check(["publicUrl", "loginUrl", "uploadUrl"].includes(step.route as string), `${p}.route`, "locator_pack_route_invalid"); break;
        case "upload": object(step, p, ["op", "selector"]); check(step.selector === "cadUpload" || step.selector === "drawingUpload", `${p}.selector`); if (step.selector === "cadUpload") uploads++; break;
        case "fill": case "select": object(step, p, ["op", "selector", "value"]); labelRef(step.value, `${p}.value`); break;
        case "click": object(step, p, ["op", "selector"], ["label"]); if (own(step, "label")) labelRef(step.label, `${p}.label`); break;
        case "chooseByLabel": object(step, p, ["op", "selector", "label"], ["within"]); labelRef(step.label, `${p}.label`); break;
        case "waitPrice": object(step, p, ["op", "selector", "timeoutMs"], ["notShape"]); check(Number.isInteger(step.timeoutMs) && Number(step.timeoutMs) >= 1 && Number(step.timeoutMs) <= 120000, `${p}.timeoutMs`); check(!own(step, "notShape") || step.notShape === "dash", `${p}.notShape`); break;
        case "readPrice": object(step, p, ["op", "unit", "total"]); reads++; break;
        case "readOfferCards": object(step, p, ["op"]); check(own(value, "offerCards"), "offerCards"); reads++; break;
        case "readEcho": object(step, p, ["op"], ["material", "thickness", "quantity"]); break;
      }
      for (const key of ["selector", "within", "unit", "total", "material", "thickness", "quantity"]) if (own(step, key)) ref(step[key], `${p}.${key}`);
      if (["fill", "select", "click", "chooseByLabel"].includes(step.op as string)) {
        const name = step.selector as string, op = step.op === "chooseByLabel" ? "click" : step.op as string;
        check(!operations.has(name) || operations.get(name) === op, `${p}.selector`);
        operations.set(name, op);
        if (!["cadUpload", "drawingUpload", "quantity"].includes(name)) check(!/checkout|order|purchase|payment|cart/i.test(selectors[name] as string), `${p}.selector`, "locator_pack_configuration_prohibited");
      }
    }
    check(uploads === 1 && reads === 1, "flow");
    if (own(value, "offerCards")) {
      const cards = value.offerCards;
      object(cards, "offerCards", ["card", "optionIdAttribute", "fields"], ["priceFormat", "fieldJoin"]);
      check(selector(cards.card), "offerCards.card");
      check(typeof cards.optionIdAttribute === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(cards.optionIdAttribute), "offerCards.optionIdAttribute");
      object(cards.fields, "offerCards.fields", ["label", "quantity", "unitPrice", "totalPrice", "currency", "leadBusinessDays"]);
      for (const [k, v] of Object.entries(cards.fields)) check(selector(v), `offerCards.fields.${k}`);
      check(!own(cards, "priceFormat") || ["plain", "display"].includes(cards.priceFormat as string), "offerCards.priceFormat");
      check(!own(cards, "fieldJoin") || [" ", " >> "].includes(cards.fieldJoin as string), "offerCards.fieldJoin");
    }
    if (own(value, "cleanup")) {
      const c = value.cleanup;
      object(c, "cleanup", ["mode"], ["row", "rowFileName", "rules", "steps", "verify"]);
      check(["none", "reportOnly", "delete", "archive", "expire"].includes(c.mode as string), "cleanup.mode");
      for (const k of ["row", "rowFileName", "verify"]) if (own(c, k)) ref(c[k], `cleanup.${k}`);
      if (own(c, "rules")) {
        check(record(c.rules), "cleanup.rules");
        for (const [k, rule] of Object.entries(c.rules)) {
          check(NAME.test(k), `cleanup.rules.${k}`);
          object(rule, `cleanup.rules.${k}`, ["selector"], ["scope", "uploadedRows", "reportOnly"]);
          ref(rule.selector, `cleanup.rules.${k}.selector`);
          if (own(rule, "scope")) ref(rule.scope, `cleanup.rules.${k}.scope`);
          for (const flag of ["uploadedRows", "reportOnly"]) check(!own(rule, flag) || typeof rule[flag] === "boolean", `cleanup.rules.${k}.${flag}`);
          check(c.mode !== "reportOnly" || rule.reportOnly === true, `cleanup.rules.${k}.reportOnly`);
        }
      }
      if (own(c, "steps")) {
        check(c.mode !== "reportOnly" && Array.isArray(c.steps), "cleanup.steps");
        for (const [i, step] of c.steps.entries()) {
          object(step, `cleanup.steps[${i}]`, ["op", "selector"], ["scope"]);
          check(step.op === "click" && (!own(step, "scope") || step.scope === "$itemId"), `cleanup.steps[${i}]`);
          ref(step.selector, `cleanup.steps[${i}].selector`);
        }
      }
    }
    object(value.terminalSignals, "terminalSignals", [...SIGNALS]);
    for (const [k, signals] of Object.entries(value.terminalSignals)) {
      check(Array.isArray(signals) && signals.length <= 20, `terminalSignals.${k}`, "locator_pack_signal_invalid");
      for (const [i, signal] of signals.entries()) {
        const p = `terminalSignals.${k}[${i}]`;
        object(signal, p, ["pattern", "flags"]);
        check(text(signal.pattern, 500) && typeof signal.flags === "string" && /^i?m?s?u?$/.test(signal.flags), p, "locator_pack_signal_invalid");
        try { new RegExp(signal.pattern, signal.flags); } catch { throw new InvalidPack("locator_pack_signal_invalid", p); }
      }
    }
    if (own(value, "fingerprint")) {
      check(record(value.fingerprint), "fingerprint");
      for (const [page, entry] of Object.entries(value.fingerprint)) {
        if (page === "mask") { check(Array.isArray(entry), "fingerprint.mask"); entry.forEach((v, i) => ref(v, `fingerprint.mask[${i}]`)); }
        else { check(/^[a-z][A-Za-z0-9]{0,31}$/.test(page), `fingerprint.${page}`); object(entry, `fingerprint.${page}`, ["readySelector"]); ref(entry.readySelector, `fingerprint.${page}.readySelector`); }
      }
    }
    object(value.evidence, "evidence", ["capturedAt", "issue", "captureSha256"], ["note"]);
    const e = value.evidence;
    check(e.capturedAt === null || (typeof e.capturedAt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.capturedAt) && !Number.isNaN(Date.parse(e.capturedAt)) && new Date(e.capturedAt).toISOString().slice(0, 10) === e.capturedAt), "evidence.capturedAt");
    check(typeof e.issue === "string" && /^OVD-[1-9]\d*$/.test(e.issue), "evidence.issue");
    check(e.captureSha256 === null || (typeof e.captureSha256 === "string" && /^[a-fA-F0-9]{64}$/.test(e.captureSha256)), "evidence.captureSha256");
    check(!own(e, "note") || (typeof e.note === "string" && e.note.length <= 500), "evidence.note");
    return { ok: true, pack: value as LocatorPack };
  } catch (error) {
    if (error instanceof InvalidPack) return { ok: false, reason: error.reason, path: error.path };
    throw error;
  }
}
