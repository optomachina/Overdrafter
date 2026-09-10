/**
 * Exercise the HTTP handler against real OVD-498 PostgreSQL functions in an
 * explicitly named disposable local container. No hosted URL or key is accepted.
 * This injects a SQL transport; it does not qualify Edge routing or Windows TLS.
 */
import { assertEquals, assertNotEquals } from "@std/assert";
import { createEngineeringWorkerHandler, createWorkerSecret, hashWorkerSecret, WORKER_GATEWAY_SCHEMA } from "./index.ts";

const container = Deno.args[0];
if (Deno.args.length !== 1 || !/^supabase_db_ovd498-[a-z0-9-]+$/.test(container ?? "")) {
  throw new Error("Pass exactly one disposable local OVD-498 database container.");
}
const q = (value: unknown) => {
  if (typeof value !== "string" && typeof value !== "number") throw new Error("Only primitive synthetic SQL inputs are accepted.");
  return `'${String(value).replaceAll("'", "''")}'`;
};
/** Only generated synthetic fixture values and the handler's fixed RPC map enter SQL. */
async function sql(source: string, signal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  const deadline = AbortSignal.timeout(15_000);
  const result = await new Deno.Command("docker", {
    args: ["exec", "-i", container, "psql", "-U", "postgres", "-Atq", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"],
    stdin: "piped", stdout: "piped", stderr: "piped", signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  }).spawn();
  const input = result.stdin.getWriter();
  await input.write(new TextEncoder().encode(source));
  await input.close();
  const output = await result.output();
  return { code: output.code, stdout: new TextDecoder().decode(output.stdout).trim(), stderr: new TextDecoder().decode(output.stderr) };
}
async function required(source: string): Promise<string> {
  const result = await sql(source);
  assertEquals(result.code, 0, "Synthetic local SQL operation failed; inspect the disposable fixture privately.");
  return result.stdout;
}
async function fixture() {
  const f = { actor: crypto.randomUUID(), org: crypto.randomUUID(), project: crypto.randomUUID(), worker: crypto.randomUUID(),
    installation: crypto.randomUUID(), boot: crypto.randomUUID(), token: createWorkerSecret("worker"), code: createWorkerSecret("pairing") };
  await required(`begin;
    insert into auth.users(id,aud,role,email,email_confirmed_at) values(${q(f.actor)},'authenticated','authenticated',${q(`ovd499-${f.actor}@example.test`)},now());
    insert into public.organizations(id,name,slug) values(${q(f.org)},'OVD-499 fixture',${q(`ovd499-${f.org}`)});
    insert into public.organization_memberships(organization_id,user_id,role) values(${q(f.org)},${q(f.actor)},'client');
    insert into public.projects(id,organization_id,owner_user_id,name) values(${q(f.project)},${q(f.org)},${q(f.actor)},'OVD-499 fixture');
    insert into public.project_memberships(project_id,user_id,role) values(${q(f.project)},${q(f.actor)},'owner');
    insert into engineering_private.engineering_operators(organization_id,user_id,enabled) values(${q(f.org)},${q(f.actor)},true);
    commit;`);
  const invitation = await owner(f.actor, `public.api_create_worker_pairing(${q(f.worker)},${q(f.org)},${q(f.project)},0,${q(crypto.randomUUID())},${q(await hashWorkerSecret(f.code))})`);
  assertEquals(invitation.revision, 1);
  return f;
}
async function owner(actor: string, expression: string) {
  return JSON.parse(await required(`begin; set local role authenticated; set local request.jwt.claim.sub=${q(actor)}; select ${expression}; commit;`));
}
const handler = createEngineeringWorkerHandler({ enabled: () => true, rpc: async (name, args, signal) => {
  const params = Object.entries(args).map(([key,value]) => `${key} => ${q(value)}`).join(",");
  const result = await sql(`begin; set local role service_role; select public.${name}(${params}); commit;`, signal);
  if (result.code !== 0) {
    const code = /ERROR:\s+([A-Z0-9]{5}):/.exec(result.stderr)?.[1];
    return { data: null, error: { code } };
  }
  return { data: JSON.parse(result.stdout), error: null };
} });
async function send(f: Awaited<ReturnType<typeof fixture>>, body: Record<string, unknown>, status = 200, token = f.token) {
  const response = await handler(new Request("https://local-fixture.invalid/functions/v1/engineering-worker", {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ schema: WORKER_GATEWAY_SCHEMA, workerId: f.worker, ...body }),
  }));
  assertEquals(response.status, status);
  const result = await response.json();
  const serialized = JSON.stringify(result);
  for (const value of [f.token, f.code, await hashWorkerSecret(f.token), await hashWorkerSecret(f.code)]) {
    assertEquals(serialized.includes(value), false, "HTTP response leaked a synthetic secret or digest.");
  }
  return result;
}
const f = await fixture();
const pairing = { action: "pair", installationId: f.installation, pairingCode: f.code, expectedRevision: 1, idempotencyKey: crypto.randomUUID() };
const paired = await send(f, pairing);
assertEquals(paired.receipt.revision, 2);
assertEquals(await send(f, pairing), paired, "Lost pairing reply must replay exactly.");
await send(f, { ...pairing, idempotencyKey: crypto.randomUUID() }, 409);
await send(f, { action: "session", bootId: f.boot }, 401, createWorkerSecret("worker"));
const boot = { action: "boot", bootId: f.boot, expectedRevision: 2, idempotencyKey: crypto.randomUUID() };
const booted = await send(f, boot);
assertEquals(booted.receipt.enabled, false);
assertEquals(await send(f, boot), booted);
assertEquals((await send(f, { action: "session", bootId: f.boot })).receipt.reason, "owner_enablement_required");
await owner(f.actor, `public.api_control_worker_session(${q(f.worker)},3,${q(crypto.randomUUID())},'enabled',${q(f.boot)})`);
const enabled = await send(f, { action: "session", bootId: f.boot });
assertEquals(enabled.receipt.sessionEligible, true);
assertEquals(Date.parse(enabled.receipt.expiresAt) > Date.now(), true);
assertEquals((await send(f, { action: "session", bootId: crypto.randomUUID() })).receipt.reason, "boot_mismatch");
await owner(f.actor, `public.api_control_worker_session(${q(f.worker)},4,${q(crypto.randomUUID())},'paused',${q(f.boot)})`);
assertEquals((await send(f, { action: "session", bootId: f.boot })).receipt.reason, "paused");
const newBoot = crypto.randomUUID();
await send(f, { action: "boot", bootId: newBoot, expectedRevision: 5, idempotencyKey: crypto.randomUUID() });
assertEquals((await send(f, { action: "session", bootId: newBoot })).receipt.reason, "owner_enablement_required");
assertEquals(await send(f, boot), booted, "Old boot replay must preserve its original receipt.");
assertEquals((await send(f, { action: "session", bootId: newBoot })).receipt.reason, "owner_enablement_required");
const other = await fixture();
await send(other, { action: "pair", installationId: other.installation, pairingCode: other.code, expectedRevision: 1, idempotencyKey: crypto.randomUUID() });
assertNotEquals(other.org, f.org);
await send(other, { action: "session", bootId: other.boot }, 401, f.token);
await owner(f.actor, `public.api_control_worker_session(${q(f.worker)},6,${q(crypto.randomUUID())},'revoked',null)`);
await send(f, { action: "session", bootId: newBoot }, 401);
await send(f, pairing, 401);
console.log(JSON.stringify({ schema: "overdrafter.worker-gateway-integration.v1", pairingReplay: true, bootReplay: true,
  oldBootCannotRestoreSession: true, ownerEnablement: true, pause: true, restart: true, revoked: true,
  wrongCredentialDenied: true, crossOrganizationCredentialDenied: true, responseRedaction: true,
  realPostgres: true, injectedSqlTransport: true, hostedEdgeQualified: false, windowsQualified: false, productionChanged: false }, null, 2));
