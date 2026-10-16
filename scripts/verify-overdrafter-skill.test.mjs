// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FEATURE_SPECS, specsFor } from "../.agents/skills/verify-overdrafter/scripts/feature-specs.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(root, ".agents/skills/verify-overdrafter");
const read = (p) => readFileSync(path.join(skillDir, p), "utf8");

describe("verify-overdrafter skill structure", () => {
  it("has registering frontmatter", () => {
    const skill = read("SKILL.md");
    expect(skill).toMatch(/^---\nname: verify-overdrafter\ndescription: .+\n---/);
    for (const h of ["Launch", "Doctor", "Drive", "Evidence", "Cleanup", "Helpers"]) {
      expect(skill).toContain(`## ${h}`);
    }
  });

  it("indexes every feature file and each has the four H2s in order", () => {
    const index = read("features/README.md");
    const links = [...index.matchAll(/\]\(\.\/([\w-]+\.md)\)/g)].map((m) => m[1]);
    expect(links.sort()).toEqual(["auth.md", "provider.md", "quote.md"]);
    for (const f of links) {
      const h2 = [...read(`features/${f}`).matchAll(/^## (.+)$/gm)].map((m) => m[1]);
      expect(h2).toEqual(["Sub-features", "How to get to it (user POV)", "Driving it with Playwright", "Gotchas"]);
    }
  });

  it("maps every index feature to existing e2e specs and shipped scripts", () => {
    expect(Object.keys(FEATURE_SPECS).sort()).toEqual(["auth", "provider", "quote"]);
    for (const mode of ["fixture", "local"]) {
      for (const spec of specsFor(Object.keys(FEATURE_SPECS), mode)) {
        expect(existsSync(path.join(root, spec)), spec).toBe(true);
      }
    }
    for (const s of ["scripts/verify.sh", "scripts/feature-specs.mjs"]) {
      expect(existsSync(path.join(skillDir, s)), s).toBe(true);
      expect(read("SKILL.md")).toContain(s);
    }
    expect(() => specsFor(["nope"], "fixture")).toThrow(/unknown feature/);
  });

  it("keeps evidence gitignored and the skill listed in AGENTS.md", () => {
    expect(readFileSync(path.join(root, ".gitignore"), "utf8")).toContain("artifacts/verify-overdrafter/");
    expect(readFileSync(path.join(root, "AGENTS.md"), "utf8")).toContain("`verify-overdrafter`");
  });
});
