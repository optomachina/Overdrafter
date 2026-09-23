import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateSyntheticPrincipal, validateSyntheticSnapshotMetadata, validateSyntheticSecretVersionMetadata } from "./ovd419-acquisition-metadata.mjs";

const mode = { mode: "TEST_ONLY" };
const principal = [{ account: "TEST_ONLY_operator@example.invalid", status: "ACTIVE" }];
const snapshot = { generation: "9007199254740993", metageneration: "2", etag: "TEST_ONLY+/_=-" };
const secret = { name: "projects/123456789/secrets/supabase-service-role-key/versions/7", state: "ENABLED" };
const binding = { ...mode, projectNumber: "123456789", referenceKey: "latest" };
const cases = [
  ["principal", validateSyntheticPrincipal, principal, mode, { principal: principal[0].account }],
  ["snapshot", validateSyntheticSnapshotMetadata, snapshot, mode, snapshot],
  ["secretVersion", validateSyntheticSecretVersionMetadata, secret, binding, { secretVersion: "7" }],
];

describe("synthetic acquisition metadata", () => {
  it.each(cases)("preserves exact %s bytes with a frozen non-authority projection", (kind, validate, input, options, projection) => {
    const raw = `\n${JSON.stringify(input, null, 2)}\n`;
    const result = validate(raw, options);
    expect(result).toMatchObject({ schema: "OVD419-SYNTHETIC-METADATA-NOT-AUTHORITY-v1", kind,
      raw, sha256: createHash("sha256").update(raw).digest("hex"), projection,
      transportQualified: false, privateBindingReady: false });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.projection)).toBe(true);
  });
  it.each(cases)("rejects unknown %s options and production mode", (_, validate, input, options) => {
    for (const invalid of [undefined, {}, { ...options, mode: "PRODUCTION" }, { ...options, trusted: true }]) {
      expect(() => validate(JSON.stringify(input), invalid)).toThrow(/^acquisition_metadata_rejected$/);
    }
  });
  it.each(cases)("bounds and rejects malformed raw %s input", (_, validate, input, options) => {
    for (const raw of [input, "not-json", "null", `${JSON.stringify(input)}${" ".repeat(4194304)}`]) {
      expect(() => validate(raw, options)).toThrow(/^acquisition_metadata_rejected$/);
    }
  });
  it.each([
    ["empty", []], ["multiple", [...principal, ...principal]], ["object wrapper", { items: principal }],
    ["missing account", [{ status: "ACTIVE" }]], ["inactive", [{ ...principal[0], status: "INACTIVE" }]],
    ["unknown field", [{ ...principal[0], token: "TEST_ONLY_forbidden" }]],
    ["empty account", [{ ...principal[0], account: "" }]], ["object account", [{ ...principal[0], account: {} }]],
    ["space", [{ ...principal[0], account: "TEST_ONLY user" }]],
    ["control", [{ ...principal[0], account: "TEST_ONLY\nuser" }]],
    ["overlong", [{ ...principal[0], account: "a".repeat(257) }]],
  ])("rejects %s principal", (_, value) => {
    expect(() => validateSyntheticPrincipal(JSON.stringify(value), mode)).toThrow(/^acquisition_metadata_rejected$/);
  });
  it("rejects duplicate decoded principal fields", () => {
    const raw = JSON.stringify(principal).replace('"status":"ACTIVE"', '"status":"ACTIVE","\\u0073tatus":"ACTIVE"');
    expect(() => validateSyntheticPrincipal(raw, mode)).toThrow(/^acquisition_metadata_rejected$/);
  });
  it("keeps the complete ASCII control and Unicode whitespace boundary for principals", () => {
    for (let codePoint = 0; codePoint <= 0x7f; codePoint += 1) {
      const account = `user${String.fromCodePoint(codePoint)}@example.invalid`;
      const input = JSON.stringify([{ account, status: "ACTIVE" }]);
      if (codePoint <= 0x20 || codePoint === 0x7f) {
        expect(() => validateSyntheticPrincipal(input, mode)).toThrow(/^acquisition_metadata_rejected$/);
      } else {
        expect(validateSyntheticPrincipal(input, mode).projection.principal).toBe(account);
      }
    }
    for (const whitespace of ["\u00a0", "\u1680", "\u2028", "\u3000"]) {
      const input = JSON.stringify([{ account: `user${whitespace}@example.invalid`, status: "ACTIVE" }]);
      expect(() => validateSyntheticPrincipal(input, mode)).toThrow(/^acquisition_metadata_rejected$/);
    }
  });
  it.each(["generation", "metageneration"])("preserves %s above JS integer precision without coercion", field => {
    const input = { ...snapshot, [field]: "9223372036854775807" };
    expect(validateSyntheticSnapshotMetadata(JSON.stringify(input), mode).projection[field]).toBe(input[field]);
  });
  it.each(["generation", "metageneration"])("rejects invalid %s representation", field => {
    for (const value of [0, 2, null, "0", "01", "-1", "1e5", "1.0", " 1", "1\n", "9".repeat(21)]) {
      expect(() => validateSyntheticSnapshotMetadata(JSON.stringify({ ...snapshot, [field]: value }), mode)).toThrow(/^acquisition_metadata_rejected$/);
    }
    const missing = { ...snapshot }; delete missing[field];
    expect(() => validateSyntheticSnapshotMetadata(JSON.stringify(missing), mode)).toThrow(/^acquisition_metadata_rejected$/);
  });
  it.each(["", null, 1, "value\n", '"quoted"', "x".repeat(257)])("rejects invalid ETag %j", etag => {
    expect(() => validateSyntheticSnapshotMetadata(JSON.stringify({ ...snapshot, etag }), mode)).toThrow(/^acquisition_metadata_rejected$/);
  });
  it("rejects extra snapshot data and duplicate generation keys", () => {
    expect(() => validateSyntheticSnapshotMetadata(JSON.stringify({ ...snapshot, payload: "TEST_ONLY" }), mode)).toThrow(/^acquisition_metadata_rejected$/);
    const raw = JSON.stringify(snapshot).replace('"metageneration":"2"', '"metageneration":"2","metageneration":"2"');
    expect(() => validateSyntheticSnapshotMetadata(raw, mode)).toThrow(/^acquisition_metadata_rejected$/);
  });
  it.each(["123456789", "overdrafter-worker-9133"])("binds the allowed project representation %s", project => {
    const input = { ...secret, name: `projects/${project}/secrets/supabase-service-role-key/versions/7` };
    expect(validateSyntheticSecretVersionMetadata(JSON.stringify(input), binding).projection.secretVersion).toBe("7");
  });
  it("requires an exact numeric reference match when latest was not requested", () => {
    expect(validateSyntheticSecretVersionMetadata(JSON.stringify(secret), { ...binding, referenceKey: "7" }).projection.secretVersion).toBe("7");
    expect(() => validateSyntheticSecretVersionMetadata(JSON.stringify(secret), { ...binding, referenceKey: "8" })).toThrow(/^acquisition_metadata_rejected$/);
  });
  it.each([
    "projects/987654321/secrets/supabase-service-role-key/versions/7",
    "projects/another-project/secrets/supabase-service-role-key/versions/7",
    "projects/123456789/secrets/another-secret/versions/7",
    "projects/123456789/locations/us-west1/secrets/supabase-service-role-key/versions/7",
    "projects/123456789/secrets/supabase-service-role-key/versions/latest",
    "projects/123456789/secrets/supabase-service-role-key/versions/0",
    "projects/123456789/secrets/supabase-service-role-key/versions/07",
    "projects/123456789/secrets/supabase-service-role-key/versions/77777777777777777777",
    "projects/123456789/secrets/supabase-service-role-key/versions/7/extra",
    "projects/123456789/secrets/supabase-service-role-key/versions/7\n",
  ])("rejects substituted or malformed version resource %s", name => {
    expect(() => validateSyntheticSecretVersionMetadata(JSON.stringify({ ...secret, name }), binding)).toThrow(/^acquisition_metadata_rejected$/);
  });
  it.each(["DISABLED", "DESTROYED", "STATE_UNSPECIFIED", "enabled", null])("rejects non-enabled version %j", state => {
    expect(() => validateSyntheticSecretVersionMetadata(JSON.stringify({ ...secret, state }), binding)).toThrow(/^acquisition_metadata_rejected$/);
  });
  it("rejects secret payloads and decoded duplicate resource names", () => {
    expect(() => validateSyntheticSecretVersionMetadata(JSON.stringify({ ...secret, payload: { data: "TEST_ONLY" } }), binding)).toThrow(/^acquisition_metadata_rejected$/);
    const raw = JSON.stringify(secret).replace('"state":"ENABLED"', '"state":"ENABLED","state":"ENABLED"');
    expect(() => validateSyntheticSecretVersionMetadata(raw, binding)).toThrow(/^acquisition_metadata_rejected$/);
  });
  it.each([
    { projectNumber: "0" }, { projectNumber: "001" }, { projectNumber: 123456789 },
    { projectNumber: "other" }, { projectNumber: "1".repeat(21) },
    { referenceKey: "0" }, { referenceKey: "07" }, { referenceKey: "LATEST" }, { referenceKey: 7 },
  ])("rejects malformed typed binding %j", change => {
    expect(() => validateSyntheticSecretVersionMetadata(JSON.stringify(secret), { ...binding, ...change })).toThrow(/^acquisition_metadata_rejected$/);
  });
});
