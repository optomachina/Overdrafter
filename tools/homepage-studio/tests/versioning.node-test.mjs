import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { appendVersion, restoreVersion, addMark, starredIds, currentVersion, decorate } from "../lib/ops.mjs";
import { validateProject, assertAppendOnly, SchemaError, validateVersion, validateJob } from "../lib/schema.mjs";
import { seedProject } from "../lib/seed.mjs";
import { runSeed } from "../scripts/seed.mjs";
import { wordDiff } from "../lib/diff.mjs";
import { buildCopyJson, buildHandoffMarkdown } from "../lib/handoff.mjs";
import { newId } from "../lib/ids.mjs";
import { freshProject, seed, tmpDir, studioRoot } from "./helpers.mjs";

test("ids are ulid-like, sortable and match the id pattern", () => {
  const a = newId(1_000_000);
  const b = newId(2_000_000);
  assert.match(a, /^[a-z0-9]{20}$/);
  assert.ok(a < b);
});

test("seed project validates and every field has one seed version", () => {
  const p = freshProject();
  assert.deepEqual(validateProject(p), []);
  assert.equal(Object.keys(p.fields).length, seed.fields.length);
  for (const f of Object.values(p.fields)) assert.equal(f.versions.length, 1);
  assert.equal(Object.keys(p.assets).length, p.sections.length);
});

test("edit, restore and star only append; nothing is deleted or rewritten", () => {
  const before = freshProject();
  const p = structuredClone(before);
  const f = p.fields["hero-eyebrow"];
  const v1 = f.versions[0];
  const v2 = appendVersion(f, { kind: "manual", text: "Edited once", note: "n" });
  const v3 = appendVersion(f, { kind: "manual", text: "Edited twice" });
  assert.equal(v2.parentId, v1.id);
  assert.equal(v3.parentId, v2.id);
  const r = restoreVersion(f, v1.id, "copy", { note: "back" });
  assert.equal(r.kind, "restore");
  assert.equal(r.parentId, v1.id);
  assert.equal(r.text, v1.text);
  assert.equal(f.versions.length, 4);
  addMark(f, v2.id, true);
  addMark(f, v2.id, false);
  addMark(f, v1.id, true);
  assert.deepEqual([...starredIds(f)], [v1.id]);
  assert.equal(f.versions.length, 4, "starring adds no versions and removes none");
  assert.equal(currentVersion(f).id, r.id);
  assert.doesNotThrow(() => assertAppendOnly(before, p));
  assert.deepEqual(validateProject(p), []);
  assert.equal(decorate(f).versions.find((v) => v.id === v1.id).starred, true);
});

test("append-only guard rejects deletes and rewrites", () => {
  const before = freshProject();
  const rewritten = structuredClone(before);
  rewritten.fields["hero-eyebrow"].versions[0].text = "sneaky";
  assert.throws(() => assertAppendOnly(before, rewritten), SchemaError);
  const removed = structuredClone(before);
  delete removed.fields["hero-eyebrow"];
  assert.throws(() => assertAppendOnly(before, removed), /removed/);
  const shrunk = structuredClone(before);
  const f = before.fields["hero-lede"];
  const grown = structuredClone(before);
  appendVersion(grown.fields["hero-lede"], { kind: "manual", text: "x" });
  assert.throws(() => assertAppendOnly(grown, before), /shrank/);
  assert.ok(f && shrunk);
});

test("restore of a failed attempt and of an unknown version is refused", () => {
  const p = freshProject();
  const a = p.assets["asset-ch3"];
  const failed = appendVersion(a, { kind: "failed", assetPath: null, note: "x" });
  assert.equal(a.currentVersionId, null, "failed records never become current");
  assert.throws(() => restoreVersion(a, failed.id, "asset"), /failed attempt/);
  assert.throws(() => restoreVersion(a, "nope", "asset"), /not found/);
});

test("schema validation catches bad records", () => {
  const p = freshProject();
  const bad = structuredClone(p);
  bad.fields["hero-eyebrow"].versions[0].kind = "weird";
  assert.ok(validateProject(bad).some((e) => /bad kind/.test(e)));
  const bad2 = structuredClone(p);
  bad2.fields["hero-eyebrow"].currentVersionId = "missing";
  assert.ok(validateProject(bad2).some((e) => /currentVersionId/.test(e)));
  const bad3 = structuredClone(p);
  appendVersion(bad3.assets["asset-ch3"], { kind: "generated", assetPath: "../../etc/passwd" });
  assert.ok(validateProject(bad3).some((e) => /assetPath/.test(e)));
  assert.ok(validateVersion({ id: "A B" }, "copy").length > 0);
  assert.ok(validateJob({ id: "x", kind: "asset", sectionId: "ch1", state: "weird", prompt: "", engine: "e", tool: "t", createdAt: new Date().toISOString() }).some((e) => /state/.test(e)));
  assert.deepEqual(validateJob({ id: "x", kind: "asset", sectionId: "ch1", state: "blocked", prompt: "", engine: "e", tool: "t", createdAt: new Date().toISOString() }), []);
});

test("seeding is idempotent and never destroys versions", async () => {
  const dir = tmpDir();
  const first = await runSeed({ dataDir: dir, seedFile: path.join(studioRoot, "data/seed.json") });
  assert.equal(first.created, true);
  const file = path.join(dir, "project.json");
  const p1 = JSON.parse(fs.readFileSync(file, "utf8"));
  appendVersion(p1.fields["hero-lede"], { kind: "manual", text: "My edit" });
  fs.writeFileSync(file, JSON.stringify(p1));
  const second = await runSeed({ dataDir: dir, seedFile: path.join(studioRoot, "data/seed.json") });
  assert.equal(second.created, false);
  const p2 = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(p2, p1, "re-seeding leaves existing versions untouched");
  const again = seedProject(seed, p2);
  assert.deepEqual(again, p2);
});

test("word diff marks insertions and deletions", () => {
  const d = wordDiff("one two three", "one three four");
  const text = (t) => d.filter((x) => x.type === t).map((x) => x.value).join("");
  assert.match(text("del"), /two/);
  assert.match(text("ins"), /four/);
  assert.equal(wordDiff("same words", "same words").every((x) => x.type === "same"), true);
});

test("exports list current copy and asset version ids", () => {
  const p = freshProject();
  const v = appendVersion(p.fields["hero-lede"], { kind: "manual", text: "Brand new lede." });
  const j = buildCopyJson(p, new Date("2026-10-18T00:00:00Z"));
  assert.equal(j.sections[0].fields["hero-lede"].versionId, v.id);
  assert.equal(j.sections[0].fields["hero-lede"].text, "Brand new lede.");
  const md = buildHandoffMarkdown(p);
  assert.match(md, /Brand new lede\./);
  assert.match(md, new RegExp(v.id));
  assert.match(md, /Asset version: none/);
});
