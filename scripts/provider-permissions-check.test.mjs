// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { readProviderManifests } from "./provider-manifest.mjs";
import {
  ACCEPTANCE_TABLES_RELATIVE_PATH,
  LEGAL_REVIEW_RELATIVE_PATH,
  MATRIX_JSON_RELATIVE_PATH,
  MATRIX_MARKDOWN_RELATIVE_PATH,
  MATRIX_SCHEMA_RELATIVE_PATH,
  OUTREACH_DIR_RELATIVE_PATH,
  PLAYBOOK_PENDING_MARKER,
  PLAYBOOK_RELATIVE_PATH,
  REQUIRED_NOT_1_0_KEYS,
  REQUIRED_OUTREACH_DRAFT_KEYS,
  assertCeaseAndDesistPlaybook,
  assertMarkdownAgreesWithJson,
  assertMarkdownOwnerOverrides,
  assertPaidAutomationGate,
  assertEnabledDerivation,
  assertNoAdmittedProviderIsProhibitedOrCd,
  assertOvd722KillSwitchShipped,
  assertOutreachDirectoryContents,
  assertOutreachDraft,
  assertOutreachHasNoSendInstructions,
  assertOneDotZeroMatchesReviewedSet,
  assertRequiredProviderCoverage,
  deriveRequired10Keys,
  OVD722_KILL_CLI_RELATIVE_PATH,
  OVD722_RPC_CLIENT_RELATIVE_PATH,
  parseMarkdownReplyCounts,
  checkProviderPermissions,
  deriveEnabledForPaidAutomation,
  extractPlaybookKillCommand,
  parseAdmissionPolicyFixtures,
  parseMarkdownMatrix,
  validatePermissionsMatrixDocument,
} from "./provider-permissions-check.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = [];
// Weerg is blocked and RMFG substitutes, so Weerg stays in the matrix as not in 1.0.
const EXPECTED_1_0_KEYS = ["xometry", "fictiv", "quickparts", "geomiq", "rmfg", "oshcut", "sendcutsend"];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function readRepoMatrix() {
  const [document, schema, markdown] = await Promise.all([
    fs.readFile(path.join(repoRoot, MATRIX_JSON_RELATIVE_PATH), "utf8").then(JSON.parse),
    fs.readFile(path.join(repoRoot, MATRIX_SCHEMA_RELATIVE_PATH), "utf8").then(JSON.parse),
    fs.readFile(path.join(repoRoot, MATRIX_MARKDOWN_RELATIVE_PATH), "utf8"),
  ]);
  return { document, schema, markdown };
}

function clone(value) {
  return structuredClone(value);
}

async function writeTempRepo(overrides = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ovd724-permissions-"));
  temporaryRoots.push(temporaryRoot);
  const { document, schema, markdown } = await readRepoMatrix();
  const matrix = overrides.matrix ?? document;
  const md = overrides.markdown ?? markdown;
  await fs.mkdir(path.join(temporaryRoot, "docs/providers/outreach"), { recursive: true });
  await fs.mkdir(path.join(temporaryRoot, "docs/runbooks"), { recursive: true });
  await fs.mkdir(path.join(temporaryRoot, "src/integrations/supabase"), { recursive: true });
  await fs.mkdir(path.join(temporaryRoot, "worker/src"), { recursive: true });
  await fs.mkdir(path.join(temporaryRoot, "provider-integrations"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(temporaryRoot, MATRIX_SCHEMA_RELATIVE_PATH), `${JSON.stringify(schema, null, 2)}\n`),
    fs.writeFile(path.join(temporaryRoot, MATRIX_JSON_RELATIVE_PATH), `${JSON.stringify(matrix, null, 2)}\n`),
    fs.writeFile(path.join(temporaryRoot, MATRIX_MARKDOWN_RELATIVE_PATH), md),
    fs.copyFile(path.join(repoRoot, PLAYBOOK_RELATIVE_PATH), path.join(temporaryRoot, PLAYBOOK_RELATIVE_PATH)),
    fs.copyFile(path.join(repoRoot, LEGAL_REVIEW_RELATIVE_PATH), path.join(temporaryRoot, LEGAL_REVIEW_RELATIVE_PATH)),
    fs.copyFile(
      path.join(repoRoot, ACCEPTANCE_TABLES_RELATIVE_PATH),
      path.join(temporaryRoot, ACCEPTANCE_TABLES_RELATIVE_PATH),
    ),
    fs.copyFile(
      path.join(repoRoot, "src/integrations/supabase/types.ts"),
      path.join(temporaryRoot, "src/integrations/supabase/types.ts"),
    ),
    fs.copyFile(path.join(repoRoot, "worker/src/types.ts"), path.join(temporaryRoot, "worker/src/types.ts")),
    fs.cp(path.join(repoRoot, "provider-integrations"), path.join(temporaryRoot, "provider-integrations"), {
      recursive: true,
    }),
    ...REQUIRED_OUTREACH_DRAFT_KEYS.map((key) => fs.copyFile(
      path.join(repoRoot, "docs/providers/outreach", `${key}.md`),
      path.join(temporaryRoot, "docs/providers/outreach", `${key}.md`),
    )),
  ]);
  return { temporaryRoot, matrix, schema };
}

describe("OVD-724 provider permissions matrix lint", () => {
  it("passes the real CLI (npm run provider:permissions) against the committed files in the unit lane", () => {
    const result = spawnSync(process.execPath, ["scripts/provider-permissions-check.mjs"], { cwd: repoRoot, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, providerCount: 9 });
  });

  it("accepts the committed matrix, outreach drafts, legal review, and playbook", async () => {
    const result = await checkProviderPermissions({ rootDir: repoRoot, today: "2026-10-11" });
    expect(result.ok).toBe(true);
    expect(result.providerCount).toBe(9);
    expect(result.enabledKeys).toEqual(["xometry", "fictiv", "quickparts", "geomiq", "rmfg", "oshcut", "sendcutsend"]);
    expect([
      "provider-integrations/provider-registry.v1.json",
      "provider-integrations/*/manifest.v1.json",
    ]).toContain(result.registrySource);
  });

  it("covers every 1.0 key plus Protolabs marked not in 1.0", async () => {
    const { document, schema } = await readRepoMatrix();
    const validated = validatePermissionsMatrixDocument(document, schema);
    const keys = validated.providers.map((row) => row.key);
    expect([...keys].sort()).toEqual([...EXPECTED_1_0_KEYS, "weerg", ...REQUIRED_NOT_1_0_KEYS].sort());
    expect(validated.providers.find((row) => row.key === "weerg")).toMatchObject({
      in_1_0: false,
      permission_status: "not_in_1_0",
      enabled_for_paid_automation: false,
    });
    const protolabs = validated.providers.find((row) => row.key === "protolabs");
    expect(protolabs).toMatchObject({
      in_1_0: false,
      permission_status: "not_in_1_0",
      enabled_for_paid_automation: false,
      tos_stance: "prohibited",
    });
  });

  it("links the matrix from the acceptance tables for every named provider", async () => {
    const acceptance = await fs.readFile(path.join(repoRoot, ACCEPTANCE_TABLES_RELATIVE_PATH), "utf8");
    expect(acceptance).toContain("permissions-matrix.md");
    for (const key of [...EXPECTED_1_0_KEYS, ...REQUIRED_NOT_1_0_KEYS]) {
      expect(acceptance).toContain(key);
      expect(acceptance).toContain(`permissions-matrix.md#${key}`);
    }
    const liveReadiness = await Promise.all([
      fs.readFile(path.join(repoRoot, "docs/workflows/ovd673-fictiv-live-readiness.md"), "utf8"),
      fs.readFile(path.join(repoRoot, "docs/workflows/ovd674-quickparts-live-readiness.md"), "utf8"),
      fs.readFile(path.join(repoRoot, "docs/workflows/ovd675-weerg-live-readiness.md"), "utf8"),
    ]);
    for (const text of liveReadiness) {
      expect(text).toContain("permissions-matrix.md");
      expect(text).toContain("OVD-724");
    }
  });

  it("keeps outreach as draft-only files with no send tooling", async () => {
    for (const key of REQUIRED_OUTREACH_DRAFT_KEYS) {
      const contents = await fs.readFile(path.join(repoRoot, "docs/providers/outreach", `${key}.md`), "utf8");
      assertOutreachDraft(contents, key);
      expect(contents).toMatch(/^status:\s+draft$/m);
    }
    const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
    expect(JSON.stringify(packageJson.scripts)).not.toMatch(/outreach:send|gmail:send|vendor:email/);
    const playbook = await fs.readFile(path.join(repoRoot, PLAYBOOK_RELATIVE_PATH), "utf8");
    expect(playbook).toMatch(/Do not send this/);
  });

  it("records the model-council review as not legal advice", async () => {
    const review = await fs.readFile(path.join(repoRoot, LEGAL_REVIEW_RELATIVE_PATH), "utf8");
    expect(review).toMatch(/not legal advice/i);
    expect(review).toMatch(/Reading A/);
    expect(review).toMatch(/Reading B/);
    expect(review).toMatch(/Reading C/);
    expect(review).toMatch(/Final position/);
  });

  it("clears paid automated quoting only when the derivation rule says so", async () => {
    const { document } = await readRepoMatrix();
    for (const row of document.providers) {
      expect(row.enabled_for_paid_automation).toBe(deriveEnabledForPaidAutomation(row));
    }
    expect(deriveEnabledForPaidAutomation({
      in_1_0: true,
      tos_stance: "allowed",
      permission_status: "not_requested",
      written_permission: null,
    })).toBe(true);
    expect(deriveEnabledForPaidAutomation({
      in_1_0: true,
      tos_stance: "prior-consent",
      permission_status: "draft_outreach_prepared",
      written_permission: null,
    })).toBe(false);
    expect(deriveEnabledForPaidAutomation({
      in_1_0: true,
      tos_stance: "prior-consent",
      permission_status: "written_permission_recorded",
      written_permission: { recorded: true, reference: "letter-1", recorded_on: "2026-10-11" },
    })).toBe(true);
    expect(deriveEnabledForPaidAutomation({
      in_1_0: true,
      tos_stance: "allowed",
      permission_status: "cease_and_desist",
      written_permission: null,
    })).toBe(false);
    expect(deriveEnabledForPaidAutomation({
      in_1_0: false,
      tos_stance: "allowed",
      permission_status: "not_in_1_0",
      written_permission: null,
    })).toBe(false);
  });

  it.each([
    ["weerg", "Weerg",
      "Kept in the matrix and marked **not in 1.0**. Weerg is blocked; RMFG substitutes in the 1.0 set. 2026-10-22 owner override (appended): Owner explicitly cleared quote-only automated quoting on his own accounts on 2026-10-22, accepting ToS risk until a cease-and-desist; no orders. The silent ToS stance is unchanged. No vendor was contacted; agents never contact vendors."],
    ["geomiq", "Geomiq",
      "User terms mention Geomiq's own automated data extraction for quoting. They do not grant customers a right to automate the portal. Ask for partner API access and written permission. 2026-10-22 owner override (appended): Owner explicitly cleared quote-only automated quoting on his own accounts on 2026-10-22, accepting ToS risk until a cease-and-desist; no orders. The silent ToS stance is unchanged. No vendor was contacted; agents never contact vendors. The partner-API and written-permission ask above stays open."],
    ["oshcut", "OSH Cut",
      "Sales terms are silent on automation. Ask for partner API access and written permission. Historical admission permission basis: owner_approved (OVD-641), recorded by Blaine on 2026-10-15; the planned OVD-677 go-live was superseded by the 2026-10-20 default-off decision. OSH Cut remains liveAdapter:false with no session secrets and egress:none. This is not a matrix clearance, so enabled_for_paid_automation stays derived false. 2026-10-22 owner override (appended): Owner explicitly cleared quote-only automated quoting on his own accounts on 2026-10-22, accepting ToS risk until a cease-and-desist; no orders. The silent ToS stance is unchanged. No vendor was contacted; agents never contact vendors. It supersedes the \"not a matrix clearance\" sentence above: the override is the matrix clearance; runtime gates (liveAdapter, session secrets, egress, admission) are unchanged. The partner-API and written-permission ask above stays open."],
    ["sendcutsend", "SendCutSend",
      "Named in OVD-724. Not in the current outreach ask list. No partner-API draft is prepared until Blaine adds it. 2026-10-22 owner override (appended): Owner explicitly cleared quote-only automated quoting on his own accounts on 2026-10-22, accepting ToS risk until a cease-and-desist; no orders. The silent ToS stance is unchanged. No vendor was contacted; agents never contact vendors."],
  ])("pins the full %s notes, keeps prior notes before the 2026-10-22 override, and matches the Markdown row", async (key, displayName, fullNotes) => {
    const { document, markdown } = await readRepoMatrix();
    const row = document.providers.find((provider) => provider.key === key);
    expect(row.notes).toBe(fullNotes);
    expect(row.notes.indexOf("2026-10-22 owner override")).toBeGreaterThan(0);
    expect(row.owner_override.orders_allowed).toBe(false);
    const section = markdown.split(`- displayName: ${displayName}\n`)[1];
    expect(section).toBeDefined();
    const markdownNotes = section.match(/^- notes: (.*)$/m)[1];
    expect(markdownNotes).toBe(row.notes);
  });

  it.each(["xometry", "fictiv", "quickparts", "geomiq", "oshcut", "sendcutsend"])("accepts %s owner clearance without changing ToS or runtime admission", async (key) => {
    const { document } = await readRepoMatrix();
    const row = document.providers.find((provider) => provider.key === key);
    expect(row.tos_stance).toBe({ xometry: "prohibited", fictiv: "prior-consent", quickparts: "silent", geomiq: "silent", oshcut: "silent", sendcutsend: "silent" }[key]);
    expect(row.owner_override.recorded_on).toBe(["geomiq", "oshcut", "sendcutsend"].includes(key) ? "2026-10-22" : "2026-10-21");
    expect(row.written_permission).toBeNull();
    expect(row.replies).toEqual([]);
    expect(deriveEnabledForPaidAutomation(row)).toBe(true);
    expect(() => assertPaidAutomationGate([row])).not.toThrow();
    expect(deriveEnabledForPaidAutomation({ ...row, owner_override: null })).toBe(false);
    expect(() => assertPaidAutomationGate([{ ...row, owner_override: null }])).toThrow();
    for (const denial of [{ permission_status: "cease_and_desist" }, { in_1_0: false }]) {
      const denied = { ...row, ...denial };
      expect(deriveEnabledForPaidAutomation(denied)).toBe(false);
      expect(() => assertPaidAutomationGate([denied])).toThrow();
    }
    expect(() => assertEnabledDerivation([row], "2027-02-01")).toThrow("older than 90 days");
    if (key === "xometry") {
      expect(() => assertNoAdmittedProviderIsProhibitedOrCd([row], new Map([[key, "approved"]])))
        .toThrow("admitted 1.0 provider xometry is marked prohibited");
    }
  });

  it.each([
    ["recorded_by", "another owner"], ["recorded_on", "2026-02-30"],
    ["scope", "all accounts"], ["tos_risk_accepted_until", "forever"],
    ["orders_allowed", true], ["extra", true], ["recorded_on", undefined],
  ])("rejects an invalid owner override %s", async (field, value) => {
    const { document, schema } = await readRepoMatrix();
    const row = document.providers.find((provider) => provider.key === "xometry");
    row.owner_override[field] = value;
    expect(deriveEnabledForPaidAutomation(row)).toBe(false);
    expect(() => assertPaidAutomationGate([row])).toThrow();
    expect(() => validatePermissionsMatrixDocument(document, schema)).toThrow("owner_override");
  });

  it("keeps the owner override schema closed and optional for other providers", async () => {
    const { document, schema } = await readRepoMatrix();
    const contract = schema.$defs.providerRow.properties.owner_override;
    expect(contract.additionalProperties).toBe(false);
    expect(contract.required.toSorted()).toEqual(["orders_allowed", "recorded_by", "recorded_on", "scope", "tos_risk_accepted_until"]);
    for (const [key, value] of Object.entries(document.providers[0].owner_override)) {
      if (key === "recorded_on") expect(value).toMatch(new RegExp(contract.properties[key].pattern));
      else expect(contract.properties[key].const).toBe(value);
    }
    expect(document.providers.filter((row) => row.owner_override).map((row) => row.key))
      .toEqual(["xometry", "fictiv", "quickparts", "weerg", "geomiq", "oshcut", "sendcutsend"]);
    expect(() => validatePermissionsMatrixDocument(document, schema)).not.toThrow();
  });

  it("rejects missing, stale, duplicate or unrecorded Markdown owner overrides", async () => {
    const { document, markdown } = await readRepoMatrix();
    expect(() => assertMarkdownOwnerOverrides(markdown, document.providers)).not.toThrow();
    const line = markdown.match(/^- owner_override: .*$/m)[0];
    for (const replacement of ["", line.replace("2026-10-21", "2026-10-20"), `${line}\n${line}`]) {
      expect(() => assertMarkdownOwnerOverrides(markdown.replace(line, replacement), document.providers))
        .toThrow("xometry.owner_override");
    }
    delete document.providers[0].owner_override;
    expect(() => assertMarkdownOwnerOverrides(markdown, document.providers)).toThrow("xometry.owner_override");
  });

  it("rejects a matrix that fails the closed schema", async () => {
    const { document, schema } = await readRepoMatrix();
    const invalid = clone(document);
    delete invalid.killSwitch;
    expect(() => validatePermissionsMatrixDocument(invalid, schema)).toThrow("killSwitch");
  });

  it("rejects a 1.0 provider missing from the OVD-688 registry or manifests", async () => {
    const manifests = await readProviderManifests(repoRoot, { today: "2026-10-11" });
    const keys = manifests.map(({ manifest }) => manifest.key).filter((key) => key !== "fictiv");
    await expect(checkProviderPermissions({
      rootDir: repoRoot,
      today: "2026-10-11",
      registryKeys: keys,
    })).rejects.toThrow("matrix keys missing from OVD-688 registry or manifests: fictiv");
  });

  it("rejects a 1.0 manifest key that is absent from the matrix", async () => {
    const { document, markdown } = await readRepoMatrix();
    const matrix = clone(document);
    matrix.providers = matrix.providers.filter((row) => row.key !== "oshcut");
    const trimmedMarkdown = markdown
      .split("\n")
      .filter((line) => !line.startsWith("| oshcut "))
      .join("\n");
    await expect(checkProviderPermissions({
      rootDir: repoRoot,
      today: "2026-10-11",
      matrixDocument: matrix,
      markdown: trimmedMarkdown,
    })).rejects.toThrow("1.0 provider oshcut is missing from the permissions matrix");
  });

  it("rejects an enabled_for_paid_automation value that does not match the derivation", async () => {
    const { document, markdown } = await readRepoMatrix();
    const matrix = clone(document);
    const fictiv = matrix.providers.find((row) => row.key === "fictiv");
    delete fictiv.owner_override;
    const sections = markdown.split("### fictiv\n");
    const brokenMarkdown = sections[0] + "### fictiv\n" + sections[1].replace(/^- owner_override: .*\n/m, "");
    await expect(checkProviderPermissions({
      rootDir: repoRoot,
      today: "2026-10-11",
      matrixDocument: matrix,
      markdown: brokenMarkdown,
    })).rejects.toThrow("fictiv.enabled_for_paid_automation is true, expected false");
  });

  it("rejects an enabled provider whose date_checked is older than 90 days", async () => {
    const { document, markdown } = await readRepoMatrix();
    const matrix = clone(document);
    const rmfg = matrix.providers.find((row) => row.key === "rmfg");
    rmfg.date_checked = "2026-01-01";
    const brokenMarkdown = markdown.replace(
      "| rmfg | true | public_agent_api | allowed | oct23_checkpoint_referenced | true | 2026-10-11 | OVD-722 |",
      "| rmfg | true | public_agent_api | allowed | oct23_checkpoint_referenced | true | 2026-01-01 | OVD-722 |",
    );
    await expect(checkProviderPermissions({
      rootDir: repoRoot,
      today: "2026-10-11",
      matrixDocument: matrix,
      markdown: brokenMarkdown,
    })).rejects.toThrow(/rmfg\.date_checked is older than 90 days; re-check the provider's terms, then bump date_checked .*permissions-matrix\.v1\.json.*permissions-matrix\.md/);
  });

  it("rejects markdown that disagrees with the JSON", async () => {
    const { document, markdown } = await readRepoMatrix();
    const brokenMarkdown = markdown.replace(
      "| xometry | true | partner_or_request_only | prohibited | draft_outreach_prepared | true | 2026-10-21 | OVD-722 |",
      "| xometry | true | partner_or_request_only | silent | draft_outreach_prepared | true | 2026-10-21 | OVD-722 |",
    );
    expect(() => assertMarkdownAgreesWithJson(parseMarkdownMatrix(brokenMarkdown), document.providers))
      .toThrow("markdown/JSON disagree on xometry.tos_stance");
  });

  it("rejects an approved 1.0 admission fixture marked prohibited or C&D", () => {
    const providers = [
      {
        key: "xometry",
        in_1_0: true,
        tos_stance: "prohibited",
        permission_status: "draft_outreach_prepared",
      },
    ];
    const admitted = parseAdmissionPolicyFixtures([
      "insert into private.quote_provider_admission_policies values ('xometry'::public.vendor_name, 'approved', true);",
    ]);
    expect(admitted.get("xometry")).toBe("approved");
    expect(() => assertNoAdmittedProviderIsProhibitedOrCd(providers, admitted))
      .toThrow("admitted 1.0 provider xometry is marked prohibited");
    expect(() => assertNoAdmittedProviderIsProhibitedOrCd(
      [{ key: "weerg", in_1_0: true, tos_stance: "silent", permission_status: "cease_and_desist" }],
      new Map([["weerg", "approved"]]),
    )).toThrow("admitted 1.0 provider weerg is marked silent/cease_and_desist");
  });

  it("does not treat controlled_beta_only Xometry as a paid-automation admission conflict", async () => {
    const { document } = await readRepoMatrix();
    const xometry = document.providers.find((row) => row.key === "xometry");
    expect(xometry.tos_stance).toBe("prohibited");
    expect(xometry.enabled_for_paid_automation).toBe(true);
    const admitted = parseAdmissionPolicyFixtures([
      await fs.readFile(
        path.join(repoRoot, "supabase/migrations/20260817133902_add_quote_provider_admission_registry.sql"),
        "utf8",
      ),
    ]);
    expect(admitted.get("xometry")).toBe("controlled_beta_only");
    expect(() => assertNoAdmittedProviderIsProhibitedOrCd(document.providers, admitted)).not.toThrow();
  });

  it("fails the full lint when Protolabs is dropped or marked in 1.0", async () => {
    const { document, markdown } = await readRepoMatrix();
    const matrix = clone(document);
    matrix.providers = matrix.providers.filter((row) => row.key !== "protolabs");
    await expect(checkProviderPermissions({
      rootDir: repoRoot,
      today: "2026-10-11",
      matrixDocument: matrix,
      markdown: markdown.replace("| protolabs | false | none | prohibited | not_in_1_0 | false | 2026-10-11 | OVD-722 |\n", ""),
    })).rejects.toThrow("protolabs must remain in the permissions matrix");

    const markedIn = clone(document);
    const row = markedIn.providers.find((item) => item.key === "protolabs");
    row.in_1_0 = true;
    row.permission_status = "not_requested";
    await expect(checkProviderPermissions({
      rootDir: repoRoot,
      today: "2026-10-11",
      matrixDocument: markedIn,
      markdown: markdown.replace(
        "| protolabs | false | none | prohibited | not_in_1_0 | false | 2026-10-11 | OVD-722 |",
        "| protolabs | true | none | prohibited | not_requested | false | 2026-10-11 | OVD-722 |",
      ),
    })).rejects.toThrow("protolabs must be marked not in 1.0");
  });

  it("is wired into npm run verify", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, "package.json"), "utf8"));
    expect(packageJson.scripts["provider:permissions"]).toBe("node scripts/provider-permissions-check.mjs");
    expect(packageJson.scripts.verify).toContain("provider:permissions");
  });

  it("keeps an expected 1.0 key out of the lint script", async () => {
    const source = await fs.readFile(path.join(repoRoot, "scripts/provider-permissions-check.mjs"), "utf8");
    expect(source).not.toMatch(/REQUIRED_1_0_KEYS/);
    expect(source).not.toMatch(/"sendcutsend"/);
  });

  it("still validates fixture copies of the committed docs", async () => {
    const { temporaryRoot } = await writeTempRepo();
    const result = await checkProviderPermissions({ rootDir: temporaryRoot, today: "2026-10-11" });
    expect(result.ok).toBe(true);
    expect(result.registrySource).toBe("provider-integrations/provider-registry.v1.json");
  });

  it("prefers an OVD-688 registry when that file is present", async () => {
    const { temporaryRoot } = await writeTempRepo();
    await fs.writeFile(
      path.join(temporaryRoot, "provider-integrations/provider-registry.v1.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        oneDotZero: EXPECTED_1_0_KEYS,
        providers: [
          { key: "xometry" },
          { key: "fictiv" },
          { key: "quickparts" },
          { key: "weerg" },
          { key: "geomiq" },
          { key: "rmfg" },
          { key: "oshcut" },
          { key: "sendcutsend" },
          { key: "protolabs" },
        ],
      }, null, 2)}\n`,
    );
    const result = await checkProviderPermissions({ rootDir: temporaryRoot, today: "2026-10-11" });
    expect(result.registrySource).toBe("provider-integrations/provider-registry.v1.json");
  });

  it("falls back to the manifest glob when the registry lists providers: []", async () => {
    const { temporaryRoot } = await writeTempRepo();
    const registryPath = path.join(temporaryRoot, "provider-integrations/provider-registry.v1.json");
    const registry = JSON.parse(await fs.readFile(registryPath, "utf8"));
    await fs.writeFile(
      registryPath,
      `${JSON.stringify({ ...registry, providers: [] }, null, 2)}\n`,
    );
    const result = await checkProviderPermissions({ rootDir: temporaryRoot, today: "2026-10-11" });
    expect(result.ok).toBe(true);
    expect(result.registrySource).toBe("provider-integrations/*/manifest.v1.json");
  });
});

describe("OVD-724 cease-and-desist playbook uses the OVD-722 switch", () => {
  it("states the 1-hour no-deploy target and the exact flip command", async () => {
    const playbook = await fs.readFile(path.join(repoRoot, PLAYBOOK_RELATIVE_PATH), "utf8");
    assertCeaseAndDesistPlaybook(playbook);
    expect(playbook).toMatch(/within 1 hour/);
    expect(playbook).toMatch(/no deploy/);
    expect(playbook).toContain("npm run provider:kill -- <provider_key> --on --reason");
    expect(playbook).toContain("api_admin_set_provider_kill_switch");
    const command = extractPlaybookKillCommand(playbook, "fictiv");
    expect(command).toEqual({
      command: "npm",
      args: ["run", "provider:kill", "--", "fictiv", "--on", "--reason", "C&D received for fictiv"],
      rpc: "api_admin_set_provider_kill_switch",
      rpcArgs: { provider: "fictiv", engaged: true, reason: "C&D received for fictiv" },
      expectedDenyCode: "provider_kill_switch_engaged",
      sla: "1 hour",
      requiresDeploy: false,
    });
  });

  it("reuses the OVD-722 deny contract: an engaged switch is terminal and not a deploy", async () => {
    const playbook = await fs.readFile(path.join(repoRoot, PLAYBOOK_RELATIVE_PATH), "utf8");
    const command = extractPlaybookKillCommand(playbook, "xometry");
    expect(command.expectedDenyCode).toBe("provider_kill_switch_engaged");
    expect(command.requiresDeploy).toBe(false);
    const ovd722Kill = path.join(repoRoot, "scripts/provider-kill.mjs");
    const ovd722Present = await fs.access(ovd722Kill).then(() => true).catch(() => false);
    if (ovd722Present) {
      const source = await fs.readFile(ovd722Kill, "utf8");
      expect(source).toMatch(/provider:kill|api_service_set_provider_kill_switch/);
    }
  });
});

const DRAFT_LINE = "> DRAFT ONLY. Nothing is sent without Blaine's approval.";
const FRONT_MATTER = [
  "status: draft",
  "provider: xometry",
  "sender: Blaine Wilson",
  "send_mode: manual_by_blaine",
  "auto_send: false",
];

function buildDraft({ fields = FRONT_MATTER, body } = {}) {
  return `---\n${fields.join("\n")}\n---\n\n${body ?? `# Draft\n\n${DRAFT_LINE}\n\nAsk text.\n`}`;
}

describe("OVD-728 structural outreach checks", () => {
  it("accepts a well-formed draft", () => {
    expect(() => assertOutreachDraft(buildDraft(), "xometry")).not.toThrow();
  });

  it("rejects the outreach-negated-loose mutation that satisfied the old substring regexes", () => {
    const loose = "status: draft\n\nThis is not a draft only note; we do not send... Blaine mentioned it.\n";
    expect(() => assertOutreachDraft(loose, "xometry")).toThrow("front matter");
    const looseWithFrontMatter = buildDraft({
      body: "# Note\n\nThis is not a draft only note; we do not send... Blaine mentioned it.\n",
    });
    expect(() => assertOutreachDraft(looseWithFrontMatter, "xometry")).toThrow("first line under the H1");
  });

  it.each(["status", "sender", "send_mode", "auto_send"])("rejects a draft missing %s", (field) => {
    const fields = FRONT_MATTER.filter((line) => !line.startsWith(`${field}:`));
    expect(() => assertOutreachDraft(buildDraft({ fields }), "xometry")).toThrow(field);
  });

  it("rejects auto_send true, wrong sender, wrong send_mode, and unknown status", () => {
    const swap = (from, to) => FRONT_MATTER.map((line) => (line === from ? to : line));
    expect(() => assertOutreachDraft(buildDraft({ fields: swap("auto_send: false", "auto_send: true") }), "xometry"))
      .toThrow("auto_send: false");
    expect(() => assertOutreachDraft(buildDraft({ fields: swap("sender: Blaine Wilson", "sender: Grok Bot") }), "xometry"))
      .toThrow("sender: Blaine Wilson");
    expect(() => assertOutreachDraft(buildDraft({ fields: swap("send_mode: manual_by_blaine", "send_mode: auto") }), "xometry"))
      .toThrow("send_mode");
    expect(() => assertOutreachDraft(buildDraft({ fields: swap("status: draft", "status: pending") }), "xometry"))
      .toThrow("status");
    expect(() => assertOutreachDraft(
      buildDraft({ fields: [...FRONT_MATTER, "auto_send: false"] }),
      "xometry",
    )).toThrow("duplicate front-matter key: auto_send");
    expect(() => assertOutreachDraft(
      buildDraft({ fields: ["auto_send: true", ...FRONT_MATTER] }),
      "xometry",
    )).toThrow("duplicate front-matter key: auto_send");
  });

  it("rejects a moved or altered DRAFT ONLY line", () => {
    const moved = buildDraft({ body: `# Draft\n\nIntro paragraph.\n\n${DRAFT_LINE}\n` });
    expect(() => assertOutreachDraft(moved, "xometry")).toThrow("first line under the H1");
    const altered = buildDraft({ body: `# Draft\n\n${DRAFT_LINE.replace("DRAFT ONLY.", "Draft only.")}\n` });
    expect(() => assertOutreachDraft(altered, "xometry")).toThrow("first line under the H1");
    const aboveH1 = buildDraft({ body: `${DRAFT_LINE}\n\n# Draft\n` });
    expect(() => assertOutreachDraft(aboveH1, "xometry")).toThrow("first line under the H1");
  });

  it("still bans send instructions and keeps the RMFG Oct 23 check", () => {
    expect(() => assertOutreachDraft(buildDraft({ body: `# Draft\n\n${DRAFT_LINE}\n\nmailto:a@b.co\n` }), "xometry"))
      .toThrow("send or vendor-call");
    const rmfg = (extra) => buildDraft({ fields: FRONT_MATTER, body: `# RMFG\n\n${DRAFT_LINE}\n\n${extra}\n` });
    expect(() => assertOutreachDraft(rmfg("See the checkpoint."), "rmfg")).toThrow("Oct 23");
    expect(() => assertOutreachDraft(rmfg("See the Oct 23 checkpoint."), "rmfg")).not.toThrow();
  });
});

describe("OVD-728 outreach directory contents", () => {
  async function outreachDir() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "ovd728-outreach-"));
    temporaryRoots.push(root);
    await fs.writeFile(path.join(root, "README.md"), "# readme\n");
    await fs.writeFile(path.join(root, "xometry.md"), buildDraft());
    return root;
  }

  it("accepts only .md files", async () => {
    await expect(assertOutreachDirectoryContents(await outreachDir())).resolves.toBeUndefined();
    await expect(assertOutreachDirectoryContents(path.join(repoRoot, OUTREACH_DIR_RELATIVE_PATH))).resolves.toBeUndefined();
  });

  it.each(["send.txt", "send.eml"])("rejects %s", async (name) => {
    const root = await outreachDir();
    await fs.writeFile(path.join(root, name), "x");
    await expect(assertOutreachDirectoryContents(root)).rejects.toThrow(`.md files: ${name}`);
  });

  it("rejects a nested folder", async () => {
    const root = await outreachDir();
    await fs.mkdir(path.join(root, "nested"));
    await expect(assertOutreachDirectoryContents(root)).rejects.toThrow("subdirectories: nested");
  });

  it("rejects a symlink, even one named .md", async () => {
    const root = await outreachDir();
    await fs.symlink(path.join(root, "xometry.md"), path.join(root, "link.md"));
    await expect(assertOutreachDirectoryContents(root)).rejects.toThrow("symlinks: link.md");
  });

  it("fails the full lint when the outreach directory carries a stray file", async () => {
    const { temporaryRoot } = await writeTempRepo();
    await fs.writeFile(path.join(temporaryRoot, OUTREACH_DIR_RELATIVE_PATH, "draft.eml"), "x");
    await expect(checkProviderPermissions({ rootDir: temporaryRoot, today: "2026-10-11" }))
      .rejects.toThrow("may only contain .md files: draft.eml");
  });

  it("scans every outreach .md file for mailto and send links, including extras", async () => {
    const { temporaryRoot } = await writeTempRepo();
    await fs.writeFile(
      path.join(temporaryRoot, OUTREACH_DIR_RELATIVE_PATH, "extra.md"),
      "Please mailto:vendor@example.com now.\n",
    );
    await expect(checkProviderPermissions({ rootDir: temporaryRoot, today: "2026-10-11" }))
      .rejects.toThrow("outreach draft for extra must not include send or vendor-call instructions");
    expect(() => assertOutreachHasNoSendInstructions("mailto:a@b.co", "README")).toThrow("send or vendor-call");
  });
});

describe("OVD-728 derived 1.0 keys", () => {
  it("derives today's list from the reviewed registry", async () => {
    const registry = JSON.parse(await fs.readFile(path.join(repoRoot, "provider-integrations/provider-registry.v1.json"), "utf8"));
    const manifests = await readProviderManifests(repoRoot, { today: "2026-10-11" });
    expect([...deriveRequired10Keys(registry, manifests)]).toEqual([...EXPECTED_1_0_KEYS].sort());
  });

  it("changes when a 1.0 flag is added or removed", () => {
    const base = { oneDotZero: ["fictiv", "xometry"], providers: [{ key: "fictiv" }, { key: "xometry" }, { key: "weerg" }] };
    expect([...deriveRequired10Keys(base)]).toEqual(["fictiv", "xometry"]);
    const flagged = { ...base, providers: [...base.providers.slice(0, 2), { key: "weerg", in_1_0: true }] };
    expect([...deriveRequired10Keys(flagged)]).toEqual(["fictiv", "weerg", "xometry"]);
    const released = { ...base, providers: [{ key: "weerg", release: "1.0" }] };
    expect([...deriveRequired10Keys(released)]).toContain("weerg");
    expect([...deriveRequired10Keys({ oneDotZero: ["fictiv"], providers: [] })]).toEqual(["fictiv"]);
    expect([...deriveRequired10Keys({ providers: [] }, [{ manifest: { key: "geomiq", in_1_0: true } }])]).toEqual(["geomiq"]);
    expect(() => deriveRequired10Keys({ providers: [{ key: "weerg" }] })).toThrow("no 1.0 providers");
  });

  it("makes coverage follow the derived set", async () => {
    const { document } = await readRepoMatrix();
    const providers = document.providers;
    expect(() => assertRequiredProviderCoverage(providers, ["xometry"])).not.toThrow();
    expect(() => assertRequiredProviderCoverage(providers, ["xometry", "unknownco"])).toThrow("unknownco is missing");
    expect(() => assertRequiredProviderCoverage(providers, ["protolabs"])).toThrow("protolabs must have in_1_0=true");
  });

  it("fails the lint when a reviewed 1.0 provider is dropped from oneDotZero", async () => {
    const registry = JSON.parse(
      await fs.readFile(path.join(repoRoot, "provider-integrations/provider-registry.v1.json"), "utf8"),
    );
    const reviewed = (await readRepoMatrix()).document.providers
      .filter((row) => row.in_1_0)
      .map((row) => row.key);
    expect(() => assertOneDotZeroMatchesReviewedSet(registry.oneDotZero, reviewed)).not.toThrow();
    expect(registry.oneDotZero).not.toContain("weerg");
    registry.oneDotZero = registry.oneDotZero.filter((key) => key !== "oshcut");
    expect(() => assertOneDotZeroMatchesReviewedSet(registry.oneDotZero, reviewed)).toThrow("reviewed 1.0 set");
    await expect(checkProviderPermissions({
      rootDir: repoRoot,
      today: "2026-10-11",
      registryDocument: registry,
    })).rejects.toThrow("registry.oneDotZero does not match the reviewed 1.0 set");
  });
});

describe("OVD-728 reply logging", () => {
  const reply = { on: "2026-10-12", summary: "Asked for a call." };

  async function withReplies(key, row, replyCount = row.replies?.length ?? 0) {
    const { document, schema, markdown } = await readRepoMatrix();
    const matrix = clone(document);
    Object.assign(matrix.providers.find((item) => item.key === key), row);
    const md = markdown.replace(
      new RegExp(`(### ${key}\\n[\\s\\S]*?- replies: )\\d+`),
      `$1${replyCount}`,
    );
    return { matrix, schema, markdown: md };
  }

  it("accepts a replied row with a logged reply, in markdown and JSON", async () => {
    const { matrix, schema, markdown } = await withReplies("geomiq", { permission_status: "replied", replies: [reply] });
    expect(() => validatePermissionsMatrixDocument(matrix, schema)).not.toThrow();
    const rows = parseMarkdownMatrix(markdown.replace(
      "| geomiq | true | none | silent | draft_outreach_prepared |",
      "| geomiq | true | none | silent | replied |",
    ));
    expect(() => assertMarkdownAgreesWithJson(rows, matrix.providers, parseMarkdownReplyCounts(markdown))).not.toThrow();
  });

  it.each([
    ["missing on", { summary: "x" }],
    ["invalid on", { on: "yesterday", summary: "x" }],
    ["empty summary", { on: "2026-10-12", summary: "  " }],
  ])("rejects a reply with %s", async (_label, badReply) => {
    const { matrix, schema } = await withReplies("geomiq", { permission_status: "replied", replies: [badReply] });
    expect(() => validatePermissionsMatrixDocument(matrix, schema)).toThrow(/replies\[0\]/);
  });

  it("rejects a reply on a row still at draft_outreach_prepared", async () => {
    const { matrix, schema } = await withReplies("geomiq", { replies: [reply] });
    expect(() => validatePermissionsMatrixDocument(matrix, schema)).toThrow("still draft_outreach_prepared");
  });

  it("rejects markdown and JSON that disagree on the reply count", async () => {
    const { matrix, markdown } = await withReplies("geomiq", { permission_status: "replied", replies: [reply] }, 0);
    const rows = parseMarkdownMatrix(markdown.replace(
      "| geomiq | true | none | silent | draft_outreach_prepared |",
      "| geomiq | true | none | silent | replied |",
    ));
    expect(() => assertMarkdownAgreesWithJson(rows, matrix.providers, parseMarkdownReplyCounts(markdown)))
      .toThrow("geomiq reply count; markdown=0 json=1");
  });

  it("requires every markdown row to carry a reply count", async () => {
    const { document, markdown } = await readRepoMatrix();
    const counts = parseMarkdownReplyCounts(markdown.replace(/^- replies: 0\n/gm, ""));
    expect(() => assertMarkdownAgreesWithJson(parseMarkdownMatrix(markdown), document.providers, counts))
      .toThrow("reply count");
  });
});

describe("OVD-728 playbook structure and pending marker", () => {
  async function playbook() {
    return fs.readFile(path.join(repoRoot, PLAYBOOK_RELATIVE_PATH), "utf8");
  }

  it("requires Step 1 as the first ## heading", async () => {
    const text = await playbook();
    const swapped = text.replace("## Step 1: Engage the OVD-722 kill switch", "## Overview")
      .replace("## Step 2: Preserve evidence", "## Step 1: Engage the OVD-722 kill switch\n\n```bash\nnpm run provider:kill -- <provider_key> --on --reason \"x\"\n```\n\n## Step 2: Preserve evidence");
    expect(() => assertCeaseAndDesistPlaybook(swapped)).toThrow("first ## heading");
  });

  it("requires the first code block of Step 1 to be the kill command", async () => {
    const text = await playbook();
    const broken = text.replace("```bash\nnpm run provider:kill -- <provider_key> --on", "```bash\necho hi\n```\n\n```bash\nnpm run provider:kill -- <provider_key> --on");
    expect(() => assertCeaseAndDesistPlaybook(broken)).toThrow("first code block");
  });

  it("requires the pending OVD-722 headline while kill_switch_shipped is false", async () => {
    const text = await playbook();
    const withoutMarker = text.replace("**pending OVD-722**", "ready");
    expect(() => assertCeaseAndDesistPlaybook(withoutMarker)).toThrow("pending OVD-722");
    expect(() => assertCeaseAndDesistPlaybook(withoutMarker, { killSwitchShipped: false })).toThrow("pending OVD-722");
    expect(() => assertCeaseAndDesistPlaybook(withoutMarker, { killSwitchShipped: true })).not.toThrow();
    expect(() => assertCeaseAndDesistPlaybook(text)).not.toThrow();
  });

  it("ignores a pending marker hidden in a fence or HTML comment", async () => {
    const text = await playbook();
    const stripped = text.replace(`${PLAYBOOK_PENDING_MARKER}\n`, "");
    const fenced = `${stripped}\n\`\`\`\n${PLAYBOOK_PENDING_MARKER}\n\`\`\`\n`;
    const commented = `${stripped}\n<!-- ${PLAYBOOK_PENDING_MARKER} -->\n`;
    expect(() => assertCeaseAndDesistPlaybook(fenced)).toThrow("pending OVD-722");
    expect(() => assertCeaseAndDesistPlaybook(commented)).toThrow("pending OVD-722");
  });

  it("requires the Manual fallback section with an executable Cloud Run command", async () => {
    const text = await playbook();
    expect(text).toContain("gcloud run services update overdrafter-cad-worker");
    expect(text).toContain("--update-env-vars \"^@^WORKER_LIVE_ADAPTERS=<remaining_comma_separated_keys>\"");
    expect(text).toMatch(/new revision/i);
    expect(text).toContain("reviewed migration");
    const withoutSection = text.replace(/## Manual fallback until OVD-722 ships[\s\S]*?(?=\n## Step 2:)/, "");
    expect(() => assertCeaseAndDesistPlaybook(withoutSection)).toThrow("Manual fallback section");
    const noCommand = text.replace(/gcloud run services update overdrafter-cad-worker/, "echo skip");
    expect(() => assertCeaseAndDesistPlaybook(noCommand)).toThrow("gcloud command");
    const unfenced = text.replace(/```bash\n(gcloud run services update[\s\S]*?)```/, "$1");
    expect(unfenced).not.toBe(text);
    expect(() => assertCeaseAndDesistPlaybook(unfenced)).toThrow("fenced code block");
    const noAdmission = text.replaceAll("reviewed migration", "later change");
    expect(() => assertCeaseAndDesistPlaybook(noAdmission)).toThrow("reviewed migration");
  });

  it("rejects the plain comma form of --update-env-vars, which gcloud splits on commas", async () => {
    const text = await playbook();
    const plain = text.replace("\"^@^WORKER_LIVE_ADAPTERS=", "WORKER_LIVE_ADAPTERS=").replace("<remaining_comma_separated_keys>\"", "<remaining_comma_separated_keys>");
    expect(plain).not.toBe(text);
    expect(() => assertCeaseAndDesistPlaybook(plain)).toThrow("plain comma form");
    const quotedPlain = text.replace("^@^", "");
    expect(() => assertCeaseAndDesistPlaybook(quotedPlain)).toThrow("plain comma form");
  });

  it("requires the production project and region on the fallback commands", async () => {
    const text = await playbook();
    const noProject = text.replaceAll("  --project overdrafter-worker-9133 \\\n", "");
    expect(noProject).not.toBe(text);
    expect(() => assertCeaseAndDesistPlaybook(noProject)).toThrow("--project overdrafter-worker-9133");
    const noRegion = text.replaceAll("  --region us-west1 \\\n", "");
    expect(noRegion).not.toBe(text);
    expect(() => assertCeaseAndDesistPlaybook(noRegion)).toThrow("--region us-west1");
  });

  it("requires a read only describe step and the empty list readiness warning", async () => {
    const text = await playbook();
    const noDescribe = text.replaceAll("gcloud run services describe", "echo");
    expect(() => assertCeaseAndDesistPlaybook(noDescribe)).toThrow("describe");
    const noWarning = text.replace(/Never set an empty remainder[\s\S]*?stopping the worker service\.\n/, "");
    expect(noWarning).not.toBe(text);
    expect(() => assertCeaseAndDesistPlaybook(noWarning)).toThrow("fails readiness");
  });

  it("ignores a Manual fallback hidden in an HTML comment", async () => {
    const text = await playbook();
    const start = text.indexOf("## Manual fallback until OVD-722 ships");
    const end = text.indexOf("## Step 2:");
    const hidden = `${text.slice(0, start)}<!--\n${text.slice(start, end)}-->\n\n${text.slice(end)}`;
    expect(() => assertCeaseAndDesistPlaybook(hidden)).toThrow("Manual fallback section");
    const commented = text.replace("## Manual fallback until OVD-722 ships", "## Manual fallback until OVD-722 ships\n\n<!--");
    const withDecoy = `${commented.slice(0, commented.indexOf("## Step 2:"))}-->\n\n${commented.slice(commented.indexOf("## Step 2:"))}`;
    expect(() => assertCeaseAndDesistPlaybook(withDecoy)).toThrow();
  });

  it("rejects kill_switch_shipped true unless the OVD-722 switch exists in code", async () => {
    const { document, markdown } = await readRepoMatrix();
    expect(document.kill_switch_shipped).toBe(false);
    // The OVD-722 CLI and RPC client are in this repository now; a temporary
    // repository without them is the "switch absent" case.
    await expect(assertOvd722KillSwitchShipped(repoRoot)).resolves.toBeUndefined();
    const { temporaryRoot } = await writeTempRepo();
    await expect(assertOvd722KillSwitchShipped(temporaryRoot)).rejects.toThrow("scripts/provider-kill.mjs");
    const text = (await playbook()).replace("**pending OVD-722**", "ready");
    const shipped = { ...clone(document), kill_switch_shipped: true };
    await expect(checkProviderPermissions({ rootDir: temporaryRoot, today: "2026-10-11", playbook: text, markdown }))
      .rejects.toThrow("pending OVD-722");
    await expect(checkProviderPermissions({
      rootDir: temporaryRoot,
      today: "2026-10-11",
      playbook: text,
      markdown,
      matrixDocument: shipped,
    })).rejects.toThrow("kill_switch_shipped is true but scripts/provider-kill.mjs");
  });

  it("accepts kill_switch_shipped true only when the CLI and RPC client structurally exist", async () => {
    const { temporaryRoot, matrix } = await writeTempRepo();
    matrix.kill_switch_shipped = true;
    await fs.writeFile(
      path.join(temporaryRoot, "docs/providers/permissions-matrix.v1.json"),
      `${JSON.stringify(matrix, null, 2)}\n`,
    );
    const text = (await playbook()).replace("**pending OVD-722**", "ready");
    await fs.writeFile(path.join(temporaryRoot, "docs/runbooks/provider-cease-and-desist.md"), text);
    await expect(checkProviderPermissions({ rootDir: temporaryRoot, today: "2026-10-11" }))
      .rejects.toThrow("scripts/provider-kill.mjs");

    await fs.mkdir(path.join(temporaryRoot, "scripts"), { recursive: true });
    await fs.writeFile(
      path.join(temporaryRoot, OVD722_KILL_CLI_RELATIVE_PATH),
      "// later: api_admin_set_provider_kill_switch\nexport const name = \"not-yet\";\n",
    );
    await expect(assertOvd722KillSwitchShipped(temporaryRoot)).rejects.toThrow("does not implement provider:kill");

    await fs.writeFile(
      path.join(temporaryRoot, OVD722_KILL_CLI_RELATIVE_PATH),
      "export const command = \"provider:kill\";\nexport const rpc = \"api_admin_set_provider_kill_switch\";\n",
    );
    // OVD-771: a CLI still on the admin RPC (MFA-dependent) is not the shipped brake.
    await expect(assertOvd722KillSwitchShipped(temporaryRoot)).rejects.toThrow("does not call api_service_set_provider_kill_switch");

    await fs.writeFile(
      path.join(temporaryRoot, OVD722_KILL_CLI_RELATIVE_PATH),
      "export const command = \"provider:kill\";\nexport const rpc = \"api_service_set_provider_kill_switch\";\n",
    );
    await fs.mkdir(path.dirname(path.join(temporaryRoot, OVD722_RPC_CLIENT_RELATIVE_PATH)), { recursive: true });
    await fs.writeFile(
      path.join(temporaryRoot, OVD722_RPC_CLIENT_RELATIVE_PATH),
      "export const rpc = \"api_admin_set_provider_kill_switch\";\n",
    );
    await expect(assertOvd722KillSwitchShipped(temporaryRoot)).resolves.toBeUndefined();
    await expect(checkProviderPermissions({ rootDir: temporaryRoot, today: "2026-10-11" }))
      .resolves.toMatchObject({ ok: true });
  });
});
