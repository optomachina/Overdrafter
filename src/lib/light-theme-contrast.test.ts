import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import legacyDestructive from "./__fixtures__/legacy-destructive-classes.json";
import { Input } from "@/components/ui/input";
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
  it("rejects destructive text outside STATUS_TONE without a dark error color", () => {
    const unsafe = (line: string) => /\btext-destructive(?=[\s"'`])/.test(line)
      && !/dark:(?:[\w[\].-]+:)*text-(?:red|rose)-[1-4]00\b/.test(line);
    expect(unsafe('className="bg-card text-destructive"')).toBe(true);
    expect(unsafe('className="text-destructive dark:text-foreground"')).toBe(true);
    expect(unsafe('className="text-destructive dark:text-red-300"')).toBe(false);
    // The shared error tone itself must keep an error colour in dark, not fall back to body text.
    expect(unsafe(`className="${STATUS_TONE.error}"`), "STATUS_TONE.error needs a dark error colour").toBe(false);
    const legacy = legacyDestructive as Record<string, string[]>;
    for (const file of Object.keys(legacy)) {
      expect(files, `legacy fixture names a file that is not scanned: ${file}`).toContain(file);
    }
    for (const file of files.filter((file) => file !== "components/quotes/status-tone.ts")) {
      // Exact pre-PR lines are grandfathered; new copies or changed lines fail.
      // Do not repair unrelated main failures in this contrast PR.
      const remaining = [...(legacy[file] ?? [])];
      for (const line of readFileSync(path.join(srcRoot, file), "utf8").split("\n").filter(unsafe)) {
        const index = remaining.indexOf(line.trim());
        expect(index, `${file}: route error through STATUS_TONE.error: ${line.trim()}`).toBeGreaterThanOrEqual(0);
        if (index >= 0) remaining.splice(index, 1);
      }
      // A fixed legacy line must also leave the fixture, so the list can only shrink.
      expect(remaining, `${file}: stale legacy entries; delete them from legacy-destructive-classes.json`).toEqual([]);
    }
    for (const file of ["components/chat/WorkspaceAccountMenu.tsx", "pages/ClientProject.tsx", "components/quotes/StripePaymentPanel.tsx"]) {
      expect(readFileSync(path.join(srcRoot, file), "utf8")).not.toMatch(/\btext-destructive\b/);
    }
  });
  it("compiles every STATUS_TONE utility and the spend bar fill with the real theme", async () => {
    const utilities = [...new Set([...Object.values(STATUS_TONE).flatMap((tone) => tone.split(" ")), "bg-foreground", "bg-muted-foreground", "bg-card", "bg-muted", "bg-ws-base", "bg-ws-raised",
      "placeholder:text-muted-foreground", "text-sky-800", "text-emerald-800", "text-amber-800",
      "text-rose-800", "text-cyan-800", "text-fuchsia-800", "dark:text-foreground",
      "group-[.destructive]:text-destructive-foreground", "group-[.destructive]:hover:text-destructive-foreground",
      "dark:group-[.destructive]:text-red-300", "dark:group-[.destructive]:hover:text-red-300",
      "[&>button]:text-foreground", "[&>button]:hover:text-foreground", "[&>button]:bg-accent",
      "[&>button]:hover:bg-accent", "hover:text-foreground", "bg-transparent", "text-muted-foreground",
    ])];
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
  // Every theme token muted text can sit on (OVD-1040). A new surface token must be added here.
  const mutedTextSurfaces = [
    "bg", "surface", "surface-2",
    "background", "card", "popover", "secondary", "muted", "accent", "input-background", "surface-elevated",
    "sidebar", "sidebar-accent",
    "ws-surface-base", "ws-surface-card", "ws-surface-inset", "ws-surface-raised",
    "ws-surface-shell", "ws-surface-deep", "ws-surface-overlay", "ws-accent-surface",
  ];
  // A family word anywhere in the name counts, in any case: --bg2, --surface_3,
  // --warning-surface, --ws-warning-surface, --warningSurface, --panelbg, --surfacealt.
  // Never exempt foreground/border/etc. by suffix: each exception needs review.
  // Name-only limit: a surface with an unrelated name (e.g. --panel) cannot be detected
  // here; add such a token to mutedTextSurfaces by hand.
  const surfaceFamilies = ["bg", "surface", "background", "card", "popover", "secondary", "muted", "accent", "sidebar", "base", "inset", "raised", "shell", "deep", "overlay"];
  const surfaceToken = new RegExp(`^--.*(?:${surfaceFamilies.join("|")})`, "i");
  for (const name of ["--ws-warning-surface", "--warning-surface", "--surface3", "--surface_3", "--bg2", "--warningSurface", "--panelbg", "--bgcolor", "--surfacealt", "--surfaces"]) {
    expect(surfaceToken.test(name), `${name}: surface guard must catch this name`).toBe(true);
  }
  const nonSurfaceTokens: Record<string, string> = {
    "radius-surface-sm": "Small surface corner radius length, not a color.",
    "radius-surface-lg": "Large surface corner radius length, not a color.",
    "card-foreground": "Card text ink.",
    "popover-foreground": "Popover text ink.",
    "secondary-foreground": "Secondary text ink.",
    "muted-foreground": "Muted text ink being measured.",
    "muted-ink": "Primitive graphite text ink.",
    "accent-foreground": "Accent text ink.",
    "accent-red": "Emphasis ink and destructive color, not a muted-text surface.",
    "ws-accent-border": "Workspace accent border color.",
    "sidebar-foreground": "Sidebar text ink.",
    "sidebar-primary": "Sidebar primary emphasis color, paired with its own foreground rather than muted text.",
    "sidebar-primary-foreground": "Sidebar primary text ink.",
    "sidebar-accent-foreground": "Sidebar accent text ink.",
    "sidebar-border": "Sidebar border color.",
    "sidebar-ring": "Sidebar focus ring color.",
  };
  const definedTokens = new Set(Object.values(themes).flatMap((variables) => Object.keys(variables)));
  for (const [token, reason] of Object.entries(nonSurfaceTokens)) {
    expect(definedTokens, `--${token}: stale non-surface exception; remove it from nonSurfaceTokens`).toContain(`--${token}`);
    expect(surfaceToken.test(`--${token}`), `--${token}: exception must belong to a guarded family`).toBe(true);
    expect(mutedTextSurfaces, `--${token}: covered surface cannot also be a non-surface exception`).not.toContain(token);
    expect(reason.trim().length).toBeGreaterThan(10);
  }
  for (const [theme, variables] of Object.entries(themes)) {
    for (const token of Object.keys(variables).filter((name) => surfaceToken.test(name))) {
      if (Object.prototype.hasOwnProperty.call(nonSurfaceTokens, token.slice(2))) continue;
      expect(mutedTextSurfaces, `${theme} ${token}: add surface to muted text contrast coverage (mutedTextSurfaces), or document a reviewed non-surface exception in nonSurfaceTokens`).toContain(token.slice(2));
    }
  }
  for (const surface of mutedTextSurfaces) {
    expect(themes.light, `--${surface}: covered surface must exist in :root`).toHaveProperty(`--${surface}`);
  }
  expect(themes.light["--muted-ink"]).toBe("#686359");
  expect(themes.dark["--muted-foreground"]).toBe("oklch(0.708 0 0)");
  const pairs: Record<string, string> = { ...STATUS_TONE, "stat-label": "bg-ws-inset text-foreground" };
  for (const status of ["not_requested", "queued", "requesting", "received", "failed", "canceled"] as const) {
    pairs[`request-${status}`] = getQuoteRequestStatusBadgeClassName(status);
  }
  for (let index = 0; index < 6; index++) {
    pairs[`assignee-${index}`] = getProjectAssigneeBubbleColor({ userId: String(index), email: null, givenName: null, familyName: null, fullName: null })!;
  }
  // Convert actual compiled colors to sRGB before alpha compositing. OKLCH
  // conversion also handles chromatic destructive tokens (not only gray).
  function channels(value: string): number[] {
    const oklch = value.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/);
    if (oklch) {
      const [, l, c, h, alpha] = oklch.map(Number);
      const a = c * Math.cos(h * Math.PI / 180), b = c * Math.sin(h * Math.PI / 180);
      const ll = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
      const mm = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
      const ss = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
      return [4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss,
        -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss,
        -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss]
        .map((v) => Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)))
        .concat(Number.isFinite(alpha) ? Number(alpha) : 1);
    }
    if (value.startsWith("#")) return value.slice(1).match(/../g)!.map((v) => parseInt(v, 16) / 255).concat(1);
    const rgb = value.match(/^rgb\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/);
    if (!rgb) throw new Error(`Unsupported color: ${value}`);
    return rgb.slice(1, 4).map((v) => Number(v) / 255).concat(Number(rgb[4] ?? 1));
  }
  function luminance(rgb: number[]): number {
    const linear = rgb.slice(0, 3).map((s) => s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  }
  function composite(fg: number[], bg: number[], opacity = 1): number[] {
    const alpha = fg[3] * opacity;
    return fg.slice(0, 3).map((v, i) => v * alpha + bg[i] * (1 - alpha)).concat(1);
  }
  const source = (file: string) => readFileSync(path.join(srcRoot, file), "utf8");
  const review = source("pages/ClientProjectReview.tsx");
  for (const label of ["Ready", "Warning", "Blocked"]) {
    const match = review.match(new RegExp(`<div className="([^"]+)">\\s*<p className="([^"]+)">${label}</p>`));
    expect(match, `${label} tile keeps its measured surface`).toBeTruthy();
    pairs[`review-${label}`] = `${match![1]} ${match![2]}`;
  }
  const activity = source("components/quotes/ActivityLog.tsx");
  expect(activity).toMatch(/className="[^"]*text-muted-foreground"\s*>\s*\{occurredAtLabel\}/);
  expect(activity).toMatch(/className="[^"]*text-muted-foreground">\{entry.detail\}/);
  for (const tone of ["active", "attention"]) {
    const classes = activity.match(new RegExp(`case "${tone}":\\s*return "([^"]+)"`))![1];
    for (const label of ["timestamp", "detail"]) pairs[`activity-${tone}-${label}`] = `${classes.replace("text-foreground", "")} text-muted-foreground`;
  }
  // These consumers have muted descendants: assert their real parent classes,
  // so changing a parent back to inset cannot leave a disconnected passing test.
  for (const [name, file, pattern] of [
    ["payment-confirmed", "components/quotes/StripePaymentPanel.tsx", /if \(paid\)[\s\S]*?<section className="([^"]+)"/],
    ["recommended-score", "components/quotes/ClientTradeoffSummary.tsx", /<div className="(rounded-lg border [^"]+)"/],
    ["internal-diagnostics", "pages/internal-job-detail/InternalJobPartRequirementCard.tsx", /showInternalDiagnostics \? \(\s*<div className="([^"]+)"/],
  ] as const) {
    pairs[name] = `${source(file).match(pattern)![1].replace("text-foreground", "")} text-muted-foreground`;
  }
  const orgInputs = [...source("components/chat/WorkspaceAccountMenu.tsx").matchAll(/<Input\b[\s\S]*?\/>/g)]
    .filter(([input]) => input.includes("orgDetailsDraft."));
  expect(orgInputs).toHaveLength(12);
  const inputClasses = orgInputs.map(([input]) => input.match(/className="([^"]+)"/)![1]);
  const renderedInputs = inputClasses.map((className) => renderToStaticMarkup(createElement(Input, { className }))
    .match(/class="([^"]+)"/)![1]);
  const skeletonClasses = [...source("components/quotes/ClientWorkspacePanelContent.tsx")
    .matchAll(/className="([^"]*animate-pulse[^"]*)"/g)].map((match) => match[1]);
  expect(skeletonClasses).toHaveLength(2);
  // Inventory of inherited parent surfaces used by this PR's foreground changes.
  for (const bg of ["background", "card", "muted", "accent", "ws-base", "ws-card", "ws-inset", "ws-raised", "ws-shell", "ws-deep", "ws-overlay"]) {
    pairs[`foreground/${bg}`] = `text-foreground bg-${bg}`;
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
      const bg = channels(resolve(background));
      const a = luminance(composite(channels(resolve(foreground)), bg));
      const b = luminance(bg);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    function compiled(classes: string, state = "base") {
      const declarations: Record<string, string> = {};
        // Tailwind emits the dark variant after base utilities. Read that cascade.
        result.root.walkRules((rule) => {
          for (const utility of classes.split(" ")) {
            if (utility.startsWith("dark:") && theme !== "dark") continue;
            if (utility.split(":").some((part) => ["hover", "focus"].includes(part) && part !== state)) continue;
            const escaped = utility.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
            const selector = `.${escaped}${utility.startsWith("placeholder:") ? "::placeholder" : /^(hover|focus):/.test(utility) ? `:${state}` : ""}`;
            const index = rule.selector.indexOf(selector);
            if (index < 0 || /[\w\\/-]/.test(rule.selector[index + selector.length] ?? " ")) continue;
            rule.walkDecls((decl) => { declarations[decl.prop] = decl.value; });
          }
        });
      return Object.fromEntries(Object.entries(declarations).map(([key, value]) => [key,
        value.replace(/var\(--tw-(?:text|bg)-opacity(?:, 1)?\)/g, "1")]));
    }
    const toast = source("components/ui/toast.tsx").match(/"(absolute right-2 top-2[^"\n]+)"/)![1];
    for (const state of ["base", "hover", "focus"]) {
      const color = compiled(toast, state).color;
      const bg = compiled("bg-destructive")["background-color"];
      const contrast = ratio(color, bg);
      reports.push(`${theme} destructive-toast-close/${state}: ${contrast.toFixed(3)}:1`);
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
    for (const classes of renderedInputs) {
      const value = compiled(classes.split(" ").filter((c) => !c.includes(":")).join(" "));
      const placeholder = compiled(classes.split(" ").filter((c) => c.startsWith("placeholder:")).join(" "));
      expect(resolve(placeholder.color)).not.toBe(resolve(value.color));
      const contrast = ratio(placeholder.color, value["background-color"]);
      reports.push(`${theme} org-placeholder: ${contrast.toFixed(3)}:1`);
      // Placeholders use the muted token, which clears AA on every surface since OVD-1040; never value ink.
      expect(contrast).toBeGreaterThanOrEqual(4.5);
    }
    for (const classes of skeletonClasses) {
      const fill = channels(resolve(compiled(classes)["background-color"]));
      const bg = channels(resolve(compiled("bg-accent")["background-color"]));
      // Tailwind pulse bottoms out at .5 opacity. Test the worst frame too.
      for (const opacity of [0.5, 1]) {
        const a = luminance(composite(fill, bg, opacity)), b = luminance(bg);
        const contrast = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        reports.push(`${theme} skeleton opacity ${opacity}: ${contrast.toFixed(3)}:1`);
        expect(contrast).toBeGreaterThanOrEqual(1.5);
      }
    }
    for (const [name, classes] of Object.entries(pairs)) {
      for (const state of ["base", "hover", "focus"]) {
        const declarations = compiled(classes, state);
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
    for (const surface of mutedTextSurfaces) {
      const contrast = ratio("var(--muted-foreground)", `var(--${surface})`);
      const reportLine = `${theme} muted-foreground on ${surface}: ${contrast.toFixed(3)}:1`;
      reports.push(reportLine);
      expect.soft(contrast, reportLine).toBeGreaterThanOrEqual(4.5);
    }
  }
  console.info(reports.join("\n"));
}, 20000);
