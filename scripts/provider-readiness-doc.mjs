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
 * is only an HTML comment, whitespace, a `###`+ sub-heading, or a
 * placeholder token (TBD / TODO / N/A) is empty.
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

const PLACEHOLDER_TOKENS = new Set(["tbd", "todo", "na"]);

/**
 * HTML comments, whitespace, `###`+ sub-headings, and placeholder-only bodies
 * (TBD / TODO / N/A, case-insensitive, after stripping punctuation) are not
 * section content.
 */
export function sectionHasVisibleContent(body) {
  const visible = String(body)
    .replace(/<!--[\s\S]*?-->/g, "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*#{3,}(\s|$)/.test(line))
    .join("\n");
  const token = visible.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
  return token.length > 0 && !PLACEHOLDER_TOKENS.has(token);
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
