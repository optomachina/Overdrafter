import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileGlob, classifyPaths, loadSensitivePaths, checkAgentsParity } from "./lib/sensitive-paths.mjs";
import { validateAgentContract } from "./validate-agent-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsText = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
const recaptureHeading = "### Fixture-heal recapture and certification (OVD-796 §6.2, OVD-816)";
const classSHeading = "### Fixture-heal class S auto-merge (OVD-796 D8, OVD-816)";
const allowedGlobs = ["provider-integrations/*/locators.v*.json", "provider-integrations/*/fixtures/locators.v*.html"];
const runbookPath = path.join(root, "docs/runbooks/fixture-heal.md");

function section(text, heading) {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const next = lines.findIndex((line, index) => index > start && /^#{2,3} /.test(line));
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

const slug = (heading) => heading.toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");

describe("fixture-heal policy", () => {
  it("policy_lint_pack_only_paths", () => {
    const begin = "<!-- fixture-heal-class-s:begin -->";
    const end = "<!-- fixture-heal-class-s:end -->";
    expect(agentsText.split(begin)).toHaveLength(2);
    expect(agentsText.split(end)).toHaveLength(2);
    expect(agentsText.indexOf(begin)).toBeLessThan(agentsText.indexOf(end));
    const block = agentsText.slice(agentsText.indexOf(begin) + begin.length, agentsText.indexOf(end));
    const globs = [...block.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    expect(globs).toEqual(allowedGlobs);
    for (const glob of globs) {
      expect(glob.startsWith("provider-integrations/")).toBe(true);
      expect(glob).not.toContain("**");
      expect(glob).not.toContain("{");
    }
    const compiled = globs.map(compileGlob);
    const samples = ["provider-integrations/oshcut/locators.v2.json", "provider-integrations/quickparts/fixtures/locators.v3.html"];
    for (const sample of samples) expect(compiled.some((regex) => regex.test(sample)), sample).toBe(true);
    for (const sample of [
      "worker/src/adapters/oshcutProductionPortal.ts",
      "worker/src/adapters/fixtures/oshcut-locators.v2.html",
      "worker/src/fixtureHeal/sanity.ts",
      "provider-integrations/oshcut/golden/sample-plate.json",
      "provider-integrations/oshcut/manifest.v1.json",
      "provider-integrations/provider-registry.v1.json",
      "provider-integrations/oshcut/fingerprints/login.v1.json",
      "provider-integrations/oshcut/nested/locators.v2.json",
      "provider-integrations/locators.v2.json",
      "scripts/fixture-heal/heal-guard.mjs",
      "docs/sensitive-paths.json",
      "AGENTS.md",
    ]) expect(compiled.some((regex) => regex.test(sample)), sample).toBe(false);
    const config = loadSensitivePaths({ root });
    const classification = classifyPaths(samples, config);
    expect(classification.sensitive).toBe(true);
    expect(classification.files).toHaveLength(samples.length);
    for (const file of classification.files) expect(file.classes, file.path).toContain("provider_dispatch");
    expect(checkAgentsParity(agentsText, config)).toEqual([]);
    const policy = section(agentsText, classSHeading);
    for (const phrase of ["heal-guard", "class `S`", "Opus review", "QA pass", "OVD-823", "OVD-845", "git revert", "`docs/sensitive-paths.json` is not narrowed"]) {
      expect(policy).toContain(phrase);
    }
  });

  it("standing_recapture_authorization_is_scoped", () => {
    const policy = section(agentsText, recaptureHeading);
    for (const phrase of ["--stage=repair --capture", "golden", "quote-only", "admitted", "permissions-matrix", "checkout", "C&D", "3 propose-validate iterations", "2 live certification uploads", "human-engaged kill switch", "OVD-823"]) {
      expect(policy).toContain(phrase);
    }
    expect(policy).not.toContain("--stage=admit");
    expect(policy).not.toContain("--stage=envelope");
  });

  it("runbook_review_checklist", () => {
    expect(fs.existsSync(runbookPath)).toBe(true);
    const runbook = fs.readFileSync(runbookPath, "utf8");
    expect(runbook.match(/^#{1,2} .+$/gm)).toEqual([
      "# Fixture heal runbook (OVD-796)",
      "## What runs today",
      "## How drift is detected",
      "## When a supplier is paused",
      "## How a repair runs",
      "## Approvals",
      "## Kill switches",
      "## Rollback",
      "## Review checklist for a fixture-repair PR",
      "## What always needs a human",
    ]);
    const items = section(runbook, "## Review checklist for a fixture-repair PR").match(/^- \[ \] .+$/gm) ?? [];
    expect(items.length).toBeGreaterThanOrEqual(10);
    for (const phrase of ["heal-guard", "provider:check", "cleanup", "tolerance", "secrets", "kill switch", "Opus"]) {
      expect(items.join("\n").toLowerCase()).toContain(phrase.toLowerCase());
    }
    for (const phrase of ["Kill switches always win.", "never auto-released", "git revert", ...allowedGlobs, "OVD-823", "OVD-845"]) {
      expect(runbook).toContain(phrase);
    }
    for (const [, target] of runbook.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https?:|^#/.test(target)) continue;
      const [relative, anchor] = target.split("#");
      const destination = path.resolve(path.dirname(runbookPath), relative);
      expect(fs.existsSync(destination), target).toBe(true);
      if (anchor !== undefined && destination.endsWith(".md")) {
        const headings = [...fs.readFileSync(destination, "utf8").matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1]));
        expect(headings, target).toContain(anchor);
      }
    }
    expect(agentsText).toContain("](docs/runbooks/fixture-heal.md)");
    expect(fs.existsSync(path.resolve(root, "docs/runbooks/fixture-heal.md"))).toBe(true);
  });

  it("policy_text_has_no_forbidden_strings", () => {
    const sources = [fs.readFileSync(runbookPath, "utf8"), section(agentsText, recaptureHeading), section(agentsText, classSHeading), fs.readFileSync(fileURLToPath(import.meta.url), "utf8")];
    for (const source of sources) {
      for (const forbidden of ["OVD-" + "TPL", "VALIDATION" + " PLATE", "sb_" + "secret_", "ey" + "J"]) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it("agent contract stays valid with the new policy", () => {
    expect(validateAgentContract(root)).toEqual([]);
  });
});
