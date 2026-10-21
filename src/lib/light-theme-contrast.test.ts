import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";
import config from "../../tailwind.config";
import { STATUS_TONE } from "@/components/quotes/status-tone";

// Exact paths only: new files are guarded by default. Each exception has an owner/scope reason.
const deferredFiles: Record<string, string> = {
  "pages/InternalHome.tsx": "Internal estimator dashboard deferred.",
  "pages/StateGallery.tsx": "Internal state-preview gallery deferred.",
  "components/quotes/XometryDebugCard.tsx": "Internal provider debug view deferred.",
  "components/quotes/ExtractionLabCard.tsx": "Internal extraction lab deferred.",
  "components/debug/ExtractionLauncher.tsx": "Debug-only extraction launcher deferred.",
  "components/quotes/QuoteSelectionFunctionBar.tsx": "Owned by OVD-1027; do not edit.",
  "concepts/ConceptsGallery.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-1/HomePage.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-1/PartPage.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-1/ProjectPage.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-2/HomePage.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-2/PartPage.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-2/ProjectPage.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-3/HomePage.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-3/PartPage.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-3/ProjectPage.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-4/HomePage.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-4/PartPage.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-4/ProjectPage.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-5/HomePage.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-5/PartPage.tsx": "Design concept preview deferred; not a customer workflow.",
  "concepts/set-5/ProjectPage.tsx": "Design concept preview deferred; not a customer workflow."
};
const srcRoot = path.resolve(import.meta.dirname, "..");
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : sourceFiles(file);
    return /\.tsx?$/.test(file) && !/\.(?:test|spec)\.tsx?$/.test(file) ? [file] : [];
  });
}
const hues = "red rose pink fuchsia purple violet indigo blue sky cyan teal emerald green lime yellow amber orange".split(" ");
function paleClasses(source: string) {
  // Include arbitrary variants (group-[...], [&>...]) so dark can be checked as a complete prefix.
  const pattern = new RegExp(`(?:[\\w-]+:|\\[[^\\]\\s]+\\]:|[\\w-]+-\\[[^\\]\\s]+\\]:)*!?(?:text|bg|border)-(?:${hues.join("|")})-(?:50|100|200|300|400)(?:/[\\d.]+)?(?![\\w-])`, "g");
  return [...source.matchAll(pattern)].map(([token]) => token)
    .filter((token) => !token.split(":").slice(0, -1).includes("dark"));
}

describe("source-wide light-theme contrast", () => {
  const files = sourceFiles(srcRoot).map((file) => path.relative(srcRoot, file));
  it("keeps every exception explicit, present and documented", () => {
    for (const [file, reason] of Object.entries(deferredFiles)) {
      expect(files).toContain(file);
      expect(reason.trim().length).toBeGreaterThan(10);
    }
  });
  it.each(files.filter((file) => !(file in deferredFiles)))("%s has no unconditional pale palette utilities", (file) => {
    expect(paleClasses(readFileSync(path.join(srcRoot, file), "utf8"))).toEqual([]);
  });
  it.each(hues)("covers every shade, fill and variant of %s", (hue) => {
    for (const shade of [50, 100, 200, 300, 400]) {
      for (const utility of ["text", "bg", "border"]) {
        for (const prefix of ["", "hover:", "focus:", "group-[.error]:", "[&>span]:"]) {
          const token = `${prefix}${utility}-${hue}-${shade}/80`;
          expect(paleClasses(token)).toEqual([token]);
          expect(paleClasses(`dark:${token}`)).toEqual([]);
        }
      }
    }
  });
  it("keeps exception text above 4.5:1 on its explicit card surface", () => {
    const css = readFileSync(path.join(srcRoot, "index.css"), "utf8");
    function color(token: string): string {
      const value = css.match(new RegExp(`--${token}:\\s*([^;]+);`))?.[1]?.trim();
      if (!value) throw new Error(`Missing theme token ${token}`);
      const reference = value.match(/^var\(--([\w-]+)\)$/);
      return reference ? color(reference[1]) : value;
    }
    function luminance(hex: string) {
      const channels = hex.slice(1).match(/../g)!.map((part) => {
        const channel = Number.parseInt(part, 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    }
    const contrast = (luminance(color("card")) + 0.05) / (luminance(color("destructive")) + 0.05);
    expect(STATUS_TONE.error).toContain("bg-card");
    expect(STATUS_TONE.error).toContain("text-destructive");
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  });
  it("compiles every STATUS_TONE utility and the spend bar fill with the real theme", async () => {
    const utilities = [...new Set([...Object.values(STATUS_TONE).flatMap((tone) => tone.split(" ")), "bg-foreground"])];
    const result = await postcss([tailwindcss({ ...config, content: [path.join(srcRoot, "**/*.{ts,tsx}")] })])
      .process(readFileSync(path.join(srcRoot, "index.css"), "utf8"), { from: path.join(srcRoot, "index.css") });
    const selectors = new Set<string>();
    result.root.walkRules((rule) => { selectors.add(rule.selector); });
    for (const utility of utilities) {
      const escaped = utility.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
      const pseudo = utility.startsWith("hover:") ? ":hover" : utility.startsWith("focus:") ? ":focus" : "";
      expect(selectors, utility).toContain(`.${escaped}${pseudo}`);
    }
    expect(STATUS_TONE.badge).not.toContain("font-mono");
    expect(STATUS_TONE.callout).toContain("font-sans");
    expect(STATUS_TONE.state).toContain("font-mono");
  }, 20000);
});
