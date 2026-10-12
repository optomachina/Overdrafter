#!/usr/bin/env node
/**
 * Stripe test-mode catalog setup for OVD-725.
 *
 * Never writes keys to files or logs. Refuses sk_live_ / rk_live_ secrets.
 * Amounts stay TBD unless --placeholder is passed in test mode.
 */
import { readFileSync } from "node:fs";
import process from "node:process";

const catalogData = JSON.parse(
  readFileSync(new URL("../supabase/functions/_shared/billingCatalogPrices.json", import.meta.url), "utf8"),
);

export const PLACEHOLDER_AMOUNT_CENTS = catalogData.placeholderAmountCents;
export const BILLING_CATALOG_VERSION = catalogData.version;
export const BILLING_CATALOG_CURRENCY = catalogData.currency;
export const BILLING_CATALOG_PRICES = catalogData.prices;

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

function amountFor(entry) {
  return entry.amountCents ?? PLACEHOLDER_AMOUNT_CENTS;
}

function rememberProduct(product, productName, productIds) {
  if (product && typeof product === "object" && product.id) {
    productIds.set(productName, product.id);
    return 1;
  }
  return 0;
}

async function resolveProductId(client, entry, productIds, dryRun, placeholder) {
  const cached = productIds.get(entry.productName);
  if (cached) {
    return { created: false, existing: false, productId: cached };
  }

  const products = await client.products.search?.({
    query: `name:'${entry.productName}'`,
  }) ?? { data: [] };
  const found = products.data.find((product) => product.name === entry.productName);
  if (found) {
    productIds.set(entry.productName, found.id);
    return { created: false, existing: true, productId: found.id };
  }

  const productId = dryRun
    ? `prod_dry_run_${entry.tier}`
    : (await client.products.create({
      name: entry.productName,
      metadata: {
        od_catalog_version: String(BILLING_CATALOG_VERSION),
        od_tier: entry.tier,
        placeholder: placeholder ? "true" : "false",
      },
    })).id;
  productIds.set(entry.productName, productId);
  return { created: true, existing: false, productId };
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

  const listed = await client.prices.list({
    expand: ["data.product"],
    limit: 100,
    lookup_keys: catalog.map((entry) => entry.lookupKey),
  });
  const byKey = new Map(listed.data.map((price) => [price.lookup_key, price]));
  const productIds = new Map();
  const existing = { prices: 0, products: 0 };
  const drift = catalog.flatMap((entry) => {
    const current = byKey.get(entry.lookupKey);
    if (!current) {
      return [];
    }
    existing.prices += 1;
    existing.products += rememberProduct(current.product, entry.productName, productIds);
    return priceMatchesCatalog(current, entry, amountFor(entry), placeholder)
      ? []
      : [{ lookupKey: entry.lookupKey, reason: "price_drift" }];
  });

  const missing = catalog.filter((entry) => !byKey.has(entry.lookupKey));
  const uniqueMissing = [...new Map(missing.map((entry) => [entry.productName, entry])).values()];
  const resolved = await Promise.all(
    uniqueMissing.map((entry) => resolveProductId(client, entry, productIds, dryRun, placeholder)),
  );
  const created = {
    prices: missing.length,
    products: resolved.filter((item) => item.created).length,
  };
  existing.products += resolved.filter((item) => item.existing).length;

  if (!dryRun) {
    await Promise.all(missing.map((entry) => client.prices.create({
      currency: BILLING_CATALOG_CURRENCY,
      lookup_key: entry.lookupKey,
      metadata: catalogPriceMetadata(entry, placeholder),
      nickname: entry.nickname,
      product: productIds.get(entry.productName),
      recurring: {
        interval: entry.interval,
        interval_count: 1,
      },
      unit_amount: amountFor(entry),
    })));
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
  try {
    const result = await runStripeCatalogSetup(process.argv.slice(2), process.env, {
      createClient: defaultCreateClient,
    });
    console.log(JSON.stringify({
      created: result.created,
      drift: result.drift,
      existing: result.existing,
      livemode: result.livemode,
      key: redactSecret(process.env.STRIPE_SECRET_KEY),
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "stripe_catalog_failed");
    process.exitCode = 1;
  }
}
