import { describe, expect, it } from "vitest";
import {
  OVD419_DIGEST_CONTRACT as CONTRACT,
  evaluatePreMutationChecks,
  isFullSha,
  isImmutableImage,
  parseDigestRecord,
} from "./ovd419-digest-contract.mjs";

const FULL_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const IMAGE = `us-docker.pkg.dev/proj/repo/worker@sha256:${"c".repeat(64)}`;
const ROLLBACK_IMAGE = `us-docker.pkg.dev/proj/repo/worker@sha256:${"d".repeat(64)}`;

function validRecord(overrides = {}) {
  return JSON.stringify({
    contractId: CONTRACT.contractId,
    schemaVersion: 1,
    commit: FULL_SHA,
    image: IMAGE,
    worktreeClean: true,
    buildVersion: FULL_SHA,
    ...overrides,
  });
}

function healthyObserved() {
  return {
    rollout: { disabled: true },
    queueDepthJob: 0,
    queueDepthService: 0,
    executionCount: 0,
    jobResourceVersion: "123456789",
    serviceResourceVersion: "987654321",
    rollbackImage: ROLLBACK_IMAGE,
  };
}

describe("OVD-419 digest record contract", () => {
  it("parses and freezes a valid clean-SHA record", () => {
    const record = parseDigestRecord(validRecord());
    expect(record.commit).toBe(FULL_SHA);
    expect(record.image).toBe(IMAGE);
    expect(record.worktreeClean).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("accepts UTF-8 byte input", () => {
    const record = parseDigestRecord(new TextEncoder().encode(validRecord()));
    expect(record.commit).toBe(FULL_SHA);
  });

  it("binds the image to source via exact full-SHA build version", () => {
    expect(() =>
      parseDigestRecord(validRecord({ buildVersion: FULL_SHA.slice(0, 7) })),
    ).toThrow(TypeError);
    expect(() => parseDigestRecord(validRecord({ buildVersion: OTHER_SHA }))).toThrow(
      TypeError,
    );
  });

  it.each([
    ["tag instead of SHA", validRecord({ commit: "v1.2.3", buildVersion: "v1.2.3" })],
    ["short SHA only", validRecord({ commit: FULL_SHA.slice(0, 7), buildVersion: FULL_SHA.slice(0, 7) })],
    ["uppercase SHA", validRecord({ commit: FULL_SHA.toUpperCase(), buildVersion: FULL_SHA.toUpperCase() })],
    ["dirty worktree record", validRecord({ worktreeClean: false })],
    ["non-immutable image tag reference", validRecord({ image: "worker:latest" })],
    ["wrong contractId", validRecord({ contractId: "ovd420-recovery-egress-v1" })],
    ["unsupported schema version", validRecord({ schemaVersion: 2 })],
    ["unknown field", validRecord({ extra: true })],
    ["missing commit", JSON.stringify({ contractId: CONTRACT.contractId, schemaVersion: 1 })],
    ["not an object", "[1,2,3]"],
    ["malformed JSON", "{not json"],
  ])("rejects %s", (_label, source) => {
    expect(() => parseDigestRecord(source)).toThrow(TypeError);
  });

  it("rejects malformed UTF-8 bytes", () => {
    expect(() => parseDigestRecord(new Uint8Array([0xc3, 0x28]))).toThrow(TypeError);
  });
});

describe("OVD-419 pre-mutation checks", () => {
  it("passes healthy observations and returns a frozen verdict", () => {
    const record = parseDigestRecord(validRecord());
    const verdict = evaluatePreMutationChecks(record, healthyObserved());
    expect(verdict.verdict).toBe("pass");
    expect(verdict.image).toBe(IMAGE);
    expect(verdict.rollbackImage).toBe(ROLLBACK_IMAGE);
    expect(Object.isFrozen(verdict)).toBe(true);
  });

  it("allows a null rollback image for first promotion", () => {
    const record = parseDigestRecord(validRecord());
    const observed = { ...healthyObserved(), rollbackImage: null };
    const verdict = evaluatePreMutationChecks(record, observed);
    expect(verdict.rollbackImage).toBeNull();
  });

  it("aggregates multiple failures fail-closed", () => {
    const record = parseDigestRecord(validRecord());
    const observed = {
      ...healthyObserved(),
      rollout: { disabled: false },
      queueDepthJob: 2,
      executionCount: 1,
      serviceResourceVersion: "",
    };
    try {
      evaluatePreMutationChecks(record, observed);
      throw new Error("expected pre-mutation checks to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("rollout must be disabled");
      expect(error.message).toContain("probe job queue must be empty");
      expect(error.message).toContain("execution count must be zero");
      expect(error.message).toContain("serviceResourceVersion");
    }
  });

  it.each([
    [
      "enabled rollout",
      (o) => ({ ...o, rollout: { disabled: false } }),
      "rollout must be disabled",
    ],
    [
      "non-empty probe job queue",
      (o) => ({ ...o, queueDepthJob: 1 }),
      "probe job queue must be empty",
    ],
    [
      "non-empty service queue",
      (o) => ({ ...o, queueDepthService: 3 }),
      "service queue must be empty",
    ],
    [
      "outstanding executions",
      (o) => ({ ...o, executionCount: 2 }),
      "execution count must be zero",
    ],
    [
      "missing job resource version",
      (o) => ({ ...o, jobResourceVersion: null }),
      "jobResourceVersion",
    ],
    [
      "negative queue depth",
      (o) => ({ ...o, queueDepthService: -1 }),
      "queueDepthService",
    ],
    [
      "mutable rollback image",
      (o) => ({ ...o, rollbackImage: "worker:rollback" }),
      "rollbackImage",
    ],
  ])("rejects %s", (_label, mutate, messagePart) => {
    const record = parseDigestRecord(validRecord());
    expect(() => evaluatePreMutationChecks(record, mutate(healthyObserved()))).toThrow(
      messagePart,
    );
  });

  it("rejects non-object observations", () => {
    const record = parseDigestRecord(validRecord());
    expect(() => evaluatePreMutationChecks(record, null)).toThrow(TypeError);
  });
});

describe("OVD-419 pattern helpers", () => {
  it("classifies full SHAs and immutable images", () => {
    expect(isFullSha(FULL_SHA)).toBe(true);
    expect(isFullSha(FULL_SHA.slice(0, 12))).toBe(false);
    expect(isImmutableImage(IMAGE)).toBe(true);
    expect(isImmutableImage("worker:latest")).toBe(false);
  });
});
