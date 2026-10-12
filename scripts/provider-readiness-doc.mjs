/**
 * Required structure of a reviewed provider's live-readiness doc. The
 * fixture:onboard live-stage template must generate its headings from this
 * constant so the generator and provider:check cannot drift.
 *
 * Residuals this check does not close: a literal `&nbsp;` entity as section
 * body (decoded nbsp / other whitespace is already empty).
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
 * Returns a list of problems (empty when the doc conforms). Required `## `
 * lines must appear in order, each with a non-empty body before the next
 * `## ` heading. Fenced code blocks are not scanned for headings. A body that
 * is only an HTML comment, whitespace, a `###`+ sub-heading, or
 * placeholder words (tbd, tbc, todo, wip, none, na, n/a, coming soon,
 * later, pending, placeholder) is empty.
 */
export function validateReadinessDoc(text) {
  const problems = [];
  const sections = readSections(typeof text === "string" ? text : "");
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
    if (!sectionHasVisibleContent(sections[index].body)) {
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

const PLACEHOLDER_WORDS = new Set([
  "tbd",
  "tbc",
  "todo",
  "wip",
  "none",
  "na",
  "later",
  "pending",
  "placeholder",
  "coming",
  "soon",
]);

/**
 * HTML comments, whitespace, `###`+ sub-headings, and bodies made only of
 * placeholder words (tbd, tbc, todo, wip, none, na, n/a, coming soon, later,
 * pending, placeholder — case-insensitive, ignoring punctuation and
 * whitespace) are not section content.
 */
export function sectionHasVisibleContent(body) {
  const visible = String(body)
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*#{3,}(\s|$)/.test(line))
    .join("\n");
  const words = placeholderWords(visible);
  return words.some((word) => !PLACEHOLDER_WORDS.has(word));
}

function placeholderWords(text) {
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
