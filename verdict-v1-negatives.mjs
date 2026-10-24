// Runs /workspace/qa-batch/845-verdict-v1.md through the repo parser with simulated comment metadata.
import { readFileSync } from "node:fs";
const repo = process.argv[2] ?? "/workspace/qa-batch/wt-verdict";
const { parseVerdictComments } = await import(`${repo}/scripts/verdict-schema.mjs`);
const body = readFileSync(process.argv[3] ?? "/workspace/qa-batch/845-verdict-v1.md", "utf8");
const SHA = "dc145bfb09774bdb33e6993e1bd52e37f073d3d8";
const ts = JSON.parse(body.match(/```overdrafter-verdict\n([\s\S]*?)\n```/)[1]).timestamp;
const created = new Date(Date.parse(ts) + 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const later = new Date(Date.parse(ts) + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z");
const c = (o = {}) => ({ id: o.id ?? 1, body: o.body ?? body, created_at: o.created_at ?? created, updated_at: o.updated_at ?? o.created_at ?? created, user: { login: o.login ?? "optomachina" } });
const summary = (r) => ({ verdict: r.verdict?.verdict ?? null, comment_id: r.comment_id, conflict: r.conflict, conflicts: r.conflicts.map((e) => `${e.comment_id}:${e.verdict.verdict}`), other_sha: r.other_sha.length, reviews: r.reviews.length, rejected: r.rejected.map((x) => ({ id: x.comment_id, reason: x.reason, errors: x.errors })) });
const run = (name, comments, sha = SHA) => {
  let out; try { out = summary(parseVerdictComments(comments, { sha })); } catch (e) { out = { threw: e.message }; }
  console.log(`== ${name}\n${JSON.stringify(out, null, 1)}`);
};
const shortSha = body.replaceAll(`"sha": "${SHA}"`, `"sha": "${SHA.slice(0, 39)}"`);
const sha7 = body.replaceAll(`"sha": "${SHA}"`, `"sha": "${SHA.slice(0, 7)}"`);
const pass = body.replace('"verdict": "FAIL"', '"verdict": "PASS"');
run("sample: fresh, unedited, author optomachina", [c()]);
run("sample: author login differs case (Optomachina)", [c({ login: "Optomachina" })]);
run("NEG edited comment (updated_at != created_at)", [c({ updated_at: later })]);
run("NEG author mismatch (posted by coderabbitai[bot])", [c({ login: "coderabbitai[bot]" })]);
run("NEG sha in block 39 chars", [c({ body: shortSha })]);
run("NEG sha in block 7 chars", [c({ body: sha7 })]);
run("NEG parse query sha 39 chars", [c()], SHA.slice(0, 39));
run("NEG comment created before verdict timestamp (-10 min)", [c({ created_at: new Date(Date.parse(ts) - 600_000).toISOString() })]);
run("NEG missing updated_at", [{ ...c(), updated_at: null }]);
run("NEG extra field in JSON (proof inside block)", [c({ body: body.replace('"schema": "overdrafter.verdict/v1",', '"schema": "overdrafter.verdict/v1",\n  "proof": "x",') })]);
run("NEG findings on verifier role", [c({ body: body.replace('"readiness": {', '"findings": [],\n  "readiness": {') })]);
run("NEG conflicting verdicts same sha (FAIL then PASS)", [c({ id: 1 }), c({ id: 2, body: pass, created_at: later })]);
run("same verdict repeated same sha (FAIL twice, fresh comments)", [c({ id: 1 }), c({ id: 2, created_at: later })]);
run("other sha query (stale head)", [c()], "0".repeat(40));
