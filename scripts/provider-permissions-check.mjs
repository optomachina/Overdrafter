import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readCurrentVendorKeys, readProviderManifests } from "./provider-manifest.mjs";

export const MATRIX_JSON_RELATIVE_PATH = "docs/providers/permissions-matrix.v1.json";
export const MATRIX_MARKDOWN_RELATIVE_PATH = "docs/providers/permissions-matrix.md";
export const MATRIX_SCHEMA_RELATIVE_PATH = "docs/providers/permissions-matrix.v1.schema.json";
export const OUTREACH_DIR_RELATIVE_PATH = "docs/providers/outreach";
export const LEGAL_REVIEW_RELATIVE_PATH = "docs/providers/legal-council-review-2026-10.md";
export const PLAYBOOK_RELATIVE_PATH = "docs/runbooks/provider-cease-and-desist.md";
export const ACCEPTANCE_TABLES_RELATIVE_PATH = "docs/providers/acceptance-tables.md";
export const MAX_ENABLED_AGE_DAYS = 90;

export const REQUIRED_1_0_KEYS = Object.freeze([
  "xometry",
  "fictiv",
  "quickparts",
  "weerg",
  "geomiq",
  "rmfg",
  "oshcut",
  "sendcutsend",
]);

export const REQUIRED_NOT_1_0_KEYS = Object.freeze(["protolabs"]);

export const REQUIRED_OUTREACH_DRAFT_KEYS = Object.freeze([
  "xometry",
  "fictiv",
  "quickparts",
  "weerg",
  "geomiq",
  "oshcut",
  "rmfg",
]);

export const TOS_STANCES = Object.freeze(["allowed", "prior-consent", "prohibited", "silent"]);
export const PERMISSION_STATUSES = Object.freeze([
  "not_requested",
  "draft_outreach_prepared",
  "oct23_checkpoint_referenced",
  "approved_by_blaine",
  "sent_by_blaine",
  "replied",
  "written_permission_recorded",
  "cease_and_desist",
  "not_in_1_0",
]);
export const API_AVAILABILITIES = Object.freeze([
  "none",
  "public_quote_api",
  "public_agent_api",
  "partner_or_request_only",
]);

export const OVD688_REGISTRY_CANDIDATES = Object.freeze([
  "docs/providers/registry.v1.json",
  "provider-integrations/provider-registry.v1.json",
]);

export const ADMISSION_FIXTURE_RELATIVE_PATHS = Object.freeze([
  "supabase/migrations/20260817133902_add_quote_provider_admission_registry.sql",
  "supabase/migrations/20260928081534_seed_rmfg_disabled_admission.sql",
  "supabase/migrations/20260821223851_configure_emachineshop_manual_vendor.sql",
]);

const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9]{1,49}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SUMMARY_HEADER = "| key | in_1_0 | api_availability | tos_stance | permission_status | enabled_for_paid_automation | date_checked | kill_switch_state |";

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function daysBetween(earlier, later) {
  const start = Date.parse(`${earlier}T00:00:00.000Z`);
  const end = Date.parse(`${later}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new Error(`invalid date range ${earlier} → ${later}`);
  }
  return Math.floor((end - start) / 86_400_000);
}

export function hasWrittenPermission(row) {
  return row?.written_permission?.recorded === true;
}

export function deriveEnabledForPaidAutomation(row) {
  if (!row || typeof row !== "object") {
    return false;
  }
  if (row.in_1_0 !== true) {
    return false;
  }
  if (row.permission_status === "cease_and_desist") {
    return false;
  }
  return row.tos_stance === "allowed" || hasWrittenPermission(row);
}

export function validatePermissionsMatrixSchema(schema) {
  const document = requireObject(schema, "permissions matrix schema");
  if (document.title !== "ProviderPermissionsMatrixV1" || document.additionalProperties !== false) {
    throw new Error("permissions matrix JSON schema does not define the closed V1 contract");
  }
  const required = document.required;
  for (const field of ["$schema", "schemaVersion", "title", "checkedOn", "killSwitch", "derivation", "providers"]) {
    if (!Array.isArray(required) || !required.includes(field)) {
      throw new Error(`permissions matrix schema is missing required field ${field}`);
    }
  }
  return document;
}

function assertIsoDate(value, label) {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    throw new Error(`${label} must be an ISO date`);
  }
  if (!Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${label} is not a real calendar date`);
  }
  return value;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
}

function assertOptionalString(value, label) {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
}

function assertEnumMember(allowed, value, label) {
  if (!allowed.includes(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function assertProviderIdentity(provider, label) {
  if (typeof provider.key !== "string" || !PROVIDER_KEY_PATTERN.test(provider.key)) {
    throw new Error(`${label}.key is invalid`);
  }
  assertNonEmptyString(provider.displayName, `${label}.displayName`);
  if (typeof provider.in_1_0 !== "boolean") {
    throw new Error(`${label}.in_1_0 must be a boolean`);
  }
  assertEnumMember(API_AVAILABILITIES, provider.api_availability, `${label}.api_availability`);
  assertEnumMember(TOS_STANCES, provider.tos_stance, `${label}.tos_stance`);
  assertEnumMember(PERMISSION_STATUSES, provider.permission_status, `${label}.permission_status`);
}

function assertProviderClauseAndContact(provider, label) {
  const clause = requireObject(provider.tos_automation_clause, `${label}.tos_automation_clause`);
  assertNonEmptyString(clause.quote, `${label}.tos_automation_clause.quote`);
  if (typeof clause.url !== "string" || !clause.url.startsWith("https://")) {
    throw new Error(`${label}.tos_automation_clause.url must be an https URL`);
  }
  assertNonEmptyString(provider.partner_program, `${label}.partner_program`);
  const contact = requireObject(provider.contact, `${label}.contact`);
  assertNonEmptyString(contact.role, `${label}.contact.role`);
  assertOptionalString(contact.published_address, `${label}.contact.published_address`);
  assertOptionalString(contact.published_url, `${label}.contact.published_url`);
}

function assertProviderKillSwitchPointer(provider, label) {
  const killSwitch = requireObject(provider.kill_switch_state, `${label}.kill_switch_state`);
  if (killSwitch.source !== "OVD-722") {
    throw new Error(`${label}.kill_switch_state must point at OVD-722`);
  }
  if (typeof killSwitch.pointer !== "string" || !killSwitch.pointer.includes("provider_kill_switches")) {
    throw new Error(`${label}.kill_switch_state.pointer must name the OVD-722 table`);
  }
}

function assertWrittenPermissionShape(provider, label) {
  if (provider.written_permission === null) {
    return;
  }
  const permission = requireObject(provider.written_permission, `${label}.written_permission`);
  if (typeof permission.recorded !== "boolean") {
    throw new Error(`${label}.written_permission.recorded must be a boolean`);
  }
  assertNonEmptyString(permission.reference, `${label}.written_permission.reference`);
  assertIsoDate(permission.recorded_on, `${label}.written_permission.recorded_on`);
}

function assertProviderReplies(provider, label) {
  if (!Array.isArray(provider.replies)) {
    throw new Error(`${label}.replies must be an array`);
  }
  for (const [replyIndex, reply] of provider.replies.entries()) {
    const replyLabel = `${label}.replies[${replyIndex}]`;
    requireObject(reply, replyLabel);
    assertIsoDate(reply.on, `${replyLabel}.on`);
    assertNonEmptyString(reply.summary, `${replyLabel}.summary`);
  }
}

function assertProviderRow(row, index) {
  const label = `providers[${index}]`;
  const provider = requireObject(row, label);
  assertProviderIdentity(provider, label);
  assertProviderClauseAndContact(provider, label);
  assertIsoDate(provider.date_checked, `${label}.date_checked`);
  assertProviderKillSwitchPointer(provider, label);
  assertWrittenPermissionShape(provider, label);
  if (typeof provider.enabled_for_paid_automation !== "boolean") {
    throw new Error(`${label}.enabled_for_paid_automation must be a boolean`);
  }
  assertProviderReplies(provider, label);
  if (typeof provider.notes !== "string") {
    throw new Error(`${label}.notes must be a string`);
  }
  return provider;
}

export function validatePermissionsMatrixDocument(document, schema) {
  validatePermissionsMatrixSchema(schema);
  const matrix = requireObject(document, "permissions matrix");
  if (matrix.$schema !== "./permissions-matrix.v1.schema.json") {
    throw new Error("permissions matrix $schema must be ./permissions-matrix.v1.schema.json");
  }
  if (matrix.schemaVersion !== 1 || matrix.title !== "ProviderPermissionsMatrixV1") {
    throw new Error("permissions matrix is not the closed V1 document");
  }
  assertIsoDate(matrix.checkedOn, "checkedOn");
  const killSwitch = requireObject(matrix.killSwitch, "killSwitch");
  if (killSwitch.issue !== "OVD-722" || killSwitch.rpc !== "api_admin_set_provider_kill_switch") {
    throw new Error("killSwitch must name the OVD-722 provider RPC");
  }
  if (killSwitch.globalRpc !== "api_admin_set_global_kill_switch") {
    throw new Error("killSwitch must name the OVD-722 global RPC");
  }
  const derivation = requireObject(matrix.derivation, "derivation");
  if (typeof derivation.enabledForPaidAutomation !== "string" || derivation.enabledForPaidAutomation.trim().length === 0) {
    throw new Error("derivation.enabledForPaidAutomation is required");
  }
  if (!Array.isArray(matrix.providers) || matrix.providers.length === 0) {
    throw new Error("providers must be a non-empty array");
  }
  const seen = new Set();
  const rows = matrix.providers.map((row, index) => {
    const provider = assertProviderRow(row, index);
    if (seen.has(provider.key)) {
      throw new Error(`duplicate provider key ${provider.key}`);
    }
    seen.add(provider.key);
    return provider;
  });
  return { ...matrix, providers: rows };
}

function parseMarkdownBoolean(cell) {
  if (cell === "true") {
    return true;
  }
  return cell === "false" ? false : cell;
}

export function parseMarkdownMatrix(markdown) {
  if (typeof markdown !== "string" || markdown.trim().length === 0) {
    throw new Error("permissions matrix markdown is empty");
  }
  const lines = markdown.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === SUMMARY_HEADER);
  if (headerIndex < 0) {
    throw new Error("permissions matrix markdown is missing the summary table");
  }
  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith("| ")) {
      break;
    }
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 8) {
      throw new Error(`permissions matrix markdown row is malformed: ${line}`);
    }
    const [key, in_1_0, api_availability, tos_stance, permission_status, enabled, date_checked, kill_switch_state] = cells;
    rows.push({
      key,
      in_1_0: parseMarkdownBoolean(in_1_0),
      api_availability,
      tos_stance,
      permission_status,
      enabled_for_paid_automation: parseMarkdownBoolean(enabled),
      date_checked,
      kill_switch_state,
    });
  }
  if (rows.length === 0) {
    throw new Error("permissions matrix markdown summary table has no provider rows");
  }
  return rows;
}

export function assertMarkdownAgreesWithJson(markdownRows, providers) {
  if (markdownRows.length !== providers.length) {
    throw new Error(
      `markdown/JSON provider count mismatch; markdown=${markdownRows.length} json=${providers.length}`,
    );
  }
  for (const [index, jsonRow] of providers.entries()) {
    const markdownRow = markdownRows[index];
    if (markdownRow.key !== jsonRow.key) {
      throw new Error(`markdown/JSON key order mismatch at ${index}: ${markdownRow.key} vs ${jsonRow.key}`);
    }
    const expected = {
      in_1_0: jsonRow.in_1_0,
      api_availability: jsonRow.api_availability,
      tos_stance: jsonRow.tos_stance,
      permission_status: jsonRow.permission_status,
      enabled_for_paid_automation: jsonRow.enabled_for_paid_automation,
      date_checked: jsonRow.date_checked,
    };
    for (const [field, value] of Object.entries(expected)) {
      if (markdownRow[field] !== value) {
        throw new Error(`markdown/JSON disagree on ${jsonRow.key}.${field}`);
      }
    }
    if (!String(markdownRow.kill_switch_state).includes("OVD-722")) {
      throw new Error(`markdown kill_switch_state for ${jsonRow.key} must point at OVD-722`);
    }
  }
}

export function parseAdmissionPolicyFixtures(sqlTexts) {
  const admitted = new Map();
  const pattern = /'([a-z][a-z0-9]+)'::public\.vendor_name,\s*'(disabled|evidence_required|controlled_beta_only|approved)'/g;
  for (const sql of sqlTexts) {
    if (typeof sql !== "string") {
      continue;
    }
    for (const match of sql.matchAll(pattern)) {
      admitted.set(match[1], match[2]);
    }
  }
  return admitted;
}

export function assertNoAdmittedProviderIsProhibitedOrCd(providers, admissionStates) {
  for (const row of providers) {
    if (row.in_1_0 !== true) {
      continue;
    }
    const admission = admissionStates.get(row.key);
    if (admission !== "approved") {
      continue;
    }
    if (row.tos_stance === "prohibited" || row.permission_status === "cease_and_desist") {
      throw new Error(
        `admitted 1.0 provider ${row.key} is marked ${row.tos_stance}/${row.permission_status} in the matrix`,
      );
    }
  }
}

export function assertEnabledDerivation(providers, today) {
  for (const row of providers) {
    const expected = deriveEnabledForPaidAutomation(row);
    if (row.enabled_for_paid_automation !== expected) {
      throw new Error(
        `${row.key}.enabled_for_paid_automation is ${row.enabled_for_paid_automation}, expected ${expected}`,
      );
    }
    if (row.enabled_for_paid_automation && daysBetween(row.date_checked, today) > MAX_ENABLED_AGE_DAYS) {
      throw new Error(`${row.key}.date_checked is older than ${MAX_ENABLED_AGE_DAYS} days`);
    }
  }
}

export function assertRequiredProviderCoverage(providers) {
  const byKey = new Map(providers.map((row) => [row.key, row]));
  for (const key of REQUIRED_1_0_KEYS) {
    const row = byKey.get(key);
    if (!row) {
      throw new Error(`1.0 provider ${key} is missing from the permissions matrix`);
    }
    if (row.in_1_0 !== true) {
      throw new Error(`1.0 provider ${key} must have in_1_0=true`);
    }
  }
  for (const key of REQUIRED_NOT_1_0_KEYS) {
    const row = byKey.get(key);
    if (!row) {
      throw new Error(`${key} must remain in the permissions matrix`);
    }
    if (row.in_1_0 !== false || row.permission_status !== "not_in_1_0") {
      throw new Error(`${key} must be marked not in 1.0`);
    }
  }
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is missing or invalid: ${error.message}`);
  }
}

const compareKeys = (left, right) => left.localeCompare(right);

function extractRegistryKeys(document) {
  if (Array.isArray(document.providers)) {
    return document.providers.map((row) => row.key ?? row);
  }
  if (Array.isArray(document.keys)) {
    return document.keys;
  }
  return Object.keys(document.providers ?? {});
}

export async function readOvd688RegistryOrManifestKeys(rootDir, today) {
  for (const relativePath of OVD688_REGISTRY_CANDIDATES) {
    try {
      const document = JSON.parse(await fs.readFile(path.join(rootDir, relativePath), "utf8"));
      const keys = extractRegistryKeys(document)
        .filter((key) => typeof key === "string" && PROVIDER_KEY_PATTERN.test(key))
        .sort(compareKeys);
      if (keys.length > 0) {
        return { source: relativePath, keys };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`OVD-688 registry ${relativePath} is unreadable: ${error.message}`);
      }
    }
  }
  const manifests = await readProviderManifests(rootDir, { today });
  return {
    source: "provider-integrations/*/manifest.v1.json",
    keys: manifests.map(({ manifest }) => manifest.key).sort(compareKeys),
  };
}

export function assertRegistryParity(matrixKeys, registryKeys) {
  const missingFromRegistry = matrixKeys.filter((key) => !registryKeys.includes(key));
  if (missingFromRegistry.length > 0) {
    throw new Error(`matrix keys missing from OVD-688 registry or manifests: ${missingFromRegistry.join(",")}`);
  }
  const missingFromMatrix = REQUIRED_1_0_KEYS.filter((key) => registryKeys.includes(key) && !matrixKeys.includes(key));
  if (missingFromMatrix.length > 0) {
    throw new Error(`1.0 registry/manifest keys missing from the matrix: ${missingFromMatrix.join(",")}`);
  }
}

export function assertCeaseAndDesistPlaybook(playbook) {
  if (typeof playbook !== "string" || playbook.trim().length === 0) {
    throw new Error("cease-and-desist playbook is missing");
  }
  const requiredSnippets = [
    ["within 1 hour", "playbook must state the 1-hour off-switch target"],
    ["no deploy", "playbook must state that the flip needs no deploy"],
    ["api_admin_set_provider_kill_switch(provider := '<provider_key>', engaged := true, reason :=", "playbook step one must show the exact OVD-722 flip call"],
    ["api_admin_set_global_kill_switch", "playbook must name the OVD-722 global RPC"],
    ["private.provider_kill_switches", "playbook must name the OVD-722 per-provider table"],
    ["private.provider_global_kill_switch", "playbook must name the OVD-722 global table"],
    ["cancelled_provider_disabled", "playbook must name the in-flight task end state"],
    ["OVD-722 is not merged yet", "playbook must state the OVD-722 dependency"],
    ["provider_kill_switch_engaged", "playbook must name the OVD-722 deny code"],
    ["permission_status=cease_and_desist", "playbook must update the matrix after a C&D"],
    ["Owner: Blaine", "playbook must name Blaine as owner"],
  ];
  const normalized = playbook.replace(/\s+/g, " ");
  for (const [snippet, message] of requiredSnippets) {
    if (!normalized.includes(snippet)) {
      throw new Error(message);
    }
  }
}

export function extractPlaybookKillCommand(playbook, providerKey = "fictiv") {
  if (typeof providerKey !== "string" || !PROVIDER_KEY_PATTERN.test(providerKey)) {
    throw new Error("provider key for the playbook command is invalid");
  }
  assertCeaseAndDesistPlaybook(playbook);
  const reason = `C&D received for ${providerKey}`;
  return {
    rpc: "api_admin_set_provider_kill_switch",
    rpcArgs: { provider: providerKey, engaged: true, reason },
    expectedDenyCode: "provider_kill_switch_engaged",
    expectedTaskState: "cancelled_provider_disabled",
    sla: "1 hour",
    requiresDeploy: false,
  };
}

export function assertOutreachDraft(contents, providerKey) {
  if (typeof contents !== "string" || contents.trim().length === 0) {
    throw new Error(`outreach draft for ${providerKey} is empty`);
  }
  if (!/^status:\s+(draft|approved_by_blaine|sent_by_blaine|replied)\s*$/m.test(contents)) {
    throw new Error(`outreach draft for ${providerKey} must declare a status`);
  }
  if (providerKey === "rmfg") {
    if (!/Oct 23/i.test(contents)) {
      throw new Error("RMFG outreach must reference the Oct 23 checkpoint instead of duplicating it");
    }
    return;
  }
  if (!/draft only|do not send|nothing is sent/i.test(contents)) {
    throw new Error(`outreach draft for ${providerKey} must say it is draft-only and unsent`);
  }
  if (!/Blaine/i.test(contents)) {
    throw new Error(`outreach draft for ${providerKey} must say Blaine is the sender`);
  }
  if (/mailto:|send this email|submit this form|call the API now/i.test(contents)) {
    throw new Error(`outreach draft for ${providerKey} must not include send or vendor-call instructions`);
  }
}

export function assertPaidAutomationGate(providers) {
  for (const row of providers) {
    if (row.enabled_for_paid_automation !== true) {
      continue;
    }
    if (row.in_1_0 !== true) {
      throw new Error(`${row.key} is enabled for paid automation but is not a 1.0 provider`);
    }
    if (row.tos_stance !== "allowed" && !hasWrittenPermission(row)) {
      throw new Error(`${row.key} is enabled for paid automation without an allowed stance or written permission`);
    }
    if (row.permission_status === "cease_and_desist" || row.tos_stance === "prohibited") {
      throw new Error(`${row.key} is enabled for paid automation while prohibited or under C&D`);
    }
  }
}

async function readOptionalFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function loadAdmissionSql(rootDir) {
  const texts = [];
  for (const relativePath of ADMISSION_FIXTURE_RELATIVE_PATHS) {
    const sql = await readOptionalFile(path.join(rootDir, relativePath));
    if (sql) {
      texts.push(sql);
    }
  }
  return texts;
}

async function loadOutreachDrafts(rootDir) {
  const drafts = {};
  for (const key of REQUIRED_OUTREACH_DRAFT_KEYS) {
    const contents = await readOptionalFile(path.join(rootDir, OUTREACH_DIR_RELATIVE_PATH, `${key}.md`));
    if (!contents) {
      throw new Error(`outreach draft missing: ${key}.md`);
    }
    drafts[key] = contents;
  }
  return drafts;
}

function assertLegalReview(legalReview) {
  if (!legalReview || !/not legal advice/i.test(legalReview)) {
    throw new Error("legal council review must exist and state it is not legal advice");
  }
}

function assertAcceptanceTablesLinkMatrix(acceptanceTables) {
  for (const key of [...REQUIRED_1_0_KEYS, ...REQUIRED_NOT_1_0_KEYS]) {
    if (!acceptanceTables.includes(key) || !acceptanceTables.includes("permissions-matrix.md")) {
      throw new Error(`acceptance tables must name ${key} and link the permissions matrix`);
    }
  }
}

async function checkRegistryAndVendors({ rootDir, today, registryKeys, providers }) {
  const registry = registryKeys
    ? { source: "test", keys: [...registryKeys].sort(compareKeys) }
    : await readOvd688RegistryOrManifestKeys(rootDir, today);
  const matrixKeys = providers.map((row) => row.key);
  assertRegistryParity([...matrixKeys].sort(compareKeys), registry.keys);

  const vendorKeys = await readCurrentVendorKeys(rootDir);
  const unknownVendor = matrixKeys.filter((key) => !vendorKeys.includes(key));
  if (unknownVendor.length > 0) {
    throw new Error(`matrix keys missing from vendor_name: ${unknownVendor.join(",")}`);
  }
  return registry;
}

async function resolveInputs(rootDir, overrides) {
  const read = (relativePath) => fs.readFile(path.join(rootDir, relativePath), "utf8");
  return {
    schema: overrides.schema ?? await readJson(path.join(rootDir, MATRIX_SCHEMA_RELATIVE_PATH), "permissions matrix schema"),
    matrix: overrides.matrixDocument ?? await readJson(path.join(rootDir, MATRIX_JSON_RELATIVE_PATH), "permissions matrix JSON"),
    markdown: overrides.markdown ?? await read(MATRIX_MARKDOWN_RELATIVE_PATH),
    admissionSql: overrides.admissionSql ?? await loadAdmissionSql(rootDir),
    playbook: overrides.playbook ?? await read(PLAYBOOK_RELATIVE_PATH),
    legalReview: overrides.legalReview ?? await readOptionalFile(path.join(rootDir, LEGAL_REVIEW_RELATIVE_PATH)),
    acceptanceTables: overrides.acceptanceTables ?? await read(ACCEPTANCE_TABLES_RELATIVE_PATH),
    drafts: overrides.outreachFiles ?? await loadOutreachDrafts(rootDir),
  };
}

export async function checkProviderPermissions({
  rootDir,
  today = new Date().toISOString().slice(0, 10),
  ...overrides
} = {}) {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw new Error("rootDir is required");
  }
  const inputs = await resolveInputs(rootDir, overrides);
  const document = validatePermissionsMatrixDocument(inputs.matrix, inputs.schema);
  assertMarkdownAgreesWithJson(parseMarkdownMatrix(inputs.markdown), document.providers);
  assertRequiredProviderCoverage(document.providers);
  assertEnabledDerivation(document.providers, today);
  assertPaidAutomationGate(document.providers);

  const registry = await checkRegistryAndVendors({
    rootDir,
    today,
    registryKeys: overrides.registryKeys,
    providers: document.providers,
  });
  assertNoAdmittedProviderIsProhibitedOrCd(document.providers, parseAdmissionPolicyFixtures(inputs.admissionSql));
  assertCeaseAndDesistPlaybook(inputs.playbook);
  assertLegalReview(inputs.legalReview);
  assertAcceptanceTablesLinkMatrix(inputs.acceptanceTables);
  for (const key of REQUIRED_OUTREACH_DRAFT_KEYS) {
    assertOutreachDraft(inputs.drafts[key], key);
  }

  return {
    ok: true,
    providerCount: document.providers.length,
    enabledKeys: document.providers.filter((row) => row.enabled_for_paid_automation).map((row) => row.key),
    registrySource: registry.source,
    checkedOn: document.checkedOn,
  };
}

export async function runProviderPermissionsCheckCli(argv = process.argv.slice(2), rootDir = process.cwd()) {
  if (argv.length > 0) {
    throw new Error(`unknown argument: ${argv[0]}`);
  }
  const result = await checkProviderPermissions({ rootDir });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    await runProviderPermissionsCheckCli();
  } catch (error) {
    process.stderr.write(`provider:permissions failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
