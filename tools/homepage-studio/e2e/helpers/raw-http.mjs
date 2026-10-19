// Raw node:http requests with full control over the request line and headers (Host, Origin, odd paths, huge bodies).
// fetch() normalises "../" and refuses to set Host, which are exactly the things the security specs need to send.
import http from "node:http";

export function rawRequest(baseUrl, { method = "GET", path = "/", headers = {}, body } = {}) {
  const u = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
