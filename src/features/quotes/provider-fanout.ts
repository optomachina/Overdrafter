import type { VendorName } from "@/integrations/supabase/types";
import { PROVIDER_CATALOG } from "@/features/quotes/generated/provider-catalog";

/**
 * Multi provider fan out: one customer confirmation issues one generic
 * dispatch request per applicable provider. Off by default; with the flag off
 * the confirmation flow sends only to the configured live dispatch provider,
 * exactly as before.
 *
 * The client plan is a filter, never an authority. The server still denies any
 * provider without an approved admission, an active reviewed envelope, an
 * applicable vendor row, and an admitted process (OVD-458/459), and the worker
 * execution seam still denies kill switched, export blocked, and capped work
 * (provider_disabled, export_control_blocked, provider_daily_cap_reached).
 */

export function resolveMultiProviderFanoutEnabled(rawValue: string | undefined | null): boolean {
  return rawValue?.trim().toLowerCase() === "true";
}

export function getConfiguredMultiProviderFanoutEnabled(): boolean {
  return resolveMultiProviderFanoutEnabled(import.meta.env.VITE_MULTI_PROVIDER_FANOUT as string | undefined);
}

/**
 * Providers the client plan never sends to, whatever the guards say: Weerg is
 * blocked and Geomiq moved to the 1.1 release. The server still refuses them
 * on its own; this keeps them out of the customer's disclosure too.
 */
export const FANOUT_EXCLUDED_PROVIDERS: ReadonlySet<VendorName> = new Set<VendorName>(["weerg", "geomiq"]);

export type FanoutProcessClass = "cnc" | "sheet_metal";

/**
 * Processes each provider can quote through its adapter. The generated catalog
 * declares a single process family and leaves several providers "unknown", so
 * this map is the reviewed source; a provider missing here is never eligible.
 * Guidance only providers have no dispatch path and stay empty.
 */
export const PROVIDER_PROCESS_CAPABILITIES: Readonly<Record<VendorName, readonly FanoutProcessClass[]>> = {
  xometry: ["cnc", "sheet_metal"],
  fictiv: ["cnc"],
  protolabs: ["cnc"],
  sendcutsend: ["sheet_metal"],
  oshcut: ["sheet_metal"],
  fabworks: ["sheet_metal"],
  rmfg: ["sheet_metal"],
  ponoko: ["sheet_metal"],
  geomiq: ["cnc", "sheet_metal"],
  rapiddirect: ["cnc", "sheet_metal"],
  protolabsnetwork: ["cnc", "sheet_metal"],
  quickparts: ["cnc"],
  weerg: ["cnc"],
  emachineshop: ["cnc", "sheet_metal"],
  partsbadger: [],
  fastdms: [],
  devzmanufacturing: [],
  infraredlaboratories: [],
};

/**
 * Providers based in the United States. Every other provider, including one
 * missing from this list, is treated as foreign and needs a clean export
 * declaration (OVD-723 rule export_foreign_provider_requires_clean_declaration).
 */
const DOMESTIC_PROVIDERS: ReadonlySet<VendorName> = new Set<VendorName>([
  "xometry",
  "fictiv",
  "protolabs",
  "sendcutsend",
  "oshcut",
  "fabworks",
  "rmfg",
  "ponoko",
  "quickparts",
  "emachineshop",
  "partsbadger",
  "fastdms",
  "devzmanufacturing",
  "infraredlaboratories",
]);

export function isForeignProvider(provider: VendorName): boolean {
  return !DOMESTIC_PROVIDERS.has(provider);
}

/** Classifies the approved process text. Anything ambiguous returns null and sends nowhere extra. */
export function classifyFanoutProcess(process: string | null | undefined): FanoutProcessClass | null {
  const normalized = process?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  const sheet = /sheet|laser|waterjet|bend|brak|punch|fabricat/.test(normalized);
  const cnc = /cnc|mill|turn|lathe|machin/.test(normalized);
  if (sheet === cnc) return null;
  return sheet ? "sheet_metal" : "cnc";
}

export function getProviderDisplayName(provider: VendorName): string {
  return PROVIDER_CATALOG[provider]?.displayName ?? provider;
}

/**
 * Runtime guard state for the org and job. Supplied by
 * api_get_provider_fanout_guards (drafted under docs/migration-drafts). The
 * kill switch rows come from OVD-722 and the declaration from OVD-723; until
 * both land the RPC is absent and the plan falls back to the primary provider.
 */
export type ProviderFanoutGuards = {
  killSwitchedProviders: readonly VendorName[];
  exportDeclaration: "clean" | "not_clean";
  /** Providers at their admin-set daily quote cap; uncapped providers never appear. The RPC exposes no counts. */
  providersAtDailyCap: readonly VendorName[];
  /** The caller's quote request guardrail, or null when the org has it off. */
  quoteRequestBudget: QuoteRequestBudget | null;
};

/**
 * Per user quote request guardrail (quote_request_guardrails): by default 5
 * requests per user per 60 minutes, and a $500 pending ceiling per org at $75
 * per requested lane. Every provider request creates one request and one lane,
 * so extras past either limit would be refused by the server.
 */
export type QuoteRequestBudget = {
  userWindowMinutes: number;
  userMaxRequestsPerWindow: number;
  userRequestsRemaining: number;
  orgPendingCostCeilingUsd: number;
  costPerLaneUsd: number;
  orgPendingCostHeadroomUsd: number;
};

export type ProviderFanoutSkipReason =
  | "kill_switch"
  | "process_ineligible"
  | "export_control"
  | "daily_cap"
  | "guards_unavailable"
  | "not_admitted"
  | "not_offered"
  | "user_rate_limit"
  | "cost_ceiling"
  | "scope_changed";

export type ProviderFanoutPlan = {
  send: VendorName[];
  skipped: { provider: VendorName; reason: ProviderFanoutSkipReason }[];
  budget: QuoteRequestBudget | null;
};

export const PROVIDER_FANOUT_SKIP_REASON_COPY: Readonly<Record<ProviderFanoutSkipReason, string>> = {
  kill_switch: "Switched off by OverDrafter right now.",
  process_ineligible: "Does not quote this part's process.",
  export_control: "Foreign provider; needs a clean export declaration.",
  daily_cap: "Daily quote limit reached for this provider.",
  guards_unavailable: "Safety checks could not be loaded, so only the primary provider is used.",
  not_admitted: "Not admitted for this part or organization.",
  not_offered: "Not offered for automatic quotes yet.",
  user_rate_limit: "Over your quote request limit for now.",
  cost_ceiling: "Over your workspace's pending quote budget.",
  scope_changed: "The package changed after you reviewed it, so it was not sent.",
};

function formatUsd(value: number): string {
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}

/** Customer copy for a skip, with the guardrail numbers when they apply. */
export function describeFanoutSkipReason(reason: ProviderFanoutSkipReason, budget: QuoteRequestBudget | null): string {
  if (reason === "user_rate_limit" && budget) {
    return `You can send ${budget.userMaxRequestsPerWindow} quote requests every ${budget.userWindowMinutes} minutes, and this one would go over that limit.`;
  }
  if (reason === "cost_ceiling" && budget) {
    return `Each request holds about ${formatUsd(budget.costPerLaneUsd)} against your workspace's ${formatUsd(budget.orgPendingCostCeilingUsd)} pending quote ceiling, and this one would go over it.`;
  }
  return PROVIDER_FANOUT_SKIP_REASON_COPY[reason];
}

/**
 * Chooses which providers one confirmation reaches. `primary` is the provider
 * whose scope the customer reviewed; it always leads `send` when it is
 * eligible. `candidates` are the providers enabled for the org and selected for
 * this job. Without guards only the primary is sent, which is today's behavior.
 */
export function planProviderFanout(input: {
  primary: VendorName;
  candidates: readonly VendorName[];
  process: string | null | undefined;
  guards: ProviderFanoutGuards | null;
}): ProviderFanoutPlan {
  const ordered = [input.primary, ...input.candidates.filter((provider) => provider !== input.primary)];
  const unique = [...new Set(ordered)];
  const processClass = classifyFanoutProcess(input.process);
  const budget = input.guards?.quoteRequestBudget ?? null;
  const plan: ProviderFanoutPlan = { send: [], skipped: [], budget };
  let requestsLeft = budget?.userRequestsRemaining ?? Number.POSITIVE_INFINITY;
  let headroomUsd = budget?.orgPendingCostHeadroomUsd ?? Number.POSITIVE_INFINITY;

  for (const provider of unique) {
    const reason = getSkipReason(provider) ?? getBudgetSkipReason(provider);
    if (reason) {
      plan.skipped.push({ provider, reason });
    } else {
      plan.send.push(provider);
    }
  }
  return plan;

  /**
   * Spends the guardrail in send order. The primary always keeps its place, as
   * today, and the server stays the authority on its own request.
   */
  function getBudgetSkipReason(provider: VendorName): ProviderFanoutSkipReason | null {
    const cost = budget?.costPerLaneUsd ?? 0;
    if (provider !== input.primary) {
      if (requestsLeft < 1) return "user_rate_limit";
      if (headroomUsd < cost) return "cost_ceiling";
    }
    requestsLeft -= 1;
    headroomUsd -= cost;
    return null;
  }

  function getSkipReason(provider: VendorName): ProviderFanoutSkipReason | null {
    const guards = input.guards;
    if (provider !== input.primary && FANOUT_EXCLUDED_PROVIDERS.has(provider)) return "not_offered";
    if (!guards) {
      return provider === input.primary ? null : "guards_unavailable";
    }
    if (guards.killSwitchedProviders.includes(provider)) return "kill_switch";
    // An unclassified process never widens the send set; the primary then keeps
    // today's server side process check alone.
    const supportsProcess = processClass !== null && PROVIDER_PROCESS_CAPABILITIES[provider]?.includes(processClass);
    if (!supportsProcess && (provider !== input.primary || processClass !== null)) {
      return "process_ineligible";
    }
    if (isForeignProvider(provider) && guards.exportDeclaration !== "clean") return "export_control";
    if (guards.providersAtDailyCap.includes(provider)) return "daily_cap";
    return null;
  }
}

export type ProviderFanoutOutcome =
  | { provider: VendorName; status: "pending" }
  | { provider: VendorName; status: "queued"; created: boolean }
  | { provider: VendorName; status: "denied" | "unknown"; skipReason?: ProviderFanoutSkipReason };

/**
 * Worker guard codes (providerExecutionSeam) that map to a plan skip reason.
 * OVD-722: the permit insert trigger refuses a switched off provider with
 * provider_kill_switch_engaged, so that code reads as the kill switch too.
 */
const GUARD_DENIAL_SKIP_REASONS: readonly [RegExp, ProviderFanoutSkipReason][] = [
  [/\b(?:provider_disabled|provider_kill_switch_engaged)\b/, "kill_switch"],
  [/\bexport_control_blocked\b/, "export_control"],
  [/\bprovider_daily_cap_reached\b/, "daily_cap"],
  [/\bprovider_dispatch_(?:admission_disabled|admission_evidence_missing|admission_expired|provider_not_enabled|provider_unknown|provider_applicability_required|process_not_admitted|provider_envelope_unknown)\b/, "not_admitted"],
];

/**
 * Refusals that mean the package changed after the customer reviewed it, from
 * either admission path. After one of these on the primary, no extra is sent.
 */
const SCOPE_CHANGE_DENIAL =
  /\b(?:xometry_beta_(?:scope_changed|exact_scope_required|notice_changed)|provider_dispatch_(?:scope_mismatch|exact_scope_required|notice_mismatch|envelope_mismatch))\b/;

function getErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : (error as { message?: unknown } | null)?.message;
  return typeof raw === "string" ? raw : "";
}

export function isDispatchScopeChangeDenial(error: unknown): boolean {
  return SCOPE_CHANGE_DENIAL.test(getErrorMessage(error));
}

export function getFanoutDenialSkipReason(error: unknown): ProviderFanoutSkipReason | undefined {
  const message = getErrorMessage(error);
  if (SCOPE_CHANGE_DENIAL.test(message)) return "scope_changed";
  return GUARD_DENIAL_SKIP_REASONS.find(([pattern]) => pattern.test(message))?.[1];
}

/**
 * Dispatches to each provider in order, one at a time: the generic admission
 * takes job row locks without waiting, so parallel requests for one job would
 * refuse each other as busy. A failure is reported for its provider and never
 * stops the rest. `onOutcome` fires as each provider settles.
 */
export async function runProviderFanout(input: {
  providers: readonly VendorName[];
  dispatch: (provider: VendorName) => Promise<{ created: boolean }>;
  classifyFailure: (error: unknown) => "denied" | "unknown";
  onOutcome: (outcome: ProviderFanoutOutcome) => void;
}): Promise<ProviderFanoutOutcome[]> {
  const outcomes: ProviderFanoutOutcome[] = [];
  for (const provider of input.providers) {
    input.onOutcome({ provider, status: "pending" });
    let outcome: ProviderFanoutOutcome;
    try {
      const result = await input.dispatch(provider);
      outcome = { provider, status: "queued", created: result.created };
    } catch (error) {
      let status: "denied" | "unknown" = "unknown";
      try {
        status = input.classifyFailure(error);
      } catch {
        status = "unknown";
      }
      outcome = { provider, status, skipReason: getFanoutDenialSkipReason(error) };
    }
    outcomes.push(outcome);
    input.onOutcome(outcome);
  }
  return outcomes;
}
