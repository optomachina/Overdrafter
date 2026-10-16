// Core Jarvis channel contracts (OVD-798). Channels only translate transport; every
// decision about routing, access and work lives in the ConversationService.

export type ChannelId = string;
export type UserId = string;
export type AccessTier = "owner" | "beta" | "paid";
export type DomainAgentId = "cad" | "optics" | "electronics" | "analysis";
export type ControlKind = "pause" | "resume" | "cancel" | "steer";

export const WEB_CHANNEL: ChannelId = "web";

export type ChannelCapabilities = {
  readonly buttons: boolean;
  readonly images: boolean;
  readonly model3d: boolean;
  readonly maxText: number;
};

export type InboundAction =
  | { readonly kind: "decision"; readonly decisionId: string; readonly choice: string | null }
  | { readonly kind: "control"; readonly runId: string; readonly command: ControlKind };

export type InboundMessage = {
  readonly channel: ChannelId;
  readonly externalUserId: string;
  readonly text: string;
  readonly agent?: DomainAgentId;
  readonly action?: InboundAction;
  readonly idempotencyKey: string;
  readonly receivedAt: string;
};

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export type ReplyButton = { readonly id: string; readonly label: string };

/** What an adapter receives: already shaped for its capabilities. */
export type RenderedMessage = {
  readonly text: string;
  readonly buttons?: readonly ReplyButton[];
  readonly model3dUrl?: string;
  readonly link?: string;
};

/** Address for an outbound send. External ids are only ever known by hash. */
export type UserRef = { readonly userId: UserId; readonly externalIdHash: string | null };

export type DeliveryResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface ChannelAdapter {
  readonly id: ChannelId;
  /** Test-only adapters route in the test environment only, regardless of the UI flag. */
  readonly testOnly?: boolean;
  readonly capabilities: ChannelCapabilities;
  verifyInbound(request: unknown): Promise<VerifyResult>;
  normalizeInbound(request: unknown): InboundMessage;
  send(user: UserRef, message: RenderedMessage, deliveryKey: string): Promise<DeliveryResult>;
}

export type DecisionOption = { readonly id: string; readonly label: string };

export type GraphEvent =
  | { readonly type: "run_accepted"; readonly runId: string }
  | {
      readonly type: "decision_requested";
      readonly runId: string;
      readonly decisionId: string;
      readonly nodeId: string;
      readonly question: string;
      readonly options: readonly DecisionOption[];
      readonly recommended?: string;
      readonly bestGuess: string;
    }
  | {
      readonly type: "decision_resolved";
      readonly runId: string;
      readonly decisionId: string;
      readonly resolution: DecisionResolution;
      readonly chosen: string;
    }
  | { readonly type: "artifact"; readonly runId: string; readonly format: "glb" | "usdz" | "step" | "png"; readonly url: string }
  | { readonly type: "status"; readonly runId: string; readonly text: string }
  | { readonly type: "notice"; readonly text: string };

export type DecisionResolution = "chosen" | "skipped_best_guess" | "timeout_best_guess";

export type GraphSubmission = {
  readonly userId: UserId;
  readonly conversationId: string;
  readonly text: string;
  readonly agent?: DomainAgentId;
  readonly idempotencyKey: string;
};

export type GraphDecisionResolution = {
  readonly runId: string;
  readonly decisionId: string;
  readonly resolution: DecisionResolution;
  readonly chosen: string;
  readonly actorUserId: UserId;
};

export type GraphControlCommand = {
  readonly kind: ControlKind;
  readonly payload?: unknown;
  readonly idempotencyKey: string;
  readonly actor: UserId;
};

/** The only exit to work. OVD-801 supplies the real graph; workers sit behind it. */
export interface DesignGraph {
  submit(submission: GraphSubmission): Promise<{ readonly runId: string }>;
  resolveDecision(resolution: GraphDecisionResolution): Promise<void>;
  control(runId: string, command: GraphControlCommand): Promise<void>;
}
