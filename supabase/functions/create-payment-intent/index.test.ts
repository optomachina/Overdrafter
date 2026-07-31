import { assertEquals } from "https://deno.land/std@0.220.0/assert/mod.ts";
import { isLegacyProjectPaymentsEnabled } from "../_shared/legacy-project-payments.ts";
import { handleCreatePaymentIntent } from "./index.ts";

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

Deno.test("legacy payment flag accepts normalized true", () => {
  assertEquals(isLegacyProjectPaymentsEnabled("true"), true);
  assertEquals(isLegacyProjectPaymentsEnabled(" TRUE "), true);
  assertEquals(isLegacyProjectPaymentsEnabled("TrUe"), true);
});

Deno.test("legacy payment flag rejects absent and non-true values", () => {
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

for (
  const { name, omittedVariables } of [
    {
      name: "Supabase URL",
      omittedVariables: ["SUPABASE_URL"],
    },
    {
      name: "Supabase anonymous key",
      omittedVariables: ["SUPABASE_ANON_KEY"],
    },
    {
      name: "Supabase service-role keys",
      omittedVariables: ["SUPABASE_SERVICE_ROLE_KEY", "SERVICE_ROLE_KEY"],
    },
    {
      name: "Stripe secret",
      omittedVariables: ["STRIPE_SECRET_KEY"],
    },
  ]
) {
  Deno.test(
    `enabled POST returns JSON+CORS 500 when ${name} configuration is missing`,
    async () => {
      const response = await handleCreatePaymentIntent(
        new Request("https://example.test", {
          method: "POST",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ projectId: "test" }),
        }),
        (variableName) => {
          if (omittedVariables.includes(variableName)) {
            return undefined;
          }
          return enabledEnvironment(variableName);
        },
      );

      assertEquals(response.status, 500);
      assertEquals(await response.json(), {
        error: "Payment setup failed. Try again or contact support.",
      });
      assertEquals(response.headers.get("access-control-allow-origin"), "*");
      assertEquals(response.headers.get("content-type"), "application/json");
    },
  );
}

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
