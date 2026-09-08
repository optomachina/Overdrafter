/** Internal evidence contracts; no state in this module grants engineering release authority. */
export type EngineeringScope = Readonly<{ organizationId: string; projectId: string }>;
export type EngineeringDocumentReference = Readonly<{
  scope: EngineeringScope;
  documentId: string;
  canonicalPartId: string | null;
  partVersionId: string | null;
  configurationId: string | null;
  nativeVersion: string | null;
  officialRevision: string | null;
  observedAt: string;
  ownerId: string;
}>;
export type EngineeringQuantity = Readonly<{ value: number; unit: string }>;
export type EngineeringEvidenceReference = Readonly<{
  kind: "artifact" | "calculation" | "human" | "decision";
  sourceId: string;
  contentHash: string;
}>;
export type EngineeringStatement = Readonly<{
  id: string;
  kind: "requirement" | "constraint" | "objective" | "assumption" | "observation" | "derived";
  knowledgeState: "known" | "unknown" | "conflicting" | "stale";
  text: string;
  quantity: EngineeringQuantity | null;
  confidence: number | null;
  evidence: readonly EngineeringEvidenceReference[];
}>;
export type EngineeringDecisionReference = Readonly<{
  decisionId: string;
  revisionId: string;
  contentHash: string;
}>;
export type EngineeringArtifact = Readonly<{
  artifactId: string;
  scope: EngineeringScope;
  kind: "native_cad" | "calculation" | "drawing" | "report" | "other";
  contentHash: string;
  document: EngineeringDocumentReference;
}>;
export type EngineeringRequest = Readonly<{
  id: string;
  scope: EngineeringScope;
  text: string;
  desiredOutcome: string;
  selectedReferences: readonly EngineeringDocumentReference[];
  statements: readonly EngineeringStatement[];
}>;
export type EngineeringBinding = Readonly<{
  scope: EngineeringScope;
  baselineSnapshotId: string;
  baselineManifestHash: string;
  includedDecisions: readonly EngineeringDecisionReference[];
  requirementsHash: string;
  artifactManifestHash: string;
  toolchainHash: string;
  verificationPolicyHash: string;
}>;
export type EngineeringSnapshotInput = Readonly<{
  snapshotId: string;
  binding: EngineeringBinding;
  request: EngineeringRequest;
  artifacts: readonly EngineeringArtifact[];
}>;
export type EngineeringSnapshot = EngineeringSnapshotInput & Readonly<{
  schema: "engineering-snapshot.v1";
  bindingKey: string;
  canonicalKey: string;
}>;

function fail(path: string, reason: string): never {
  throw new TypeError(`${path}: ${reason}`);
}

function record(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return fail(path, "expected a plain object");
  }
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    return fail(path, "unexpected or missing fields");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) return fail(path, "expected nonempty trimmed text");
  return value;
}

function optionalText(value: unknown, path: string): string | null {
  if (value === null) return null;
  return text(value, path);
}

function hash(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) return fail(path, "expected a lowercase SHA-256 digest");
  return value;
}

function choice<T extends string>(value: unknown, options: readonly T[], path: string): T {
  if (typeof value !== "string" || !options.includes(value as T)) return fail(path, "unsupported value");
  return value as T;
}

function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(path, "expected a finite number");
  return value;
}

function compareText(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function serialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(serialize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort(compareText).map((key) => `${JSON.stringify(key)}:${serialize(object[key])}`).join(",")}}`;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(finite(value, "canonical value"));
  return fail("canonical value", "unsupported value");
}

function list<T>(value: unknown, path: string, parse: (item: unknown, path: string) => T, identity: (item: T) => string): T[] {
  if (!Array.isArray(value)) return fail(path, "expected an array");
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return fail(path, "sparse arrays are not supported");
  }
  const result = value.map((item, index) => parse(item, `${path}[${index}]`));
  const ids = result.map(identity);
  if (new Set(ids).size !== ids.length) return fail(path, "duplicate or conflicting identity");
  return result.sort((left, right) => compareText(identity(left), identity(right)));
}

function scope(value: unknown, path: string, expected?: EngineeringScope): EngineeringScope {
  const input = record(value, path, ["organizationId", "projectId"]);
  const result = { organizationId: text(input.organizationId, `${path}.organizationId`), projectId: text(input.projectId, `${path}.projectId`) };
  if (expected && (result.organizationId !== expected.organizationId || result.projectId !== expected.projectId)) return fail(path, "scope mismatch");
  return result;
}

function document(value: unknown, path: string, expected: EngineeringScope): EngineeringDocumentReference {
  const input = record(value, path, ["scope", "documentId", "canonicalPartId", "partVersionId", "configurationId", "nativeVersion", "officialRevision", "observedAt", "ownerId"]);
  const canonicalPartId = optionalText(input.canonicalPartId, `${path}.canonicalPartId`);
  const partVersionId = optionalText(input.partVersionId, `${path}.partVersionId`);
  if ((canonicalPartId === null) !== (partVersionId === null)) return fail(path, "part identity requires both canonical part and part version");
  const observedAt = text(input.observedAt, `${path}.observedAt`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(observedAt) || !Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) return fail(`${path}.observedAt`, "expected a canonical UTC timestamp");
  return {
    scope: scope(input.scope, `${path}.scope`, expected),
    documentId: text(input.documentId, `${path}.documentId`), canonicalPartId, partVersionId,
    configurationId: optionalText(input.configurationId, `${path}.configurationId`),
    nativeVersion: optionalText(input.nativeVersion, `${path}.nativeVersion`),
    officialRevision: optionalText(input.officialRevision, `${path}.officialRevision`), observedAt,
    ownerId: text(input.ownerId, `${path}.ownerId`),
  };
}

function evidence(value: unknown, path: string): EngineeringEvidenceReference {
  const input = record(value, path, ["kind", "sourceId", "contentHash"]);
  return { kind: choice(input.kind, ["artifact", "calculation", "human", "decision"], `${path}.kind`), sourceId: text(input.sourceId, `${path}.sourceId`), contentHash: hash(input.contentHash, `${path}.contentHash`) };
}

function statement(value: unknown, path: string): EngineeringStatement {
  const input = record(value, path, ["id", "kind", "knowledgeState", "text", "quantity", "confidence", "evidence"]);
  let quantity: EngineeringQuantity | null = null;
  if (input.quantity !== null) {
    const amount = record(input.quantity, `${path}.quantity`, ["value", "unit"]);
    quantity = { value: finite(amount.value, `${path}.quantity.value`), unit: text(amount.unit, `${path}.quantity.unit`) };
  }
  let confidence: number | null = null;
  if (input.confidence !== null) {
    confidence = finite(input.confidence, `${path}.confidence`);
    if (confidence < 0 || confidence > 1) return fail(`${path}.confidence`, "expected a value between zero and one");
  }
  const knowledgeState = choice(input.knowledgeState, ["known", "unknown", "conflicting", "stale"], `${path}.knowledgeState`);
  const references = list(input.evidence, `${path}.evidence`, evidence, (item) => serialize([item.kind, item.sourceId]));
  if (knowledgeState === "known" && references.length === 0) return fail(path, "known statements require explicit evidence");
  return {
    id: text(input.id, `${path}.id`), kind: choice(input.kind, ["requirement", "constraint", "objective", "assumption", "observation", "derived"], `${path}.kind`),
    knowledgeState, text: text(input.text, `${path}.text`), quantity, confidence, evidence: references,
  };
}

function decision(value: unknown, path: string): EngineeringDecisionReference {
  const input = record(value, path, ["decisionId", "revisionId", "contentHash"]);
  return { decisionId: text(input.decisionId, `${path}.decisionId`), revisionId: text(input.revisionId, `${path}.revisionId`), contentHash: hash(input.contentHash, `${path}.contentHash`) };
}

function binding(value: unknown): EngineeringBinding {
  const path = "binding";
  const input = record(value, path, ["scope", "baselineSnapshotId", "baselineManifestHash", "includedDecisions", "requirementsHash", "artifactManifestHash", "toolchainHash", "verificationPolicyHash"]);
  return {
    scope: scope(input.scope, `${path}.scope`), baselineSnapshotId: text(input.baselineSnapshotId, `${path}.baselineSnapshotId`),
    baselineManifestHash: hash(input.baselineManifestHash, `${path}.baselineManifestHash`),
    includedDecisions: list(input.includedDecisions, `${path}.includedDecisions`, decision, (item) => item.decisionId),
    requirementsHash: hash(input.requirementsHash, `${path}.requirementsHash`), artifactManifestHash: hash(input.artifactManifestHash, `${path}.artifactManifestHash`),
    toolchainHash: hash(input.toolchainHash, `${path}.toolchainHash`), verificationPolicyHash: hash(input.verificationPolicyHash, `${path}.verificationPolicyHash`),
  };
}

function artifact(value: unknown, path: string, expected: EngineeringScope): EngineeringArtifact {
  const input = record(value, path, ["artifactId", "scope", "kind", "contentHash", "document"]);
  return {
    artifactId: text(input.artifactId, `${path}.artifactId`), scope: scope(input.scope, `${path}.scope`, expected),
    kind: choice(input.kind, ["native_cad", "calculation", "drawing", "report", "other"], `${path}.kind`),
    contentHash: hash(input.contentHash, `${path}.contentHash`), document: document(input.document, `${path}.document`, expected),
  };
}

function request(value: unknown, expected: EngineeringScope): EngineeringRequest {
  const path = "request";
  const input = record(value, path, ["id", "scope", "text", "desiredOutcome", "selectedReferences", "statements"]);
  return {
    id: text(input.id, `${path}.id`), scope: scope(input.scope, `${path}.scope`, expected),
    text: text(input.text, `${path}.text`), desiredOutcome: text(input.desiredOutcome, `${path}.desiredOutcome`),
    selectedReferences: list<EngineeringDocumentReference>(input.selectedReferences, `${path}.selectedReferences`, (item, location) => document(item, location, expected), serialize),
    statements: list(input.statements, `${path}.statements`, statement, (item) => item.id),
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Validates exact evaluation context and returns versioned canonical bytes as text for external hashing. */
export function canonicalEngineeringBindingKey(input: EngineeringBinding): string {
  return serialize({ schema: "engineering-binding.v1", ...binding(input) });
}

/**
 * Validates, copies and recursively freezes an internal snapshot. Hash fields are
 * caller-supplied claims, not verified digests or authorization. canonicalKey also
 * covers the actual request and artifact manifest, preventing hidden content drift.
 */
export function createEngineeringSnapshot(value: EngineeringSnapshotInput): EngineeringSnapshot {
  const input = record(value, "snapshot", ["snapshotId", "binding", "request", "artifacts"]);
  const context = binding(input.binding);
  const artifacts = list(input.artifacts, "artifacts", (item, path) => artifact(item, path, context.scope), (item) => item.artifactId);
  const intent = request(input.request, context.scope);
  for (const item of intent.statements) {
    for (const reference of item.evidence) {
      if (reference.kind === "human") continue;
      if (reference.kind === "decision") {
        const source = context.includedDecisions.find((candidate) => candidate.decisionId === reference.sourceId);
        if (!source || source.contentHash !== reference.contentHash) fail(item.id, "decision evidence is not bound to the included revision");
      } else {
        const source = artifacts.find((candidate) => candidate.artifactId === reference.sourceId);
        if (!source || source.contentHash !== reference.contentHash || (reference.kind === "calculation" && source.kind !== "calculation")) fail(item.id, "artifact evidence is not bound to the manifest");
      }
    }
  }
  const snapshot = { schema: "engineering-snapshot.v1" as const, snapshotId: text(input.snapshotId, "snapshot.snapshotId"), binding: context, request: intent, artifacts };
  return freeze({ ...snapshot, bindingKey: canonicalEngineeringBindingKey(context), canonicalKey: serialize(snapshot) });
}
