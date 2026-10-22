import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import { describe, expect, it } from "vitest";
import config from "../../tailwind.config";
import { getProjectAssigneeBubbleColor } from "@/features/quotes/project-assignee";
import { getQuoteRequestStatusBadgeClassName } from "@/features/quotes/quote-request-status-badge";
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
  const pattern = new RegExp(`(?:[\\w/-]+:|\\[[^\\]\\s]+\\]:|[\\w-]+-\\[[^\\]\\s]+\\]:)*!?(?:text|bg|border)-(?:${hues.join("|")})-(?:50|100|200|300|400)(?:/[\\d.]+)?(?![\\w-])`, "g");
  const interpolated = /(?:text|bg|border)-(?:\$\{[^}]+\}(?:-(?:\d+|\$\{[^}]+\}))?|(?:red|rose|pink|fuchsia|purple|violet|indigo|blue|sky|cyan|teal|emerald|green|lime|yellow|amber|orange)-\$\{[^}]+\})/g;
  return [...source.matchAll(pattern), ...source.matchAll(interpolated)].map(([token]) => token)
    .filter((token) => !token.split(":").slice(0, -1).includes("dark"));
}

describe("source-wide light-theme contrast", () => {
  const files = sourceFiles(srcRoot).map((file) => path.relative(srcRoot, file));
  it("keeps every exception explicit, present and documented", () => {
    for (const [file, reason] of Object.entries(deferredFiles)) {
      expect(files).toContain(file);
      expect(paleClasses(readFileSync(path.join(srcRoot, file), "utf8")), `${file}: remove stale exception`).not.toEqual([]);
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
  it("detects interpolated palette utilities and named groups without mistaking them for dark variants", () => {
    for (const token of ["text-${hue}-200", "text-amber-${shade}", "group-hover/dark:text-amber-200"]) {
      expect(paleClasses(token)).toEqual([token]);
    }
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
      expect([...selectors].some((selector) => selector.includes(`.${escaped}${pseudo}`)), utility).toBe(true);
    }
    expect(STATUS_TONE.badge).not.toContain("font-mono");
    expect(STATUS_TONE.callout).toContain("font-sans");
    expect(STATUS_TONE.state).toContain("font-mono");
  }, 20000);
});

// Resolve the compiled utilities, including variants, instead of assuming token names
// imply a particular color. Browser coverage remains in the seeded journey.
it("keeps compiled status, assignee and stat-label pairs above AA in both themes", async () => {
  const result = await postcss([tailwindcss({ ...config, content: [path.join(srcRoot, "**/*.{ts,tsx}")] })])
    .process(readFileSync(path.join(srcRoot, "index.css"), "utf8"), { from: path.join(srcRoot, "index.css") });
  const themes: Record<string, Record<string, string>> = { light: {}, dark: {} };
  result.root.walkRules((rule) => {
    if (rule.selector !== ":root" && rule.selector !== ".dark") return;
    rule.walkDecls(/^--/, (decl) => { themes[rule.selector === ":root" ? "light" : "dark"][decl.prop] = decl.value; });
  });
  const pairs: Record<string, string> = { ...STATUS_TONE, "stat-label": "bg-ws-inset text-foreground" };
  for (const status of ["not_requested", "queued", "requesting", "received", "failed", "canceled"] as const) {
    pairs[`request-${status}`] = getQuoteRequestStatusBadgeClassName(status);
  }
  for (let index = 0; index < 6; index++) {
    pairs[`assignee-${index}`] = getProjectAssigneeBubbleColor({ userId: String(index), email: null, givenName: null, familyName: null, fullName: null })!;
  }
  function luminance(value: string): number {
    const gray = value.match(/^oklch\(([\d.]+) 0 0\)$/);
    if (gray) return Number(gray[1]) ** 3;
    const channels = value.startsWith("#")
      ? value.slice(1).match(/../g)!.map((part) => Number.parseInt(part, 16))
      : value.match(/^rgb\((\d+) (\d+) (\d+)(?: \/ 1)?\)$/)?.slice(1).map(Number);
    if (!channels || channels.length !== 3) throw new Error(`Unsupported opaque color: ${value}`);
    const linear = channels.map((channel) => {
      const s = channel / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  }
  const reports: string[] = [];
  for (const theme of ["light", "dark"]) {
    const variables = { ...themes.light, ...(theme === "dark" ? themes.dark : {}) };
    function resolve(value: string): string {
      return value.replace(/var\((--[\w-]+)\)/g, (_, token: string) => {
        if (!(token in variables)) throw new Error(`Missing ${token}`);
        return resolve(variables[token]);
      });
    }
    const ratio = (foreground: string, background: string) => {
      const a = luminance(resolve(foreground));
      const b = luminance(resolve(background));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    for (const [name, classes] of Object.entries(pairs)) {
      for (const state of ["base", "hover", "focus"]) {
        const declarations: Record<string, string> = {};
        // Tailwind emits the dark variant after base utilities. Read that cascade.
        result.root.walkRules((rule) => {
          for (const utility of classes.split(" ")) {
            if (utility.startsWith("dark:") && theme !== "dark") continue;
            if (/^(hover|focus):/.test(utility) && !utility.startsWith(`${state}:`)) continue;
            const escaped = utility.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
            const selector = `.${escaped}${/^(hover|focus):/.test(utility) ? `:${state}` : ""}`;
            if (rule.selector !== selector && !(utility.startsWith("dark:") && rule.selector.includes(selector))) continue;
            rule.walkDecls((decl) => { declarations[decl.prop] = decl.value; });
          }
        });
        const foreground = declarations.color;
        expect(foreground, `${name} has a compiled foreground`).toBeTruthy();
        // Text/action tones inherit any of the three supported bone surfaces.
        const backgrounds = declarations["background-color"] ? [declarations["background-color"]] : ["var(--card)", "var(--background)", "var(--accent)"];
        for (const background of backgrounds) {
          const contrast = ratio(foreground.replace(/var\(--tw-text-opacity(?:, 1)?\)/g, "1"), background.replace(/var\(--tw-bg-opacity(?:, 1)?\)/g, "1"));
          reports.push(`${theme} ${name}/${state} on ${background}: ${contrast.toFixed(3)}:1`);
          expect.soft(contrast, reports.at(-1)).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    for (const surface of ["background", "card", "accent"]) {
      reports.push(`${theme} muted-foreground on ${surface}: ${ratio("var(--muted-foreground)", `var(--${surface})`).toFixed(3)}:1`);
    }
  }
  console.info(reports.join("\n"));
}, 20000);
