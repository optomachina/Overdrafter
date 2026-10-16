import type { JarvisRepo } from "./repo";
import type { ChannelAdapter, RenderedMessage, UserRef } from "./types";

export type DeliveryPolicy = {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
};

export type DeliveryOutcome = "sent" | "failed" | "duplicate";

async function attemptSend(adapter: ChannelAdapter, user: UserRef, message: RenderedMessage, deliveryKey: string) {
  try {
    return (await adapter.send(user, message, deliveryKey)).ok;
  } catch {
    return false;
  }
}

/**
 * Sends one message to one channel at most once: the (message_id, channel) claim stops
 * a second delivery, and the delivery key lets the channel dedupe an ambiguous retry.
 * Failures back off exponentially and the row is marked failed after maxAttempts.
 */
export async function deliver(
  repo: JarvisRepo,
  adapter: ChannelAdapter,
  user: UserRef,
  messageId: string,
  message: RenderedMessage,
  policy: DeliveryPolicy,
): Promise<DeliveryOutcome> {
  if (!(await repo.claimDelivery(messageId, adapter.id))) return "duplicate";
  const deliveryKey = `${messageId}:${adapter.id}`;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    if (await attemptSend(adapter, user, message, deliveryKey)) {
      await repo.updateDelivery(messageId, adapter.id, { status: "sent", attempts: attempt });
      return "sent";
    }
    await repo.updateDelivery(messageId, adapter.id, { status: "pending", attempts: attempt });
    if (attempt < policy.maxAttempts) await policy.sleep(policy.baseDelayMs * 2 ** (attempt - 1));
  }
  await repo.updateDelivery(messageId, adapter.id, { status: "failed", attempts: policy.maxAttempts });
  return "failed";
}
