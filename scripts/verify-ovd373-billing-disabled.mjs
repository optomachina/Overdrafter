export const OVD373_BILLING_PROJECT_REF = "ozuatdcakezjtevztjlr";
export const BILLING_DISABLED_ERROR =
  "New subscriptions are unavailable during the free, invitation-only Founding Beta.";
const CHECKOUT_PROBE_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000000";

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

/**
 * Extracts and verifies the project binding from a legacy public Supabase JWT.
 * Signature verification is unnecessary here because the token is used only
 * as a public probe credential; the hosted gateway verifies it independently.
 *
 * @param {string} token Public legacy anon JWT.
 * @returns {string} Project ref embedded in the token.
 */
export function getProjectRefFromPublicJwt(token) {
  if (typeof token !== "string") {
    throw new Error("public JWT is missing");
  }
  const segments = token.trim().split(".");
  if (segments.length !== 3) {
    throw new Error("public JWT is malformed");
  }
  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(segments[1]));
  } catch {
    throw new Error("public JWT payload is malformed");
  }
  if (payload?.ref !== OVD373_BILLING_PROJECT_REF) {
    throw new Error("public JWT does not belong to the production project");
  }
  return payload.ref;
}

/**
 * Reads the public probe token from the committed environment example without
 * accepting alternate files or logging the token.
 *
 * @param {string} contents `.env.example` contents.
 * @returns {string} Validated public JWT.
 */
export function readPublicProbeJwt(contents) {
  const match = contents.match(/^VITE_SUPABASE_PUBLISHABLE_KEY="([^"]+)"$/m);
  if (!match) {
    throw new Error("public probe JWT is absent from .env.example");
  }
  getProjectRefFromPublicJwt(match[1]);
  return match[1];
}

/**
 * Probes the hosted Checkout boundary and accepts only the exact disabled
 * response emitted before auth, runtime configuration, or Stripe access.
 *
 * @param {{fetchImpl?: typeof fetch, publicJwt: string}} input Probe dependencies.
 * @returns {Promise<void>}
 */
export async function verifyHostedBillingDisabled({ fetchImpl = fetch, publicJwt } = {}) {
  getProjectRefFromPublicJwt(publicJwt);
  const response = await fetchImpl(
    `https://${OVD373_BILLING_PROJECT_REF}.supabase.co/functions/v1/billing-sessions`,
    {
      method: "POST",
      headers: {
        apikey: publicJwt,
        Authorization: `Bearer ${publicJwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "checkout",
        organizationId: CHECKOUT_PROBE_ORGANIZATION_ID,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`billing probe returned non-JSON status ${response.status}`);
  }
  if (response.status !== 503 || payload?.error !== BILLING_DISABLED_ERROR) {
    throw new Error(`billing probe did not prove the disabled boundary (status ${response.status})`);
  }
}

async function main() {
  const { readFile } = await import("node:fs/promises");
  const envContents = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  const publicJwt = readPublicProbeJwt(envContents);
  await verifyHostedBillingDisabled({ publicJwt });
  console.log("OVD-373 hosted billing-disabled verification passed.");
}

const isDirectExecution =
  /(?:^|[\\/])verify-ovd373-billing-disabled\.mjs$/.test(process.argv[1] ?? "");

if (isDirectExecution) {
  try {
    await main();
  } catch (error) {
    console.error(`OVD-373 hosted billing-disabled verification stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
