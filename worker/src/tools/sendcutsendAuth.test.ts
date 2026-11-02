// @vitest-environment node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSendCutSendCurrentUser } from "../adapters/sendcutsendPortal";
import { saveSendCutSendSession, SENDCUTSEND_SESSION_BOOTSTRAP } from "./sendcutsendAuth";

const tempDirs: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function outputPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sendcutsend-auth-"));
  tempDirs.push(dir);
  return path.join(dir, "sendcutsend-storage-state.json");
}

const signedIn = {
  cookies: [
    { name: "session", value: "v", domain: "app.sendcutsend.com", path: "/" },
    { name: "ga", value: "v", domain: ".google.com", path: "/" },
  ],
  origins: [{ origin: "https://app.sendcutsend.com", localStorage: [] }],
};

function page(signedIn: boolean, detail = signedIn ? "status 200" : "status 401") {
  return {
    goto: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => ({ signedIn, detail })) as unknown as <T>(fn: () => Promise<T>) => Promise<T>,
  };
}

/** A headed session plus the fresh verification context built from the filtered state. */
function session(options: { signedIn?: boolean; survivesFilter?: boolean; state?: unknown } = {}) {
  const verificationContexts: unknown[] = [];
  const close = vi.fn(async () => undefined);
  const context = {
    storageState: async () => options.state ?? signedIn,
    newPage: async () => page(options.signedIn ?? true),
    close,
  };
  const browser = {
    newContext: vi.fn(async (contextOptions: { storageState: never }) => {
      verificationContexts.push(contextOptions.storageState);
      return { storageState: async () => ({}), newPage: async () => page(options.survivesFilter ?? true), close };
    }),
  };
  return { session: { browser, context, page: page(options.signedIn ?? true) }, verificationContexts, close };
}

describe("SendCutSend session save", () => {
  it("opens the quote page for a manual sign-in", () => {
    expect(SENDCUTSEND_SESSION_BOOTSTRAP).toMatchObject({
      vendor: "sendcutsend",
      loginUrl: "https://app.sendcutsend.com/customer#/quote",
    });
  });

  it("saves only exact-host entries, privately, once the app reports a signed-in user", async () => {
    const target = await outputPath();
    const lines: string[] = [];
    const { session: headed, verificationContexts, close } = session();
    await saveSendCutSendSession(headed, target, (line) => lines.push(line));
    expect(verificationContexts).toEqual([{ cookies: [signedIn.cookies[0]], origins: signedIn.origins }]);
    expect(close).toHaveBeenCalledOnce();
    const saved = JSON.parse(await fs.readFile(target, "utf8"));
    expect(saved.cookies).toEqual([signedIn.cookies[0]]);
    expect(saved.origins).toEqual(signedIn.origins);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(lines.join("\n")).toContain("Dropped cookies for: google.com");
    expect(lines.join("\n")).not.toContain("v\"");
  });

  it("saves nothing when the app does not report a signed-in, non-guest user", async () => {
    const target = await outputPath();
    await expect(saveSendCutSendSession(session({ signedIn: false }).session, target, () => undefined))
      .rejects.toThrow(/did not report a signed-in user \(status 401\)/);
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("saves nothing when the session does not survive the exact-host filter", async () => {
    const target = await outputPath();
    const { session: headed, close } = session({ survivesFilter: false });
    await expect(saveSendCutSendSession(headed, target, () => undefined))
      .rejects.toThrow(/does not survive the exact-host filter \(status 401; dropped cookies for: google\.com\)/);
    expect(close).toHaveBeenCalledOnce();
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("treats a stalled session check as not signed in and still closes the verification context", async () => {
    const target = await outputPath();
    const stalled = { goto: vi.fn(async () => undefined), evaluate: vi.fn(() => new Promise<never>(() => undefined)) };
    const { session: headed, close } = session();
    const startedAt = Date.now();
    await expect(saveSendCutSendSession({ ...headed, page: stalled as never }, target, () => undefined, 30))
      .rejects.toThrow(/did not report a signed-in user \(timed out\)/);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await expect(fs.stat(target)).rejects.toThrow();

    headed.browser.newContext.mockResolvedValueOnce({ storageState: async () => ({}), newPage: async () => stalled as never, close });
    await expect(saveSendCutSendSession(headed, target, () => undefined, 30))
      .rejects.toThrow(/does not survive the exact-host filter/);
    expect(close).toHaveBeenCalledOnce();
  });

  it("saves nothing without an app cookie", async () => {
    const target = await outputPath();
    await expect(saveSendCutSendSession(
      session({ state: { cookies: [signedIn.cookies[1]], origins: [] } }).session, target, () => undefined,
    )).rejects.toThrow(/No SendCutSend app cookie/);
    await expect(fs.stat(target)).rejects.toThrow();
  });
});

/** Stubs the page globals the in-page evaluator reads; `respond` answers the /users/current fetch. */
function stubPage(respond: () => Promise<Response>) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => respond());
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("document", { querySelector: () => ({ content: "csrf-token-value" }) });
  vi.stubGlobal("window", { appData: { clientGuid: "client-guid" } });
  return fetch;
}

const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

/** A page whose evaluate runs the function it is given, as Playwright does in the browser. */
function evaluatingPage() {
  return {
    goto: vi.fn(async () => undefined),
    evaluate: (async (fn: () => Promise<unknown>) => fn()) as <T>(fn: () => Promise<T>) => Promise<T>,
  };
}

describe("SendCutSend current-user check (the real in-page evaluator)", () => {
  it("confirms only an id with an explicit guest: false, sending the app's own headers", async () => {
    const fetch = stubPage(json({ id: 42, guest: false, email: "operator@example.com" }));
    await expect(checkSendCutSendCurrentUser()).resolves.toEqual({ signedIn: true, detail: "status 200" });
    expect(fetch).toHaveBeenCalledWith("https://app.sendcutsend.com/users/current", expect.objectContaining({
      method: "GET", mode: "same-origin", redirect: "error",
      credentials: "same-origin",
      headers: expect.objectContaining({ "X-CSRF-Token": "csrf-token-value", "X-Client-Guid": "client-guid" }),
    }));
  });

  it.each([
    ["no guest flag", json({ id: 1 }), "status 200 without a guest flag"],
    ["a null guest flag", json({ id: 1, guest: null }), "status 200 without a guest flag"],
    ["a non-boolean guest flag", json({ id: 1, guest: 0 }), "status 200 without a guest flag"],
    ["a guest user", json({ id: 1, guest: true }), "guest user"],
    ["no id", json({ guest: false }), "status 200 without a user"],
    ["an empty id", json({ id: " ", guest: false }), "status 200 without a user"],
    ["a non-positive id", json({ id: 0, guest: false }), "status 200 without a user"],
    ["a null body", json(null), "status 200 without a user"],
    ["an array body", json([{ id: 1, guest: false }]), "status 200 without a user"],
    ["a malformed body", async () => new Response("<html>", { status: 200 }), "request failed"],
    ["an error status", json({ id: 1, guest: false }, 401), "status 401"],
    ["a server error", json({ error: "boom" }, 500), "status 500"],
    ["a network failure", async () => { throw new TypeError("network"); }, "request failed"],
  ])("does not confirm %s", async (_label, respond, detail) => {
    stubPage(respond as () => Promise<Response>);
    await expect(checkSendCutSendCurrentUser()).resolves.toEqual({ signedIn: false, detail });
  });

  it("saves nothing when the real evaluator sees a user without an explicit guest flag", async () => {
    stubPage(json({ id: 1 }));
    const target = await outputPath();
    const { session: headed } = session();
    await expect(saveSendCutSendSession({ ...headed, page: evaluatingPage() }, target, () => undefined))
      .rejects.toThrow(/did not report a signed-in user \(status 200 without a guest flag\)/);
    await expect(fs.stat(target)).rejects.toThrow();
  });

  it("saves through the real evaluator once it confirms a non-guest user in both contexts", async () => {
    stubPage(json({ id: 1, guest: false }));
    const target = await outputPath();
    const { session: headed } = session();
    headed.browser.newContext.mockResolvedValueOnce({
      storageState: async () => ({}), newPage: async () => evaluatingPage(), close: vi.fn(async () => undefined),
    });
    await saveSendCutSendSession({ ...headed, page: evaluatingPage() }, target, () => undefined);
    expect(JSON.parse(await fs.readFile(target, "utf8")).cookies).toEqual([signedIn.cookies[0]]);
  });

  it("does not trust a check result that is not an explicit true", async () => {
    const target = await outputPath();
    const { session: headed } = session();
    const truthy = { goto: vi.fn(async () => undefined), evaluate: vi.fn(async () => ({ signedIn: "yes" })) };
    await expect(saveSendCutSendSession({ ...headed, page: truthy as never }, target, () => undefined))
      .rejects.toThrow(/did not report a signed-in user \(malformed session check\)/);
  });
});
