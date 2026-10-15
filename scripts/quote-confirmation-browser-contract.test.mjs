import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { ID, FINGERPRINT, POLICY, access, queued, scope, detail } from "../e2e/quote-confirmation/data";
import { QuoteBrowserBackend, ORIGIN } from "../e2e/quote-confirmation/network";
import { parseQuoteAccess } from "../src/features/quotes/quote-access";
import { parseXometryBetaDispatchScope, parseXometryBetaDispatchResult } from "../src/features/quotes/xometry-beta-dispatch";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
function loadConfig(path, env) {
  const url = new URL(path, import.meta.url);
  const compiled = ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText.replaceAll("import.meta.url", JSON.stringify(url.href));
  const sandbox = { exports: {}, URL, process: { env }, require(name) {
    if (name === "@playwright/test") return { defineConfig: value => value };
    if (name === "node:url") return { fileURLToPath };
    throw new Error(`Unexpected config dependency: ${name}`);
  } };
  runInNewContext(compiled, sandbox, { timeout: 1000 });
  return sandbox.exports.default;
}
async function network() {
  let handler;
  let socketHandler;
  const backend = new QuoteBrowserBackend();
  await backend.install({ on: vi.fn(),
    route: async (_pattern, callback) => { handler = callback; },
    routeWebSocket: async (_pattern, callback) => { socketHandler = callback; },
  });
  const request = async (url, { method = "GET", body = {} } = {}) => {
    const route = { request: () => ({ url: () => url, method: () => method, postDataJSON: () => body }),
      abort: vi.fn(), fulfill: vi.fn(), continue: vi.fn() };
    await handler(route);
    return route;
  };
  return { backend, request, socketHandler };
}
const payload = () => ({ p_job_id: ID.job, p_declared_model_units: "inch", p_expected_scope_fingerprint: FINGERPRINT,
  p_policy_revision: POLICY, p_approval_reference: "50000000-0000-4000-8000-000000000001",
  p_authority_to_share: true, p_non_export_controlled: true, p_quote_only: true });

describe("Free quote browser fixture contracts (not browser acceptance)", () => {
  it("uses parser-valid synthetic Free access and dispatch data, with zero attachment bytes", () => {
    expect(parseQuoteAccess(access(), { actorUserId: ID.actor, organizationId: ID.organization, jobId: ID.job })).toMatchObject({ source: "free_beta", state: "eligible" });
    expect(parseXometryBetaDispatchScope(scope())).toEqual(scope());
    expect(parseXometryBetaDispatchScope(scope("millimeter", true))).toEqual(scope("millimeter", true));
    expect(parseXometryBetaDispatchResult(queued(false))).toMatchObject({ created: false, deduplicated: true });
    expect(detail.files).toEqual([]);
    expect(detail.part.cadFile.size_bytes).toBe(0);
    expect(detail.part.drawingFile).toBeNull();
    expect(detail.drawingPreview.pages).toEqual([]);
  });

  it("aborts all off-origin, backend non-RPC, file and unexpected mutation requests before send", async () => {
    const { request } = await network();
    for (const url of ["https://provider.example.invalid/upload", "http://localhost:4175/rest/v1/rpc/nope",
      "http://127.0.0.1:9/rest/v1/rpc/nope", `${ORIGIN}/storage/v1/object/test`, `${ORIGIN}/auth/v1/token`,
      `${ORIGIN}/api/admin-operations`, `${ORIGIN}/synthetic.step`, `${ORIGIN}/synthetic.pdf`]) {
      const route = await request(url);
      expect(route.abort).toHaveBeenCalledOnce();
      expect(route.continue).not.toHaveBeenCalled();
      expect(route.fulfill).not.toHaveBeenCalled();
    }
    const mutation = await request(`${ORIGIN}/anything`, { method: "POST" });
    expect(mutation.abort).toHaveBeenCalledOnce();
    const source = await request(`${ORIGIN}/assets/index-synthetic.js`);
    expect(source.continue).toHaveBeenCalledOnce();
  });

  it("aborts unknown RPCs and all WebSockets without a server connection", async () => {
    const { request, socketHandler, backend } = await network();
    const route = await request(`${ORIGIN}/rest/v1/rpc/api_request_quote_scoped`, { method: "POST" });
    expect(route.abort).toHaveBeenCalledOnce();
    expect(route.continue).not.toHaveBeenCalled();
    const socket = { url: () => "wss://provider.example.invalid/realtime", close: vi.fn(), connectToServer: vi.fn() };
    socketHandler(socket);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.connectToServer).not.toHaveBeenCalled();
    expect(backend.committed.size).toBe(0);
  });

  it("models lost response followed by exact deduplicated replay, and denies changed-scope reuse", async () => {
    const { backend, request } = await network();
    const invoke = body => request(`${ORIGIN}/rest/v1/rpc/api_request_xometry_beta_dispatch`, { method: "POST", body });
    backend.nextReply = "lost-after-commit";
    expect((await invoke(payload())).abort).toHaveBeenCalledOnce();
    expect(backend.committed.size).toBe(1);
    backend.changed = true;
    backend.accessMode = "blocked";
    const replay = await invoke(payload());
    expect(replay.fulfill.mock.calls[0][0].json).toMatchObject({ created: false, deduplicated: true, scopeFingerprint: FINGERPRINT });
    const changed = await invoke({ ...payload(), p_declared_model_units: "millimeter" });
    expect(changed.fulfill.mock.calls[0][0]).toMatchObject({ status: 400, json: { message: "xometry_beta_scope_changed" } });
    expect(backend.committed.size).toBe(1);
  });

  it("applies an optional synthetic failure body and status only to failing replies", async () => {
    const { backend, request } = await network();
    const scopeCall = body => request(`${ORIGIN}/rest/v1/rpc/api_get_xometry_beta_dispatch_scope`, { method: "POST", body });
    backend.failureReply = { status: 500, body: { code: "XX000", message: "synthetic failure" } };
    expect((await scopeCall({ p_declared_model_units: "inch" })).fulfill.mock.calls[0][0]).toMatchObject({ status: 200, json: scope() });
    backend.scopeMode = "error";
    expect((await scopeCall({})).fulfill.mock.calls[0][0]).toMatchObject({ status: 500, json: { code: "XX000", message: "synthetic failure" } });
    backend.nextReply = "denied";
    const denied = await request(`${ORIGIN}/rest/v1/rpc/api_request_xometry_beta_dispatch`, { method: "POST", body: payload() });
    expect(denied.fulfill.mock.calls[0][0]).toMatchObject({ status: 500, json: { code: "XX000" } });
    expect(backend.committed.size).toBe(0);
    backend.failureReply = null;
    expect((await scopeCall({})).fulfill.mock.calls[0][0]).toMatchObject({ status: 400, json: { code: "P0001", message: "Synthetic scope lookup unavailable" } });
  });

  it.each(["p_authority_to_share", "p_non_export_controlled", "p_quote_only"])("refuses missing %s even in the response fixture", async key => {
    const { backend, request } = await network();
    const route = await request(`${ORIGIN}/rest/v1/rpc/api_request_xometry_beta_dispatch`, { method: "POST", body: { ...payload(), [key]: false } });
    expect(route.fulfill.mock.calls[0][0].status).toBe(400);
    expect(backend.committed.size).toBe(0);
  });

  it.each([{}, { CI: "true", PLAYWRIGHT_BASE_URL: "https://forbidden.invalid", VITE_SUPABASE_URL: "https://forbidden.invalid" }])("retains sandbox, no saved auth, and fixed loopback with env %j", env => {
    const config = loadConfig("../e2e/quote-confirmation/playwright.config.ts", env);
    expect(config.testMatch).toBe("*.browser.ts");
    expect(config.use.baseURL).toBe(ORIGIN);
    expect(config.use.launchOptions).toEqual({ chromiumSandbox: true });
    expect(config.use.channel).toBe(env.CI === "true" ? "chrome" : undefined);
    expect(config.use.storageState).toBeUndefined();
    expect(config.use.serviceWorkers).toBe("block");
    expect(config.globalSetup).toBeUndefined();
    expect(config.webServer.reuseExistingServer).toBe(false);
    expect(config.webServer.command).toContain("vite.js build --config e2e/quote-confirmation/vite.config.ts &&");
    expect(config.webServer.command).toContain("vite.js preview --config e2e/quote-confirmation/vite.config.ts --host 127.0.0.1 --port 4175 --strictPort");
  });

  it("keeps the real feature modules and selects the browser suite in required CI without skips", () => {
    const config = read("../e2e/quote-confirmation/vite.config.ts");
    expect(config).toContain('publicDir: false');
    expect(config).toContain('hmr: false');
    expect(config).toContain('JSON.stringify("http://127.0.0.1:4175")');
    expect(config.match(/find:/g)).toHaveLength(3); // Session, workspace reads and ordinary @ path alias only.
    for (const module of ["use-client-part-controller", "quote-access", "quote-requests-api", "XometryBetaDispatchConfirmationDialog"]) expect(config).not.toContain(module);
    expect(read("../e2e/quote-confirmation/fixture.tsx")).toContain('import ClientPart from "../../src/pages/ClientPart"');
    const spec = read("../e2e/quote-confirmation/quote.browser.ts");
    expect(spec).not.toMatch(/test\.(?:skip|fixme)\(/);
    expect(read("../e2e/quote-confirmation/errors.browser.ts")).not.toMatch(/test\.(?:skip|fixme)\(/);
    const pkg = JSON.parse(read("../package.json"));
    expect(pkg.scripts["e2e:quote-confirmation"]).toContain("tsc --noEmit -p e2e/quote-confirmation/tsconfig.json && playwright test --config e2e/quote-confirmation/playwright.config.ts");
    const workflow = read("../.github/workflows/ci.yml");
    const browserJob = workflow.split("  browser-test:")[1].split("\n  build:")[0];
    expect(browserJob).toContain("run: npm run e2e:quote-confirmation -- --output=quote-confirmation-results --reporter=line,json");
    expect(browserJob).not.toContain("continue-on-error");
    expect(workflow).toContain("needs.browser-test.result");
    expect(browserJob).toContain("path: quote-confirmation-results/");
  });
});
