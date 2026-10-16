import type {
  AccessGrantRow,
  ChannelIdentityRow,
  ChannelSettingsRow,
  ControlCommandRow,
  ConversationRow,
  DecisionClaim,
  DecisionRow,
  InboundEventRow,
  JarvisRepo,
  LinkCodeRow,
  MessageRow,
  OutboundDeliveryRow,
  RunOrigin,
} from "./repo";
import type { ChannelId, UserId } from "./types";

const key = (...parts: string[]) => JSON.stringify(parts);

/**
 * In-memory JarvisRepo. Every check-and-set runs without an await in between, so
 * concurrent callers observe the same uniqueness guarantees the draft schema enforces.
 */
export class InMemoryJarvisRepo implements JarvisRepo {
  readonly accessGrants = new Map<UserId, AccessGrantRow>();
  readonly channelSettings = new Map<ChannelId, ChannelSettingsRow>();
  readonly conversations = new Map<UserId, ConversationRow>();
  readonly channelIdentities = new Map<string, ChannelIdentityRow>();
  readonly linkCodes = new Map<string, LinkCodeRow>();
  readonly messages: MessageRow[] = [];
  private readonly messagesByDedupeKey = new Map<string, MessageRow>();
  readonly decisions = new Map<string, DecisionRow>();
  readonly controlCommands = new Map<string, ControlCommandRow>();
  readonly inboundEvents = new Map<string, InboundEventRow>();
  readonly outboundDeliveries = new Map<string, OutboundDeliveryRow>();
  private sequence = 0;

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  async getChannelSettings(channel: ChannelId) {
    return this.channelSettings.get(channel) ?? null;
  }

  async claimInboundEvent(channel: ChannelId, idempotencyKey: string, receivedAt: string) {
    const id = key(channel, idempotencyKey);
    if (this.inboundEvents.has(id)) return false;
    this.inboundEvents.set(id, { channel, idempotencyKey, receivedAt });
    return true;
  }

  async releaseInboundEvent(channel: ChannelId, idempotencyKey: string) {
    this.inboundEvents.delete(key(channel, idempotencyKey));
  }

  async findIdentity(channel: ChannelId, externalIdHash: string) {
    return this.channelIdentities.get(key(channel, externalIdHash)) ?? null;
  }

  async findIdentityForUser(userId: UserId, channel: ChannelId) {
    const rows = [...this.channelIdentities.values()];
    return rows.find((row) => row.userId === userId && row.channel === channel && row.revokedAt === null) ?? null;
  }

  async insertIdentity(row: ChannelIdentityRow) {
    const id = key(row.channel, row.externalIdHash);
    if (this.channelIdentities.has(id)) return false;
    this.channelIdentities.set(id, { ...row });
    return true;
  }

  async consumeLinkCode(codeHash: string, channel: ChannelId, now: string) {
    const code = this.linkCodes.get(codeHash);
    if (!code || code.channel !== channel || code.consumedAt !== null || code.expiresAt <= now) return null;
    code.consumedAt = now;
    return { ...code };
  }

  async getAccessGrant(userId: UserId) {
    return this.accessGrants.get(userId) ?? null;
  }

  async getOrCreateConversation(userId: UserId) {
    const existing = this.conversations.get(userId);
    if (existing) return existing;
    const created = { id: this.nextId("conv"), userId };
    this.conversations.set(userId, created);
    return created;
  }

  async appendMessage(message: Omit<MessageRow, "id">) {
    const existing = message.dedupeKey === null ? undefined : this.messagesByDedupeKey.get(message.dedupeKey);
    if (existing) return existing;
    const row = { ...message, id: this.nextId("msg") };
    this.messages.push(row);
    if (row.dedupeKey !== null) this.messagesByDedupeKey.set(row.dedupeKey, row);
    return row;
  }

  async findMessageByDedupeKey(dedupeKey: string) {
    return this.messagesByDedupeKey.get(dedupeKey) ?? null;
  }

  async attachRun(messageId: string, runId: string) {
    const row = this.messages.find((message) => message.id === messageId);
    if (row) row.graphRunId = runId;
  }

  async findRunOrigin(runId: string): Promise<RunOrigin | null> {
    const origin = this.messages.find((message) => message.graphRunId === runId && message.direction === "in");
    if (!origin) return null;
    const conversation = [...this.conversations.values()].find((row) => row.id === origin.conversationId);
    return conversation ? { userId: conversation.userId, conversationId: conversation.id, channel: origin.channel } : null;
  }

  async insertDecision(row: DecisionRow) {
    if (!this.decisions.has(row.id)) this.decisions.set(row.id, { ...row });
  }

  async getDecision(decisionId: string) {
    const row = this.decisions.get(decisionId);
    return row ? { ...row } : null;
  }

  async claimDecision(decisionId: string, pendingKey: string, claimedAt: string, staleBefore: string): Promise<DecisionClaim> {
    const row = this.decisions.get(decisionId);
    if (!row || row.resolution !== null) return "resolved";
    const fresh = row.pendingAt !== null && row.pendingAt > staleBefore;
    if (row.pendingKey !== null && row.pendingKey !== pendingKey && fresh) return "busy";
    row.pendingKey = pendingKey;
    row.pendingAt = claimedAt;
    return "claimed";
  }

  async releaseDecision(decisionId: string, pendingKey: string) {
    const row = this.decisions.get(decisionId);
    if (row?.pendingKey === pendingKey) Object.assign(row, { pendingKey: null, pendingAt: null });
  }

  async resolveDecision(
    decisionId: string,
    pendingKey: string,
    resolution: Pick<DecisionRow, "resolution" | "chosen" | "rationale" | "resolvedBy" | "resolvedAt">,
  ) {
    const row = this.decisions.get(decisionId);
    if (!row || row.resolution !== null || row.pendingKey !== pendingKey) return false;
    Object.assign(row, resolution, { pendingKey: null, pendingAt: null, resolvedKey: pendingKey });
    return true;
  }

  async recordDecisionOutcome(decisionId: string, outcome: Pick<DecisionRow, "resolution" | "chosen" | "rationale" | "resolvedAt">) {
    const row = this.decisions.get(decisionId);
    if (!row) return;
    if (row.resolution === null) Object.assign(row, outcome, { pendingKey: null, pendingAt: null, resolvedKey: row.pendingKey });
    else row.rationale = outcome.rationale;
  }

  async insertControlCommand(row: ControlCommandRow) {
    const id = key(row.graphRunId, row.idempotencyKey);
    if (this.controlCommands.has(id)) return false;
    this.controlCommands.set(id, { ...row });
    return true;
  }

  async getControlCommand(graphRunId: string, idempotencyKey: string) {
    const row = this.controlCommands.get(key(graphRunId, idempotencyKey));
    return row ? { ...row } : null;
  }

  async setControlCommandStatus(graphRunId: string, idempotencyKey: string, status: ControlCommandRow["status"]) {
    const row = this.controlCommands.get(key(graphRunId, idempotencyKey));
    if (row) row.status = status;
  }

  async claimDelivery(messageId: string, channel: ChannelId) {
    const id = key(messageId, channel);
    if (this.outboundDeliveries.has(id)) return false;
    this.outboundDeliveries.set(id, { messageId, channel, status: "pending", attempts: 0 });
    return true;
  }

  async updateDelivery(messageId: string, channel: ChannelId, patch: Pick<OutboundDeliveryRow, "status" | "attempts">) {
    const row = this.outboundDeliveries.get(key(messageId, channel));
    if (row) Object.assign(row, patch);
  }
}
