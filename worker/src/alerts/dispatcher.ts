import type { SessionHealthRecord } from "../providerSessionHealth";
import type { AlertChannel, SessionAlert } from "./types";

/** Sends one alert per provider state change to every channel; unchanged state is silent. */
export function createSessionAlertDispatcher(channels: readonly AlertChannel[]) {
  const lastState = new Map<string, SessionHealthRecord["state"]>();
  return {
    async observe(record: SessionHealthRecord): Promise<SessionAlert | null> {
      const from = lastState.get(record.provider) ?? null;
      if (from === record.state) return null;
      lastState.set(record.provider, record.state);
      // First observation of a healthy provider is not news.
      if (from === null && record.state === "authenticated") return null;
      const alert: SessionAlert = {
        provider: record.provider,
        from,
        to: record.state,
        reason: record.reason,
        at: record.checkedAt,
      };
      await Promise.allSettled(channels.map((channel) => channel.send(alert)));
      return alert;
    },
  };
}
