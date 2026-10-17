// @vitest-environment node

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  detectProviderEnablement,
  parseEnvelopeProviders,
  parseNameStatus,
} from "./provider-enablement-detect.mjs";
import {
  PROVIDER_GO_LIVE_GROUPS,
  PROVIDER_GO_LIVE_HEADING,
  PROVIDER_GO_LIVE_AUTO_SIGNATURE,
  PROVIDER_GO_LIVE_REQUIRED_ITEMS,
  collectGoLiveEvidenceLinks,
  enablesProvider,
  extractEvidenceLinks,
  main,
  validatePrBody,
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

  it("treats the envelope review item as automatic: signed, unsigned, or absent, it never fails", () => {
    const auto = PROVIDER_GO_LIVE_REQUIRED_ITEMS.filter((item) => item.auto);
    expect(auto.map((item) => item.id)).toEqual(["envelope-reviewer"]);
    expect(auto[0].text).toContain(PROVIDER_GO_LIVE_AUTO_SIGNATURE);
    expect(PROVIDER_GO_LIVE_AUTO_SIGNATURE).toBe("Grok Bot under Blaine Wilson standing authority");
    expect(validate(buildGoLiveSection())).toEqual({ ok: true, errors: [] });
    expect(validate(buildGoLiveSection({ "envelope-reviewer": null }))).toEqual({ ok: true, errors: [] });
    const unchecked = buildGoLiveSection().replace("- [x] Envelope reviewed", "- [ ] Envelope reviewed");
    expect(validate(unchecked)).toEqual({ ok: true, errors: [] });
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
});
