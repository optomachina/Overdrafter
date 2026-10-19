import test from "node:test";
import assert from "node:assert/strict";
import { lintCopy, MISSION_EXACT, RULES } from "../lib/lint.mjs";
import { seed } from "./helpers.mjs";

const caps = seed.capabilities;
const ctx = { capabilities: caps };
const rules = (r) => r.errors.map((e) => e.rule);
const warns = (r) => r.warnings.map((e) => e.rule);

test("rules are data with unique ids", () => {
  assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length);
});

test("year and date: positive and negative", () => {
  assert.ok(rules(lintCopy("Ships in 2027.", ctx)).includes("year"));
  assert.ok(rules(lintCopy("Back in 2039", ctx)).includes("year"));
  assert.ok(!rules(lintCopy("Part 2040 and 1999 and 12026", ctx)).includes("year"));
});
test("quarters", () => {
  assert.ok(rules(lintCopy("Coming in Q3.", ctx)).includes("quarter"));
  assert.ok(!rules(lintCopy("Quote part abc123", ctx)).includes("quarter"));
});
test("timing words: next year, later, next", () => {
  assert.ok(rules(lintCopy("Available next year.", ctx)).includes("timing-word"));
  assert.ok(rules(lintCopy("We add that later.", ctx)).includes("timing-word"));
  assert.ok(rules(lintCopy("Next, we add CAD.", ctx)).includes("timing-word"));
  assert.ok(!rules(lintCopy("The bracket sits next to the plate.", ctx)).includes("timing-word"));
});
test("percentages only allowed in the mission sentence", () => {
  assert.ok(rules(lintCopy("Saves 30% on cost.", ctx)).includes("percent"));
  assert.ok(rules(lintCopy("Twenty percent faster, 20 percent", ctx)).includes("percent"));
  const mission = `Reduce the time to Mars ${MISSION_EXACT}.`;
  assert.ok(!rules(lintCopy(mission, ctx)).includes("percent"));
  assert.ok(rules(lintCopy(`${mission} Also 50% done.`, ctx)).includes("percent"));
  assert.ok(rules(lintCopy("Reduce the time to Mars by 12% through creative and efficient deployment of engineering resources.", ctx)).includes("percent"));
});
test("third-party brand names", () => {
  for (const t of ["Works with SolidWorks.", "Post to Slack.", "Like Cursor for hardware.", "In Teams or Meta apps", "Ask Xometry"]) {
    assert.ok(rules(lintCopy(t, ctx)).includes("brand"), t);
  }
  assert.ok(!rules(lintCopy("Works with your CAD seat and team chat apps.", ctx)).includes("brand"));
  assert.ok(!rules(lintCopy("our teams love metadata", ctx)).includes("brand"));
});
test("bare Live label", () => {
  assert.ok(rules(lintCopy("Live", ctx)).includes("bare-live"));
  assert.ok(rules(lintCopy("Live quotes today", ctx)).includes("bare-live"));
  assert.ok(!rules(lintCopy("Live in Founding Beta", ctx)).includes("bare-live"));
  assert.ok(!rules(lintCopy("Powered nodes are live in the invitation-only Founding Beta.", ctx)).includes("bare-live"));
});
test("Coming soon on a live capability", () => {
  assert.ok(rules(lintCopy("Coming soon: quotes in parallel.", ctx)).includes("coming-soon-on-live"));
  assert.ok(rules(lintCopy("Coming soon: the agent reads specs from drawings.", ctx)).includes("coming-soon-on-live"));
  assert.ok(rules(lintCopy("Coming soon", { ...ctx, fieldStatus: "live" })).includes("coming-soon-on-live"));
  assert.ok(!rules(lintCopy("Coming soon: describe a part and an agent drafts the model.", ctx)).includes("coming-soon-on-live"));
  assert.ok(!rules(lintCopy("Coming soon", { ...ctx, fieldStatus: "planned" })).includes("coming-soon-on-live"));
});
test("claiming a planned capability exists", () => {
  assert.ok(rules(lintCopy("OverDrafter runs CFD on your parts.", ctx)).includes("planned-claim"));
  assert.ok(rules(lintCopy("Use text to CAD today.", ctx)).includes("planned-claim"));
  assert.ok(rules(lintCopy("Open the marketplace now.", ctx)).includes("planned-claim"));
  assert.ok(!rules(lintCopy("Coming soon: CFD and DFM checks.", ctx)).includes("planned-claim"));
  assert.ok(!rules(lintCopy("Text to CAD is our goal, not a feature today.", ctx)).includes("planned-claim"));
  assert.ok(!rules(lintCopy("Create assembly instructions for assy abc123.", { ...ctx, plannedContext: true })).includes("planned-claim"));
  assert.ok(!rules(lintCopy("Quotes parts, compares price and lead time.", ctx)).includes("planned-claim"));
});
test("closing statement must match exactly", () => {
  const exact = "Powered nodes are live in the invitation-only Founding Beta. Unpowered nodes are our intentions, not commitments.";
  assert.ok(rules(lintCopy("Powered nodes are live.", { ...ctx, mustEqual: exact })).includes("closing-statement"));
  assert.ok(!rules(lintCopy(exact, { ...ctx, mustEqual: exact })).includes("closing-statement"));
});
test("warnings: long sentence, soon, superlative", () => {
  const long = Array.from({ length: 26 }, (_, i) => `w${i}`).join(" ") + ".";
  assert.ok(warns(lintCopy(long, ctx)).includes("long-sentence"));
  assert.ok(!warns(lintCopy(Array.from({ length: 25 }, (_, i) => `w${i}`).join(" ") + ".", ctx)).includes("long-sentence"));
  assert.ok(warns(lintCopy("It ships soon.", ctx)).includes("soon-word"));
  assert.ok(!warns(lintCopy("Coming soon: more.", ctx)).includes("soon-word"));
  assert.ok(warns(lintCopy("The best supplier", ctx)).includes("superlative"));
  assert.ok(warns(lintCopy("The fastest quote", ctx)).includes("superlative"));
  assert.ok(!warns(lintCopy("A good supplier", ctx)).includes("superlative"));
  assert.equal(lintCopy("It ships soon.", ctx).ok, true, "warnings do not block");
});
test("every seeded field passes lint without errors", () => {
  for (const f of seed.fields) {
    const r = lintCopy(f.text, { capabilities: caps, fieldStatus: f.status, plannedContext: f.status === "planned", mustEqual: f.mustEqual });
    assert.deepEqual(r.errors, [], f.id);
  }
});
