// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { digest, RECIPE, type Run } from "./sample-plate-dispatch";
import { createPrivatePlateHttp } from "./sample-plate-private";

const origin = "https://workstation.example.ts.net";
const identity = "owner@example.test";
const id = "a".repeat(32);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ovd579-"));
  const output = path.join(root, "private"); const assets = path.join(root, "static");
  mkdirSync(path.join(output, id), { recursive: true }); mkdirSync(path.join(assets, "assets"), { recursive: true });
  writeFileSync(path.join(assets, "sample-plate.html"), "<h1>Verified sample</h1>");
  writeFileSync(path.join(assets, "assets", "sample-test.js"), "console.log('sample')");
  writeFileSync(path.join(assets, "assets", "secret.map"), "never served");
  const checks = Object.fromEntries(["dimensions", "material", "holes", "corners", "threadMetadata", "stepDimensions", "stepHoles", "stepCorners", "documentsPreserved"].map(k => [k, true]));
  const run: Run = { id, instruction: "Build the sample plate", recipe: RECIPE, status: "succeeded", message: "Verified", startedAt: new Date().toISOString(), result: { checks, documentsPreserved: true, material: "6061 Alloy", elapsedSeconds: 1, files: ["plate.SLDPRT", "plate.STEP"].map(name => ({ name, bytes: 6, sha256: digest("sample") })) } };
  for (const file of run.result!.files) writeFileSync(path.join(output, id, file.name), "sample");
  writeFileSync(path.join(output, "native-attempt.lock"), JSON.stringify({ id }));
  writeFileSync(path.join(output, "attempts.jsonl"), JSON.stringify({ run }) + "\n");
  let now = 1_000;
  const handler = createPrivatePlateHttp({ origin, identity, artifactRoot: output, staticRoot: assets, capabilities: ["phone", "mac"], now: () => now });
  const server: Server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No server");
  cleanups.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
  const request = (route: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => new Promise<Response>((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${address.port}${route}`, { method: options.method, headers: { Host: new URL(origin).host, "Tailscale-User-Login": identity, ...options.headers } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve(new Response(text, { status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(",") : value ?? ""])) })));
    }); req.on("error", reject); req.end(options.body);
  });
  const pair = (capability = "phone", headers: Record<string, string> = {}) => request("/sample-plate/api/bootstrap", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify({ capability }) });
  return { request, pair, output, advance: (ms: number) => { now += ms; } };
}
describe("private retained sample ingress", () => {
  it("requires the exact proxy identity, host and origin before exposing UI or pairing", async () => {
    const f = await fixture();
    for (const headers of ([{ "Tailscale-User-Login": "foreign@example.test" }, { "Tailscale-User-Login": "" }, { Host: "evil.example" }, { Origin: "https://evil.example" }, { Forwarded: "host=evil.example" }, { "X-Forwarded-Host": new URL(origin).host }, { "X-Forwarded-Proto": "http" }, { "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[])) {
      expect((await f.request("/sample-plate/", { headers })).status).toBe(403);
    }
    expect((await f.pair("phone", { Origin: "https://evil.example" })).status).toBe(403);
    expect((await f.pair()).status).toBe(200);
  });
  it("pairs once, uses secure cookies, isolates sessions, expires access and denies every build", async () => {
    const f = await fixture();
    expect((await f.request("/api/session")).status).toBe(401);
    const paired = await f.pair(); const cookie = paired.headers.get("set-cookie")!;
    expect(cookie).toContain("Secure; HttpOnly; SameSite=Strict; Path=/");
    const headers = { Cookie: cookie.split(";")[0] };
    const { csrf } = await paired.json() as { csrf: string };
    expect((await f.pair()).status).toBe(401);
    expect((await f.pair("mac")).status).toBe(200);
    expect((await f.request("/api/session", { headers })).status).toBe(200);
    expect((await f.request("/api/session", { headers: { ...headers, "Tailscale-User-Login": "foreign@example.test" } })).status).toBe(403);
    for (const token of ["wrong", csrf]) expect((await f.request("/api/runs", { method: "POST", headers: { ...headers, Origin: origin, "Content-Type": "application/json", "X-Plate-CSRF": token }, body: "{}" })).status).toBe(403);
    const journal = readFileSync(path.join(f.output, "attempts.jsonl"), "utf8");
    expect(journal.trim().split("\n")).toHaveLength(1);
    f.advance(3_600_001); expect((await f.request("/api/session", { headers })).status).toBe(401);
  });
  it("serves only exact checked artifact bytes and a fixed static allowlist", async () => {
    const f = await fixture(); const paired = await f.pair();
    const headers = { Cookie: paired.headers.get("set-cookie")!.split(";")[0] };
    const url = `/sample-plate/api/files/${id}/plate.STEP`;
    expect((await f.request(url)).status).toBe(401);
    expect(await (await f.request(url, { headers })).text()).toBe("sample");
    expect((await f.request("/sample-plate/assets/sample-test.js")).status).toBe(200);
    for (const route of ["/@fs/private", "/src/main.tsx", "/assets/secret.map", "/api/files/other/plate.STEP", "/api/files/" + id + "/native-receipt.json"]) expect((await f.request(route, { headers })).status).toBe(404);
    writeFileSync(path.join(f.output, id, "plate.STEP"), "tamper");
    expect((await f.request(url, { headers })).status).toBe(409);
  });
  it("expires unused links without consuming valid newer sessions", async () => {
    const f = await fixture(); f.advance(600_001);
    expect((await f.pair()).status).toBe(401);
  });
});
