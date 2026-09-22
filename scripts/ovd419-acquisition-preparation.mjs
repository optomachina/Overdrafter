import { createHash } from "node:crypto";
import { ACQUISITION_IDENTITIES, ACQUISITION_LIMITS } from "./ovd419-acquisition-compatibility.mjs";
import { parseBoundedSqlJson } from "./ovd419-acquisition-support/official-sql-wrapper.mjs";
import { validatePrivateManifest } from "./ovd419-diagnostic-manifest.mjs";
import { compareCodeUnits, digest } from "./ovd419-job-diagnostic.mjs";
import { evaluateStableEgressEvidence } from "./verify-xometry-stable-egress.mjs";
import { OVD410_PRODUCTION_CONTRACT, OVD410_NAT_TCP_ESTABLISHED_IDLE_TIMEOUT_SECONDS } from "./xometry-stable-egress-contract.mjs";

export const PREPARATION_SCHEMA_HASHES = Object.freeze({
  private: "2321e4c430ba7d50eca583a1c31709df5e115d9a23bcbc43ea490779d038471f",
  receipt: "24719b225bd01ea150ab66afa2322a3b41f0ab85065cd9420796671437c89cc7",
});
const reject = () => { throw new Error("acquisition_fixture_rejected"); };
const need = value => { if (!value) reject(); };
const sha = value => createHash("sha256").update(value).digest("hex");
const parse = raw => parseBoundedSqlJson(raw, ACQUISITION_LIMITS.persistedPrivateBytes);

function object(value, keys) {
  need(value && Object.getPrototypeOf(value) === Object.prototype);
  need(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
}

/** Canonicalize private, JSON-only records without invoking serialization hooks. */
function canonical(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    need(value.isWellFormed());
    return value;
  }
  if (typeof value === "number") { need(Number.isSafeInteger(value)); return value; }
  if (Array.isArray(value)) {
    need(Object.keys(value).length === value.length);
    return Array.from({ length: value.length }, (_, i) => {
      const field = Object.getOwnPropertyDescriptor(value, String(i));
      need(field && Object.hasOwn(field, "value"));
      return canonical(field.value);
    });
  }
  need(value && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0);
  return Object.fromEntries(Object.keys(value).sort(compareCodeUnits).map(key => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    need(field && Object.hasOwn(field, "value"));
    return [key, canonical(field.value)];
  }));
}

// Interpreter restricted to the vocabulary of the two byte-pinned schemas. It
// never accepts arbitrary caller schemas or treats shape as invocation authority.
function validate(value, schema) {
  if (Object.hasOwn(schema, "const")) need(value === schema.const);
  if (schema.enum) need(schema.enum.includes(value));
  if (schema.type === "object") {
    need(value && Object.getPrototypeOf(value) === Object.prototype);
    need(schema.required.every(key => Object.hasOwn(value, key)));
    need(Object.keys(value).every(key => Object.hasOwn(schema.properties, key)));
    for (const [key, child] of Object.entries(value)) validate(child, schema.properties[key]);
  } else if (schema.type === "array") {
    need(Array.isArray(value) && value.length <= schema.maxItems);
    if (schema.uniqueItems) need(new Set(value.map(item => JSON.stringify(item))).size === value.length);
    value.forEach(item => validate(item, schema.items));
  } else if (schema.type === "string") {
    need(typeof value === "string" && value.isWellFormed());
    const length = [...value].length;
    if (schema.minLength !== undefined) need(length >= schema.minLength);
    if (schema.maxLength !== undefined) need(length <= schema.maxLength);
    if (schema.pattern) {
      const match = new RegExp(schema.pattern, "u").exec(value);
      need(match && match[0].length === value.length);
    }
    if (schema.format === "date-time") {
      need(Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
    }
  } else if (schema.type === "integer") {
    need(Number.isSafeInteger(value) && value >= schema.minimum && value <= schema.maximum);
  }
}

/** Pin harness inputs before the reader starts. This is synthetic qualification,
 * not verification of a real checkout or a remote service. Scope identity stays
 * with the reader; this pure helper cannot issue or unwrap a capability. */
export function qualifyPreparation(input, qualification, packet) {
  try {
    object(input, ["scope", "epochMs", "acquisitionSourceCommit", "inputManifestSha256", "packetSha256", "privateSchemaJson", "receiptSchemaJson"]);
    object(input.scope, []);
    need(Number.isSafeInteger(input.epochMs) && input.epochMs >= 0 && Number.isFinite(new Date(input.epochMs).getTime()));
    need(input.acquisitionSourceCommit === qualification.acquisitionSourceCommit &&
      input.inputManifestSha256 === qualification.inputManifestSha256 && input.packetSha256 === digest(packet));
    need(typeof input.privateSchemaJson === "string" && typeof input.receiptSchemaJson === "string");
    need(Buffer.byteLength(input.privateSchemaJson) <= 1048576 && Buffer.byteLength(input.receiptSchemaJson) <= 1048576);
    need(sha(input.privateSchemaJson) === PREPARATION_SCHEMA_HASHES.private && sha(input.receiptSchemaJson) === PREPARATION_SCHEMA_HASHES.receipt);
    return Object.freeze({ scope: input.scope, epochMs: input.epochMs,
      acquisitionSourceCommit: input.acquisitionSourceCommit, inputManifestSha256: input.inputManifestSha256,
      packetSha256: input.packetSha256, privateSchema: parse(input.privateSchemaJson), receiptSchema: parse(input.receiptSchemaJson) });
  } catch { reject(); }
}

function immutableEgress(prefix, second) {
  const names = ["service", "job", "iamPolicy", "jobIamPolicy", "projectIamPolicy", "network", "subnet", "router", "nat", "address", "routes", "policyBasedRoutes", "natMappings", "jobExecutions", "confirmService", "confirmJob", "confirmRouter", "confirmNat"];
  const entries = names.map((name, i) => {
    const matches = prefix.observations.filter(item => item.id === `E${String(i + 1).padStart(2, "0")}`);
    need(matches.length === 1);
    const item = matches[0];
    need(item.complete === true && item.settled === true && item.payloadSha256 === sha(item.payload));
    return [name, parseBoundedSqlJson(item.payload, ACQUISITION_LIMITS.cloudResponseBytes)];
  });
  const egress = Object.fromEntries(entries);
  const verdict = evaluateStableEgressEvidence(egress, { ...OVD410_PRODUCTION_CONTRACT,
    natTcpEstablishedIdleTimeoutSeconds: OVD410_NAT_TCP_ESTABLISHED_IDLE_TIMEOUT_SECONDS });
  need(verdict.ok && !verdict.invalid && verdict.failures.length === 0);
  for (const name of ["service", "job"]) {
    const version = second[name].projection.identity.resourceVersion;
    const confirm = name === "service" ? "confirmService" : "confirmJob";
    need(egress[name].metadata.resourceVersion === version && egress[confirm].metadata.resourceVersion === version);
  }
  const excluded = new Set(["service", "job", "confirmService", "confirmJob", "natMappings", "jobExecutions"]);
  return digest(Object.fromEntries(entries.filter(([name]) => !excluded.has(name))));
}

/** Pure preparation of already module-owned reader data. Returned strings are
 * consumed only by the reader's private store; this helper grants no capability. */
export function prepareAcquisitionData(retained, context, handoff) {
  try {
    const { second, prefix, snapshotClosing, principalClosing, secretClosing, containmentClosing } = retained;
    const { qualified, packet, capturedAt } = context;
    need(digest(packet) === qualified.packetSha256);
    need(prefix.provenance.acquisitionSourceCommit === qualified.acquisitionSourceCommit &&
      prefix.provenance.inputManifestSha256 === qualified.inputManifestSha256 &&
      prefix.provenance.diagnosticSourceCommit === ACQUISITION_IDENTITIES.diagnosticSourceCommit &&
      prefix.provenance.readPlanSha256 === ACQUISITION_IDENTITIES.readPlanSha256);
    const rawJob = parseBoundedSqlJson(second.job.raw, ACQUISITION_LIMITS.cloudResponseBytes);
    need(digest({ name: rawJob.metadata.name, spec: rawJob.spec }) === packet.baseline.job.configuration);
    const manifest = structuredClone(rawJob);
    manifest.metadata = { name: rawJob.metadata.name, resourceVersion: rawJob.metadata.resourceVersion,
      labels: rawJob.metadata.labels, annotations: { ...rawJob.metadata.annotations } };
    delete manifest.metadata.annotations["run.googleapis.com/creator"];
    delete manifest.metadata.annotations["run.googleapis.com/lastModifier"];
    delete manifest.status;
    validatePrivateManifest(manifest, packet);
    const candidate = structuredClone(manifest);
    candidate.spec.template.spec.template.spec.containers[0].image = packet.image;
    const candidateConfiguration = digest({ name: candidate.metadata.name, spec: candidate.spec });
    need(candidateConfiguration === packet.candidateConfiguration);
    validatePrivateManifest(candidate, packet);
    const identity = result => ({ uid: result.projection.identity.uid, generation: result.projection.identity.generation,
      resourceVersion: result.projection.identity.resourceVersion, configuration: result.projection.configurationFingerprint });
    const scope = second.job.projection.snapshotScope;
    const principal = principalClosing.projection.principal;
    const binding = {
      schema: "OVD419-PRIVATE-BINDING-DATA-NOT-AUTHORITY-v2", capturedAt,
      readPlanSha256: ACQUISITION_IDENTITIES.readPlanSha256,
      baseline: { job: identity(second.job), service: identity(second.service),
        snapshot: digest(snapshotClosing.projection), account: digest({ ...scope, principal }),
        secretVersion: secretClosing.projection.secretVersion, inventory: second.inventory.ids,
        controls: containmentClosing.controls, egress: immutableEgress(prefix, second) },
      candidateConfiguration, snapshotScope: { ...scope, ...snapshotClosing.projection }, principal,
      resources: { ...second.job.projection.resources, tasks: rawJob.spec.template.spec.taskCount,
        parallelism: rawJob.spec.template.spec.parallelism },
      compatibility: { catalogue: true, executionRepresentation: true,
        baselineSafeForTemporaryManifest: true, controlsEncodingVerified: true },
      catalogueFingerprint: prefix.catalogueFingerprint,
      completedExecutionRepresentationFingerprint: second.execution.sha256,
      acquisitionSourceCommit: qualified.acquisitionSourceCommit,
      diagnosticSourceCommit: ACQUISITION_IDENTITIES.diagnosticSourceCommit,
      inputManifestSha256: qualified.inputManifestSha256,
    };
    validate(binding, qualified.privateSchema);
    const bindingsJson = JSON.stringify(canonical(binding));
    need(Buffer.byteLength(bindingsJson) <= ACQUISITION_LIMITS.persistedPrivateBytes);
    // Enforce the reviewed parser ceilings on the exact stored serialization.
    parse(bindingsJson);
    const receipt = { schema: "OVD419-SYNTHETIC-ACQUISITION-RESULT-NOT-AUTHORITY-v1", mode: "TEST_ONLY",
      bindingsSha256: sha(bindingsJson), bindingsBytes: Buffer.byteLength(bindingsJson),
      acquisitionSourceCommit: qualified.acquisitionSourceCommit, diagnosticSourceCommit: ACQUISITION_IDENTITIES.diagnosticSourceCommit,
      inputManifestSha256: qualified.inputManifestSha256, readPlanSha256: ACQUISITION_IDENTITIES.readPlanSha256,
      handoffSha256: handoff.handoffSha256, transportQualified: false, privateBindingReady: false };
    validate(receipt, qualified.receiptSchema);
    const receiptJson = JSON.stringify(canonical(receipt));
    need(Buffer.byteLength(receiptJson) <= ACQUISITION_LIMITS.persistedSanitizedBytes);
    parse(receiptJson);
    return Object.freeze({ bindingsJson, receiptJson, bindingsSha256: receipt.bindingsSha256,
      bindingsBytes: receipt.bindingsBytes, receiptSha256: sha(receiptJson), receiptBytes: Buffer.byteLength(receiptJson) });
  } catch { reject(); }
}
