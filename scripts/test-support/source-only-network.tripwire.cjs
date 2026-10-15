"use strict";

// Regression-test backstop, loaded BEFORE the guard under test. This deliberately
// narrower independent allowlist ensures a guard defect cannot create egress.
const net = require("node:net");
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : net._normalizeArgs(args);
  const options = normalized[0];
  if (!options.path && ![undefined, "localhost", "127.0.0.1", "::1"].includes(options.host)) {
    const error = new Error("Offline regression tripwire rejected a non-fixture socket");
    error.code = "ERR_OFFLINE_TRIPWIRE";
    throw error;
  }
  return Reflect.apply(original, this, args);
};
