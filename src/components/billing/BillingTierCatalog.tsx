import { BILLING_CATALOG_PRICES } from "@/lib/billing-catalog";
import { isBillingTierCatalogUiEnabled } from "@/lib/billing-flags";

const TIER_COPY = [
  {
    description: "Monthly and annual. One seat. Amount pending council approval.",
    name: "Pro",
    seats: "1 seat",
    term: "Monthly or annual",
    tier: "pro",
  },
  {
    description:
      "Monthly and annual. Included seats plus metered extra seats. Amounts pending council approval.",
    name: "Team",
    seats: "Included seats + extra seat price",
    term: "Monthly or annual",
    tier: "team",
  },
  {
    description:
      "Locked 12-month term. At most 12 teams. Not listed publicly. Amount pending council approval.",
    name: "Founding Team",
    seats: "Team entitlements plus founding badge",
    term: "12-month lock",
    tier: "founding_team",
  },
] as const;

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
        Prices stay TBD until Blaine approves them. Free remains on the existing quote meter.
      </p>
      <ul className="space-y-3">
        {TIER_COPY.map((tier) => {
          const prices = BILLING_CATALOG_PRICES.filter((entry) => entry.tier === tier.tier);
          return (
            <li key={tier.tier} className="rounded border border-border bg-accent p-4">
              <h3 className="text-[16px] font-medium text-foreground">{tier.name}</h3>
              <p className="mt-1 font-mono text-sm text-foreground">Price TBD</p>
              <p className="mt-2 text-sm leading-6 text-foreground/80">{tier.description}</p>
              <p className="mt-1 text-xs leading-5 text-foreground/80">
                {tier.seats}. {tier.term}. Lookup keys: {prices.map((entry) => entry.lookupKey).join(", ")}.
              </p>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
