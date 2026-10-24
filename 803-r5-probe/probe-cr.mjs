import { planContiguousVerified } from "../wt803-r5/scripts/merge-readback.mjs";
const base = "a".repeat(40);
try { const p = planContiguousVerified([{ pr: 1, head_sha: "abcd1234" }], { 1: { sha: "abcd1234", verdict_ref: "v1", valid: true } }, { base }); console.log("CR short head_sha accepted by plan:", JSON.stringify(p.land)); } catch (e) { console.log("CR short head_sha rejected:", e.message); }
