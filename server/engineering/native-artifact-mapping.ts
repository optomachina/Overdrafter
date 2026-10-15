import type { PrivateArtifactSql } from "./native-artifact-repository";

export const WRITE_NATIVE_ARTIFACT_MAPPINGS_SQL = `select engineering_private.write_native_artifact_mappings($1::uuid,$2::text,$3::text) as mapping`;
export type NativeArtifactMapping = Readonly<{
  attemptId: string; inputAdmissionId: string; outputRoles: 7;
  inputs: readonly Readonly<{ id: string; ordinal: number }>[];
}>;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function validId(value: unknown): value is string {
  return typeof value === "string" && uuid.test(value) && value !== "00000000-0000-0000-0000-000000000000";
}
/** Internal owner composition only. Do not expose manifest/bucket selection in a
 * worker route. Existing admission hash authorizes seed bytes; finalized producer
 * registry authorizes candidate bytes. This writer cannot create admission.
 * Driver must reject unknown COMMIT outcomes; caller must explicitly reconcile
 * by repeating this exact operation, never substitute another mapping. */
export async function writeNativeArtifactMappings(input: {
  enabled: boolean; sql: PrivateArtifactSql; attemptId: string;
  seedManifestText: string | null; outputBucket: string; signal: AbortSignal;
}): Promise<NativeArtifactMapping> {
  if (input.enabled !== true) throw new Error("native_mapping_disabled");
  const { sql, attemptId, seedManifestText, outputBucket, signal } = input;
  if (!validId(attemptId) || typeof outputBucket !== "string" || outputBucket.length < 1
    || Buffer.byteLength(outputBucket) > 100 || Array.from(outputBucket).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    || (seedManifestText !== null && (typeof seedManifestText !== "string"
      || Buffer.byteLength(seedManifestText) > 16384))) throw new Error("native_mapping_invalid_input");
  signal.throwIfAborted();
  return sql.transaction(async (tx) => {
    signal.throwIfAborted();
    const rows = await tx.query(WRITE_NATIVE_ARTIFACT_MAPPINGS_SQL,
      [attemptId, seedManifestText, outputBucket], { signal, timeoutMs: 30000 });
    signal.throwIfAborted();
    const result = rows[0]?.mapping as NativeArtifactMapping | undefined;
    if (rows.length !== 1 || !result || result.attemptId !== attemptId || !validId(result.inputAdmissionId)
      || result.outputRoles !== 7 || !Array.isArray(result.inputs) || result.inputs.length !== 3
      || result.inputs.some((item, index) => !item || item.ordinal !== index || !validId(item.id))
      || new Set(result.inputs.map((item) => item.id)).size !== 3) throw new Error("native_mapping_invalid_receipt");
    return Object.freeze({ attemptId, inputAdmissionId: result.inputAdmissionId, outputRoles: 7,
      inputs: Object.freeze(result.inputs.map(({ id, ordinal }) => Object.freeze({ id, ordinal }))) });
  }, { signal, timeoutMs: 30000, isolation: "read committed" });
}

export const PREPARE_NATIVE_ARTIFACT_INPUTS_SQL = `select engineering_private.prepare_native_artifact_inputs($1::uuid,$2::uuid,$3::text) as mapping`;
export const PREPARE_NATIVE_ARTIFACT_OUTPUTS_SQL = `select engineering_private.prepare_native_artifact_outputs($1::uuid,$2::text) as mapping`;
export type NativeArtifactInputs = Pick<NativeArtifactMapping, "inputAdmissionId" | "inputs">;
/** Preclaim owner provisioning. IDs are returned before a worker is dispatched. */
export async function prepareNativeArtifactInputs(input: {
  enabled: boolean; sql: PrivateArtifactSql; inputAdmissionId: string; actorId: string;
  seedManifestText: string | null; signal: AbortSignal;
}): Promise<NativeArtifactInputs> {
  if (input.enabled !== true) throw new Error("native_mapping_disabled");
  const { sql, inputAdmissionId, actorId, seedManifestText, signal } = input;
  if (!validId(inputAdmissionId) || !validId(actorId) || (seedManifestText !== null
    && (typeof seedManifestText !== "string" || Buffer.byteLength(seedManifestText) > 16384))) throw new Error("native_mapping_invalid_input");
  signal.throwIfAborted();
  return sql.transaction(async (tx) => {
    signal.throwIfAborted();
    const rows = await tx.query(PREPARE_NATIVE_ARTIFACT_INPUTS_SQL,
      [inputAdmissionId, actorId, seedManifestText], { signal, timeoutMs: 30000 });
    signal.throwIfAborted();
    const result = rows[0]?.mapping as NativeArtifactInputs | undefined;
    if (rows.length !== 1 || !result || result.inputAdmissionId !== inputAdmissionId
      || !Array.isArray(result.inputs) || result.inputs.length !== 3
      || result.inputs.some((item, index) => !item || item.ordinal !== index || !validId(item.id))
      || new Set(result.inputs.map((item) => item.id)).size !== 3) throw new Error("native_mapping_invalid_receipt");
    return Object.freeze({ inputAdmissionId,
      inputs: Object.freeze(result.inputs.map(({ id, ordinal }) => Object.freeze({ id, ordinal }))) });
  }, { signal, timeoutMs: 30000, isolation: "read committed" });
}
/** Internal poststop provisioning; no seed manifest or worker bucket selection. */
export async function prepareNativeArtifactOutputs(input: {
  enabled: boolean; sql: PrivateArtifactSql; attemptId: string; outputBucket: string; signal: AbortSignal;
}): Promise<Readonly<{ attemptId: string; outputRoles: 7 }>> {
  if (input.enabled !== true) throw new Error("native_mapping_disabled");
  const { sql, attemptId, outputBucket, signal } = input;
  if (!validId(attemptId) || typeof outputBucket !== "string" || outputBucket.length < 1
    || Buffer.byteLength(outputBucket) > 100
    || Array.from(outputBucket).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw new Error("native_mapping_invalid_input");
  signal.throwIfAborted();
  return sql.transaction(async (tx) => {
    signal.throwIfAborted();
    const rows = await tx.query(PREPARE_NATIVE_ARTIFACT_OUTPUTS_SQL,
      [attemptId, outputBucket], { signal, timeoutMs: 30000 });
    signal.throwIfAborted();
    const result = rows[0]?.mapping as { attemptId: string; outputRoles: number } | undefined;
    if (rows.length !== 1 || !result || result.attemptId !== attemptId || result.outputRoles !== 7) throw new Error("native_mapping_invalid_receipt");
    return Object.freeze({ attemptId, outputRoles: 7 });
  }, { signal, timeoutMs: 30000, isolation: "read committed" });
}
