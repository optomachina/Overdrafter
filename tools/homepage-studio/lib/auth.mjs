// Access control.
//  - local mode: loopback only (enforced by the request guard); no password.
//  - hosted mode: shared password -> HMAC-signed, HttpOnly, Secure, SameSite=Strict cookie.
//    Fails CLOSED: if STUDIO_PASSWORD or STUDIO_SESSION_SECRET is missing, everything is refused.
// The login rate limit is in-memory and best effort: serverless instances do not share
// memory, so it only slows guessing per warm instance. Vercel Authentication is the
// second layer (see HOSTING.md).
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export const COOKIE_NAME = "studio_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const NOT_CONFIGURED_MESSAGE =
  "Studio is not configured: set STUDIO_PASSWORD and STUDIO_SESSION_SECRET (at least 16 characters) in the hosting environment.";

const b64 = (buf) => Buffer.from(buf).toString("base64url");

export function signToken(payload, secret) {
  const body = b64(JSON.stringify(payload));
  const mac = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyToken(token, secret, nowMs = Date.now()) {
  if (typeof token !== "string" || !secret) return null;
  const i = token.indexOf(".");
  if (i < 1) return null;
  const body = token.slice(0, i);
  const mac = token.slice(i + 1);
  const expect = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || typeof payload.exp !== "number" || payload.exp <= nowMs) return null;
  return payload;
}

// Constant-time password comparison independent of length.
export function safeEqual(a, b, secret = "studio-compare") {
  const ha = createHmac("sha256", secret).update(String(a)).digest();
  const hb = createHmac("sha256", secret).update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function createAuth({ mode = "local", password = "", secret = "", now = () => Date.now(), ttlMs = SESSION_TTL_MS, maxFailures = 5, windowMs = 15 * 60_000 } = {}) {
  const configured = mode !== "hosted" || (!!password && secret.length >= 16);
  const failures = new Map(); // ip -> {count, resetAt}

  function limited(ip) {
    const f = failures.get(ip);
    if (!f) return false;
    if (f.resetAt <= now()) {
      failures.delete(ip);
      return false;
    }
    return f.count >= maxFailures;
  }
  function recordFailure(ip) {
    const f = failures.get(ip);
    if (!f || f.resetAt <= now()) failures.set(ip, { count: 1, resetAt: now() + windowMs });
    else f.count++;
  }

  const cookieAttrs = (maxAge) => `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

  return {
    mode,
    configured,
    notConfiguredMessage: NOT_CONFIGURED_MESSAGE,
    required: mode === "hosted",
    login(candidate, ip = "unknown") {
      if (!configured) return { ok: false, status: 503, message: NOT_CONFIGURED_MESSAGE };
      if (limited(ip)) return { ok: false, status: 429, message: "Too many failed attempts. Wait 15 minutes and try again." };
      if (typeof candidate !== "string" || !safeEqual(candidate, password, secret)) {
        recordFailure(ip);
        return { ok: false, status: 401, message: "Wrong password." };
      }
      failures.delete(ip);
      const iat = now();
      const token = signToken({ iat, exp: iat + ttlMs, n: randomBytes(8).toString("hex") }, secret);
      return { ok: true, setCookie: `${COOKIE_NAME}=${token}; ${cookieAttrs(Math.floor(ttlMs / 1000))}` };
    },
    logoutCookie() {
      return `${COOKIE_NAME}=; ${cookieAttrs(0)}`;
    },
    isAuthenticated(request) {
      if (mode !== "hosted") return true;
      if (!configured) return false;
      const token = parseCookies(request.headers.get("cookie"))[COOKIE_NAME];
      return verifyToken(token, secret, now()) !== null;
    },
  };
}
