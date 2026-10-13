import { CheckCircle2, CircleSlash, Loader2, TriangleAlert } from "lucide-react";
import type { VendorName } from "@/integrations/supabase/types";
import {
  PROVIDER_FANOUT_SKIP_REASON_COPY,
  getProviderDisplayName,
  type ProviderFanoutOutcome,
  type ProviderFanoutPlan,
} from "@/features/quotes/provider-fanout";

type ProviderFanoutStatusProps = Readonly<{
  plan: ProviderFanoutPlan;
  outcomes: Partial<Record<VendorName, ProviderFanoutOutcome>>;
}>;

function describeOutcome(outcome: ProviderFanoutOutcome | undefined): { text: string; tone: "idle" | "busy" | "ok" | "bad" } {
  switch (outcome?.status) {
    case undefined:
      return { text: "Will be sent when you confirm.", tone: "idle" };
    case "pending":
      return { text: "Sending…", tone: "busy" };
    case "queued":
      return { text: outcome.created ? "Quote request queued." : "Quote request already queued.", tone: "ok" };
    case "denied":
      return {
        text: outcome.skipReason ? `Not sent. ${PROVIDER_FANOUT_SKIP_REASON_COPY[outcome.skipReason]}` : "Not queued by OverDrafter.",
        tone: "bad",
      };
    case "unknown":
      return { text: "Status could not be confirmed.", tone: "bad" };
  }
}

/** Which providers one confirmation reaches, which were skipped and why, and each live result. */
export function ProviderFanoutStatus({ plan, outcomes }: ProviderFanoutStatusProps) {
  return (
    <section aria-labelledby="provider-fanout-heading">
      <h3 id="provider-fanout-heading" className="font-mono text-[10px] font-semibold uppercase tracking-[0.1em] text-paper-muted">
        Providers for this request
      </h3>
      <ul className="mt-2 divide-y divide-paper-hairline border-y border-paper-hairline" aria-label="Providers sent">
        {plan.send.map((provider) => {
          const { text, tone } = describeOutcome(outcomes[provider]);
          return (
            <li key={provider} className="flex items-start gap-3 py-3 text-sm" data-provider={provider} data-status={outcomes[provider]?.status ?? "planned"}>
              {tone === "busy" ? (
                <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-paper-muted" aria-hidden="true" />
              ) : tone === "bad" ? (
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-paper-red" aria-hidden="true" />
              ) : (
                <CheckCircle2 className={tone === "ok" ? "mt-0.5 h-4 w-4 shrink-0 text-emerald-700" : "mt-0.5 h-4 w-4 shrink-0 text-paper-muted"} aria-hidden="true" />
              )}
              <span>
                <strong className="block font-semibold text-paper-ink">{getProviderDisplayName(provider)}</strong>
                <span className="block text-paper-muted">{text}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {plan.skipped.length > 0 ? (
        <ul className="mt-2 divide-y divide-paper-hairline border-b border-paper-hairline" aria-label="Providers skipped">
          {plan.skipped.map(({ provider, reason }) => (
            <li key={provider} className="flex items-start gap-3 py-3 text-sm" data-provider={provider} data-status="skipped">
              <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-paper-muted" aria-hidden="true" />
              <span>
                <strong className="block font-semibold text-paper-ink">{getProviderDisplayName(provider)}</strong>
                <span className="block text-paper-muted">Skipped. {PROVIDER_FANOUT_SKIP_REASON_COPY[reason]}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
