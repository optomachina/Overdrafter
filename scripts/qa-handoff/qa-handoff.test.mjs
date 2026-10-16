// @vitest-environment node

import { describe, expect, it } from "vitest";
import { decide, dedupeKey, evaluateGate, hasMarker, markerFor, parseRequiredChecks } from "./gate.mjs";
import { GithubApiError, handoffPr, parseArgs, resolveRequiredChecks, run } from "./run.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REQUIRED = ["ci", "provider-go-live"];

function pr(overrides = {}) {
  return { number: 7, state: "open", draft: false, base: { ref: "main" }, head: { sha: SHA_A }, ...overrides };
}

function green(names = REQUIRED, startId = 1) {
  return names.map((name, index) => ({ id: startId + index, name, status: "completed", conclusion: "success" }));
}

// In-memory GitHub. Every call yields to the event loop so concurrent runs
// interleave the way two workflow jobs would.
function fakeApi({ prs = [pr()], checkRuns = { [SHA_A]: green() }, statuses = {}, protection = REQUIRED } = {}) {
  const state = {
    prs: new Map(prs.map((item) => [item.number, structuredClone(item)])),
    checkRuns: structuredClone(checkRuns),
    statuses: structuredClone(statuses),
    comments: new Map(),
    labels: new Map(),
    writes: [],
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const api = {
    state,
    async getPr(number) {
      await tick();
      return structuredClone(state.prs.get(number) ?? null);
    },
    async listOpenPrs() {
      await tick();
      return [...state.prs.values()].filter((item) => item.state === "open").map((item) => structuredClone(item));
    },
    async getRequiredChecks() {
      await tick();
      if (protection instanceof Error) throw protection;
      return protection;
    },
    async listCheckRuns(sha) {
      await tick();
      return structuredClone(state.checkRuns[sha] ?? []);
    },
    async listStatuses(sha) {
      await tick();
      return structuredClone(state.statuses[sha] ?? []);
    },
    async listComments(number) {
      await tick();
      return structuredClone(state.comments.get(number) ?? []);
    },
    async createComment(number, body) {
      await tick();
      const list = state.comments.get(number) ?? [];
      list.push({ id: list.length + 1, body });
      state.comments.set(number, list);
      state.writes.push({ type: "comment", number, body });
    },
    async addLabels(number, labels) {
      await tick();
      const set = state.labels.get(number) ?? new Set();
      labels.forEach((label) => set.add(label));
      state.labels.set(number, set);
      state.writes.push({ type: "label", number, labels });
    },
  };
  return api;
}

function markers(api, number = 7) {
  return (api.state.comments.get(number) ?? []).filter((comment) => comment.body.includes("<!-- qa-handoff sha="));
}

// Models the workflow's concurrency group: callers with the same key run one
// at a time, in arrival order.
function concurrencyGroups() {
  const tails = new Map();
  return (key, fn) => {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn);
    tails.set(key, result.catch(() => {}));
    return result;
  };
}

const apply = (api, extra = {}) => handoffPr({ api, prNumber: 7, mode: "apply", requiredChecks: REQUIRED, ...extra });

describe("gate", () => {
  it("formats the marker and dedupe key per sha", () => {
    expect(markerFor(SHA_A)).toBe(`<!-- qa-handoff sha=${SHA_A} -->`);
    expect(dedupeKey(7, SHA_A)).toBe(`qa-handoff:7:${SHA_A}`);
    expect(hasMarker([{ body: `x\n${markerFor(SHA_A)}` }], SHA_A)).toBe(true);
    expect(hasMarker([{ body: markerFor(SHA_A) }], SHA_B)).toBe(false);
    expect(parseRequiredChecks(" ci, provider-go-live,,ci ")).toEqual(["ci", "provider-go-live"]);
  });

  it("hands off when every required check is green", () => {
    const result = evaluateGate({ event: { headSha: SHA_A }, pr: pr(), checkRuns: green(), statuses: [], requiredChecks: REQUIRED });
    expect(result).toMatchObject({ handoff: true, reason: "all-required-green" });
  });

  it("is a no-op for a stale sha", () => {
    const result = evaluateGate({ event: { headSha: SHA_B }, pr: pr(), checkRuns: green(), statuses: [], requiredChecks: REQUIRED });
    expect(result).toMatchObject({ handoff: false, reason: "stale-sha" });
  });

  it("blocks on one pending required check", () => {
    const runs = [...green(["ci"]), { id: 9, name: "provider-go-live", status: "in_progress", conclusion: null }];
    const result = evaluateGate({ event: { headSha: SHA_A }, pr: pr(), checkRuns: runs, statuses: [], requiredChecks: REQUIRED });
    expect(result).toMatchObject({ handoff: false, reason: "check-pending" });
  });

  it("blocks on a missing or failed required check, and only counts the latest run", () => {
    const base = { event: { headSha: SHA_A }, pr: pr(), statuses: [], requiredChecks: REQUIRED };
    expect(evaluateGate({ ...base, checkRuns: green(["ci"]) }).reason).toBe("check-missing");
    const failed = [...green(["ci"]), { id: 3, name: "provider-go-live", status: "completed", conclusion: "failure" }];
    expect(evaluateGate({ ...base, checkRuns: failed }).reason).toBe("check-fail");
    const rerun = [...failed, { id: 4, name: "provider-go-live", status: "completed", conclusion: "success" }];
    expect(evaluateGate({ ...base, checkRuns: rerun }).handoff).toBe(true);
  });

  it("accepts skipped and neutral, and commit statuses", () => {
    const runs = [{ id: 1, name: "ci", status: "completed", conclusion: "skipped" }];
    const statuses = [{ context: "provider-go-live", state: "success" }];
    const result = evaluateGate({ event: { headSha: SHA_A }, pr: pr(), checkRuns: runs, statuses, requiredChecks: REQUIRED });
    expect(result.handoff).toBe(true);
    const neutral = [{ id: 1, name: "ci", status: "completed", conclusion: "neutral" }];
    expect(evaluateGate({ event: { headSha: SHA_A }, pr: pr(), checkRuns: neutral, statuses, requiredChecks: REQUIRED }).handoff).toBe(true);
  });

  it.each([
    ["draft", { draft: true }, "pr-draft"],
    ["closed", { state: "closed" }, "pr-closed"],
    ["non-main base", { base: { ref: "release" } }, "base-not-main:release"],
  ])("is a no-op for a %s PR", (_label, overrides, reason) => {
    const result = decide({ event: { headSha: SHA_A }, pr: pr(overrides), checkRuns: green(), statuses: [], requiredChecks: REQUIRED, comments: [] });
    expect(result).toMatchObject({ handoff: false, reason });
  });

  it("refuses to hand off with an empty required set", () => {
    const result = evaluateGate({ event: { headSha: SHA_A }, pr: pr(), checkRuns: green(), statuses: [], requiredChecks: [] });
    expect(result.reason).toBe("no-required-checks");
  });

  it("is a no-op when the marker for this sha exists", () => {
    const result = decide({ event: { headSha: SHA_A }, pr: pr(), checkRuns: green(), statuses: [], requiredChecks: REQUIRED, comments: [{ body: markerFor(SHA_A) }] });
    expect(result).toMatchObject({ handoff: false, reason: "already-handed-off", key: dedupeKey(7, SHA_A) });
  });
});

describe("handoffPr", () => {
  it("stale event sha is a no-op and writes nothing", async () => {
    const api = fakeApi();
    const result = await apply(api, { eventSha: SHA_B });
    expect(result).toMatchObject({ action: "noop", reason: "stale-sha" });
    expect(api.state.writes).toEqual([]);
  });

  it("one pending required check is a no-op", async () => {
    const api = fakeApi({ checkRuns: { [SHA_A]: [...green(["ci"]), { id: 5, name: "provider-go-live", status: "queued", conclusion: null }] } });
    const result = await apply(api, { eventSha: SHA_A });
    expect(result).toMatchObject({ action: "noop", reason: "check-pending" });
    expect(api.state.writes).toEqual([]);
  });

  it("all green hands off exactly once: label then marker", async () => {
    const api = fakeApi();
    const result = await apply(api, { eventSha: SHA_A });
    expect(result).toMatchObject({ action: "handoff", key: dedupeKey(7, SHA_A) });
    expect(api.state.writes.map((write) => write.type)).toEqual(["label", "comment"]);
    expect(markers(api)).toHaveLength(1);
    expect(markers(api)[0].body).toContain(markerFor(SHA_A));
    expect([...api.state.labels.get(7)]).toEqual(["qa:ready"]);
  });

  it("duplicate event and a later backstop run are no-ops", async () => {
    const api = fakeApi();
    await apply(api, { eventSha: SHA_A });
    const duplicate = await apply(api, { eventSha: SHA_A });
    const backstop = await run({
      args: { repo: "o/r", mode: "apply", pr: undefined, sha: undefined },
      api,
      log: () => {},
    });
    expect(duplicate).toMatchObject({ action: "noop", reason: "already-handed-off" });
    expect(backstop).toEqual([expect.objectContaining({ action: "noop", reason: "already-handed-off" })]);
    expect(markers(api)).toHaveLength(1);
  });

  it("a force-pushed new sha that goes green hands off a second time", async () => {
    const api = fakeApi();
    await apply(api, { eventSha: SHA_A });
    api.state.prs.get(7).head.sha = SHA_B;
    expect(await apply(api, { eventSha: SHA_B })).toMatchObject({ action: "noop", reason: "check-missing" });
    api.state.checkRuns[SHA_B] = green(REQUIRED, 10);
    expect(await apply(api, { eventSha: SHA_A })).toMatchObject({ action: "noop", reason: "stale-sha" });
    expect(await apply(api, { eventSha: SHA_B })).toMatchObject({ action: "handoff", key: dedupeKey(7, SHA_B) });
    expect(markers(api).map((comment) => comment.body.split("\n")[0])).toEqual([markerFor(SHA_A), markerFor(SHA_B)]);
  });

  it.each([
    ["draft", { draft: true }],
    ["closed", { state: "closed" }],
    ["non-main base", { base: { ref: "develop" } }],
  ])("%s PR is a no-op", async (_label, overrides) => {
    const api = fakeApi({ prs: [pr(overrides)] });
    expect((await apply(api, { eventSha: SHA_A })).action).toBe("noop");
    expect(api.state.writes).toEqual([]);
  });

  it("two concurrent completions write exactly one marker", async () => {
    const api = fakeApi();
    const lock = concurrencyGroups();
    // Both pass the pre-lock read before either writes; the post-lock
    // re-check is what stops the second.
    const results = await Promise.all([apply(api, { eventSha: SHA_A, lock }), apply(api, { eventSha: SHA_A, lock })]);
    expect(results.map((result) => result.action).sort()).toEqual(["handoff", "noop"]);
    expect(results.find((result) => result.action === "noop").reason).toBe("already-handed-off");
    expect(markers(api)).toHaveLength(1);
  });

  it("report mode logs the would-be handoff and writes nothing", async () => {
    const api = fakeApi();
    const lines = [];
    const result = await handoffPr({ api, prNumber: 7, eventSha: SHA_A, mode: "report", requiredChecks: REQUIRED, log: (line) => lines.push(line) });
    expect(result.action).toBe("would-handoff");
    expect(lines.join("\n")).toContain("WOULD hand off");
    expect(api.state.writes).toEqual([]);
  });
});

describe("run", () => {
  it("falls back to REQUIRED_CHECKS when protection is unreadable and logs it", async () => {
    const api = fakeApi({ protection: new GithubApiError(403, "/protection", "Resource not accessible") });
    const lines = [];
    expect(await resolveRequiredChecks(api, { REQUIRED_CHECKS: "ci" }, (line) => lines.push(line))).toEqual(["ci"]);
    expect(lines.join("\n")).toMatch(/unreadable \(403\).*\n.*REQUIRED_CHECKS env/);
    expect(await resolveRequiredChecks(api, {}, () => {})).toEqual(REQUIRED);
  });

  it("rethrows protection errors other than 403/404", async () => {
    const api = fakeApi({ protection: new GithubApiError(500, "/protection", "boom") });
    await expect(resolveRequiredChecks(api, {}, () => {})).rejects.toThrow("500");
  });

  it("finds the PR by sha when the event carries no PR number", async () => {
    const api = fakeApi({ prs: [pr(), pr({ number: 8, head: { sha: SHA_B } })] });
    const results = await run({ args: { repo: "o/r", mode: "apply", pr: undefined, sha: SHA_A }, api, log: () => {} });
    expect(results).toEqual([expect.objectContaining({ action: "handoff", key: dedupeKey(7, SHA_A) })]);
    expect(markers(api, 8)).toHaveLength(0);
  });

  it("validates CLI arguments", () => {
    expect(parseArgs(["--repo", "optomachina/Overdrafter", "--mode", "report", "--pr", "12"])).toMatchObject({ pr: 12, mode: "report" });
    expect(parseArgs(["--repo", "o/r", "--mode", "apply", "--pr", "", "--sha", SHA_A])).toMatchObject({ pr: undefined, sha: SHA_A });
    expect(() => parseArgs(["--repo", "o/r", "--mode", "enforce"])).toThrow("--mode");
    expect(() => parseArgs(["--mode", "report"])).toThrow("--repo");
    expect(() => parseArgs(["--repo", "o/r", "--sha", "main"])).toThrow("--sha");
  });
});
