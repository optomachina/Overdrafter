import { supabase } from "@/integrations/supabase/client";
import type { CadPreviewSource } from "@/lib/cad-preview-source";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sha = /^[0-9a-f]{64}$/;
const commit = /^[0-9a-f]{40}$/;
const MAX_STEP_BYTES = 2_000_000;

export type ExactStepReview = Readonly<{
  taskId: string; attemptId: string; sourceSnapshotId: string;
  candidateSnapshotId: string; candidateContextSha256: string;
  resultSha256: string; exportId: string; sourceCommit: string;
  reportSha256: string; stepSha256: string; stepBytes: number;
  source: CadPreviewSource;
}>;
export type StepReviewResult = Readonly<{ status: "unavailable"; reason: "not_verified" | "not_exported" }>
  | Readonly<{ status: "ready"; review: ExactStepReview }>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function valid(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function decodeStep(value: unknown, size: number): Uint8Array {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(MAX_STEP_BYTES / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new TypeError("Exact STEP encoding invalid.");
  }
  const binary = atob(value);
  if (btoa(binary) !== value || binary.length !== size) throw new TypeError("Exact STEP size differs.");
  const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  if (!text.startsWith("ISO-10303-21;") || !text.endsWith("END-ISO-10303-21;")) {
    throw new TypeError("Exact STEP envelope invalid.");
  }
  return bytes;
}

/** Revalidate exact RPC bytes before the renderer can access them. */
export async function parseExactStepReview(value: unknown, expected: {
  taskId: string; candidateSnapshotId: string;
}): Promise<StepReviewResult> {
  if (!record(value) || typeof value.status !== "string"
    || !["ready", "unavailable"].includes(value.status)) {
    throw new TypeError("Exact STEP review response invalid.");
  }
  if (value.status === "unavailable") {
    if (value.reason !== "not_verified" && value.reason !== "not_exported") {
      throw new TypeError("Exact STEP availability response invalid.");
    }
    return Object.freeze({ status: "unavailable", reason: value.reason });
  }
  if (value.taskId !== expected.taskId || value.candidateSnapshotId !== expected.candidateSnapshotId
    || !valid(value.taskId, uuid) || !valid(value.attemptId, uuid)
    || !valid(value.sourceSnapshotId, uuid) || !valid(value.candidateSnapshotId, uuid)
    || !valid(value.exportId, uuid)
    || !valid(value.candidateContextSha256, sha) || !valid(value.resultSha256, sha)
    || !valid(value.reportSha256, sha) || !valid(value.stepSha256, sha)
    || !valid(value.sourceCommit, commit)
    || !Number.isSafeInteger(value.stepBytes) || Number(value.stepBytes) < 1
    || Number(value.stepBytes) > MAX_STEP_BYTES) {
    throw new TypeError("Exact STEP review binding invalid.");
  }
  const stepBytes = value.stepBytes as number;
  const bytes = decodeStep(value.stepBase64, stepBytes);
  const measured = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const measuredSha = Array.from(measured, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (measuredSha !== value.stepSha256) throw new TypeError("Exact STEP bytes differ.");
  const source: CadPreviewSource = Object.freeze({
    cacheKey: `finalized-step:${value.candidateSnapshotId}:${measuredSha}`,
    fileName: "candidate-assembly.step",
    loadStepBuffer: async () => new Uint8Array(bytes),
  });
  return Object.freeze({ status: "ready", review: Object.freeze({
    taskId: value.taskId, attemptId: value.attemptId,
    sourceSnapshotId: value.sourceSnapshotId, candidateSnapshotId: value.candidateSnapshotId,
    candidateContextSha256: value.candidateContextSha256, resultSha256: value.resultSha256,
    exportId: value.exportId, sourceCommit: value.sourceCommit,
    reportSha256: value.reportSha256, stepSha256: measuredSha,
    stepBytes, source,
  }) });
}

type ReadRpc = (name: string, args: Record<string, string>) => Promise<{ data: unknown; error: unknown }>;

/** The RPC is staged source-only, so generated live database types omit it. */
export async function readExactStepReview(conversationId: string, taskId: string,
  candidateSnapshotId: string): Promise<StepReviewResult> {
  if (![conversationId, taskId, candidateSnapshotId].every((item) => valid(item, uuid))) {
    throw new TypeError("Exact STEP request identity invalid.");
  }
  const rpc = supabase.rpc.bind(supabase) as unknown as ReadRpc;
  const result = await rpc("api_read_native_step_review", {
    p_conversation_id: conversationId, p_task_id: taskId,
    p_candidate_snapshot_id: candidateSnapshotId,
  });
  if (result.error) throw new Error("Exact STEP review unavailable.");
  return parseExactStepReview(result.data, { taskId, candidateSnapshotId });
}
