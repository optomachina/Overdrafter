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
export const PROVIDER_REGISTRY_RELATIVE_PATH = "provider-integrations/provider-registry.v1.json";
export const MAX_ENABLED_AGE_DAYS = 90;
export const PLAYBOOK_PENDING_MARKER = "Target: 1 hour, no deploy, **pending OVD-722** (until the kill switch ships, follow the manual fallback below)";
export const OUTREACH_DRAFT_ONLY_LINE = "> DRAFT ONLY. Nothing is sent without Blaine's approval.";
export const OUTREACH_STATUSES = Object.freeze(["draft", "approved_by_blaine", "sent_by_blaine", "replied"]);
export const PLAYBOOK_STEP_ONE_HEADING = "## Step 1: Engage the OVD-722 kill switch";
const KILL_COMMAND_PATTERN = /^npm run provider:kill -- (?:<provider_key>|[a-z][a-z0-9]{1,49}) --on --reason ".+"$/m;

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

/**
 * The 1.0 scope comes from the reviewed provider registry (`oneDotZero` list, or an
 * `in_1_0` / `release: "1.0"` flag on a registry entry or manifest), never from this script.
 */
export function deriveRequired10Keys(registry, manifests = []) {
  const keys = new Set();
  const flagged = (entry) => isObject(entry) && (entry.in_1_0 === true || entry.release === "1.0");
  if (isObject(registry)) {
    if (Array.isArray(registry.oneDotZero)) {
      registry.oneDotZero.filter((key) => typeof key === "string").forEach((key) => keys.add(key));
    }
    for (const entry of Array.isArray(registry.providers) ? registry.providers : []) {
      if (flagged(entry) && typeof entry.key === "string") {
        keys.add(entry.key);
      }
    }
  }
  for (const item of manifests) {
    const manifest = item?.manifest ?? item;
    if (flagged(manifest) && typeof manifest.key === "string") {
      keys.add(manifest.key);
    }
  }
  if (keys.size === 0) {
    throw new Error("no 1.0 providers are declared; add them to oneDotZero in provider-integrations/provider-registry.v1.json");
  }
  return Object.freeze([...keys].sort(compareKeys));
}

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

function compareKeys(left, right) {
  return left.localeCompare(right);
}

function parseBooleanCell(value) {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
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

function assertType(condition, message) {
  if (!condition) {
    throw new TypeError(message);
  }
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
  for (const field of ["$schema", "schemaVersion", "title", "checkedOn", "kill_switch_shipped", "killSwitch", "derivation", "providers"]) {
    if (!Array.isArray(required) || !required.includes(field)) {
      throw new Error(`permissions matrix schema is missing required field ${field}`);
    }
  }
  return document;
}

function assertIsoDate(value, label) {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
    throw new TypeError(`${label} must be an ISO date`);
  }
  if (!Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new Error(`${label} is not a real calendar date`);
  }
  return value;
}

function assertNonEmptyString(value, label) {
  assertType(typeof value === "string" && value.trim().length > 0, `${label} is required`);
}

function assertProviderIdentity(provider, label) {
  assertType(typeof provider.key === "string" && PROVIDER_KEY_PATTERN.test(provider.key), `${label}.key is invalid`);
  assertNonEmptyString(provider.displayName, `${label}.displayName`);
  assertType(typeof provider.in_1_0 === "boolean", `${label}.in_1_0 must be a boolean`);
  if (!API_AVAILABILITIES.includes(provider.api_availability)) {
    throw new Error(`${label}.api_availability is invalid`);
  }
}

function assertProviderTos(provider, label) {
  const clause = requireObject(provider.tos_automation_clause, `${label}.tos_automation_clause`);
  assertNonEmptyString(clause.quote, `${label}.tos_automation_clause.quote`);
  assertType(typeof clause.url === "string" && clause.url.startsWith("https://"), `${label}.tos_automation_clause.url must be an https URL`);
  if (!TOS_STANCES.includes(provider.tos_stance)) {
    throw new Error(`${label}.tos_stance is invalid`);
  }
  assertNonEmptyString(provider.partner_program, `${label}.partner_program`);
}

function assertProviderContact(provider, label) {
  const contact = requireObject(provider.contact, `${label}.contact`);
  assertNonEmptyString(contact.role, `${label}.contact.role`);
  if (contact.published_address !== undefined) {
    assertType(typeof contact.published_address === "string", `${label}.contact.published_address must be a string`);
  }
  if (contact.published_url !== undefined) {
    assertType(typeof contact.published_url === "string", `${label}.contact.published_url must be a string`);
  }
}

function assertProviderKillSwitch(provider, label) {
  const killSwitch = requireObject(provider.kill_switch_state, `${label}.kill_switch_state`);
  if (killSwitch.source !== "OVD-722") {
    throw new Error(`${label}.kill_switch_state must point at OVD-722`);
  }
  assertType(
    typeof killSwitch.pointer === "string" && killSwitch.pointer.includes("provider_kill_switches"),
    `${label}.kill_switch_state.pointer must name the OVD-722 table`,
  );
}

function assertWrittenPermission(provider, label) {
  if (provider.written_permission === null) {
    return;
  }
  const permission = requireObject(provider.written_permission, `${label}.written_permission`);
  assertType(typeof permission.recorded === "boolean", `${label}.written_permission.recorded must be a boolean`);
  assertNonEmptyString(permission.reference, `${label}.written_permission.reference`);
  assertIsoDate(permission.recorded_on, `${label}.written_permission.recorded_on`);
}

function assertProviderReplies(provider, label) {
  assertType(Array.isArray(provider.replies), `${label}.replies must be an array`);
  for (const [replyIndex, reply] of provider.replies.entries()) {
    requireObject(reply, `${label}.replies[${replyIndex}]`);
    assertIsoDate(reply.on, `${label}.replies[${replyIndex}].on`);
    assertNonEmptyString(reply.summary, `${label}.replies[${replyIndex}].summary`);
  }
  if (provider.replies.length > 0 && provider.permission_status === "draft_outreach_prepared") {
    throw new Error(`${label} logs a reply but permission_status is still draft_outreach_prepared`);
  }
}

function assertProviderRow(row, index) {
  const label = `providers[${index}]`;
  const provider = requireObject(row, label);
  assertProviderIdentity(provider, label);
  assertProviderTos(provider, label);
  assertProviderContact(provider, label);
  if (!PERMISSION_STATUSES.includes(provider.permission_status)) {
    throw new Error(`${label}.permission_status is invalid`);
  }
  assertIsoDate(provider.date_checked, `${label}.date_checked`);
  assertProviderKillSwitch(provider, label);
  assertWrittenPermission(provider, label);
  assertType(typeof provider.enabled_for_paid_automation === "boolean", `${label}.enabled_for_paid_automation must be a boolean`);
  assertProviderReplies(provider, label);
  assertType(typeof provider.notes === "string", `${label}.notes must be a string`);
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
  if (typeof matrix.kill_switch_shipped !== "boolean") {
    throw new TypeError("kill_switch_shipped must be a boolean");
  }
  const killSwitch = requireObject(matrix.killSwitch, "killSwitch");
  if (killSwitch.issue !== "OVD-722" || killSwitch.rpc !== "api_admin_set_provider_kill_switch") {
    throw new Error("killSwitch must name the OVD-722 RPC");
  }
  if (typeof killSwitch.cli !== "string" || !killSwitch.cli.includes("provider:kill")) {
    throw new Error("killSwitch.cli must be the OVD-722 provider:kill command");
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
      in_1_0: parseBooleanCell(in_1_0),
      api_availability,
      tos_stance,
      permission_status,
      enabled_for_paid_automation: parseBooleanCell(enabled),
      date_checked,
      kill_switch_state,
    });
  }
  if (rows.length === 0) {
    throw new Error("permissions matrix markdown summary table has no provider rows");
  }
  return rows;
}

export function parseMarkdownReplyCounts(markdown) {
  const counts = new Map();
  for (const section of String(markdown).split(/^### /m).slice(1)) {
    const key = section.split(/\r?\n/, 1)[0].trim();
    const match = section.match(/^- replies: (\d+)\s*$/m);
    if (match) {
      counts.set(key, Number(match[1]));
    }
  }
  return counts;
}

export function assertMarkdownAgreesWithJson(markdownRows, providers, replyCounts) {
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
    if (replyCounts) {
      if (replyCounts.get(jsonRow.key) !== jsonRow.replies.length) {
        throw new Error(
          `markdown/JSON disagree on ${jsonRow.key} reply count; markdown=${replyCounts.get(jsonRow.key)} json=${jsonRow.replies.length}`,
        );
      }
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

export function assertRequiredProviderCoverage(providers, required10Keys) {
  const byKey = new Map(providers.map((row) => [row.key, row]));
  for (const key of required10Keys) {
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
    const absolutePath = path.join(rootDir, relativePath);
    try {
      const document = JSON.parse(await fs.readFile(absolutePath, "utf8"));
      const normalized = extractRegistryKeys(document)
        .filter((key) => typeof key === "string" && PROVIDER_KEY_PATTERN.test(key))
        .sort(compareKeys);
      if (normalized.length > 0) {
        return { source: relativePath, keys: normalized };
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

export function assertRegistryParity(matrixKeys, registryKeys, required10Keys) {
  const missingFromRegistry = matrixKeys.filter((key) => !registryKeys.includes(key));
  if (missingFromRegistry.length > 0) {
    throw new Error(`matrix keys missing from OVD-688 registry or manifests: ${missingFromRegistry.join(",")}`);
  }
  const missingFromMatrix = required10Keys.filter((key) => registryKeys.includes(key) && !matrixKeys.includes(key));
  if (missingFromMatrix.length > 0) {
    throw new Error(`1.0 registry/manifest keys missing from the matrix: ${missingFromMatrix.join(",")}`);
  }
}

export function assertCeaseAndDesistPlaybook(playbook, { killSwitchShipped = false } = {}) {
  if (typeof playbook !== "string" || playbook.trim().length === 0) {
    throw new Error("cease-and-desist playbook is missing");
  }
  const requiredSnippets = [
    ["within 1 hour", "playbook must state the 1-hour off-switch target"],
    ["no deploy", "playbook must state that the flip needs no deploy"],
    ["npm run provider:kill --", "playbook must use the OVD-722 CLI"],
    ["--on --reason", "playbook must include the exact on/reason flags"],
    ["api_admin_set_provider_kill_switch", "playbook must name the OVD-722 RPC"],
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
  const headings = playbook.split(/\r?\n/).filter((line) => /^## /.test(line));
  if (headings[0]?.trimEnd() !== PLAYBOOK_STEP_ONE_HEADING) {
    throw new Error(`playbook must open with "${PLAYBOOK_STEP_ONE_HEADING}" as its first ## heading`);
  }
  const stepOne = playbook.slice(playbook.indexOf(PLAYBOOK_STEP_ONE_HEADING) + PLAYBOOK_STEP_ONE_HEADING.length);
  const firstFence = stepOne.match(/```[^\n]*\r?\n([\s\S]*?)```/);
  if (!firstFence || !KILL_COMMAND_PATTERN.test(firstFence[1].trim())) {
    throw new Error("playbook step one's first code block must be the exact provider:kill flip command");
  }
  if (!killSwitchShipped && !playbook.split(/\r?\n/).some((line) => line.trim() === PLAYBOOK_PENDING_MARKER)) {
    throw new Error("playbook must carry the pending OVD-722 headline until kill_switch_shipped is true");
  }
}

export function extractPlaybookKillCommand(playbook, providerKey = "fictiv") {
  if (typeof providerKey !== "string" || !PROVIDER_KEY_PATTERN.test(providerKey)) {
    throw new Error("provider key for the playbook command is invalid");
  }
  assertCeaseAndDesistPlaybook(playbook);
  return {
    command: "npm",
    args: [
      "run",
      "provider:kill",
      "--",
      providerKey,
      "--on",
      "--reason",
      `C&D received for ${providerKey}`,
    ],
    rpc: "api_admin_set_provider_kill_switch",
    rpcArgs: {
      provider: providerKey,
      engaged: true,
      reason: `C&D received for ${providerKey}`,
    },
    expectedDenyCode: "provider_kill_switch_engaged",
    sla: "1 hour",
    requiresDeploy: false,
  };
}

export function parseOutreachFrontMatter(contents) {
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) {
    return null;
  }
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) {
      fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return { fields, body: contents.slice(match[0].length) };
}

export function assertOutreachDraft(contents, providerKey) {
  if (typeof contents !== "string" || contents.trim().length === 0) {
    throw new Error(`outreach draft for ${providerKey} is empty`);
  }
  const parsed = parseOutreachFrontMatter(contents);
  if (!parsed) {
    throw new Error(`outreach draft for ${providerKey} must start with YAML front matter`);
  }
  const { fields, body } = parsed;
  if (!OUTREACH_STATUSES.includes(fields.status)) {
    throw new Error(`outreach draft for ${providerKey} must declare a status`);
  }
  if (fields.sender !== "Blaine Wilson") {
    throw new Error(`outreach draft for ${providerKey} must declare sender: Blaine Wilson`);
  }
  if (fields.send_mode !== "manual_by_blaine") {
    throw new Error(`outreach draft for ${providerKey} must declare send_mode: manual_by_blaine`);
  }
  if (fields.auto_send !== "false") {
    throw new Error(`outreach draft for ${providerKey} must declare auto_send: false`);
  }
  const bodyLines = body.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  if (!/^# \S/.test(bodyLines[0] ?? "") || bodyLines[1] !== OUTREACH_DRAFT_ONLY_LINE) {
    throw new Error(
      `outreach draft for ${providerKey} must have "${OUTREACH_DRAFT_ONLY_LINE}" as the first line under the H1`,
    );
  }
  if (/mailto:|send this email|submit this form|call the API now/i.test(contents)) {
    throw new Error(`outreach draft for ${providerKey} must not include send or vendor-call instructions`);
  }
  if (providerKey === "rmfg" && !/Oct 23/i.test(contents)) {
    throw new Error("RMFG outreach must reference the Oct 23 checkpoint instead of duplicating it");
  }
}

/** The outreach directory holds only regular `.md` files: no other types, subdirectories, or symlinks. */
export async function assertOutreachDirectoryContents(directory) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`outreach directory is unreadable: ${error.message}`);
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error(`outreach directory must not contain symlinks: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      throw new Error(`outreach directory must not contain subdirectories: ${entry.name}`);
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      throw new Error(`outreach directory may only contain .md files: ${entry.name}`);
    }
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

async function loadAdmissionSql(rootDir, admissionSql) {
  if (admissionSql) {
    return admissionSql;
  }
  const files = await Promise.all(
    ADMISSION_FIXTURE_RELATIVE_PATHS.map((relativePath) => readOptionalFile(path.join(rootDir, relativePath))),
  );
  return files.filter(Boolean);
}

async function loadOutreachDrafts(rootDir, outreachFiles) {
  if (outreachFiles) {
    return outreachFiles;
  }
  await assertOutreachDirectoryContents(path.join(rootDir, OUTREACH_DIR_RELATIVE_PATH));
  const entries = await Promise.all(
    REQUIRED_OUTREACH_DRAFT_KEYS.map(async (key) => {
      const contents = await readOptionalFile(path.join(rootDir, OUTREACH_DIR_RELATIVE_PATH, `${key}.md`));
      if (!contents) {
        throw new Error(`outreach draft missing: ${key}.md`);
      }
      return [key, contents];
    }),
  );
  return Object.fromEntries(entries);
}

function assertAcceptanceTables(acceptance, required10Keys) {
  for (const key of [...required10Keys, ...REQUIRED_NOT_1_0_KEYS]) {
    if (!acceptance.includes(key) || !acceptance.includes("permissions-matrix.md")) {
      throw new Error(`acceptance tables must name ${key} and link the permissions matrix`);
    }
  }
}

async function resolveRegistry(rootDir, today, registryKeys) {
  if (registryKeys) {
    return { source: "test", keys: [...registryKeys].sort(compareKeys) };
  }
  return readOvd688RegistryOrManifestKeys(rootDir, today);
}

export async function checkProviderPermissions({
  rootDir,
  today = new Date().toISOString().slice(0, 10),
  matrixDocument,
  markdown,
  schema,
  admissionSql,
  registryKeys,
  outreachFiles,
  playbook,
  legalReview,
  acceptanceTables,
  registryDocument,
  manifests,
} = {}) {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw new Error("rootDir is required");
  }
  const resolvedSchema = schema ?? await readJson(
    path.join(rootDir, MATRIX_SCHEMA_RELATIVE_PATH),
    "permissions matrix schema",
  );
  const resolvedMatrix = matrixDocument ?? await readJson(
    path.join(rootDir, MATRIX_JSON_RELATIVE_PATH),
    "permissions matrix JSON",
  );
  const document = validatePermissionsMatrixDocument(resolvedMatrix, resolvedSchema);
  const resolvedMarkdown = markdown ?? await fs.readFile(
    path.join(rootDir, MATRIX_MARKDOWN_RELATIVE_PATH),
    "utf8",
  );
  assertMarkdownAgreesWithJson(
    parseMarkdownMatrix(resolvedMarkdown),
    document.providers,
    parseMarkdownReplyCounts(resolvedMarkdown),
  );
  const required10Keys = deriveRequired10Keys(
    registryDocument ?? await readJson(path.join(rootDir, PROVIDER_REGISTRY_RELATIVE_PATH), "provider registry"),
    manifests ?? await readProviderManifests(rootDir, { today }),
  );
  assertRequiredProviderCoverage(document.providers, required10Keys);
  assertEnabledDerivation(document.providers, today);
  assertPaidAutomationGate(document.providers);

  const registry = await resolveRegistry(rootDir, today, registryKeys);
  assertRegistryParity(document.providers.map((row) => row.key).sort(compareKeys), registry.keys, required10Keys);

  const vendorKeys = await readCurrentVendorKeys(rootDir);
  const unknownVendor = document.providers.map((row) => row.key).filter((key) => !vendorKeys.includes(key));
  if (unknownVendor.length > 0) {
    throw new Error(`matrix keys missing from vendor_name: ${unknownVendor.join(",")}`);
  }

  assertNoAdmittedProviderIsProhibitedOrCd(
    document.providers,
    parseAdmissionPolicyFixtures(await loadAdmissionSql(rootDir, admissionSql)),
  );
  assertCeaseAndDesistPlaybook(
    playbook ?? await fs.readFile(path.join(rootDir, PLAYBOOK_RELATIVE_PATH), "utf8"),
    { killSwitchShipped: document.kill_switch_shipped },
  );

  const resolvedLegal = legalReview ?? await readOptionalFile(path.join(rootDir, LEGAL_REVIEW_RELATIVE_PATH));
  if (!resolvedLegal || !/not legal advice/i.test(resolvedLegal)) {
    throw new Error("legal council review must exist and state it is not legal advice");
  }

  assertAcceptanceTables(
    acceptanceTables ?? await fs.readFile(path.join(rootDir, ACCEPTANCE_TABLES_RELATIVE_PATH), "utf8"),
    required10Keys,
  );
  const drafts = await loadOutreachDrafts(rootDir, outreachFiles);
  for (const key of REQUIRED_OUTREACH_DRAFT_KEYS) {
    assertOutreachDraft(drafts[key], key);
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
