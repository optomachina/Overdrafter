// @vitest-environment node

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
  PLAYBOOK_RELATIVE_PATH,
  REQUIRED_1_0_KEYS,
  REQUIRED_NOT_1_0_KEYS,
  REQUIRED_OUTREACH_DRAFT_KEYS,
  assertCeaseAndDesistPlaybook,
  assertMarkdownAgreesWithJson,
  assertNoAdmittedProviderIsProhibitedOrCd,
  assertOutreachDraft,
  checkProviderPermissions,
  deriveEnabledForPaidAutomation,
  extractPlaybookKillCommand,
  parseAdmissionPolicyFixtures,
  parseMarkdownMatrix,
  validatePermissionsMatrixDocument,
} from "./provider-permissions-check.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = [];

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
  it("accepts the committed matrix, outreach drafts, legal review, and playbook", async () => {
    const result = await checkProviderPermissions({ rootDir: repoRoot, today: "2026-10-11" });
    expect(result.ok).toBe(true);
    expect(result.providerCount).toBe(9);
    expect(result.enabledKeys).toEqual(["rmfg"]);
    expect(result.registrySource).toContain("manifest.v1.json");
  });

  it("covers every 1.0 key plus Protolabs marked not in 1.0", async () => {
    const { document, schema } = await readRepoMatrix();
    const validated = validatePermissionsMatrixDocument(document, schema);
    const keys = validated.providers.map((row) => row.key);
    expect(keys).toEqual([...REQUIRED_1_0_KEYS, ...REQUIRED_NOT_1_0_KEYS]);
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
    for (const key of [...REQUIRED_1_0_KEYS, ...REQUIRED_NOT_1_0_KEYS]) {
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
    matrix.providers = matrix.providers.filter((row) => row.key !== "weerg");
    const trimmedMarkdown = markdown
      .split("\n")
      .filter((line) => !line.startsWith("| weerg "))
      .join("\n");
    await expect(checkProviderPermissions({
      rootDir: repoRoot,
      today: "2026-10-11",
      matrixDocument: matrix,
      markdown: trimmedMarkdown,
    })).rejects.toThrow("1.0 provider weerg is missing from the permissions matrix");
  });

  it("rejects an enabled_for_paid_automation value that does not match the derivation", async () => {
    const { document, markdown } = await readRepoMatrix();
    const matrix = clone(document);
    const fictiv = matrix.providers.find((row) => row.key === "fictiv");
    fictiv.enabled_for_paid_automation = true;
    const brokenMarkdown = markdown.replace(
      "| fictiv | true | none | prior-consent | draft_outreach_prepared | false | 2026-10-11 | OVD-722 |",
      "| fictiv | true | none | prior-consent | draft_outreach_prepared | true | 2026-10-11 | OVD-722 |",
    );
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
    })).rejects.toThrow("rmfg.date_checked is older than 90 days");
  });

  it("rejects markdown that disagrees with the JSON", async () => {
    const { document, markdown } = await readRepoMatrix();
    const brokenMarkdown = markdown.replace(
      "| xometry | true | partner_or_request_only | prohibited | draft_outreach_prepared | false | 2026-10-11 | OVD-722 |",
      "| xometry | true | partner_or_request_only | silent | draft_outreach_prepared | false | 2026-10-11 | OVD-722 |",
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
    expect(xometry.enabled_for_paid_automation).toBe(false);
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

  it("still validates fixture copies of the committed docs", async () => {
    const { temporaryRoot } = await writeTempRepo();
    const result = await checkProviderPermissions({ rootDir: temporaryRoot, today: "2026-10-11" });
    expect(result.ok).toBe(true);
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
      expect(source).toMatch(/provider:kill|api_admin_set_provider_kill_switch/);
    }
  });
});
