// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULT_LOG, decisionRecord, finalTier, maxTier, replay, screen } from "./jev-pr-screen.mjs";

const accepted = (choice, confidence = 0.9) => ({ status: "accepted", choice, confidence });

describe("jev PR screen", () => {
  it("lets Jev raise the tier but never lower it", () => {
    expect(finalTier("low", accepted("risky"))).toBe("risky");
    expect(finalTier("risky", accepted("low"))).toBe("risky");
    expect(finalTier("normal", accepted("low"))).toBe("normal");
  });

  it("raises to at least normal when Jev fails or is unsure", () => {
    expect(finalTier("low", { status: "failed", reason: "timeout" })).toBe("normal");
    expect(finalTier("low", { status: "uncertain", choice: "low", confidence: 0.3 })).toBe("normal");
    expect(finalTier("risky", { status: "failed" })).toBe("risky");
  });

  it("treats an unknown Jev tier as normal and an unknown deterministic tier as risky", () => {
    expect(maxTier("normal", "low")).toBe("normal");
    expect(finalTier("low", accepted("bogus"))).toBe("normal");
    for (const typo of ["Risky", "critical", "high", undefined, null]) {
      expect(finalTier(typo, accepted("low"))).toBe("risky");
    }
    expect(decisionRecord({ pr: 9, sha: "f", deterministic: "Risky" }, { ok: false, reason: "timeout" }, new Date(0)))
      .toMatchObject({ deterministic: "risky", final: "risky" });
  });

  it("bounds what it logs", () => {
    const record = decisionRecord(
      { pr: "x", sha: "abc def/../../", deterministic: "low" },
      { ok: true, model: "jev 1.13.0 <script>", answers: { tier: { type: "choice", choice: "low", confidence: 7 }, incident: { type: "noul", noul: 3 } }, latencyMs: "slow" },
      new Date(0),
    );
    expect(record.pr).toBeNull();
    expect(record.sha).toMatch(/^[\w.-]*$/);
    expect(record.model).toMatch(/^[\w.-]*$/);
    expect(record.jev).toMatchObject({ confidence: null, pIncident: null, status: "failed" });
    expect(record.latencyMs).toBeNull();
    expect(record.final).toBe("normal");
  });

  it("records probabilities and failures without throwing", () => {
    const ok = decisionRecord(
      { pr: 1, sha: "a", deterministic: "low" },
      { ok: true, model: "jev-1.13.0", answers: { tier: { type: "choice", choice: "low", confidence: 0.95 }, incident: { type: "noul", noul: 0.1 } }, latencyMs: 5 },
      new Date(0),
    );
    expect(ok).toMatchObject({ final: "low", jev: { tier: "low", confidence: 0.95, pIncident: 0.1 }, ok: true });
    const failed = decisionRecord({ pr: 2, sha: "b", deterministic: "low" }, { ok: false, reason: "http_403" }, new Date(0));
    expect(failed).toMatchObject({ final: "normal", ok: false, reason: "http_403", jev: { pIncident: null } });
  });

  it("replays logged decisions under a stricter confidence floor", () => {
    const records = [
      { pr: 4, sha: "d", ok: true, deterministic: "low", final: "low", jev: { tier: "low", confidence: 0.6 } },
      { pr: 5, sha: "e", ok: false, deterministic: "risky", final: "risky", jev: { tier: null, confidence: null } },
    ];
    expect(replay(records, { minConfidence: 0.5 })[0]).toMatchObject({ after: "low", changed: false });
    expect(replay(records, { minConfidence: 0.7 })[0]).toMatchObject({ after: "normal", changed: true });
    expect(replay(records, { minConfidence: 0.7 })[1]).toMatchObject({ after: "risky", changed: false });
    expect(replay(records, { minConfidence: 0.6 })[0]).toMatchObject({ after: "low" });
    expect(replay(records, { minConfidence: null })[0]).toMatchObject({ after: "low" });
    expect(replay(records, { minConfidence: 2 })[0]).toMatchObject({ after: "low" });
    const uncertain = [{ pr: 6, sha: "g", ok: true, deterministic: "low", final: "normal", jev: { tier: "low", confidence: 0.4 } }];
    expect(replay(uncertain, { minConfidence: 0.3 })[0]).toMatchObject({ after: "low", changed: true });
    const riskyBase = [{ pr: 7, sha: "h", ok: true, deterministic: "risky", final: "risky", jev: { tier: "low", confidence: 0.99 } }];
    expect(replay(riskyBase, { minConfidence: 0.1 })[0]).toMatchObject({ after: "risky", changed: false });
  });

  it("replays the committed log to itself at the default floor", () => {
    const lines = readFileSync(DEFAULT_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.length).toBeGreaterThan(0);
    for (const result of replay(lines)) expect(result.changed).toBe(false);
  });

  it("appends one JSONL line per PR", async () => {
    const lines = [];
    const ask = async () => ({ ok: false, reason: "timeout", latencyMs: 1 });
    const records = await screen([{ pr: 3, sha: "c", deterministic: "risky" }], { ask, log: "x.jsonl", append: (_p, line) => lines.push(line) });
    expect(records[0].final).toBe("risky");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ pr: 3, final: "risky" });
  });
});
