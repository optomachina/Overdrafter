import { assertEquals } from "jsr:@std/assert@1";

/**
 * Tests proving test-login is impossible to enable in production.
 * 
 * These tests verify that the test-login function correctly fails closed
 * in production environments, even when other conditions would allow access.
 */

Deno.test("test-login rejects production NODE_ENV", async () => {
  const savedNodeEnv = Deno.env.get("NODE_ENV");
  const savedVercelEnv = Deno.env.get("VERCEL_ENV");
  const savedAppEnv = Deno.env.get("APP_ENV");
  const savedEnableTestLogin = Deno.env.get("ENABLE_TEST_LOGIN");
  const savedSupabaseUrl = Deno.env.get("SUPABASE_URL");
  const savedServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  try {
    Deno.env.set("NODE_ENV", "production");
    Deno.env.set("ENABLE_TEST_LOGIN", "1");
    Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");

    // Import fresh to pick up the new env vars
    const module = await import("./index.ts?t=" + Date.now());

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

    const response = await module.default.fetch(request);
    const body = await response.json();

    assertEquals(response.status, 404);
    assertEquals(body.error, "Not found.");
  } finally {
    if (savedNodeEnv !== undefined) Deno.env.set("NODE_ENV", savedNodeEnv);
    else Deno.env.delete("NODE_ENV");

    if (savedVercelEnv !== undefined) Deno.env.set("VERCEL_ENV", savedVercelEnv);
    else Deno.env.delete("VERCEL_ENV");

    if (savedAppEnv !== undefined) Deno.env.set("APP_ENV", savedAppEnv);
    else Deno.env.delete("APP_ENV");

    if (savedEnableTestLogin !== undefined) Deno.env.set("ENABLE_TEST_LOGIN", savedEnableTestLogin);
    else Deno.env.delete("ENABLE_TEST_LOGIN");

    if (savedSupabaseUrl !== undefined) Deno.env.set("SUPABASE_URL", savedSupabaseUrl);
    else Deno.env.delete("SUPABASE_URL");

    if (savedServiceRoleKey !== undefined) Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", savedServiceRoleKey);
    else Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
  }
});

Deno.test("test-login rejects production VERCEL_ENV", async () => {
  const savedNodeEnv = Deno.env.get("NODE_ENV");
  const savedVercelEnv = Deno.env.get("VERCEL_ENV");
  const savedEnableTestLogin = Deno.env.get("ENABLE_TEST_LOGIN");
  const savedSupabaseUrl = Deno.env.get("SUPABASE_URL");
  const savedServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  try {
    Deno.env.delete("NODE_ENV");
    Deno.env.set("VERCEL_ENV", "production");
    Deno.env.set("ENABLE_TEST_LOGIN", "1");
    Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");

    const module = await import("./index.ts?t=" + Date.now());

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

    const response = await module.default.fetch(request);
    const body = await response.json();

    assertEquals(response.status, 404);
    assertEquals(body.error, "Not found.");
  } finally {
    if (savedNodeEnv !== undefined) Deno.env.set("NODE_ENV", savedNodeEnv);
    else Deno.env.delete("NODE_ENV");

    if (savedVercelEnv !== undefined) Deno.env.set("VERCEL_ENV", savedVercelEnv);
    else Deno.env.delete("VERCEL_ENV");

    if (savedEnableTestLogin !== undefined) Deno.env.set("ENABLE_TEST_LOGIN", savedEnableTestLogin);
    else Deno.env.delete("ENABLE_TEST_LOGIN");

    if (savedSupabaseUrl !== undefined) Deno.env.set("SUPABASE_URL", savedSupabaseUrl);
    else Deno.env.delete("SUPABASE_URL");

    if (savedServiceRoleKey !== undefined) Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", savedServiceRoleKey);
    else Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
  }
});

Deno.test("test-login rejects production APP_ENV", async () => {
  const savedAppEnv = Deno.env.get("APP_ENV");
  const savedEnableTestLogin = Deno.env.get("ENABLE_TEST_LOGIN");
  const savedSupabaseUrl = Deno.env.get("SUPABASE_URL");
  const savedServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  try {
    Deno.env.set("APP_ENV", "prod");
    Deno.env.set("ENABLE_TEST_LOGIN", "1");
    Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");

    const module = await import("./index.ts?t=" + Date.now());

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

    const response = await module.default.fetch(request);
    const body = await response.json();

    assertEquals(response.status, 404);
    assertEquals(body.error, "Not found.");
  } finally {
    if (savedAppEnv !== undefined) Deno.env.set("APP_ENV", savedAppEnv);
    else Deno.env.delete("APP_ENV");

    if (savedEnableTestLogin !== undefined) Deno.env.set("ENABLE_TEST_LOGIN", savedEnableTestLogin);
    else Deno.env.delete("ENABLE_TEST_LOGIN");

    if (savedSupabaseUrl !== undefined) Deno.env.set("SUPABASE_URL", savedSupabaseUrl);
    else Deno.env.delete("SUPABASE_URL");

    if (savedServiceRoleKey !== undefined) Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", savedServiceRoleKey);
    else Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
  }
});

Deno.test("test-login rejects when ENABLE_TEST_LOGIN is not set", async () => {
  const savedEnableTestLogin = Deno.env.get("ENABLE_TEST_LOGIN");
  const savedSupabaseUrl = Deno.env.get("SUPABASE_URL");
  const savedServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const savedNodeEnv = Deno.env.get("NODE_ENV");

  try {
    Deno.env.delete("ENABLE_TEST_LOGIN");
    Deno.env.set("NODE_ENV", "development");
    Deno.env.set("SUPABASE_URL", "http://127.0.0.1:54321");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");

    const module = await import("./index.ts?t=" + Date.now());

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

    const response = await module.default.fetch(request);
    const body = await response.json();

    assertEquals(response.status, 404);
    assertEquals(body.error, "Not found.");
  } finally {
    if (savedEnableTestLogin !== undefined) Deno.env.set("ENABLE_TEST_LOGIN", savedEnableTestLogin);
    else Deno.env.delete("ENABLE_TEST_LOGIN");

    if (savedSupabaseUrl !== undefined) Deno.env.set("SUPABASE_URL", savedSupabaseUrl);
    else Deno.env.delete("SUPABASE_URL");

    if (savedServiceRoleKey !== undefined) Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", savedServiceRoleKey);
    else Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");

    if (savedNodeEnv !== undefined) Deno.env.set("NODE_ENV", savedNodeEnv);
    else Deno.env.delete("NODE_ENV");
  }
});

Deno.test("test-login rejects non-localhost Supabase URL", async () => {
  const savedEnableTestLogin = Deno.env.get("ENABLE_TEST_LOGIN");
  const savedSupabaseUrl = Deno.env.get("SUPABASE_URL");
  const savedServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const savedNodeEnv = Deno.env.get("NODE_ENV");

  try {
    Deno.env.set("NODE_ENV", "development");
    Deno.env.set("ENABLE_TEST_LOGIN", "1");
    Deno.env.set("SUPABASE_URL", "https://production.supabase.co");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-key");

    const module = await import("./index.ts?t=" + Date.now());

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

    const response = await module.default.fetch(request);
    const body = await response.json();

    assertEquals(response.status, 404);
    assertEquals(body.error, "Not available outside local development.");
  } finally {
    if (savedEnableTestLogin !== undefined) Deno.env.set("ENABLE_TEST_LOGIN", savedEnableTestLogin);
    else Deno.env.delete("ENABLE_TEST_LOGIN");

    if (savedSupabaseUrl !== undefined) Deno.env.set("SUPABASE_URL", savedSupabaseUrl);
    else Deno.env.delete("SUPABASE_URL");

    if (savedServiceRoleKey !== undefined) Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", savedServiceRoleKey);
    else Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");

    if (savedNodeEnv !== undefined) Deno.env.set("NODE_ENV", savedNodeEnv);
    else Deno.env.delete("NODE_ENV");
  }
});

Deno.test("test-login rejects non-localhost origin", async () => {
  const savedEnableTestLogin = Deno.env.get("ENABLE_TEST_LOGIN");
  const savedSupabaseUrl = Deno.env.get("SUPABASE_URL");
  const savedServiceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const savedNodeEnv = Deno.env.get("NODE_ENV");

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
    if (savedEnableTestLogin !== undefined) Deno.env.set("ENABLE_TEST_LOGIN", savedEnableTestLogin);
    else Deno.env.delete("ENABLE_TEST_LOGIN");

    if (savedSupabaseUrl !== undefined) Deno.env.set("SUPABASE_URL", savedSupabaseUrl);
    else Deno.env.delete("SUPABASE_URL");

    if (savedServiceRoleKey !== undefined) Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", savedServiceRoleKey);
    else Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");

    if (savedNodeEnv !== undefined) Deno.env.set("NODE_ENV", savedNodeEnv);
    else Deno.env.delete("NODE_ENV");
  }
});
