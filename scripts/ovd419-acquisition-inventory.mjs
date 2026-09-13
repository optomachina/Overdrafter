import { createHash } from "node:crypto";
import { compareCodeUnits, TARGET } from "./ovd419-job-diagnostic.mjs";
import { parseBoundedSqlJson } from "./ovd419-acquisition-support/official-sql-wrapper.mjs";
import { ACQUISITION_LIMITS } from "./ovd419-acquisition-compatibility.mjs";

const reject = () => { throw new Error("acquisition_inventory_rejected"); };
function requireValue(value) { if (!value) reject(); }
function object(value) { requireValue(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype); }
function shape(value, required, optional = []) {
  object(value);
  requireValue(required.every(key => Object.hasOwn(value, key)));
  requireValue(Object.keys(value).every(key => required.includes(key) || optional.includes(key)));
}
function boundedText(value, max) {
  requireValue(typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value));
}

// UTC protobuf timestamps can retain nanoseconds. Do not truncate to JS milliseconds
// when choosing the newest Execution; equivalent fractional spellings compare equal.
function instant(value) {
  requireValue(typeof value === "string");
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  requireValue(match && !value.startsWith("0000-"));
  const milliseconds = Date.parse(`${match[1]}Z`);
  requireValue(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === `${match[1]}.000Z`);
  return BigInt(milliseconds) * 1000000n + BigInt((match[2] ?? "").padEnd(9, "0"));
}

function validateEntry(entry) {
  shape(entry, ["metadata", "status"]);
  const { metadata, status } = entry;
  shape(metadata, ["name", "uid", "creationTimestamp", "labels"]);
  requireValue(typeof metadata.name === "string" && /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(metadata.name));
  requireValue(metadata.name.startsWith(`${TARGET.job}-`));
  requireValue(typeof metadata.uid === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(metadata.uid));
  object(metadata.labels);
  const labels = Object.entries(metadata.labels);
  requireValue(labels.length <= 64 && Object.hasOwn(metadata.labels, "run.googleapis.com/job") && metadata.labels["run.googleapis.com/job"] === TARGET.job);
  for (const [key, value] of labels) {
    boundedText(key, 256);
    // Empty label values are supported metadata, not absent evidence.
    requireValue(typeof value === "string" && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/.test(value));
  }
  const created = instant(metadata.creationTimestamp);
  shape(status, ["completionTime"], ["runningCount"]);
  requireValue(!Object.hasOwn(status, "runningCount") || status.runningCount === 0);
  requireValue(instant(status.completionTime) >= created);
  return { name: metadata.name, uid: metadata.uid, created };
}

/**
 * Validate the pinned fullInventory projection and select an existing completed
 * Execution. Pure TEST_ONLY interpretation: raw bytes remain exact; a caller must
 * separately prove complete transport, freshness, request attribution and budgets.
 * No I/O, private-binding issuance or production execution is provided here.
 */
export function validateSyntheticAcquisitionInventory(raw, options) {
  try {
    shape(options, ["mode"]); requireValue(options.mode === "TEST_ONLY");
    const rows = parseBoundedSqlJson(raw, ACQUISITION_LIMITS.cloudResponseBytes);
    requireValue(Array.isArray(rows) && rows.length > 0 && rows.length <= ACQUISITION_LIMITS.maximumListRows);
    const names = new Set(), uids = new Set();
    let selected;
    for (const row of rows) {
      const item = validateEntry(row);
      requireValue(!names.has(item.name) && !uids.has(item.uid));
      names.add(item.name); uids.add(item.uid);
      if (!selected || item.created > selected.created || item.created === selected.created && compareCodeUnits(item.name, selected.name) < 0) selected = item;
    }
    return Object.freeze({
      schema: "OVD419-SYNTHETIC-INVENTORY-NOT-AUTHORITY-v1",
      raw, sha256: createHash("sha256").update(raw).digest("hex"),
      ids: Object.freeze([...names].sort(compareCodeUnits)),
      selected: Object.freeze({ name: selected.name, uid: selected.uid }),
      transportQualified: false, privateBindingReady: false,
    });
  } catch { reject(); }
}
