import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  ACQUISITION_IDENTITIES,
  ACQUISITION_LIMITS,
  validateContainmentCompatibility,
} from "./ovd419-acquisition-compatibility.mjs";
import {
  selectSyntheticRuntimeIamRoleRequests,
  validateSyntheticRuntimeIamEvidence,
} from "./ovd419-acquisition-iam.mjs";
import { parseBoundedSqlJson } from "./ovd419-acquisition-support/official-sql-wrapper.mjs";
import { createSyntheticCatalogueAcquisition } from "./ovd419-synthetic-catalogue-reader.mjs";
import {
  collectStableEgressEvidence,
  evaluateStableEgressEvidence,
} from "./verify-xometry-stable-egress.mjs";
import {
  OVD410_NAT_TCP_ESTABLISHED_IDLE_TIMEOUT_SECONDS,
  OVD410_PRODUCTION_CONTRACT,
} from "./xometry-stable-egress-contract.mjs";

export const SYNTHETIC_PREFIX_CONTRACT = Object.freeze({
  requestSchema: "OVD419-SYNTHETIC-ACQUISITION-PREFIX-REQUEST-v1",
  responseSchema: "OVD419-SYNTHETIC-ACQUISITION-PREFIX-RESPONSE-v1",
  resultSchema: "OVD419-SYNTHETIC-ACQUISITION-PREFIX-NOT-AUTHORITY-v1",
  egressCatalogueSha256: "8bfe1fb3b1499e2ed3b5983719e1e0fd132b9298574aeeeb6db64a8dd52197ba",
  perReadMs: ACQUISITION_LIMITS.perReadMs,
  totalDurationMs: ACQUISITION_LIMITS.totalDurationMs,
  minimumCalls: 21,
  maximumCalls: 70,
});

const EGRESS_REQUESTS = Object.freeze([
  ["E01", "8082a13aa3bce86db283791d67674bee56b7e0dd718f45ed23e5d6c2bf1e6438"],
  ["E02", "a36c0332a193e748adca2c58ab7eb5b442e71e9427b01f20d154c6ddf4bbafd7"],
  ["E03", "92957fe5f5e31344b25f65055d1273539b6361187bb79d6310e160cfd80f6dcc"],
  ["E04", "d1aaf0d2397b5a69af1e0abc4803f81d5a00281d79f6afc3c658f50681c6ea3d"],
  ["E05", "8a5bd80fae9d194d69d5ac848ccbe4503372889f74f18c7e1e46544824bd1774"],
  ["E06", "8e851edf7561504674a216932570654fb2f69f6e3d1e5697457d8a1ca6d6d77e"],
  ["E07", "7ee91993432866fd7182eaefb87e9f3b83dc5639ab5be33a6c5eb2641fe331eb"],
  ["E08", "b0f330e43095fc97c94fb0dff3f3d92e1e8203da78adf2323a428fe3517dae74"],
  ["E09", "4cc8d3196424ec5ea1fb896e8a08770fea251c52f0c126c14a097d11d46a267f"],
  ["E10", "b8649f2892dec41f7573cd2f4c3af7a962c53d5f21735201c3466e6db7df093a"],
  ["E11", "a4c4b8ac9a2dec92e01306e006b439deb4c24bfc5b3276b918bf06a5ed7f9c17"],
  ["E12", "5f3f02dc5a144fa2d66ce7b9d55c2dc9e7a21f787cc9590feb3e0d0c5f1e158b"],
  ["E13", "cb4c91b6b824e8e3efbea02e8d9c226fde03ac192fa41c711b9d1cfb938d4de4"],
  ["E14", "e472c393f1ad332898f1b4948988f71d505c5e8cf06f0400c542159e3085e748"],
  ["E15", "8082a13aa3bce86db283791d67674bee56b7e0dd718f45ed23e5d6c2bf1e6438"],
  ["E16", "a36c0332a193e748adca2c58ab7eb5b442e71e9427b01f20d154c6ddf4bbafd7"],
  ["E17", "b0f330e43095fc97c94fb0dff3f3d92e1e8203da78adf2323a428fe3517dae74"],
  ["E18", "4cc8d3196424ec5ea1fb896e8a08770fea251c52f0c126c14a097d11d46a267f"],
].map(([id, requestSha256]) => Object.freeze({ id, requestSha256 })));

const EXPECTATIONS = Object.freeze({
  ...OVD410_PRODUCTION_CONTRACT,
  natTcpEstablishedIdleTimeoutSeconds: OVD410_NAT_TCP_ESTABLISHED_IDLE_TIMEOUT_SECONDS,
});
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");
const fail = code => { throw new Error(code); };

function exactObject(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail(code);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !actual.every(key => keys.includes(key))) fail(code);
}

function validateOptions(options) {
  exactObject(options, ["transport", "qualification", "perReadMs", "totalDurationMs"], "invalid_prefix_options");
  if (typeof options.transport !== "function") fail("transport_required");
  const { perReadMs, totalDurationMs } = options;
  if (!Number.isSafeInteger(perReadMs) || perReadMs < 1 || perReadMs > SYNTHETIC_PREFIX_CONTRACT.perReadMs ||
      !Number.isSafeInteger(totalDurationMs) || totalDurationMs < 1 ||
      totalDurationMs > SYNTHETIC_PREFIX_CONTRACT.totalDurationMs) fail("invalid_prefix_limits");
}

function prefixRequest({ id, sequence, requestSha256, provenance, args = null }) {
  return Object.freeze({
    schema: SYNTHETIC_PREFIX_CONTRACT.requestSchema,
    mode: "TEST_ONLY",
    id,
    sequence,
    requestSha256,
    provenance,
    args: args === null ? null : Object.freeze([...args]),
  });
}

function validateResponse(raw, request, maximumPayloadBytes) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > ACQUISITION_LIMITS.aggregateTransportBytes) {
    fail("invalid_prefix_response");
  }
  let response;
  try { response = parseBoundedSqlJson(raw, ACQUISITION_LIMITS.aggregateTransportBytes); }
  catch { fail("invalid_prefix_response"); }
  if (JSON.stringify(response) !== raw) fail("invalid_prefix_response");
  exactObject(response, ["schema", "mode", "id", "sequence", "requestSha256", "provenance", "complete", "settled", "isError", "payload"], "invalid_prefix_response");
  if (response.schema !== SYNTHETIC_PREFIX_CONTRACT.responseSchema || response.mode !== "TEST_ONLY" ||
      response.id !== request.id || response.sequence !== request.sequence ||
      response.requestSha256 !== request.requestSha256 || response.complete !== true ||
      response.settled !== true || response.isError !== false || typeof response.payload !== "string") {
    fail("invalid_prefix_response");
  }
  exactObject(response.provenance, Object.keys(request.provenance), "prefix_provenance_mismatch");
  if (!Object.keys(request.provenance).every(key => response.provenance[key] === request.provenance[key])) {
    fail("prefix_provenance_mismatch");
  }
  const payloadBytes = Buffer.byteLength(response.payload, "utf8");
  if (payloadBytes > maximumPayloadBytes) fail("prefix_payload_byte_limit");
  return {
    payload: response.payload,
    payloadBytes,
    payloadSha256: sha256(response.payload),
    responseBytes: Buffer.byteLength(raw, "utf8"),
    responseSha256: sha256(raw),
  };
}

function immutableObservation({ request, raw, validated, startedAt, completedAt }) {
  return Object.freeze({
    id: request.id,
    sequence: request.sequence,
    requestSha256: request.requestSha256,
    requestEnvelopeSha256: sha256(JSON.stringify(request)),
    responseSha256: validated.responseSha256,
    responseBytes: validated.responseBytes,
    payloadSha256: validated.payloadSha256,
    payloadBytes: validated.payloadBytes,
    startedAt,
    completedAt,
    complete: true,
    settled: true,
    args: request.args,
    responseRaw: raw,
    payload: validated.payload,
  });
}

/**
 * Construct the finite TEST_ONLY reader through runtime IAM. There is no default
 * transport or executable path. The single attempt is consumed before dispatch.
 */
export function createSyntheticAcquisitionPrefix({
  transport,
  qualification,
  perReadMs = SYNTHETIC_PREFIX_CONTRACT.perReadMs,
  totalDurationMs = SYNTHETIC_PREFIX_CONTRACT.totalDurationMs,
} = {}) {
  const options = { transport, qualification, perReadMs, totalDurationMs };
  validateOptions(options);
  let consumed = false;
  let catalogueDispatch;
  const catalogueReader = createSyntheticCatalogueAcquisition({
    qualification,
    timeoutMs: Math.min(perReadMs, totalDurationMs),
    transport: (request, context) => {
      if (typeof catalogueDispatch !== "function") fail("prefix_transport_unavailable");
      return catalogueDispatch(request, context);
    },
  });

  return Object.freeze({
    async read() {
      if (consumed) fail("request_budget_exhausted");
      consumed = true;
      const startedAt = new Date().toISOString();
      const started = performance.now();
      const deadline = started + totalDurationMs;
      const observations = [];
      let receivedBytes = 0;
      let active = false;

      const remaining = () => deadline - performance.now();
      const account = observation => {
        receivedBytes += observation.payloadBytes;
        if (receivedBytes > ACQUISITION_LIMITS.aggregateTransportBytes) fail("prefix_aggregate_byte_limit");
        observations.push(observation);
      };
      const dispatch = async (request, maximumPayloadBytes, interpret = payload => payload) => {
        if (active) fail("prefix_parallel_dispatch");
        const available = remaining();
        if (available <= 0) fail("prefix_total_timeout");
        active = true;
        const controller = new AbortController();
        const timeout = Math.min(perReadMs, available);
        const callStarted = performance.now();
        const callStartedAt = new Date().toISOString();
        let timer;
        const assertDeadline = () => {
          if (performance.now() - callStarted >= timeout) fail("read_timeout");
          if (remaining() <= 0) fail("prefix_total_timeout");
        };
        try {
          const deadlinePromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error("read_timeout"));
            }, timeout);
          });
          const operation = Promise.resolve().then(() => transport(request, Object.freeze({
            signal: controller.signal,
            maxBytes: maximumPayloadBytes,
          }))).catch(() => fail("prefix_transport_failed"));
          const raw = await Promise.race([operation, deadlinePromise]);
          assertDeadline();
          const validated = validateResponse(raw, request, maximumPayloadBytes);
          assertDeadline();
          const interpreted = interpret(validated.payload);
          assertDeadline();
          const observation = immutableObservation({
            request,
            raw,
            validated,
            startedAt: callStartedAt,
            completedAt: new Date().toISOString(),
          });
          assertDeadline();
          return { observation, interpreted };
        } catch (error) {
          controller.abort();
          throw error;
        } finally {
          clearTimeout(timer);
          active = false;
        }
      };

      let catalogueRequest;
      let catalogueRaw;
      const catalogueStarted = performance.now();
      const catalogueTimeout = Math.min(perReadMs, totalDurationMs);
      catalogueDispatch = async (request, context) => {
          if (active) fail("prefix_parallel_dispatch");
          active = true;
          catalogueRequest = request;
          try {
            catalogueRaw = await transport(request, context);
            return catalogueRaw;
          } finally {
            active = false;
          }
        };
      const catalogue = await catalogueReader.read();
      if (remaining() <= 0) fail("prefix_total_timeout");
      const catalogueObservation = Object.freeze({
        id: catalogue.id,
        sequence: catalogue.sequence,
        requestSha256: catalogue.requestSha256,
        requestEnvelopeSha256: sha256(JSON.stringify(catalogueRequest)),
        responseSha256: catalogue.responseSha256,
        responseBytes: catalogue.responseBytes,
        payloadSha256: catalogue.payloadSha256,
        payloadBytes: catalogue.payloadBytes,
        startedAt: catalogue.startedAt,
        completedAt: new Date().toISOString(),
        complete: true,
        settled: true,
        args: null,
        responseRaw: catalogueRaw,
        payload: catalogue.payload,
      });
      if (performance.now() - catalogueStarted >= catalogueTimeout) fail("read_timeout");
      if (remaining() <= 0) fail("prefix_total_timeout");
      account(catalogueObservation);

      const provenance = catalogue.provenance;
      const containmentRequest = prefixRequest({
        id: "containmentOpening",
        sequence: 1,
        requestSha256: ACQUISITION_IDENTITIES.containmentQuerySha256,
        provenance,
      });
      const containmentRead = await dispatch(
        containmentRequest,
        ACQUISITION_LIMITS.sqlPayloadBytes + ACQUISITION_LIMITS.sqlWrapperAllowanceBytes,
        validateContainmentCompatibility,
      );
      const containmentObservation = containmentRead.observation;
      account(containmentObservation);
      const containment = containmentRead.interpreted;

      let egressIndex = 0;
      const egress = await collectStableEgressEvidence(EXPECTATIONS, {
        gcloudBin: "TEST_ONLY_INJECTED",
        runCommand: async (_unused, args) => {
          const expected = EGRESS_REQUESTS[egressIndex];
          if (!expected || sha256(JSON.stringify(args)) !== expected.requestSha256) fail("egress_catalogue_mismatch");
          const request = prefixRequest({
            id: expected.id,
            sequence: egressIndex + 2,
            requestSha256: expected.requestSha256,
            provenance,
            args,
          });
          egressIndex += 1;
          const { observation, interpreted } = await dispatch(
            request,
            ACQUISITION_LIMITS.cloudResponseBytes,
            payload => {
              try { return parseBoundedSqlJson(payload, ACQUISITION_LIMITS.cloudResponseBytes); }
              catch { fail("invalid_cloud_json"); }
            },
          );
          account(observation);
          return interpreted;
        },
      });
      if (egressIndex !== EGRESS_REQUESTS.length) fail("egress_catalogue_mismatch");
      const egressEvaluation = evaluateStableEgressEvidence(egress, EXPECTATIONS);
      if (!egressEvaluation.ok || egressEvaluation.invalid || egressEvaluation.failures.length !== 0) {
        fail("stable_egress_rejected");
      }

      const policyRaw = observations.find(observation => observation.id === "E05")?.payload;
      const roleRequests = selectSyntheticRuntimeIamRoleRequests(policyRaw, { mode: "TEST_ONLY" });
      const roleResponses = [];
      for (let index = 0; index < roleRequests.length; index += 1) {
        const roleRequest = roleRequests[index];
        const request = prefixRequest({
          id: `IAM${String(index + 1).padStart(2, "0")}`,
          sequence: EGRESS_REQUESTS.length + 2 + index,
          requestSha256: sha256(JSON.stringify(roleRequest.args)),
          provenance,
          args: roleRequest.args,
        });
        const { observation } = await dispatch(
          request,
          ACQUISITION_LIMITS.cloudResponseBytes,
          payload => {
            try { return parseBoundedSqlJson(payload, ACQUISITION_LIMITS.cloudResponseBytes); }
            catch { fail("invalid_cloud_json"); }
          },
        );
        account(observation);
        roleResponses.push({ role: roleRequest.role, raw: observation.payload });
      }
      const iam = validateSyntheticRuntimeIamEvidence(policyRaw, roleResponses, { mode: "TEST_ONLY" });
      if (remaining() <= 0) fail("prefix_total_timeout");
      const cloudCalls = EGRESS_REQUESTS.length + roleRequests.length;
      const calls = observations.length;
      if (calls < SYNTHETIC_PREFIX_CONTRACT.minimumCalls || calls > SYNTHETIC_PREFIX_CONTRACT.maximumCalls ||
          calls !== cloudCalls + 2) fail("prefix_call_budget_mismatch");
      const frozenObservations = Object.freeze([...observations]);
      const egressFingerprint = sha256(JSON.stringify(frozenObservations.slice(2, 20).map(({ id, requestSha256, payloadSha256 }) => ({ id, requestSha256, payloadSha256 }))));
      const iamFingerprint = sha256(JSON.stringify({
        policy: iam.policy.sha256,
        roles: iam.roles.map(({ role, sha256: responseSha256 }) => ({ role, responseSha256 })),
        permissions: iam.permissions,
      }));
      const completedAt = new Date().toISOString();
      const elapsedMs = performance.now() - started;
      if (elapsedMs >= totalDurationMs) fail("prefix_total_timeout");
      return Object.freeze({
        schema: SYNTHETIC_PREFIX_CONTRACT.resultSchema,
        mode: "TEST_ONLY",
        provenance,
        startedAt,
        completedAt,
        elapsedMs,
        usage: Object.freeze({ calls, sqlCalls: 2, cloudCalls, receivedBytes }),
        observations: frozenObservations,
        catalogueFingerprint: catalogue.catalogueFingerprint,
        containmentFingerprint: containment.fingerprint,
        controlsFingerprint: containment.controls,
        egressFingerprint,
        iamFingerprint,
        egressCatalogueSha256: SYNTHETIC_PREFIX_CONTRACT.egressCatalogueSha256,
        prefixQualified: true,
        transportQualified: false,
        fullAcquisitionQualified: false,
        privateBindingReady: false,
      });
    },
  });
}
