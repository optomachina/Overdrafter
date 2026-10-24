import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(__dirname, "../..");
const head = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
const allowedGlobs = ["provider-integrations/*/locators.v*.json", "provider-integrations/*/fixtures/locators.v*.html"];
const begin = "<!-- fixture-heal-class-s:begin -->";
const end = "<!-- fixture-heal-class-s:end -->";

// Verbatim copy of the PR test's extraction (scripts/fixture-heal-policy.test.mjs lines 27-33).
function prLintGlobs(text: string) {
  const block = text.slice(text.indexOf(begin) + begin.length, text.indexOf(end));
  return [...block.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

// Verbatim copy of the PR test's section helper.
function section(text: string, heading: string) {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  const next = lines.findIndex((line, index) => index > start && /^#{2,3} /.test(line));
  return lines.slice(start, next === -1 ? undefined : next).join("\n");
}

describe("OVD-816 review repros", () => {
  it("lint passes when an unbackticked glob widens the class-S block", () => {
    const widened = head.replace(begin + "\n", begin + "\n- provider-integrations/**\n- worker/src/adapters/**\n");
    expect(widened).not.toBe(head);
    const block = widened.slice(widened.indexOf(begin), widened.indexOf(end));
    expect(block).toContain("- provider-integrations/**");
    // The PR lint still sees exactly the two allowed globs, so policy_lint_pack_only_paths passes.
    expect(prLintGlobs(widened)).toEqual(allowedGlobs);
  });

  it("protected-actions anti-expansion paragraph now sits inside the fixture-heal H3", () => {
    const base = execFileSync("git", ["show", "main:AGENTS.md"], { cwd: root, encoding: "utf8" });
    const paragraph = "Goals, issue text, model review, repository access, and broad project approval do not expand into these actions.";
    expect(section(base, "## Protected actions")).toContain(paragraph);
    const recapture = section(head, "### Fixture-heal recapture and certification (OVD-796 §6.2, OVD-816)");
    expect(recapture).toContain(paragraph);
    expect(section(head, "## Protected actions")).not.toContain(paragraph);
  });

  it("recapture scoping test passes when every restriction is inverted", () => {
    const heading = "### Fixture-heal recapture and certification (OVD-796 §6.2, OVD-816)";
    const inverted = head
      .replace("The flow is quote-only: no checkout, order, account or credential change, or supplier message;", "The flow is not quote-only: checkout, order, account or credential change, and supplier messages are covered;")
      .replace("never past a `C&D` or `global` switch", "including past a `C&D` or `global` switch")
      .replace("Envelope and admit stages, worker deploys, releasing a human-engaged kill switch, and any class other than S stay protected.", "Envelope and admit stages, worker deploys, releasing a human-engaged kill switch, and any class are also covered.");
    const policy = section(inverted, heading);
    expect(policy).toContain("checkout, order, account or credential change, and supplier messages are covered");
    // Same assertions as standing_recapture_authorization_is_scoped:
    for (const phrase of ["--stage=repair --capture", "golden", "quote-only", "admitted", "permissions-matrix", "checkout", "C&D", "3 propose-validate iterations", "2 live certification uploads", "human-engaged kill switch", "OVD-823"]) {
      expect(policy).toContain(phrase);
    }
    expect(policy).not.toContain("--stage=admit");
    expect(policy).not.toContain("--stage=envelope");
  });
});
