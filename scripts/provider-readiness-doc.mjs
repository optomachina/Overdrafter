/**
 * Required structure of a reviewed provider's live-readiness doc. The
 * fixture:onboard live-stage template must generate its headings from this
 * constant so the generator and provider:check cannot drift.
 *
 * Residual: the content rule is a word count, not comprehension. Two real
 * but meaningless words ("see notes") still pass.
 */
export const REQUIRED_READINESS_HEADINGS = Object.freeze([
  "## What the code provides",
  "## Default-off switches",
  "## Known gaps before admission",
  "## Inputs only Blaine can provide",
  "## Admission revision template (not applied)",
]);

export const RECOMMENDED_READINESS_HEADINGS = Object.freeze([
  "## Permissions matrix (OVD-724)",
]);

/**
 * Sections whose honest answer can be "None." (no open gaps, no inputs needed).
 */
export const NONE_ALLOWED_READINESS_HEADINGS = Object.freeze([
  "## Known gaps before admission",
  "## Inputs only Blaine can provide",
]);

/**
 * Returns a list of problems (empty when the doc conforms). HTML comments are
 * removed before anything is read, so a commented-out section is absent.
 * Required `## ` lines must appear in order, each with a body before the next
 * `## ` heading. Fenced code blocks are not scanned for headings. A body
 * counts only when it holds at least two words outside a small placeholder
 * and stopword list (see sectionHasVisibleContent); "None." is accepted for
 * the sections in NONE_ALLOWED_READINESS_HEADINGS.
 */
export function validateReadinessDoc(text) {
  const problems = [];
  const sections = readSections(stripHtmlComments(typeof text === "string" ? text : ""));
  let cursor = 0;
  for (const heading of REQUIRED_READINESS_HEADINGS) {
    const index = sections.findIndex((section, i) => i >= cursor && section.heading === heading);
    if (index === -1) {
      problems.push(
        sections.some((section) => section.heading === heading)
          ? `heading out of order: ${heading}`
          : `missing heading: ${heading}`,
      );
      continue;
    }
    cursor = index + 1;
    const { body } = sections[index];
    const honestNone = NONE_ALLOWED_READINESS_HEADINGS.includes(heading) && isExplicitNone(body);
    if (!honestNone && !sectionHasVisibleContent(body)) {
      problems.push(`empty section: ${heading}`);
    }
  }
  return problems;
}

export function assertReadinessDoc(text, relativePath) {
  const problems = validateReadinessDoc(text);
  if (problems.length > 0) {
    throw new Error(`provider:check: readiness doc ${relativePath} is malformed: ${problems.join("; ")}`);
  }
}

/** Placeholder markers and template filler that never count as content. */
const PLACEHOLDER_WORDS = new Set([
  "tbd", "tbc", "todo", "wip", "fixme", "xxx", "none", "na", "later", "pending", "placeholder",
  "coming", "soon", "determined", "lorem", "ipsum", "dolor", "sit", "amet", "nbsp",
  "fill", "list", "add", "insert", "write", "describe", "update", "here",
]);

const STOPWORDS = new Set([
  "a", "an", "the", "to", "be", "in", "of", "on", "for", "and", "or", "is", "are", "it", "this",
  "that", "there", "see", "below", "above", "with", "will", "by", "at", "as", "out",
]);

const MIN_CONTENT_WORDS = 2;

/**
 * True when the body has at least two words that are neither placeholders
 * (tbd, todo, fixme, xxx, lorem ipsum, "to be determined", "fill in later",
 * ...) nor stopwords, after HTML comments, HTML space entities, and `###`+
 * sub-headings are removed. Case and punctuation are ignored.
 */
export function sectionHasVisibleContent(body) {
  const visible = stripHtmlComments(String(body))
    .replace(/&(?:nbsp|#160|#x0*a0);/gi, " ")
    .split(/\r?\n/)
    .filter((line) => !/^\s*#{3,}(\s|$)/.test(line))
    .join("\n");
  const content = normalizedWords(visible).filter((word) => !PLACEHOLDER_WORDS.has(word) && !STOPWORDS.has(word));
  return content.length >= MIN_CONTENT_WORDS;
}

function isExplicitNone(body) {
  return normalizedWords(stripHtmlComments(String(body))).join(" ") === "none";
}

/** Removes `<!-- ... -->`; an unclosed comment hides everything after it. */
function stripHtmlComments(text) {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

function normalizedWords(text) {
  const raw = String(text)
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const words = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === "n" && raw[i + 1] === "a") {
      words.push("na");
      i += 1;
    } else {
      words.push(raw[i]);
    }
  }
  return words;
}

function readSections(text) {
  const sections = [];
  let inFence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
    }
    if (!inFence && /^## /.test(line)) {
      sections.push({ heading: line.trimEnd(), body: "" });
    } else if (sections.length > 0) {
      sections.at(-1).body += `${line}\n`;
    }
  }
  return sections;
}
