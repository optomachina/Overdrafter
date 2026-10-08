import type { BrowserContext, Route } from "@playwright/test";
import { access, ID, POLICY, queued, scope } from "./data";

export const ORIGIN = "http://127.0.0.1:4175";
export type RpcCall = { name: string; input: Record<string, unknown> };
type ReplyMode = "success" | "lost-after-commit" | "lost-before-commit" | "denied";
const cors = { "access-control-allow-origin": ORIGIN };

/** This ledger models only HTTP responses, NOT real SQL admission or worker execution. */
export class QuoteBrowserBackend {
  readonly calls: RpcCall[] = [];
  readonly forbidden: string[] = [];
  readonly pageErrors: string[] = [];
  readonly committed = new Map<string, Record<string, unknown>>();
  accessMode: "eligible" | "blocked" | "error" | "malformed" = "eligible";
  scopeMode: "ready" | "error" | "malformed" = "ready";
  changed = false;
  nextReply: ReplyMode = "success";
  denialCode = "xometry_beta_scope_changed";
  private pendingGate: Promise<void> | null = null;

  get dispatches() { return this.calls.filter(call => call.name === "api_request_xometry_beta_dispatch"); }
  get scopes() { return this.calls.filter(call => call.name === "api_get_xometry_beta_dispatch_scope"); }

  holdNextDispatch() {
    if (this.pendingGate) throw new Error("A fixture response is already held");
    let release!: () => void;
    this.pendingGate = new Promise<void>(resolve => { release = resolve; });
    return release;
  }

  async install(context: BrowserContext) {
    // Installed before page creation/navigation; popups inherit containment. Service workers
    // are blocked in config and no WebSocket can reach a server (including Vite HMR).
    context.on("page", page => page.on("pageerror", error => this.pageErrors.push(error.message)));
    await context.routeWebSocket("**/*", socket => {
      this.forbidden.push(`websocket:${new URL(socket.url()).origin}`);
      socket.close();
    });
    await context.route("**/*", async route => {
      const request = route.request();
      const url = new URL(request.url());
      // Exact origin is stricter than hostname-only loopback: no arbitrary local services.
      if (url.origin !== ORIGIN) {
        this.forbidden.push(`off-origin:${url.origin}`);
        return route.abort("blockedbyclient");
      }
      if (url.pathname.startsWith("/rest/v1/rpc/")) {
        if (request.method() !== "POST") return this.denyUnexpected(route);
        const name = url.pathname.slice("/rest/v1/rpc/".length);
        const input = request.postDataJSON() as Record<string, unknown>;
        this.calls.push({ name, input });
        return this.respond(route, name, input);
      }
      // Every app API, object read, upload, auth call and mutation outside the allowlist
      // is aborted before network send. Only the built entry and hashed assets go to preview.
      const isEntry = url.pathname === "/e2e/quote-confirmation/index.html";
      const isAsset = /^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css|wasm|svg|png|woff2)$/.test(url.pathname);
      if (request.method() !== "GET" || (!isEntry && !isAsset)) return this.denyUnexpected(route);
      return route.continue();
    });
  }

  private denyUnexpected(route: Route) {
    const url = new URL(route.request().url());
    this.forbidden.push(`${route.request().method()}:${url.pathname}`);
    return route.abort("blockedbyclient");
  }
  private json(route: Route, json: unknown, status = 200) {
    return route.fulfill({ status, json, headers: { ...cors, "cache-control": "no-store" } });
  }
  private denial(route: Route, message: string) {
    return this.json(route, { code: "P0001", message, details: null, hint: null }, 400);
  }
  private async respond(route: Route, name: string, input: Record<string, unknown>) {
    switch (name) {
      case "api_get_quote_access":
        if (this.accessMode === "error") return this.denial(route, "Synthetic quote-access lookup unavailable");
        return this.json(route, this.accessMode === "malformed" ? { schema: "quote-access.v1" } : access(this.accessMode === "eligible"));
      case "api_get_founding_beta_access_state":
        return this.json(route, { state: "eligible", policyRevision: POLICY, termsPath: "/terms", privacyPath: "/privacy" });
      case "api_get_job_vendor_preferences":
        return this.json(route, { jobId: ID.job, organizationId: ID.organization, projectId: null,
          availableVendors: ["xometry"], projectVendorPreferences: { includedVendors: [], excludedVendors: [] },
          jobVendorPreferences: { includedVendors: ["xometry"], excludedVendors: [] } });
      case "api_get_quote_lane_eligibility":
        return this.json(route, [{ vendor: "xometry", partId: ID.part, requestedQuantity: 1,
          state: "requestable", currentOfferId: null, validUntil: null, retryAt: null }]);
      case "api_get_xometry_beta_dispatch_scope": {
        if (this.scopeMode === "error") return this.denial(route, "Synthetic scope lookup unavailable");
        const value = scope(input.p_declared_model_units === "millimeter" ? "millimeter" : "inch", this.changed);
        return this.json(route, this.scopeMode === "malformed" ? { ...value, scopeFingerprint: "invalid" } : value);
      }
      case "api_request_xometry_beta_dispatch": {
        const gate = this.pendingGate;
        this.pendingGate = null;
        const reply = this.nextReply;
        this.nextReply = "success";
        if (gate) await gate;
        if (reply === "denied") return this.denial(route, this.denialCode);
        if (input.p_job_id !== ID.job || input.p_policy_revision !== POLICY
          || !["inch", "millimeter"].includes(String(input.p_declared_model_units))
          || typeof input.p_approval_reference !== "string" || !/^[0-9a-f-]{36}$/.test(input.p_approval_reference)
          || input.p_authority_to_share !== true || input.p_non_export_controlled !== true || input.p_quote_only !== true) {
          return this.denial(route, "xometry_beta_invalid_confirmation");
        }
        if (reply === "lost-before-commit") return route.abort("connectionfailed");
        const reference = String(input.p_approval_reference);
        const previous = this.committed.get(reference);
        const current = scope(input.p_declared_model_units === "millimeter" ? "millimeter" : "inch", this.changed);
        if (previous ? JSON.stringify(previous) !== JSON.stringify(input)
          : input.p_expected_scope_fingerprint !== current.scopeFingerprint || this.accessMode !== "eligible") {
          return this.denial(route, "xometry_beta_scope_changed");
        }
        if (!previous) this.committed.set(reference, structuredClone(input));
        if (reply === "lost-after-commit") return route.abort("connectionfailed");
        return this.json(route, queued(!previous, String(input.p_expected_scope_fingerprint)));
      }
      default: return this.denyUnexpected(route);
    }
  }
}
