import test from "node:test";
import assert from "node:assert/strict";
import { matchFields, normalizeText } from "../lib/field-match.mjs";
import { validatePageMessage, validateParentMessage, isTrustedMessage, makeMessage, planCopyApply, cleanEditedText } from "../lib/page-protocol.mjs";
import { handleLintRequest, saveResultMessage, fieldsForPage } from "../lib/page-parent.mjs";
import { buildEditorScript, editorSource } from "../lib/editor-inject.mjs";
import { PREVIEW_CSP } from "../lib/api.mjs";
import { localApp, call, freshProject } from "./helpers.mjs";

const F = (id, sectionId, text, extra = {}) => ({ id, sectionId, text, ...extra });
const C = (elementKey, text, order, sectionId) => ({ elementKey, text, order, ...(sectionId ? { sectionId } : {}) });

test("matcher: exact, case and typography differences", () => {
  const r = matchFields([F("a", "hero", "Today it reads your drawing."), F("b", "hero", "Don't stop")], [C("e1", "TODAY  IT READS\nYOUR DRAWING.", 0), C("e2", "Don’t stop", 1)]);
  assert.deepEqual(r.mapping, { a: "e1", b: "e2" });
  assert.deepEqual(r.unmatched, []);
  assert.equal(normalizeText("“Hi” — ok"), '"hi" - ok');
});

test("matcher: duplicates across sections resolve by section, then by document order", () => {
  const fields = [F("hero-cta", "hero", "Create account"), F("final-cta", "final", "Create account")];
  const bySection = matchFields(fields, [C("hdr", "Create account", 0, "header"), C("h", "Create account", 1, "hero"), C("f", "Create account", 2, "final")]);
  assert.deepEqual(bySection.mapping, { "hero-cta": "h", "final-cta": "f" });
  const byOrder = matchFields([F("b1", "ch1", "You bring"), F("b2", "ch2", "You bring")], [C("x", "You bring", 5), C("y", "You bring", 9)]);
  assert.deepEqual(byOrder.mapping, { b1: "x", b2: "y" });
});

test("matcher: multiline lockup, loose punctuation, alternates and unmatched report", () => {
  const r = matchFields(
    [F("lock", "hero", "OverDrafter\nYour agent for\nBuilding hardware"), F("loose", "hero", "Roadmap · intentions, not commitments"), F("moved", "hero", "Old words", { alts: ["Newer words"] }), F("gone", "hero", "Not on the page")],
    [C("h1", "OverDrafter Your agent for Building hardware", 0), C("p", "Roadmap intentions not commitments", 1), C("q", "Newer words", 2)],
  );
  assert.equal(r.mapping.lock, "h1");
  assert.equal(r.mapping.loose, "p");
  assert.equal(r.how.loose, "loose");
  assert.equal(r.mapping.moved, "q");
  assert.equal(r.how.moved, "alt");
  assert.deepEqual(r.unmatched, ["gone"]);
});

test("matcher: every seed field is found in the real v9 page text", async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("../../../public/v9/index.html", import.meta.url), "utf8");
  const project = freshProject();
  const norm = normalizeText(html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&"));
  const missing = Object.values(project.fields).filter((f) => !norm.includes(normalizeText(f.versions[0].text.split("\n")[0])));
  assert.deepEqual(missing.map((f) => f.id), []);
});

test("protocol: accepts valid messages in both directions", () => {
  assert.ok(validatePageMessage(makeMessage("edit-save", { reqId: "r1", fieldId: "hero-lede", text: "Hi", overrideWarnings: false })).ok);
  assert.ok(validatePageMessage(makeMessage("open-generate", { kind: "asset", sectionId: "ch3" })).ok);
  assert.ok(validatePageMessage(makeMessage("ready")).ok);
  assert.ok(validateParentMessage(makeMessage("apply-copy", { values: { "hero-lede": "x" } })).ok);
  assert.ok(validateParentMessage(makeMessage("asset-state", { assets: { hero: { count: 1, versionId: "abc" }, ch1: { count: 0, versionId: null } } })).ok);
});

test("protocol: rejects forged, unknown, mis-shaped and over-long messages", () => {
  const bad = [
    null, "ready", [], { type: "ready" }, { v: 2, type: "ready" }, makeMessage("nope"), makeMessage("ready", { extra: 1 }),
    makeMessage("edit-save", { reqId: "r1", fieldId: "../x", text: "t", overrideWarnings: false }),
    makeMessage("edit-save", { reqId: "r1", fieldId: "hero-lede", text: 5, overrideWarnings: false }),
    makeMessage("edit-save", { reqId: "r1", fieldId: "hero-lede", text: "x".repeat(5001), overrideWarnings: false }),
    makeMessage("edit-save", { reqId: "r1", fieldId: "hero-lede", text: "t" }),
    makeMessage("open-generate", { kind: "asset" }),
    makeMessage("open-generate", { kind: "copy", sectionId: "hero" }),
    makeMessage("open-asset-history", { sectionId: "A B" }),
    Object.create({ type: "ready", v: 1 }),
  ];
  for (const m of bad) assert.equal(validatePageMessage(m).ok, false, JSON.stringify(m));
  // A page-direction message is not valid in the parent-direction table and vice versa.
  assert.equal(validateParentMessage(makeMessage("edit-save", { reqId: "r", fieldId: "a", text: "t", overrideWarnings: false })).ok, false);
  assert.equal(validatePageMessage(makeMessage("apply-copy", { values: {} })).ok, false);
  assert.equal(validateParentMessage(makeMessage("apply-copy", { values: { "bad key": "x" } })).ok, false);
});

test("protocol: sender must be the expected window and origin", () => {
  const win = {};
  assert.equal(isTrustedMessage({ source: win, origin: "null" }, win, "null"), true);
  assert.equal(isTrustedMessage({ source: {}, origin: "null" }, win, "null"), false);
  assert.equal(isTrustedMessage({ source: win, origin: "https://evil.example" }, win, "null"), false);
  assert.equal(isTrustedMessage({ source: win, origin: "http://127.0.0.1:5177" }, win, "http://127.0.0.1:5177"), true);
  assert.equal(isTrustedMessage({ source: win, origin: "null" }, null, "null"), false);
});

test("apply-copy planner: only changed, mapped, not-being-edited fields", () => {
  const plan = planCopyApply({
    values: { a: "new", b: "same", c: "x", d: "editing text" },
    mapping: { a: "e1", b: "e2", d: "e4" },
    applied: { a: "old", b: "same" },
    editingFieldId: "d",
  });
  assert.deepEqual(plan.ops, [{ fieldId: "a", elementKey: "e1", text: "new" }]);
  assert.deepEqual(plan.unmapped, ["c"]);
  assert.equal(cleanEditedText("  a b \n c ", false), "a b c");
  assert.equal(cleanEditedText("one \n\n\n\n two", true), "one\n\ntwo");
});

test("lint-request handling uses the real copy lint and answers every request", () => {
  const project = freshProject();
  const ok = handleLintRequest(project, { reqId: "r1", fieldId: "hero-lede", text: "Reads your drawing." });
  assert.deepEqual([ok.type, ok.errors.length], ["lint-result", 0]);
  const bad = handleLintRequest(project, { reqId: "r2", fieldId: "hero-lede", text: "Works with SolidWorks since 2027." });
  assert.ok(bad.errors.some((e) => /SolidWorks/.test(e)) && bad.errors.some((e) => /2027/.test(e)));
  const live = handleLintRequest(project, { reqId: "r3", fieldId: "hero-lede", text: "Live" });
  assert.ok(live.errors.some((e) => /Live in Founding Beta/.test(e)));
  assert.ok(handleLintRequest(project, { reqId: "r4", fieldId: "nope", text: "x" }).errors.length > 0);
  assert.ok(handleLintRequest(project, { reqId: "r5", fieldId: "hero-lede", text: "  " }).errors.length > 0);
  assert.ok(validateParentMessage(bad).ok);
  const warn = saveResultMessage("r6", { ok: false, status: 409, data: { needsConfirm: true, lint: { warnings: [{ message: "w" }] } } });
  assert.equal(warn.needsConfirm, true);
  assert.ok(validateParentMessage(warn).ok);
  // A 409 that is a real failed write (conflict_exhausted) is a plain failure message, not a lint outcome.
  const exhausted = saveResultMessage("r7", { ok: false, status: 409, data: { error: "conflict_exhausted", message: "Could not save after 3 retries: the data repo kept changing. Try again." } });
  assert.equal(exhausted.ok, false);
  assert.ok(!exhausted.needsConfirm && !exhausted.warnings && !exhausted.errors);
  assert.match(exhausted.message, /Could not save after 3 retries/);
  assert.ok(validateParentMessage(exhausted).ok);
  assert.equal(fieldsForPage(project).length, 52);
  assert.ok(validateParentMessage(makeMessage("init", { fields: fieldsForPage(project), values: {}, theme: "dark", editMode: true, hintDismissed: false, assets: {} })).ok);
});

test("editor script builds, parses, has no script-terminating text and carries the one parent origin", () => {
  assert.ok(!/<\/script/i.test(editorSource()));
  const src = buildEditorScript("http://127.0.0.1:5177");
  assert.doesNotThrow(() => new Function(src));
  assert.match(src, /__OD_PARENT_ORIGIN__="http:\/\/127\.0\.0\.1:5177"/);
  assert.ok(!/^\s*(import|export)\s/m.test(src));
});

test("serving rule: editor only in baseline previews, never in asset previews; CSP present", async () => {
  const { app } = localApp();
  const base = await call(app.api, "GET", "/api/preview/baseline/v9?theme=dark");
  assert.equal(base.status, 200);
  assert.match(base.text, /data-od-editor="1"/);
  assert.match(base.text, /__OD_PARENT_ORIGIN__="http:\/\/127\.0\.0\.1:5177"/);
  assert.equal(base.headers.get("content-security-policy"), PREVIEW_CSP);
  assert.match(PREVIEW_CSP, /sandbox allow-scripts/);
  assert.doesNotMatch(PREVIEW_CSP, /allow-same-origin/);
  const optOut = await call(app.api, "GET", "/api/preview/baseline/v9?editor=0");
  assert.doesNotMatch(optOut.text, /data-od-editor/);
  // A generated asset (demo engine) is never instrumented, even when asked.
  const gen = await call(app.api, "POST", "/api/generate", { kind: "asset", sectionId: "hero", prompt: "x", tool: "hand-built", engine: "template-demo" });
  assert.ok(gen.status < 300, gen.text);
  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const p = await call(app.api, "GET", "/api/project");
    version = p.json.project.assets["asset-hero"].versions.find((v) => v.assetPath);
  }
  assert.ok(version);
  const asset = await call(app.api, "GET", `/api/preview/asset/${version.id}?editor=1`);
  assert.equal(asset.status, 200);
  assert.doesNotMatch(asset.text, /data-od-editor|__OD_PARENT_ORIGIN__/);
  assert.equal(asset.headers.get("content-security-policy"), PREVIEW_CSP);
});

test("shared modules are served to the shell", async () => {
  const { app } = localApp();
  for (const n of ["field-match", "page-protocol", "page-parent", "lint", "diff"]) {
    const r = await call(app.api, "GET", `/api/shared/${n}.mjs`);
    assert.equal(r.status, 200, n);
  }
});
