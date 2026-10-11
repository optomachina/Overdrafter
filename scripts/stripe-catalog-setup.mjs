#!/usr/bin/env node
/**
 * Stripe test-mode catalog setup for OVD-725.
 *
 * Never writes keys to files or logs. Refuses sk_live_ / rk_live_ secrets.
 * Amounts stay TBD unless --placeholder is passed in test mode.
 */
import process from "node:process";

export const PLACEHOLDER_AMOUNT_CENTS = 100;
export const BILLING_CATALOG_VERSION = 1;
export const BILLING_CATALOG_CURRENCY = "usd";

export const BILLING_CATALOG_PRICES = [
  {
    amountCents: null,
    interval: "month",
    kind: "plan",
    lookupKey: "od_pro_month_v1",
    nickname: "Pro monthly",
    productName: "OverDrafter Pro",
    seatsIncluded: 1,
    tier: "pro",
  },
  {
    amountCents: null,
    interval: "year",
    kind: "plan",
    lookupKey: "od_pro_year_v1",
    nickname: "Pro annual",
    productName: "OverDrafter Pro",
    seatsIncluded: 1,
    tier: "pro",
  },
  {
    amountCents: null,
    interval: "month",
    kind: "plan",
    lookupKey: "od_team_month_v1",
    nickname: "Team monthly",
    productName: "OverDrafter Team",
    seatsIncluded: null,
    tier: "team",
  },
  {
    amountCents: null,
    interval: "year",
    kind: "plan",
    lookupKey: "od_team_year_v1",
    nickname: "Team annual",
    productName: "OverDrafter Team",
    seatsIncluded: null,
    tier: "team",
  },
  {
    amountCents: null,
    interval: "month",
    kind: "extra_seat",
    lookupKey: "od_team_seat_month_v1",
    nickname: "Team extra seat monthly",
    productName: "OverDrafter Team",
    seatsIncluded: null,
    tier: "team",
  },
  {
    amountCents: null,
    interval: "year",
    kind: "extra_seat",
    lookupKey: "od_team_seat_year_v1",
    nickname: "Team extra seat annual",
    productName: "OverDrafter Team",
    seatsIncluded: null,
    tier: "team",
  },
  {
    amountCents: null,
    interval: "year",
    kind: "plan",
    lookupKey: "od_founding_team_year_v1",
    nickname: "Founding Team 12-month",
    productName: "OverDrafter Founding Team",
    seatsIncluded: null,
    tier: "founding_team",
  },
];

export function isLiveStripeSecret(secret) {
  const value = typeof secret === "string" ? secret.trim() : "";
  return value.startsWith("sk_live_") || value.startsWith("rk_live_");
}

export function assertTestModeSecret(secret) {
  if (!secret || typeof secret !== "string" || secret.trim().length === 0) {
    throw new Error("stripe_catalog_secret_missing");
  }
  if (isLiveStripeSecret(secret)) {
    throw new Error("stripe_catalog_live_key_refused");
  }
  return secret.trim();
}

export function parseSetupArgs(argv) {
  const args = { apply: false, dryRun: false, placeholder: false };
  for (const value of argv) {
    if (value === "--apply") {
      args.apply = true;
    } else if (value === "--dry-run") {
      args.dryRun = true;
    } else if (value === "--placeholder") {
      args.placeholder = true;
    } else if (value === "--live") {
      throw new Error("stripe_catalog_live_mode_refused");
    } else {
      throw new Error(`stripe_catalog_unknown_arg:${value}`);
    }
  }
  if (args.apply === args.dryRun) {
    throw new Error("stripe_catalog_mode_required");
  }
  return args;
}

export function catalogPriceMetadata(entry, placeholder) {
  return {
    od_catalog_version: String(BILLING_CATALOG_VERSION),
    od_interval: entry.interval,
    od_kind: entry.kind,
    od_tier: entry.tier,
    placeholder: placeholder ? "true" : "false",
  };
}

function priceMatchesCatalog(price, entry, amountCents, placeholder) {
  const metadata = price.metadata ?? {};
  const expected = catalogPriceMetadata(entry, placeholder);
  return price.active === true &&
    price.livemode === false &&
    (price.currency ?? "").toLowerCase() === BILLING_CATALOG_CURRENCY &&
    price.unit_amount === amountCents &&
    price.type === "recurring" &&
    price.recurring?.interval === entry.interval &&
    price.recurring?.interval_count === 1 &&
    metadata.od_tier === expected.od_tier &&
    metadata.od_interval === expected.od_interval &&
    metadata.od_catalog_version === expected.od_catalog_version &&
    metadata.placeholder === expected.placeholder;
}

export async function syncStripeCatalog({
  catalog = BILLING_CATALOG_PRICES,
  client,
  dryRun,
  placeholder = false,
}) {
  if (!placeholder && catalog.some((entry) => entry.amountCents == null)) {
    throw new Error("stripe_catalog_amounts_tbd");
  }

  const created = { prices: 0, products: 0 };
  const existing = { prices: 0, products: 0 };
  const drift = [];
  const productIds = new Map();

  for (const entry of catalog) {
    const amountCents = entry.amountCents ?? PLACEHOLDER_AMOUNT_CENTS;
    const metadata = catalogPriceMetadata(entry, placeholder);
    const listed = await client.prices.list({
      lookup_keys: [entry.lookupKey],
      expand: ["data.product"],
      limit: 2,
    });
    const current = listed.data[0];

    if (current) {
      existing.prices += 1;
      const product = current.product;
      if (product && typeof product === "object" && product.id) {
        productIds.set(entry.productName, product.id);
        existing.products += 1;
      }
      if (!priceMatchesCatalog(current, entry, amountCents, placeholder)) {
        drift.push({
          lookupKey: entry.lookupKey,
          reason: "price_drift",
        });
      }
      continue;
    }

    let productId = productIds.get(entry.productName);
    if (!productId) {
      const products = await client.products.search?.({
        query: `name:'${entry.productName}'`,
      }) ?? { data: [] };
      const found = products.data.find((product) => product.name === entry.productName);
      if (found) {
        productId = found.id;
        existing.products += 1;
      } else if (!dryRun) {
        const createdProduct = await client.products.create({
          name: entry.productName,
          metadata: {
            od_catalog_version: String(BILLING_CATALOG_VERSION),
            od_tier: entry.tier,
            placeholder: placeholder ? "true" : "false",
          },
        });
        productId = createdProduct.id;
        created.products += 1;
      } else {
        productId = `prod_dry_run_${entry.tier}`;
        created.products += 1;
      }
      productIds.set(entry.productName, productId);
    }

    if (!dryRun) {
      await client.prices.create({
        currency: BILLING_CATALOG_CURRENCY,
        lookup_key: entry.lookupKey,
        metadata,
        nickname: entry.nickname,
        product: productId,
        recurring: {
          interval: entry.interval,
          interval_count: 1,
        },
        unit_amount: amountCents,
      });
    }
    created.prices += 1;
  }

  return { created, drift, existing, livemode: false };
}

export async function runStripeCatalogSetup(argv, env, options = {}) {
  const args = parseSetupArgs(argv);
  const secret = assertTestModeSecret(env.STRIPE_SECRET_KEY);
  const client = options.client ?? await options.createClient?.(secret);
  if (!client) {
    throw new Error("stripe_catalog_client_missing");
  }

  return syncStripeCatalog({
    client,
    dryRun: args.dryRun,
    placeholder: args.placeholder,
  });
}

function redactSecret(value) {
  if (!value) {
    return "";
  }
  return `${value.slice(0, 7)}…`;
}

async function defaultCreateClient(secret) {
  const { default: Stripe } = await import("stripe");
  return new Stripe(secret, {
    apiVersion: "2024-11-20.acacia",
    typescript: false,
  });
}

const isMain = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("stripe-catalog-setup.mjs");

if (isMain && process.env.OVD_STRIPE_CATALOG_SKIP_MAIN !== "1") {
  runStripeCatalogSetup(process.argv.slice(2), process.env, {
    createClient: defaultCreateClient,
  }).then((result) => {
    console.log(JSON.stringify({
      created: result.created,
      drift: result.drift,
      existing: result.existing,
      livemode: result.livemode,
      key: redactSecret(process.env.STRIPE_SECRET_KEY),
    }));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : "stripe_catalog_failed");
    process.exitCode = 1;
  });
}
