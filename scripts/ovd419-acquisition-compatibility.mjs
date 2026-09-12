import { createHash } from "node:crypto";
import { digest } from "./ovd419-job-diagnostic.mjs";
import { parseBoundedSqlJson, decodeOfficialSqlWrapper } from "./ovd419-acquisition-support/official-sql-wrapper.mjs";

export const ACQUISITION_IDENTITIES = Object.freeze({
  diagnosticSourceCommit: "e9c1073c47277f7ba7709655d94d4a399e78fffa",
  readPlanSha256: "58f007868ada20901080b914cfeb0c7f90d1169166a62bdb25314a4ea3bc5354",
  catalogueQuerySha256: "0ee434293e2df44fda3a5e4d8d45d52e1622286370a1653a79a2424ccb89dea8",
  containmentQuerySha256: "f489eb1961f74ef4cacdda4e7a99cbf11b08538a050a52cf36d725349a864346",
  rpcBodySha256: "d2c93170b557ca49739310d091e2a6e958fdd6eaa2ea5ae69ee2345291318b4c",
});
export const ACQUISITION_LIMITS = Object.freeze({ attempts: 1, retries: 0, totalDurationMs: 900000, perReadMs: 30000,
  maximumCloudCommands: 84, maximumSqlCalls: 3, maximumTotalCalls: 87, cloudResponseBytes: 4194304,
  sqlPayloadBytes: 2097152, sqlWrapperAllowanceBytes: 65536, aggregateTransportBytes: 33554432,
  persistedPrivateBytes: 1048576, persistedSanitizedBytes: 1048576, maximumListRows: 1000,
  maximumMatchingRoleBindings: 50, maximumCatalogueRows: 2000, maximumQueueRowsPerTable: 100000 });
const RPC = "public.api_get_commercial_rollout_controls";
const TABLES = ["public.work_queue", "public.quote_requests", "private.commercial_rollout_controls", "private.commercial_rollout_control_events"];
const CONTROLS = ["automatic_quote_collection", "commercial_admin_mutations", "order_administration", "promotion_codes"];
const ENUMS = { queue_task_status: ["queued", "running", "completed", "failed", "cancelled"], quote_request_status: ["queued", "requesting", "received", "failed", "canceled"] };
const NAT_ARGS = ["compute", "routers", "get-nat-mapping-info", "overdrafter-xometry-egress-router", "--nat-name", "overdrafter-xometry-egress-nat", "--project", "overdrafter-worker-9133", "--region", "us-west1", "--format=json(instanceName)"];
const sha = value => createHash("sha256").update(value).digest("hex");
const stop = () => { throw new Error("acquisition_compatibility_rejected"); };
function need(value) { if (!value) stop(); }
function shape(v, names) {
  need(v && Object.getPrototypeOf(v) === Object.prototype);
  const actual = Object.keys(v);
  need(actual.length === names.length && actual.every(name => names.includes(name)));
}
function integer(v, min, max) { need(Number.isSafeInteger(v) && v >= min && v <= max); }
function text(v, max = 65536) { need(typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= max); }
function nullableText(v) { if (v !== null) text(v); }
function bool(v) { need(typeof v === "boolean"); }
function hash(v, size = 64) { need(typeof v === "string" && new RegExp(`^[0-9a-f]{${size}}$`).test(v)); }
function time(v) { text(v, 32); const n = Date.parse(v); need(Number.isFinite(n) && new Date(n).toISOString() === v); return n; }
function uniqueStrings(v, max = 1000) { need(Array.isArray(v) && v.length <= max); v.forEach(x => text(x, 256)); need(new Set(v).size === v.length); }
function definition(row) {
  const d = row.definition;
  const fields = {
    relation: ["kind", "rls", "forceRls", "owner", "acl"], column: ["number", "type", "notNull", "acl", "default"],
    constraint: ["definition", "validated"], index: ["definition", "valid", "ready"],
    policy: ["command", "permissive", "roles", "using", "check"], trigger: ["enabled", "definition", "function"],
    function: ["securityDefiner", "volatility", "config", "owner", "acl", "definition"], enum: ["labels"],
    role: ["inherit", "superuser", "bypassRls", "memberships"], schema: ["owner", "acl"],
    diagnostic_rpc_contract: ["argumentCount", "returnsSet", "resultType", "language", "source", "serviceRoleExecute", "anonExecute", "authenticatedExecute", "publicExecute"],
    diagnostic_queue_privileges: ["serviceRoleIdSelect", "serviceRoleStatusSelect"], diagnostic_schema_privileges: ["serviceRoleUsage"],
    diagnostic_rpc_owner_visibility: ["ownerSchemaUsage", "ownerSelect", "ownerUnfiltered"],
  };
  need(Object.hasOwn(fields, row.kind)); shape(d, fields[row.kind]);
  for (const [key, v] of Object.entries(d)) {
    if (["rls", "forceRls", "notNull", "validated", "valid", "ready", "permissive", "securityDefiner", "inherit", "superuser", "bypassRls", "returnsSet", "serviceRoleExecute", "anonExecute", "authenticatedExecute", "publicExecute", "serviceRoleIdSelect", "serviceRoleStatusSelect", "serviceRoleUsage", "ownerSchemaUsage", "ownerSelect", "ownerUnfiltered"].includes(key)) bool(v);
    else if (["acl", "default", "using", "check"].includes(key)) nullableText(v);
    else if (["roles", "memberships"].includes(key)) { if (v !== null) uniqueStrings(v); }
    else if (["config", "labels"].includes(key)) uniqueStrings(v);
    else if (key === "number") integer(v, 1, 1600);
    else if (key === "argumentCount") integer(v, 0, 100);
    else text(v);
  }
}
function scopedRow(row) {
  if (["relation", "column", "constraint", "index", "policy", "trigger"].includes(row.kind)) {
    if (row.kind === "relation") need(TABLES.includes(row.identity));
    else need(TABLES.some(t => row.identity.startsWith(`${t}.`) && row.identity.length > t.length + 1));
  } else if (row.kind === "function") need(row.identity === `${RPC}()`);
  else if (row.kind === "diagnostic_rpc_contract") need(row.identity === RPC);
  else if (row.kind === "enum") need(Object.keys(ENUMS).map(e => `public.${e}`).includes(row.identity));
  else if (row.kind === "role") need(["anon", "authenticated", "service_role"].includes(row.identity));
  else if (row.kind === "schema") need(["public", "private"].includes(row.identity));
  else if (row.kind === "diagnostic_schema_privileges") need(row.identity === "public");
  else if (row.kind === "diagnostic_queue_privileges") need(TABLES.slice(0, 2).includes(row.identity));
  else if (row.kind === "diagnostic_rpc_owner_visibility") need(TABLES.slice(2).includes(row.identity));
  else stop();
}
function catalogueRecords(rows) {
  const records = new Map(), columnNumbers = new Set();
  for (const row of rows) {
    shape(row, ["kind", "identity", "definition"]); text(row.kind, 64); text(row.identity, 512);
    const key = `${row.kind}:${row.identity}`; need(!records.has(key)); definition(row); scopedRow(row);
    if (row.kind === "column") {
      const table = TABLES.find(t => row.identity.startsWith(`${t}.`));
      const numberKey = `${table}:${row.definition.number}`; need(!columnNumbers.has(numberKey)); columnNumbers.add(numberKey);
    }
    records.set(key, row.definition);
  }
  return records;
}
function validatePrivateColumns(get) {
  // Require the private columns actually read by the pinned RPC; extra catalogue
  // metadata is retained in accepted bytes and checked for shape/scope above.
  const privateColumns = {
    [TABLES[2]]: { capability: "text", enabled: "boolean", revision: "bigint", change_reason: "text", updated_at: "timestamp with time zone", updated_by_user_id: "uuid", updated_by_actor: "text" },
    [TABLES[3]]: { id: "bigint", capability: "text", idempotency_key: "text", previous_enabled: "boolean", enabled: "boolean", changed: "boolean", previous_revision: "bigint", revision: "bigint", change_reason: "text", changed_at: "timestamp with time zone", changed_by_user_id: "uuid", changed_by_actor: "text", changed_by_role: "text" },
  };
  for (const [table, columns] of Object.entries(privateColumns)) for (const [name, type] of Object.entries(columns)) {
    const c = get("column", `${table}.${name}`); need(c.type === type);
    if (!["updated_by_user_id", "updated_by_actor", "changed_by_user_id"].includes(name)) need(c.notNull);
  }
}
function catalogue(value) {
  shape(value, ["schema", "relationCount", "rows"]);
  need(value.schema === "OVD419-DIAGNOSTIC-CATALOGUE-COMPATIBILITY-NOT-AUTHORITY-v1" && value.relationCount === 4);
  need(Array.isArray(value.rows) && value.rows.length > 0 && value.rows.length <= 2000);
  const records = catalogueRecords(value.rows);
  const get = (kind, id) => { const v = records.get(`${kind}:${id}`); need(v); return v; };
  for (const table of TABLES) need(get("relation", table).kind === "r");
  for (const [table, status] of [[TABLES[0], "queue_task_status"], [TABLES[1], "quote_request_status"]]) {
    const id = get("column", `${table}.id`), state = get("column", `${table}.status`);
    need(id.type === "uuid" && id.notNull && [`public.${status}`, status].includes(state.type) && state.notNull);
    need(digest(get("enum", `public.${status}`).labels) === digest(ENUMS[status]));
    need(Object.values(get("diagnostic_queue_privileges", table)).every(v => v === true));
  }
  for (const table of TABLES.slice(2)) need(Object.values(get("diagnostic_rpc_owner_visibility", table)).every(v => v === true));
  validatePrivateColumns(get);
  const fn = get("function", `${RPC}()`), contract = get("diagnostic_rpc_contract", RPC);
  need(fn.securityDefiner && fn.volatility === "s" && digest(fn.config) === digest(["search_path=pg_catalog"]));
  need(contract.argumentCount === 0 && !contract.returnsSet && contract.resultType === "jsonb" && contract.language === "sql");
  need(sha(contract.source) === ACQUISITION_IDENTITIES.rpcBodySha256 && fn.definition.includes(contract.source));
  need(contract.serviceRoleExecute && !contract.anonExecute && !contract.authenticatedExecute && !contract.publicExecute);
  for (const role of ["anon", "authenticated"]) need(!get("role", role).superuser);
  // Superuser plus reported denied EXECUTE would contradict PostgreSQL privileges.
  const role = get("role", "service_role"); need(role.superuser || role.bypassRls);
  for (const name of ["public", "private"]) get("schema", name);
  need(get("diagnostic_schema_privileges", "public").serviceRoleUsage);
  return digest(value);
}
function containment(v) {
  shape(v, ["schema", "visibility", "controls", "workQueue", "quoteRequests"]);
  need(v.schema === "OVD419-PREFLIGHT-CONTAINMENT-NOT-AUTHORITY");
  shape(v.visibility, ["bypassRls", "readOnly"]); need(v.visibility.bypassRls === true && v.visibility.readOnly === "on");
  need(Array.isArray(v.controls) && v.controls.length === 4);
  for (let i = 0; i < 4; i++) { shape(v.controls[i], ["capability", "enabled"]); need(v.controls[i].capability === CONTROLS[i] && v.controls[i].enabled === false); }
  for (const queue of [v.workQueue, v.quoteRequests]) {
    shape(queue, ["total", "active", "invalid", "fingerprint"]); integer(queue.total, 0, 100000);
    need(queue.active === 0 && queue.invalid === 0); hash(queue.fingerprint);
    if (queue.total === 0) need(queue.fingerprint === sha(""));
  }
  return { fingerprint: digest(v), controls: digest(v.controls) };
}
function sqlPayload(raw) {
  text(raw, ACQUISITION_LIMITS.sqlPayloadBytes + ACQUISITION_LIMITS.sqlWrapperAllowanceBytes);
  let rows;
  if (raw.startsWith("Below is the result of the SQL query.")) rows = decodeOfficialSqlWrapper(raw);
  else rows = parseBoundedSqlJson(raw, ACQUISITION_LIMITS.sqlPayloadBytes);
  need(Array.isArray(rows) && rows.length === 1); shape(rows[0], ["evidence"]); return rows[0].evidence;
}
function validate(raw, qualification) {
  shape(qualification, ["acquisitionSourceCommit", "inputManifestSha256", "now"]);
  hash(qualification.acquisitionSourceCommit, 40); hash(qualification.inputManifestSha256); integer(qualification.now, 0, Number.MAX_SAFE_INTEGER);
  text(raw, ACQUISITION_LIMITS.aggregateTransportBytes);
  const input = parseBoundedSqlJson(raw, ACQUISITION_LIMITS.aggregateTransportBytes);
  shape(input, ["schema", "mode", "provenance", "limits", "usage", "observations"]);
  need(input.schema === "OVD419-ACQUISITION-COMPATIBILITY-INPUT-v2" && input.mode === "TEST_ONLY");
  shape(input.provenance, ["acquisitionSourceCommit", "diagnosticSourceCommit", "inputManifestSha256", "readPlanSha256", "invocationId", "startedAt", "completedAt"]);
  const p = input.provenance;
  need(p.acquisitionSourceCommit === qualification.acquisitionSourceCommit && p.inputManifestSha256 === qualification.inputManifestSha256);
  need(p.diagnosticSourceCommit === ACQUISITION_IDENTITIES.diagnosticSourceCommit && p.readPlanSha256 === ACQUISITION_IDENTITIES.readPlanSha256);
  need(typeof p.invocationId === "string" && /^TEST_ONLY_[A-Za-z0-9_-]{1,80}$/.test(p.invocationId));
  const start = time(p.startedAt), end = time(p.completedAt);
  need(start <= end && end - start <= 900000 && qualification.now >= end && qualification.now - end <= 30000);
  shape(input.limits, Object.keys(ACQUISITION_LIMITS)); need(digest(input.limits) === digest(ACQUISITION_LIMITS));
  shape(input.usage, ["cloudCalls", "sqlCalls", "receivedBytes", "elapsedMs"]);
  const usage = input.usage; integer(usage.cloudCalls, 34, 84); need(usage.sqlCalls === 3 && usage.cloudCalls + usage.sqlCalls <= 87);
  integer(usage.receivedBytes, 0, 33554432); need(usage.elapsedMs === end - start);
  need(Array.isArray(input.observations) && input.observations.length === 5);
  const expected = [
    ["catalogue", 0, ACQUISITION_IDENTITIES.catalogueQuerySha256], ["containmentOpening", 1, ACQUISITION_IDENTITIES.containmentQuerySha256],
    ["E13", 14, sha(JSON.stringify(NAT_ARGS))], ["containmentClosing", usage.cloudCalls - 7, ACQUISITION_IDENTITIES.containmentQuerySha256],
    ["closingE13", usage.cloudCalls + 2, sha(JSON.stringify(NAT_ARGS))],
  ];
  let previous = start, bytes = 0;
  const data = input.observations.map((observation, i) => {
    shape(observation, ["id", "sequence", "requestSha256", "startedAt", "completedAt", "complete", "settled", "payload"]);
    need(observation.id === expected[i][0] && observation.sequence === expected[i][1] && observation.requestSha256 === expected[i][2]);
    need(observation.complete === true && observation.settled === true);
    const began = time(observation.startedAt), ended = time(observation.completedAt);
    need(began >= previous && ended >= began && ended <= end && ended - began <= 30000); previous = ended;
    text(observation.payload, i === 2 || i === 4 ? 4194304 : 2162688); bytes += Buffer.byteLength(observation.payload);
    if (i === 2 || i === 4) { const mappings = parseBoundedSqlJson(observation.payload, 4194304); need(Array.isArray(mappings) && mappings.length === 0); return null; }
    return sqlPayload(observation.payload);
  });
  need(bytes <= usage.receivedBytes && qualification.now - previous <= 30000);
  const catalogueFingerprint = catalogue(data[0]), before = containment(data[1]), after = containment(data[3]);
  need(before.fingerprint === after.fingerprint);
  return Object.freeze({ schema: "OVD419-COMPATIBILITY-RESULT-NOT-AUTHORITY-v2", mode: "TEST_ONLY", privateBindingReady: false,
    acquisitionSourceCommit: p.acquisitionSourceCommit, diagnosticSourceCommit: p.diagnosticSourceCommit,
    inputManifestSha256: p.inputManifestSha256, readPlanSha256: p.readPlanSha256, invocationId: p.invocationId,
    catalogueFingerprint, controlsFingerprint: before.controls, containmentFingerprint: before.fingerprint,
    acceptedSha256: sha(raw), acceptedBytes: raw, completedAt: p.completedAt, sqlRuntimeQualified: false });
}

/**
 * Validate injected synthetic evidence without I/O. Preserves accepted bytes and
 * closes only catalogue/containment/NAT/provenance predicates, not full resource
 * acquisition, actual transport origin, schema execution, authority or persistence.
 * The qualification argument is the caller's trusted, separately hash-bound input.
 */
export function validateAcquisitionCompatibility(raw, qualification) {
  try { return validate(raw, qualification); } catch { stop(); }
}
