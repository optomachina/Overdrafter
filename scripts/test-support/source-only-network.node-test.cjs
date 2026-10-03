"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const path = require("node:path");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");

// A second, independent all-network tripwire below the guard. No negative probe
// in this process can contact a real target even if the tested guard regresses.
let reachedTransport = 0;
let transportArgs;
function tripwire(...args) {
  transportArgs = args;
  reachedTransport += 1;
  const error = new Error("Offline regression tripwire reached");
  error.code = "ERR_OFFLINE_TRIPWIRE";
  throw error;
}
net.Socket.prototype.connect = tripwire;
const originalHttpRequest = http.request;
for (const transport of [http, https]) {
  transport.request = tripwire;
  transport.get = tripwire;
}
tls.connect = tripwire;
const guardPath = path.resolve(__dirname, "source-only-network.cjs");
const tripwirePath = path.resolve(__dirname, "source-only-network.tripwire.cjs");
const guard = require(guardPath);
const blocked = { code: "ERR_SOURCE_ONLY_NETWORK" };
const external = "https://external.invalid/synthetic-test-only";

function expectSyncBlock(callback) {
  const before = reachedTransport;
  guard.expectBlocked(() => assert.throws(callback, blocked));
  assert.equal(reachedTransport, before, "blocked before any original transport");
}

function runChild(source, extraEnv = {}) {
  const result = spawnSync(process.execPath, ["-e", source], {
    encoding: "utf8",
    timeout: 15_000,
    env: { ...process.env, NODE_OPTIONS: `--require=${tripwirePath} --require=${guardPath}`, OVD_SOURCE_ONLY_NETWORK_MARKER: "", ...extraEnv },
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

test("rejects non-loopback addresses and accepts only literal loopback/localhost", () => {
  for (const host of ["external.invalid", "localhost.invalid", "localhost.", "0.0.0.0", "192.0.2.1", "::", "::ffff:192.0.2.1"]) {
    assert.equal(guard.isLoopbackHost(host), false, host);
  }
  for (const host of ["localhost", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]) {
    assert.equal(guard.isLoopbackHost(host), true, host);
  }
});

test("native fetch rejects URLs and Request instances before transport", async () => {
  for (const input of [external, new URL(external), new Request(external)]) {
    const before = reachedTransport;
    await guard.expectBlocked(() => assert.rejects(fetch(input), blocked));
    assert.equal(reachedTransport, before);
  }
});

test("HTTP/HTTPS request/get reject URL and options targets before originals", () => {
  for (const transport of [http, https]) {
    for (const method of ["request", "get"]) {
      for (const args of [[external], [new URL(external)], [{ hostname: "external.invalid", port: 443 }], ["http://127.0.0.1", { hostname: "external.invalid" }]]) {
        expectSyncBlock(() => transport[method](...args));
      }
    }
  }
});

test("all standard net entrypoints reject before DNS/connect, including normalized args", () => {
  for (const callback of [
    () => net.connect(443, "external.invalid"),
    () => net.createConnection({ host: "192.0.2.1", port: 443 }),
    () => new net.Socket().connect({ host: "external.invalid", port: 443, lookup: tripwire }),
    () => new net.Socket().connect(net._normalizeArgs([443, "external.invalid"])),
    () => tls.connect({ host: "external.invalid", port: 443 }),
    () => tls.connect(443, "external.invalid"),
  ]) expectSyncBlock(callback);
});

test("loopback delegates to originals instead of stubbing successful responses", () => {
  for (const callback of [
    () => http.request("http://127.0.0.1"),
    () => https.get("https://[::1]"),
    () => net.connect(80, "localhost"),
    () => new net.Socket().connect({ path: "/tmp/synthetic-only.sock" }),
  ]) assert.throws(callback, { code: "ERR_OFFLINE_TRIPWIRE" });
});

test("socket loopback names are canonicalized before DNS", () => {
  assert.throws(() => net.connect({ host: "[::1]", port: 443, lookup: tripwire }), { code: "ERR_OFFLINE_TRIPWIRE" });
  assert.equal(transportArgs[0].host, "::1");
  assert.throws(() => net.connect(443, "localhost"), { code: "ERR_OFFLINE_TRIPWIRE" });
  assert.equal(transportArgs[0].host, "127.0.0.1");
});

test("jsdom XHR and WebSocket block before creating requests", () => {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM("", { url: "http://127.0.0.1/" });
  try {
    guard.installBrowserGuards(dom.window);
    expectSyncBlock(() => new dom.window.XMLHttpRequest().open("GET", external));
    expectSyncBlock(() => new dom.window.WebSocket("wss://external.invalid"));
    const xhr = new dom.window.XMLHttpRequest();
    xhr.open("GET", "/local-fixture");
    xhr.abort();
  } finally {
    dom.window.close();
  }
});

test("explicit injected browser mocks remain usable", async () => {
  const target = { fetch: async () => new Response("original fixture") };
  guard.installBrowserGuards(target);
  const protectedFetch = target.fetch;
  target.fetch = async () => new Response("injected fixture");
  assert.equal(await (await target.fetch(external)).text(), "injected fixture");
  target.fetch = protectedFetch;
  await guard.expectBlocked(() => assert.rejects(target.fetch(external), blocked));
});

test("ESM built-in exports see the same guards", async () => {
  const module = await import("node:http");
  assert.notEqual(module.request, originalHttpRequest);
  expectSyncBlock(() => module.request(external));
});

test("preload survives a normal child process and worker-thread bootstrap", () => {
  const result = runChild(`
    const assert = require('node:assert/strict');
    const { Worker } = require('node:worker_threads');
    assert.ok(process[Symbol.for('overdrafter.source-only-network')]);
    const worker = new Worker("const { parentPort } = require('node:worker_threads'); parentPort.postMessage(Boolean(process[Symbol.for('overdrafter.source-only-network')]));", { eval: true });
    worker.on('message', active => assert.equal(active, true));
    worker.on('error', error => { throw error; });
  `);
  assert.equal(result.status, 0, result.stderr);
});

test("real synthetic loopback fetch, HTTP and socket fixtures still work", () => {
  const result = runChild(`
    const assert = require('node:assert/strict');
    const http = require('node:http');
    const net = require('node:net');
    (async () => {
      const server = http.createServer((request, response) => response.end('synthetic fixture'));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const url = 'http://127.0.0.1:' + server.address().port;
      try {
        assert.equal(await (await fetch(url)).text(), 'synthetic fixture');
        assert.equal(await new Promise((resolve, reject) => {
          http.get(url, response => { let body = ''; response.on('data', part => body += part); response.on('end', () => resolve(body)); }).on('error', reject);
        }), 'synthetic fixture');
        await new Promise((resolve, reject) => {
          const socket = net.connect({ port: server.address().port, host: 'localhost', lookup: () => { throw new Error('localhost must not resolve externally'); } });
          socket.on('connect', () => { socket.destroy(); resolve(); }); socket.on('error', reject);
        });
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
  assert.equal(result.status, 0, result.stderr);
});

test("native fetch cannot follow a loopback redirect to an external target", () => {
  const result = runChild(`
    const assert = require('node:assert/strict');
    const http = require('node:http');
    const guard = process[Symbol.for('overdrafter.source-only-network')];
    (async () => {
      const server = http.createServer((request, response) => {
        response.writeHead(302, { Location: 'http://external.invalid/synthetic-only' }); response.end();
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        await guard.expectBlocked(() => assert.rejects(fetch('http://127.0.0.1:' + server.address().port), error => error.cause?.code === 'ERR_SOURCE_ONLY_NETWORK'));
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `);
  assert.equal(result.status, 0, result.stderr);
});

test("even a caught unexpected outbound attempt forces a nonzero exit", () => {
  const result = runChild(`
    // The independent preload tripwire prevents egress even if the guard regresses.
    fetch('https://external.invalid/synthetic-only').catch(() => {});
  `);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected outbound attempt.*verification is not a pass/);
});

test("a swallowed child-process violation still fails the aggregate owner", () => {
  const result = runChild(`
    const { spawnSync } = require('node:child_process');
    spawnSync(process.execPath, ['-e', "fetch('https://external.invalid/synthetic-only').catch(() => {});"], { encoding: 'utf8' });
    // Deliberately ignore the child's nonzero exit. The shared marker must fail us.
  `);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /blocked across this run/);
});

test("a swallowed worker-thread violation still fails the aggregate owner", () => {
  const result = runChild(`
    const { Worker } = require('node:worker_threads');
    const worker = new Worker("fetch('https://external.invalid/synthetic-only').catch(() => {});", { eval: true });
    worker.on('error', () => {});
    worker.on('exit', () => {});
  `);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /blocked across this run/);
});

test("guard regression tests recorded no unexpected requests", () => {
  guard.assertNoUnexpectedNetwork();
});
