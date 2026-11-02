// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("global reduced-motion styles", () => {
  it("overrides smooth HTML scrolling when reduced motion is requested", () => {
    // jsdom does not apply stylesheets, so verify the shipped CSS directly.
    const css = readFileSync(new URL("./index.css", import.meta.url), "utf8");
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*html\s*\{\s*scroll-behavior:\s*auto\s*;/,
    );
  });
});
