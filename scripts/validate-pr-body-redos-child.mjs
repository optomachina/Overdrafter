import { performance } from "node:perf_hooks";

import {
  PROVIDER_GO_LIVE_REQUIRED_ITEMS,
  collectGoLiveEvidenceLinks,
  validatePrBody,
  validateProviderGoLive,
} from "./validate-pr-body.mjs";

const WIDTH = 65536;

function repeatTo(unit, width = WIDTH) {
  return unit.repeat(Math.ceil(width / unit.length)).slice(0, width);
}

function goLive(payload) {
  // normalizeText turns a final `\r\n` into `\n` and trim() eats a final CR,
  // LS, or PS. A trailing "#" keeps that character inside the line so the
  // validator actually runs the failing match.
  const guarded = /[\r\u2028\u2029]$/.test(payload) ? `${payload}#` : payload;
  return `## Provider go-live\n\n${guarded}\n`;
}

function time(fn) {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
}

function runBody(payload) {
  const body = goLive(payload);
  const live = time(() => validateProviderGoLive(body));
  const pr = time(() => validatePrBody(body));
  const links = time(() => collectGoLiveEvidenceLinks(body));
  return {
    maxMs: Math.max(live.ms, pr.ms, links.ms),
    sumMs: live.ms + pr.ms,
    ok: pr.value.ok,
    errors: live.value,
    calls: [
      { name: "validateProviderGoLive", ms: live.ms },
      { name: "validatePrBody", ms: pr.ms },
      { name: "collectGoLiveEvidenceLinks", ms: links.ms },
    ],
  };
}

function runBodies(payloads) {
  const runs = payloads.map((payload) => runBody(payload));
  return {
    maxMs: Math.max(...runs.map((run) => run.maxMs)),
    sumMs: Math.max(...runs.map((run) => run.sumMs)),
    ok: runs.some((run) => run.ok),
    errors: runs.map((run) => run.errors),
    calls: runs.flatMap((run) => run.calls),
  };
}

const envelope = PROVIDER_GO_LIVE_REQUIRED_ITEMS.find((item) => item.id === "envelope-reviewer").match;

function combined(width) {
  // `\r` is the line break on the adversarial lines, so it is not paired with `\n`.
  const unit = [
    `# ${" ".repeat(40)}\r`,
    `- [x]${" ".repeat(40)}\r`,
    `${"`".repeat(40)}\r`,
    `${"<h1 ".repeat(20)}\n`,
    "> a\n> ===\n",
    "a\n---\n",
  ].join("");
  return repeatTo(unit, width);
}

function bench(makePayload) {
  const measure = (width) => {
    const body = goLive(makePayload(width));
    validateProviderGoLive(body);
    const start = performance.now();
    let reps = 0;
    let elapsed = 0;
    do {
      validateProviderGoLive(body);
      reps += 1;
      elapsed = performance.now() - start;
    } while (elapsed < 25 && reps < 400);
    return { ms: elapsed / reps, reps };
  };
  const small = measure(16 * 1024);
  const large = measure(64 * 1024);
  const ratio = small.ms <= 0 ? 0 : large.ms / small.ms;
  return { smallMs: small.ms, largeMs: large.ms, reps: [small.reps, large.reps], ratio };
}

const payloads = {
  a1: () => [`# ${" ".repeat(WIDTH - 3)}\r`],
  a2: () => [`#${" ".repeat(WIDTH - 2)}\u2028`],
  a3: () => [`${"- ".repeat(32768)}x`, " ".repeat(WIDTH)],
  a5: () => [
    `- [x]${" ".repeat(WIDTH - 6)}\r`,
    `${"-  1. ".repeat(10922)} `,
    `${"- ".repeat(32768)}[y]`,
    `${"> ".repeat(32768)}- [x]\r`,
  ],
  a6: () => [`${"`".repeat(WIDTH - 1)}\r`, `${"~".repeat(WIDTH - 1)}\r`, `${"- ".repeat(32768)}\`\``],
  a7: () => [`# ${"<a".repeat((WIDTH - 2) / 2)}`],
  a8: () => ["<h1 ".repeat(WIDTH / 4)],
  a9: () => [combined(WIDTH)],
  a10: () => [repeatTo("> a\n> ===\n")],
  a11: () => [repeatTo("a\n---\n")],
  a12: () => [repeatTo(`${"a\n".repeat(50)}---\n`)],
  a10k: () => [combined(10_000)],
};

const id = process.argv[2];
let report;

if (id === "a4") {
  const samples = ["-  ".repeat(40) + "x", "-  ".repeat(21845) + "x"];
  const calls = samples.map((sample) => {
    const timed = time(() => envelope.test(sample));
    return { ms: timed.ms, match: timed.value };
  });
  report = {
    id,
    maxMs: Math.max(...calls.map((call) => call.ms)),
    match: calls.some((call) => call.match),
    calls,
  };
} else if (id === "growth") {
  const families = {
    r1: (width) => `# ${" ".repeat(Math.max(0, width - 3))}\r`,
    r4: (width) => `- [x]${" ".repeat(Math.max(0, width - 6))}\r`,
    r5: (width) => `${"`".repeat(Math.max(1, width - 1))}\r`,
    setext: (width) => repeatTo("a\n---\n", width),
  };
  const ratios = Object.fromEntries(Object.entries(families).map(([name, make]) => [name, bench(make)]));
  report = { id, ratios, maxRatio: Math.max(...Object.values(ratios).map((row) => row.ratio)) };
} else if (payloads[id]) {
  report = { id, ...runBodies(payloads[id]()) };
} else {
  console.error(`unknown case ${id}`);
  process.exit(1);
}

console.log(JSON.stringify(report));
