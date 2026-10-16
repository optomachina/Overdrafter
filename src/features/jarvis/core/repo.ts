import type { AccessTier, ChannelId, ControlKind, UserId } from "./types";

// Row shapes mirror the OVD-797 draft (docs/migration-drafts/ovd-795-jarvis-channels.sql).

export type AccessGrantRow = {
  userId: UserId;
  tier: AccessTier;
  grantedBy: UserId;
  grantedAt: string;
  revokedAt: string | null;
};

export type ChannelSettingsRow = { channel: ChannelId; enabled: boolean; minTier: AccessTier };

export type ConversationRow = { id: string; userId: UserId };

export type ChannelIdentityRow = {
  userId: UserId;
  channel: ChannelId;
  externalIdHash: string;
  revokedAt: string | null;
};

export type LinkCodeRow = {
  codeHash: string;
  userId: UserId;
  channel: ChannelId;
  expiresAt: string;
  consumedAt: string | null;
};

export type MessageRow = {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  channel: ChannelId;
  kind: string;
  body: unknown;
  graphRunId: string | null;
};

export type DecisionResolution = "chosen" | "skipped_best_guess" | "timeout_best_guess";

export type DecisionRow = {
  id: string;
  messageId: string;
  graphRunId: string;
  graphNode: string;
  options: readonly string[];
  bestGuess: string;
  resolution: DecisionResolution | null;
  chosen: string | null;
  rationale: string | null;
  resolvedBy: UserId | null;
  resolvedAt: string | null;
};

export type ControlCommandRow = {
  id: string;
  graphRunId: string;
  kind: ControlKind;
  payload: unknown;
  actorUserId: UserId;
  idempotencyKey: string;
  status: "queued" | "applied" | "rejected";
  appliedAtCheckpoint: string | null;
};

export type InboundEventRow = { channel: ChannelId; idempotencyKey: string; receivedAt: string };

export type OutboundDeliveryRow = {
  messageId: string;
  channel: ChannelId;
  status: "pending" | "sent" | "failed";
  attempts: number;
};

export type RunOrigin = { userId: UserId; conversationId: string; channel: ChannelId };

/** Persistence port. The in-memory implementation backs OVD-798; Supabase swaps in after OVD-797. */
export interface JarvisRepo {
  getChannelSettings(channel: ChannelId): Promise<ChannelSettingsRow | null>;
  /** Atomic insert on PRIMARY KEY (channel, idempotency_key); false when already claimed. */
  claimInboundEvent(channel: ChannelId, idempotencyKey: string, receivedAt: string): Promise<boolean>;
  releaseInboundEvent(channel: ChannelId, idempotencyKey: string): Promise<void>;
  findIdentity(channel: ChannelId, externalIdHash: string): Promise<ChannelIdentityRow | null>;
  findIdentityForUser(userId: UserId, channel: ChannelId): Promise<ChannelIdentityRow | null>;
  /** Atomic insert on UNIQUE (channel, external_id_hash); false when that external id is already linked. */
  insertIdentity(row: ChannelIdentityRow): Promise<boolean>;
  /** Atomically marks an unexpired, unconsumed code consumed and returns it. */
  consumeLinkCode(codeHash: string, channel: ChannelId, now: string): Promise<LinkCodeRow | null>;
  getAccessGrant(userId: UserId): Promise<AccessGrantRow | null>;
  getOrCreateConversation(userId: UserId): Promise<ConversationRow>;
  appendMessage(message: Omit<MessageRow, "id">): Promise<MessageRow>;
  attachRun(messageId: string, runId: string): Promise<void>;
  findRunOrigin(runId: string): Promise<RunOrigin | null>;
  insertDecision(row: DecisionRow): Promise<void>;
  getDecision(decisionId: string): Promise<DecisionRow | null>;
  /** Resolves only an unresolved decision; false when it was already resolved. */
  resolveDecision(decisionId: string, resolution: Pick<DecisionRow, "resolution" | "chosen" | "rationale" | "resolvedBy" | "resolvedAt">): Promise<boolean>;
  /**
   * Applies the graph's own decision_resolved outcome: fills an unresolved row (timeouts never pass
   * through the core) and always stores the graph's rationale, which is the authoritative one.
   */
  recordDecisionOutcome(decisionId: string, outcome: Pick<DecisionRow, "resolution" | "chosen" | "rationale" | "resolvedAt">): Promise<void>;
  /** Atomic insert on UNIQUE (graph_run_id, idempotency_key); false on a duplicate. */
  insertControlCommand(row: ControlCommandRow): Promise<boolean>;
  /** Atomic insert on UNIQUE (message_id, channel); false when that delivery already exists. */
  claimDelivery(messageId: string, channel: ChannelId): Promise<boolean>;
  updateDelivery(messageId: string, channel: ChannelId, patch: Pick<OutboundDeliveryRow, "status" | "attempts">): Promise<void>;
}
