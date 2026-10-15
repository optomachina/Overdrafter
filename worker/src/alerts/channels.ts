import type { AlertChannel, AlertChannelName, SessionAlert } from "./types";

/** Records what would be sent. Slice 1 makes no network calls. */
function stubChannel(name: Exclude<AlertChannelName, "dashboard">): AlertChannel & { readonly sent: SessionAlert[] } {
  const sent: SessionAlert[] = [];
  return {
    name,
    sent,
    async send(alert) {
      sent.push(alert);
    },
  };
}

export const createEmailChannel = () => stubChannel("email");
export const createSlackChannel = () => stubChannel("slack");
export const createSmsChannel = () => stubChannel("sms");

/** In-memory event log, shaped so a later slice can project it into the dashboard. */
export function createDashboardChannel(): AlertChannel & { readonly events: SessionAlert[] } {
  const events: SessionAlert[] = [];
  return {
    name: "dashboard",
    events,
    async send(alert) {
      events.push(alert);
    },
  };
}

export const ALERT_CHANNEL_ENV_FLAGS: Record<AlertChannelName, string> = {
  email: "ALERT_CHANNEL_EMAIL_ENABLED",
  slack: "ALERT_CHANNEL_SLACK_ENABLED",
  sms: "ALERT_CHANNEL_SMS_ENABLED",
  dashboard: "ALERT_CHANNEL_DASHBOARD_ENABLED",
};

const DEFAULT_ENABLED: Record<AlertChannelName, boolean> = { email: false, slack: false, sms: false, dashboard: true };

/** Only "true"/"1" enable and "false"/"0" disable; anything else keeps the default. */
export function enabledAlertChannels(env: Readonly<Record<string, string | undefined>>): AlertChannelName[] {
  return (Object.keys(ALERT_CHANNEL_ENV_FLAGS) as AlertChannelName[]).filter((name) => {
    const raw = env[ALERT_CHANNEL_ENV_FLAGS[name]]?.trim().toLowerCase();
    if (raw === "true" || raw === "1") return true;
    if (raw === "false" || raw === "0") return false;
    return DEFAULT_ENABLED[name];
  });
}
