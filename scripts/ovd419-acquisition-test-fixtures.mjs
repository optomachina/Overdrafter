// Conspicuously synthetic in-memory SQL/catalogue fixtures. No I/O or real state.
import { createHash } from "node:crypto";
import { ACQUISITION_IDENTITIES, ACQUISITION_LIMITS } from "./ovd419-acquisition-compatibility.mjs";
const RPC_SOURCE = "\n  select pg_catalog.jsonb_build_object(\n    'controls',\n    coalesce(\n      (\n        select pg_catalog.jsonb_agg(\n          pg_catalog.jsonb_build_object(\n            'capability', control.capability,\n            'enabled', control.enabled,\n            'revision', control.revision,\n            'changeReason', control.change_reason,\n            'updatedAt', control.updated_at,\n            'updatedByUserId', control.updated_by_user_id,\n            'updatedByActor', control.updated_by_actor\n          )\n          order by control.capability\n        )\n        from private.commercial_rollout_controls control\n      ),\n      '[]'::jsonb\n    ),\n    'recentEvents',\n    coalesce(\n      (\n        select pg_catalog.jsonb_agg(event_payload.payload order by event_payload.id desc)\n        from (\n          select\n            event.id,\n            pg_catalog.jsonb_build_object(\n              'id', event.id,\n              'capability', event.capability,\n              'idempotencyKey', event.idempotency_key,\n              'previousEnabled', event.previous_enabled,\n              'enabled', event.enabled,\n              'changed', event.changed,\n              'previousRevision', event.previous_revision,\n              'revision', event.revision,\n              'changeReason', event.change_reason,\n              'changedAt', event.changed_at,\n              'changedByUserId', event.changed_by_user_id,\n              'changedByActor', event.changed_by_actor,\n              'changedByRole', event.changed_by_role\n            ) as payload\n          from private.commercial_rollout_control_events event\n          order by event.id desc\n          limit 100\n        ) event_payload\n      ),\n      '[]'::jsonb\n    )\n  );\n";
const sha = text => createHash("sha256").update(text).digest("hex");
const CONTROLS = ["automatic_quote_collection", "commercial_admin_mutations", "order_administration", "promotion_codes"];
const TABLES = ["public.work_queue", "public.quote_requests", "private.commercial_rollout_controls", "private.commercial_rollout_control_events"];
const OWNER = "TEST_ONLY_RPC_OWNER";
/** Complete synthetic responses for the exact reviewed catalogue and containment SQL. */
export function compatibilityFixture() {
  const rows = [], add = (kind, identity, definition) => rows.push({ kind, identity, definition });
  for (const table of TABLES) add("relation", table, { kind: "r", rls: true, forceRls: false, owner: OWNER, acl: null });
  const columns = {
    [TABLES[0]]: { id: "uuid", status: "public.queue_task_status" },
    [TABLES[1]]: { id: "uuid", status: "public.quote_request_status" },
    [TABLES[2]]: { capability: "text", enabled: "boolean", revision: "bigint", change_reason: "text", updated_at: "timestamp with time zone", updated_by_user_id: "uuid", updated_by_actor: "text" },
    [TABLES[3]]: { id: "bigint", capability: "text", idempotency_key: "text", previous_enabled: "boolean", enabled: "boolean", changed: "boolean", previous_revision: "bigint", revision: "bigint", change_reason: "text", changed_at: "timestamp with time zone", changed_by_user_id: "uuid", changed_by_actor: "text", changed_by_role: "text" },
  };
  for (const [table, fields] of Object.entries(columns)) {
    let number = 0;
    for (const [name, type] of Object.entries(fields)) add("column", `${table}.${name}`, { number: ++number, type, notNull: !["updated_by_user_id", "updated_by_actor", "changed_by_user_id"].includes(name), acl: null, default: null });
  }
  for (const table of TABLES.slice(0, 2)) add("diagnostic_queue_privileges", table, { serviceRoleIdSelect: true, serviceRoleStatusSelect: true });
  for (const table of TABLES.slice(2)) add("diagnostic_rpc_owner_visibility", table, { ownerSchemaUsage: true, ownerSelect: true, ownerUnfiltered: true });
  add("function", "public.api_get_commercial_rollout_controls()", { securityDefiner: true, volatility: "s", config: ["search_path=pg_catalog"], owner: OWNER, acl: null, definition: `TEST_ONLY_FUNCTION_DEFINITION${RPC_SOURCE}` });
  add("diagnostic_rpc_contract", "public.api_get_commercial_rollout_controls", { argumentCount: 0, returnsSet: false, resultType: "jsonb", language: "sql", source: RPC_SOURCE, serviceRoleExecute: true, anonExecute: false, authenticatedExecute: false, publicExecute: false });
  add("enum", "public.queue_task_status", { labels: ["queued", "running", "completed", "failed", "cancelled"] });
  add("enum", "public.quote_request_status", { labels: ["queued", "requesting", "received", "failed", "canceled"] });
  for (const role of ["anon", "authenticated", "service_role"]) add("role", role, { inherit: true, superuser: false, bypassRls: role === "service_role", memberships: null });
  for (const name of ["public", "private"]) add("schema", name, { owner: OWNER, acl: null });
  add("diagnostic_schema_privileges", "public", { serviceRoleUsage: true });
  const catalogue = JSON.stringify([{ evidence: { schema: "OVD419-DIAGNOSTIC-CATALOGUE-COMPATIBILITY-NOT-AUTHORITY-v1", relationCount: 4, rows } }]);
  const queue = { total: 0, active: 0, invalid: 0, fingerprint: sha("") };
  const containment = JSON.stringify([{ evidence: { schema: "OVD419-PREFLIGHT-CONTAINMENT-NOT-AUTHORITY", visibility: { bypassRls: true, readOnly: "on" }, controls: CONTROLS.map(capability => ({ capability, enabled: false })), workQueue: queue, quoteRequests: queue } }]);
  const natHash = sha(JSON.stringify(["compute", "routers", "get-nat-mapping-info", "overdrafter-xometry-egress-router", "--nat-name", "overdrafter-xometry-egress-nat", "--project", "overdrafter-worker-9133", "--region", "us-west1", "--format=json(instanceName)"]));
  const start = Date.parse("2026-09-10T20:00:00.000Z"), completedAt = new Date(start + 5000).toISOString();
  const observations = [
    ["catalogue", 0, ACQUISITION_IDENTITIES.catalogueQuerySha256, catalogue],
    ["containmentOpening", 1, ACQUISITION_IDENTITIES.containmentQuerySha256, containment],
    ["E13", 14, natHash, "[]"],
    ["containmentClosing", 27, ACQUISITION_IDENTITIES.containmentQuerySha256, containment],
    ["closingE13", 36, natHash, "[]"],
  ].map(([id, sequence, requestSha256, payload], i) => ({ id, sequence, requestSha256, payload, startedAt: new Date(start + i * 1000).toISOString(), completedAt: new Date(start + (i + 1) * 1000).toISOString(), complete: true, settled: true }));
  const qualification = { acquisitionSourceCommit: "a".repeat(40), inputManifestSha256: "b".repeat(64), now: start + 5000 };
  return { qualification, input: { schema: "OVD419-ACQUISITION-COMPATIBILITY-INPUT-v2", mode: "TEST_ONLY", provenance: {
    acquisitionSourceCommit: qualification.acquisitionSourceCommit, diagnosticSourceCommit: ACQUISITION_IDENTITIES.diagnosticSourceCommit,
    inputManifestSha256: qualification.inputManifestSha256, readPlanSha256: ACQUISITION_IDENTITIES.readPlanSha256,
    invocationId: "TEST_ONLY_invocation", startedAt: new Date(start).toISOString(), completedAt,
  }, limits: { ...ACQUISITION_LIMITS }, usage: { cloudCalls: 34, sqlCalls: 3, receivedBytes: 100000, elapsedMs: 5000 }, observations } };
}
