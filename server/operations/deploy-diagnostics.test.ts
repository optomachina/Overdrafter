// @vitest-environment node

import { describe, expect, it } from "vitest";
import health from "../../api/health";
import {
  PRODUCTION_SUPABASE_REF,
  STAGING_SUPABASE_REF,
  createDeployDiagnosticsHandler,
  readDeployDiagnostics,
  supabaseProjectRef,
} from "./deploy-diagnostics";

const PROD_URL = `https://${PRODUCTION_SUPABASE_REF}.supabase.co`;
const STAGING_URL = `https://${STAGING_SUPABASE_REF}.supabase.co`;
const SECRET_SENTINELS = {
  SUPABASE_SERVICE_ROLE_KEY: "service-role-sentinel",
  SUPABASE_PUBLISHABLE_KEY: "publishable-sentinel",
  VITE_SUPABASE_PUBLISHABLE_KEY: "browser-publishable-sentinel",
};

async function get(environment: Record<string, string | undefined>) {
  const response = createDeployDiagnosticsHandler(environment)(new Request("https://app.example.com/api/health"));
  const body = await response.text();
  return { status: response.status, body, json: JSON.parse(body) };
}

describe("supabaseProjectRef", () => {
  it("derives the ref from a hosted Supabase URL", () => {
    expect(supabaseProjectRef(STAGING_URL)).toBe(STAGING_SUPABASE_REF);
    expect(supabaseProjectRef(`${PROD_URL}/rest/v1`)).toBe(PRODUCTION_SUPABASE_REF);
  });

  it.each([undefined, "", "not a url", "http://localhost:54321", "https://example.com", "https://abc.supabase.co"])(
    "reports no ref for %s",
    (url) => {
      expect(supabaseProjectRef(url)).toBeNull();
    },
  );
});

describe("deploy diagnostics", () => {
  it("never targets the production project from Preview", () => {
    expect(STAGING_SUPABASE_REF).not.toBe(PRODUCTION_SUPABASE_REF);
    expect(readDeployDiagnostics({ VERCEL_ENV: "preview" }).expectedSupabaseRef).toBe(STAGING_SUPABASE_REF);
  });

  it("reports the staging ref for a correctly wired Preview", async () => {
    const { status, json } = await get({
      VERCEL_ENV: "preview",
      SUPABASE_URL: STAGING_URL,
      VITE_SUPABASE_URL: STAGING_URL,
    });
    expect(status).toBe(200);
    expect(json).toEqual({
      service: "overdrafter-web",
      deployEnvironment: "preview",
      serverSupabaseRef: STAGING_SUPABASE_REF,
      browserSupabaseRef: STAGING_SUPABASE_REF,
      expectedSupabaseRef: STAGING_SUPABASE_REF,
      supabaseRefMatchesEnvironment: true,
    });
  });

  it("keeps Production on the production ref", async () => {
    const { status, json } = await get({ VERCEL_ENV: "production", SUPABASE_URL: PROD_URL, VITE_SUPABASE_URL: PROD_URL });
    expect(status).toBe(200);
    expect(json.serverSupabaseRef).toBe(PRODUCTION_SUPABASE_REF);
    expect(json.supabaseRefMatchesEnvironment).toBe(true);
  });

  it.each([
    ["Preview with production server URL", { VERCEL_ENV: "preview", SUPABASE_URL: PROD_URL, VITE_SUPABASE_URL: STAGING_URL }],
    ["Preview with production browser URL", { VERCEL_ENV: "preview", SUPABASE_URL: STAGING_URL, VITE_SUPABASE_URL: PROD_URL }],
    ["Preview with no server URL", { VERCEL_ENV: "preview", VITE_SUPABASE_URL: STAGING_URL }],
    ["Production with staging URLs", { VERCEL_ENV: "production", SUPABASE_URL: STAGING_URL, VITE_SUPABASE_URL: STAGING_URL }],
  ])("fails closed with 503 for %s", async (_label, environment) => {
    const { status, json } = await get(environment);
    expect(status).toBe(503);
    expect(json.supabaseRefMatchesEnvironment).toBe(false);
  });

  it("does not judge local or development environments", async () => {
    const { status, json } = await get({ SUPABASE_URL: PROD_URL });
    expect(status).toBe(200);
    expect(json.deployEnvironment).toBe("local");
    expect(json.supabaseRefMatchesEnvironment).toBeNull();
  });

  it("never echoes keys", async () => {
    const { body } = await get({ VERCEL_ENV: "preview", SUPABASE_URL: STAGING_URL, VITE_SUPABASE_URL: STAGING_URL, ...SECRET_SENTINELS });
    for (const sentinel of Object.values(SECRET_SENTINELS)) expect(body).not.toContain(sentinel);
  });

  it("rejects non-read methods", async () => {
    const response = createDeployDiagnosticsHandler({})(new Request("https://app.example.com/api/health", { method: "POST" }));
    expect(response.status).toBe(405);
  });

  it("exports the Web-standard fetch adapter expected by the Node runtime", () => {
    expect(health).toEqual({ fetch: expect.any(Function) });
  });
});
