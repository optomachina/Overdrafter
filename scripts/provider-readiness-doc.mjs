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
 * `## ` heading. HTML comments (including multi-line) and whitespace do not
 * count as content. Fenced code blocks are not scanned for headings.
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
    if (sections[index].body.replace(/[\s\u200b-\u200d\u2060\ufeff]/g, "").length === 0) {
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
  let inComment = false;
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine;
    if (!inComment && /^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
    }
    if (!inFence) {
      ({ line, inComment } = stripHtmlComments(line, inComment));
    }
    if (!inFence && /^## /.test(line)) {
      sections.push({ heading: line.trimEnd(), body: "" });
    } else if (sections.length > 0) {
      sections.at(-1).body += `${line}\n`;
    }
  }
  return sections;
}

function stripHtmlComments(line, inComment) {
  let out = "";
  let rest = line;
  let open = inComment;
  while (rest.length > 0) {
    if (open) {
      const end = rest.indexOf("-->");
      if (end === -1) {
        return { line: out, inComment: true };
      }
      rest = rest.slice(end + 3);
      open = false;
    } else {
      const start = rest.indexOf("<!--");
      if (start === -1) {
        out += rest;
        break;
      }
      out += rest.slice(0, start);
      rest = rest.slice(start + 4);
      open = true;
    }
  }
  return { line: out, inComment: open };
}
