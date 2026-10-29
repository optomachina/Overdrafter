import { execFileSync } from "node:child_process";
import { isEntryPoint } from "./lib/entry-point.mjs";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import process from "node:process";

import { detectProviderEnablement } from "./provider-enablement-detect.mjs";

export const REQUIRED_SECTIONS = [
  {
    heading: "Summary",
    placeholders: ["Describe the change briefly."],
    type: "generic",
  },
  {
    heading: "Problem",
    placeholders: ["What problem does this PR solve?"],
    type: "generic",
  },
  {
    heading: "Scope",
    placeholders: ["What is included in this PR?", "What is intentionally not included?"],
    type: "generic",
  },
  {
    heading: "Verification",
    placeholders: [
      "List the exact commands run locally and whether they passed.",
      "Prefer `npm run verify` unless a narrower command set was the right fit for the change.",
      "If unrelated baseline failures surfaced, describe them separately from current-change failures.",
      "# npm run verify",
    ],
    type: "verification",
  },
  {
    heading: "Tests",
    placeholders: ["What tests were added or updated?", "If none were added, explain why."],
    type: "generic",
  },
  {
    heading: "Migration notes",
    placeholders: [],
    type: "choice",
  },
  {
    heading: "Rollback / risk notes",
    placeholders: ["What could go wrong?", "How would this be rolled back if needed?"],
    type: "generic",
  },
  {
    heading: "Documentation",
    placeholders: [],
    type: "choice",
  },
];

const CHOICE_SECTION_BOILERPLATE = {
  "Migration notes": [
    "- [ ] No migration impact",
    "- [x] No migration impact",
    "- [X] No migration impact",
    "- [ ] Migration impact exists and is described below",
    "- [x] Migration impact exists and is described below",
    "- [X] Migration impact exists and is described below",
  ],
  Documentation: [
    "- [ ] Docs updated",
    "- [x] Docs updated",
    "- [X] Docs updated",
    "- [ ] No doc updates needed",
    "- [x] No doc updates needed",
    "- [X] No doc updates needed",
  ],
};

function normalizeHeading(value) {
  return value.trim().toLowerCase();
}

function normalizeText(value) {
  return value.replace(/\r\n/g, "\n").trim();
}

function stripCodeBlocks(value) {
  return value.replace(/```[\s\S]*?```/g, " ");
}

function stripMarkdown(value) {
  return value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/^\s{0,3}[-*]\s+\[[ xX]\]\s*/gm, "")
    .replace(/^\s{0,3}[-*]\s+/gm, "")
    .replace(/^Details:\s*$/gim, "")
    .replace(/^Commands run:\s*$/gim, "")
    .replace(/^Results:\s*$/gim, "")
    .replace(/^Baseline failures or exceptions:\s*$/gim, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasMeaningfulText(value) {
  return /[A-Za-z0-9]/.test(stripMarkdown(stripCodeBlocks(value)));
}

/**
 * Heading rule:
 * - Required PR sections, including Provider go-live, are delimited by ATX
 *   `##` headings only.
 * - `###` headings are subsections and stay inside the parent `##` section.
 * - Headings that appear inside fenced code blocks (``` ... ```) are ignored.
 */
function fencedCodeRanges(text) {
  const ranges = [];
  let searchFrom = 0;

  while (searchFrom < text.length) {
    const start = text.indexOf("```", searchFrom);
    if (start === -1) {
      break;
    }

    const endFence = text.indexOf("```", start + 3);
    const end = endFence === -1 ? text.length : endFence + 3;
    ranges.push([start, end]);
    searchFrom = end;
  }

  return ranges;
}

function isInsideRange(ranges, index) {
  return ranges.some(([start, end]) => index >= start && index < end);
}

const SECTION_HEADING_LINE = /^##[ \t]+(\S.*)$/;
// Any heading form a reader sees: ATX of any level, indented up to 3 spaces,
// optional closing hashes, or a setext underline on the next line.
// Any indent counts (list-nested headings sit deeper); for duplicates only, so
// an indented code line that looks like a heading just fails closed.
export const ANY_ATX_HEADING = /^[ \t]*#{1,6}(?:[ \t]+([^ \t\n\r\u2028\u2029][^\n\r\u2028\u2029]*)?)?$/;
const SETEXT_UNDERLINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
export const CONTAINER_PREFIX = /^[ \t]*(?:>[ \t]*|(?:[-*+]|\d{1,9}[.)])[ \t]+)+/;
const NAMED_ENTITIES = { nbsp: " ", amp: "&", hyphen: "-", dash: "-", ndash: "-", mdash: "-", minus: "-" };
const HEADING_TAG = /<\/?[a-z][^>]*>/gi;
const HTML_HEADING_START = /<h[1-6]\b/gi;
const HTML_HEADING = /<h[1-6]\b[^>]*>([\s\S]*?)(?=<\/h[1-6]\s*>|<h[1-6]\b|$(?![\s\S]))/yi;
const GO_LIVE_PHRASE = "providergolive";
const GO_LIVE_TAIL = GO_LIVE_PHRASE.length - 1;

/**
 * The character a numeric reference names. A reference with hundreds of digits
 * parses to Infinity and `Infinity % n` is NaN, which `fromCodePoint` throws on,
 * so an absurd value reads as U+FFFD (what a browser shows) instead of crashing.
 */
function referenceChar(digits, radix) {
  const value = Number.parseInt(digits, radix) % 0x110000;
  return Number.isFinite(value) ? String.fromCodePoint(value) : "�";
}

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => referenceChar(hex, 16))
    .replace(/&#(\d+);/g, (_, dec) => referenceChar(dec, 10))
    .replace(/&([a-z]+);/gi, (entity, name) => NAMED_ENTITIES[name.toLowerCase()] ?? entity);
}

/** Visible ATX heading text on line `index`, or null when the line is not ATX. */
function anyHeadingText(lines, index) {
  // Headings inside blockquotes or list items ("> ## x", "- ## x") count too.
  const line = lines[index].replace(CONTAINER_PREFIX, "");
  const atx = ANY_ATX_HEADING.exec(line);
  if (atx) return atx[1] ?? "";
  return null;
}

/** Drop closed tags. A `<` with no later `>` stays literal, so the scan cannot retry it. */
function stripHeadingTags(text) {
  const last = text.lastIndexOf(">");
  if (last === -1) return text;
  HEADING_TAG.lastIndex = 0;
  return text.slice(0, last + 1).replace(HEADING_TAG, "") + text.slice(last + 1);
}

/**
 * The most combining marks in a row that Unicode normalization is handed.
 * UAX #15 section 13 (Stream-Safe Text Format) uses the same figure.
 */
export const STREAM_SAFE_RUN = 30;
const COMBINING_GRAPHEME_JOINER = "\u034F";
// Marks, plus the two letters NFKC rewrites into marks: U+FF9E and U+FF9F
// (halfwidth katakana sound marks) become U+3099 and U+309A. Left out, a run of
// them next to real marks would get past the cap. A test checks this list
// against the Unicode tables of the Node it runs on.
const MARK_OR_MARK_LETTER = String.raw`[\p{M}\uFF9E\uFF9F]`;
const STREAM_SAFE_BREAK = new RegExp(
  `(${MARK_OR_MARK_LETTER}{${STREAM_SAFE_RUN}})(?=${MARK_OR_MARK_LETTER})`,
  "gu",
);

/**
 * Put a combining grapheme joiner, which is a starter, after every
 * STREAM_SAFE_RUN marks that have another mark behind them.
 *
 * Normalization sorts each run of marks into canonical order, and ICU's sort
 * costs the square of the run. Marks that alternate between combining classes
 * (U+0316, U+0301, ...) made 64 KiB of one line take over a second and a half.
 * With the joiner no run is longer than the cap, so the sort is linear in total.
 * Text that never has more than STREAM_SAFE_RUN marks in a row comes back as it
 * was, and the joiner is not a letter or digit, so squashing drops it.
 */
export function streamSafeText(text) {
  return text.replace(STREAM_SAFE_BREAK, `$1${COMBINING_GRAPHEME_JOINER}`);
}

/**
 * The only place the squash code normalizes, so no text reaches NFKC before
 * streamSafeText has capped its runs of marks.
 */
function normalizeNfkc(text) {
  return streamSafeText(text).normalize("NFKC");
}

/**
 * Squash heading text to letters and digits, dropping comments and markup and
 * decoding entities, so "### **Provider g&#111;-live** <!-- x -->" still reads
 * as go-live.
 */
function squashHeading(text) {
  return normalizeNfkc(decodeEntities(stripHeadingTags(stripComments(text, false).text)))
    .toLowerCase()
    .replace(/&[a-z]+;/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// `steps` and `maxPending` are work counters for the tests: entity characters
// examined, and the most text a half-read reference ever kept waiting.
function createSquashAcc() {
  return { length: 0, tail: "", head: "", goLive: false, short: "", hold: "", entityRaw: "", steps: 0, maxPending: 0 };
}

function squashChars(text) {
  return normalizeNfkc(text).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function appendAlnum(acc, alnum) {
  if (!alnum) return;
  if (!acc.goLive && (acc.tail + alnum).includes(GO_LIVE_PHRASE)) acc.goLive = true;
  if (acc.head.length < 15) acc.head = (acc.head + alnum).slice(0, 15);
  acc.tail = (acc.tail + alnum).slice(-GO_LIVE_TAIL);
  const next = acc.length + alnum.length;
  if (acc.short !== null && next <= 40) acc.short += alnum;
  else acc.short = null;
  acc.length = next;
}

/** Already-decoded text. One trailing code point stays held so a combiner can join it. */
function commitDecoded(acc, text) {
  if (!text) return;
  const chars = Array.from(acc.hold + text);
  acc.hold = chars.pop() ?? "";
  if (chars.length > 0) appendAlnum(acc, squashChars(chars.join("")));
}

function decodedEntity(raw) {
  const hex = /^&#x([0-9a-f]+);$/i.exec(raw);
  if (hex) return referenceChar(hex[1], 16);
  const dec = /^&#(\d+);$/.exec(raw);
  if (dec) return referenceChar(dec[1], 10);
  if (/^&[a-z]+;$/i.test(raw)) return NAMED_ENTITIES[raw.slice(1, -1).toLowerCase()] ?? "";
  return raw;
}

/**
 * Longest character reference the setext scan reads, "&" and ";" included.
 * CommonMark reads at most 7 decimal or 6 hex digits, and the longest HTML name
 * is 31 letters (`&CounterClockwiseContourIntegral;` is 33 characters), so a
 * longer run is plain text on every renderer and stays literal here.
 *
 * The cap is also what keeps the scan linear. A reference can span tags and
 * comments, so a half-read one waits in `entityRaw` and is scanned again with
 * the next piece of text. Without a cap that wait grows with the line and the
 * rescans add up to a square of its length; with it, at most
 * MAX_REFERENCE_LENGTH - 1 characters ever wait or get scanned again.
 */
export const MAX_REFERENCE_LENGTH = 34;
const REFERENCE_NAME_CHAR = /[a-z]/i;
const REFERENCE_HEX_CHAR = /[0-9a-f]/i;
const REFERENCE_DEC_CHAR = /\d/;

/**
 * Read one reference starting at the "&" at `data[start]`: "done" (with the
 * index after its ";"), "incomplete" (the text ended before it could be
 * decided, so the caller keeps it waiting), or "broken" (not a reference).
 * Examines at most MAX_REFERENCE_LENGTH characters; `steps` counts them.
 */
export function scanEntity(data, start) {
  let steps = 1;
  const next = data[start + 1];
  if (next === undefined) return { kind: "incomplete", steps };
  let cursor = start + 1;
  let isBody = REFERENCE_NAME_CHAR;
  if (next === "#") {
    const marker = data[start + 2];
    steps += 1;
    if (marker === undefined) return { kind: "incomplete", steps };
    const hex = marker === "x" || marker === "X";
    cursor = start + (hex ? 3 : 2);
    isBody = hex ? REFERENCE_HEX_CHAR : REFERENCE_DEC_CHAR;
  } else if (!isBody.test(next)) {
    return { kind: "broken", steps };
  }
  const bodyStart = cursor;
  // The ";" must land on index `last` at the latest, so stop there.
  const last = start + MAX_REFERENCE_LENGTH - 1;
  while (cursor < data.length && cursor < last && isBody.test(data[cursor])) cursor += 1;
  steps += cursor - bodyStart + 1;
  if (cursor === data.length) return { kind: "incomplete", steps };
  if (data[cursor] === ";" && cursor > bodyStart) return { kind: "done", end: cursor + 1, steps };
  return { kind: "broken", steps };
}

function pushLiteral(acc, text) {
  if (!text) return;
  const data = acc.entityRaw + text;
  acc.entityRaw = "";
  let cursor = 0;
  while (cursor < data.length) {
    const amp = data.indexOf("&", cursor);
    if (amp === -1) {
      commitDecoded(acc, data.slice(cursor));
      return;
    }
    commitDecoded(acc, data.slice(cursor, amp));
    const entity = scanEntity(data, amp);
    acc.steps += entity.steps;
    if (entity.kind === "incomplete") {
      acc.entityRaw = data.slice(amp);
      acc.maxPending = Math.max(acc.maxPending, acc.entityRaw.length);
      return;
    }
    if (entity.kind === "done") {
      commitDecoded(acc, decodedEntity(data.slice(amp, entity.end)));
      cursor = entity.end;
      continue;
    }
    commitDecoded(acc, "&");
    cursor = amp + 1;
  }
}

function materialize(acc) {
  const copy = { ...acc };
  appendAlnum(copy, squashChars(acc.hold + acc.entityRaw));
  return copy;
}

function accIsGoLive(acc) {
  if (acc.goLive) return true;
  return acc.short !== null && acc.short.includes("provider") && acc.short.includes("live");
}

function combinedGoLive(main, side) {
  if (main.goLive || side.goLive || (main.tail + side.head).includes(GO_LIVE_PHRASE)) return true;
  if (main.length + side.length > 40 || main.short === null || side.short === null) return false;
  const all = main.short + side.short;
  return all.includes(GO_LIVE_PHRASE) || (all.includes("provider") && all.includes("live"));
}

/**
 * Streaming squash of one setext paragraph. Equivalent to squashHeading on the
 * joined paragraph (except that a character reference longer than
 * MAX_REFERENCE_LENGTH stays literal), but each line is consumed once. An open
 * tag is kept aside and dropped if it closes, so a `>` cannot make the scan
 * retry earlier `<`. `stats()` reports the work done, for the tests.
 */
export function createGoLiveScan() {
  const main = createSquashAcc();
  const side = createSquashAcc();
  let inComment = false;
  let commentHold = "";
  let tagHold = "";
  let inTag = false;

  function resetSide() {
    side.length = 0;
    side.tail = "";
    side.head = "";
    side.goLive = false;
    side.short = "";
    side.hold = "";
    side.entityRaw = "";
  }

  function emitPlain(text) {
    const data = tagHold + text;
    tagHold = "";
    let cursor = 0;
    while (cursor < data.length) {
      if (inTag) {
        const close = data.indexOf(">", cursor);
        if (close === -1) {
          pushLiteral(side, data.slice(cursor));
          return;
        }
        resetSide();
        inTag = false;
        cursor = close + 1;
        continue;
      }
      const open = data.indexOf("<", cursor);
      if (open === -1) {
        pushLiteral(main, data.slice(cursor));
        return;
      }
      if (open > cursor) pushLiteral(main, data.slice(cursor, open));
      const after = data[open + 1];
      if (after === undefined) {
        tagHold = "<";
        return;
      }
      if (after === "/") {
        const letter = data[open + 2];
        if (letter === undefined) {
          tagHold = "</";
          return;
        }
        if (/[a-z]/i.test(letter)) {
          inTag = true;
          resetSide();
          cursor = open + 2;
          continue;
        }
        pushLiteral(main, "</");
        cursor = open + 2;
        continue;
      }
      if (/[a-z]/i.test(after)) {
        inTag = true;
        resetSide();
        cursor = open + 1;
        continue;
      }
      pushLiteral(main, "<");
      cursor = open + 1;
    }
  }

  function feed(piece) {
    const data = commentHold + piece;
    commentHold = "";
    let cursor = 0;
    while (cursor < data.length) {
      if (inComment) {
        const close = data.indexOf("-->", cursor);
        if (close === -1) {
          const held = /--?$/.exec(data.slice(cursor));
          commentHold = held ? held[0] : "";
          return;
        }
        cursor = close + 3;
        inComment = false;
        continue;
      }
      const start = data.indexOf("<!--", cursor);
      if (start === -1) {
        const tail = data.slice(cursor);
        const held = /<(?:!--?|!)?$/.exec(tail);
        if (held) {
          emitPlain(tail.slice(0, held.index));
          commentHold = held[0];
        } else {
          emitPlain(tail);
        }
        return;
      }
      emitPlain(data.slice(cursor, start));
      cursor = start + 4;
      inComment = true;
    }
  }

  function isGoLive() {
    const mainView = materialize(main);
    if (!inTag) return accIsGoLive(mainView);
    return combinedGoLive(mainView, materialize(side));
  }

  function stats() {
    return { steps: main.steps + side.steps, maxPending: Math.max(main.maxPending, side.maxPending) };
  }

  return { feed, isGoLive, stats };
}

function unquoteMarkers(text) {
  return text.replace(/^(?:[ \t]*>)+/, "");
}

/**
 * Setext underlines, decided in one forward pass. The paragraph since the last
 * blank line or fenced code block is squashed as it grows; an underline never
 * walks back over it. Flags may count an extra go-live heading, never a missing one.
 *
 * `hidden` is the fence flags from hiddenLineFlags. A fenced line, fence lines
 * included, is code, not paragraph text: it must not feed the scan, and it ends
 * the paragraph before it, because a fence can interrupt a paragraph and the
 * dashes after one are a thematic break. A line after a fence end that could not
 * be pinned down (`uncertain`) is read as visible, as the ATX count reads it.
 */
function setextGoLiveFlags(lines, hidden) {
  const flags = new Array(lines.length).fill(false);
  let scan = createGoLiveScan();
  let paragraph = 0;
  // `paragraph` is 0 only while the scan is fresh, so a reset with nothing read is a no-op.
  const endParagraph = () => {
    if (paragraph === 0) return;
    scan = createGoLiveScan();
    paragraph = 0;
  };
  for (let index = 0; index < lines.length; index += 1) {
    if (hidden.fenced[index] && !hidden.uncertain[index]) {
      endParagraph();
      continue;
    }
    const unquoted = unquoteMarkers(lines[index]);
    if (!/\S/.test(unquoted)) {
      endParagraph();
      continue;
    }
    if (SETEXT_UNDERLINE.test(unquoted) && paragraph > 0 && scan.isGoLive()) flags[index] = true;
    const inner = unquoted.replace(CONTAINER_PREFIX, "");
    scan.feed(paragraph === 0 ? inner : ` ${inner}`);
    paragraph += 1;
  }
  return flags;
}

/**
 * HTML headings outside a fence. The sticky copy only runs at a real `<hN`
 * start, and only while a `>` is still ahead, so an unclosed `<h1` cannot retry.
 */
function countHtmlGoLiveHeadings(unfenced, matches = isGoLiveHeading) {
  const lastGt = unfenced.lastIndexOf(">");
  if (lastGt === -1) return 0;
  let count = 0;
  let searchFrom = 0;
  while (searchFrom <= lastGt) {
    HTML_HEADING_START.lastIndex = searchFrom;
    const start = HTML_HEADING_START.exec(unfenced);
    if (!start || start.index > lastGt) break;
    HTML_HEADING.lastIndex = start.index;
    const html = HTML_HEADING.exec(unfenced);
    if (!html) {
      searchFrom = start.index + 1;
      continue;
    }
    if (matches(html[1])) count += 1;
    const next = HTML_HEADING.lastIndex;
    searchFrom = next > start.index ? next : start.index + 1;
  }
  HTML_HEADING_START.lastIndex = 0;
  HTML_HEADING.lastIndex = 0;
  return count;
}

/**
 * Conservative: a heading containing "provider go-live", or a short heading
 * naming both "provider" and "live", counts as go-live.
 */
function isGoLiveHeading(text) {
  const squashed = squashHeading(text);
  if (squashed.includes("providergolive")) return true;
  return squashed.length <= 40 && squashed.includes("provider") && squashed.includes("live");
}

function collectSections(body, { revertPlan = false } = {}) {
  const normalizedBody = normalizeText(body);
  const fences = fencedCodeRanges(normalizedBody);
  const lines = normalizedBody.split("\n");
  const hidden = hiddenLineFlags(lines);
  const headings = [];
  let goLiveHeadings = 0;
  let revertHeadings = 0;
  let detailsDepth = 0;
  const details = [];
  let offset = 0;
  const setextGoLive = setextGoLiveFlags(lines, hidden);

  lines.forEach((line, index) => {
    if (revertPlan) {
      const tags = line.match(/<details\b|<\/details\s*>/gi) ?? [];
      details[index] = detailsDepth > 0 || tags.length > 0;
      if (!hidden.fenced[index] && !hidden.comment[index]) for (const tag of tags) detailsDepth = Math.max(0, detailsDepth + (tag.startsWith("</") ? -1 : 1));
      if (!hidden.fenced[index] || hidden.uncertain[index]) {
        const text = anyHeadingText(lines, index);
        const setext = index + 1 < lines.length && SETEXT_UNDERLINE.test(lines[index + 1]);
        if ((text !== null && squashHeading(text) === "revertplan") || (setext && squashHeading(line) === "revertplan")) revertHeadings += 1;
      }
    }
    const match = line.match(SECTION_HEADING_LINE);
    const visibleToCount = !hidden.fenced[index] || hidden.uncertain[index];
    // Every heading outside a code fence that mentions Provider go-live counts toward
    // duplicates, in any heading form and even where the splitter skips it (an HTML
    // comment, the legacy ``` ranges), so a second copy can never stand in for the real one.
    if (visibleToCount) {
      const anyText = anyHeadingText(lines, index);
      if ((anyText !== null && isGoLiveHeading(anyText)) || setextGoLive[index]) goLiveHeadings += 1;
    }
    // A heading after an unresolved fence still splits sections so ordinary PR
    // bodies keep working; its checkboxes stay hidden.
    if (match && visibleToCount) {
      const key = revertPlan && squashHeading(match[1]) === "revertplan" ? normalizeHeading(REVERT_PLAN_HEADING) : normalizeHeading(match[1]);
      if (!hidden.comment[index] && !isInsideRange(fences, offset) && !(revertPlan && key === "revert plan" && details[index])) {
        headings.push({ index, key, heading: match[1].trim() });
      }
    }
    offset += line.length + 1;
  });

  // HTML headings, possibly several per line or spanning lines, anywhere outside
  // a code fence (an unclosed tag runs to the end).
  const unfenced = lines.map((line, index) => (hidden.fenced[index] && !hidden.uncertain[index] ? "" : line)).join("\n");
  goLiveHeadings += countHtmlGoLiveHeadings(unfenced);
  if (revertPlan) revertHeadings += countHtmlGoLiveHeadings(unfenced, (text) => squashHeading(text) === "revertplan");

  const sections = new Map();
  headings.forEach((entry, position) => {
    const endLine = position + 1 < headings.length ? headings[position + 1].index : lines.length;
    const sectionLines = lines.slice(entry.index + 1, endLine);
    const content = sectionLines.join("\n").trim();
    const parsedLines = sectionLines.map((line, offsetInSection) => ({
      line,
      hidden: hidden.fenced[entry.index + 1 + offsetInSection] || hidden.comment[entry.index + 1 + offsetInSection] || (revertPlan && details[entry.index + 1 + offsetInSection]),
    }));
    // Only the Provider go-live section uses `count`: every heading whose visible
    // text mentions "provider go-live", in any form, counts toward it.
    const count = entry.key === normalizeHeading(PROVIDER_GO_LIVE_HEADING) ? goLiveHeadings : revertPlan && entry.key === "revert plan" ? revertHeadings : 1;
    sections.set(entry.key, { heading: entry.heading, content, lines: parsedLines, count });
  });

  return sections;
}

function findPlaceholder(content, placeholders) {
  const normalizedContent = normalizeText(content);
  return placeholders.find((placeholder) => normalizedContent.includes(placeholder)) ?? null;
}

function hasCheckedBox(content) {
  return /^\s*[-*]\s+\[[xX]\]/m.test(content);
}

function hasExecutableCommand(content) {
  const blocks = [...content.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)];

  return blocks.some((block) =>
    block[1]
      .split("\n")
      .map((line) => line.trim())
      .some((line) => line && !line.startsWith("#")),
  );
}

function validateGenericSection(content, rule) {
  const errors = [];
  const placeholder = findPlaceholder(content, rule.placeholders);

  if (placeholder) {
    errors.push(`replace template placeholder text in "${rule.heading}"`);
  }

  const withoutPlaceholders = rule.placeholders.reduce(
    (current, candidate) => current.replaceAll(candidate, " "),
    content,
  );

  if (!hasMeaningfulText(withoutPlaceholders)) {
    errors.push(`add non-empty content to "${rule.heading}"`);
  }

  return errors;
}

function validateChoiceSection(content, rule) {
  const withoutBoilerplate = CHOICE_SECTION_BOILERPLATE[rule.heading].reduce(
    (current, candidate) => current.replaceAll(candidate, " "),
    content,
  );

  if (hasCheckedBox(content) || hasMeaningfulText(withoutBoilerplate)) {
    return [];
  }

  return [`mark or explain "${rule.heading}" instead of leaving it blank`];
}

function validateVerificationSection(content, rule) {
  const errors = [];
  const placeholder = findPlaceholder(content, rule.placeholders);

  if (placeholder) {
    errors.push('replace template placeholder text in "Verification"');
  }

  if (!hasExecutableCommand(content)) {
    errors.push('add at least one real command to "Verification"');
  }

  const nonCommandContent = stripCodeBlocks(content);
  const withoutPlaceholders = rule.placeholders.reduce(
    (current, candidate) => current.replaceAll(candidate, " "),
    nonCommandContent,
  );
  const withoutCheckboxLines = withoutPlaceholders.replace(/^\s{0,3}[-*]\s+\[[ xX]\].*$/gm, " ");

  if (!hasCheckedBox(content) && !hasMeaningfulText(withoutCheckboxLines)) {
    errors.push('record an outcome in "Verification"');
  }

  return errors;
}


export const PROVIDER_GO_LIVE_HEADING = "Provider go-live";

export const PROVIDER_GO_LIVE_REPO = "optomachina/Overdrafter";

export const PROVIDER_GO_LIVE_NA_MIN_REASON_LENGTH = 12;

export const PROVIDER_GO_LIVE_NA_PLACEHOLDERS = new Set([
  "",
  "x",
  "n/a",
  "na",
  "-",
  "tbd",
  "todo",
  "none",
  "n.a",
]);

/** Signature on the automatic envelope review item (Blaine Wilson, Oct 16, 2026). */
export const PROVIDER_GO_LIVE_AUTO_SIGNATURE = "Grok Bot under Blaine Wilson standing authority";

/**
 * `na: true` items may be marked N/A with a written justification when the
 * item does not apply to the stage being enabled. Items with `na: false` always
 * need a real evidence link. Legal stance items are never N/A, with one
 * exception: the ITAR/EAR item may be N/A for a US only provider. `auto: true`
 * items are filled by the renderer, pre-checked with the automatic signature;
 * the gate never asks a human for evidence on them, but rejects the section
 * when the automatic line is missing or unticked.
 */
export const PROVIDER_GO_LIVE_REQUIRED_ITEMS = [
  {
    id: "provider-check",
    group: "Envelope",
    text: "provider:check green. Evidence:",
    label: "provider:check green",
    match: /provider:check\s+green/i,
    na: false,
  },
  {
    id: "envelope-reviewer",
    group: "Envelope",
    text: `Envelope reviewed (automatic). Signed: ${PROVIDER_GO_LIVE_AUTO_SIGNATURE}.`,
    label: "envelope reviewed (automatic)",
    // [ \t] only, matches runtime. Ticked checkbox line; must not match prose,
    // an unticked box, or "not envelope reviewed".
    match: /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)+\[x\][ \t]*(?:[*_]+[ \t]*)?envelope reviewed \(automatic\)/im,
    na: false,
    auto: true,
  },
  {
    id: "worker-secret",
    group: "Live",
    text: "Worker adapter deployed and Secret Manager secret created (name only). Evidence:",
    label: "worker adapter and Secret Manager secret",
    match: /secret manager secret/i,
    na: true,
  },
  {
    id: "egress",
    group: "Live",
    text: "Stable egress verified (`verify:xometry-egress`-style). Evidence:",
    label: "stable egress verified",
    match: /stable egress verified/i,
    na: true,
  },
  {
    id: "admission-revision",
    group: "Admit",
    text: "Approved admission revision (`generic_dispatch_enabled=true`) reviewed and applied. Admit SQL is never committed by a generator. Evidence:",
    label: "approved admission revision (generic_dispatch_enabled=true)",
    match: /approved admission revision/i,
    na: true,
  },
  {
    id: "rollout",
    group: "Admit",
    text: "`automatic_quote_collection` rollout and org enablement. Evidence:",
    label: "automatic_quote_collection rollout and org enablement",
    match: /automatic_quote_collection/i,
    na: true,
  },
  {
    id: "certification",
    group: "Admit",
    text: "Certification run evidence:",
    label: "certification run evidence",
    match: /certification run evidence/i,
    na: true,
  },
  {
    id: "supplier-switch",
    group: "Admit",
    text: "Per-supplier on/off switch in the admin dashboard (immediate, worker-enforced at generic dispatch) and optional admin daily quote cap (default unlimited), via OVD-829. Evidence:",
    label: "per-supplier on/off switch in the admin dashboard",
    match: /per-supplier on\/off switch/i,
    na: false,
  },
  {
    id: "no-passwords",
    group: "Legal stance",
    text: "No stored customer passwords; encrypted session tokens only. Evidence:",
    label: "no stored customer passwords, encrypted session tokens only",
    match: /no stored customer passwords/i,
    na: false,
  },
  {
    id: "export-control",
    group: "Legal stance",
    text: "ITAR/EAR controlled or uncertain uploads are blocked to foreign providers (Geomiq, Weerg) and to LLMs. Evidence:",
    label: "ITAR/EAR controlled or uncertain uploads blocked to foreign providers and LLMs",
    match: /ITAR\/EAR/i,
    na: true,
  },
];

export const PROVIDER_GO_LIVE_GROUPS = ["Envelope", "Live", "Admit", "Legal stance"];

// Any list marker ("-", "*", "+", "1.", "1)"), optionally inside a blockquote.
// Nested markers ("- - [ ]", "> 1. - [ ]") count too.
// Group 1 is only used for the `>` test (a quoted line never satisfies a required item).
export const CHECKBOX_LINE = /^([ \t]*(?:(?:>|(?:[-*+]|\d{1,9}[.)])[ \t])[ \t]*)*)(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\][ \t]*([^ \t\n\r\u2028\u2029][^\n\r\u2028\u2029]*)?$/;

export { detectProviderEnablement };

/**
 * Return whether the change enables a provider for customers. Path matches
 * alone never count; the registry and envelope list are compared per provider
 * and migrations are read statement by statement. A disable or kill switch
 * change returns false, and so does an edit to the gate itself (that needs a
 * reviewer note instead, see validateGateChangeNote).
 */
export function enablesProvider(options = {}) {
  return detectProviderEnablement(options).some((finding) => finding.kind === "provider");
}

export const REVERT_PLAN_HEADING = "Revert plan";
export const REVERT_PLAN_FIELDS = Object.freeze(["Revert", "State effects", "Kill switch", "Owner", "Verify after revert", "Blast radius"]);
const REVERT_TEMPLATE_TEXT = /\b(?:todo|tbd|n\/a|replace me|fill (?:in|out)|template text|affected surfaces or users|a command or check run)\b/i;

function revertOwners() {
  // The maintained YAML names model labels; its bot roster is the same
  // JSON-compatible routing fixture the existing Built-by parser consumes.
  const labels = readFileSync(new URL("../docs/agent-graph/model-routing.yaml", import.meta.url), "utf8");
  const roster = JSON.parse(readFileSync(new URL("./fixtures/agent-graph/model-routing.v2.yaml", import.meta.url), "utf8"));
  if (!Array.isArray(roster.bots)) throw new Error("missing owner roster");
  return new Set(["blaine", ...roster.bots.map((bot) => bot.id), ...[...labels.matchAll(/label:\s*"model:([a-z0-9-]+)"/g)].map((match) => match[1])]);
}

function revertFields(section) {
  const fields = new Map();
  const errors = [];
  for (const { line, hidden } of section.lines) {
    // Hidden or partially hidden field values cannot provide evidence.
    if (hidden || line.includes("<!--") || /<\/?details\b/i.test(line)) continue;
    const text = normalizeNfkc(decodeEntities(line)).replaceAll(/[\u200B-\u200F\u2060\uFEFF]/g, "");
    if (!/^ {0,3}-[ \t]/.test(text)) continue;
    const colon = text.indexOf(":");
    if (colon < 0 || colon > 40) continue;
    const match = [text, text.slice(text.indexOf("-") + 1, colon).trim(), text.slice(colon + 1).trim()];
    const key = squashHeading(match[1]);
    if (![...REVERT_PLAN_FIELDS, "Why none"].some((name) => squashHeading(name) === key)) continue;
    if (fields.has(key)) errors.push(`duplicate field "${match[1]}" in "${REVERT_PLAN_HEADING}"`);
    const value = match[2].replaceAll(/[`*]/g, "").trim();
    fields.set(key, value);
    if (!value || value === "-" || REVERT_TEMPLATE_TEXT.test(value)
        || /<[^>]+>/.test(value.replaceAll("<squash-sha>", ""))) errors.push(`placeholder or empty field "${match[1]}" in "${REVERT_PLAN_HEADING}"`);
  }
  return { fields, errors };
}

/** Optional until enforcement: callers must explicitly supply a door. */
export function validateRevertPlan(body, door, { owners, maxMs = 1000 } = {}) {
  if (door === "one-way") return { ok: true, required: false, errors: [] };
  const errors = [];
  const finish = () => ({ ok: errors.length === 0, required: true, errors });
  try {
    const started = performance.now();
    if (typeof body !== "string" || body.length > 256 * 1024) throw new Error("unscannable PR body");
    if (door !== "revertable") errors.push("unknown door; Revert plan is required (fail closed)");
    const section = collectSections(body, { revertPlan: true }).get(normalizeHeading(REVERT_PLAN_HEADING));
    if (!section) errors.push(`missing required section "${REVERT_PLAN_HEADING}"`);
    else {
      if (section.count !== 1) errors.push(`duplicate section "${REVERT_PLAN_HEADING}"`);
      const parsed = revertFields(section);
      errors.push(...parsed.errors);
      const get = (name) => parsed.fields.get(squashHeading(name)) ?? "";
      for (const field of REVERT_PLAN_FIELDS) if (!get(field)) errors.push(`missing field "${field}" in "${REVERT_PLAN_HEADING}"`);
      if (!/^(?:git revert (?:<squash-sha>|[a-f0-9]{7,40})(?:\s|$)|(?:revert )?(?:PR|branch)\s+\S+|https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$)/i.test(get("Revert"))) errors.push("Revert must name git revert <squash-sha>, a revert PR or a branch");
      const state = get("State effects").split(/;[ \t]*Why none:/i);
      if (state[0].trim().toLowerCase() !== "none") errors.push("State effects must be none; other state effects are one-way");
      const why = get("Why none") || state[1]?.trim() || "";
      if (why.length < 20 || REVERT_TEMPLATE_TEXT.test(why)) errors.push("Why none needs at least 20 characters explaining the absence of state effects");
      const kill = get("Kill switch");
      if (!/^(?:none\s*[-:;(]\s*[A-Za-z0-9][^\n]{11,}|[A-Za-z][A-Za-z0-9_.-]*\s*[,;:( -]+\s*default\s*(?:[:=]|is)?\s*off\b)/i.test(kill)) errors.push("Kill switch must name a flag with default off, or none with a reason");
      if (!(owners ?? revertOwners()).has(get("Owner").toLowerCase().replace(/^@/, ""))) errors.push("Owner must be a known routing id or blaine");
      if (!/^(?:[A-Za-z0-9_./-]+(?:\s+\S+)+|(?:check|run)\s*:\s*\S+|ci|provider-go-live|secret-scan)$/i.test(get("Verify after revert"))) errors.push("Verify after revert must name a command or check run");
      if (get("Blast radius").length < 12) errors.push("Blast radius needs at least 12 characters naming affected surfaces or users");
    }
    if (performance.now() - started > maxMs) throw new Error("parse timeout");
  } catch {
    errors.push("Revert plan parse error or timeout (fail closed)");
  }
  return finish();
}

export const GATE_CHANGE_HEADING = "Gate change review";

// A fence opener may follow list or blockquote markers ("- ~~~", "> ```").
export const FENCE_OPEN = /^([ \t]*(?:(?:[-*+]|\d{1,9}[.)]|>)[ \t]+)*)(`{3,}(?!`)|~{3,}(?!~))([^\n\r\u2028\u2029]*)$/;
const FENCE_CLOSE = /^([ \t]*)(`{3,}|~{3,})[ \t]*$/;
const LIST_MARKERS = /^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$))+/;
const LIST_MARKER = /([-*+]|\d{1,9}[.)])([ \t]*)/g;

function columnWidth(prefix, start = 0) {
  return [...prefix].reduce((width, char) => (char === "\t" ? width + 4 - (width % 4) : width + 1), start) - start;
}

/** Possible content columns of the list item(s) a line opens. */
function listContentColumns(line) {
  const prefix = line.match(LIST_MARKERS)?.[0];
  if (!prefix) return [];
  const columns = [];
  const lead = prefix.match(/^[ \t]*/)[0];
  let column = columnWidth(lead);
  for (const marker of prefix.slice(lead.length).matchAll(LIST_MARKER)) {
    const markerEnd = column + marker[1].length;
    const spaces = columnWidth(marker[2], markerEnd);
    // 1-4 spaces set the content column; 5+ (or none) mean one space and the rest is content.
    columns.push(markerEnd + 1);
    if (spaces >= 1 && spaces <= 4) columns.push(markerEnd + spaces);
    column = markerEnd + spaces;
  }
  return columns;
}

/**
 * The content columns of earlier list items that can hold a fence opened at
 * `column`: those at most 3 columns to its left. Columns are whole numbers, so
 * four lookups find them, however many columns the body has collected.
 */
export function fenceCandidateColumns(listColumns, column) {
  const candidates = [];
  for (let k = column - 3; k <= column; k += 1) {
    if (listColumns.has(k)) candidates.push(k);
  }
  return candidates;
}

/**
 * Flag the lines a reader never sees as real checklist content: lines inside a
 * fenced code block (``` or ~~~, fence lines included) and lines inside a
 * multi-line HTML comment. `uncertain` marks lines after a fence whose end
 * could not be pinned down.
 *
 * The scan is deliberately fail-closed: it may hide a line a reader sees (a
 * hidden checkbox can only fail an item), but must never show a fenced one.
 *
 * - A fence opens on a line of 3+ backticks or tildes, at any indent and also
 *   after list or blockquote markers (a backtick fence's info string may not
 *   hold a backtick). An unclosed fence runs to the end.
 * - Its container content column k is known for an opener after list markers;
 *   otherwise k is 0 or the content column of any earlier list item at most 3
 *   columns left of the opener. A bare marker line of the same character, at
 *   least as long, at column d closes the fence when k <= d <= k + 3 holds for
 *   every candidate k, ends the container and opens a new fence when d < k for
 *   every candidate, and otherwise leaves the rest of the body uncertain
 *   (hidden). If no candidate fits, the opener is really indented code, so
 *   hiding until the marker line at its own column is only ever extra hiding.
 * - A fence opened after a blockquote marker lasts until a line that does not
 *   start with ">", which ends the blockquote.
 * - An HTML comment opened by "<!--" outside a fence hides the following lines
 *   until a line containing "-->".
 */
function hiddenLineFlags(lines) {
  const fenced = [];
  const comment = [];
  const uncertain = [];
  const listColumns = new Set([0]);
  let fence = null;
  let inComment = false;
  let stuck = false;

  const openFence = (marker, column, prefix) => {
    if (/>/.test(prefix)) return { marker, quote: true };
    const afterList = LIST_MARKERS.test(prefix);
    const candidates = afterList ? [column] : fenceCandidateColumns(listColumns, column);
    return { marker, column, candidates };
  };

  for (const line of lines) {
    if (stuck) {
      fenced.push(true);
      comment.push(false);
      uncertain.push(true);
      continue;
    }

    if (fence?.quote) {
      if (/^[ \t]*>/.test(line)) {
        fenced.push(true);
        comment.push(false);
        uncertain.push(false);
        continue;
      }
      fence = null;
    } else if (fence) {
      fenced.push(true);
      comment.push(false);
      uncertain.push(false);
      const close = line.match(FENCE_CLOSE);
      if (close && close[2][0] === fence.marker[0] && close[2].length >= fence.marker.length) {
        const d = columnWidth(close[1]);
        const { candidates } = fence;
        if (candidates.length === 0) {
          if (d === fence.column) fence = null;
        } else if (d >= Math.max(...candidates) && d <= Math.min(...candidates) + 3) {
          fence = null;
        } else if (d < Math.min(...candidates)) {
          fence = openFence(close[2], d, close[1]);
        } else if (candidates.some((k) => d >= k && d <= k + 3) || candidates.some((k) => d < k)) {
          stuck = true;
        }
      }
      continue;
    }

    if (inComment) {
      fenced.push(false);
      comment.push(true);
      uncertain.push(false);
      inComment = stripComments(line, true).inComment;
      continue;
    }

    const open = line.match(FENCE_OPEN);
    if (open && !(open[2][0] === "`" && open[3].includes("`"))) {
      fence = openFence(open[2], columnWidth(open[1]), open[1]);
      fenced.push(true);
      comment.push(false);
      uncertain.push(false);
      continue;
    }

    for (const column of listContentColumns(line)) listColumns.add(column);
    fenced.push(false);
    comment.push(false);
    uncertain.push(false);
    inComment = stripComments(line, false).inComment;
  }

  return { fenced, comment, uncertain };
}

/**
 * Remove HTML comment text from one line. `inComment` says whether the line
 * starts inside a comment; the result says whether it ends inside one.
 */
function stripComments(line, inComment) {
  let text = "";
  let rest = line;
  let open = inComment;
  while (rest.length > 0) {
    if (open) {
      const close = rest.indexOf("-->");
      if (close === -1) return { text, inComment: true };
      rest = rest.slice(close + 3);
      open = false;
    } else {
      const start = rest.indexOf("<!--");
      if (start === -1) return { text: text + rest, inComment: false };
      text += rest.slice(0, start);
      rest = rest.slice(start + 4);
      open = true;
    }
  }
  return { text, inComment: open };
}

/** Parse checkbox lines from a section's `lines` ({ line, hidden }) entries. */
function parseCheckboxLines(sectionLines) {
  const boxes = [];
  let continuing = false;

  for (const { line, hidden } of sectionLines) {
    // A checkbox in a code fence or HTML comment is never a real answer.
    if (hidden) {
      continuing = false;
      continue;
    }

    // Comment text never counts: the box must be a checkbox as written, and only
    // its text outside "<!-- ... -->" can match an item or carry evidence.
    const visible = stripComments(line, false).text;
    const match = CHECKBOX_LINE.exec(line);
    if (match) {
      const visibleMatch = CHECKBOX_LINE.exec(visible);
      // A quoted checkbox ("> - [x] ...") is checked like any extra line but never
      // satisfies a required item. Group 3 is missing when the box has an empty tail.
      boxes.push({
        checked: match[2] !== " ",
        text: visibleMatch ? (visibleMatch[3] ?? "") : "",
        firstLine: visibleMatch ? (visibleMatch[3] ?? "") : "",
        line: visible,
        quoted: match[1].includes(">"),
      });
      continuing = true;
      continue;
    }

    const last = boxes.at(-1);
    if (continuing && last && /^[ \t]+\S/.test(line)) {
      last.text += ` ${visible.trim()}`;
    }
  }

  return boxes;
}

const URL_PATTERN = /https:\/\/[^\s<>)\]]+/gi;

function stripUrls(text) {
  return text.replace(/\[([^\]]*)\]\(https:\/\/[^)\s]*\)/gi, "$1").replace(URL_PATTERN, " ");
}

function stripEvidenceFromJustification(text) {
  return stripUrls(text)
    .replace(/`[^`]*`/g, " ")
    .replace(/\bevidence:/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isPlaceholderToken(token) {
  const normalized = token.toLowerCase().replace(/[.:]+$/g, "");
  return PROVIDER_GO_LIVE_NA_PLACEHOLDERS.has(normalized);
}

function parseNaAnnotation(text) {
  const marker = text.search(/\bN\/A\b/i);
  if (marker === -1) {
    return null;
  }

  let rest = text.slice(marker + 3).trimStart();
  if (rest.startsWith(":") || rest.startsWith("—") || rest.startsWith("-")) {
    rest = rest.slice(1).trimStart();
  }

  const stripped = stripEvidenceFromJustification(rest);
  const realTokens = stripped.split(/[ \t,;]+/).filter((token) => token && !isPlaceholderToken(token));
  const realText = realTokens.join(" ");
  if (realText.length < PROVIDER_GO_LIVE_NA_MIN_REASON_LENGTH) {
    return { valid: false };
  }

  return { valid: true, reason: realText };
}

const GITHUB_EVIDENCE = new RegExp(
  `^https://github\\.com/${PROVIDER_GO_LIVE_REPO}/(pull/\\d+|actions/runs/\\d+|commit/[0-9a-f]{7,40})(?:[/?#].*)?$`,
  "i",
);
const LINEAR_EVIDENCE = /^https:\/\/linear\.app\/[^/\s]+\/issue\/OVD-\d+(?:[/?#].*)?$/i;

function trimUrl(url) {
  return url.replace(/[),.;]+$/g, "");
}

/**
 * Real evidence is a GitHub PR, Actions run, or commit URL in this repo, or a
 * full Linear OVD issue URL. A bare OVD-n and any other https URL are not
 * evidence. Links are checked by format here; verifyEvidenceLinks additionally
 * confirms GitHub links exist. No check reads what a link says.
 */
export function extractEvidenceLinks(text) {
  const links = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimUrl(match[0]);
    if (GITHUB_EVIDENCE.test(url) || LINEAR_EVIDENCE.test(url)) {
      links.push(url);
    }
  }

  return links;
}

const EVIDENCE_HINT =
  "add an evidence link (a GitHub PR, run, or commit URL in optomachina/Overdrafter, or a full Linear OVD issue URL)";

function checkboxResult(box, label, naAllowed) {
  const na = parseNaAnnotation(box.text);

  if (na) {
    if (!naAllowed) {
      return `N/A is not allowed for "${label}"`;
    }
    if (!box.checked) {
      return `check N/A item "${label}"`;
    }
    if (!na.valid) {
      return `mark N/A with a real written justification for "${label}"`;
    }
    return null;
  }

  if (!box.checked) {
    return `check "${label}"`;
  }

  if (extractEvidenceLinks(box.text).length === 0) {
    return `${EVIDENCE_HINT} for "${label}"`;
  }

  return null;
}

/**
 * Check only the Provider go-live section of a body (for renderers).
 */
export function validateProviderGoLive(body) {
  return validateProviderGoLiveSection(body, [{ file: "(rendered body)", reason: "provider go-live requested" }]);
}

/**
 * An edit to the gate itself needs a "Gate change review" section naming a
 * reviewer and linking evidence, because the gate runs from the base copy and
 * cannot check its own replacement.
 */
export function validateGateChangeNote(body, findings = []) {
  const section = collectSections(body).get(normalizeHeading(GATE_CHANGE_HEADING));
  if (!section) {
    const files = findings.map((finding) => finding.file).join(", ");
    return [`missing required section "${GATE_CHANGE_HEADING}" for a PR that edits the PR body gate (${files})`];
  }
  const errors = [];
  if (!/^\s*(?:[-*]\s+)?Reviewer:\s*[A-Za-z][^\n]{2,}$/m.test(section.content)) {
    errors.push(`name a reviewer in "${GATE_CHANGE_HEADING}" with a line "Reviewer: <name>"`);
  }
  if (extractEvidenceLinks(section.content).length === 0) {
    errors.push(`${EVIDENCE_HINT} in "${GATE_CHANGE_HEADING}"`);
  }
  return errors;
}

/** Text of the automatic envelope line, ticked or not (bold markers allowed). */
const AUTO_LINE_TEXT = /^[*_]*[ \t]*envelope reviewed \(automatic\)/i;

function validateProviderGoLiveSection(body, findings) {
  const sections = collectSections(body);
  const section = sections.get(normalizeHeading(PROVIDER_GO_LIVE_HEADING));
  const errors = [];

  if (!section) {
    const why = findings.map((finding) => `${finding.file}: ${finding.reason}`).join("; ");
    return [`missing required section "${PROVIDER_GO_LIVE_HEADING}" for a PR that enables a provider (${why})`];
  }

  // Only one section is validated, so a second copy could hide an unticked first one.
  if (section.count > 1) {
    errors.push(`"${PROVIDER_GO_LIVE_HEADING}" appears ${section.count} times; keep exactly one section`);
  }

  const boxes = parseCheckboxLines(section.lines);
  if (boxes.length === 0) {
    errors.push(`add Provider go-live checkboxes to "${PROVIDER_GO_LIVE_HEADING}"`);
  }

  const unused = [...boxes];
  for (const required of PROVIDER_GO_LIVE_REQUIRED_ITEMS) {
    if (required.auto) {
      // The automatic line must be present and ticked. A ticked line satisfies it;
      // an unticked real line is consumed and rejected; lookalikes such as
      // "not envelope reviewed" are never consumed and fail as extra lines.
      const ticked = unused.findIndex((box) => !box.quoted && box.checked && AUTO_LINE_TEXT.test(box.firstLine));
      if (ticked !== -1) {
        unused.splice(ticked, 1);
        continue;
      }
      const unticked = unused.findIndex((box) => !box.quoted && !box.checked && AUTO_LINE_TEXT.test(box.firstLine));
      if (unticked !== -1) {
        unused.splice(unticked, 1);
        errors.push(`"${required.label}" must be ticked`);
        continue;
      }
      errors.push(`missing Provider go-live item "${required.label}"`);
      continue;
    }
    const index = unused.findIndex((box) => !box.quoted && required.match.test(box.text));
    if (index === -1) {
      errors.push(`missing Provider go-live item "${required.label}"`);
      continue;
    }

    const error = checkboxResult(unused.splice(index, 1)[0], required.label, required.na);
    if (error) {
      errors.push(error);
    }
  }

  for (const box of unused) {
    const label = box.text.trim() || "an extra Provider go-live checkbox";
    const error = checkboxResult(box, label, true);
    if (error) {
      errors.push(error);
    }
  }

  return errors;
}

/**
 * Collect the evidence links in the Provider go-live section so a caller can
 * check that they resolve.
 */
export function collectGoLiveEvidenceLinks(body) {
  const section = collectSections(body).get(normalizeHeading(PROVIDER_GO_LIVE_HEADING));
  if (!section) {
    return [];
  }

  return [
    ...new Set(
      parseCheckboxLines(section.lines)
        .filter((box) => box.checked && !parseNaAnnotation(box.text))
        .flatMap((box) => extractEvidenceLinks(box.text)),
    ),
  ];
}

export function collectGateEvidenceLinks(body) {
  const section = collectSections(body).get(normalizeHeading(GATE_CHANGE_HEADING));
  return section ? [...new Set(extractEvidenceLinks(section.content))] : [];
}

/**
 * Confirm GitHub evidence links exist, through the GitHub REST API. Linear
 * issue references are accepted by shape only.
 *
 * @returns {Promise<string[]>} error messages, empty when every link resolves.
 */
export async function verifyEvidenceLinks(links, { fetchImpl = fetch, token } = {}) {
  const errors = [];
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "overdrafter-pr-body-gate" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  for (const link of links) {
    const match = GITHUB_EVIDENCE.exec(link);
    if (!match) continue;
    const route = match[1]
      .replace(/^pull\//, "pulls/")
      .replace(/^commit\//, "commits/");
    try {
      const response = await fetchImpl(`https://api.github.com/repos/${PROVIDER_GO_LIVE_REPO}/${route}`, { headers });
      if (!response.ok) {
        errors.push(`evidence link does not resolve (HTTP ${response.status}): ${link}`);
      }
    } catch (error) {
      errors.push(`could not verify evidence link ${link}: ${error instanceof Error ? error.message : error}`);
    }
  }

  return errors;
}

/**
 * Validate that a PR body includes all required sections and obvious non-placeholder content.
 * The Provider go-live section is required only when the diff enables a
 * provider for customers (see provider-enablement-detect.mjs).
 *
 * @param {string} body
 * @param {{ changedFiles?: string[], diffText?: string }} [options]
 */
export function validatePrBody(body, options = {}) {
  const sections = collectSections(body);
  const errors = [];

  for (const rule of REQUIRED_SECTIONS) {
    const section = sections.get(normalizeHeading(rule.heading));

    if (!section) {
      errors.push(`missing required section "${rule.heading}"`);
      continue;
    }

    const sectionErrors =
      rule.type === "verification"
        ? validateVerificationSection(section.content, rule)
        : rule.type === "choice"
          ? validateChoiceSection(section.content, rule)
          : validateGenericSection(section.content, rule);

    errors.push(...sectionErrors);
  }

  const findings = detectProviderEnablement(options);
  const providerFindings = findings.filter((finding) => finding.kind === "provider");
  const gateFindings = findings.filter((finding) => finding.kind === "gate");
  if (providerFindings.length > 0) {
    errors.push(...validateProviderGoLiveSection(body, providerFindings));
  }
  if (gateFindings.length > 0) {
    errors.push(...validateGateChangeNote(body, gateFindings));
  }

  if (Object.hasOwn(options, "door")) errors.push(...validateRevertPlan(body, options.door).errors);
  return {
    ok: errors.length === 0,
    errors,
  };
}

export function formatValidationErrors(errors) {
  return errors.map((error) => `- ${error}`).join("\n");
}

async function readStdin() {
  let input = "";

  for await (const chunk of process.stdin) {
    input += chunk;
  }

  return input;
}

const VALUE_FLAGS = new Map([
  ["--changed-files-from", "changedFilesFrom"],
  ["--diff-from", "diffFrom"],
  ["--base-ref", "baseRef"],
  ["--head-ref", "headRef"],
  ["--door", "door"],
]);

const BOOLEAN_FLAGS = new Map([
  ["--stdin", "stdin"],
  ["-", "stdin"],
  ["--skip-unless-enabling", "skipUnlessEnabling"],
  ["--verify-links", "verifyLinks"],
]);

function parseCliArgs(argv) {
  const flags = new Set();
  const values = {};
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (BOOLEAN_FLAGS.has(arg)) {
      flags.add(BOOLEAN_FLAGS.get(arg));
    } else if (arg === "--door") {
      if (Object.hasOwn(values, "door")) throw new Error("duplicate --door");
      values.door = argv[index + 1]?.startsWith("--") ? "" : (argv[++index] ?? "");
    } else if (VALUE_FLAGS.has(arg)) {
      values[VALUE_FLAGS.get(arg)] = argv[index + 1];
      index += 1;
    } else {
      positional.push(arg);
    }
  }

  return { flags, values, positional };
}

async function readLines(filePath) {
  return (await fs.readFile(filePath, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * CLI entrypoint for validating pull request bodies from a file or stdin.
 *
 *   --changed-files-from <path>  git diff --name-status --no-renames output
 *   --diff-from <path>           git diff --no-renames unified diff
 *   --skip-unless-enabling       pass without checking when the diff does not
 *                                enable a provider (the PR body gate uses this)
 *   --base-ref <ref>             git ref of the base (default HEAD^1); the
 *                                registry and envelope list are compared
 *                                between it and the head ref
 *   --head-ref <ref>             git ref of the head (default HEAD)
 *   --verify-links               confirm GitHub evidence links resolve
 */
// An absolute path keeps a writable PATH entry from substituting git. Set
// GIT_EXECUTABLE where git lives elsewhere (for example macOS).
const GIT_EXECUTABLE = process.env.GIT_EXECUTABLE ?? "/usr/bin/git";

export function gitShowReader(baseRef, headRef, { binary = GIT_EXECUTABLE, cwd = process.cwd() } = {}) {
  return (side, filePath) => {
    if (process.platform === "win32") throw new Error("git on Windows requires WSL");
    const ref = side === "base" ? baseRef : headRef;
    const options = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 };
    const entry = execFileSync(binary, ["ls-tree", "-z", ref, "--", `:(literal)${filePath}`], options);
    return entry ? execFileSync(binary, ["show", `${ref}:${filePath}`], options) : null;
  };
}

export async function main(argv = process.argv.slice(2), env = process.env, deps = {}) {
  let parsed;
  try { parsed = parseCliArgs(argv); } catch {
    console.error("Revert plan argument parse error (fail closed)");
    return 1;
  }
  const useStdin = parsed.flags.has("stdin");
  const filePath = useStdin ? null : parsed.positional[0];

  if (!useStdin && !filePath) {
    console.error(
      "Usage: npm run validate:pr-body -- <path-to-markdown> | --stdin [--changed-files-from <path>] [--diff-from <path>] [--skip-unless-enabling] [--verify-links]",
    );
    return 1;
  }

  for (const flag of VALUE_FLAGS.keys()) {
    if (argv.includes(flag) && parsed.values[VALUE_FLAGS.get(flag)] === undefined) {
      console.error(`Usage: ${flag} requires a path`);
      return 1;
    }
  }

  const body = useStdin ? await readStdin() : await fs.readFile(filePath, "utf8");
  const changedFiles = parsed.values.changedFilesFrom ? await readLines(parsed.values.changedFilesFrom) : [];
  const diffText = parsed.values.diffFrom ? await fs.readFile(parsed.values.diffFrom, "utf8") : "";
  const readFile = deps.readFile ?? gitShowReader(parsed.values.baseRef ?? "HEAD^1", parsed.values.headRef ?? "HEAD");
  const detection = { changedFiles, diffText, readFile, ...(Object.hasOwn(parsed.values, "door") ? { door: parsed.values.door } : {}) };
  const findings = detectProviderEnablement(detection);

  if (parsed.flags.has("skipUnlessEnabling") && findings.length === 0 && !Object.hasOwn(parsed.values, "door")) {
    console.log("No provider enablement or gate edit in this diff; no extra PR section required.");
    return 0;
  }

  let result;
  try { result = validatePrBody(body, detection); } catch (error) {
    if (!Object.hasOwn(parsed.values, "door")) throw error;
    console.error("Revert plan parse error or timeout (fail closed)");
    return 1;
  }
  const errors = [...result.errors];

  if (errors.length === 0 && findings.length > 0 && parsed.flags.has("verifyLinks")) {
    const links = new Set(collectGoLiveEvidenceLinks(body));
    if (findings.some((finding) => finding.kind === "gate")) {
      for (const link of collectGateEvidenceLinks(body)) links.add(link);
    }
    errors.push(...(await verifyEvidenceLinks([...links], { token: env.GITHUB_TOKEN })));
  }

  if (errors.length > 0) {
    console.error("PR body validation failed:");
    console.error(formatValidationErrors(errors));
    return 1;
  }

  const sectionNames = REQUIRED_SECTIONS.map((section) => section.heading);
  if (Object.hasOwn(parsed.values, "door") && parsed.values.door !== "one-way") sectionNames.push(REVERT_PLAN_HEADING);
  for (const finding of findings) {
    console.log(`${finding.kind === "gate" ? "Gate edit" : "Provider enablement"} detected: ${finding.file}: ${finding.reason}`);
  }
  if (findings.some((finding) => finding.kind === "provider")) sectionNames.push(PROVIDER_GO_LIVE_HEADING);
  if (findings.some((finding) => finding.kind === "gate")) sectionNames.push(GATE_CHANGE_HEADING);

  console.log(`PR body validation passed for sections: ${sectionNames.join(", ")}`);
  return 0;
}

if (isEntryPoint(import.meta.url)) {
  const exitCode = await main();
  process.exit(exitCode);
}
