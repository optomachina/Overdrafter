import { createServer } from "node:http";
import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPrivatePlateHttp } from "../server/engineering/sample-plate-private";
import { newCapability } from "../server/engineering/sample-plate-dispatch";

const required = (name: string) => { const value = process.env[name]; if (!value) { throw new Error(`Missing ${name}`); } return value; };
const origin = required("OVD_PHONE_ORIGIN");
const privateRoot = required("OVD_PHONE_PAIRING_ROOT");
const capabilities = [newCapability(), newCapability()];
const handler = createPrivatePlateHttp({ origin, identity: required("OVD_PHONE_IDENTITY"), artifactRoot: required("OVD_SAMPLE_OUTPUT_ROOT"), staticRoot: path.resolve("dist-sample-plate"), capabilities });
const server = createServer(handler);
server.requestTimeout = 10_000; server.headersTimeout = 10_000;
server.listen(8092, "127.0.0.1", () => {
  if (!statSync(privateRoot).isDirectory()) throw new Error("Protected pairing directory required");
  for (const [index, label] of ["phone", "mac-verification"].entries()) {
    writeFileSync(path.join(privateRoot, `ovd579-${label}-pairing.json`), JSON.stringify({ url: `${origin}/sample-plate/#launch=${capabilities[index]}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() }), { mode: 0o600, flag: "wx" });
  }
  console.log("Private sample listener ready on loopback 8092. Pairing links saved privately; no CAD adapter is loaded.");
});
