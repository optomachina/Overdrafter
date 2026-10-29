// @vitest-environment node

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  detectProviderEnablement,
  parseEnvelopeProviders,
  parseNameStatus,
} from "./provider-enablement-detect.mjs";
import {
  REVERT_PLAN_FIELDS,
  validateRevertPlan,
  ANY_ATX_HEADING,
  CHECKBOX_LINE,
  CONTAINER_PREFIX,
  FENCE_OPEN,
  MAX_REFERENCE_LENGTH,
  PROVIDER_GO_LIVE_GROUPS,
  PROVIDER_GO_LIVE_HEADING,
  PROVIDER_GO_LIVE_AUTO_SIGNATURE,
  PROVIDER_GO_LIVE_REQUIRED_ITEMS,
  STREAM_SAFE_RUN,
  collectGoLiveEvidenceLinks,
  createGoLiveScan,
  enablesProvider,
  extractEvidenceLinks,
  fenceCandidateColumns,
  main,
  scanEntity,
  streamSafeText,
  validatePrBody,
  validateProviderGoLive,
  verifyEvidenceLinks,
} from "./validate-pr-body.mjs";

function buildValidPrBody() {
  return `
## Summary

Adds a pull-request body validator and documents the handoff expectation.

## Problem

PR descriptions were inconsistently filled out, so reviewers had to chase missing verification and risk context.

## Scope

- Adds a local validator script and a pull_request CI job.
- Updates workflow docs and repo-local PR skills.
- Does not change application runtime behavior.

## Verification

- [x] narrower commands were used intentionally and are listed below

Commands run:

\`\`\`bash
npm run test -- scripts/validate-pr-body.test.mjs
./scripts/symphony-preflight.sh
\`\`\`

Results:

- [x] all listed verification passed
- validator accepts a complete PR body and rejects template placeholders

Baseline failures or exceptions:

None.

## Tests

- Added unit coverage for valid, missing-section, placeholder, and empty-section cases.

## Migration notes

- [x] No migration impact

## Rollback / risk notes

- The validator could reject a PR body that uses the wrong headings.
- Roll back by removing the job and validator script if it becomes too noisy.

## Documentation

- [x] Docs updated

Details:

Updated contributor workflow docs and Codex skill instructions.
`;
}


const REGISTRY = "provider-integrations/provider-registry.v1.json";
const ENVELOPE = "worker/src/providerDispatchEnvelope.ts";
const MIGRATION = "supabase/migrations/20261012100000_ovd999_geomiq_admission.sql";

function unifiedDiff(files) {
  return files
    .map(
      ({ path: file, added = [], removed = [], status = "M" }) =>
        [
          `diff --git a/${file} b/${file}`,
          status === "A" ? "--- /dev/null" : `--- a/${file}`,
          status === "D" ? "+++ /dev/null" : `+++ b/${file}`,
          "@@ -1,1 +1,1 @@",
          ...removed.map((line) => `-${line}`),
          ...added.map((line) => `+${line}`),
        ].join("\n"),
    )
    .join("\n");
}

function nameStatus(files) {
  return files.map(({ path: file, status = "M" }) => `${status}\t${file}`);
}

/**
 * `contents` maps a path to {base, head} text. The detector reads the registry
 * and the envelope list from it, never from diff lines.
 */
function change(files, contents = {}) {
  const readFile = (side, file) => contents[file]?.[side] ?? null;
  return { changedFiles: nameStatus(files), diffText: unifiedDiff(files), readFile };
}

function merge(...changes) {
  return {
    changedFiles: changes.flatMap((entry) => entry.changedFiles),
    diffText: changes.map((entry) => entry.diffText).join("\n"),
    readFile: (side, file) => changes.map((entry) => entry.readFile(side, file)).find((text) => text !== null) ?? null,
  };
}

function registryJson(providers) {
  return JSON.stringify({
    schemaVersion: 1,
    providers: providers.map(([key, liveAdapter, egress = "none"]) => ({ key, liveAdapter, sessionSecrets: [], egress })),
  }, null, 2);
}

function envelopeSource(providers, layout = "multiline") {
  const entries = providers.map((provider) =>
    layout === "multiline"
      ? `  {\n    provider: "${provider}",\n    id: "${provider}-env",\n    version: 1,\n    requiredAdmission: "generic_dispatch",\n  },`
      : `  { requiredAdmission: "generic_dispatch", version: 1, id: "${provider}-env", provider: '${provider}' },`,
  );
  return `export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES: readonly ReviewedProviderDispatchEnvelope[] = [\n${entries.join("\n")}\n];\n`;
}

const REGISTRY_CHANGE = { path: REGISTRY, added: ["x"] };
const ENVELOPE_CHANGE = { path: ENVELOPE, added: ["x"] };

function registryChange(base, head) {
  return change([REGISTRY_CHANGE], { [REGISTRY]: { base: registryJson(base), head: registryJson(head) } });
}

function envelopeChange(base, head, layout) {
  return change([ENVELOPE_CHANGE], { [ENVELOPE]: { base: envelopeSource(base), head: envelopeSource(head, layout) } });
}

const ENABLE_REGISTRY = {
  ...registryChange([["fictiv", true, "stable_nat"], ["geomiq", false]], [["fictiv", true, "stable_nat"], ["geomiq", true, "stable_nat"]]),
};
const DISABLE_REGISTRY = registryChange([["fictiv", true, "stable_nat"], ["geomiq", false]], [["fictiv", false], ["geomiq", false]]);
const ENABLE_ENVELOPE = envelopeChange(["xometry"], ["xometry", "geomiq"]);
const REMOVE_ENVELOPE = envelopeChange(["xometry", "geomiq"], ["xometry"]);

const ENABLE_MIGRATION = {
  path: MIGRATION,
  status: "A",
  added: [
    "update private.quote_provider_admission_policies",
    "set admission_state = 'approved',",
    "    generic_dispatch_enabled = true",
    "where provider = 'geomiq'::public.vendor_name;",
  ],
};
const DISABLE_MIGRATION = {
  path: "supabase/migrations/20261012110000_ovd999_geomiq_disable.sql",
  status: "A",
  added: [
    "update private.quote_provider_admission_policies",
    "set admission_state = 'disabled',",
    "    generic_dispatch_enabled = false",
    "where provider = 'geomiq'::public.vendor_name;",
  ],
};

const reasons = (input) => detectProviderEnablement(input).map((finding) => finding.reason);

describe("detectProviderEnablement", () => {
  it("detects a pure enable of one provider", () => {
    expect(reasons(registryChange([["geomiq", false]], [["geomiq", true]]))).toEqual(['registry provider "geomiq" gains liveAdapter: true']);
    expect(detectProviderEnablement(registryChange([["geomiq", false]], [["geomiq", true]]))[0].kind).toBe("provider");
  });

  it("detects a swap that turns one provider on while turning another off", () => {
    const swap = registryChange(
      [["fictiv", true, "stable_nat"], ["geomiq", false]],
      [["fictiv", false], ["geomiq", true, "stable_nat"]],
    );
    expect(reasons(swap)).toEqual([
      'registry provider "geomiq" gains liveAdapter: true',
      'registry provider "geomiq" gains production egress ("stable_nat")',
    ]);
    expect(enablesProvider(swap)).toBe(true);
  });

  it("does not trigger on a pure disable", () => {
    expect(enablesProvider(DISABLE_REGISTRY)).toBe(false);
  });

  it("detects a registry provider gaining production egress", () => {
    expect(reasons(registryChange([["geomiq", true, "none"]], [["geomiq", true, "stable_nat"]]))).toEqual([
      'registry provider "geomiq" gains production egress ("stable_nat")',
    ]);
  });

  it("detects a new registry provider that is added already live", () => {
    expect(enablesProvider(registryChange([["fictiv", false]], [["fictiv", false], ["newco", true]]))).toBe(true);
  });

  it("does not trigger on a disabled new registry provider, a reformat, or a removed provider", () => {
    expect(enablesProvider(registryChange([["fictiv", true, "stable_nat"]], [["fictiv", true, "stable_nat"], ["newco", false]]))).toBe(false);
    expect(enablesProvider(registryChange([["fictiv", true, "stable_nat"]], [["fictiv", true, "stable_nat"]]))).toBe(false);
    expect(enablesProvider(registryChange([["fictiv", true, "stable_nat"], ["old", true, "stable_nat"]], [["fictiv", true, "stable_nat"]]))).toBe(false);
  });

  it("fails closed when the registry cannot be read", () => {
    const unreadable = change([REGISTRY_CHANGE], { [REGISTRY]: { base: "{}", head: "not json" } });
    expect(enablesProvider(unreadable)).toBe(true);
    expect(enablesProvider(change([REGISTRY_CHANGE]))).toBe(true);
  });

  it("detects a provider added to REVIEWED_PROVIDER_DISPATCH_ENVELOPES", () => {
    expect(reasons(ENABLE_ENVELOPE)).toEqual(['REVIEWED_PROVIDER_DISPATCH_ENVELOPES gains provider "geomiq"']);
  });

  it("reads the envelope list structurally, whatever the layout", () => {
    expect(reasons(envelopeChange(["xometry"], ["xometry", "geomiq"], "inline"))).toEqual([
      'REVIEWED_PROVIDER_DISPATCH_ENVELOPES gains provider "geomiq"',
    ]);
    const frozen = `export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES = Object.freeze([{ provider: "xometry" }, { "provider": "geomiq" }] as const);`;
    expect(parseEnvelopeProviders(frozen)).toEqual(new Set(["xometry", "geomiq"]));
    const base = envelopeSource(["xometry"]);
    const reformatted = envelopeSource(["xometry"], "inline");
    expect(enablesProvider(change([ENVELOPE_CHANGE], { [ENVELOPE]: { base, head: reformatted } }))).toBe(false);
  });

  it("does not trigger when an envelope is removed or only revised, and fails closed on unreadable source", () => {
    expect(enablesProvider(REMOVE_ENVELOPE)).toBe(false);
    const revised = envelopeSource(["xometry", "weerg"]).replace("version: 1", "version: 2");
    expect(enablesProvider(change([ENVELOPE_CHANGE], { [ENVELOPE]: { base: envelopeSource(["xometry", "weerg"]), head: revised } }))).toBe(false);
    expect(enablesProvider(change([ENVELOPE_CHANGE], { [ENVELOPE]: { base: "", head: "export const other = 1;" } }))).toBe(true);
    expect(
      enablesProvider(
        change([ENVELOPE_CHANGE], { [ENVELOPE]: { base: envelopeSource(["xometry"]), head: "export const REVIEWED_PROVIDER_DISPATCH_ENVELOPES = [{ provider: NAME }];" } }),
      ),
    ).toBe(true);
  });

  it("ignores provider literals outside the reviewed envelope list", () => {
    const head = `${envelopeSource(["xometry"])}export const other = [{ provider: "geomiq" }];\n`;
    expect(enablesProvider(change([ENVELOPE_CHANGE], { [ENVELOPE]: { base: envelopeSource(["xometry"]), head } }))).toBe(false);
  });

  it("flags an edit to the gate itself as a gate finding, not a provider finding", () => {
    const findings = detectProviderEnablement(change([{ path: "scripts/validate-pr-body.mjs", added: ["x"] }]));
    expect(findings).toEqual([{ file: "scripts/validate-pr-body.mjs", reason: "edits the PR body gate itself", kind: "gate" }]);
    expect(enablesProvider(change([{ path: ".github/workflows/pr-body-gate.yml", added: ["x"] }]))).toBe(false);
    expect(detectProviderEnablement(change([{ path: "scripts/lib/entry-point.mjs", added: ["x"] }])))
      .toEqual([{ file: "scripts/lib/entry-point.mjs", reason: "edits the PR body gate itself", kind: "gate" }]);
  });

  it("detects an admission migration that enables a provider", () => {
    const findings = detectProviderEnablement(change([ENABLE_MIGRATION]));
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe(MIGRATION);
  });

  it("detects an INSERT that seeds an enabled admission policy", () => {
    const insert = {
      path: "supabase/migrations/20261012120000_seed_enabled.sql",
      status: "A",
      added: [
        "insert into private.quote_provider_admission_policies (provider, admission_state, generic_dispatch_enabled)",
        "values ('geomiq'::public.vendor_name, 'approved', true)",
        "on conflict (provider) do nothing;",
      ],
    };
    expect(enablesProvider(change([insert]))).toBe(true);
  });

  it("does not trigger on a schema change whose name mentions admission", () => {
    const nowait = {
      path: "supabase/migrations/20261004130000_ovd628_generic_admission_nowait.sql",
      status: "A",
      added: [
        "create or replace function private.lock_generic_admission() returns void as $$",
        "begin",
        "  perform 1 from private.quote_provider_admission_policies where generic_dispatch_enabled is true for update nowait;",
        "end; $$ language plpgsql;",
      ],
    };
    expect(enablesProvider(change([nowait]))).toBe(false);
  });

  it("does not read a WHERE clause as an assignment: a disable migration is not enabling", () => {
    const disable = {
      path: "supabase/migrations/20261012130000_weerg_disable.sql",
      status: "A",
      added: [
        "update private.quote_provider_admission_policies",
        "   set admission_state = 'disabled', generic_dispatch_enabled = false",
        " where provider = 'weerg' and admission_state = 'approved' and generic_dispatch_enabled = true;",
      ],
    };
    expect(enablesProvider(change([disable]))).toBe(false);
    const oneLine = {
      path: "supabase/migrations/20261012130001_weerg_disable.sql",
      status: "A",
      added: ["update t set admission_state = 'disabled', generic_dispatch_enabled = false where provider = 'weerg' and admission_state = 'approved';"],
    };
    expect(enablesProvider(change([oneLine]))).toBe(false);
  });

  it("reads SET assignments, multi row inserts, and ON CONFLICT DO UPDATE as enabling", () => {
    const sql = (line) => change([{ path: "supabase/migrations/20261012140000_x.sql", status: "A", added: [line] }]);
    expect(enablesProvider(sql("update t set note = 'x', generic_dispatch_enabled = true where provider = 'a';"))).toBe(true);
    expect(enablesProvider(sql("update t set admission_state = 'approved'::text from s where s.id = t.id;"))).toBe(true);
    expect(
      enablesProvider(
        sql("insert into t (provider, admission_state, generic_dispatch_enabled) values ('a', 'disabled', false), ('b', 'approved', true);"),
      ),
    ).toBe(true);
    expect(
      enablesProvider(
        sql("insert into t (provider, generic_dispatch_enabled) values ('a', false) on conflict (provider) do update set generic_dispatch_enabled = true;"),
      ),
    ).toBe(true);
    expect(enablesProvider(sql("select * from t where generic_dispatch_enabled = true;"))).toBe(false);
  });

  it("does not trigger on a disabled seed or a comment that mentions enabling", () => {
    const seed = {
      path: "supabase/migrations/20260928081534_seed_rmfg_disabled_admission.sql",
      status: "A",
      added: [
        "-- generic_dispatch_enabled = true is set later by a human",
        "insert into private.quote_provider_admission_policies (provider, admission_state, generic_dispatch_enabled)",
        "values ('rmfg'::public.vendor_name, 'disabled', false);",
      ],
    };
    expect(enablesProvider(change([seed]))).toBe(false);
  });

  it("never triggers on disable, kill switch, or cease and desist changes", () => {
    expect(enablesProvider(DISABLE_REGISTRY)).toBe(false);
    expect(enablesProvider(change([DISABLE_MIGRATION]))).toBe(false);
    expect(enablesProvider(merge(DISABLE_REGISTRY, REMOVE_ENVELOPE, change([DISABLE_MIGRATION])))).toBe(false);
  });

  it("does not trigger on the review-only admit stub, generated output, or unrelated files", () => {
    const files = [
      { path: "provider-integrations/geomiq/admit/geomiq_admission_revision.sql.review", status: "A", added: ["    generic_dispatch_enabled = true,"] },
      { path: "worker/src/generated/providerRegistry.ts", added: ['    "liveAdapter": true,'] },
      { path: "src/App.tsx", added: ["const x = 1;"] },
    ];
    expect(enablesProvider(change(files))).toBe(false);
  });

  it("ignores a deleted file and an empty diff", () => {
    expect(enablesProvider(change([{ ...ENABLE_MIGRATION, status: "D" }]))).toBe(false);
    expect(enablesProvider({})).toBe(false);
  });

  it("parses name-status lines", () => {
    expect(parseNameStatus(["M\ta.ts", "D\tb.ts", "c.ts", ""])).toEqual([
      { status: "M", path: "a.ts" },
      { status: "D", path: "b.ts" },
      { status: "M", path: "c.ts" },
    ]);
  });
});

const EVIDENCE_PR = "https://github.com/optomachina/Overdrafter/pull/690";
const EVIDENCE_RUN = "https://github.com/optomachina/Overdrafter/actions/runs/38185671103";
const EVIDENCE_LINEAR = "https://linear.app/overdrafter/issue/OVD-690";

function evidenceFor(item, index) {
  return [EVIDENCE_PR, EVIDENCE_RUN, EVIDENCE_LINEAR][index % 3];
}

function itemLine(item, index, overrides = {}) {
  if (item.auto) {
    return `- [x] ${item.text}`;
  }
  if (overrides.na !== undefined) {
    const base = item.text.replace(/:$/, "").replace(/\s*Evidence$/, "");
    return `- [x] ${base} N/A: ${overrides.na}`;
  }
  const mark = overrides.checked === false ? " " : "x";
  return `- [${mark}] ${item.text} ${overrides.evidence ?? evidenceFor(item, index)}`;
}

function buildGoLiveSection(overridesById = {}) {
  const lines = ["", `## ${PROVIDER_GO_LIVE_HEADING}`, ""];
  for (const group of PROVIDER_GO_LIVE_GROUPS) {
    lines.push(`### ${group}`, "");
    PROVIDER_GO_LIVE_REQUIRED_ITEMS.forEach((item, index) => {
      if (item.group === group && overridesById[item.id] !== null) {
        lines.push(itemLine(item, index, overridesById[item.id]));
      }
    });
    lines.push("");
  }
  return lines.join("\n");
}

const ENABLING = ENABLE_REGISTRY;
const MANUAL_ITEMS = PROVIDER_GO_LIVE_REQUIRED_ITEMS.filter((item) => !item.auto);

function validate(section, options = ENABLING) {
  return validatePrBody(`${buildValidPrBody()}${section}`, options);
}

describe("validatePrBody", () => {
  it("accepts a complete PR body", () => {
    expect(validatePrBody(buildValidPrBody())).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("rejects a missing required section", () => {
    const body = buildValidPrBody().replace("## Problem", "## Context");
    const result = validatePrBody(body);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('missing required section "Problem"');
  });

  it("rejects template placeholder text", () => {
    const body = buildValidPrBody().replace(
      "Adds a pull-request body validator and documents the handoff expectation.",
      "Describe the change briefly.",
    );
    const result = validatePrBody(body);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('replace template placeholder text in "Summary"');
  });

  it("rejects intentionally empty sections", () => {
    const body = buildValidPrBody().replace(
      /## Rollback \/ risk notes[\s\S]*?## Documentation/,
      `## Rollback / risk notes

## Documentation`,
    );
    const result = validatePrBody(body);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('add non-empty content to "Rollback / risk notes"');
  });

  it("rejects unchecked migration and documentation boilerplate without details", () => {
    const body = buildValidPrBody()
      .replace("- [x] No migration impact", "- [ ] No migration impact")
      .replace("- [x] Docs updated", "- [ ] Docs updated")
      .replace("Updated contributor workflow docs and Codex skill instructions.", "");
    const result = validatePrBody(body);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('mark or explain "Migration notes" instead of leaving it blank');
    expect(result.errors).toContain('mark or explain "Documentation" instead of leaving it blank');
  });

  it("does not require Provider go-live for a path match with no enablement", () => {
    const files = [
      { path: ENVELOPE, added: ["// comment only"] },
      { path: "provider-integrations/geomiq/manifest.v1.json", added: ['  "status": "draft"'] },
      { path: "worker/scripts/deploy-cloud-run.sh", added: ["echo hi"] },
    ];
    const same = envelopeSource(["xometry"]);
    expect(validatePrBody(buildValidPrBody(), change(files, { [ENVELOPE]: { base: same, head: same } }))).toEqual({ ok: true, errors: [] });
  });

  it("requires a Gate change review note when the gate itself is edited", () => {
    const edit = change([{ path: "scripts/provider-enablement-detect.mjs", added: ["x"] }]);
    const missing = validatePrBody(buildValidPrBody(), edit);
    expect(missing.errors[0]).toMatch(/missing required section "Gate change review"/);
    const note = (text) => `${buildValidPrBody()}\n## Gate change review\n\n${text}\n`;
    expect(validatePrBody(note(`Reviewer: Ada Lovelace\nEvidence: ${EVIDENCE_PR}`), edit)).toEqual({ ok: true, errors: [] });
    expect(validatePrBody(note(`Evidence: ${EVIDENCE_PR}`), edit).errors[0]).toMatch(/name a reviewer/);
    expect(validatePrBody(note("Reviewer: Ada Lovelace\nEvidence: OVD-690"), edit).errors[0]).toMatch(/add an evidence link/);
  });

  it("passes a disable PR without the section", () => {
    const disable = merge(DISABLE_REGISTRY, REMOVE_ENVELOPE, change([DISABLE_MIGRATION]));
    expect(validatePrBody(buildValidPrBody(), disable)).toEqual({ ok: true, errors: [] });
  });

  it("rejects an enabling change without the section", () => {
    const result = validatePrBody(buildValidPrBody(), ENABLING);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/missing required section "Provider go-live" for a PR that enables a provider/);
    expect(result.errors[0]).toContain("liveAdapter");
  });

  it("accepts an enabling change with a real section", () => {
    expect(validate(buildGoLiveSection())).toEqual({ ok: true, errors: [] });
  });

  it("rejects unchecked boxes", () => {
    const result = validate(buildGoLiveSection({ "supplier-switch": { checked: false } }));
    expect(result.errors).toContain('check "per-supplier on/off switch in the admin dashboard"');
  });

  it("requires an evidence link on the per-supplier on/off switch item", () => {
    const result = validate(buildGoLiveSection({ "supplier-switch": { evidence: "tested locally" } }));
    expect(result.errors).toEqual([
      'add an evidence link (a GitHub PR, run, or commit URL in optomachina/Overdrafter, or a full Linear OVD issue URL) for "per-supplier on/off switch in the admin dashboard"',
    ]);
  });

  it("accepts the OVD-829 Linear issue URL as evidence on the per-supplier on/off switch item", () => {
    const result = validate(buildGoLiveSection({ "supplier-switch": { evidence: "https://linear.app/overdrafter/issue/OVD-829" } }));
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("treats the envelope review item as automatic but rejects it unticked or missing", () => {
    const auto = PROVIDER_GO_LIVE_REQUIRED_ITEMS.filter((item) => item.auto);
    expect(auto.map((item) => item.id)).toEqual(["envelope-reviewer"]);
    expect(auto[0].text).toContain(PROVIDER_GO_LIVE_AUTO_SIGNATURE);
    expect(PROVIDER_GO_LIVE_AUTO_SIGNATURE).toBe("Grok Bot under Blaine Wilson standing authority");
    expect(validate(buildGoLiveSection())).toEqual({ ok: true, errors: [] });
    expect(validate(buildGoLiveSection({ "envelope-reviewer": null }))).toEqual({
      ok: false,
      errors: ['missing Provider go-live item "envelope reviewed (automatic)"'],
    });
    const unchecked = buildGoLiveSection().replace("- [x] Envelope reviewed", "- [ ] Envelope reviewed");
    expect(unchecked).toContain(`- [ ] Envelope reviewed (automatic). Signed: ${PROVIDER_GO_LIVE_AUTO_SIGNATURE}.`);
    expect(validate(unchecked)).toEqual({ ok: false, errors: ['"envelope reviewed (automatic)" must be ticked'] });
    const uncheckedBold = buildGoLiveSection({ "envelope-reviewer": null }).replace(
      "## Provider go-live",
      "## Provider go-live\n\n- [ ] **Envelope reviewed (automatic).** Signed: x\n",
    );
    expect(validate(uncheckedBold)).toEqual({ ok: false, errors: ['"envelope reviewed (automatic)" must be ticked'] });
  });

  it("does not take the automatic envelope line from prose, a blockquote, or mid-line text", () => {
    for (const extra of [
      "The envelope reviewed (automatic) item is pending.",
      "> - [x] envelope reviewed (automatic)",
      "Note: - [x] envelope reviewed (automatic)",
    ]) {
      const section = buildGoLiveSection({ "envelope-reviewer": null }).replace(
        "## Provider go-live",
        `## Provider go-live\n\n${extra}\n`,
      );
      expect(validate(section).errors, extra).toContain('missing Provider go-live item "envelope reviewed (automatic)"');
    }
  });

  describe("ignores checkboxes inside fenced code blocks", () => {
    const withExtra = (extra, overrides = { "envelope-reviewer": null }) =>
      buildGoLiveSection(overrides).replace("## Provider go-live", `## Provider go-live\n\n${extra}\n`);
    const fences = [
      ["```", "```"],
      ["~~~", "~~~"],
      ["````md", "````"],
      ["   ```", "  ```"],
      ["~~~~", "~~~~~"],
    ];

    it("a fenced ticked automatic line alone does not satisfy the item", () => {
      for (const [open, close] of fences) {
        const result = validate(withExtra(`${open}\n- [x] envelope reviewed (automatic)\n${close}`));
        expect(result, open).toEqual({
          ok: false,
          errors: ['missing Provider go-live item "envelope reviewed (automatic)"'],
        });
      }
    });

    it("a fenced unticked line plus a real ticked line passes with no error", () => {
      for (const [open, close] of fences) {
        const result = validate(withExtra(`${open}\n- [ ] envelope reviewed (automatic)\n${close}`, {}));
        expect(result, open).toEqual({ ok: true, errors: [] });
      }
    });

    it("a fenced ticked line plus a real unticked line fails", () => {
      for (const [open, close] of fences) {
        const section = withExtra(`${open}\n- [x] envelope reviewed (automatic)\n${close}`, {}).replace(
          "- [x] Envelope reviewed",
          "- [ ] Envelope reviewed",
        );
        expect(validate(section), open).toEqual({
          ok: false,
          errors: ['"envelope reviewed (automatic)" must be ticked'],
        });
      }
    });

    it("closes a fence only on a matching, long enough, bare fence line", () => {
      // None of the inner lines close the ```` fence, so the ticked box stays fenced.
      for (const inner of ["```", "~~~~", "```` not a close", "    ````"]) {
        const result = validate(withExtra(`\`\`\`\`\n${inner}\n- [x] envelope reviewed (automatic)\n\`\`\`\``));
        expect(result.errors, inner).toEqual(['missing Provider go-live item "envelope reviewed (automatic)"']);
      }
    });

    it("an unclosed fence hides everything after it", () => {
      const result = validate(withExtra("~~~\n- [x] envelope reviewed (automatic)"));
      expect(result.ok).toBe(false);
    });

    it("hides a fence nested in a list item (4+ spaces), failing closed", () => {
      const nested = "- example\n\n    ~~~\n    - [x] envelope reviewed (automatic)\n    ~~~";
      expect(validate(withExtra(nested)).errors).toEqual([
        'missing Provider go-live item "envelope reviewed (automatic)"',
      ]);
      // A closer indented more than 3 columns past its opener does not close the fence.
      const deepClose = "~~~\n    ~~~\n- [x] envelope reviewed (automatic)\n~~~";
      expect(validate(withExtra(deepClose)).errors).toEqual([
        'missing Provider go-live item "envelope reviewed (automatic)"',
      ]);
    });

    it("rejects a second Provider go-live section that could hide an unticked first one", () => {
      const unticked = buildGoLiveSection().replace("- [x] Envelope reviewed", "- [ ] Envelope reviewed");
      const result = validate(`${unticked}\n${buildGoLiveSection()}`);
      expect(result).toEqual({
        ok: false,
        errors: ['"Provider go-live" appears 2 times; keep exactly one section'],
      });
    });

    it("counts a duplicate section in any heading form", () => {
      const missingAuto = buildGoLiveSection({ "envelope-reviewer": null });
      for (const heading of [
        "## Provider go-live ##",
        "  ## Provider go-live",
        "# Provider go-live",
        "### Provider go-live",
        "Provider go-live\n---",
        "### Provider go-live <!-- duplicate -->",
        "### **Provider go-live**",
        "## Provider `go-live`",
        "## Provider go&#8209;live (continued)",
        "## Provider g&#111;-live",
        "## Provider g&#x6f;-live",
        "> ## Provider go-live",
        "### Pro<span></span>vider go-live",
        "> Provider go-live\n> ---",
        "Provider\ngo-live\n---",
        "<h2>Provider go-live</h2>",
        "## Notes\n\n<h2>\nProvider go-live\n</h2>",
        "## Notes\n\n<h2>Notes</h2><h2>Provider go-live</h2>",
        "- item\n\n    ## Provider go-live",
        "- item\n\n\t## Provider go-live",
      ]) {
        const body = `${missingAuto}\n${heading}\n\n- [x] Envelope reviewed (automatic)\n`;
        expect(validate(body).errors, heading).toContain('"Provider go-live" appears 2 times; keep exactly one section');
      }
    });

    it("counts a duplicate section even where the legacy ``` scan would hide its heading", () => {
      const unticked = buildGoLiveSection().replace("- [x] Envelope reviewed", "- [ ] Envelope reviewed");
      const body = `\n## Notes\n\nInline \`\`\` text\n${unticked}\n\nInline \`\`\` text\n${buildGoLiveSection()}`;
      expect(validate(body).errors).toContain('"Provider go-live" appears 2 times; keep exactly one section');
    });

    it("hides a fence opened after a list or blockquote marker", () => {
      for (const extra of [
        "- ~~~\n  - [x] Envelope reviewed (automatic)\n  ~~~",
        "1. ```\n   - [x] Envelope reviewed (automatic)\n   ```",
        "> ~~~\n> - [x] Envelope reviewed (automatic)\n> ~~~",
      ]) {
        expect(validate(withExtra(extra)).errors, extra).toEqual([
          'missing Provider go-live item "envelope reviewed (automatic)"',
        ]);
      }
    });

    it("keeps a list-item fence open past a less indented marker line, which opens a new fence", () => {
      // CommonMark: the unindented ~~~ ends the list item and opens a new fence.
      // That new fence never closes, so it also hides the rest of the section.
      const extra = "- ~~~\n  x\n~~~\n- [x] Envelope reviewed (automatic)";
      expect(validate(withExtra(extra)).errors).toContain('missing Provider go-live item "envelope reviewed (automatic)"');
      const closed = "- ~~~\n  x\n~~~\n- [x] Envelope reviewed (automatic)\n~~~";
      expect(validate(withExtra(closed)).errors).toEqual([
        'missing Provider go-live item "envelope reviewed (automatic)"',
      ]);
    });

    it("does not close a top-level fence on an over-indented marker line", () => {
      const extra = "   ~~~\n      ~~~\n- [x] Envelope reviewed (automatic)\n   ~~~";
      expect(validate(withExtra(extra)).errors).toEqual([
        'missing Provider go-live item "envelope reviewed (automatic)"',
      ]);
    });

    it("hides the rest of the body when a fence end is ambiguous", () => {
      // After "- item", a fence at column 2 could be in the list item (k=2) or top level (k=0);
      // a closer at column 1 closes in one reading and opens a new fence in the other.
      const extra = "- item\n\n  ~~~\n - [x] Envelope reviewed (automatic)\n ~~~\n- [x] Envelope reviewed (automatic)";
      expect(validate(withExtra(extra)).ok).toBe(false);
    });

    it("ignores checkboxes inside a multi-line HTML comment", () => {
      const extra = "<!--\n- [x] Envelope reviewed (automatic)\n-->";
      expect(validate(withExtra(extra)).errors).toEqual([
        'missing Provider go-live item "envelope reviewed (automatic)"',
      ]);
      const passes = validate(withExtra("<!--\n- [ ] Envelope reviewed (automatic)\n-->", {}));
      expect(passes).toEqual({ ok: true, errors: [] });
    });

    it("never takes item text or evidence from an HTML comment", () => {
      const real = buildGoLiveSection().split("\n").find((line) => line.startsWith("- [x] provider:check green"));
      for (const replacement of [
        "- [x] Pending\n  <!-- provider:check green. Evidence: https://github.com/optomachina/Overdrafter/pull/123\n  This claim is commented out.\n  -->",
        "- [x] Pending <!-- provider:check green. Evidence: https://github.com/optomachina/Overdrafter/pull/123 -->",
        "- [x] provider:check green. Evidence: <!-- https://github.com/optomachina/Overdrafter/pull/123 -->",
        "- [x] provider:check green. Evidence: <!--\n  https://github.com/optomachina/Overdrafter/pull/123 -->",
      ]) {
        const result = validate(buildGoLiveSection().replace(real, replacement));
        expect(result.ok, replacement).toBe(false);
      }
    });

    it("reads checkboxes with every list marker and rejects unticked or quoted extras", () => {
      for (const extra of ["+ [ ] Envelope reviewed (automatic)", "1. [ ] Extra attestation", "2) [ ] Extra attestation", "> - [ ] Quoted attestation", "- - [ ] Nested attestation", "> 1. - [ ] Nested quoted"]) {
        expect(validate(withExtra(extra, {})).ok, extra).toBe(false);
      }
      // A ticked "+" or ordered line satisfies the automatic item; a quoted one never does.
      for (const line of ["+ [x] Envelope reviewed (automatic)", "1. [x] Envelope reviewed (automatic)", "- [x] __Envelope reviewed (automatic)__", "- - [x] Envelope reviewed (automatic)"]) {
        expect(validate(withExtra(line)), line).toEqual({ ok: true, errors: [] });
      }
      // The automatic text must be on the checkbox line itself, not a continuation.
      expect(validate(withExtra("- [x]\n  Envelope reviewed (automatic)")).errors).toContain(
        'missing Provider go-live item "envelope reviewed (automatic)"',
      );
      expect(validate(withExtra("> - [x] Envelope reviewed (automatic)")).errors).toContain(
        'missing Provider go-live item "envelope reviewed (automatic)"',
      );
    });

    it("ignores a fake Provider go-live section inside a tilde fence", () => {
      const fake = `~~~\n## Provider go-live\n\n- [x] envelope reviewed (automatic)\n~~~`;
      const broken = buildGoLiveSection().replace("- [x] Envelope reviewed", "- [ ] Envelope reviewed");
      const result = validate(`${broken}\n\n## Notes\n\n${fake}\n`);
      expect(result.errors).toContain('"envelope reviewed (automatic)" must be ticked');
    });

    describe("setext headings and fenced code", () => {
      const valid = buildGoLiveSection();
      const duplicate = '"Provider go-live" appears 2 times; keep exactly one section';
      const after = (extra) => validate(`${valid}\n${extra}\n`);

      it.each([
        ["a tilde fence, then dashes", "\n~~~\nProvider go-live\n~~~\n---"],
        ["a backtick fence, then equals signs", "\n```\nProvider go-live\n```\n==="],
        ["a long fence with an info string", "\n````md\nProvider go-live\n````\n---"],
        ["an indented fence", "\n   ~~~\n   Provider go-live\n   ~~~\n---"],
        ["a fence with a paragraph line inside", "\n~~~\ncode\nProvider go-live\n~~~\n---"],
        ["a fence in a list item", "\n- ~~~\n  Provider go-live\n  ~~~\n  ---"],
        ["a quoted fence, then dashes outside the quote", "\n> ~~~\n> Provider go-live\n> ~~~\n---"],
        ["an unclosed fence that runs to the end", "\n~~~\nProvider go-live\n---"],
        ["a paragraph cut off by a fence", "Provider go-live\n~~~\ncode\n~~~\n---"],
        ["a multi-line paragraph cut off by a fence", "Provider\ngo-live\n~~~\ncode\n~~~\n---"],
        ["two fences in a row", "\n~~~\nx\n~~~\n```\nProvider go-live\n```\n---"],
      ])("a dash or equals line after %s is not a heading", (_name, extra) => {
        // CommonMark: a fenced block ends the paragraph before it, so this is a code block
        // and a thematic break, and the checklist still has one Provider go-live section.
        expect(after(extra), extra).toEqual({ ok: true, errors: [] });
      });

      it.each([
        ["a closed fence", "~~~\ncode\n~~~\nProvider go-live\n---"],
        ["a closed fence and a multi-line heading", "~~~\ncode\n~~~\nProvider\ngo-live\n---"],
        ["a closed fence and a quoted heading", "~~~\ncode\n~~~\n> Provider go-live\n> ==="],
        ["a closed fence and a blank line", "~~~\ncode\n~~~\n\nProvider go-live\n---"],
        ["a heading before the fence", "Provider go-live\n---\n\n~~~\ncode\n~~~"],
        ["a heading between two fences", "~~~\nx\n~~~\nProvider go-live\n---\n~~~\ny\n~~~"],
      ])("still counts a real setext heading next to %s", (_name, extra) => {
        expect(after(`\n${extra}`).errors, extra).toContain(duplicate);
      });

      it("counts a real heading after a fence, and not the fenced copy before it", () => {
        const both = "\n~~~\nProvider go-live\n~~~\n---\n\nProvider go-live\n---";
        const result = after(both);
        expect(result.errors).toContain(duplicate);
        expect(result.errors).not.toContain('"Provider go-live" appears 3 times; keep exactly one section');
      });

      it("keeps counting after a fence whose end cannot be pinned down", () => {
        // The ambiguous closer leaves the rest of the body uncertain. An uncertain line is read as
        // visible, the same as for the ATX count, so a duplicate can never hide behind it.
        const ambiguous = "- item\n\n  ~~~\n - x\n ~~~\n";
        expect(after(`${ambiguous}Provider go-live\n---`).errors).toContain(duplicate);
        expect(after(`${ambiguous}## Provider go-live`).errors).toContain(duplicate);
      });
    });
  });

  it("matches only a ticked envelope-reviewed (automatic) checkbox line", () => {
    const { match } = PROVIDER_GO_LIVE_REQUIRED_ITEMS.find((item) => item.id === "envelope-reviewer");
    for (const line of [
      "- [x] envelope reviewed (automatic)",
      "* [X] Envelope reviewed (automatic). Signed: anyone.",
      "  - [x] envelope reviewed (automatic)",
      "- [x] **Envelope reviewed (automatic).** Signed: Grok Bot under Blaine Wilson",
    ]) {
      expect(match.test(line), line).toBe(true);
    }
    for (const line of [
      "not envelope reviewed",
      "- [ ] envelope reviewed (automatic)",
      "the envelope reviewed (automatic) item is missing",
      "    envelope reviewed (automatic)",
      "> envelope reviewed (automatic)",
    ]) {
      expect(match.test(line), line).toBe(false);
    }
  });

  it("does not treat an unticked lookalike as the automatic envelope item", () => {
    const section = buildGoLiveSection({ "envelope-reviewer": null }).replace(
      "## Provider go-live",
      "## Provider go-live\n\n- [ ] not envelope reviewed\n",
    );
    const result = validate(section);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => /not envelope reviewed/i.test(error))).toBe(true);
  });

  it("rejects a placeholder URL on every item", () => {
    const overrides = Object.fromEntries(
      PROVIDER_GO_LIVE_REQUIRED_ITEMS.map((item) => [item.id, { evidence: "https://example.test/ok" }]),
    );
    const result = validate(buildGoLiveSection(overrides));
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(MANUAL_ITEMS.length);
  });

  it("rejects links to other repos, bare github.com, and non-evidence paths", () => {
    for (const evidence of [
      "https://github.com/someone/else/pull/1",
      "https://github.com/optomachina/Overdrafter",
      "https://github.com/optomachina/Overdrafter/tree/main",
      "https://github.com/optomachina/Overdrafter/pull/abc",
      "https://linear.app/overdrafter/issue/ENG-1",
      "deadbeefdeadbeef commit",
      "`npm run provider:check` -> pass",
    ]) {
      const result = validate(buildGoLiveSection({ "provider-check": { evidence } }));
      expect(result.errors.some((error) => error.startsWith("add an evidence link")), evidence).toBe(true);
    }
  });

  it("accepts GitHub PR, run, and commit URLs and Linear OVD issues as evidence", () => {
    expect(extractEvidenceLinks(`x ${EVIDENCE_PR}/files#diff, ${EVIDENCE_RUN}`)).toEqual([
      `${EVIDENCE_PR}/files#diff`,
      EVIDENCE_RUN,
    ]);
    expect(extractEvidenceLinks("https://github.com/optomachina/Overdrafter/commit/0123456789abcdef")).toHaveLength(1);
    expect(extractEvidenceLinks(EVIDENCE_LINEAR)).toEqual([EVIDENCE_LINEAR]);
    expect(extractEvidenceLinks("see OVD-690")).toEqual([]);
  });

  it("rejects a bare OVD-n as evidence on every box", () => {
    const overrides = Object.fromEntries(PROVIDER_GO_LIVE_REQUIRED_ITEMS.map((item) => [item.id, { evidence: "OVD-1" }]));
    const result = validate(buildGoLiveSection(overrides));
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(MANUAL_ITEMS.length);
    expect(result.errors.every((error) => error.startsWith("add an evidence link"))).toBe(true);
  });

  it("allows N/A with a written justification on items that can be N/A", () => {
    const naIds = PROVIDER_GO_LIVE_REQUIRED_ITEMS.filter((item) => item.na).map((item) => item.id);
    expect(naIds).toEqual(
      expect.arrayContaining(["worker-secret", "egress", "admission-revision", "rollout", "certification", "export-control"]),
    );
    const overrides = Object.fromEntries(
      naIds.map((id) => [id, { na: "this change is the stage 2 registry listing and runs no admission" }]),
    );
    expect(validate(buildGoLiveSection(overrides))).toEqual({ ok: true, errors: [] });
  });

  it("rejects N/A on the provider:check, per-supplier switch, and legal stance items", () => {
    const naIds = MANUAL_ITEMS.filter((item) => !item.na).map((item) => item.id);
    expect(naIds).toEqual(["provider-check", "supplier-switch", "no-passwords"]);
    for (const id of naIds) {
      const result = validate(buildGoLiveSection({ [id]: { na: "this does not apply to the stage" } }));
      expect(result.errors.some((error) => error.startsWith("N/A is not allowed")), id).toBe(true);
    }
  });

  it("rejects N/A with a placeholder or empty justification", () => {
    for (const na of ["x", "n/a", "tbd", "todo", "none", "-", ""]) {
      const result = validate(buildGoLiveSection({ egress: { na } }));
      expect(result.errors, na).toContain('mark N/A with a real written justification for "stable egress verified"');
    }
  });

  it("rejects N/A that is not ticked", () => {
    const section = buildGoLiveSection({ egress: { na: "this stage does not touch egress at all" } }).replace(
      "- [x] Stable egress",
      "- [ ] Stable egress",
    );
    expect(validate(section).errors).toContain('check N/A item "stable egress verified"');
  });

  it("rejects a keyword-stuffed single line", () => {
    const stuffed = `${PROVIDER_GO_LIVE_REQUIRED_ITEMS.map((item) => item.text).join(" ")} ${EVIDENCE_PR}`;
    const result = validate(`\n## ${PROVIDER_GO_LIVE_HEADING}\n\n- [x] ${stuffed}\n`);
    expect(result.ok).toBe(false);
  });

  it("rejects missing items and unchecked extra items", () => {
    const missing = validate(buildGoLiveSection({ "supplier-switch": null }));
    expect(missing.errors).toContain('missing Provider go-live item "per-supplier on/off switch in the admin dashboard"');
    const extra = validate(`${buildGoLiveSection()}\n- [ ] Extra attestation\n`);
    expect(extra.errors).toContain('check "Extra attestation"');
  });

  it("ignores a Provider go-live heading inside a code fence and a ### heading", () => {
    const fenced = validate(`\n\`\`\`\n${buildGoLiveSection()}\n\`\`\`\n`);
    expect(fenced.errors[0]).toMatch(/missing required section "Provider go-live"/);
    const nested = validate(buildGoLiveSection().replace("## Provider go-live", "### Provider go-live"));
    expect(nested.errors[0]).toMatch(/missing required section "Provider go-live"/);
  });
});

describe("evidence link verification", () => {
  const body = `${buildValidPrBody()}${buildGoLiveSection()}`;

  it("collects the evidence links of checked items", () => {
    const links = collectGoLiveEvidenceLinks(body);
    expect(links).toEqual(expect.arrayContaining([EVIDENCE_PR, EVIDENCE_RUN, EVIDENCE_LINEAR]));
  });

  it("calls the GitHub API for PR, run, and commit links and skips Linear", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      return { ok: true, status: 200 };
    };
    const errors = await verifyEvidenceLinks(
      [EVIDENCE_PR, EVIDENCE_RUN, "https://github.com/optomachina/Overdrafter/commit/0123456", EVIDENCE_LINEAR, "OVD-1"],
      { fetchImpl, token: "t" },
    );
    expect(errors).toEqual([]);
    expect(calls).toEqual([
      "https://api.github.com/repos/optomachina/Overdrafter/pulls/690",
      "https://api.github.com/repos/optomachina/Overdrafter/actions/runs/38185671103",
      "https://api.github.com/repos/optomachina/Overdrafter/commits/0123456",
    ]);
  });

  it("reports links that do not resolve and fetch failures", async () => {
    const notFound = await verifyEvidenceLinks([EVIDENCE_PR], { fetchImpl: async () => ({ ok: false, status: 404 }) });
    expect(notFound).toEqual([`evidence link does not resolve (HTTP 404): ${EVIDENCE_PR}`]);
    const failed = await verifyEvidenceLinks([EVIDENCE_PR], {
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    expect(failed[0]).toContain("could not verify evidence link");
  });
});

describe("main", () => {
  function setup(input, section = "") {
    const dir = mkdtempSync(path.join(os.tmpdir(), "pr-body-gate-"));
    const bodyFile = path.join(dir, "body.md");
    const namesFile = path.join(dir, "names.txt");
    const diffFile = path.join(dir, "pr.diff");
    writeFileSync(bodyFile, `${buildValidPrBody()}${section}`);
    writeFileSync(namesFile, input.changedFiles.join("\n"));
    writeFileSync(diffFile, input.diffText);
    return [bodyFile, "--changed-files-from", namesFile, "--diff-from", diffFile, "--skip-unless-enabling"];
  }
  const run = (input, section) => main(setup(input, section), {}, { readFile: input.readFile });

  it("skips a disable change, fails an enabling change without the section, and passes with it", async () => {
    expect(await run(DISABLE_REGISTRY)).toBe(0);
    expect(await run(ENABLE_REGISTRY)).toBe(1);
    expect(await run(ENABLE_REGISTRY, buildGoLiveSection())).toBe(0);
  });

  it("fails a swap that nets to zero without the section", async () => {
    const swap = registryChange([["fictiv", true, "stable_nat"], ["geomiq", false]], [["fictiv", false], ["geomiq", true, "stable_nat"]]);
    expect(await run(swap)).toBe(1);
    expect(await run(swap, buildGoLiveSection())).toBe(0);
  });

  it("fails when a flag is missing its path", async () => {
    expect(await main(["--stdin", "--diff-from"])).toBe(1);
  });
});

describe("PR body CLI through a symlinked gate directory", () => {
  it("emits skip evidence and rejects an invalid body when validation is required", () => {
    // Keep the copied gate below the checkout so it resolves the installed TypeScript package.
    const scratch = mkdtempSync(path.join(process.cwd(), ".ovd950-pr-body-"));
    try {
      const real = path.join(scratch, "real");
      mkdirSync(path.join(real, "scripts", "lib"), { recursive: true });
      for (const file of ["validate-pr-body.mjs", "provider-enablement-detect.mjs", "lib/entry-point.mjs"]) {
        copyFileSync(new URL(file, import.meta.url), path.join(real, "scripts", file));
      }
      const link = path.join(scratch, "link");
      symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
      const body = path.join(scratch, "body.md");
      const changed = path.join(scratch, "empty.txt");
      writeFileSync(body, "Invalid PR body\n");
      writeFileSync(changed, "");
      const args = [path.join(link, "scripts", "validate-pr-body.mjs"), body, "--changed-files-from", changed];
      const run = (extra) => spawnSync(process.execPath, [...args, ...extra], { encoding: "utf8", timeout: 10_000 });
      const skipped = run(["--skip-unless-enabling"]);
      expect(skipped.error).toBeUndefined();
      expect(skipped.status, skipped.stderr).toBe(0);
      expect(skipped.stdout).toMatch(/^No provider enablement or gate edit in this diff/m);
      const rejected = run([]);
      expect(rejected.error).toBeUndefined();
      expect(rejected.status, rejected.stderr).toBe(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("provider go-live docs and workflows", () => {
  const read = (...parts) => readFileSync(path.join(...parts), "utf8");

  it("links the checklist from every provider-integration stage and the OVD-687 runbook block", () => {
    const doc = read("docs", "provider-integration.md");
    const checklistHref = "checklists/provider-go-live-checklist.md";
    const headingMatches = [...doc.matchAll(/^### .+$/gm)];
    const requiredPrefixes = ["### 1. Define", "### 2. Make", "### 3. Admit", "### Generated-stage runbook (OVD-687)"];

    for (const prefix of requiredPrefixes) {
      const headingIndex = headingMatches.findIndex((match) => match[0].startsWith(prefix));
      expect(headingIndex >= 0, `missing heading ${prefix}`).toBe(true);
      const heading = headingMatches[headingIndex];
      const start = heading.index + heading[0].length;
      const end = headingIndex + 1 < headingMatches.length ? headingMatches[headingIndex + 1].index : doc.length;
      expect(doc.slice(start, end)).toContain(checklistHref);
    }
  });

  it("keeps the PR template and checklist items aligned with the validator", () => {
    const template = read(".github", "pull_request_template.md");
    const checklist = read("docs", "checklists", "provider-go-live-checklist.md");
    expect(template).toContain(`## ${PROVIDER_GO_LIVE_HEADING}`);
    for (const item of PROVIDER_GO_LIVE_REQUIRED_ITEMS) {
      expect(template, item.id).toContain(`- [${item.auto ? "x" : " "}] ${item.text}`);
      expect(item.match.test(checklist), item.label).toBe(true);
    }
    expect(template).toContain("never committed by a generator");
    expect(template).not.toContain("Admit SQL was not added");
  });

  it("states the N/A rule the same way in the template and the checklist", () => {
    const template = read(".github", "pull_request_template.md").replace(/\s+/g, " ");
    const checklist = read("docs", "checklists", "provider-go-live-checklist.md").replace(/\s+/g, " ");
    for (const text of [template, checklist]) {
      expect(text).toContain("ITAR/EAR item for a US only provider");
      expect(text).toContain("format checked only");
      expect(text).toContain("A bare `OVD-n`");
    }
    const naIds = PROVIDER_GO_LIVE_REQUIRED_ITEMS.filter((item) => item.na).map((item) => item.id);
    expect(naIds).toEqual(["worker-secret", "egress", "admission-revision", "rollout", "certification", "export-control"]);
  });

  it("covers the provider legal stance in the checklist", () => {
    const checklist = read("docs", "checklists", "provider-go-live-checklist.md");
    for (const phrase of ["Blaine Wilson, October 16, 2026", PROVIDER_GO_LIVE_AUTO_SIGNATURE, "OVD-829",
      "https://linear.app/overdrafter/issue/OVD-829", "satisfied by dependency on", "optional admin daily quote cap (default unlimited)", "no default daily quote cap", "No stored customer passwords", "encrypted session tokens", "ITAR/EAR", "Geomiq", "Weerg", "LLMs"]) {
      expect(checklist.replace(/\s+/g, " "), phrase).toContain(phrase);
    }
    const goLiveItems = (text) => text.slice(text.indexOf("## Envelope")).split(/\n(?=- \[)/).filter((line) => line.startsWith("- ["));
    for (const text of [checklist, read(".github", "pull_request_template.md")]) {
      for (const item of goLiveItems(text)) {
        expect(item).not.toMatch(/CAPTCHA|rotate IPs|one click revoke|named reviewer|GO-LIVE:|providerKillSwitch\.handler\.test/i);
      }
    }
  });

  it("requires the no stored customer passwords item, decoupled from one-click revoke", () => {
    const item = PROVIDER_GO_LIVE_REQUIRED_ITEMS.find((candidate) => candidate.id === "no-passwords");
    expect(item).toMatchObject({ group: "Legal stance", na: false });
    expect(item.text).not.toMatch(/revoke/i);
    const missing = validate(buildGoLiveSection({ "no-passwords": null }));
    expect(missing.errors).toContain('missing Provider go-live item "no stored customer passwords, encrypted session tokens only"');
    expect(read(".github", "pull_request_template.md")).toContain("- [ ] No stored customer passwords; encrypted session tokens only. Evidence:");
  });

  it("no longer says the checklist is unbuilt and uses real command names", () => {
    for (const file of [
      ["docs", "provider-integration.md"],
      [".codex", "skills", "add-quote-provider", "SKILL.md"],
      [".codex", "skills", "add-quote-provider", "references", "lifecycle.md"],
      [".codex", "skills", "add-quote-provider", "references", "live-continuation.md"],
    ]) {
      expect(read(...file), file.join("/")).not.toMatch(/not yet built/);
    }
    expect(read("scripts", "reviewed-envelope-check.mjs")).not.toContain("npm run provider:onboard");
    expect(read("docs", "provider-integration.md")).not.toContain("`provider:onboard`");
  });

  it("runs the gate in its own small workflow", () => {
    const gate = read(".github", "workflows", "pr-body-gate.yml");
    expect(gate).toMatch(/types:\s*\n\s+- opened\n\s+- reopened\n\s+- synchronize\n\s+- edited/);
    expect(gate).toMatch(/concurrency:\s*\n\s+group: pr-body-gate-/);
    expect(gate).toMatch(/permissions:\s*\n\s+contents: read\n\s+pull-requests: read/);
    expect(gate).toMatch(/fetch-depth: 2/);
    expect(gate).toMatch(/git diff --name-status --no-renames HEAD\^1 HEAD/);
    expect(gate).toMatch(/git diff --no-renames -U0 HEAD\^1 HEAD/);
    expect(gate).not.toContain("base.sha");
    expect(gate).toMatch(/PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
    const runBlocks = [...gate.matchAll(/run: \|\n((?: {10}.*\n|\n)+)/g)].map((match) => match[1]).join("\n");
    expect(runBlocks).toContain("validate-pr-body.mjs");
    expect(runBlocks).not.toContain("${{");
    expect(gate).toContain("--skip-unless-enabling");
  });

  it("runs the validator from the base copy and passes a no op on merge_group", () => {
    const gate = read(".github", "workflows", "pr-body-gate.yml");
    expect(gate).toMatch(/merge_group:/);
    expect(gate).toMatch(/git show "HEAD\^1:\$file"/);
    expect(gate).toContain("--base-ref HEAD^1 --head-ref HEAD");
    expect(gate).toMatch(/if: github\.event_name == 'merge_group'/);
    expect(gate).not.toContain("PR body gate / provider-go-live");
    expect(gate).toContain('"provider-go-live" (the job name)');
  });

  it("leaves ci.yml triggers and the ci aggregate alone", () => {
    const workflow = read(".github", "workflows", "ci.yml");
    expect(workflow).not.toMatch(/^\s+- edited$/m);
    expect(workflow).not.toContain("provider-go-live");
    expect(workflow).not.toContain("validate-pr-body");
  });

  it("copies the optional helper from the selected gate source without changing fallback selection", () => {
    const gate = read(".github", "workflows", "pr-body-gate.yml");
    expect(gate).toContain('files="scripts/validate-pr-body.mjs scripts/provider-enablement-detect.mjs"');
    const copy = gate.slice(gate.indexOf('helper="scripts/lib/entry-point.mjs"'), gate.indexOf('echo "Gate scripts taken from:'));
    expect(copy).toContain('mkdir -p "$gate/$(dirname "$helper")"');
    expect(copy).toContain('if [ "$source" = base ]; then');
    expect(copy).toContain('if git cat-file -e "HEAD^1:$helper" 2>/dev/null; then');
    expect(copy).toContain('git show "HEAD^1:$helper" > "$gate/$helper"');
    expect(copy).toContain('elif [ -f "$helper" ]; then');
    expect(copy).toContain('cp "$helper" "$gate/$helper"');
    expect(copy).not.toContain('source=head');
  });

  it("requires validator evidence after a successful process exit", () => {
    const gate = read(".github", "workflows", "pr-body-gate.yml");
    const step = gate.slice(gate.indexOf('- name: Validate provider go-live PR section'));
    expect(step).toContain("set -euo pipefail");
    expect(step).toContain('--verify-links | tee "$RUNNER_TEMP/pr-body-validation.log"');
    expect(step).toContain("if ! grep -Eq '^(PR body validation passed|No provider enablement or gate edit in this diff)'");
    expect(step).toMatch(/echo "::error::[^\n]+\n\s+exit 1/);
  });
});

describe("linear heading and checkbox regexes", () => {
  it("pins ATX headings, including a trailing CR that does not match", () => {
    const captured = (line) => {
      const match = ANY_ATX_HEADING.exec(line);
      return match ? (match[1] ?? "") : null;
    };
    expect(captured("#######")).toBeNull();
    expect(captured("#x")).toBeNull();
    expect(captured("#")).toBe("");
    expect(captured("#   ")).toBe("");
    expect(captured("# a")).toBe("a");
    expect(captured("   ## a ##")).toBe("a ##");
    expect(captured("# a\r")).toBeNull();
  });

  it("pins the container prefix used before heading detection", () => {
    const stripped = (line) => line.replace(CONTAINER_PREFIX, "");
    expect(stripped("> - 1. text")).toBe("text");
    expect(stripped(">>- x")).toBe("x");
    expect(stripped("1234567890. x")).toBe("1234567890. x");
    expect(stripped("-x")).toBe("-x");
  });

  it("pins checkbox captures, including quoted markers and an empty tail", () => {
    const captured = (line) => {
      const match = CHECKBOX_LINE.exec(line);
      return match ? [match[1].includes(">"), match[2], match[3] ?? ""] : null;
    };
    expect(captured("+ [x] a")).toEqual([false, "x", "a"]);
    expect(captured("* [X] a")).toEqual([false, "X", "a"]);
    expect(captured("1) [x] a")).toEqual([false, "x", "a"]);
    expect(captured("123456789. [ ] a")).toEqual([false, " ", "a"]);
    expect(captured("1234567890. [x] a")).toBeNull();
    expect(captured("- - [x] a")).toEqual([false, "x", "a"]);
    expect(captured("> 1. - [ ] a")).toEqual([true, " ", "a"]);
    expect(captured("> - [x] quoted")).toEqual([true, "x", "quoted"]);
    expect(captured("- [x] plain")).toEqual([false, "x", "plain"]);
    expect(captured("- [x]")).toEqual([false, "x", ""]);
    expect(captured("- [x]\t  text")).toEqual([false, "x", "text"]);
    expect(captured(">- [x] text")).toEqual([true, "x", "text"]);
    expect(captured(">>- [ ] a")).toEqual([true, " ", "a"]);
    expect(captured("> >1. [x] b")).toEqual([true, "x", "b"]);
  });

  it("pins fence openers, including a quoted fence and a backtick in the info string", () => {
    const captured = (line) => {
      const match = FENCE_OPEN.exec(line);
      return match ? [match[1], match[2], match[3]] : null;
    };
    expect(captured("> ```")).toEqual(["> ", "```", ""]);
    expect(captured(">```")).toBeNull();
    expect(captured("- ~~~")).toEqual(["- ", "~~~", ""]);
    expect(captured("```js")).toEqual(["", "```", "js"]);
    expect(captured("```x`x")).toEqual(["", "```", "x`x"]);
    expect(captured("````")).toEqual(["", "````", ""]);
  });

  it("still counts a multi-line setext Provider go-live heading, and two of them", () => {
    const missingAuto = buildGoLiveSection({ "envelope-reviewer": null });
    for (const heading of ["Provider\ngo-live\n---", "> Provider\n> go-live\n> ==="]) {
      expect(validate(`${missingAuto}\n${heading}\n`).errors, heading).toContain(
        '"Provider go-live" appears 2 times; keep exactly one section',
      );
      expect(validate(`${missingAuto}\n${heading}\n${heading}\n`).errors, heading).toContain(
        '"Provider go-live" appears 3 times; keep exactly one section',
      );
    }
  });
});

// These count work instead of reading a clock, so they cannot flake on a slow runner.
describe("character reference scan does bounded work", () => {
  const MAX = MAX_REFERENCE_LENGTH;
  const kindOf = (text) => scanEntity(text, 0).kind;

  it("reads references up to the cap and leaves longer runs as text", () => {
    expect(scanEntity("&#112;", 0)).toMatchObject({ kind: "done", end: 6 });
    expect(scanEntity("&#x70;", 0)).toMatchObject({ kind: "done", end: 6 });
    expect(scanEntity("&#X7A;", 0)).toMatchObject({ kind: "done", end: 6 });
    expect(scanEntity("x&nbsp;y", 1)).toMatchObject({ kind: "done", end: 7 });
    for (const open of ["&", "&#", "&#x", "&#1", "&#x7", "&n", "&nbsp"]) {
      expect(kindOf(open), open).toBe("incomplete");
    }
    for (const broken of ["&;", "& ", "&1", "&#;", "&#x;", "&#x ", "&#1 ", "&#xg", "&n1;", "&#1a;", "&n x"]) {
      expect(kindOf(broken), broken).toBe("broken");
    }
    // "&" and ";" count toward the cap: 34 characters is the longest reference.
    expect(kindOf(`&${"a".repeat(MAX - 2)};`)).toBe("done");
    expect(kindOf(`&${"a".repeat(MAX - 1)};`)).toBe("broken");
    expect(kindOf(`&#${"1".repeat(MAX - 3)};`)).toBe("done");
    expect(kindOf(`&#${"1".repeat(MAX - 2)};`)).toBe("broken");
    expect(kindOf(`&#x${"f".repeat(MAX - 4)};`)).toBe("done");
    expect(kindOf(`&#x${"f".repeat(MAX - 3)};`)).toBe("broken");
    // The longest half-read reference can still be finished by a ";" in the next piece.
    expect(kindOf(`&${"a".repeat(MAX - 2)}`)).toBe("incomplete");
    expect(kindOf(`&${"a".repeat(MAX - 1)}`)).toBe("broken");
  });

  it("never looks more than one reference length ahead, however long the text", () => {
    const reads = (chars, start = 0) => {
      let count = 0;
      const data = new Proxy(chars, {
        get(target, key, receiver) {
          if (typeof key === "string" && /^\d+$/.test(key)) count += 1;
          return Reflect.get(target, key, receiver);
        },
      });
      const result = scanEntity(data, start);
      return { count, result };
    };
    for (const open of ["&", "&#", "&#x"]) {
      for (const body of ["1", "a", "f"]) {
        const chars = [...open, ...body.repeat(100_000)];
        const { count, result } = reads(chars);
        expect(count, `${open}${body}`).toBeLessThanOrEqual(MAX + 2);
        expect(result.steps, `${open}${body}`).toBeLessThanOrEqual(MAX);
      }
    }
    expect(reads([..."&#", ...Array.from({ length: 100_000 }, () => "1")]).result.kind).toBe("broken");
  });

  const WIDTHS = [16 * 1024, 64 * 1024];
  // Each family keeps a character reference half read across tags or comments,
  // the way that once made every piece of text rescan all the text before it.
  const families = {
    "decimal reference between tags": (w) => `&#${"1<b>".repeat(w / 4)}`,
    "hex reference between tags": (w) => `&#x${"f<b>".repeat(w / 4)}`,
    "named reference between closing tags": (w) => `&${"a</b>".repeat(w / 5)}`,
    "reference between comments": (w) => `&#${"1<!---->".repeat(w / 8)}`,
    "reference inside an unclosed tag": (w) => `<b &#${"1<!---->".repeat(w / 8)}`,
    "reference that never ends, over and over": (w) => `&${"a<b>".repeat(32)}`.repeat(Math.floor(w / 129)),
    "references that end late, over and over": (w) => `&${"a<b>".repeat(31)}a;`.repeat(Math.floor(w / 129)),
  };

  it.each(Object.entries(families))("%s: pending text stays within one reference and steps grow linearly", (_name, make) => {
    const work = WIDTHS.map((width) => {
      const input = make(width);
      const scan = createGoLiveScan();
      scan.feed(input);
      scan.isGoLive();
      return { length: input.length, ...scan.stats() };
    });
    for (const { length, steps, maxPending } of work) {
      expect(maxPending).toBeLessThanOrEqual(MAX - 1);
      // At most one scan of one reference per piece of text, and a piece is 4+ characters here.
      expect(steps).toBeLessThanOrEqual((length * MAX) / 4);
    }
    const [small, large] = work;
    expect(large.steps).toBeLessThanOrEqual(small.steps * (large.length / small.length) * 1.1);
  });

  it("does not let a half-read reference grow while underlines keep asking", () => {
    for (const width of WIDTHS) {
      const scan = createGoLiveScan();
      // The line ends inside a tag, so the half-read reference outlives it.
      scan.feed(`&#${"1".repeat(width / 2)}<b`);
      for (let line = 0; line < width / 8; line += 1) {
        scan.isGoLive();
        scan.feed(" ---");
      }
      expect(scan.stats().maxPending).toBeLessThanOrEqual(MAX - 1);
      expect(scan.stats().steps).toBeLessThanOrEqual(MAX * 2);
    }
  });

  it("still decodes a reference that spans tags and comments, up to the cap", () => {
    const missingAuto = buildGoLiveSection({ "envelope-reviewer": null });
    const duplicate = '"Provider go-live" appears 2 times; keep exactly one section';
    const longest = (zeros) => `Provider g&#x${"0".repeat(zeros)}6f;-live\n---`;
    for (const heading of [
      "Provider g&#1<b></b>11;-live\n---",
      "Provider g&#x<i>6f</i>;-live\n---",
      "Provider g&#x6<!---->f;-live\n---",
      "Provider g&#<!-- c -->111;-live\n---",
      "Provider g&#x6f<b>;-live\n---",
      // "&#x" + 28 zeros + "6f;" is exactly MAX_REFERENCE_LENGTH characters.
      longest(MAX - 6),
      `> ${longest(MAX - 6).replace("\n", "\n> ")}`,
    ]) {
      expect(validate(`${missingAuto}\n${heading}\n`).errors, heading).toContain(duplicate);
    }
    // One digit more and it is plain text, as in CommonMark, so no heading reads as go-live.
    const plain = validate(`${missingAuto}\n${longest(MAX - 5)}\n`).errors;
    expect(plain.some((error) => error.includes("appears")), plain.join("\n")).toBe(false);
  });

  it("does not throw on a reference with hundreds of digits", () => {
    const missingAuto = buildGoLiveSection({ "envelope-reviewer": null });
    const huge = `&#x${"f".repeat(300)};`;
    const hugeDecimal = `&#${"9".repeat(400)};`;
    for (const heading of [`### x ${huge} y`, `<h2>x ${hugeDecimal} y</h2>`, `x ${huge} y\n---`, `x ${hugeDecimal} y\n---`]) {
      expect(() => validate(`${missingAuto}\n${heading}\n`), heading).not.toThrow();
    }
  });

  it("finds the fence candidate columns with a fixed number of lookups", () => {
    class CountingSet extends Set {
      lookups = 0;
      iterations = 0;
      has(value) {
        this.lookups += 1;
        return super.has(value);
      }
      [Symbol.iterator]() {
        this.iterations += 1;
        return super[Symbol.iterator]();
      }
    }
    const columns = new CountingSet();
    for (let column = 0; column < 30_000; column += 1) columns.add(column);
    columns.delete(9);
    expect(fenceCandidateColumns(columns, 10)).toEqual([7, 8, 10]);
    expect(fenceCandidateColumns(columns, 1)).toEqual([0, 1]);
    expect(fenceCandidateColumns(columns, 40_000)).toEqual([]);
    expect(columns.lookups).toBe(12);
    expect(columns.iterations).toBe(0);
    expect(fenceCandidateColumns(new Set([0, 4]), 3)).toEqual([0]);
    expect(fenceCandidateColumns(new Set([0, 4]), 4)).toEqual([4]);
  });
});

// These count the work normalization is handed instead of reading a clock. NFKC sorts each
// run of combining marks into canonical order and the sort costs the square of the run, so
// what matters is the longest run of marks any normalize call receives.
describe("combining marks cannot make normalization quadratic", () => {
  const JOINER = "\u034F";
  const marks = (count, mark = "\u0301") => mark.repeat(count);

  // A character is a starter when canonical ordering never moves it. NFD swaps two marks of
  // different combining classes, so a mark is moved by one probe or the other.
  const nonStarters = new Map();
  function isNonStarter(char) {
    let known = nonStarters.get(char);
    if (known === undefined) {
      const behind = `\u0345${char}`;
      const before = `${char}\u0334`;
      known = behind.normalize("NFD") !== behind || before.normalize("NFD") !== before;
      nonStarters.set(char, known);
    }
    return known;
  }

  /** Lengths of the runs of marks that canonical ordering has to sort in `text`. */
  function markRuns(text) {
    const runs = [];
    let run = 0;
    for (const char of text.normalize("NFKD")) {
      if (isNonStarter(char)) {
        run += 1;
      } else {
        if (run > 0) runs.push(run);
        run = 0;
      }
    }
    if (run > 0) runs.push(run);
    return runs;
  }

  /** Run `work` and report every string `normalize` received, restoring it either way. */
  function recordNormalizeInputs(work) {
    const original = String.prototype.normalize;
    const received = [];
    String.prototype.normalize = function recording(form) {
      received.push(String(this));
      return original.call(this, form);
    };
    try {
      work();
    } finally {
      String.prototype.normalize = original;
    }
    return received;
  }

  function normalizeWork(body) {
    const received = recordNormalizeInputs(() => {
      validateProviderGoLive(body);
      validatePrBody(body);
    });
    let longestRun = 0;
    let sortCost = 0;
    let handed = 0;
    for (const text of received) {
      handed += text.length;
      for (const run of markRuns(text)) {
        longestRun = Math.max(longestRun, run);
        sortCost += run * run;
      }
    }
    return { handed, longestRun, sortCost };
  }

  it("leaves text with at most 30 marks in a row as it was", () => {
    expect(STREAM_SAFE_RUN).toBe(30);
    for (const text of [
      "",
      "Provider go-live",
      `e${marks(1)}`,
      `x${marks(STREAM_SAFE_RUN)}`,
      marks(STREAM_SAFE_RUN),
      `${marks(STREAM_SAFE_RUN)}x${marks(STREAM_SAFE_RUN)}`,
      "\uFF9E\u0301".repeat(STREAM_SAFE_RUN / 2),
      `a${marks(STREAM_SAFE_RUN)} ${marks(STREAM_SAFE_RUN)}b`,
    ]) {
      expect(streamSafeText(text), text).toBe(text);
    }
  });

  it("puts a joiner after every 30 marks that have another mark behind them", () => {
    const run = STREAM_SAFE_RUN;
    expect(streamSafeText(marks(run + 1))).toBe(`${marks(run)}${JOINER}${marks(1)}`);
    expect(streamSafeText(marks(2 * run))).toBe(`${marks(run)}${JOINER}${marks(run)}`);
    expect(streamSafeText(marks(2 * run + 1))).toBe(`${marks(run)}${JOINER}${marks(run)}${JOINER}${marks(1)}`);
    expect(streamSafeText(`x${marks(run + 1)}y`)).toBe(`x${marks(run)}${JOINER}${marks(1)}y`);
    // Marks of different classes and the halfwidth sound marks count the same.
    expect(streamSafeText("\u0316\u0301".repeat(run))).toBe(`${"\u0316\u0301".repeat(run / 2)}${JOINER}${"\u0316\u0301".repeat(run / 2)}`);
    expect(streamSafeText("\uFF9E".repeat(run + 1))).toBe(`${"\uFF9E".repeat(run)}${JOINER}\uFF9E`);
  });

  it("only ever adds joiners, and none unless a run is longer than the cap", () => {
    // A seeded generator, so a failure repeats exactly.
    let seed = 20261020;
    const next = (bound) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      // The high bits: the low bits of this generator repeat with a short period.
      return (seed >>> 8) % bound;
    };
    const MARK_RUN = /(?:(?!\u034F)[\p{M}\uFF9E\uFF9F])+/gu;
    const pieces = ["a", "b", " ", "-", "<b>", "\u0301", "\u0316", "\u0301", "\uFF9E", "\u3099", "\u0F73", "&#x301;"];
    for (let round = 0; round < 300; round += 1) {
      let text = "";
      for (let piece = 0, count = 10 + next(200); piece < count; piece += 1) {
        const repeat = next(8) === 0 ? 20 + next(60) : 1 + next(3);
        text += pieces[next(pieces.length)].repeat(repeat);
      }
      const safe = streamSafeText(text);
      expect(safe.replaceAll(JOINER, ""), text).toBe(text);
      const longest = Math.max(0, ...[...text.matchAll(MARK_RUN)].map((run) => run[0].length));
      if (longest <= STREAM_SAFE_RUN) expect(safe, text).toBe(text);
      // A joiner is a mark by category but a starter, so it ends a run.
      for (const run of safe.matchAll(MARK_RUN)) expect(run[0].length, text).toBeLessThanOrEqual(STREAM_SAFE_RUN);
    }
  });

  it("counts every character that normalizes into marks only, on this Node's Unicode tables", () => {
    // A character whose NFKD form is nothing but marks can fill a run, so the cap must count it.
    // Besides the mark category that is U+FF9E and U+FF9F today: letters that NFKC rewrites into
    // the marks U+3099 and U+309A. A Node or ICU upgrade that adds another fails here. The scan
    // covers every plane that holds characters.
    const uncounted = [];
    const ranges = [
      [0x80, 0x3ffff],
      [0xe0000, 0xe0fff],
    ];
    for (const [first, last] of ranges) {
      for (let code = first; code <= last; code += 1) {
        if (code >= 0xd800 && code <= 0xdfff) continue;
        const char = String.fromCodePoint(code);
        if (!Array.from(char.normalize("NFKD")).every(isNonStarter)) continue;
        const run = char.repeat(STREAM_SAFE_RUN + 1);
        if (streamSafeText(run) === run) uncounted.push(code.toString(16));
      }
    }
    expect(uncounted).toEqual([]);
  });

  const WIDTHS = [8 * 1024, 32 * 1024];
  // A run of marks only reaches normalize whole when the text arrives in one piece. A line of
  // plain text does, but tags, comments and character references cut the setext scan's text
  // into pieces of a mark or two, which no cap is needed for, so those kinds only apply to
  // headings, where the visible text is joined (and decoded) before it is normalized.
  const directRuns = {
    "marks of two combining classes": (count) => "\u0316\u0301".repeat(count / 2),
    "a halfwidth sound mark beside a mark": (count) => "\uFF9E\u0301".repeat(count / 2),
  };
  const joinedRuns = {
    ...directRuns,
    "marks written as character references": (count) => "&#x316;&#x301;".repeat(count / 2),
    "marks split by tags": (count) => "\u0316\u0301<b>".repeat(count / 2),
    "marks split by comments": (count) => "\u0316<!---->\u0301".repeat(count / 2),
  };
  const lineShapes = [
    ["a plain line", (run) => `x${run}`, directRuns],
    ["a checkbox line", (run) => `- [x] x${run}`, directRuns],
    ["a quoted line", (run) => `> x${run}`, directRuns],
    ["an ATX heading", (run) => `### x${run}`, joinedRuns],
    ["an HTML heading", (run) => `<h2>x${run}</h2>`, joinedRuns],
    ["a setext heading", (run) => `x${run}\n---`, directRuns],
    ["a multi-line setext heading", (run) => `x${run}\n${run}\n---`, directRuns],
  ];
  const cases = lineShapes.flatMap(([shape, line, runs]) =>
    Object.entries(runs).map(([kind, run]) => [`${shape} of ${kind}`, line, run]),
  );

  it.each(cases)("%s: no run of marks is longer than 30 and the work grows linearly", (_name, line, run) => {
    const work = WIDTHS.map((width) => {
      const result = normalizeWork(`## Provider go-live\n\n${line(run(width))}\n`);
      // The test has to be looking at the mark runs, or it proves nothing.
      expect(result.handed).toBeGreaterThanOrEqual(width / 2);
      return { width, ...result };
    });
    for (const { longestRun, sortCost, handed } of work) {
      expect(longestRun).toBeLessThanOrEqual(30);
      // Sorting a run costs its square, so the cap bounds the whole sort by 30 per character.
      expect(sortCost).toBeLessThanOrEqual(30 * handed);
    }
    const [small, large] = work;
    const scale = large.width / small.width;
    expect(large.handed).toBeLessThanOrEqual(small.handed * scale * 1.1);
    expect(large.sortCost).toBeLessThanOrEqual(small.sortCost * scale * 1.1);
  });

  it("reads a go-live heading the same with a long run of marks near it", () => {
    const missingAuto = buildGoLiveSection({ "envelope-reviewer": null });
    const duplicate = '"Provider go-live" appears 2 times; keep exactly one section';
    for (const heading of [
      (run) => `### Provider go-live ${run}`,
      (run) => `### Provider go-live <!-- ${run} -->`,
      (run) => `<h2>Provider go-live ${run}</h2>`,
      (run) => `Provider go-live ${run}\n---`,
      (run) => `> Provider go-live ${run}\n> ===`,
      (run) => `Provider ${run}\ngo-live\n---`,
      // Joiners already in the text are starters, so they change nothing either.
      (run) => `### Provider go-live${"\u034F".repeat(40)}${run}`,
    ]) {
      const plain = validate(`${missingAuto}\n${heading("")}\n`).errors;
      const long = validate(`${missingAuto}\n${heading("\u0316\u0301".repeat(200))}\n`).errors;
      expect(plain, heading("")).toContain(duplicate);
      expect(long, heading("...")).toEqual(plain);
    }
  });
});

const REDOS_CHILD = fileURLToPath(new URL("./validate-pr-body-redos-child.mjs", import.meta.url));
const REDOS_MISSING = [
  'add Provider go-live checkboxes to "Provider go-live"',
  'missing Provider go-live item "provider:check green"',
  'missing Provider go-live item "envelope reviewed (automatic)"',
  'missing Provider go-live item "worker adapter and Secret Manager secret"',
  'missing Provider go-live item "stable egress verified"',
  'missing Provider go-live item "approved admission revision (generic_dispatch_enabled=true)"',
  'missing Provider go-live item "automatic_quote_collection rollout and org enablement"',
  'missing Provider go-live item "certification run evidence"',
  'missing Provider go-live item "per-supplier on/off switch in the admin dashboard"',
  'missing Provider go-live item "no stored customer passwords, encrypted session tokens only"',
  'missing Provider go-live item "ITAR/EAR controlled or uncertain uploads blocked to foreign providers and LLMs"',
];

function runRedosCase(id) {
  const result = spawnSync(process.execPath, [REDOS_CHILD, id], { timeout: 5000, encoding: "utf8" });
  expect(result.error?.code ?? result.signal, result.stderr).toBeFalsy();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("adversarial ReDoS bounds", { timeout: 30_000 }, () => {
  const bounded = [
    ["a1", 250],
    ["a2", 250],
    ["a3", 250],
    ["a5", 250],
    ["a6", 250],
    ["a7", 250],
    ["a8", 250],
    ["a10", 250],
    ["a11", 250],
    ["a12", 250],
    ["a13", 250],
    ["a14", 250],
  ];

  it.each(bounded)("%s stays under %i ms and still fails closed", (id, bound) => {
    const report = runRedosCase(id);
    expect(report.maxMs).toBeLessThan(bound);
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual(report.errors.map(() => REDOS_MISSING));
  });

  it("a4 matches nothing and stays under 50 ms", () => {
    const report = runRedosCase("a4");
    expect(report.maxMs).toBeLessThan(50);
    expect(report.match).toBe(false);
  });

  it("a mixed 65 KiB body stays under 1 s", () => {
    const report = runRedosCase("a9");
    expect(report.sumMs).toBeLessThan(1000);
    expect(report.maxMs).toBeLessThan(1000);
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([REDOS_MISSING]);
  });

  it("a mixed 10k body stays under 100 ms", () => {
    const report = runRedosCase("a10k");
    expect(report.sumMs).toBeLessThan(100);
    expect(report.ok).toBe(false);
    expect(report.errors).toEqual([REDOS_MISSING]);
  });

  it("grows less than 8x from 16 KiB to 64 KiB", () => {
    const report = runRedosCase("growth");
    for (const [name, row] of Object.entries(report.ratios)) {
      expect(row.ratio, name).toBeLessThan(8);
    }
  });
});

describe("Revert plan: explicit report-only opt-in", () => {
  const plan = `## Revert plan
- Revert: git revert <squash-sha>
- State effects: none
- Why none: Only pure parsing code changes; no persistent or external writes occur.
- Kill switch: none: a code revert restores the parser
- Owner: engineer
- Verify after revert: npm test -- scripts/example.test.mjs
- Blast radius: Provider quote parsing for internal fixture users.
`;
  it("accepts a valid plan only when opted in and permits no plan for one-way", () => {
    expect(validateRevertPlan(plan, "revertable")).toMatchObject({ok:true, required:true});
    expect(validateRevertPlan("", "one-way")).toMatchObject({ok:true, required:false});
    expect(validatePrBody(buildValidPrBody()).ok).toBe(true);
    expect(validatePrBody(buildValidPrBody(), {door:"revertable"}).ok).toBe(false);
    expect(validatePrBody(buildValidPrBody()+plan, {door:"revertable"}).ok).toBe(true);
  });
  it.each(REVERT_PLAN_FIELDS)("requires the visible %s field", (field) => {
    const line = plan.split("\n").find((value) => value.startsWith(`- ${field}:`));
    for (const replacement of ["", `<!-- ${line} -->`, `<details>\n${line}\n</details>`, `<details\nopen>\n${line}\n</details>`, `~~~\n${line}\n~~~`]) {
      expect(validateRevertPlan(plan.replace(line, replacement), "revertable").ok).toBe(false);
    }
  });
  it.each(REVERT_PLAN_FIELDS)("rejects placeholders and duplicates for %s", (field) => {
    const line = plan.split("\n").find((value) => value.startsWith(`- ${field}:`));
    for (const value of ["TODO", "TBD", "n/a", "-", "template text", "<replace me>"]) {
      expect(validateRevertPlan(plan.replace(line, `- ${field}: ${value}`), "revertable").ok).toBe(false);
    }
    expect(validateRevertPlan(plan + line, "revertable").ok).toBe(false);
  });
  it("requires state effects none with a meaningful reason, default off and a known owner", () => {
    for (const [from,to] of [["State effects: none","State effects: some"],["Why none: Only pure parsing code changes; no persistent or external writes occur.","Why none: short"],["Owner: engineer","Owner: random-person"],["none: a code revert restores the parser","EXAMPLE_FLAG default on"]]) {
      expect(validateRevertPlan(plan.replace(from,to), "revertable").ok).toBe(false);
    }
    expect(validateRevertPlan(plan.replace("none: a code revert restores the parser", "EXAMPLE_FLAG default off"), "revertable").ok).toBe(true);
    expect(validateRevertPlan(plan.replace("Owner: engineer", "Owner: blaine"), "revertable").ok).toBe(true);
  });
  it("normalizes encoded headings and rejects duplicate headings, even hidden ones", () => {
    expect(validateRevertPlan(plan.replace("## Revert plan", "## R&#101;vert plan"), "revertable").ok).toBe(true);
    for (const duplicate of ["## Revert plan", "## R&#101;vert plan", "<!--\n## Revert plan\n-->", "<h2>Revert plan</h2>", "Revert plan\n---", "### Revert plan", "> ## Revert plan"]) {
      expect(validateRevertPlan(plan + duplicate, "revertable").ok, duplicate).toBe(false);
    }
    expect(validateRevertPlan(plan + "~~~\n## Revert plan\n~~~", "revertable").ok).toBe(true);
    expect(validateRevertPlan("<details>\n"+plan+"</details>", "revertable").ok).toBe(false);
  });
  it.each(["", "unknown", null, undefined])("unknown door %s fails closed", (door) => {
    expect(validateRevertPlan(plan, door).ok).toBe(false);
  });
  it("fails closed on parse errors, a timeout or missing routing", () => {
    expect(validateRevertPlan(null, "revertable").ok).toBe(false);
    expect(validateRevertPlan(plan, "revertable", {maxMs:-1}).ok).toBe(false);
    expect(validateRevertPlan(plan, "revertable", {owners:{has(){throw new Error("routing unreadable");}}}).ok).toBe(false);
  });
  it("CLI no-door output is unchanged, and explicit door bypasses the skip", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "revert-plan-cli-"));
    const file = path.join(dir, "body.md");
    writeFileSync(file, buildValidPrBody());
    try {
      expect(await main([file,"--skip-unless-enabling"], {})).toBe(0);
      expect(await main([file,"--skip-unless-enabling","--door","revertable"], {})).toBe(1);
      expect(await main([file,"--door",""], {})).toBe(1);
      expect(await main([file,"--door"], {})).toBe(1);
      expect(await main([file,"--door","one-way"], {})).toBe(0);
      expect(await main([file,"--door","one-way","--door","revertable"], {})).toBe(1);
      writeFileSync(file, buildValidPrBody()+plan);
      expect(await main([file,"--door","revertable"], {})).toBe(0);
    } finally { rmSync(dir, {recursive:true, force:true}); }
  });
});


it("Revert plan parser remains bounded in the existing ReDoS child", () => {
  const result = spawnSync(process.execPath, [REDOS_CHILD, "revert"], {timeout:5000, encoding:"utf8"});
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.ms).toBeLessThan(1000);
  expect(report.value.ok).toBe(false);
});
