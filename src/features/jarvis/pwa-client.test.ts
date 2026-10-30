// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { loadJarvisPwaSession, readJarvisPwaSession } from "./pwa-client";

const TOKEN = "synthetic-jarvis-gate-token";

describe("Jarvis PWA client", () => {
  it("admits only an empty thread document", async () => {
    await expect(readJarvisPwaSession(Response.json({ thread: { state: "empty" } }))).resolves.toEqual({ kind: "admitted" });
  });

  it("treats extra fields, messages, and a forged 200 as absent", async () => {
    for (const body of [
      { thread: { state: "empty" }, messages: [{ text: "plate" }] },
      { thread: { state: "ready" } },
      { thread: { state: "empty", name: "PLATE R1" } },
      { error: "aal2_required" },
    ]) {
      await expect(readJarvisPwaSession(Response.json(body))).resolves.toEqual({ kind: "absent" });
    }
  });

  it("asks for step up only on the exact AAL2 code", async () => {
    await expect(readJarvisPwaSession(Response.json({ error: "aal2_required" }, { status: 403 }))).resolves.toEqual({ kind: "step_up" });
    await expect(readJarvisPwaSession(Response.json({ error: "aal2_required", thread: {} }, { status: 403 }))).resolves.toEqual({ kind: "absent" });
  });

  it("sends the bearer token and no client role", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(headers.get("x-jarvis-role")).toBeNull();
      expect(init?.method).toBe("GET");
      return new Response(null, { status: 401 });
    });
    await expect(loadJarvisPwaSession(TOKEN, fetchImpl)).resolves.toEqual({ kind: "signed_out" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/jarvis/session", expect.objectContaining({ cache: "no-store" }));
  });

  it("still calls the server when there is no token", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return new Response(null, { status: 401 });
    });
    await expect(loadJarvisPwaSession(null, fetchImpl)).resolves.toEqual({ kind: "signed_out" });
  });
});

describe("Jarvis PWA installable files", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../../public/jarvis/manifest.webmanifest", import.meta.url), "utf8")) as {
    name: string;
    short_name: string;
    start_url: string;
    scope: string;
    display: string;
    theme_color: string;
    background_color: string;
    icons: { src: string; sizes: string; type: string }[];
  };

  it("meets the manifest install criteria", () => {
    expect(manifest.name).toBe("Jarvis");
    expect(manifest.short_name).toBe("Jarvis");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/jarvis/");
    expect(manifest.scope).toBe("/");
    expect(manifest.theme_color).toBe("#0E0E10");
    expect(manifest.background_color).toBe("#0E0E10");
    expect(manifest.icons.map((icon) => icon.sizes).sort()).toEqual(["180x180", "192x192", "512x512"]);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      const bytes = readFileSync(new URL(`../../../public${icon.src}`, import.meta.url));
      expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
  });

  it("registers a fetch handler and does not cache API responses", () => {
    const worker = readFileSync(new URL("../../../public/jarvis-sw.js", import.meta.url), "utf8");
    expect(worker).toContain('addEventListener("fetch"');
    expect(worker).toContain('pathname.startsWith("/api/")');
    expect(worker).not.toContain("caches");
    expect(worker).not.toMatch(/respondWith/);
  });
});
