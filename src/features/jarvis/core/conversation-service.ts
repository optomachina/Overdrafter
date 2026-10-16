import { deliver, type DeliveryPolicy } from "./delivery";
import type { RateLimiter } from "./rate-limiter";
import type { ChannelRegistry } from "./registry";
import { NOT_AVAILABLE_REPLY, renderEvent, SKIP_CHOICE, type OutboundEvent } from "./render";
import type { ChannelSettingsRow, DecisionRow, JarvisRepo, MessageRow, RunOrigin } from "./repo";
import {
  WEB_CHANNEL,
  type AccessTier,
  type ChannelAdapter,
  type ChannelId,
  type DesignGraph,
  type GraphDecisionAnswer,
  type GraphEvent,
  type InboundAction,
  type InboundMessage,
  type UserId,
} from "./types";

export const LINK_PROMPT = "To use Jarvis here, link this chat from the Jarvis web app.";
export const GENERIC_DENIAL = "Jarvis isn't available for this account yet.";
export const THROTTLED_REPLY = "You're sending requests too quickly. Try again in a minute.";
export { NOT_AVAILABLE_REPLY };
export const REFUSED_REPLY = "That action isn't allowed.";

const TIER_RANK: Record<AccessTier, number> = { paid: 1, beta: 2, owner: 3 };
const SLICE_ONE_CONTROLS = new Set(["pause", "cancel"]);

export type JarvisLogEntry = { readonly channel: ChannelId; readonly outcome: string; readonly reason?: string };

/**
 * `reply` on denied/throttled/unavailable/refused results is the user-facing answer and is never
 * sent through `ChannelAdapter.send`: the webhook handler returns it in its synchronous response
 * (Slack response body, Telegram webhook reply, web JSON). An unlinked sender has no stored
 * address, so the synchronous response is the only way to reach them, and a replay of the same
 * event returns `duplicate` with no reply, so the user gets exactly one.
 */
export type InboundResult =
  | { readonly status: "dropped"; readonly reason: "unknown_channel" | "flag_off" | "channel_disabled" }
  | { readonly status: "rejected"; readonly reason: "unverified" | "malformed" }
  | { readonly status: "duplicate" }
  | { readonly status: "denied" | "throttled" | "unavailable"; readonly reply: string }
  | { readonly status: "refused"; readonly reason: string; readonly reply: string }
  | { readonly status: "accepted"; readonly runId: string };

export type ConversationServiceDeps = {
  readonly repo: JarvisRepo;
  readonly graph: DesignGraph;
  readonly channels: ChannelRegistry;
  /** Keyed hash (HMAC in production) for external ids and link codes; raw values are never stored. */
  readonly hash: (value: string) => string;
  /** JARVIS_UI_ENABLED, read server-side. */
  readonly uiEnabled: boolean;
  readonly testEnvironment: boolean;
  readonly rateLimiter: RateLimiter;
  readonly delivery: DeliveryPolicy;
  readonly webBaseUrl: string;
  readonly now: () => Date;
  readonly log: (entry: JarvisLogEntry) => void;
};

type Admitted = {
  readonly adapter: ChannelAdapter;
  readonly message: InboundMessage;
  readonly userId: UserId;
  readonly externalIdHash: string;
};

type Routed = Admitted & { readonly origin: RunOrigin; readonly inbound: MessageRow };

type AccessCheck = { readonly userId: UserId } | { readonly reason: string; readonly reply: string };

/**
 * One conversation service for every channel. The pipeline order is fixed:
 * flag -> channel enabled -> verify -> idempotency claim -> identity -> tier -> rate limit
 * -> append -> DesignGraph. Nothing before the append writes anything except the claim.
 */
export class ConversationService {
  constructor(private readonly deps: ConversationServiceDeps) {}

  async handleInbound(channelId: ChannelId, request: unknown): Promise<InboundResult> {
    const adapter = this.deps.channels.get(channelId);
    if (!adapter) return this.finish(channelId, { status: "dropped", reason: "unknown_channel" });
    if (!this.routable(adapter)) return this.finish(channelId, { status: "dropped", reason: "flag_off" });
    const settings = await this.enabledSettings(channelId);
    if (!settings) return this.finish(channelId, { status: "dropped", reason: "channel_disabled" });
    const message = await this.verifiedMessage(adapter, request);
    if ("status" in message) return this.finish(channelId, message);
    const receivedAt = this.deps.now().toISOString();
    if (!(await this.deps.repo.claimInboundEvent(channelId, message.idempotencyKey, receivedAt))) {
      return this.finish(channelId, { status: "duplicate" });
    }
    try {
      return await this.admit(adapter, message, settings);
    } catch (error) {
      // Release the claim so the channel's retry (sent after our non-2xx) is processed, not dropped
      // as a duplicate. Every write after the claim is idempotent per event, so the retry resumes.
      await this.deps.repo.releaseInboundEvent(channelId, message.idempotencyKey).catch(() => undefined);
      this.deps.log({ channel: channelId, outcome: "failed", reason: "internal_error" });
      throw error;
    }
  }

  /**
   * Graph events fan out to the web thread (always) and the run's originating channel. Replays are
   * safe: the message row is keyed on the event's (runId, seq), decision writes are idempotent, and
   * each (message, channel) delivery is claimed once, so a redelivered event or a retry after a
   * partial fan-out never sends a channel the same message twice.
   */
  async handleGraphEvent(event: GraphEvent): Promise<void> {
    const origin = await this.deps.repo.findRunOrigin(event.runId);
    if (!origin) return;
    const message = await this.appendOutbound(origin, event);
    if (event.type === "decision_requested") await this.deps.repo.insertDecision(decisionRow(event, message.id));
    if (event.type === "decision_resolved") await this.deps.repo.recordDecisionOutcome(event.decisionId, decisionOutcome(event));
    await this.fanOut(origin, message, event);
  }

  /** Consumes a one-time code issued from an AAL2 web session and links the external id. */
  async linkIdentity(channel: ChannelId, code: string, externalUserId: string): Promise<UserId | null> {
    const linkCode = await this.deps.repo.consumeLinkCode(this.deps.hash(code), channel, this.deps.now().toISOString());
    if (!linkCode) return null;
    const externalIdHash = this.externalIdHash(channel, externalUserId);
    const linked = await this.deps.repo.insertIdentity({ userId: linkCode.userId, channel, externalIdHash, address: null, revokedAt: null });
    return linked ? linkCode.userId : null;
  }

  private routable(adapter: ChannelAdapter): boolean {
    return adapter.testOnly ? this.deps.testEnvironment : this.deps.uiEnabled;
  }

  private async enabledSettings(channel: ChannelId): Promise<ChannelSettingsRow | null> {
    const settings = await this.deps.repo.getChannelSettings(channel);
    return settings?.enabled ? settings : null;
  }

  private async verifiedMessage(adapter: ChannelAdapter, request: unknown): Promise<InboundMessage | InboundResult> {
    const verified = await adapter.verifyInbound(request);
    if (!verified.ok) return { status: "rejected", reason: "unverified" };
    try {
      return adapter.normalizeInbound(request);
    } catch {
      return { status: "rejected", reason: "malformed" };
    }
  }

  private async admit(adapter: ChannelAdapter, message: InboundMessage, settings: ChannelSettingsRow): Promise<InboundResult> {
    const externalIdHash = this.externalIdHash(adapter.id, message.externalUserId);
    const access = await this.checkAccess(adapter.id, externalIdHash, settings.minTier);
    if (!("userId" in access)) return this.finish(adapter.id, { status: "denied", reply: access.reply }, access.reason);
    if (!this.deps.rateLimiter.tryAcquire(access.userId, this.deps.now().getTime())) {
      await this.deps.repo.releaseInboundEvent(adapter.id, message.idempotencyKey);
      return this.finish(adapter.id, { status: "throttled", reply: THROTTLED_REPLY });
    }
    const routed = await this.append({ adapter, message, userId: access.userId, externalIdHash });
    return this.route(routed);
  }

  private async checkAccess(channel: ChannelId, externalIdHash: string, minTier: AccessTier): Promise<AccessCheck> {
    const identity = await this.deps.repo.findIdentity(channel, externalIdHash);
    if (!identity) return { reason: "identity_unlinked", reply: LINK_PROMPT };
    if (identity.revokedAt !== null) return { reason: "identity_revoked", reply: LINK_PROMPT };
    const grant = await this.deps.repo.getAccessGrant(identity.userId);
    if (!grant) return { reason: "no_grant", reply: GENERIC_DENIAL };
    if (grant.revokedAt !== null) return { reason: "grant_revoked", reply: GENERIC_DENIAL };
    if (TIER_RANK[grant.tier] < TIER_RANK[minTier]) return { reason: "tier_below_min", reply: GENERIC_DENIAL };
    return { userId: identity.userId };
  }

  private async append(admitted: Admitted): Promise<Routed> {
    const conversation = await this.deps.repo.getOrCreateConversation(admitted.userId);
    const { message, adapter } = admitted;
    const inbound = await this.deps.repo.appendMessage({
      conversationId: conversation.id,
      direction: "in",
      channel: adapter.id,
      kind: message.action?.kind ?? "text",
      body: { text: message.text, action: message.action ?? null },
      graphRunId: null,
      dedupeKey: `in:${adapter.id}:${message.idempotencyKey}`,
    });
    const origin = { userId: admitted.userId, conversationId: conversation.id, channel: adapter.id };
    return { ...admitted, origin, inbound };
  }

  private route(routed: Routed): Promise<InboundResult> {
    const action = routed.message.action;
    if (action?.kind === "decision") return this.routeDecision(routed, action);
    if (action?.kind === "control") return this.routeControl(routed, action);
    return this.routeSubmit(routed);
  }

  private async routeSubmit(routed: Routed): Promise<InboundResult> {
    const { message, origin } = routed;
    if (message.agent && this.deps.graph.agentAvailability(message.agent) !== "enabled") {
      return this.finish(origin.channel, { status: "unavailable", reply: NOT_AVAILABLE_REPLY }, "agent_not_enabled");
    }
    // A retry whose earlier attempt already reached the graph reuses that run; otherwise the
    // graph's idempotency key dedupes a submit whose runId never got attached.
    const runId =
      routed.inbound.graphRunId ??
      (await this.deps.graph.submit(
        { prompt: message.text, ...(message.agent ? { domain: message.agent } : {}) },
        { userId: origin.userId, conversationId: origin.conversationId, idempotencyKey: eventKey(origin.channel, message.idempotencyKey) },
      ));
    await this.deps.repo.attachRun(routed.inbound.id, runId);
    const event: OutboundEvent = { type: "run_accepted", runId };
    await this.fanOut(origin, await this.appendOutbound(origin, event), event);
    return this.finish(origin.channel, { status: "accepted", runId });
  }

  private async routeDecision(routed: Routed, action: Extract<InboundAction, { kind: "decision" }>): Promise<InboundResult> {
    const { origin } = routed;
    const decision = await this.deps.repo.getDecision(action.decisionId);
    if (!decision) return this.refuse(origin.channel, "decision_unknown");
    if (!(await this.ownsRun(origin.userId, decision.graphRunId))) return this.refuse(origin.channel, "not_owner");
    const choice = resolveChoice(decision, action.choice);
    if (!choice) return this.refuse(origin.channel, "invalid_choice");
    // Pending -> promote: the resolution is committed only after the graph accepts it.
    const pendingKey = eventKey(origin.channel, routed.message.idempotencyKey);
    const claim = await this.deps.repo.claimDecision(decision.id, pendingKey);
    if (claim === "resolved") return this.refuse(origin.channel, "already_resolved");
    if (claim === "busy") return this.refuse(origin.channel, "decision_in_progress");
    let accepted: Awaited<ReturnType<DesignGraph["resolveDecision"]>>;
    try {
      accepted = await this.deps.graph.resolveDecision(decision.graphRunId, decision.id, choice.answer);
    } catch (error) {
      await this.deps.repo.releaseDecision(decision.id, pendingKey);
      throw error;
    }
    if ("reason" in accepted) {
      await this.deps.repo.releaseDecision(decision.id, pendingKey);
      return this.refuse(origin.channel, `graph_${accepted.reason}`);
    }
    await this.deps.repo.resolveDecision(decision.id, pendingKey, {
      ...choice.row,
      resolvedBy: origin.userId,
      resolvedAt: this.deps.now().toISOString(),
    });
    await this.deps.repo.attachRun(routed.inbound.id, decision.graphRunId);
    return this.finish(origin.channel, { status: "accepted", runId: decision.graphRunId });
  }

  private async routeControl(routed: Routed, action: Extract<InboundAction, { kind: "control" }>): Promise<InboundResult> {
    const { origin, message } = routed;
    if (!(await this.ownsRun(origin.userId, action.runId))) return this.refuse(origin.channel, "not_owner");
    if (!SLICE_ONE_CONTROLS.has(action.command)) {
      return this.finish(origin.channel, { status: "unavailable", reply: NOT_AVAILABLE_REPLY }, "control_not_enabled");
    }
    // Pending -> promote: the row is `pending` until the graph accepts the command. A retry of the
    // same event finds it still pending and re-sends; the graph dedupes on the idempotency key.
    const inserted = await this.deps.repo.insertControlCommand({
      id: `${action.runId}:${message.idempotencyKey}`,
      graphRunId: action.runId,
      kind: action.command,
      payload: null,
      actorUserId: origin.userId,
      idempotencyKey: message.idempotencyKey,
      status: "pending",
      appliedAtCheckpoint: null,
    });
    if (!inserted && (await this.deps.repo.getControlCommand(action.runId, message.idempotencyKey))?.status !== "pending") {
      return this.finish(origin.channel, { status: "duplicate" });
    }
    const applied = await this.deps.graph.control(action.runId, { kind: action.command, idempotencyKey: message.idempotencyKey, actor: origin.userId });
    if ("reason" in applied) {
      await this.deps.repo.setControlCommandStatus(action.runId, message.idempotencyKey, "rejected");
      return this.finish(origin.channel, { status: "unavailable", reply: NOT_AVAILABLE_REPLY }, `control_${applied.reason}`);
    }
    await this.deps.repo.setControlCommandStatus(action.runId, message.idempotencyKey, "queued");
    return this.finish(origin.channel, { status: "accepted", runId: action.runId });
  }

  private async ownsRun(userId: UserId, runId: string): Promise<boolean> {
    const owner = await this.deps.repo.findRunOrigin(runId);
    return owner?.userId === userId;
  }

  private appendOutbound(origin: RunOrigin, event: OutboundEvent): Promise<MessageRow> {
    return this.deps.repo.appendMessage({
      conversationId: origin.conversationId,
      direction: "out",
      channel: origin.channel,
      kind: event.type,
      body: event,
      graphRunId: event.runId,
      dedupeKey: `out:${event.runId}:${event.type === "run_accepted" ? "accepted" : event.seq}`,
    });
  }

  private async fanOut(origin: RunOrigin, message: MessageRow, event: OutboundEvent): Promise<void> {
    for (const channel of new Set([WEB_CHANNEL, origin.channel])) {
      await this.deliverTo(channel, origin.userId, message, event);
    }
  }

  private async deliverTo(channel: ChannelId, userId: UserId, message: MessageRow, event: OutboundEvent): Promise<void> {
    const adapter = this.deps.channels.get(channel);
    if (!adapter || !this.routable(adapter) || !(await this.enabledSettings(channel))) {
      this.deps.log({ channel, outcome: "outbound_suppressed" });
      return;
    }
    const identity = channel === WEB_CHANNEL ? null : await this.deps.repo.findIdentityForUser(userId, channel);
    if (channel !== WEB_CHANNEL && !identity?.address) {
      this.deps.log({ channel, outcome: "outbound_unaddressable" });
      return;
    }
    const user = { userId, externalIdHash: identity?.externalIdHash ?? null, address: identity?.address ?? null };
    const rendered = renderEvent(event, adapter.capabilities, this.deps.webBaseUrl);
    const outcome = await deliver(this.deps.repo, adapter, user, message.id, rendered, this.deps.delivery);
    this.deps.log({ channel, outcome: `outbound_${outcome}` });
  }

  private externalIdHash(channel: ChannelId, externalUserId: string): string {
    return this.deps.hash(`${channel}:${externalUserId}`);
  }

  private refuse(channel: ChannelId, reason: string): InboundResult {
    return this.finish(channel, { status: "refused", reason, reply: REFUSED_REPLY }, reason);
  }

  private finish(channel: ChannelId, result: InboundResult, reason?: string): InboundResult {
    const code = reason ?? ("reason" in result ? result.reason : undefined);
    this.deps.log(code ? { channel, outcome: result.status, reason: code } : { channel, outcome: result.status });
    return result;
  }
}

const eventKey = (channel: ChannelId, idempotencyKey: string) => `${channel}:${idempotencyKey}`;

type ResolvedChoice = {
  readonly answer: GraphDecisionAnswer;
  readonly row: Pick<DecisionRow, "resolution" | "chosen" | "rationale">;
};

/** A skip records the best guess with a rationale now; the graph's decision_resolved event refines it. */
function resolveChoice(decision: DecisionRow, choice: string | null): ResolvedChoice | null {
  if (choice === null || choice.toLowerCase() === SKIP_CHOICE) {
    const rationale = `User skipped; proceeding with best guess "${decision.bestGuess}".`;
    return { answer: { kind: "skip" }, row: { resolution: "skipped_best_guess", chosen: decision.bestGuess, rationale } };
  }
  const byIndex = /^\d+$/.test(choice) ? decision.options[Number(choice) - 1] : undefined;
  const option = byIndex ?? decision.options.find((candidate) => candidate === choice);
  if (!option) return null;
  return { answer: { kind: "choose", choice: option }, row: { resolution: "chosen", chosen: option, rationale: `User chose "${option}".` } };
}

function decisionOutcome(event: Extract<GraphEvent, { type: "decision_resolved" }>): Pick<DecisionRow, "resolution" | "chosen" | "rationale" | "resolvedAt"> {
  const resolution = event.outcome === "chosen" ? "chosen" : event.cause === "timeout" ? "timeout_best_guess" : "skipped_best_guess";
  return { resolution, chosen: event.choice, rationale: event.rationale, resolvedAt: new Date(event.at).toISOString() };
}

function decisionRow(event: Extract<GraphEvent, { type: "decision_requested" }>, messageId: string): DecisionRow {
  return {
    id: event.decisionId,
    messageId,
    graphRunId: event.runId,
    graphNode: event.nodeId,
    options: event.options,
    bestGuess: event.bestGuess,
    resolution: null,
    chosen: null,
    rationale: null,
    resolvedBy: null,
    resolvedAt: null,
    pendingKey: null,
  };
}
