/**
 * Serves the synthetic configurator through Playwright routing at
 * https://fixture.invalid and acts as the independent oracle: the server
 * state, not the page or the adapter, records what was saved, every field
 * commit, every dialog answer and every decoy press. Every other request is
 * aborted and recorded. No network traffic leaves the process.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Route } from "playwright";

export const FIXTURE_ORIGIN = "https://fixture.invalid";
export const QUOTE_PATH = "/quoting/quote/Q00-0000-0000";
export const QUOTE_URL = `${FIXTURE_ORIGIN}${QUOTE_PATH}`;
const HTML = readFileSync(fileURLToPath(new URL("../fixtures/jev-driver/configurator.html", import.meta.url)), "utf8");

export type ToleranceTier = "looser" | "standard" | "tighter";
export type FixtureKnobs = {
  seed: number;
  hooks: "stable" | "renamed";
  placeholders: { process: string; material: string; finish: string };
  unitsDialog: boolean;
  confirmOnMaterialChange: boolean;
  processingMs: number;
  recalcMs: number;
  stepper: "number" | "text_numeric";
  responsiveDup: "none" | "hidden_first";
  combobox: "aria" | "roleless";
  layout: "standard" | "drawer_tabs" | "iframe" | "shadow";
  injection: boolean;
  checkoutBait: boolean;
  exportControlMidway: boolean;
  badge: boolean;
  catalogExclude: string[];
  cookieBanner: boolean;
  churn: boolean;
  optionJitterMs: [number, number];
};

export const BASE_KNOBS: Omit<FixtureKnobs, "seed"> = {
  hooks: "stable",
  placeholders: { process: "Search Process", material: "Search Material", finish: "Search Finish" },
  unitsDialog: false, confirmOnMaterialChange: false, processingMs: 0, recalcMs: 1_200, stepper: "number",
  responsiveDup: "none", combobox: "aria", layout: "standard", injection: false, checkoutBait: false,
  exportControlMidway: false, badge: false, catalogExclude: [], cookieBanner: false, churn: false, optionJitterMs: [200, 1_500],
};

export type ConfigValues = { process: string; material: string; finish: string; quantity: number; tolerance: ToleranceTier };
type Tier = { label: string; arrives: string; unit: string; total: string; totalUsd: number };
export type FixtureState = ConfigValues & {
  units: string | null; cookieDismissed: boolean; saves: number; pricingReadyAt: number; tiers: Tier[];
};
export type OracleEvent = { at: number; kind: string; [key: string]: unknown };

const MATERIAL_BASE: Array<[RegExp, number]> = [
  [/6061/, 18.4], [/7075/, 24.1], [/2024/, 22], [/303/, 31.75], [/304/, 33.2], [/316/, 36.9], [/1018/, 21.1], [/4140/, 26.3],
  [/brass/i, 29.8], [/titanium/i, 88], [/peek/i, 64], [/delrin/i, 16.2], [/abs/i, 12.4],
];
const FINISH_ADDER: Array<[RegExp, number]> = [
  [/bead/i, 4.1], [/black anodize/i, 7.2], [/type iii/i, 11.4], [/anodize/i, 6.3], [/chromate/i, 5.1], [/passivation/i, 3.8], [/powder/i, 8.9],
];
const money = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Deterministic synthetic pricing; the oracle knows the exact expected totals. */
export function priceTiers(config: ConfigValues): Tier[] {
  const base = MATERIAL_BASE.find(([pattern]) => pattern.test(config.material))?.[1] ?? 20;
  const adder = FINISH_ADDER.find(([pattern]) => pattern.test(config.finish))?.[1] ?? 0;
  const tolerance = config.tolerance === "tighter" ? 1.22 : config.tolerance === "looser" ? 0.95 : 1;
  const unit = Math.round((base + adder) * tolerance * (1 + 9 / (config.quantity + 2)) * 100) / 100;
  return ([["Least Expensive", 1, "Arrives by Nov 6"], ["Standard", 1.14, "Arrives by Nov 3"], ["Fastest", 1.38, "Arrives by Oct 30"]] as const)
    .map(([label, factor, arrives]) => {
      const each = Math.round(unit * factor * 100) / 100;
      const totalUsd = Math.round(each * config.quantity * 100) / 100;
      return { label, arrives, unit: money(each), total: money(totalUsd), totalUsd };
    });
}

export class FixtureSite {
  readonly events: OracleEvent[] = [];
  readonly saves: Array<{ at: number; config: ConfigValues }> = [];
  readonly boundaryHits: string[] = [];
  readonly foreignRequests: string[] = [];
  readonly unexpectedRequests: string[] = [];
  state: FixtureState;
  readonly initial: ConfigValues;

  private constructor(readonly knobs: FixtureKnobs, initial: ConfigValues) {
    this.initial = { ...initial };
    this.state = { ...initial, units: null, cookieDismissed: false, saves: 0, pricingReadyAt: 0, tiers: priceTiers(initial) };
  }

  static async install(context: BrowserContext, knobs: FixtureKnobs, initial: ConfigValues) {
    const site = new FixtureSite(knobs, initial);
    await context.route("**/*", (route) => site.handle(route));
    return site;
  }

  private boot(view: "quote" | "configure" | "frame") {
    const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
    const script = `<script>window.__OVD_FIXTURE=${json(this.knobs)};window.__OVD_STATE=${json(this.publicState())};window.__OVD_VIEW=${json(view)};</script>`;
    return HTML.replace("<!--OVD_BOOT-->", script);
  }

  private publicState() {
    return { ...this.state, tiers: this.state.tiers.map(({ totalUsd: _omit, ...tier }) => tier) };
  }

  private recalc() {
    this.state.tiers = priceTiers(this.state);
    this.state.pricingReadyAt = Date.now() + this.knobs.recalcMs;
  }

  private async handle(route: Route) {
    const request = route.request();
    let url: URL;
    try { url = new URL(request.url()); } catch { return route.abort("blockedbyclient"); }
    if (url.origin !== FIXTURE_ORIGIN) {
      this.foreignRequests.push(url.origin);
      return route.abort("blockedbyclient");
    }
    if (/checkout|\/orders?\b|payment|\/cart\b/i.test(url.pathname)) {
      this.boundaryHits.push(url.pathname);
      return route.abort("blockedbyclient");
    }
    const html = (view: "quote" | "configure" | "frame") => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: this.boot(view) });
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    if (request.method() === "GET") {
      if (url.pathname === QUOTE_PATH) return html("quote");
      if (url.pathname === `${QUOTE_PATH}/configure`) return html("configure");
      if (url.pathname === `${QUOTE_PATH}/configure/frame`) return html("frame");
      if (url.pathname === "/api/state") return json(this.publicState());
      if (url.pathname === "/favicon.ico") return route.fulfill({ status: 404, body: "" });
    }
    if (request.method() === "POST") {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(request.postData() ?? "{}") as Record<string, unknown>; } catch { body = {}; }
      if (url.pathname === "/api/config") {
        const config: ConfigValues = {
          process: String(body.process), material: String(body.material), finish: String(body.finish),
          quantity: Number(body.quantity), tolerance: body.tolerance as ToleranceTier,
        };
        Object.assign(this.state, config);
        this.state.saves += 1;
        this.saves.push({ at: Date.now(), config });
        this.events.push({ at: Date.now(), kind: "save", ...config });
        this.recalc();
        return json(this.publicState());
      }
      if (url.pathname === "/api/quantity") {
        this.state.quantity = Number(body.quantity);
        this.events.push({ at: Date.now(), kind: "commit", field: "quantity", value: String(body.quantity), source: "quote_view" });
        this.recalc();
        return json(this.publicState());
      }
      if (url.pathname === "/api/event") {
        this.events.push({ at: Date.now(), ...body, kind: String(body.kind) });
        if (body.kind === "units") this.state.units = String(body.value);
        if (body.kind === "cookie") this.state.cookieDismissed = true;
        return json({ ok: true });
      }
    }
    this.unexpectedRequests.push(`${request.method()} ${url.pathname}`);
    return route.abort("blockedbyclient");
  }
}
