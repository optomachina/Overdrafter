// E. Security properties of the studio: what is injected where, headers, request guards, path traversal, the
// postMessage boundary between the sandboxed page and the shell, and what a generated asset can reach.
import { test, expect } from "../helpers/fixtures.mjs";
import { DESKTOP } from "../helpers/viewports.mjs";
import { rawRequest } from "../helpers/raw-http.mjs";
import { generateDemo } from "../helpers/jobs.mjs";
import { UI_CSP } from "../../server.mjs";
import { PREVIEW_CSP } from "../../lib/api.mjs";

test.use({ viewport: DESKTOP.viewport });

const get = (studio, path, headers = {}) => rawRequest(studio.url, { path, headers });

test.describe("preview responses", { tag: ["@security"] }, () => {
  test("the editor script is injected into baseline previews only, never into generated assets", async ({ sp, studio }) => {
    await sp.goto("/outline.html"); // any page load seeds the project
    const job = await generateDemo(sp, "hero", "security check");
    const baseline = await get(studio, "/api/preview/baseline/v9");
    expect(baseline.status).toBe(200);
    expect(baseline.text.match(/data-od-editor="1"/g)).toHaveLength(1);
    expect(baseline.text).toContain("__OD_PARENT_ORIGIN__");
    const optOut = await get(studio, "/api/preview/baseline/v9?editor=0");
    expect(optOut.status).toBe(200);
    expect(optOut.text).not.toContain("data-od-editor");
    expect(optOut.text).not.toContain("__OD_PARENT_ORIGIN__");
    for (const query of ["", "?editor=1", "?theme=dark&editor=1"]) {
      const asset = await get(studio, `/api/preview/asset/${job.resultVersionId}${query}`);
      expect(asset.status, `asset${query}`).toBe(200);
      expect(asset.text, `asset${query}`).not.toContain("data-od-editor");
      expect(asset.text, `asset${query}`).not.toContain("__OD_PARENT_ORIGIN__");
      expect(asset.text, `asset${query}`).not.toContain("od-studio-hint-dismissed");
    }
  });

  test("the editor does nothing when a preview is opened as a top-level page", async ({ sp, page, studio }) => {
    await sp.goto("/outline.html");
    await page.goto(`${studio.url}/api/preview/baseline/v9`);
    await expect(page.locator("h1")).toBeVisible();
    expect(await page.locator("[data-od-ui]").count()).toBe(0);
    expect(await page.locator("[data-od-editor-style]").count()).toBe(0);
  });

  test("previews carry the strict CSP and hardening headers; the studio UI carries its own CSP", async ({ sp, studio }) => {
    await sp.goto("/outline.html");
    const job = await generateDemo(sp, "hero", "csp check");
    for (const path of ["/api/preview/baseline/v9", "/api/preview/baseline/v9?editor=0", `/api/preview/asset/${job.resultVersionId}`]) {
      const res = await get(studio, path);
      expect(res.headers["content-security-policy"], path).toBe(PREVIEW_CSP);
      expect(res.headers["content-security-policy"], path).toMatch(/default-src 'none'.*sandbox allow-scripts.*frame-ancestors 'self'/);
      expect(res.headers["content-security-policy"], path).not.toMatch(/allow-same-origin|connect-src|unsafe-eval/);
      expect(res.headers["x-content-type-options"], path).toBe("nosniff");
      expect(res.headers["referrer-policy"], path).toBe("no-referrer");
      expect(res.headers["cache-control"], path).toBe("no-store");
    }
    for (const path of ["/", "/outline.html", "/page.js", "/core.js"]) {
      const res = await get(studio, path);
      expect(res.status, path).toBe(200);
      expect(res.headers["content-security-policy"], path).toBe(UI_CSP);
      expect(res.headers["content-security-policy"], path).toMatch(/frame-ancestors 'none'/);
      expect(res.headers["x-content-type-options"], path).toBe("nosniff");
    }
  });
});

test.describe("request guards", { tag: ["@security"] }, () => {
  const body = JSON.stringify({ text: "Guard test headline" });
  const post = (studio, headers, data = body, path = "/api/copy/ch3-headline/save") => rawRequest(studio.url, { method: "POST", path, headers: { "content-length": Buffer.byteLength(data), ...headers }, body: data });

  test("cross-origin and cross-site POSTs are 403 and change nothing", async ({ sp, studio }) => {
    await sp.goto("/outline.html");
    const before = await sp.versionCount("ch3-headline");
    const json = { "content-type": "application/json" };
    expect((await post(studio, { ...json, origin: "http://evil.example" })).status).toBe(403);
    expect((await post(studio, { ...json, origin: "http://localhost:1" })).status).toBe(403); // same host name, wrong port is a different origin
    expect((await post(studio, { ...json, origin: "null" })).status).toBe(403); // sandboxed pages send Origin: null
    expect((await post(studio, { ...json, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post(studio, { ...json, "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await rawRequest(studio.url, { path: "/api/project", headers: { origin: "http://evil.example" } })).status).toBe(403);
    expect(await sp.versionCount("ch3-headline")).toBe(before);
    // Control: the same request from the studio's own origin goes through.
    expect((await post(studio, { ...json, origin: studio.url, "sec-fetch-site": "same-origin" })).status).toBe(200);
    expect(await sp.versionCount("ch3-headline")).toBe(before + 1);
  });

  test("non-JSON POSTs are 415", async ({ sp, studio }) => {
    await sp.goto("/outline.html");
    const before = await sp.versionCount("ch3-headline");
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/html"]) {
      expect((await post(studio, { "content-type": type })).status, type).toBe(415);
    }
    expect((await post(studio, {})).status, "no content type").toBe(415);
    expect(await sp.versionCount("ch3-headline")).toBe(before);
  });

  test("a request whose Host is not loopback is refused (DNS rebinding)", async ({ sp, studio }) => {
    await sp.goto("/outline.html");
    for (const host of ["evil.example", "127.0.0.1.evil.example", "169.254.169.254"]) {
      const res = await rawRequest(studio.url, { path: "/api/project", headers: { host } });
      expect(res.status, host).toBe(403);
      expect(res.text).not.toContain("hero-headline");
      const ui = await rawRequest(studio.url, { path: "/", headers: { host } });
      expect(ui.status, `UI via ${host}`).toBe(403);
    }
  });

  test("bodies over 1 MB are 413, non-object JSON is 400, and the server stays up", async ({ sp, studio }) => {
    await sp.goto("/outline.html");
    const big = JSON.stringify({ text: "x".repeat(1_100_000) });
    const json = { "content-type": "application/json" };
    expect((await post(studio, json, big)).status).toBe(413);
    expect((await post(studio, json, "[1,2,3]")).status).toBe(400);
    expect((await post(studio, json, "not json")).status).toBe(400);
    expect((await post(studio, json, JSON.stringify({ text: "y".repeat(6000) }))).status).toBe(400); // over the 5000 character field limit
    expect((await get(studio, "/api/me")).status).toBe(200);
  });
});

test.describe("path traversal", { tag: ["@security"] }, () => {
  const PATHS = [
    "/api/preview/baseline/..%2f..%2f..%2fetc%2fpasswd",
    "/api/preview/baseline/../../../../etc/passwd",
    "/api/preview/baseline/%2e%2e",
    "/api/preview/baseline/V9", // ids are lowercase
    "/api/preview/baseline/v9%00",
    "/api/preview/baseline/v9.html",
    "/api/preview/asset/..%2f..%2fproject",
    "/api/preview/asset/../../project.json",
    "/api/preview/asset/%2e%2e%2f%2e%2e%2fproject.json",
    "/api/preview/asset/versions%2fhero%2fx%2findex.html",
    "/api/log/..%2f..%2fproject.json",
    "/api/log/../../project.json",
    "/api/jobs/..%2f..%2fproject",
    "/api/jobs/../../project",
    "/api/copy/..%2f..%2fx/save",
    "/api/shared/..%2fapi.mjs",
    "/api/shared/lint.mjs%00.png",
    "/api/shared/../server.mjs",
    "/..%2f..%2fpackage.json",
    "/%2e%2e/%2e%2e/package.json",
    "/../../package.json",
    "/ui/../server.mjs",
    "/studio.css/../../server.mjs",
    "//etc/passwd",
    "/data/seed.json",
    "/studio.config.json",
  ];
  test("every traversal attempt is a 4xx and never leaks a file", async ({ sp, studio }) => {
    await sp.goto("/outline.html");
    for (const p of PATHS) {
      const res = await rawRequest(studio.url, { path: p });
      expect(res.status, p).toBeGreaterThanOrEqual(400);
      expect(res.status, p).toBeLessThan(500);
      expect(res.text, p).not.toMatch(/root:.*:0:0|"name": "vite_react|import http from/);
    }
    for (const p of ["/api/copy/..%2f..%2fx/save", "/api/asset/..%2fx/restore", "/api/copy/hero-eyebrow/restore", "/api/jobs/..%2fx/cancel"]) {
      const res = await rawRequest(studio.url, { method: "POST", path: p, headers: { "content-type": "application/json", "content-length": 2 }, body: "{}" });
      expect(res.status, `POST ${p}`).toBeGreaterThanOrEqual(400);
      expect(res.status, `POST ${p}`).toBeLessThan(500);
    }
  });

  test("version ids with traversal characters are rejected in a request body too", async ({ sp }) => {
    await sp.goto("/outline.html");
    for (const versionId of ["../../x", "..%2f", "a/b", "A", "x".repeat(200)]) {
      const res = await sp.post("/api/copy/ch3-headline/restore", { versionId });
      expect(res.status(), versionId).toBeGreaterThanOrEqual(400);
      expect(res.status(), versionId).toBeLessThan(500);
    }
  });
});

test.describe("the sandboxed page cannot forge its way into the studio", { tag: ["@security"] }, () => {
  async function snapshot(sp) {
    return JSON.stringify((await sp.project()).project);
  }
  async function forge(sp, messages) {
    // Runs INSIDE the sandboxed page frame, so event.source is the real iframe and event.origin is "null".
    await sp.frame.locator("body").evaluate((_, list) => {
      for (const m of list) window.parent.postMessage(m, "*");
    }, messages);
  }

  test("malformed, oversized, wrong-type and unknown-id messages change nothing and break nothing", async ({ sp, page, guard }) => {
    guard.expectHttp(404);
    await sp.open();
    const before = await snapshot(sp);
    const longText = "A".repeat(6000);
    await forge(sp, [
      { foo: "bar" }, // wrong shape
      "a string", 42, null, [1, 2], // not objects
      { v: 2, type: "ready" }, // wrong protocol version
      { v: 1, type: "drop-database" }, // wrong type
      { v: 1, type: "ready", extra: "field" }, // unexpected key
      JSON.parse('{"__proto__":{"polluted":true},"v":1,"type":"ready"}'), // prototype tricks
      { v: 1, type: "lint-request", reqId: "r1", fieldId: "hero-eyebrow", text: longText }, // oversized text
      { v: 1, type: "edit-save", reqId: "r2", fieldId: "hero-eyebrow", text: longText, overrideWarnings: false },
      { v: 1, type: "edit-save", reqId: "r3", fieldId: "../../etc/passwd", text: "x", overrideWarnings: false }, // bad id shape
      { v: 1, type: "edit-save", reqId: "r4 with spaces", fieldId: "hero-eyebrow", text: "x", overrideWarnings: false }, // bad request id
      { v: 1, type: "edit-save", reqId: "r5", fieldId: "hero-eyebrow", text: 123, overrideWarnings: false }, // wrong field type
      { v: 1, type: "open-asset-history", sectionId: "no-such-section" }, // unknown ids are ignored
      { v: 1, type: "open-copy-history", fieldId: "no-such-field" },
      { v: 1, type: "open-generate", kind: "copy", fieldId: "no-such-field" },
      { v: 1, type: "asset-html-request", sectionId: "hero", versionId: "no-such-version" },
      { v: 1, type: "theme-changed", theme: "javascript:alert(1)" },
      { v: 1, type: "edit-save", reqId: "r6", fieldId: "no-such-field", text: "hello", overrideWarnings: false }, // well formed but unknown field: refused by the API (404)
    ]);
    // Positive control: a VALID message from the same place is processed, so the forged ones were really delivered and then refused.
    await forge(sp, [{ v: 1, type: "open-copy-history", fieldId: "hero-eyebrow" }]);
    await expect(page.locator("#sheetTitle")).toContainText("Copy: Eyebrow");
    expect(await snapshot(sp)).toBe(before);
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toMatch(/^(dark|light)$/);
    // The studio is still fully functional afterwards.
    await sp.closeSheet();
    await sp.editField("hero-eyebrow", "Still working after forged messages");
    await sp.saveAndWait();
    expect(await sp.versionCount("hero-eyebrow")).toBe(2);
  });

  test("a window that is not the page iframe cannot talk to the shell", async ({ sp, page }) => {
    await sp.open();
    const before = await snapshot(sp);
    // Messages from the shell's own window (event.source === window, origin = studio origin) are not the iframe's.
    await page.evaluate(() => {
      window.postMessage({ v: 1, type: "open-copy-history", fieldId: "hero-eyebrow" }, "*");
      window.postMessage({ v: 1, type: "edit-save", reqId: "s1", fieldId: "hero-eyebrow", text: "from the shell window", overrideWarnings: false }, "*");
    });
    // A second sandboxed copy of the page (also origin "null", so it passes the origin check) in a different iframe element.
    await page.evaluate(() => new Promise((resolve) => {
      const f = document.createElement("iframe");
      f.id = "rogue";
      f.setAttribute("sandbox", "allow-scripts");
      f.onload = () => resolve();
      f.src = "/api/preview/baseline/v9?editor=0";
      document.body.append(f);
    }));
    const rogue = page.frames().find((f) => f.url().includes("editor=0"));
    expect(rogue, "rogue frame").toBeTruthy();
    await rogue.evaluate(() => {
      window.parent.postMessage({ v: 1, type: "edit-save", reqId: "s2", fieldId: "hero-eyebrow", text: "from a rogue sibling frame", overrideWarnings: false }, "*");
      window.parent.postMessage({ v: 1, type: "open-copy-history", fieldId: "hero-eyebrow" }, "*");
    });
    await page.waitForFunction(() => document.getElementById("sheet").hidden === true); // nothing opened for the rogue frame
    // Control message from the real page frame still works afterwards.
    await sp.frame.locator("body").evaluate(() => window.parent.postMessage({ v: 1, type: "open-copy-history", fieldId: "hero-eyebrow" }, "*"));
    await expect(page.locator("#sheetTitle")).toContainText("Copy: Eyebrow");
    expect(await snapshot(sp)).toBe(before);
  });

  test("a generated asset frame cannot reach the studio: no cookies, storage, parent DOM, network, or messages to the shell", async ({ sp, page, guard, studio }) => {
    guard.allowConsole(/Refused to (connect|load|frame)/, /Blocked a frame/, /Failed to fetch/, /violates the following Content Security Policy/);
    await sp.goto("/outline.html");
    await generateDemo(sp, "hero", "isolation check");
    await sp.open();
    const gen = sp.frame.locator('iframe[title="Generated figure, Hero"]');
    await expect(gen).toBeVisible();
    const frame = await (await gen.elementHandle()).contentFrame();
    const before = await snapshot(sp);
    // One probe per evaluate call (the frame's CSP forbids eval, so the probes are a switch rather than generated code).
    const tryProbe = (name) => frame.evaluate(async ({ name, apiUrl }) => {
      try {
        switch (name) {
          case "origin": return { ok: true, value: window.origin };
          case "cookie": return { ok: true, value: document.cookie };
          case "localStorage": return { ok: true, value: localStorage.length };
          case "sessionStorage": return { ok: true, value: sessionStorage.length };
          case "indexedDB": return { ok: true, value: indexedDB.open("x").readyState };
          case "fetchRelative": return { ok: true, value: (await fetch("/api/project")).status };
          case "fetchAbsolute": return { ok: true, value: (await fetch(`${apiUrl}/api/project`)).status };
          case "xhr": return { ok: true, value: await new Promise((resolve, reject) => {
            const x = new XMLHttpRequest();
            x.open("GET", `${apiUrl}/api/project`);
            x.onload = () => resolve(x.status);
            x.onerror = () => reject(new Error("blocked"));
            x.send();
          }) };
          case "topDocument": return { ok: true, value: window.top.document.title };
          case "parentDocument": return { ok: true, value: window.parent.document.title };
          case "topCookie": return { ok: true, value: window.top.document.cookie };
          default: return { ok: false, name: "unknown probe" };
        }
      } catch (e) {
        return { ok: false, name: e && e.name };
      }
    }, { name, apiUrl: studio.url });
    const probe = {};
    for (const name of ["origin", "cookie", "localStorage", "sessionStorage", "indexedDB", "fetchRelative", "fetchAbsolute", "xhr", "topDocument", "parentDocument", "topCookie"]) probe[name] = await tryProbe(name);
    probe.origin = probe.origin.value;
    expect(probe.origin, "document origin (not URL origin)").toBe("null");
    expect(probe.cookie.ok).toBe(false);
    expect(probe.localStorage.ok).toBe(false);
    expect(probe.sessionStorage.ok).toBe(false);
    expect(probe.indexedDB.ok).toBe(false);
    expect(probe.fetchRelative.ok).toBe(false);
    expect(probe.fetchAbsolute.ok).toBe(false);
    expect(probe.xhr.ok).toBe(false);
    expect(probe.topDocument.ok).toBe(false);
    expect(probe.parentDocument.ok).toBe(false);
    expect(probe.topCookie.ok).toBe(false);
    // It may try to message the shell (top) or the page (parent): neither acts on it.
    await frame.evaluate(() => {
      const m = { v: 1, type: "edit-save", reqId: "g1", fieldId: "hero-eyebrow", text: "from a generated asset", overrideWarnings: false };
      window.top.postMessage(m, "*");
      window.parent.postMessage(m, "*");
      window.parent.postMessage({ v: 1, type: "init", fields: [], values: {}, theme: "dark", editMode: true, hintDismissed: true, assets: {} }, "*");
    });
    await sp.frame.locator("body").evaluate(() => window.parent.postMessage({ v: 1, type: "open-copy-history", fieldId: "hero-eyebrow" }, "*"));
    await expect(page.locator("#sheetTitle")).toContainText("Copy: Eyebrow");
    expect(await snapshot(sp)).toBe(before);
    // The beacon the asset tried to send was blocked by the CSP: no request reached the studio.
    expect(guard.requests.filter((r) => r.includes("/api/logout"))).toEqual([]);
  });

  test("the baseline page frame itself has no network, no storage and no parent access either", async ({ sp, guard }) => {
    guard.allowConsole(/Refused to (connect|load|frame)/, /violates the following Content Security Policy/);
    await sp.open();
    const probe = await sp.frame.locator("body").evaluate(async () => {
      const attempt = async (fn) => {
        try {
          await fn();
          return true;
        } catch {
          return false;
        }
      };
      return {
        origin: window.origin,
        fetch: await attempt(() => fetch("/api/project")),
        cookie: await attempt(() => document.cookie),
        storage: await attempt(() => localStorage.length),
        parentDoc: await attempt(() => window.parent.document.title),
      };
    });
    expect(probe).toEqual({ origin: "null", fetch: false, cookie: false, storage: false, parentDoc: false });
  });
});

test.describe("every spec stays on 127.0.0.1", { tag: ["@security"] }, () => {
  test("a full Page mode session makes requests to no other host", async ({ sp, guard }) => {
    await sp.open();
    await sp.editField("hero-eyebrow", "Loopback only");
    await sp.saveAndWait();
    await sp.goto("/outline.html");
    expect(guard.requests.length).toBeGreaterThan(10);
    expect([...new Set(guard.requests.map((r) => new URL(r.split(" ")[1]).hostname))]).toEqual(["127.0.0.1"]);
    expect(guard.offHost).toEqual([]);
  });
});
