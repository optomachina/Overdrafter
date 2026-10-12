#!/usr/bin/env node
/**
 * Stripe test-mode catalog setup for OVD-725.
 *
 * Dry run unless --apply is passed. Never writes keys to files or logs.
 * Refuses sk_live_ / rk_live_ secrets, live accounts, and CI runners; there is
 * no flag that enables live mode. Amounts come from billingCatalogPrices.json,
 * the same file the app and edge functions read.
 */
import { readFileSync } from "node:fs";
import process from "node:process";

const catalogData = JSON.parse(
  readFileSync(new URL("../supabase/functions/_shared/billingCatalogPrices.json", import.meta.url), "utf8"),
);

export const BILLING_CATALOG_VERSION = catalogData.version;
export const BILLING_CATALOG_CURRENCY = catalogData.currency;
export const BILLING_CATALOG_PRICES = catalogData.prices;

export function normalizeStripeSecret(secret) {
  if (typeof secret !== "string") {
    return "";
  }
  let value = secret.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

export function isLiveStripeSecret(secret) {
  const value = normalizeStripeSecret(secret).toLowerCase();
  return value.startsWith("sk_live_") || value.startsWith("rk_live_");
}

export function assertTestModeSecret(secret) {
  const value = normalizeStripeSecret(secret);
  if (!value) {
    throw new Error("stripe_catalog_secret_missing");
  }
  if (isLiveStripeSecret(value)) {
    throw new Error("stripe_catalog_live_key_refused");
  }
  return value;
}

export async function assertTestModeAccount(client) {
  const balance = await client.balance?.retrieve?.();
  if (balance?.livemode === true) {
    throw new Error("stripe_catalog_live_account_refused");
  }
  if (balance?.livemode !== false) {
    throw new Error("stripe_catalog_livemode_unconfirmed");
  }
}

export function assertNotCi(env) {
  const ci = String(env.CI ?? "").trim().toLowerCase();
  if ((ci !== "" && ci !== "false" && ci !== "0") || env.GITHUB_ACTIONS === "true") {
    throw new Error("stripe_catalog_ci_refused");
  }
}

export function parseSetupArgs(argv) {
  const args = { dryRun: true };
  let apply = false;
  let dryRun = false;
  for (const value of argv) {
    if (value === "--apply") {
      apply = true;
    } else if (value === "--dry-run") {
      dryRun = true;
    } else if (value === "--live") {
      throw new Error("stripe_catalog_live_mode_refused");
    } else {
      throw new Error(`stripe_catalog_unknown_arg:${value}`);
    }
  }
  if (apply && dryRun) {
    throw new Error("stripe_catalog_mode_conflict");
  }
  args.dryRun = !apply;
  return args;
}

export function catalogPriceMetadata(entry) {
  return {
    od_catalog_version: String(BILLING_CATALOG_VERSION),
    od_interval: entry.interval,
    od_kind: entry.kind,
    od_tier: entry.tier,
  };
}

export function assertCatalogShape(catalog) {
  for (const entry of catalog) {
    if (entry.interval !== "month") {
      throw new Error(`stripe_catalog_interval_refused:${entry.lookupKey}`);
    }
    if (!Number.isInteger(entry.amountCents) || entry.amountCents < 0) {
      throw new Error(`stripe_catalog_amount_invalid:${entry.lookupKey}`);
    }
  }
}

function priceMatchesCatalog(price, entry) {
  const metadata = price.metadata ?? {};
  const expected = catalogPriceMetadata(entry);
  return price.active === true &&
    price.livemode === false &&
    (price.currency ?? "").toLowerCase() === BILLING_CATALOG_CURRENCY &&
    price.unit_amount === entry.amountCents &&
    price.type === "recurring" &&
    price.recurring?.interval === entry.interval &&
    price.recurring?.interval_count === 1 &&
    metadata.od_tier === expected.od_tier &&
    metadata.od_interval === expected.od_interval &&
    metadata.od_catalog_version === expected.od_catalog_version;
}

function rememberProduct(product, productName, productIds) {
  if (product && typeof product === "object" && product.id) {
    productIds.set(productName, product.id);
    return 1;
  }
  return 0;
}

async function resolveProductId(client, entry, productIds, dryRun) {
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
      },
    })).id;
  productIds.set(entry.productName, productId);
  return { created: true, existing: false, productId };
}

export async function syncStripeCatalog({
  catalog = BILLING_CATALOG_PRICES,
  client,
  dryRun = true,
}) {
  assertCatalogShape(catalog);

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
    return priceMatchesCatalog(current, entry)
      ? []
      : [{ lookupKey: entry.lookupKey, reason: "price_drift" }];
  });

  const missing = catalog.filter((entry) => !byKey.has(entry.lookupKey));
  const uniqueMissing = [...new Map(missing.map((entry) => [entry.productName, entry])).values()];
  const resolved = await Promise.all(
    uniqueMissing.map((entry) => resolveProductId(client, entry, productIds, dryRun)),
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
      metadata: catalogPriceMetadata(entry),
      nickname: entry.nickname,
      product: productIds.get(entry.productName),
      recurring: {
        interval: entry.interval,
        interval_count: 1,
      },
      unit_amount: entry.amountCents,
    })));
  }

  return { created, drift, dryRun, existing, livemode: false };
}

export const STRIPE_API_BASE_URL = "https://api.stripe.com";
export const STRIPE_API_VERSION = "2024-11-20.acacia";

/** Encodes nested params the way Stripe's form API expects (a[b]=c, a[]=d). */
export function encodeStripeForm(params, prefix = "", out = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      for (const item of value) {
        out.append(`${name}[]`, String(item));
      }
    } else if (typeof value === "object") {
      encodeStripeForm(value, name, out);
    } else {
      out.append(name, String(value));
    }
  }
  return out;
}

/**
 * Minimal Stripe REST client over fetch, exposing only the calls this script
 * makes. No SDK dependency. Errors never echo the secret.
 */
export function createFetchStripeClient(secret, {
  baseUrl = STRIPE_API_BASE_URL,
  fetchImpl = globalThis.fetch,
} = {}) {
  async function request(method, path, params = {}) {
    const form = encodeStripeForm(params).toString();
    const url = method === "GET" && form ? `${baseUrl}${path}?${form}` : `${baseUrl}${path}`;
    const response = await fetchImpl(url, {
      body: method === "GET" ? undefined : form,
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": STRIPE_API_VERSION,
      },
      method,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const type = typeof body?.error?.type === "string" ? body.error.type : "unknown";
      throw new Error(`stripe_api_error:${response.status}:${type}`);
    }
    return body;
  }

  return {
    balance: { retrieve: () => request("GET", "/v1/balance") },
    prices: {
      create: (params) => request("POST", "/v1/prices", params),
      list: (params) => request("GET", "/v1/prices", params),
    },
    products: {
      create: (params) => request("POST", "/v1/products", params),
      search: (params) => request("GET", "/v1/products/search", params),
    },
  };
}

export async function runStripeCatalogSetup(argv, env, options = {}) {
  assertNotCi(env);
  const args = parseSetupArgs(argv);
  const secret = assertTestModeSecret(env.STRIPE_SECRET_KEY);
  const client = options.client ??
    createFetchStripeClient(secret, {
      baseUrl: options.baseUrl,
      fetchImpl: options.fetchImpl,
    });
  await assertTestModeAccount(client);

  return syncStripeCatalog({
    client,
    dryRun: args.dryRun,
  });
}

function redactSecret(value) {
  if (!value) {
    return "";
  }
  return `${value.slice(0, 7)}…`;
}

const isMain = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("stripe-catalog-setup.mjs");

if (isMain && process.env.OVD_STRIPE_CATALOG_SKIP_MAIN !== "1") {
  try {
    const result = await runStripeCatalogSetup(process.argv.slice(2), process.env);
    console.log(JSON.stringify({
      created: result.created,
      drift: result.drift,
      dryRun: result.dryRun,
      existing: result.existing,
      livemode: result.livemode,
      key: redactSecret(process.env.STRIPE_SECRET_KEY),
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "stripe_catalog_failed");
    process.exitCode = 1;
  }
}
