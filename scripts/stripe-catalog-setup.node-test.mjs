import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertTestModeSecret,
  BILLING_CATALOG_PRICES,
  parseSetupArgs,
  runStripeCatalogSetup,
  syncStripeCatalog,
} from "./stripe-catalog-setup.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const catalogSource = readFileSync(
  join(root, "supabase/functions/_shared/billingCatalog.ts"),
  "utf8",
);

function createMockStripe(existingPrices = []) {
  const state = {
    prices: [...existingPrices],
    products: [],
    networkCalls: 0,
  };

  const client = {
    prices: {
      create: async (parameters) => {
        state.networkCalls += 1;
        const price = {
          active: true,
          currency: parameters.currency,
          id: `price_mock_${state.prices.length + 1}`,
          livemode: false,
          lookup_key: parameters.lookup_key,
          metadata: parameters.metadata,
          nickname: parameters.nickname,
          product: {
            active: true,
            id: parameters.product,
            name: "created",
          },
          recurring: parameters.recurring,
          type: "recurring",
          unit_amount: parameters.unit_amount,
        };
        state.prices.push(price);
        return price;
      },
      list: async ({ lookup_keys }) => {
        state.networkCalls += 1;
        return {
          data: state.prices.filter((price) => lookup_keys.includes(price.lookup_key)),
        };
      },
    },
    products: {
      create: async (parameters) => {
        state.networkCalls += 1;
        const product = {
          id: `prod_mock_${state.products.length + 1}`,
          name: parameters.name,
          metadata: parameters.metadata,
        };
        state.products.push(product);
        return product;
      },
      search: async () => {
        state.networkCalls += 1;
        return { data: state.products };
      },
    },
  };

  return { client, state };
}

test("catalog script lookup keys stay aligned with the TypeScript source and TBD amounts", () => {
  for (const entry of BILLING_CATALOG_PRICES) {
    assert.match(catalogSource, new RegExp(`lookupKey: "${entry.lookupKey}"`));
    assert.equal(entry.amountCents, null);
  }
  assert.match(catalogSource, /amountCents: null/);
  assert.doesNotMatch(catalogSource, /amountCents: [1-9]/);
});

test("refuses live secrets and --live without creating Stripe objects", () => {
  assert.throws(() => assertTestModeSecret("sk_live_abc"), /stripe_catalog_live_key_refused/);
  assert.throws(() => assertTestModeSecret("rk_live_abc"), /stripe_catalog_live_key_refused/);
  assert.equal(assertTestModeSecret("sk_test_abc"), "sk_test_abc");
  assert.throws(() => parseSetupArgs(["--apply", "--live"]), /stripe_catalog_live_mode_refused/);
});

test("refuses TBD amounts even when a live key is not used", async () => {
  const { client, state } = createMockStripe();
  await assert.rejects(
    () => syncStripeCatalog({ client, dryRun: false, placeholder: false }),
    /stripe_catalog_amounts_tbd/,
  );
  assert.equal(state.prices.length, 0);
  assert.equal(state.products.length, 0);
});

test("second apply against a mock creates zero objects and reports drift", async () => {
  const { client, state } = createMockStripe();
  const first = await syncStripeCatalog({
    client,
    dryRun: false,
    placeholder: true,
  });
  assert.equal(first.created.prices, BILLING_CATALOG_PRICES.length);
  assert.equal(first.created.products, 3);
  assert.equal(first.drift.length, 0);
  assert.equal(first.livemode, false);

  const createdPrices = state.prices.length;
  const createdProducts = state.products.length;
  const second = await syncStripeCatalog({
    client,
    dryRun: false,
    placeholder: true,
  });
  assert.equal(second.created.prices, 0);
  assert.equal(second.created.products, 0);
  assert.equal(second.existing.prices, BILLING_CATALOG_PRICES.length);
  assert.equal(state.prices.length, createdPrices);
  assert.equal(state.products.length, createdProducts);

  state.prices[0] = { ...state.prices[0], unit_amount: 999 };
  const drifted = await syncStripeCatalog({
    client,
    dryRun: false,
    placeholder: true,
  });
  assert.equal(drifted.created.prices, 0);
  assert.equal(drifted.drift.length, 1);
  assert.equal(drifted.drift[0].lookupKey, BILLING_CATALOG_PRICES[0].lookupKey);
  assert.equal(state.prices[0].unit_amount, 999);
});

test("runStripeCatalogSetup uses the injected mock and never a live key", async () => {
  const { client, state } = createMockStripe();
  let createdWith;
  const result = await runStripeCatalogSetup(
    ["--apply", "--placeholder"],
    { STRIPE_SECRET_KEY: "sk_test_ovd725" },
    {
      createClient: (secret) => {
        createdWith = secret;
        return client;
      },
    },
  );
  assert.equal(createdWith, "sk_test_ovd725");
  assert.equal(result.created.prices, BILLING_CATALOG_PRICES.length);
  assert.ok(state.networkCalls > 0);

  await assert.rejects(
    () => runStripeCatalogSetup(["--apply", "--placeholder"], { STRIPE_SECRET_KEY: "sk_live_nope" }, {
      createClient: () => {
        throw new Error("must_not_construct_live_client");
      },
    }),
    /stripe_catalog_live_key_refused/,
  );
});
