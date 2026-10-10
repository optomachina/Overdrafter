import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { isEngineeringIdentity, isEngineeringMessageBody } from "./engineering-inbox-client";

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
  const deadlineAt = performance.now() + 10_000;
  function checkDeadline() {
    // Elapsed work can finish before the timer callback gets a turn to run.
    if (performance.now() >= deadlineAt) controller.abort();
    if (controller.signal.aborted) throw new Error("Unavailable");
  }
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Conversation unavailable.")); }, 10_000);
  });
  async function read() {
    if (typeof ownerId !== "string" || !ownerId.trim()
      || typeof conversationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(conversationId)) throw new Error("Unavailable");
    checkDeadline();
    const head = await supabase.from("engineering_conversations")
      .select("id,owner_user_id,organization_id,project_id,head_snapshot_id,revision")
      .eq("id", conversationId).eq("owner_user_id", ownerId).abortSignal(controller.signal).single();
    checkDeadline();
    if (head.error || !head.data || head.data.id !== conversationId || head.data.owner_user_id !== ownerId) throw new Error("Unavailable");
    const context = Object.freeze({ id: head.data.id, owner_user_id: ownerId,
      organization_id: head.data.organization_id, project_id: head.data.project_id,
      head_snapshot_id: head.data.head_snapshot_id, revision: head.data.revision });
    // A stored revision may reach MAX_SAFE_INTEGER after the last valid Send.
    // Reads do not need the extra revision slot required by the intake RPC.
    if (!isEngineeringIdentity(context.id) || !isEngineeringIdentity(context.organization_id)
      || !isEngineeringIdentity(context.project_id) || !isEngineeringIdentity(context.head_snapshot_id)
      || !Number.isSafeInteger(context.revision) || context.revision < 0) throw new Error("Unavailable");
    checkDeadline();
    const history = await supabase.from("engineering_messages")
      .select("id,conversation_id,owner_user_id,organization_id,project_id,role,body,sequence")
      .eq("conversation_id", conversationId).eq("owner_user_id", ownerId)
      .eq("organization_id", context.organization_id).eq("project_id", context.project_id)
      .order("sequence", { ascending: false }).limit(100).abortSignal(controller.signal);
    checkDeadline();
    if (history.error || !Array.isArray(history.data) || history.data.length > 100) throw new Error("Unavailable");
    const seen = new Set<string>();
    let previousSequence = Number.POSITIVE_INFINITY;
    const messages = history.data.map((row) => {
      if (!row || row.conversation_id !== conversationId || row.owner_user_id !== ownerId
        || row.organization_id !== context.organization_id || row.project_id !== context.project_id
        || !["user", "assistant", "system"].includes(row.role)
        || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || row.sequence >= previousSequence || seen.has(row.id)) throw new Error("Unavailable");
      if (!isEngineeringIdentity(row.id) || !isEngineeringMessageBody(row.body)) throw new Error("Unavailable");
      previousSequence = row.sequence; seen.add(row.id);
      return Object.freeze({ id: row.id, body: row.body, role: row.role, sequence: row.sequence });
    }).reverse();
    checkDeadline();
    return Object.freeze({ context, messages: Object.freeze(messages) });
  }
  try {
    const result = await Promise.race([read(), deadline]);
    checkDeadline();
    return result;
  } catch {
    if (performance.now() >= deadlineAt) controller.abort();
    throw new Error("Conversation unavailable.");
  } finally {
    clearTimeout(timer);
  }
}
