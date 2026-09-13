import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

export type EngineeringMessage = Readonly<{
  organizationId: string;
  projectId: string;
  conversationId: string;
  inputSnapshotId: string;
  idempotencyKey: string;
  expectedRevision: number;
  body: string;
}>;

export type EngineeringMessageReceipt = Readonly<{
  conversationId: string;
  inputSnapshotId: string;
  messageId: string;
  requestId: string;
  revision: number;
}>;

export type EngineeringMessageOutcome =
  | { status: "recorded"; receipt: EngineeringMessageReceipt }
  | { status: "invalid_request"; submission?: EngineeringMessage }
  | { status: "conflict" | "access_unavailable" | "delivery_unknown"; submission: EngineeringMessage };

type SubmitArguments = Database["public"]["Functions"]["api_submit_engineering_message"]["Args"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isIdentity(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value) && value !== "00000000-0000-0000-0000-000000000000";
}

function isMessageBody(body: unknown): body is string {
  if (typeof body !== "string" || body.length > 8000 || !body.trim() || body.includes("\u0000")) return false;
  const characters = Array.from(body);
  // An unpaired surrogate cannot be represented faithfully in PostgreSQL UTF-8 text.
  if (characters.some((character) => character.length === 1 && /[\uD800-\uDFFF]/.test(character))) return false;
  return characters.length <= 4000 && new TextEncoder().encode(body).length <= 8000;
}

/** Pin one Send operation. Explicit retries must reuse all fields, including its idempotency key. */
export function prepareEngineeringMessage(input: EngineeringMessage): EngineeringMessage {
  if (!input || !isIdentity(input.organizationId) || !isIdentity(input.projectId)
    || !isIdentity(input.conversationId) || !isIdentity(input.inputSnapshotId)
    || !isIdentity(input.idempotencyKey) || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 0 || input.expectedRevision >= Number.MAX_SAFE_INTEGER
    || !isMessageBody(input.body)) {
    throw new Error("Invalid engineering message.");
  }
  return Object.freeze({
    organizationId: input.organizationId,
    projectId: input.projectId,
    conversationId: input.conversationId,
    inputSnapshotId: input.inputSnapshotId,
    idempotencyKey: input.idempotencyKey,
    expectedRevision: input.expectedRevision,
    body: input.body,
  });
}

function readReceipt(value: unknown, submission: EngineeringMessage): EngineeringMessageReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 5 || record.conversationId !== submission.conversationId
    || record.inputSnapshotId !== submission.inputSnapshotId || !isIdentity(record.messageId)
    || !isIdentity(record.requestId) || !Number.isSafeInteger(record.revision)
    || record.revision !== submission.expectedRevision + 1) return null;
  return Object.freeze({
    conversationId: submission.conversationId,
    inputSnapshotId: submission.inputSnapshotId,
    messageId: record.messageId,
    requestId: record.requestId,
    revision: record.revision as number,
  });
}

/**
 * Make one authenticated intake attempt with a ten-second deadline; never retry automatically.
 * A receipt confirms historical recording, not the current conversation head or CAD execution.
 * An uncertain response may follow a committed write. Retain submission for an exact retry;
 * even an access/conflict response does not undo a previously committed attempt.
 */
export async function submitEngineeringMessage(input: EngineeringMessage): Promise<EngineeringMessageOutcome> {
  let submission: EngineeringMessage;
  try {
    submission = prepareEngineeringMessage(input);
  } catch {
    return { status: "invalid_request" };
  }
  const args: SubmitArguments = {
    p_organization_id: submission.organizationId,
    p_project_id: submission.projectId,
    p_conversation_id: submission.conversationId,
    p_input_snapshot_id: submission.inputSnapshotId,
    p_expected_revision: submission.expectedRevision,
    p_idempotency_key: submission.idempotencyKey,
    p_body: submission.body,
  };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
      controller.abort();
    }, 10_000);
  });
  try {
    const response = await Promise.race([
      supabase.rpc("api_submit_engineering_message", args).abortSignal(controller.signal),
      timeout,
    ]);
    if (!response) return { status: "delivery_unknown", submission };
    if (response.error) {
      switch (response.error.code) {
        case "PT409": return { status: "conflict", submission };
        case "42501": return { status: "access_unavailable", submission };
        case "22023": return { status: "invalid_request", submission };
        default: return { status: "delivery_unknown", submission };
      }
    }
    const receipt = readReceipt(response.data, submission);
    if (receipt) return { status: "recorded", receipt };
    return { status: "delivery_unknown", submission };
  } catch {
    return { status: "delivery_unknown", submission };
  } finally {
    clearTimeout(timer);
  }
}
