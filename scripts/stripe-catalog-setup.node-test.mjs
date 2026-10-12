import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertCatalogShape,
  assertNotCi,
  assertTestModeAccount,
  assertTestModeSecret,
  BILLING_CATALOG_PRICES,
  encodeStripeForm,
  parseSetupArgs,
  runStripeCatalogSetup,
  STRIPE_API_VERSION,
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
    /revoke all on table private\.stripe_catalog_price_allowlist\s+from public, anon, authenticated, service_role/,
  );
  assert.match(
    draftSql,
    /revoke all on table private\.founding_team_claims\s+from public, anon, authenticated, service_role/,
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
  assert.match(draftSql, /create function public\.api_claim_founding_team_slot\(p_organization_id uuid\)/);
  assert.match(draftSql, /create function public\.api_release_founding_team_slot\(p_organization_id uuid\)/);
  assert.match(draftSql, /if v_slots >= 8 then/);
  assert.doesNotMatch(draftSql, /slots_used < 12|1\.\.12|>= 12/);
  assert.match(draftSql, /the ninth organization is refused/);
  assert.match(draftSql, /configure refuses a webhook-disabled catalog key/);
  assert.match(draftSql, /has_function_privilege\(\s+'authenticated'/);
});

test("migration draft lives outside supabase/migrations with a rollback and the 8 team cap", () => {
  const draft = readFileSync(join(root, "docs/migration-drafts/ovd-725-stripe-catalog.sql"), "utf8");
  assert.match(draft, /DRAFT ONLY/);
  assert.match(draft, /ROLLBACK/);
  assert.match(draft, /if v_slots >= 8 then/);
  assert.doesNotMatch(draft, />= 12/);
  const draftSql = readFileSync(join(root, "supabase/tests/ovd725_stripe_catalog_draft.sql"), "utf8");
  const ddl = (text, start) => text.slice(
    text.indexOf("create table private.stripe_catalog_price_allowlist", start),
    text.indexOf("  to service_role;\n", text.indexOf("api_release_founding_team_slot(uuid)\n  to service_role")) ,
  );
  assert.equal(ddl(draftSql), ddl(draft), "pgTAP proof DDL must match the migration draft");
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
  // Team and extra seat prices share one product, so products are counted once.
  assert.equal(second.existing.products, 4);
  assert.equal(state.prices.length, createdPrices);
  assert.equal(state.products.length, createdProducts);

  const inactiveProduct = { ...state.prices[0], product: { ...state.prices[0].product, active: false } };
  const original = state.prices[0];
  state.prices[0] = inactiveProduct;
  const inactive = await syncStripeCatalog({ client, dryRun: false });
  assert.deepEqual(inactive.drift, [{ lookupKey: original.lookup_key, reason: "price_drift" }]);
  state.prices[0] = original;

  state.prices[0] = { ...state.prices[0], unit_amount: 999 };
  const drifted = await syncStripeCatalog({ client, dryRun: false });
  assert.equal(drifted.created.prices, 0);
  assert.equal(drifted.drift.length, 1);
  assert.equal(drifted.drift[0].lookupKey, BILLING_CATALOG_PRICES[0].lookupKey);
  assert.equal(state.prices[0].unit_amount, 999);
});

function startStripeStub() {
  const requests = [];
  const prices = [];
  const products = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      const form = new URLSearchParams(req.method === "GET" ? url.search : raw);
      requests.push({
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        form,
        method: req.method,
        path: url.pathname,
        version: req.headers["stripe-version"],
      });
      const send = (status, body) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== "Bearer sk_test_ovd725") {
        send(401, { error: { type: "invalid_request_error" } });
      } else if (req.method === "GET" && url.pathname === "/v1/balance") {
        send(200, { livemode: false, object: "balance" });
      } else if (req.method === "GET" && url.pathname === "/v1/prices") {
        const keys = form.getAll("lookup_keys[]");
        send(200, { data: prices.filter((price) => keys.includes(price.lookup_key)) });
      } else if (req.method === "GET" && url.pathname === "/v1/products/search") {
        send(200, { data: products });
      } else if (req.method === "POST" && url.pathname === "/v1/products") {
        const product = { active: true, id: `prod_stub${products.length + 1}`, name: form.get("name") };
        products.push(product);
        send(200, product);
      } else if (req.method === "POST" && url.pathname === "/v1/prices") {
        const product = products.find((item) => item.id === form.get("product"));
        const price = {
          active: true,
          currency: form.get("currency"),
          id: `price_stub${prices.length + 1}`,
          livemode: false,
          lookup_key: form.get("lookup_key"),
          metadata: {
            od_catalog_version: form.get("metadata[od_catalog_version]"),
            od_interval: form.get("metadata[od_interval]"),
            od_kind: form.get("metadata[od_kind]"),
            od_tier: form.get("metadata[od_tier]"),
          },
          product,
          recurring: {
            interval: form.get("recurring[interval]"),
            interval_count: Number(form.get("recurring[interval_count]")),
          },
          type: "recurring",
          unit_amount: Number(form.get("unit_amount")),
        };
        prices.push(price);
        send(200, price);
      } else {
        send(404, { error: { type: "invalid_request_error" } });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
        prices,
        products,
        requests,
      });
    });
  });
}

test("encodes nested Stripe form params", () => {
  assert.equal(
    encodeStripeForm({
      expand: ["data.product"],
      lookup_keys: ["a", "b"],
      metadata: { od_tier: "pro" },
      recurring: { interval: "month", interval_count: 1 },
      skipped: undefined,
    }).toString(),
    "expand%5B%5D=data.product&lookup_keys%5B%5D=a&lookup_keys%5B%5D=b" +
      "&metadata%5Bod_tier%5D=pro&recurring%5Binterval%5D=month&recurring%5Binterval_count%5D=1",
  );
});

test("the real fetch client builds correct Stripe requests against a local stub", async () => {
  const stub = await startStripeStub();
  try {
    const env = { STRIPE_SECRET_KEY: '  "sk_test_ovd725"  ' };
    const dry = await runStripeCatalogSetup([], env, { baseUrl: stub.baseUrl });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.created.prices, BILLING_CATALOG_PRICES.length);
    assert.ok(stub.requests.every((request) => request.method === "GET"));
    assert.ok(stub.requests.every((request) => request.authorization === "Bearer sk_test_ovd725"));
    assert.ok(stub.requests.every((request) => request.version === STRIPE_API_VERSION));
    const list = stub.requests.find((request) => request.path === "/v1/prices");
    assert.deepEqual(
      list.form.getAll("lookup_keys[]"),
      BILLING_CATALOG_PRICES.map((entry) => entry.lookupKey),
    );
    assert.deepEqual(list.form.getAll("expand[]"), ["data.product"]);

    stub.requests.length = 0;
    const applied = await runStripeCatalogSetup(["--apply"], env, { baseUrl: stub.baseUrl });
    assert.equal(applied.dryRun, false);
    assert.equal(stub.products.length, 4);
    assert.equal(stub.prices.length, BILLING_CATALOG_PRICES.length);
    const priceCreates = stub.requests.filter(
      (request) => request.method === "POST" && request.path === "/v1/prices",
    );
    assert.ok(priceCreates.every((request) =>
      request.contentType === "application/x-www-form-urlencoded"
    ));
    const pro = priceCreates.find((request) => request.form.get("lookup_key") === "od_pro_month_v1");
    assert.equal(pro.form.get("unit_amount"), "9900");
    assert.equal(pro.form.get("currency"), "usd");
    assert.equal(pro.form.get("recurring[interval]"), "month");
    assert.equal(pro.form.get("recurring[interval_count]"), "1");
    assert.equal(pro.form.get("metadata[od_tier]"), "pro");
    assert.match(pro.form.get("product"), /^prod_stub\d+$/);

    const again = await runStripeCatalogSetup(["--apply"], env, { baseUrl: stub.baseUrl });
    assert.equal(again.created.prices, 0);
    assert.equal(again.drift.length, 0);

    stub.requests.length = 0;
    await assert.rejects(
      () => runStripeCatalogSetup(["--apply"], { STRIPE_SECRET_KEY: "sk_live_nope" }, {
        baseUrl: stub.baseUrl,
      }),
      /stripe_catalog_live_key_refused/,
    );
    await assert.rejects(
      () => runStripeCatalogSetup([], { STRIPE_SECRET_KEY: "sk_test_wrong" }, {
        baseUrl: stub.baseUrl,
      }),
      (error) => error.message === "stripe_api_error:401:invalid_request_error",
    );
    assert.equal(stub.requests.length, 1);
  } finally {
    await stub.close();
  }
});
