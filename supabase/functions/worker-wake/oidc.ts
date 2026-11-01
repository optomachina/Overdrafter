const TOKEN_URL = "https://oauth2.googleapis.com/token";
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
export function workerOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".run.app") || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") {
    throw new Error("invalid worker origin");
  }
  return url.origin;
}
/** Exchange a server-held service account assertion for a Google-signed ID token. */
export async function mintIdToken(secret: string, audience: string, signal: AbortSignal, http: typeof fetch): Promise<string> {
  workerOrigin(audience);
  const account = JSON.parse(secret);
  if (account.type !== "service_account" || typeof account.client_email !== "string" || !account.client_email.endsWith(".iam.gserviceaccount.com") || typeof account.private_key !== "string") {
    throw new Error("invalid service account");
  }
  const pem = account.private_key.replace("-----BEGIN PRIVATE KEY-----", "").replace("-----END PRIVATE KEY-----", "").replace(/\s/g, "");
  const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: account.client_email, sub: account.client_email, aud: TOKEN_URL, target_audience: audience, iat: now, exp: now + 300 })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  signal.throwIfAborted();
  const response = await http(TOKEN_URL, {
    method: "POST", redirect: "error", signal,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${base64url(new Uint8Array(signature))}` }),
  });
  if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error("token unavailable"); }
  const result = await response.json();
  if (typeof result.id_token !== "string" || !result.id_token || /\s/.test(result.id_token)) throw new Error("token unavailable");
  return result.id_token;
}
