// Guards a failure that only shows up on Vercel: a path ending in .mjs under /api is treated as a function file and
// answers 404 before the catch-all runs, so any browser import of /api/shared/<name>.mjs breaks the whole page.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../lib/app.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = path.join(root, "ui");

test("no UI file imports a /api/ path that ends in .mjs (Vercel answers 404 for those)", () => {
  const bad = [];
  for (const f of fs.readdirSync(uiDir).filter((n) => n.endsWith(".js") || n.endsWith(".html"))) {
    const text = fs.readFileSync(path.join(uiDir, f), "utf8");
    for (const m of text.matchAll(/["'`](\/api\/[^"'`\s]*\.mjs)["'`]/g)) bad.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

test("every shared module the UI imports is served extension-less as JavaScript with no relative .mjs imports left", async () => {
  const app = createApp({ env: {}, mode: "local", dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "hs-deploy-routing-")) });
  const wanted = new Set();
  for (const f of fs.readdirSync(uiDir).filter((n) => n.endsWith(".js"))) {
    for (const m of fs.readFileSync(path.join(uiDir, f), "utf8").matchAll(/from\s+"\/api\/shared\/([a-z-]+)"/g)) wanted.add(m[1]);
  }
  assert.ok(wanted.size >= 4, `expected the UI to import several shared modules, found ${[...wanted]}`);
  for (const name of wanted) {
    const res = await app.api.handle(new Request(`http://127.0.0.1:5177/api/shared/${name}`));
    assert.equal(res.status, 200, name);
    assert.match(res.headers.get("content-type"), /javascript/, name);
    const body = await res.text();
    assert.doesNotMatch(body, /from\s+"\.\/[a-z-]+\.mjs"/, `${name} still has a relative .mjs import`);
  }
});
