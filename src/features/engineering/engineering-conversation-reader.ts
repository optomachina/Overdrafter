import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { prepareEngineeringMessage } from "./engineering-inbox-client";

export type EngineeringConversationContext = Readonly<Pick<Database["public"]["Tables"]["engineering_conversations"]["Row"],
  "id" | "owner_user_id" | "organization_id" | "project_id" | "head_snapshot_id" | "revision">>;
export type EngineeringHistoryMessage = Readonly<Pick<Database["public"]["Tables"]["engineering_messages"]["Row"],
  "id" | "body" | "role" | "sequence">>;

/**
 * Read one owner's conversation and recent history under a shared ten-second deadline.
 * This is not an atomic snapshot: later Send still checks its pinned expected revision.
 * No partial or late result escapes, and caller/session changes remain the caller's display boundary.
 */
export async function readEngineeringConversation(conversationId: string, ownerId: string): Promise<Readonly<{
  context: EngineeringConversationContext; messages: readonly EngineeringHistoryMessage[];
}>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Conversation unavailable.")); }, 10_000);
  });
  async function read() {
    if (typeof ownerId !== "string" || !ownerId.trim()
      || typeof conversationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(conversationId)) throw new Error("Unavailable");
    const head = await supabase.from("engineering_conversations")
      .select("id,owner_user_id,organization_id,project_id,head_snapshot_id,revision")
      .eq("id", conversationId).eq("owner_user_id", ownerId).abortSignal(controller.signal).single();
    if (controller.signal.aborted || head.error || !head.data || head.data.id !== conversationId || head.data.owner_user_id !== ownerId) throw new Error("Unavailable");
    const context = Object.freeze({ id: head.data.id, owner_user_id: ownerId,
      organization_id: head.data.organization_id, project_id: head.data.project_id,
      head_snapshot_id: head.data.head_snapshot_id, revision: head.data.revision });
    const binding = { organizationId: context.organization_id, projectId: context.project_id,
      conversationId, inputSnapshotId: context.head_snapshot_id, expectedRevision: context.revision };
    prepareEngineeringMessage({ ...binding, idempotencyKey: conversationId, body: "Context validation" });
    const history = await supabase.from("engineering_messages")
      .select("id,conversation_id,owner_user_id,organization_id,project_id,role,body,sequence")
      .eq("conversation_id", conversationId).eq("owner_user_id", ownerId)
      .eq("organization_id", context.organization_id).eq("project_id", context.project_id)
      .order("sequence", { ascending: false }).limit(100).abortSignal(controller.signal);
    if (controller.signal.aborted || history.error || !Array.isArray(history.data) || history.data.length > 100) throw new Error("Unavailable");
    const seen = new Set<string>();
    let previousSequence = Number.POSITIVE_INFINITY;
    const messages = history.data.map((row) => {
      if (!row || row.conversation_id !== conversationId || row.owner_user_id !== ownerId
        || row.organization_id !== context.organization_id || row.project_id !== context.project_id
        || !["user", "assistant", "system"].includes(row.role)
        || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || row.sequence >= previousSequence || seen.has(row.id)) throw new Error("Unavailable");
      prepareEngineeringMessage({ ...binding, idempotencyKey: row.id, body: row.body });
      previousSequence = row.sequence; seen.add(row.id);
      return Object.freeze({ id: row.id, body: row.body, role: row.role, sequence: row.sequence });
    }).reverse();
    return Object.freeze({ context, messages: Object.freeze(messages) });
  }
  try {
    return await Promise.race([read(), deadline]);
  } catch {
    throw new Error("Conversation unavailable.");
  } finally {
    clearTimeout(timer);
  }
}
