// @vitest-environment node

/**
 * Contract: the public meta descriptions in index.html (description,
 * og:description, twitter:description) repeat the approved landing paragraph
 * on "/" verbatim and never advertise the retired Pro offer.
 *
 * Titles are intentionally not pinned here.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexHtml = readFileSync(path.join(repoRoot, "index.html"), "utf8");
const landingSource = readFileSync(
  path.join(repoRoot, "src/components/quote-intelligence/AnonymousHomeLanding.tsx"),
  "utf8",
);

const normalizeWhitespace = (value) => value.replace(/\s+/g, " ").trim();

function extractLandingParagraph(source) {
  const match = /<\/h1>\s*<p\b[^>]*>([\s\S]*?)<\/p>/.exec(source);
  expect(match, "landing <p> after the h1").not.toBeNull();
  return normalizeWhitespace(match[1]);
}

function extractMetaContents(html, attribute, value) {
  const pattern = new RegExp(`<meta\\s+${attribute}="${value}"\\s+content="([^"]*)"`, "g");
  return [...html.matchAll(pattern)].map((match) => normalizeWhitespace(match[1]));
}

describe("public meta copy", () => {
  const landingParagraph = extractLandingParagraph(landingSource);
  const descriptions = {
    description: extractMetaContents(indexHtml, "name", "description"),
    "og:description": extractMetaContents(indexHtml, "property", "og:description"),
    "twitter:description": extractMetaContents(indexHtml, "name", "twitter:description"),
  };

  it("reads the approved landing paragraph", () => {
    expect(landingParagraph).toContain("Organize CAD files");
  });

  it("declares each description meta tag exactly once", () => {
    for (const [tag, contents] of Object.entries(descriptions)) {
      expect(contents, tag).toHaveLength(1);
    }
  });

  it("uses the landing paragraph for every description", () => {
    expect(descriptions).toEqual({
      description: [landingParagraph],
      "og:description": [landingParagraph],
      "twitter:description": [landingParagraph],
    });
  });

  it("does not advertise the retired Pro offer", () => {
    expect(indexHtml).not.toMatch(/with Pro/i);
    expect(indexHtml).not.toMatch(/\$49/);
    expect(indexHtml).not.toMatch(/Upgrade to Pro/i);
  });
});
