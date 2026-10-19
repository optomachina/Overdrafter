// Request guard: loopback-only in local mode, same-origin everywhere (basic CSRF and
// DNS-rebinding protection). Operates on Web-standard Request objects.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function checkRequest(request, { mode = "local" } = {}) {
  const url = new URL(request.url);
  if (mode !== "hosted" && !LOOPBACK.has(url.hostname)) {
    return { status: 403, message: "Rejected: this studio only answers on the loopback address." };
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== url.origin) {
    return { status: 403, message: "Rejected: cross-origin request." };
  }
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const site = request.headers.get("sec-fetch-site");
    if (site && !["same-origin", "none"].includes(site)) {
      return { status: 403, message: "Rejected: cross-site request." };
    }
    const type = request.headers.get("content-type") || "";
    if (!/^application\/json\b/i.test(type)) {
      return { status: 415, message: "Content-Type must be application/json." };
    }
  }
  return null;
}
