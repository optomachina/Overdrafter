export const ACCOUNT_SETTINGS_REQUEST_EVENT = "overdrafter:open-account-settings";

/** Asks the mounted WorkspaceAccountMenu to open its Settings panel. */
export function requestAccountSettingsPanel(): void {
  window.dispatchEvent(new Event(ACCOUNT_SETTINGS_REQUEST_EVENT));
}
