import type { ChannelAdapter, ChannelCapabilities, DeliveryResult, InboundAction, InboundMessage, RenderedMessage, UserRef } from "../core/types";

export type TestInboundRequest = {
  readonly secret: string;
  readonly eventId: string;
  readonly externalUserId: string;
  /** Opaque reply address; defaults to `chat-<externalUserId>`. */
  readonly address?: string;
  readonly text?: string;
  readonly agent?: InboundMessage["agent"];
  readonly action?: InboundAction;
  readonly linkCode?: string;
};

export type TestSend = { readonly user: UserRef; readonly message: RenderedMessage; readonly deliveryKey: string };

export type TestAdapterOptions = {
  readonly id?: string;
  readonly testOnly?: boolean;
  readonly secret?: string;
  readonly capabilities?: Partial<ChannelCapabilities>;
  /** Scripted send results; once exhausted every send succeeds. */
  readonly sendResults?: readonly DeliveryResult[];
};

export type TestAdapter = ChannelAdapter & { readonly sent: TestSend[]; readonly attempts: TestSend[] };

export const TEST_ADAPTER_SECRET = "test-adapter-secret";

/** In-process channel for tests. Test-only by default, so it never routes outside the test environment. */
export function createTestAdapter(options: TestAdapterOptions = {}): TestAdapter {
  const secret = options.secret ?? TEST_ADAPTER_SECRET;
  const id = options.id ?? "test";
  const scripted = [...(options.sendResults ?? [])];
  const sent: TestSend[] = [];
  const attempts: TestSend[] = [];
  return {
    id,
    testOnly: options.testOnly ?? true,
    capabilities: { buttons: true, images: true, model3d: true, maxText: 4000, ...options.capabilities },
    sent,
    attempts,
    async verifyInbound(request) {
      const candidate = request as Partial<TestInboundRequest> | null;
      return candidate?.secret === secret ? { ok: true } : { ok: false, reason: "bad_secret" };
    },
    normalizeInbound(request) {
      const inbound = request as TestInboundRequest;
      if (!inbound.eventId || !inbound.externalUserId) throw new Error("malformed test request");
      return {
        channel: id,
        externalUserId: inbound.externalUserId,
        address: inbound.address ?? `chat-${inbound.externalUserId}`,
        text: inbound.text ?? "",
        agent: inbound.agent,
        action: inbound.action,
        linkCode: inbound.linkCode,
        idempotencyKey: inbound.eventId,
        receivedAt: new Date(0).toISOString(),
      };
    },
    async send(user, message, deliveryKey) {
      const record = { user, message, deliveryKey };
      attempts.push(record);
      const result = scripted.shift() ?? { ok: true };
      if (result.ok) sent.push(record);
      return result;
    },
  };
}
