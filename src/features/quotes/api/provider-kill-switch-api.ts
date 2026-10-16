import { isMissingFunctionError } from "./shared/schema-errors";
import { callUntypedRpc } from "./shared/rpc";
import { ensureData } from "./shared/response";

/**
 * OVD-722 provider kill switch (platform admin). The switch is runtime data:
 * the worker and server preflights read it on every dispatch checkpoint, so a
 * flip here stops automated traffic without a deploy. Each flip is audited
 * with the admin's identity and the typed reason.
 *
 * Release is compare and set: it carries the row version the admin was
 * looking at, and the database refuses it if the switch changed since (for
 * example another admin engaged it). Engage never needs a version, so an
 * emergency stop always wins.
 *
 * OVD-829 (OVD-828 S1): each supplier row also carries an optional daily
 * quote cap (null = unlimited, the default; an admin may set a positive cap). Once the list returns it, every per-supplier
 * write goes through `api_admin_set_provider_settings`, which sets the switch
 * and the cap together. Before that migration the list has no cap and the
 * per-supplier switch keeps using `api_admin_set_provider_kill_switch`.
 */

export const PROVIDER_KILL_SWITCH_MIN_REASON_LENGTH = 10;
const LIST_RPC = "api_admin_list_provider_kill_switches";
export const PROVIDER_KILL_SWITCH_VERSION_CONFLICT = "kill_switch_version_conflict";
export const PROVIDER_KILL_SWITCH_STALE_MESSAGE =
  "The kill switch changed since you loaded it. Review the current state, then release again if still intended.";
const SETTINGS_RPC = "api_admin_set_provider_settings";
export const PROVIDER_DAILY_CAP_STALE_MESSAGE =
  "This supplier's settings changed since you loaded them. Review the current cap, then save again if still intended.";

/** OVD-829 per-supplier daily quote cap; absent until the OVD-828 S1 migration is applied. */
export type ProviderDailyCapSettings = {
  /** Null means unlimited. */
  dailyQuoteCap: number | null;
  /** Automated quote dispatches counted so far today (UTC). */
  usedToday: number;
};

export type ProviderKillSwitchRow = {
  provider: string;
  engaged: boolean;
  reason: string | null;
  changedBy: string | null;
  changedAt: string | null;
  /** Row version for compare and set on release; null when unknown. */
  version: number | null;
  /** Present once the database returns the cap (OVD-829). */
  settings?: ProviderDailyCapSettings;
};

export type ProviderKillSwitchState =
  | {
    available: true;
    global: Omit<ProviderKillSwitchRow, "provider" | "settings">;
    providers: ProviderKillSwitchRow[];
  }
  /** The OVD-722 migration is not applied yet; nothing can be read or flipped. */
  | { available: false };

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isDailyQuoteCap(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function parseSettings(row: Record<string, unknown>): ProviderDailyCapSettings | undefined {
  if (!("dailyQuoteCap" in row)) return undefined;
  if (!isDailyQuoteCap(row.dailyQuoteCap)) throw new Error("Provider kill switch state is malformed.");
  const used = row.usedToday;
  return {
    dailyQuoteCap: row.dailyQuoteCap,
    usedToday: typeof used === "number" && Number.isSafeInteger(used) && used >= 0 ? used : 0,
  };
}

function parseRow(value: unknown): Omit<ProviderKillSwitchRow, "provider" | "settings"> & { provider: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider kill switch state is malformed.");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.engaged !== "boolean") throw new Error("Provider kill switch state is malformed.");
  return {
    provider: row.provider,
    engaged: row.engaged,
    reason: nullableString(row.reason),
    changedBy: nullableString(row.changedBy),
    changedAt: nullableString(row.changedAt),
    version: typeof row.version === "number" && Number.isSafeInteger(row.version) && row.version >= 0 ? row.version : null,
  };
}

export function parseProviderKillSwitchList(data: unknown): Extract<ProviderKillSwitchState, { available: true }> {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Provider kill switch state is malformed.");
  }
  const record = data as Record<string, unknown>;
  if (record.schema !== "provider-kill-switch-admin.v1" || !Array.isArray(record.providers)) {
    throw new Error("Provider kill switch state is malformed.");
  }
  // A missing global row is engaged in SQL; show it the same way.
  const global = record.global == null
    ? { engaged: true, reason: null, changedBy: null, changedAt: null, version: null }
    : (({ provider: _provider, ...rest }) => rest)(parseRow(record.global));
  const providers = record.providers.map((entry) => {
    const row = parseRow(entry);
    if (typeof row.provider !== "string") throw new Error("Provider kill switch state is malformed.");
    const settings = parseSettings(entry as Record<string, unknown>);
    return { ...row, provider: row.provider, ...(settings ? { settings } : {}) };
  });
  return { available: true, global, providers };
}

export async function fetchProviderKillSwitches(): Promise<ProviderKillSwitchState> {
  const { data, error } = await callUntypedRpc(LIST_RPC);
  if (error && isMissingFunctionError(error, LIST_RPC)) return { available: false };
  return parseProviderKillSwitchList(ensureData(data, error));
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < PROVIDER_KILL_SWITCH_MIN_REASON_LENGTH) {
    throw new Error(`A reason of at least ${PROVIDER_KILL_SWITCH_MIN_REASON_LENGTH} characters is required.`);
  }
  return trimmed;
}

export function isProviderKillSwitchVersionConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.includes(PROVIDER_KILL_SWITCH_VERSION_CONFLICT);
}

/**
 * `provider: null` flips the global switch that covers every provider. A
 * release must pass the `expectedVersion` of the row the admin decided on.
 * Pass the supplier's current `dailyQuoteCap` (OVD-829) to flip through
 * `api_admin_set_provider_settings`; the cap is kept as it is.
 */
export async function setProviderKillSwitch(input: {
  provider: string | null;
  engaged: boolean;
  reason: string;
  expectedVersion?: number | null;
  dailyQuoteCap?: number | null;
}) {
  const reason = requireReason(input.reason);
  const expectedVersion = input.expectedVersion ?? null;
  if (!input.engaged && expectedVersion === null) {
    throw new Error(PROVIDER_KILL_SWITCH_STALE_MESSAGE);
  }
  // Engage omits the version on purpose: the database lets it win regardless.
  const versionArg = input.engaged ? {} : { p_expected_version: expectedVersion };
  let response;
  if (input.provider === null) {
    response = await callUntypedRpc("api_admin_set_global_kill_switch", { p_engaged: input.engaged, p_reason: reason, ...versionArg });
  } else if (input.dailyQuoteCap !== undefined) {
    // A versionless engage is the emergency stop; the database keeps the current cap.
    response = await callUntypedRpc(SETTINGS_RPC, {
      p_provider: input.provider,
      p_engaged: input.engaged,
      p_daily_quote_cap: input.dailyQuoteCap,
      p_reason: reason,
      ...versionArg,
    });
  } else {
    response = await callUntypedRpc("api_admin_set_provider_kill_switch", {
      p_provider: input.provider,
      p_engaged: input.engaged,
      p_reason: reason,
      ...versionArg,
    });
  }
  const { data, error } = response;
  if (error && isProviderKillSwitchVersionConflict(error)) {
    throw new Error(PROVIDER_KILL_SWITCH_STALE_MESSAGE);
  }
  return ensureData(data, error);
}

/**
 * Sets one supplier's daily quote cap (OVD-829). `dailyQuoteCap: null` means
 * unlimited; otherwise a whole number above 0. The on/off state is sent as the
 * admin saw it, and the write is compare and set on `expectedVersion`.
 */
export async function setProviderSettings(input: {
  provider: string;
  engaged: boolean;
  dailyQuoteCap: number | null;
  reason: string;
  expectedVersion: number | null;
}) {
  const reason = requireReason(input.reason);
  if (!isDailyQuoteCap(input.dailyQuoteCap)) {
    throw new Error("The daily quote cap must be a whole number above 0, or unlimited.");
  }
  if (input.expectedVersion === null) throw new Error(PROVIDER_DAILY_CAP_STALE_MESSAGE);
  const { data, error } = await callUntypedRpc(SETTINGS_RPC, {
    p_provider: input.provider,
    p_engaged: input.engaged,
    p_daily_quote_cap: input.dailyQuoteCap,
    p_reason: reason,
    p_expected_version: input.expectedVersion,
  });
  if (error && isProviderKillSwitchVersionConflict(error)) {
    throw new Error(PROVIDER_DAILY_CAP_STALE_MESSAGE);
  }
  return ensureData(data, error);
}
