import { describe, expect, it } from "vitest";
import {
  canonicalEngineeringBindingKey,
  createEngineeringSnapshot,
  type EngineeringBinding,
  type EngineeringDocumentReference,
  type EngineeringSnapshotInput,
  type EngineeringStatement,
} from "./engineering-domain";

const digest = (character: string) => character.repeat(64);
const scope = { organizationId: "organization-a", projectId: "project-a" };

function fixture(): EngineeringSnapshotInput {
  const document: EngineeringDocumentReference = {
    scope: { ...scope },
    documentId: "mount-document",
    canonicalPartId: "mount-part",
    partVersionId: "mount-package-3",
    configurationId: "default",
    nativeVersion: "12",
    officialRevision: "B",
    observedAt: "2026-09-08T01:30:00.000Z",
    ownerId: "engineer-a",
  };
  const calculation: EngineeringDocumentReference = {
    ...document,
    documentId: "mass-calculation",
    canonicalPartId: null,
    partVersionId: null,
    configurationId: null,
    nativeVersion: null,
    officialRevision: null,
  };
  return {
    snapshotId: "candidate-snapshot",
    binding: {
      scope: { ...scope },
      baselineSnapshotId: "baseline-snapshot",
      baselineManifestHash: digest("a"),
      includedDecisions: [
        { decisionId: "b-decision", revisionId: "revision-2", contentHash: digest("b") },
        { decisionId: "a-decision", revisionId: "revision-1", contentHash: digest("c") },
      ],
      requirementsHash: digest("d"),
      artifactManifestHash: digest("e"),
      toolchainHash: digest("f"),
      verificationPolicyHash: digest("0"),
    },
    request: {
      id: "request-a",
      scope: { ...scope },
      text: "Increase the mounting bore diameter to 12 mm.",
      desiredOutcome: "A candidate with the requested bore size and verified wall thickness.",
      selectedReferences: [document, calculation],
      statements: [
        {
          id: "bore-diameter",
          kind: "requirement",
          knowledgeState: "known",
          text: "Requested bore diameter",
          quantity: { value: 12, unit: "mm" },
          confidence: null,
          evidence: [{ kind: "human", sourceId: "requester-a", contentHash: digest("1") }],
        },
        {
          id: "calculated-mass",
          kind: "derived",
          knowledgeState: "stale",
          text: "Mass calculated for the baseline, requiring re-evaluation after a change.",
          quantity: { value: 0.25, unit: "kg" },
          confidence: 0.99,
          evidence: [{ kind: "calculation", sourceId: "calculation-artifact", contentHash: digest("2") }],
        },
      ],
    },
    artifacts: [
      { artifactId: "native-artifact", scope: { ...scope }, kind: "native_cad", contentHash: digest("3"), document },
      { artifactId: "calculation-artifact", scope: { ...scope }, kind: "calculation", contentHash: digest("2"), document: calculation },
    ],
  };
}

function withStatement(input: EngineeringSnapshotInput, patch: Partial<EngineeringStatement>): EngineeringSnapshotInput {
  return { ...input, request: { ...input.request, statements: [{ ...input.request.statements[0], ...patch }] } };
}

function rejectSnapshot(input: unknown, message?: string) {
  expect(() => createEngineeringSnapshot(input as EngineeringSnapshotInput)).toThrow(message);
}

describe("engineering snapshot ontology", () => {
  it("retains native, official and observed identities separately with native and calculation artifacts", () => {
    const snapshot = createEngineeringSnapshot(fixture());
    const native = snapshot.artifacts.find((item) => item.kind === "native_cad")!;
    const calculation = snapshot.artifacts.find((item) => item.kind === "calculation")!;
    expect(native.document).toMatchObject({ nativeVersion: "12", officialRevision: "B", observedAt: "2026-09-08T01:30:00.000Z", ownerId: "engineer-a", configurationId: "default" });
    expect(calculation.document).toMatchObject({ canonicalPartId: null, partVersionId: null, nativeVersion: null, officialRevision: null });
    expect(snapshot).not.toHaveProperty("released");
    expect(snapshot).not.toHaveProperty("approved");
  });

  it.each([
    ["Substitute a stainless mounting screw.", "Evaluate fit and corrosion compatibility."],
    ["Inspect this bracket for DFM concerns.", "Identify manufacturing findings with source evidence."],
    ["Inspect the mounting arrangement for DFA concerns.", "Identify assembly access and sequence findings."],
  ])("uses the same generic request schema for %s", (text, desiredOutcome) => {
    const input = fixture();
    const snapshot = createEngineeringSnapshot({ ...input, request: { ...input.request, text, desiredOutcome } });
    expect(snapshot.request).toMatchObject({ text, desiredOutcome });
    expect(snapshot.request).not.toHaveProperty("kind");
    expect(snapshot.request).not.toHaveProperty("operations");
  });

  it("distinguishes a structured dimension change even when digest claims and prose are unchanged", () => {
    const input = fixture();
    const before = createEngineeringSnapshot(input);
    const after = createEngineeringSnapshot(withStatement(input, { quantity: { value: 14, unit: "mm" } }));
    expect(after.bindingKey).toBe(before.bindingKey);
    expect(after.canonicalKey).not.toBe(before.canonicalKey);
    expect(after.request.statements[0].quantity).toEqual({ value: 14, unit: "mm" });
  });

  it.each(["known", "unknown", "conflicting", "stale"] as const)("preserves %s independently from confidence", (knowledgeState) => {
    const snapshot = createEngineeringSnapshot(withStatement(fixture(), { knowledgeState, confidence: 1 }));
    expect(snapshot.request.statements[0]).toMatchObject({ knowledgeState, confidence: 1 });
  });

  it.each(["requirement", "constraint", "objective", "assumption", "observation", "derived"] as const)("represents %s without implying a release", (kind) => {
    const snapshot = createEngineeringSnapshot(withStatement(fixture(), { kind }));
    expect(snapshot.request.statements[0].kind).toBe(kind);
  });

  it("does not infer knowledge from empty evidence or high confidence", () => {
    const input = withStatement(fixture(), { knowledgeState: "unknown", confidence: 1, evidence: [] });
    expect(createEngineeringSnapshot(input).request.statements[0].knowledgeState).toBe("unknown");
    rejectSnapshot(withStatement(input, { knowledgeState: "known" }), "known statements require explicit evidence");
  });
});

describe("canonical engineering binding", () => {
  it("canonicalizes object keys and unordered decisions, references, statements and artifacts", () => {
    const input = fixture();
    const reordered = {
      artifacts: [...input.artifacts].reverse(),
      request: { ...input.request, statements: [...input.request.statements].reverse(), selectedReferences: [...input.request.selectedReferences].reverse() },
      binding: { ...input.binding, includedDecisions: [...input.binding.includedDecisions].reverse() },
      snapshotId: input.snapshotId,
    };
    expect(createEngineeringSnapshot(reordered)).toEqual(createEngineeringSnapshot(input));
    expect(JSON.parse(canonicalEngineeringBindingKey(input.binding)).schema).toBe("engineering-binding.v1");
  });

  it("sorts opaque identifiers by Unicode code point without locale collation", () => {
    const input = fixture();
    const includedDecisions = [
      { decisionId: "\u{10000}", revisionId: "r", contentHash: digest("a") },
      { decisionId: "\ue000", revisionId: "r", contentHash: digest("b") },
      { decisionId: "Z", revisionId: "r", contentHash: digest("c") },
    ];
    const key = canonicalEngineeringBindingKey({ ...input.binding, includedDecisions });
    expect(JSON.parse(key).includedDecisions.map((item: { decisionId: string }) => item.decisionId)).toEqual(["Z", "\ue000", "\u{10000}"]);
  });

  it.each(["baselineManifestHash", "requirementsHash", "artifactManifestHash", "toolchainHash", "verificationPolicyHash"] as const)("changes when the bound %s changes", (field) => {
    const context = fixture().binding;
    expect(canonicalEngineeringBindingKey({ ...context, [field]: digest("9") })).not.toBe(canonicalEngineeringBindingKey(context));
  });

  it("binds baseline, decision revision/content and tenant/project independently", () => {
    const context = fixture().binding;
    const changes: EngineeringBinding[] = [
      { ...context, baselineSnapshotId: "different-baseline" },
      { ...context, scope: { ...scope, projectId: "different-project" } },
      { ...context, scope: { ...scope, organizationId: "different-organization" } },
      { ...context, includedDecisions: [{ ...context.includedDecisions[0], revisionId: "different-revision" }] },
      { ...context, includedDecisions: [{ ...context.includedDecisions[0], contentHash: digest("9") }] },
    ];
    for (const changed of changes) expect(canonicalEngineeringBindingKey(changed)).not.toBe(canonicalEngineeringBindingKey(context));
  });

  it("detects actual artifact content and source-configuration changes despite unchanged manifest claims", () => {
    const input = fixture();
    for (const changed of [
      { ...input.artifacts[0], contentHash: digest("9") },
      { ...input.artifacts[0], document: { ...input.artifacts[0].document, configurationId: "alternate" } },
    ]) {
      const snapshot = createEngineeringSnapshot({ ...input, artifacts: [changed, input.artifacts[1]] });
      expect(snapshot.canonicalKey).not.toBe(createEngineeringSnapshot(input).canonicalKey);
    }
  });
});

describe("strict engineering context validation", () => {
  it.each(["", " ", "A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65)])("rejects a malformed digest %j", (contentHash) => {
    const input = fixture();
    expect(() => canonicalEngineeringBindingKey({ ...input.binding, requirementsHash: contentHash })).toThrow("lowercase SHA-256");
    rejectSnapshot({ ...input, artifacts: [{ ...input.artifacts[0], contentHash }] }, "lowercase SHA-256");
  });

  it.each([NaN, Infinity, -Infinity, "12", undefined])("rejects malformed/nonfinite quantities %j", (value) => {
    const input = fixture();
    rejectSnapshot(withStatement(input, { quantity: { value: value as number, unit: "mm" } }));
  });

  it.each([NaN, Infinity, -0.1, 1.1])("rejects invalid confidence %j", (confidence) => {
    rejectSnapshot(withStatement(fixture(), { confidence }));
  });

  it("rejects malformed units, undeclared fields, statuses, requests and sparse inputs", () => {
    const input = fixture();
    rejectSnapshot(withStatement(input, { quantity: { value: 12, unit: " " } }));
    rejectSnapshot({ ...input, released: true }, "unexpected or missing fields");
    rejectSnapshot(withStatement(input, { knowledgeState: "approved" as EngineeringStatement["knowledgeState"] }));
    rejectSnapshot({ ...input, request: null });
    rejectSnapshot({ ...input, artifacts: new Array(1) }, "sparse arrays");
  });

  it("rejects empty identifiers and incomplete document identity", () => {
    const input = fixture();
    const invalid = [
      { ...input, snapshotId: "" },
      { ...input, binding: { ...input.binding, baselineSnapshotId: "" } },
      { ...input, binding: { ...input.binding, scope: { ...scope, organizationId: "" } } },
      { ...input, request: { ...input.request, id: "" } },
      { ...input, artifacts: [{ ...input.artifacts[0], artifactId: "" }] },
      { ...input, artifacts: [{ ...input.artifacts[0], document: { ...input.artifacts[0].document, documentId: "" } }] },
      { ...input, artifacts: [{ ...input.artifacts[0], document: { ...input.artifacts[0].document, partVersionId: null } }] },
    ];
    invalid.forEach((value) => rejectSnapshot(value));
  });

  it.each(["not-a-date", "2026-02-30T01:30:00.000Z", "2026-09-08T01:30:00"])("rejects malformed observed timestamp %s", (observedAt) => {
    const input = fixture();
    rejectSnapshot({ ...input, artifacts: [{ ...input.artifacts[0], document: { ...input.artifacts[0].document, observedAt } }] }, "canonical UTC timestamp");
  });

  it.each(["organizationId", "projectId"] as const)("denies a mismatched %s on artifacts, documents and requests", (field) => {
    const input = fixture();
    const mismatch = { ...scope, [field]: "other" };
    const invalid = [
      { ...input, artifacts: [{ ...input.artifacts[0], scope: mismatch }] },
      { ...input, artifacts: [{ ...input.artifacts[0], document: { ...input.artifacts[0].document, scope: mismatch } }] },
      { ...input, request: { ...input.request, scope: mismatch } },
      { ...input, request: { ...input.request, selectedReferences: [{ ...input.request.selectedReferences[0], scope: mismatch }] } },
    ];
    invalid.forEach((value) => rejectSnapshot(value, "scope mismatch"));
  });

  it("rejects duplicate and conflicting included decision revisions", () => {
    const input = fixture();
    const first = input.binding.includedDecisions[0];
    for (const duplicate of [first, { ...first, revisionId: "another-revision" }, { ...first, contentHash: digest("9") }]) {
      expect(() => canonicalEngineeringBindingKey({ ...input.binding, includedDecisions: [first, duplicate] })).toThrow("duplicate or conflicting identity");
    }
  });

  it("rejects duplicate artifact, statement and selected-reference identities", () => {
    const input = fixture();
    rejectSnapshot({ ...input, artifacts: [input.artifacts[0], input.artifacts[0]] }, "duplicate or conflicting identity");
    rejectSnapshot({ ...input, request: { ...input.request, statements: [input.request.statements[0], input.request.statements[0]] } }, "duplicate or conflicting identity");
    rejectSnapshot({ ...input, request: { ...input.request, selectedReferences: [input.request.selectedReferences[0], input.request.selectedReferences[0]] } }, "duplicate or conflicting identity");
  });

  it("rejects unbound and substituted evidence, including a calculation mislabeled as native geometry", () => {
    const input = fixture();
    const cases: EngineeringStatement["evidence"][] = [
      [{ kind: "artifact", sourceId: "missing", contentHash: digest("3") }],
      [{ kind: "artifact", sourceId: "native-artifact", contentHash: digest("9") }],
      [{ kind: "calculation", sourceId: "native-artifact", contentHash: digest("3") }],
      [{ kind: "decision", sourceId: "b-decision", contentHash: digest("9") }],
      [{ kind: "decision", sourceId: "missing-decision", contentHash: digest("b") }],
    ];
    cases.forEach((evidence) => rejectSnapshot(withStatement(input, { evidence }), "not bound"));
    expect(createEngineeringSnapshot(withStatement(input, { evidence: [{ kind: "decision", sourceId: "b-decision", contentHash: digest("b") }] })).request.statements[0].evidence[0].sourceId).toBe("b-decision");
  });
});

describe("immutable engineering snapshots", () => {
  it("copies and deeply freezes every nested record and array without freezing caller objects", () => {
    const input = fixture();
    const snapshot = createEngineeringSnapshot(input);
    expect(snapshot.binding).not.toBe(input.binding);
    expect(snapshot.request.selectedReferences[0]).not.toBe(input.request.selectedReferences[0]);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.binding.scope)).toBe(false);
    const verifyFrozen = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      Object.values(value).forEach(verifyFrozen);
    };
    verifyFrozen(snapshot);
    expect(Reflect.set(snapshot.binding.scope, "projectId", "substituted")).toBe(false);
    expect(Reflect.set(snapshot.request.statements[0].quantity!, "value", 99)).toBe(false);
    Reflect.set(input.binding.scope, "projectId", "caller-edit");
    Reflect.set(input.request.statements[0].quantity!, "value", 99);
    expect(snapshot.binding.scope.projectId).toBe("project-a");
    expect(snapshot.request.statements[0].quantity?.value).toBe(12);
  });
});
