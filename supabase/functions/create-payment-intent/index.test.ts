import { assertEquals } from "https://deno.land/std@0.220.0/assert/mod.ts";
import {
  handleCreatePaymentIntent,
  isLegacyProjectPaymentsEnabled,
} from "./index.ts";

const enabledEnvironment = (name: string): string | undefined => {
  const values: Record<string, string> = {
    LEGACY_PROJECT_PAYMENTS_ENABLED: "true",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    STRIPE_SECRET_KEY: "sk_test_example",
  };

  return values[name];
};

Deno.test("legacy payment flag accepts only normalized true", () => {
  assertEquals(isLegacyProjectPaymentsEnabled("true"), true);
  assertEquals(isLegacyProjectPaymentsEnabled(" TRUE "), true);
  assertEquals(isLegacyProjectPaymentsEnabled("TrUe"), true);
  assertEquals(isLegacyProjectPaymentsEnabled(undefined), false);
  assertEquals(isLegacyProjectPaymentsEnabled(""), false);
  assertEquals(isLegacyProjectPaymentsEnabled("false"), false);
  assertEquals(isLegacyProjectPaymentsEnabled("1"), false);
  assertEquals(isLegacyProjectPaymentsEnabled("yes"), false);
});

Deno.test(
  "disabled POST returns stable 503 before auth or runtime secrets",
  async () => {
    const response = await handleCreatePaymentIntent(
      new Request("https://example.test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
      () => undefined,
    );

    assertEquals(response.status, 503);
    assertEquals(await response.json(), {
      error: "Legacy project payments are disabled.",
      code: "legacy_project_payments_disabled",
    });
    assertEquals(response.headers.get("access-control-allow-origin"), "*");
  },
);

Deno.test("enabled POST preserves the legacy authorization check", async () => {
  const response = await handleCreatePaymentIntent(
    new Request("https://example.test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: "test" }),
    }),
    enabledEnvironment,
  );

  assertEquals(response.status, 401);
});

Deno.test("OPTIONS returns CORS headers before the feature gate", async () => {
  const response = await handleCreatePaymentIntent(
    new Request("https://example.test", { method: "OPTIONS" }),
    () => undefined,
  );

  assertEquals(response.status, 200);
  assertEquals(response.headers.get("access-control-allow-origin"), "*");
  assertEquals(
    response.headers.get("access-control-allow-methods"),
    "POST, OPTIONS",
  );
});

Deno.test(
  "unsupported methods return 405 before the feature gate",
  async () => {
    const response = await handleCreatePaymentIntent(
      new Request("https://example.test", { method: "GET" }),
      () => undefined,
    );

    assertEquals(response.status, 405);
    assertEquals(await response.json(), { error: "Method not allowed." });
  },
);
