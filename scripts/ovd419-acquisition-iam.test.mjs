import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateSyntheticRuntimeIamEvidence } from "./ovd419-acquisition-iam.mjs";

const SERVICE_ACCOUNT = "overdrafter-worker-runner@overdrafter-worker-9133.iam.gserviceaccount.com";
const MEMBER = `serviceAccount:${SERVICE_ACCOUNT}`;
const mode = { mode: "TEST_ONLY" };
const globalRole = "roles/run.viewer";
const localRole = "projects/overdrafter-worker-9133/roles/ovd419ProbeReader";
const policy = (bindings = [{ role: globalRole, members: [MEMBER] }]) => ({ version: 1, etag: "TEST_ONLY_etag==", bindings });
const reply = (role, permissions = ["run.jobs.get", "run.executions.list"]) => ({ role, raw: JSON.stringify({ includedPermissions: permissions }) });
const validate = (value = policy(), replies = [reply(globalRole)]) =>
  validateSyntheticRuntimeIamEvidence(JSON.stringify(value), replies, mode);

describe("synthetic runtime IAM evidence", () => {
  it("retains exact bytes and returns deterministic frozen commands without authority", () => {
    const value = policy([
      { role: localRole, members: [MEMBER] },
      { role: "roles/logging.viewer", members: ["user:unrelated@example.invalid"] },
      { role: globalRole, members: [MEMBER] },
    ]);
    const policyRaw = `\n${JSON.stringify(value, null, 2)}\n`;
    const localRaw = ` ${JSON.stringify({ includedPermissions: ["run.executions.list"] })}\n`;
    const globalRaw = JSON.stringify({ includedPermissions: ["run.jobs.get"] });
    const result = validateSyntheticRuntimeIamEvidence(policyRaw,
      [{ role: globalRole, raw: globalRaw }, { role: localRole, raw: localRaw }], mode);
    expect(result).toMatchObject({ schema: "OVD419-SYNTHETIC-IAM-NOT-AUTHORITY-v1",
      policy: { raw: policyRaw, sha256: createHash("sha256").update(policyRaw).digest("hex") },
      permissions: ["run.executions.list", "run.jobs.get"], receivedBytes: Buffer.byteLength(policyRaw) + Buffer.byteLength(localRaw) + Buffer.byteLength(globalRaw),
      transportQualified: false, fullAcquisitionQualified: false, privateBindingReady: false });
    expect(result.roles.map(item => item.role)).toEqual([localRole, globalRole]);
    expect(result.roles[0].args).toEqual(["iam", "roles", "describe", "ovd419ProbeReader", "--format=json(includedPermissions)", "--project", "overdrafter-worker-9133"]);
    expect(result.roles[1].args).toEqual(["iam", "roles", "describe", globalRole, "--format=json(includedPermissions)"]);
    expect(result.roles[0]).toMatchObject({ raw: localRaw, sha256: createHash("sha256").update(localRaw).digest("hex") });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.policy)).toBe(true);
    expect(Object.isFrozen(result.roles)).toBe(true);
    expect(result.roles.every(item => Object.isFrozen(item) && Object.isFrozen(item.args))).toBe(true);
    expect(Object.isFrozen(result.permissions)).toBe(true);
  });

  it("is independent of binding, response, member, and permission order while preserving raw bytes", () => {
    const bindings = [{ role: globalRole, members: [MEMBER, "group:TEST_ONLY@example.invalid"] }, { role: localRole, members: [MEMBER] }];
    const first = validate(policy(bindings), [reply(globalRole, ["run.jobs.get"]), reply(localRole, ["run.executions.list"])]);
    const second = validate(policy(bindings.reverse().map(binding => ({ ...binding, members: [...binding.members].reverse() }))), [reply(localRole, ["run.executions.list"]), reply(globalRole, ["run.jobs.get"])]);
    expect(second.roles.map(item => item.role)).toEqual(first.roles.map(item => item.role));
    expect(second.permissions).toEqual(first.permissions);
    expect(second.policy.raw).not.toBe(first.policy.raw);
    expect(second.policy.sha256).not.toBe(first.policy.sha256);
  });

  it("accepts exactly 50 matching roles and rejects 51", () => {
    const bindings = Array.from({ length: 50 }, (_, index) => ({ role: `roles/TEST_ONLY.role${index}`, members: [MEMBER] }));
    const replies = bindings.map(({ role }, index) => reply(role, index === 0 ? ["run.jobs.get", "run.executions.list"] : [`test.permission${index}`]));
    expect(validate(policy(bindings), replies).roles).toHaveLength(50);
    bindings.push({ role: "roles/TEST_ONLY.role50", members: [MEMBER] });
    replies.push(reply("roles/TEST_ONLY.role50", ["test.permission50"]));
    expect(() => validate(policy(bindings), replies)).toThrow(/^acquisition_iam_rejected$/);
  });

  it.each([
    ["no matching role", policy([{ role: globalRole, members: ["user:other@example.invalid"] }]), []],
    ["public user", policy([{ role: globalRole, members: ["allUsers"] }]), []],
    ["public authenticated", policy([{ role: globalRole, members: ["allAuthenticatedUsers"] }]), []],
    ["conditional match", policy([{ role: globalRole, members: [MEMBER], condition: { title: "TEST_ONLY", expression: "true" } }]), [reply(globalRole)]],
    ["duplicate role", policy([{ role: globalRole, members: [MEMBER] }, { role: globalRole, members: [MEMBER, "user:other@example.invalid"] }]), [reply(globalRole)]],
    ["duplicate member", policy([{ role: globalRole, members: [MEMBER, MEMBER] }]), [reply(globalRole)]],
    ["foreign project role", policy([{ role: "projects/other-project/roles/test", members: [MEMBER] }]), [reply("projects/other-project/roles/test")]],
    ["organization role", policy([{ role: "organizations/123/roles/test", members: [MEMBER] }]), [reply("organizations/123/roles/test")]],
    ["malformed global role", policy([{ role: "roles/../owner", members: [MEMBER] }]), [reply("roles/../owner")]],
    ["unknown policy field", { ...policy(), auditConfigs: [] }, [reply(globalRole)]],
    ["unknown binding field", policy([{ role: globalRole, members: [MEMBER], deleted: false }]), [reply(globalRole)]],
    ["binding object", { bindings: {} }, [reply(globalRole)]],
    ["missing bindings", { version: 1 }, [reply(globalRole)]],
    ["invalid version", { ...policy(), version: 2 }, [reply(globalRole)]],
    ["invalid etag", { ...policy(), etag: "bad etag" }, [reply(globalRole)]],
    ["member object", policy([{ role: globalRole, members: [{}] }]), [reply(globalRole)]],
    ["member control", policy([{ role: globalRole, members: [`${MEMBER}\n`] }]), [reply(globalRole)]],
    ["overlong member", policy([{ role: globalRole, members: ["x".repeat(513)] }]), [reply(globalRole)]],
  ])("rejects %s policy evidence", (_, value, replies) => {
    expect(() => validate(value, replies)).toThrow(/^acquisition_iam_rejected$/);
  });

  it.each([
    ["missing", []], ["extra", [reply(globalRole), reply(localRole)]],
    ["duplicate", [reply(globalRole), reply(globalRole)]],
    ["foreign", [reply("roles/owner")]],
    ["object raw", [{ role: globalRole, raw: { includedPermissions: [] } }]],
    ["unknown wrapper field", [{ ...reply(globalRole), complete: true }]],
    ["unknown response field", [{ role: globalRole, raw: JSON.stringify({ includedPermissions: ["run.jobs.get", "run.executions.list"], name: globalRole }) }]],
    ["missing permissions", [{ role: globalRole, raw: "{}" }]],
    ["non-array permissions", [{ role: globalRole, raw: JSON.stringify({ includedPermissions: "run.jobs.get" }) }]],
    ["duplicate permission", [reply(globalRole, ["run.jobs.get", "run.executions.list", "run.jobs.get"])]],
    ["object permission", [reply(globalRole, ["run.jobs.get", "run.executions.list", {}])]],
    ["control permission", [reply(globalRole, ["run.jobs.get", "run.executions.list\n"])]],
    ["overlong permission", [reply(globalRole, ["run.jobs.get", "run.executions.list", `a.${"x".repeat(255)}`])]],
    ["missing required job permission", [reply(globalRole, ["run.executions.list"])]],
    ["missing required execution permission", [reply(globalRole, ["run.jobs.get"])]],
  ])("rejects %s role response evidence", (_, replies) => {
    expect(() => validate(policy(), replies)).toThrow(/^acquisition_iam_rejected$/);
  });

  it("rejects decoded duplicate raw keys and unknown wrapper fields", () => {
    const raws = [
      JSON.stringify(policy()).replace('"bindings":', '"bindings":[],"\\u0062indings":'),
      JSON.stringify(policy()).replace('"members":', '"members":[],"\\u006dembers":'),
    ];
    for (const raw of raws) expect(() => validateSyntheticRuntimeIamEvidence(raw, [reply(globalRole)], mode)).toThrow(/^acquisition_iam_rejected$/);
    const duplicateResponse = JSON.stringify({ includedPermissions: ["run.jobs.get", "run.executions.list"] }).replace('"includedPermissions":', '"includedPermissions":[],"\\u0069ncludedPermissions":');
    expect(() => validateSyntheticRuntimeIamEvidence(JSON.stringify(policy()), [{ role: globalRole, raw: duplicateResponse }], mode)).toThrow(/^acquisition_iam_rejected$/);
    expect(() => validateSyntheticRuntimeIamEvidence(JSON.stringify(policy()), [{ role: globalRole, raw: JSON.stringify({ includedPermissions: ["run.jobs.get", "run.executions.list"] }), extra: true }], mode)).toThrow(/^acquisition_iam_rejected$/);
  });

  it.each([undefined, {}, { mode: "PRODUCTION" }, { mode: "TEST_ONLY", complete: true }])("rejects unsupported options %j", options => {
    expect(() => validateSyntheticRuntimeIamEvidence(JSON.stringify(policy()), [reply(globalRole)], options)).toThrow(/^acquisition_iam_rejected$/);
  });

  it("rejects non-string and over-limit policy or response bodies", () => {
    expect(() => validateSyntheticRuntimeIamEvidence(policy(), [reply(globalRole)], mode)).toThrow(/^acquisition_iam_rejected$/);
    const tooLarge = `${JSON.stringify(policy())}${" ".repeat(4194304)}`;
    expect(() => validateSyntheticRuntimeIamEvidence(tooLarge, [reply(globalRole)], mode)).toThrow(/^acquisition_iam_rejected$/);
    expect(() => validateSyntheticRuntimeIamEvidence(JSON.stringify(policy()), [{ role: globalRole, raw: `${JSON.stringify({ includedPermissions: ["run.jobs.get", "run.executions.list"] })}${" ".repeat(4194304)}` }], mode)).toThrow(/^acquisition_iam_rejected$/);
  });

  it("rejects an aggregate over 32 MiB even when each body is below 4 MiB", () => {
    const bindings = Array.from({ length: 9 }, (_, index) => ({ role: `roles/TEST_ONLY.large${index}`, members: [MEMBER] }));
    const padding = " ".repeat(3_800_000);
    const replies = bindings.map(({ role }, index) => ({ role, raw: `${JSON.stringify({ includedPermissions: index === 0 ? ["run.jobs.get", "run.executions.list"] : [`test.permission${index}`] })}${padding}` }));
    expect(() => validate(policy(bindings), replies)).toThrow(/^acquisition_iam_rejected$/);
  });
});
