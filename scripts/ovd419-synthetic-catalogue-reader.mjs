import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

/** Fixed B1 fixture contract. Source pins describe input provenance, not authority. */
export const SYNTHETIC_CATALOGUE_CONTRACT = Object.freeze({
  requestSchema: "OVD419-SYNTHETIC-CATALOGUE-REQUEST-v1",
  responseSchema: "OVD419-SYNTHETIC-CATALOGUE-RESPONSE-v1",
  resultSchema: "OVD419-SYNTHETIC-CATALOGUE-RESULT-NOT-AUTHORITY-v1",
  diagnosticSourceCommit: "e9c1073c47277f7ba7709655d94d4a399e78fffa",
  readPlanSha256: "58f007868ada20901080b914cfeb0c7f90d1169166a62bdb25314a4ea3bc5354",
  requestSha256: "0ee434293e2df44fda3a5e4d8d45d52e1622286370a1653a79a2424ccb89dea8",
  maxResponseBytes: 2 * 1024 ** 2 + 65536,
  maxPayloadBytes: 2 * 1024 ** 2,
  timeoutMs: 30000,
});
const CONTRACT = SYNTHETIC_CATALOGUE_CONTRACT;
const fail = code => { throw new Error(code); };

function exactKeys(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length ||
      !keys.every(key => Object.hasOwn(descriptors, key) && Object.hasOwn(descriptors[key], "value"))) fail(code);
}

function scanCanonicalCharacter(state, character) {
  if (state.quoted) {
    if (state.escaped) state.escaped = false;
    else if (character === "\\") state.escaped = true;
    else if (character === '"') state.quoted = false;
    return;
  }
  if (character === '"') state.quoted = true;
  if ("{}[],:".includes(character) && ++state.tokens > 131072) fail("json_structure_limit");
  if (character === "{" || character === "[") {
    if (++state.depth > 16) fail("json_depth_limit");
  } else if (character === "}" || character === "]") {
    if (--state.depth < 0) fail("invalid_json");
  }
}

/** Bound parsing work and require JSON.stringify form, which rejects duplicate keys. */
function parseCanonicalJson(text, maxBytes, byteError) {
  if (typeof text !== "string") fail("invalid_json");
  if (Buffer.byteLength(text, "utf8") > maxBytes) fail(byteError);
  const state = { depth: 0, tokens: 0, quoted: false, escaped: false };
  for (const character of text) scanCanonicalCharacter(state, character);
  if (state.quoted || state.depth !== 0) fail("invalid_json");
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { fail("invalid_json"); }
  if (JSON.stringify(parsed) !== text) fail("noncanonical_json");
  return parsed;
}

function validatePayload(payload) {
  const rows = parseCanonicalJson(payload, CONTRACT.maxPayloadBytes, "payload_byte_limit");
  if (!Array.isArray(rows) || rows.length !== 1) fail("invalid_catalogue");
  exactKeys(rows[0], ["evidence"], "invalid_catalogue");
  const evidence = rows[0].evidence;
  exactKeys(evidence, ["schema", "relationCount", "rows"], "invalid_catalogue");
  if (evidence.schema !== "OVD419-DIAGNOSTIC-CATALOGUE-COMPATIBILITY-NOT-AUTHORITY-v1" ||
      evidence.relationCount !== 4 || !Array.isArray(evidence.rows) ||
      evidence.rows.length < 1 || evidence.rows.length > 2000) fail("invalid_catalogue");
  for (const row of evidence.rows) {
    exactKeys(row, ["kind", "identity", "definition"], "invalid_catalogue");
    if (![row.kind, row.identity].every(value => typeof value === "string" && value.length > 0) ||
        !row.definition || typeof row.definition !== "object" || Array.isArray(row.definition)) {
      fail("invalid_catalogue");
    }
  }
}

function validateResponse(raw, request, maxBytes) {
  const response = parseCanonicalJson(raw, maxBytes, "response_byte_limit");
  exactKeys(response, ["schema", "mode", "id", "sequence", "requestSha256", "provenance", "complete", "settled", "isError", "payload"], "invalid_envelope");
  if (response.schema !== CONTRACT.responseSchema || response.mode !== "TEST_ONLY" ||
      response.id !== "catalogue" || response.sequence !== 0 ||
      response.requestSha256 !== request.requestSha256 || response.complete !== true ||
      response.settled !== true || response.isError !== false) fail("invalid_envelope");
  exactKeys(response.provenance, Object.keys(request.provenance), "provenance_mismatch");
  if (!Object.keys(request.provenance).every(key => response.provenance[key] === request.provenance[key])) {
    fail("provenance_mismatch");
  }
  validatePayload(response.payload);
  return response.payload;
}

/**
 * Create a one-use synthetic reader; no default transport or executable entrypoint exists.
 * The trusted caller supplies an inert transport(request, { signal, maxBytes }) returning
 * a canonical JSON response string. Limits may only tighten. The sole request is consumed
 * before dispatch, including failures/timeouts; late responses never restore that budget.
 * Response limits apply at this callback boundary, not to transport allocation or I/O.
 * Echoed pins prove consistency only. Catalogue semantics remain independently unvalidated.
 */
export function createSyntheticCatalogueReader({ transport, qualification, timeoutMs = CONTRACT.timeoutMs, maxResponseBytes = CONTRACT.maxResponseBytes } = {}) {
  if (typeof transport !== "function") fail("transport_required");
  exactKeys(qualification, ["mode", "acquisitionSourceCommit", "inputManifestSha256", "invocationId"], "invalid_qualification");
  if (qualification.mode !== "TEST_ONLY" ||
      typeof qualification.acquisitionSourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(qualification.acquisitionSourceCommit) ||
      typeof qualification.inputManifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(qualification.inputManifestSha256) ||
      typeof qualification.invocationId !== "string" || !/^TEST_ONLY_[A-Za-z0-9_-]{1,80}$/.test(qualification.invocationId)) fail("invalid_qualification");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > CONTRACT.timeoutMs ||
      !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > CONTRACT.maxResponseBytes) fail("invalid_limits");
  const provenance = Object.freeze({
    acquisitionSourceCommit: qualification.acquisitionSourceCommit,
    inputManifestSha256: qualification.inputManifestSha256,
    invocationId: qualification.invocationId,
    diagnosticSourceCommit: CONTRACT.diagnosticSourceCommit,
    readPlanSha256: CONTRACT.readPlanSha256,
  });
  const request = Object.freeze({
    schema: CONTRACT.requestSchema, mode: "TEST_ONLY", id: "catalogue", sequence: 0,
    requestSha256: CONTRACT.requestSha256, provenance,
  });
  let consumed = false;
  return Object.freeze({
    async read() {
      if (consumed) fail("request_budget_exhausted");
      consumed = true;
      const controller = new AbortController();
      const startedAt = new Date().toISOString();
      const start = performance.now();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("read_timeout"));
          controller.abort();
        }, timeoutMs);
      });
      try {
        const operation = Promise.resolve().then(() => transport(request, Object.freeze({
          signal: controller.signal, maxBytes: maxResponseBytes,
        }))).catch(() => fail("transport_failed"));
        const raw = await Promise.race([operation, deadline]);
        if (performance.now() - start >= timeoutMs) fail("read_timeout");
        const payload = validateResponse(raw, request, maxResponseBytes);
        if (performance.now() - start >= timeoutMs) fail("read_timeout");
        const responseBytes = Buffer.byteLength(raw, "utf8");
        const responseSha256 = createHash("sha256").update(raw, "utf8").digest("hex");
        const payloadBytes = Buffer.byteLength(payload, "utf8");
        const payloadSha256 = createHash("sha256").update(payload, "utf8").digest("hex");
        const elapsedMs = performance.now() - start;
        if (elapsedMs >= timeoutMs) fail("read_timeout");
        return Object.freeze({
          schema: CONTRACT.resultSchema, mode: "TEST_ONLY", calls: 1,
          id: "catalogue", sequence: 0, requestSha256: request.requestSha256,
          provenance, startedAt, completedAt: new Date().toISOString(), elapsedMs,
          complete: true, settled: true, payload,
          responseBytes, responseSha256, payloadBytes, payloadSha256,
          compatibilityValidated: false, privateBindingReady: false, sqlRuntimeQualified: false,
        });
      } catch (error) {
        controller.abort();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
