// Test driver: runs the browser probe under tsx, the way `npm run probe:session`
// does, so transform differences from vitest cannot hide page evaluation bugs.
import { runBoundedBrowserSessionProbe } from "../providerSessionProbe.js";

const [landingUrl, executablePath] = process.argv.slice(2);
const evidence = await runBoundedBrowserSessionProbe({
  target: { provider: "fictiv", adapterKind: "portal", landingUrl: null, allowedHosts: ["127.0.0.1"] },
  storageState: { cookies: [], origins: [] },
  sandbox: { playwrightDisableSandbox: true, playwrightDisableDevShmUsage: false },
  executablePath: executablePath || undefined,
  landingUrlOverride: landingUrl,
  allowLoopbackHttp: true,
  settleMs: 300,
});
console.log(JSON.stringify(evidence));
