import { assertEquals } from "jsr:@std/assert@1";
import { handleTestLoginRequest } from "./index.ts";

/**
 * Tests proving test-login is impossible to enable in production.
 * 
 * These tests verify that the test-login function correctly fails closed
 * in production environments, even when other conditions would allow access.
 */

type EnvSnapshot = Map<string, string | undefined>;

function captureEnv(keys: string[]): EnvSnapshot {
  return new Map(keys.map((key) => [key, Deno.env.get(key)]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of snapshot) {
    if (value !== undefined) {
      Deno.env.set(key, value);
    } else {
      Deno.env.delete(key);
    }
  }
}

async function testGuardRejection(
  envOverrides: Record<string, string | undefined>,
  expectedStatus: number,
  expectedError: string,
): Promise<void> {
  const envKeys = ["NODE_ENV", "VERCEL_ENV", "APP_ENV", "ENABLE_TEST_LOGIN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const snapshot = captureEnv(envKeys);

  try {
    for (const [key, value] of Object.entries(envOverrides)) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }

    const request = new Request("http://localhost:54321/functions/v1/test-login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "http://localhost:4173",
      },
      body: JSON.stringify({
        email: "test@example.com",
        redirectPath: "/",
        appOrigin: "http://localhost:4173",
      }),
    });

    const response = await handleTestLoginRequest(request);
    const body = await response.json();

    assertEquals(response.status, expectedStatus);
    assertEquals(body.error, expectedError);
  } finally {
    restoreEnv(snapshot);
  }
}

Deno.test("test-login rejects production NODE_ENV", async () => {
  await testGuardRejection(
    {
      NODE_ENV: "production",
      ENABLE_TEST_LOGIN: "1",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
    },
    404,
    "Not found.",
  );
});

Deno.test("test-login rejects production VERCEL_ENV", async () => {
  await testGuardRejection(
    {
      NODE_ENV: undefined,
      VERCEL_ENV: "production",
      ENABLE_TEST_LOGIN: "1",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
    },
    404,
    "Not found.",
  );
});

Deno.test("test-login rejects production APP_ENV", async () => {
  await testGuardRejection(
    {
      APP_ENV: "prod",
      ENABLE_TEST_LOGIN: "1",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
    },
    404,
    "Not found.",
  );
});

Deno.test("test-login rejects when ENABLE_TEST_LOGIN is not set", async () => {
  await testGuardRejection(
    {
      ENABLE_TEST_LOGIN: undefined,
      NODE_ENV: "development",
      SUPABASE_URL: "http://127.0.0.1:54321",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
    },
    404,
    "Not found.",
  );
});

Deno.test("test-login rejects non-localhost Supabase URL", async () => {
  await testGuardRejection(
    {
      NODE_ENV: "development",
      ENABLE_TEST_LOGIN: "1",
      SUPABASE_URL: "https://production.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "test-key",
    },
    404,
    "Not available outside local development.",
  );
});

Deno.test("test-login rejects non-localhost origin", async () => {
  const envKeys = ["NODE_ENV", "VERCEL_ENV", "APP_ENV", "ENABLE_TEST_LOGIN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const snapshot = captureEnv(envKeys);

  try {
    Deno.env.set("NODE_ENV", "development");
    Deno.env.set("ENABLE_TEST_LOGIN", "1");
    Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");

    const module = await import("./index.ts?t=" + Date.now());

    const request = new Request("http://localhost:54321/functions/v1/test-login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": "https://production.example.com",
      },
      body: JSON.stringify({
        email: "test@example.com",
        redirectPath: "/",
        appOrigin: "https://production.example.com",
      }),
    });

    const response = await module.default.fetch(request);
    const body = await response.json();

    assertEquals(response.status, 404);
    assertEquals(body.error, "Not available outside local development.");
  } finally {
    restoreEnv(snapshot);
  }
});
