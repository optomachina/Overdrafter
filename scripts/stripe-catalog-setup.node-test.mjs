import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertCatalogShape,
  assertNotCi,
  assertTestModeAccount,
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
const catalogPricesSource = readFileSync(
  join(root, "supabase/functions/_shared/billingCatalogPrices.json"),
  "utf8",
);

function createMockStripe(existingPrices = [], { livemode = false } = {}) {
  const state = {
    livemode,
    prices: [...existingPrices],
    products: [],
    networkCalls: 0,
  };

  const client = {
    balance: {
      retrieve: async () => {
        state.networkCalls += 1;
        return { livemode: state.livemode };
      },
    },
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

const LOCAL_ENV = { STRIPE_SECRET_KEY: "sk_test_ovd725" };

test("catalog script reads the locked monthly amounts from the shared JSON", () => {
  assert.deepEqual(
    Object.fromEntries(BILLING_CATALOG_PRICES.map((entry) => [entry.lookupKey, entry.amountCents])),
    {
      od_founding_team_month_v1: 19900,
      od_jarvis_seat_month_v1: 0,
      od_pro_month_v1: 9900,
      od_team_month_v1: 34900,
      od_team_seat_month_v1: 4000,
    },
  );
  assert.ok(BILLING_CATALOG_PRICES.every((entry) => entry.interval === "month"));
  assert.doesNotMatch(catalogPricesSource, /"year"|annual/i);
  assert.match(catalogSource, /billingCatalogPrices\.json/);
});

test("refuses an annual or missing amount before any Stripe call", async () => {
  const annual = [{ ...BILLING_CATALOG_PRICES[0], interval: "year" }];
  assert.throws(() => assertCatalogShape(annual), /stripe_catalog_interval_refused/);
  const tbd = [{ ...BILLING_CATALOG_PRICES[0], amountCents: null }];
  assert.throws(() => assertCatalogShape(tbd), /stripe_catalog_amount_invalid/);
  const { client, state } = createMockStripe();
  await assert.rejects(
    () => syncStripeCatalog({ catalog: annual, client, dryRun: false }),
    /stripe_catalog_interval_refused/,
  );
  assert.equal(state.networkCalls, 0);
});

test("defaults to dry run and refuses CI runners", async () => {
  assert.deepEqual(parseSetupArgs([]), { dryRun: true });
  assert.deepEqual(parseSetupArgs(["--dry-run"]), { dryRun: true });
  assert.deepEqual(parseSetupArgs(["--apply"]), { dryRun: false });
  assert.throws(() => parseSetupArgs(["--apply", "--dry-run"]), /stripe_catalog_mode_conflict/);
  assert.throws(() => assertNotCi({ CI: "true" }), /stripe_catalog_ci_refused/);
  assert.throws(() => assertNotCi({ CI: "1" }), /stripe_catalog_ci_refused/);
  assert.throws(() => assertNotCi({ GITHUB_ACTIONS: "true" }), /stripe_catalog_ci_refused/);
  assert.doesNotThrow(() => assertNotCi({}));
  assert.doesNotThrow(() => assertNotCi({ CI: "false" }));

  const { client, state } = createMockStripe();
  await assert.rejects(
    () => runStripeCatalogSetup(["--apply"], { ...LOCAL_ENV, CI: "true" }, { client }),
    /stripe_catalog_ci_refused/,
  );
  assert.equal(state.networkCalls, 0);

  const result = await runStripeCatalogSetup([], LOCAL_ENV, { client });
  assert.equal(result.dryRun, true);
  assert.equal(result.created.prices, BILLING_CATALOG_PRICES.length);
  assert.equal(state.prices.length, 0);
  assert.equal(state.products.length, 0);
});

test("refuses live secrets and --live without creating Stripe objects", () => {
  assert.throws(() => assertTestModeSecret("sk_live_abc"), /stripe_catalog_live_key_refused/);
  assert.throws(() => assertTestModeSecret("rk_live_abc"), /stripe_catalog_live_key_refused/);
  assert.throws(() => assertTestModeSecret('  "SK_LIVE_abc"  '), /stripe_catalog_live_key_refused/);
  assert.throws(() => assertTestModeSecret("  'RK_LIVE_abc'  "), /stripe_catalog_live_key_refused/);
  assert.equal(assertTestModeSecret("sk_test_abc"), "sk_test_abc");
  assert.equal(assertTestModeSecret('  "sk_test_abc"  '), "sk_test_abc");
  assert.throws(() => parseSetupArgs(["--apply", "--live"]), /stripe_catalog_live_mode_refused/);
});

test("refuses a Stripe account that reports live mode", async () => {
  const { client, state } = createMockStripe([], { livemode: true });
  await assert.rejects(() => assertTestModeAccount(client), /stripe_catalog_live_account_refused/);
  await assert.rejects(
    () => runStripeCatalogSetup(["--apply"], LOCAL_ENV, { client }),
    /stripe_catalog_live_account_refused/,
  );
  assert.equal(state.prices.length, 0);
  assert.equal(state.products.length, 0);
});

test("draft SQL revokes authenticated, keeps disabled markers, and caps founding slots", () => {
  const draftSql = readFileSync(
    join(root, "supabase/tests/ovd725_stripe_catalog_draft.sql"),
    "utf8",
  );
  assert.match(
    draftSql,
    /revoke all on function public\.api_configure_stripe_catalog_price\(boolean, text, text\)\s+from public, anon, authenticated/,
  );
  assert.match(
    draftSql,
    /revoke all on function public\.api_disable_stripe_catalog_price\(text, boolean, text, text\)\s+from public, anon, authenticated/,
  );
  assert.match(
    draftSql,
    /grant execute on function public\.api_configure_stripe_catalog_price\(boolean, text, text\)\s+to service_role/,
  );
  assert.match(
    draftSql,
    /on conflict \(lookup_key\) do update\s+set stripe_price_id = excluded\.stripe_price_id,\s+livemode = excluded\.livemode,\s+updated_at = pg_catalog\.now\(\);/,
  );
  assert.doesNotMatch(
    draftSql,
    /on conflict \(lookup_key\) do update[\s\S]{0,200}disabled_at = null/,
  );
  assert.match(draftSql, /create or replace function public\.api_claim_founding_team_slot\(\)/);
  assert.match(draftSql, /and slots_used < 8/);
  assert.doesNotMatch(draftSql, /slots_used < 12|1\.\.12/);
  assert.match(draftSql, /the ninth founding slot is refused/);
  assert.match(draftSql, /has_function_privilege\(\s+'authenticated'/);
});

test("migration draft lives outside supabase/migrations with a rollback and the 8 team cap", () => {
  const draft = readFileSync(join(root, "docs/migration-drafts/ovd-725-stripe-catalog.sql"), "utf8");
  assert.match(draft, /DRAFT ONLY/);
  assert.match(draft, /ROLLBACK/);
  assert.match(draft, /and slots_used < 8/);
  assert.doesNotMatch(draft, /slots_used < 12/);
});

test("example env names the catalog flags without values", () => {
  const envExample = readFileSync(join(root, ".env.example"), "utf8");
  assert.match(envExample, /^BILLING_TIER_CATALOG_ENABLED=""$/m);
  assert.match(envExample, /^VITE_BILLING_SELF_SERVICE_ENABLED=""$/m);
  assert.match(envExample, /^VITE_BILLING_TIER_CATALOG_ENABLED=""$/m);
});

test("second apply against a mock creates zero objects and reports drift", async () => {
  const { client, state } = createMockStripe();
  const first = await syncStripeCatalog({ client, dryRun: false });
  assert.equal(first.created.prices, BILLING_CATALOG_PRICES.length);
  assert.equal(first.created.products, 4);
  assert.ok(state.products.some((product) => product.name === "OverDrafter Jarvis"));
  assert.ok(state.prices.every((price) => price.recurring.interval === "month"));
  assert.equal(first.drift.length, 0);
  assert.equal(first.livemode, false);

  const createdPrices = state.prices.length;
  const createdProducts = state.products.length;
  const second = await syncStripeCatalog({ client, dryRun: false });
  assert.equal(second.created.prices, 0);
  assert.equal(second.created.products, 0);
  assert.equal(second.existing.prices, BILLING_CATALOG_PRICES.length);
  assert.equal(state.prices.length, createdPrices);
  assert.equal(state.products.length, createdProducts);

  state.prices[0] = { ...state.prices[0], unit_amount: 999 };
  const drifted = await syncStripeCatalog({ client, dryRun: false });
  assert.equal(drifted.created.prices, 0);
  assert.equal(drifted.drift.length, 1);
  assert.equal(drifted.drift[0].lookupKey, BILLING_CATALOG_PRICES[0].lookupKey);
  assert.equal(state.prices[0].unit_amount, 999);
});

test("runStripeCatalogSetup uses the injected mock and never a live key", async () => {
  const { client, state } = createMockStripe();
  let createdWith;
  const result = await runStripeCatalogSetup(
    ["--apply"],
    { STRIPE_SECRET_KEY: '  "sk_test_ovd725"  ' },
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
    () => runStripeCatalogSetup(["--apply"], { STRIPE_SECRET_KEY: "sk_live_nope" }, {
      createClient: () => {
        throw new Error("must_not_construct_live_client");
      },
    }),
    /stripe_catalog_live_key_refused/,
  );
});
