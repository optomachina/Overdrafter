import { performance } from "node:perf_hooks";

import {
  PROVIDER_GO_LIVE_REQUIRED_ITEMS,
  collectGoLiveEvidenceLinks,
  validatePrBody,
  validateRevertPlan,
  validateProviderGoLive,
} from "./validate-pr-body.mjs";

const WIDTH = 65536;

function repeatTo(unit, width = WIDTH) {
  return unit.repeat(Math.ceil(width / unit.length)).slice(0, width);
}

// Runs of combining marks that alternate between combining classes (U+0316, U+0301), and
// of a halfwidth sound mark beside a mark (NFKC turns U+FF9E into a mark). Normalization
// sorts each run, and that sort costs the square of the run unless the run is capped.
const MARK_PAIR = "\u0316\u0301";
const HALFWIDTH_PAIR = "\uFF9E\u0301";

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

// One slow sample on a busy machine says little, while an algorithm that is
// really quadratic is slow every time. So a case is measured three times and
// the fastest run of each figure is reported. A case already over a second on
// its first run is a real failure and is reported as it is, not repeated.
const REPEATS = 3;
const SLOW_MS = 1000;
// A growth ratio at or above this is measured again; the test's own bound is 8.
const GROWTH_RETRY_ABOVE = 6;

function fastest(measure) {
  const first = measure();
  if (first.maxMs >= SLOW_MS) return first;
  const runs = [first, ...Array.from({ length: REPEATS - 1 }, measure)];
  const lowest = (key) => Math.min(...runs.map((run) => run[key]));
  const best = { ...first, maxMs: lowest("maxMs") };
  if ("sumMs" in first) best.sumMs = lowest("sumMs");
  return best;
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

// Time one body as the fastest of many single calls, not an average over a
// short window: an average moves with every pause, a minimum does not.
function measureMin(width, makePayload) {
  const body = goLive(makePayload(width));
  validateProviderGoLive(body);
  const start = performance.now();
  let best = Infinity;
  let reps = 0;
  do {
    const callStart = performance.now();
    validateProviderGoLive(body);
    best = Math.min(best, performance.now() - callStart);
    reps += 1;
  } while (reps < 5 || (performance.now() - start < 25 && reps < 400));
  return { ms: best, reps };
}

function bench(makePayload) {
  let best = null;
  for (let attempt = 0; attempt < REPEATS; attempt += 1) {
    const small = measureMin(16 * 1024, makePayload);
    const large = measureMin(64 * 1024, makePayload);
    const ratio = small.ms <= 0 ? 0 : large.ms / small.ms;
    if (best === null || ratio < best.ratio) {
      best = { smallMs: small.ms, largeMs: large.ms, reps: [small.reps, large.reps], ratio };
    }
    if (ratio < GROWTH_RETRY_ABOVE) break;
  }
  return best;
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
  // A character reference left half read across tags, comments and an unclosed
  // tag: its leftovers used to be rescanned from the "&" on every piece of text.
  a13: () => [
    `&#${"1<b>".repeat(WIDTH / 4)}`,
    `&#x${"f<b>".repeat(WIDTH / 4)}`,
    `&a${"b</b>".repeat(WIDTH / 5)}`,
    `&#${"1<!---->".repeat(WIDTH / 8)}`,
    `<b &#${"1<!---->".repeat(WIDTH / 8)}`,
    `&#${"1".repeat(WIDTH / 2)}<b\n${"---\n".repeat(WIDTH / 8)}`,
    `&${"a<b>".repeat(32)}`.repeat(WIDTH / 129),
  ],
  // Combining marks on a plain line, an ATX, an HTML and a setext heading. (A ticked line would
  // add an evidence error that repeats the whole line, so it is left to the work-counting tests.)
  a14: () => {
    const marks = repeatTo(MARK_PAIR);
    const halfwidth = repeatTo(HALFWIDTH_PAIR);
    return [
      `x${marks}`,
      `### x${marks}`,
      `<h2>x${marks}</h2>`,
      `x${marks}\n---`,
      `x${halfwidth}`,
      `### x${halfwidth}`,
    ];
  },
  a10k: () => [combined(10_000)],
};

const id = process.argv[2];
let report;

if (id === "revert") {
  const payload = `## R&#101;vert plan\n${combined(WIDTH)}\n- Blast radius: ${repeatTo(MARK_PAIR)}`;
  report = { id, ...time(() => validateRevertPlan(payload, "revertable")) };
} else if (id === "a4") {
  const samples = ["-  ".repeat(40) + "x", "-  ".repeat(21845) + "x"];
  report = {
    id,
    ...fastest(() => {
      const calls = samples.map((sample) => {
        const timed = time(() => envelope.test(sample));
        return { ms: timed.ms, match: timed.value };
      });
      return {
        maxMs: Math.max(...calls.map((call) => call.ms)),
        match: calls.some((call) => call.match),
        calls,
      };
    }),
  };
} else if (id === "growth") {
  const families = {
    r1: (width) => `# ${" ".repeat(Math.max(0, width - 3))}\r`,
    r4: (width) => `- [x]${" ".repeat(Math.max(0, width - 6))}\r`,
    r5: (width) => `${"`".repeat(Math.max(1, width - 1))}\r`,
    setext: (width) => repeatTo("a\n---\n", width),
    entity: (width) => `&#${"1<b>".repeat(Math.floor(width / 4))}`,
    marksLine: (width) => `x${repeatTo(MARK_PAIR, width)}`,
    marksAtx: (width) => `### x${repeatTo(MARK_PAIR, width)}`,
    marksHtml: (width) => `<h2>x${repeatTo(MARK_PAIR, width)}</h2>`,
    marksSetext: (width) => `x${repeatTo(MARK_PAIR, width)}\n---`,
    halfwidthMarks: (width) => `### x${repeatTo(HALFWIDTH_PAIR, width)}`,
  };
  const ratios = Object.fromEntries(Object.entries(families).map(([name, make]) => [name, bench(make)]));
  report = { id, ratios, maxRatio: Math.max(...Object.values(ratios).map((row) => row.ratio)) };
} else if (payloads[id]) {
  report = { id, ...fastest(() => runBodies(payloads[id]())) };
} else {
  console.error(`unknown case ${id}`);
  process.exit(1);
}

console.log(JSON.stringify(report));
