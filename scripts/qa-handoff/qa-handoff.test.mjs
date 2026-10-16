// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  decide,
  dedupeKey,
  duplicateMarkers,
  evaluateGate,
  hasMarker,
  markerFor,
  parseRequiredChecks,
  trustedMarkerAuthors,
} from "./gate.mjs";
import { GithubApiError, handoffPr, parseArgs, resolveRequiredChecks, run } from "./run.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const REQUIRED = ["ci", "provider-go-live"];
const BOT = "github-actions[bot]";
const BACKSTOP = "mini-operator";

function pr(overrides = {}) {
  return { number: 7, state: "open", draft: false, base: { ref: "main" }, head: { sha: SHA_A }, ...overrides };
}

function green(names = REQUIRED, startId = 1) {
  return names.map((name, index) => ({ id: startId + index, name, status: "completed", conclusion: "success" }));
}

function comment(id, body, login = BOT) {
  return { id, body, user: { login } };
}

// In-memory GitHub. Every call yields to the event loop so concurrent runs
// interleave the way two workflow jobs would. `branch` and `protection` are the
// required-check lists the two endpoints return (an Error is thrown instead).
// Comments are written as `login`; asAuthor() gives a second writer that
// shares the same state.
function fakeApi({
  prs = [pr()],
  checkRuns = { [SHA_A]: green() },
  statuses = {},
  branch = REQUIRED,
  protection = REQUIRED,
  login = BOT,
} = {}) {
  const state = {
    prs: new Map(prs.map((item) => [item.number, structuredClone(item)])),
    checkRuns: structuredClone(checkRuns),
    statuses: structuredClone(statuses),
    comments: new Map(),
    labels: new Map(),
    writes: [],
    nextCommentId: 100,
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
    async getBranchRequiredChecks() {
      await tick();
      if (branch instanceof Error) throw branch;
      return branch;
    },
    async getProtectionRequiredChecks() {
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
    createComment: (number, body) => writeComment(login, number, body),
    async deleteComment(id, author = login) {
      await tick();
      for (const [number, list] of state.comments) {
        const index = list.findIndex((item) => item.id === id);
        if (index !== -1) {
          list.splice(index, 1);
          state.writes.push({ type: "delete", number, id, login: author });
          return null;
        }
      }
      throw new GithubApiError(404, `/issues/comments/${id}`, "Not Found");
    },
    async addLabels(number, labels) {
      await tick();
      const set = state.labels.get(number) ?? new Set();
      labels.forEach((label) => set.add(label));
      state.labels.set(number, set);
      state.writes.push({ type: "label", number, labels });
    },
    asAuthor(other) {
      return {
        ...api,
        createComment: (number, body) => writeComment(other, number, body),
        deleteComment: (id) => api.deleteComment(id, other),
      };
    },
  };
  async function writeComment(author, number, body) {
    await tick();
    const list = state.comments.get(number) ?? [];
    const created = comment(state.nextCommentId++, body, author);
    list.push(created);
    state.comments.set(number, list);
    state.writes.push({ type: "comment", number, body, login: author });
    return structuredClone(created);
  }
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
    expect(hasMarker([comment(1, `x\n${markerFor(SHA_A)}`)], SHA_A)).toBe(true);
    expect(hasMarker([comment(1, markerFor(SHA_A))], SHA_B)).toBe(false);
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
    const result = decide({ event: { headSha: SHA_A }, pr: pr(), checkRuns: green(), statuses: [], requiredChecks: REQUIRED, comments: [comment(1, markerFor(SHA_A))] });
    expect(result).toMatchObject({ handoff: false, reason: "already-handed-off", key: dedupeKey(7, SHA_A) });
  });

  it("counts only markers from trusted authors", () => {
    const pasted = [comment(1, markerFor(SHA_A), "someone-else"), comment(2, markerFor(SHA_A))];
    expect(hasMarker([pasted[0]], SHA_A)).toBe(false);
    expect(hasMarker([{ id: 3, body: markerFor(SHA_A) }], SHA_A)).toBe(false);
    expect(hasMarker(pasted, SHA_A)).toBe(true);
    expect(hasMarker([comment(4, markerFor(SHA_A), BACKSTOP)], SHA_A)).toBe(false);
    expect(hasMarker([comment(4, markerFor(SHA_A), BACKSTOP)], SHA_A, trustedMarkerAuthors(` ${BACKSTOP} ,`))).toBe(true);
    expect(trustedMarkerAuthors(undefined)).toEqual([BOT]);
    expect(trustedMarkerAuthors(`${BACKSTOP},${BOT}`)).toEqual([BOT, BACKSTOP]);
  });

  it("picks every trusted marker above the lowest id as a duplicate", () => {
    const comments = [
      comment(30, markerFor(SHA_A), BACKSTOP),
      comment(10, markerFor(SHA_A), "someone-else"),
      comment(20, markerFor(SHA_A)),
      comment(40, markerFor(SHA_B)),
      comment(50, markerFor(SHA_A)),
    ];
    expect(duplicateMarkers(comments, SHA_A, [BOT, BACKSTOP]).map((item) => item.id)).toEqual([30, 50]);
    expect(duplicateMarkers(comments, SHA_B, [BOT, BACKSTOP])).toEqual([]);
  });

  it("only counts required check runs from GitHub Actions when the app is present", () => {
    const base = { event: { headSha: SHA_A }, pr: pr(), statuses: [], requiredChecks: REQUIRED };
    const spoofed = [
      { id: 1, name: "ci", status: "completed", conclusion: "failure", app: { slug: "github-actions" } },
      { id: 2, name: "ci", status: "completed", conclusion: "success", app: { slug: "some-other-app" } },
      { id: 3, name: "provider-go-live", status: "completed", conclusion: "success", app: { slug: "github-actions" } },
    ];
    expect(evaluateGate({ ...base, checkRuns: spoofed }).reason).toBe("check-fail");
    expect(evaluateGate({ ...base, checkRuns: spoofed.slice(1) }).reason).toBe("check-missing");
    const statuses = [{ context: "ci", state: "success" }];
    expect(evaluateGate({ ...base, checkRuns: spoofed.slice(1), statuses }).handoff).toBe(true);
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

  it("ignores a marker pasted by an untrusted author and honors a trusted one", async () => {
    const api = fakeApi();
    api.state.comments.set(7, [comment(1, markerFor(SHA_A), "someone-else")]);
    expect(await apply(api, { eventSha: SHA_A })).toMatchObject({ action: "handoff" });
    expect(markers(api).map((item) => item.user.login)).toEqual(["someone-else", BOT]);

    const trusted = fakeApi();
    trusted.state.comments.set(7, [comment(1, markerFor(SHA_A), BACKSTOP)]);
    const result = await apply(trusted, { eventSha: SHA_A, trustedAuthors: trustedMarkerAuthors(BACKSTOP) });
    expect(result).toMatchObject({ action: "noop", reason: "already-handed-off" });
    expect(trusted.state.writes).toEqual([]);
  });

  it("backstop and workflow racing outside one lock leave exactly one marker", async () => {
    const api = fakeApi();
    const trustedAuthors = trustedMarkerAuthors(BACKSTOP);
    // No shared lock: both pass the in-lock re-read, both write, and the
    // post-write re-list deletes the higher-id marker.
    const results = await Promise.all([
      apply(api, { eventSha: SHA_A, trustedAuthors }),
      apply(api.asAuthor(BACKSTOP), { eventSha: SHA_A, trustedAuthors }),
    ]);
    expect(results.map((result) => result.action)).toEqual(["handoff", "handoff"]);
    expect(api.state.writes.filter((write) => write.type === "comment")).toHaveLength(2);
    expect(api.state.writes.filter((write) => write.type === "delete")).toHaveLength(1);
    expect(markers(api)).toHaveLength(1);
    // Comment ids start at 100, so the survivor is the first marker written.
    expect(markers(api)[0].id).toBe(100);
    expect(results.reduce((sum, result) => sum + result.duplicatesRemoved, 0)).toBe(1);
    expect(await apply(api, { eventSha: SHA_A, trustedAuthors })).toMatchObject({ action: "noop", reason: "already-handed-off" });
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
  const unreadable = (status) => new GithubApiError(status, "/branches/main", "Resource not accessible");

  it("reads required checks from the branch endpoint first", async () => {
    const api = fakeApi({ branch: ["ci", "e2e"], protection: unreadable(403) });
    const lines = [];
    expect(await resolveRequiredChecks(api, { REQUIRED_CHECKS: "x" }, (line) => lines.push(line))).toEqual(["ci", "e2e"]);
    expect(lines).toEqual(["required checks (GET branches/main): ci, e2e"]);
  });

  it("falls back to the protection endpoint when the branch read fails or lists nothing", async () => {
    for (const branch of [unreadable(404), []]) {
      const api = fakeApi({ branch, protection: ["ci"] });
      const lines = [];
      expect(await resolveRequiredChecks(api, {}, (line) => lines.push(line))).toEqual(["ci"]);
      expect(lines.at(-1)).toBe("required checks (GET branches/main/protection/required_status_checks): ci");
    }
  });

  it("falls back to REQUIRED_CHECKS, then the default, when both endpoints fail, and logs it", async () => {
    const api = fakeApi({ branch: unreadable(404), protection: unreadable(403) });
    const lines = [];
    expect(await resolveRequiredChecks(api, { REQUIRED_CHECKS: "ci" }, (line) => lines.push(line))).toEqual(["ci"]);
    expect(lines).toEqual([
      "GET branches/main unreadable (404)",
      "GET branches/main/protection/required_status_checks unreadable (403)",
      "required checks (REQUIRED_CHECKS env): ci",
    ]);
    const defaults = [];
    expect(await resolveRequiredChecks(api, {}, (line) => defaults.push(line))).toEqual(REQUIRED);
    expect(defaults.at(-1)).toBe("required checks (DEFAULT_REQUIRED_CHECKS): ci, provider-go-live");
  });

  it("rethrows required-check errors other than 403/404", async () => {
    await expect(resolveRequiredChecks(fakeApi({ branch: unreadable(500) }), {}, () => {})).rejects.toThrow("500");
    await expect(
      resolveRequiredChecks(fakeApi({ branch: [], protection: unreadable(500) }), {}, () => {}),
    ).rejects.toThrow("500");
  });

  it("trusts QA_HANDOFF_TRUSTED_MARKER_AUTHORS from the env", async () => {
    const api = fakeApi();
    api.state.comments.set(7, [comment(1, markerFor(SHA_A), BACKSTOP)]);
    const args = { repo: "o/r", mode: "apply", pr: 7, sha: SHA_A };
    const lines = [];
    const trusted = await run({ args, api, env: { QA_HANDOFF_TRUSTED_MARKER_AUTHORS: BACKSTOP }, log: (line) => lines.push(line) });
    expect(trusted).toEqual([expect.objectContaining({ action: "noop", reason: "already-handed-off" })]);
    expect(lines).toContain(`trusted marker authors: ${BOT}, ${BACKSTOP}`);
    const untrusted = await run({ args, api, env: {}, log: () => {} });
    expect(untrusted).toEqual([expect.objectContaining({ action: "handoff" })]);
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
