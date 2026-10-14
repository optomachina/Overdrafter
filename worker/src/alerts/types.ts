import type { SessionHealthRecord } from "../providerSessionHealth";

export type AlertChannelName = "email" | "slack" | "sms" | "dashboard";

export type SessionAlert = {
  provider: SessionHealthRecord["provider"];
  from: SessionHealthRecord["state"] | null;
  to: SessionHealthRecord["state"];
  reason: string;
  at: string;
};

export interface AlertChannel {
  readonly name: AlertChannelName;
  send(alert: SessionAlert): Promise<void>;
}
