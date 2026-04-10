import { assertEquals } from "https://deno.land/std@0.220.0/assert/mod.ts";

// Minimal test harness for the create-payment-intent function.
// These run against a real Stripe test mode key ($STRIPE_SECRET_KEY) and
// a Supabase dev instance ($SUPABASE_URL / $SUPABASE_ANON_KEY).
// CI must have STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET set before these run.

Deno.test("POST without Authorization returns 401", async () => {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/create-payment-intent`;

  if (!url.startsWith("http")) {
    // Skip in environments without a running Supabase instance
    console.log("SUPABASE_URL not set — skipping integration test");
    return;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: "test", amountCents: 5000 }),
  });

  assertEquals(response.status, 401);
});

Deno.test("POST with invalid amountCents returns 400", async () => {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/create-payment-intent`;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const testToken = Deno.env.get("SUPABASE_TEST_AUTH_TOKEN");

  if (!url.startsWith("http") || !anonKey || !testToken) {
    console.log("Required env vars not set — skipping integration test");
    return;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${testToken}`,
      apikey: anonKey,
    },
    body: JSON.stringify({ projectId: "test", amountCents: 10 }), // below $0.50 minimum
  });

  assertEquals(response.status, 400);
});

Deno.test("OPTIONS returns CORS headers", async () => {
  const url = `${Deno.env.get("SUPABASE_URL")}/functions/v1/create-payment-intent`;

  if (!url.startsWith("http")) {
    console.log("SUPABASE_URL not set — skipping integration test");
    return;
  }

  const response = await fetch(url, { method: "OPTIONS" });

  assertEquals(response.status, 200);
  const origin = response.headers.get("access-control-allow-origin");
  assertEquals(origin, "*");
});
