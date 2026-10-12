import { BILLING_TIERS, BILLING_USAGE_POLICY, type CatalogTier } from "@/lib/billing-catalog";
import { isBillingTierCatalogUiEnabled } from "@/lib/billing-flags";

const TIER_ORDER: ReadonlyArray<{ name: string; tier: CatalogTier }> = [
  { name: "Free", tier: "free" },
  { name: "Pro", tier: "pro" },
  { name: "Team", tier: "team" },
  { name: "Founding Team", tier: "founding_team" },
  { name: "Jarvis", tier: "jarvis" },
];

function dollars(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US", {
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  })}`;
}

function priceLabel(tier: CatalogTier): string {
  const limits = BILLING_TIERS[tier];
  if (limits.priceCentsPerMonth === 0) {
    return "Free";
  }
  const extraSeat = limits.extraSeatCentsPerMonth === null
    ? ""
    : `, +${dollars(limits.extraSeatCentsPerMonth)}/seat`;
  return `${dollars(limits.priceCentsPerMonth)}/mo${extraSeat}`;
}

function capsLabel(tier: CatalogTier): string {
  const limits = BILLING_TIERS[tier];
  const seats = `${limits.seatsIncluded} ${limits.seatsIncluded === 1 ? "seat" : "seats"} included`;
  if (limits.modelSpendCapCentsPerSeat !== null) {
    return `${dollars(limits.modelSpendCapCentsPerSeat)} model usage cap per seat. Separate product.`;
  }
  if (limits.manualRunsPerMonth !== null) {
    return `${seats}. ${limits.manualRunsPerMonth} manual runs per month. No automation.`;
  }
  const pooled = limits.pooledRuns ? " pooled" : "";
  const parts = [
    `${seats}.`,
    `${limits.successfulRunsPerMonth}${pooled} successful runs and ${limits.providerAttemptsPerMonth} provider attempts per month.`,
  ];
  if (limits.maxTeams !== null) {
    parts.push(`At most ${limits.maxTeams} teams. Rate held ${limits.rateHoldMonths} months.`);
  }
  if (limits.chargeAfterFirstSourcingSuccess) {
    parts.push("Charged only after the first real sourcing success.");
  }
  return parts.join(" ");
}

type BillingTierCatalogProps = Readonly<{
  selfServiceEnabled?: string;
  tierCatalogEnabled?: string;
}>;

export function BillingTierCatalog({
  selfServiceEnabled,
  tierCatalogEnabled,
}: BillingTierCatalogProps) {
  if (!isBillingTierCatalogUiEnabled(selfServiceEnabled, tierCatalogEnabled)) {
    return null;
  }

  return (
    <section aria-label="Subscription tiers" className="space-y-3">
      <p className="text-sm leading-6 text-foreground/80">
        Billed monthly. No overage: we notify you at {BILLING_USAGE_POLICY.notifyAtPercent}% and
        pause automation at {BILLING_USAGE_POLICY.pauseAutomationAtPercent}%. Failed runs and
        provider outages do not count.
      </p>
      <ul className="space-y-3">
        {TIER_ORDER.map(({ name, tier }) => (
          <li key={tier} className="rounded border border-border bg-accent p-4">
            <h3 className="text-[16px] font-medium text-foreground">{name}</h3>
            <p className="mt-1 font-mono text-sm text-foreground">{priceLabel(tier)}</p>
            <p className="mt-2 text-sm leading-6 text-foreground/80">{capsLabel(tier)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
