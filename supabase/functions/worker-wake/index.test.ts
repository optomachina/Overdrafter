import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createWakeHandler, productionRuntime, type WakeRuntime } from "./index.ts";
import { mintIdToken, workerOrigin } from "./oidc.ts";

function setup(overrides: Partial<WakeRuntime> = {}) {
  const calls: string[] = [];
  const runtime: WakeRuntime = {
    enabled: () => true, deadlineMs: 100,
    authenticate: () => { calls.push("auth"); return Promise.resolve(true); },
    takeSlot: () => { calls.push("slot"); return Promise.resolve(true); },
    wake: () => { calls.push("wake"); return Promise.resolve(true); }, ...overrides,
  };
  return { handler: createWakeHandler(runtime), calls };
}
function request(body: string | undefined = "{}", token = "Bearer synthetic-user", method = "POST") {
  return new Request("https://edge.test/worker-wake", { method, headers: { Authorization: token }, ...(method === "POST" ? { body } : {}) });
}
Deno.test("default off, methods and auth fail before wake", async () => {
  for (const [runtime, req, status] of [
    [{ enabled: () => false }, request(), 503],
    [{}, request(undefined, "", "GET"), 405],
    [{}, request(undefined, "", "OPTIONS"), 204],
    [{}, request("{}", ""), 401],
    [{ authenticate: () => Promise.resolve(false) }, request(), 401],
  ] as [Partial<WakeRuntime>, Request, number][]) {
    const { handler, calls } = setup(runtime);
    assertEquals((await handler(req)).status, status);
    assertEquals(calls.includes("wake"), false);
  }
});
Deno.test("only empty bodies accepted; no user payload reaches wake", async () => {
  for (const body of [undefined, "", "{}", " { } ", '{"url":"https://attacker.test"}', "[]", "null", "bad", " ".repeat(65)]) {
    const { handler, calls } = setup();
    const valid = body === undefined || ["", "{}", " { } "].includes(body);
    assertEquals((await handler(request(body))).status, valid ? 204 : 400);
    assertEquals(calls, valid ? ["auth", "slot", "wake"] : ["auth"]);
  }
});
Deno.test("throttle, backend errors, failure and deadline are bounded and opaque", async () => {
  for (const [overrides, status] of [
    [{ takeSlot: () => Promise.resolve(false) }, 429],
    [{ takeSlot: () => Promise.reject(new Error("sensitive")) }, 503],
    [{ wake: () => Promise.resolve(false) }, 502],
    [{ wake: () => Promise.reject(new Error("sensitive")) }, 503],
    [{ deadlineMs: 5, authenticate: () => new Promise(() => {}) }, 504],
  ] as [Partial<WakeRuntime>, number][]) {
    const { handler } = setup(overrides);
    const response = await handler(request());
    assertEquals(response.status, status);
    assertEquals(await response.text(), "");
    if (status === 429) assertEquals(response.headers.get("retry-after"), "10");
  }
});
Deno.test("late authentication cannot wake after deadline", async () => {
  let finish!: (value: boolean) => void;
  const { handler, calls } = setup({ deadlineMs: 5, authenticate: () => new Promise(resolve => { finish = resolve; }) });
  assertEquals((await handler(request())).status, 504);
  finish(true);
  await new Promise(resolve => setTimeout(resolve, 1));
  assertEquals(calls, []);
});
Deno.test("worker destination rejects paths, credentials, query, HTTP and redirects by contract", () => {
  assertEquals(workerOrigin("https://worker-test.run.app/"), "https://worker-test.run.app");
  for (const url of ["http://worker.run.app", "https://evil.test", "https://a.run.app.evil.test", "https://a.run.app/path", "https://a.run.app?q=1", "https://a.run.app#x", "https://user@a.run.app", "https://a.run.app:444"]) assertThrows(() => workerOrigin(url));
});
async function account() {
  const key = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const bytes = new Uint8Array(await crypto.subtle.exportKey("pkcs8", key.privateKey));
  return { key, secret: JSON.stringify({ type: "service_account", client_email: "wake@synthetic.iam.gserviceaccount.com", private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...bytes))}\n-----END PRIVATE KEY-----` }) };
}
Deno.test("OIDC assertion is signed, audience bound and exchanged only at Google", async () => {
  const { key, secret } = await account();
  const http: typeof fetch = async (input, init) => {
    assertEquals(input, "https://oauth2.googleapis.com/token");
    assertEquals(init?.redirect, "error");
    const form = init?.body as URLSearchParams;
    assertEquals(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, payload, signature] = form.get("assertion")!.split(".");
    const decode = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(decode(payload)));
    assertEquals(claims.target_audience, "https://worker-test.run.app");
    assertEquals(claims.aud, "https://oauth2.googleapis.com/token");
    assertEquals(claims.exp - claims.iat, 300);
    assertEquals(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key.publicKey, decode(signature), new TextEncoder().encode(`${header}.${payload}`)), true);
    return Response.json({ id_token: "synthetic.id.token" });
  };
  assertEquals(await mintIdToken(secret, "https://worker-test.run.app", new AbortController().signal, http), "synthetic.id.token");
  await assertRejects(() => mintIdToken(secret, "https://worker-test.run.app", new AbortController().signal, async () => Response.json({ access_token: "wrong-kind" })));
});
Deno.test("runtime verifies users, fails closed on RPC errors and sends fixed GET with one 503 retry", async () => {
  const { secret } = await account();
  const env: Record<string, string> = { WORKER_WAKE_ENABLED: "true", SUPABASE_URL: "https://synthetic.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-key", WORKER_WAKE_URL: "https://worker-test.run.app", WORKER_WAKE_SERVICE_ACCOUNT_JSON: secret };
  let attempts = 0;
  let anonymous = false;
  let role = "authenticated";
  let expired = false;
  let rpcError = false;
  const http: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) return expired ? Response.json({ message: "expired" }, { status: 401 }) : Response.json({ id: "synthetic-user", role, is_anonymous: anonymous });
    if (url.includes("/rest/v1/rpc/")) return rpcError ? Response.json({ message: "sensitive" }, { status: 500 }) : Response.json(true);
    if (url === "https://oauth2.googleapis.com/token") return Response.json({ id_token: "synthetic.id.token" });
    assertEquals(url, "https://worker-test.run.app/");
    assertEquals(init?.method, "GET");
    assertEquals(init?.body, undefined);
    assertEquals(init?.headers, { Authorization: "Bearer synthetic.id.token" });
    assertEquals(init?.redirect, "error");
    attempts++;
    return new Response(null, { status: attempts === 1 ? 503 : 200 });
  };
  const runtime = productionRuntime(name => env[name], http);
  const signal = new AbortController().signal;
  assertEquals(await runtime.authenticate("synthetic-user-token", signal), true);
  anonymous = true;
  assertEquals(await runtime.authenticate("synthetic-user-token", signal), false);
  anonymous = false;
  for (const deniedRole of ["anon", "service_role"]) {
    role = deniedRole;
    assertEquals(await runtime.authenticate("synthetic-user-token", signal), false);
  }
  role = "authenticated";
  expired = true;
  assertEquals(await runtime.authenticate("synthetic-user-token", signal), false);
  assertEquals(await runtime.takeSlot(signal), true);
  rpcError = true;
  await assertRejects(() => runtime.takeSlot(signal));
  assertEquals(await runtime.wake(signal), true);
  assertEquals(attempts, 2);
  assertEquals(productionRuntime(() => undefined).enabled(), false);
});
Deno.test("deadline cancels stalled request body and never consumes a slot", async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const { handler, calls } = setup({ deadlineMs: 5 });
  const req = new Request("https://edge.test/worker-wake", { method: "POST", headers: { Authorization: "Bearer synthetic" }, body });
  assertEquals((await handler(req)).status, 504);
  assertEquals(cancelled, true);
  assertEquals(calls, ["auth"]);
});
