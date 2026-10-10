import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

// This suite is intentionally opt-in: ordinary verification keeps its original
// network behavior; source-only verification must use the preload and setup.
describe.skipIf(process.env.OVD_SOURCE_ONLY_TESTS !== "1")("source-only Vitest/jsdom realm", () => {
  const guard = process[Symbol.for("overdrafter.source-only-network")];
  const require = createRequire(import.meta.url);
  afterEach(() => vi.unstubAllGlobals());

  it("has the guard before the test module executes", () => {
    expect(guard).toBeDefined();
  });

  it("rejects native fetch in this realm", async () => {
    await guard.expectBlocked(() => expect(fetch("https://external.invalid/fixture")).rejects.toMatchObject({
      code: "ERR_SOURCE_ONLY_NETWORK",
    }));
  });

  it("rejects jsdom XHR and WebSocket constructors", () => {
    guard.expectBlocked(() => {
      expect(() => new XMLHttpRequest().open("GET", "https://external.invalid/fixture")).toThrow(/Source-only verification blocked/);
      expect(() => new WebSocket("wss://external.invalid/fixture")).toThrow(/Source-only verification blocked/);
    });
  });

  it("permits injected fetch mocks and restores the protected original", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("synthetic fixture")));
    expect(await (await fetch("https://external.invalid/fixture")).text()).toBe("synthetic fixture");
    vi.unstubAllGlobals();
    await guard.expectBlocked(() => expect(fetch("https://external.invalid/fixture")).rejects.toMatchObject({
      code: "ERR_SOURCE_ONLY_NETWORK",
    }));
  });

  it("retains the socket backstop when an injected mock calls a native transport", () => {
    const net = require("node:net");
    const lookup = vi.fn();
    guard.expectBlocked(() => {
      expect(() => net.connect({ host: "external.invalid", port: 443, lookup })).toThrow(/Source-only verification blocked/);
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});
