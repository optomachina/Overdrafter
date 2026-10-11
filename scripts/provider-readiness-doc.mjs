/**
 * Required structure of a reviewed provider's live-readiness doc. The
 * fixture:onboard live-stage template must generate its headings from this
 * constant so the generator and provider:check cannot drift.
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
 * `## ` heading. Fenced code blocks are not scanned for headings.
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
    if (sections[index].body.trim().length === 0) {
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
