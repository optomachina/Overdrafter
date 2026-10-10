"use strict";

// Test-only transport guard. Preload with NODE_OPTIONS=--require=<absolute path>.
// This is a cooperative Node/jsdom guard, not an OS sandbox; see the adjacent README.
const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const { URL, urlToHttpOptions } = require("node:url");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");

const stateKey = Symbol.for("overdrafter.source-only-network");
if (process[stateKey]) {
  module.exports = process[stateKey];
} else {
  const expectedBlocks = new AsyncLocalStorage();
  const violations = [];
  const markerEnvironmentKey = "OVD_SOURCE_ONLY_NETWORK_MARKER";
  const markerPath = process.env[markerEnvironmentKey] || path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "ovd-source-only-network-")), "violations.log",
  );
  if (!process.env[markerEnvironmentKey]) fs.writeFileSync(markerPath, "", { flag: "wx" });
  process.env[markerEnvironmentKey] = markerPath;

  function runViolationCount() {
    const contents = fs.readFileSync(markerPath, "utf8");
    if (!/^(blocked\n)*$/.test(contents)) throw new Error("Source-only network marker is invalid");
    return contents.length / "blocked\n".length;
  }
  runViolationCount(); // Fail closed if an inherited marker is absent/unreadable.
  const guardedFunctions = new WeakSet();

  function deny(transport) {
    // Never include a URL, query, headers, or credentials in the error/log.
    const error = new Error(`Source-only verification blocked non-loopback ${transport}. Use an explicit mock or a synthetic loopback fixture.`);
    error.code = "ERR_SOURCE_ONLY_NETWORK";
    if (!expectedBlocks.getStore()) {
      violations.push(error);
      // One synchronous O_APPEND write per violation; no URLs or credentials.
      // Children/Workers cannot hide a caught denial by having their exit ignored.
      fs.appendFileSync(markerPath, "blocked\n", { flag: "a" });
    }
    throw error;
  }

  function normalizeHost(host) {
    return String(host ?? "localhost").toLowerCase().replace(/^\[|\]$/g, "");
  }

  function isLoopbackHost(host) {
    const value = normalizeHost(host);
    if (value === "localhost" || value === "::1") return true;
    if (net.isIPv4(value)) return value.startsWith("127.");
    if (net.isIPv6(value)) {
      // URL canonicalization handles expanded IPv6 and IPv4-mapped forms.
      const canonical = new URL(`http://[${value}]/`).hostname;
      if (canonical === "[::1]") return true;
      const mapped = /^\[::ffff:([0-9a-f]+):[0-9a-f]+\]$/.exec(canonical);
      return Boolean(mapped && (Number.parseInt(mapped[1], 16) >>> 8) === 127);
    }
    return false;
  }

  function assertHost(host, transport) {
    if (!isLoopbackHost(host)) deny(transport);
  }

  function assertUrl(input, transport, base) {
    const value = typeof input === "object" && input !== null && "url" in input ? input.url : input;
    const url = new URL(String(value), base);
    if (url.protocol === "data:" || url.protocol === "blob:") return;
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) deny(transport);
    assertHost(url.hostname, transport);
  }

  function wrap(object, key, makeWrapper) {
    const original = object?.[key];
    if (typeof original !== "function" || guardedFunctions.has(original)) return;
    const wrapped = makeWrapper(original);
    guardedFunctions.add(wrapped);
    object[key] = wrapped;
  }

  function localSocketOptions(options, transport) {
    // Unix-domain IPC stays available for the test runner and local fixtures.
    if (options.path) return options;
    assertHost(options.host ?? options.hostname, transport);
    const result = { ...options };
    result.host = normalizeHost(result.host ?? result.hostname);
    if (result.host === "localhost") {
      // Pin localhost before DNS, ignoring custom resolvers that could redirect it.
      result.host = result.family === 6 ? "::1" : "127.0.0.1";
    }
    return result;
  }

  wrap(net.Socket.prototype, "connect", (original) => function (...args) {
    // Node's HTTP/HTTPS and undici transports also reach this final JS boundary.
    const normalized = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
    const options = localSocketOptions(normalized[0], "socket connection");
    return Reflect.apply(original, this, normalized[1] ? [options, normalized[1]] : [options]);
  });

  for (const [transport, protocol] of [[http, "http:"], [https, "https:"]]) {
    for (const method of ["request", "get"]) {
      wrap(transport, method, (original) => function (...args) {
        const first = args[0];
        const isUrl = typeof first === "string" || first instanceof URL;
        const options = isUrl
          ? { ...urlToHttpOptions(new URL(first)), ...(typeof args[1] === "object" ? args[1] : {}) }
          : { ...first };
        if (!options.socketPath) assertHost(options.hostname ?? options.host, `${protocol} request`);
        // Check the target before custom agents, DNS resolution, or any write.
        return Reflect.apply(original, this, args);
      });
    }
  }

  // TLS supplied an existing socket does not pass through Socket.connect again.
  wrap(tls, "connect", (original) => function (...args) {
    let options;
    if (typeof args[0] === "object") options = args[0];
    else {
      options = { port: args[0], ...(typeof args[1] === "string" ? { host: args[1] } : {}) };
      for (const arg of args.slice(1)) if (arg && typeof arg === "object") Object.assign(options, arg);
    }
    if (!options.path) assertHost(options.host ?? options.socket?.remoteAddress, "TLS connection");
    return Reflect.apply(original, this, args);
  });

  function installBrowserGuards(target = globalThis) {
    const base = target.location?.href;
    wrap(target, "fetch", (original) => async function (...args) {
      assertUrl(args[0], "fetch", base);
      return Reflect.apply(original, this, args);
    });
    wrap(target.XMLHttpRequest?.prototype, "open", (original) => function (method, url, ...args) {
      assertUrl(url, "XMLHttpRequest", base);
      return Reflect.apply(original, this, [method, url, ...args]);
    });
    for (const key of ["WebSocket", "EventSource"]) {
      wrap(target, key, (original) => new Proxy(original, {
        construct(constructor, args, newTarget) {
          assertUrl(args[0], key, base);
          return Reflect.construct(constructor, args, newTarget);
        },
      }));
    }
    wrap(target.navigator, "sendBeacon", (original) => function (...args) {
      assertUrl(args[0], "sendBeacon", base);
      return Reflect.apply(original, this, args);
    });
  }

  const api = {
    installBrowserGuards,
    isLoopbackHost,
    // Only guard regression tests should mark a deliberate negative probe expected.
    expectBlocked: (callback) => expectedBlocks.run(true, callback),
    violationCount: runViolationCount,
    assertNoUnexpectedNetwork() {
      const count = runViolationCount();
      if (count) throw new AggregateError([...violations], `${count} unexpected network attempt(s) blocked across this source-only verification run`);
    },
  };
  process[stateKey] = api;
  module.exports = api;
  installBrowserGuards();
  syncBuiltinESMExports();
  // Caught network errors still invalidate verification, including worker exits.
  process.on("exit", () => {
    try {
      const count = runViolationCount();
      if (count) {
        process.stderr.write(`[source-only-network] ${count} unexpected outbound attempt(s) blocked across this run; verification is not a pass.\n`);
        process.exitCode = 1;
      }
    } catch {
      process.stderr.write("[source-only-network] Violation marker unavailable/invalid; verification is not a pass.\n");
      process.exitCode = 1;
    }
  });
}
