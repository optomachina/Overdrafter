import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateSyntheticAcquisitionInventory } from "./ovd419-acquisition-inventory.mjs";

const JOB = "overdrafter-xometry-auth-probe";
const options = { mode: "TEST_ONLY" };
const validate = (rows) => validateSyntheticAcquisitionInventory(JSON.stringify(rows), options);
function entry(suffix = "a", created = "2026-09-12T12:00:00Z") {
  return { metadata: { name: `${JOB}-${suffix}`, uid: `TEST_ONLY_${suffix}`,
    creationTimestamp: created, labels: { "run.googleapis.com/job": JOB } },
  status: { completionTime: "2026-09-12T12:01:00Z", runningCount: 0 } };
}

describe("synthetic complete acquisition inventory", () => {
  it("retains exact accepted bytes and returns immutable selection without authority", () => {
    const raw = `\n ${JSON.stringify([entry()], null, 2)}\n`;
    const result = validateSyntheticAcquisitionInventory(raw, options);
    expect(result.raw).toBe(raw);
    expect(result.sha256).toBe(createHash("sha256").update(raw).digest("hex"));
    expect(result.ids).toEqual([`${JOB}-a`]);
    expect(result.selected).toEqual({ name: `${JOB}-a`, uid: "TEST_ONLY_a" });
    expect(result.schema).toBe("OVD419-SYNTHETIC-INVENTORY-NOT-AUTHORITY-v1");
    expect(result.transportQualified).toBe(false);
    expect(result.privateBindingReady).toBe(false);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.ids)).toBe(true);
    expect(Object.isFrozen(result.selected)).toBe(true);
  });

  it("chooses newest creation time, preserving nanosecond distinctions", () => {
    const rows = [entry("a", "2026-09-12T12:00:00.000000001Z"), entry("z", "2026-09-12T12:00:00.000000002Z")];
    expect(validate(rows).selected.name).toBe(`${JOB}-z`);
    expect(validate(rows.reverse()).selected.name).toBe(`${JOB}-z`);
  });
  it("uses ascending code-unit name for equal instants, independent of response order", () => {
    const rows = [entry("z", "2026-09-12T12:00:00.000Z"), entry("a")];
    expect(validate(rows).selected.name).toBe(`${JOB}-a`);
    expect(validate(rows.reverse()).selected.name).toBe(`${JOB}-a`);
    expect(validate(rows).ids).toEqual([`${JOB}-a`, `${JOB}-z`]);
  });
  it("accepts omitted zero runningCount without altering accepted bytes", () => {
    const row = entry(); delete row.status.runningCount;
    expect(validate([row]).raw).toBe(JSON.stringify([row]));
  });
  it("accepts at most 1000 complete entries and never the 1001 sentinel", () => {
    const rows = Array.from({ length: 1000 }, (_, i) => entry(`s${i}`));
    expect(validate(rows).ids).toHaveLength(1000);
    rows.push(entry("sentinel"));
    expect(() => validate(rows)).toThrow("acquisition_inventory_rejected");
  });
  it("preserves additional label metadata in the bound bytes", () => {
    const row = entry(); row.metadata.labels["example.test/key"] = "TEST_ONLY";
    expect(validate([row]).raw).toBe(JSON.stringify([row]));
  });
  it("binds UID and status changes even when selected names match", () => {
    const row = entry(), before = validate([row]);
    row.metadata.uid = "TEST_ONLY_different";
    expect(validate([row]).sha256).not.toBe(before.sha256);
    row.metadata.uid = "TEST_ONLY_a";
    row.status.completionTime = "2026-09-12T12:02:00Z";
    expect(validate([row]).sha256).not.toBe(before.sha256);
  });
  it.each([
    ["empty", []], ["object wrapper", { items: [entry()] }], ["null", null],
    ["duplicate name", [entry(), { ...entry(), metadata: { ...entry().metadata, uid: "TEST_ONLY_b" } }]],
    ["duplicate UID", [entry(), { ...entry("b"), metadata: { ...entry("b").metadata, uid: "TEST_ONLY_a" } }]],
  ])("rejects %s inventories without an absence fallback", (_, rows) => {
    expect(() => validate(rows)).toThrow("acquisition_inventory_rejected");
  });

  const mutations = [
    ["unknown top key", r => { r.extra = true; }],
    ["missing metadata", r => { delete r.metadata; }],
    ["unknown metadata key", r => { r.metadata.generation = 1; }],
    ["missing UID", r => { delete r.metadata.uid; }],
    ["invalid UID", r => { r.metadata.uid = "secret\nvalue"; }],
    ["foreign execution", r => { r.metadata.name = "other-job-a"; }],
    ["missing name suffix", r => { r.metadata.name = `${JOB}-`; }],
    ["invalid name", r => { r.metadata.name = `${JOB}-$(id)`; }],
    ["missing labels", r => { delete r.metadata.labels; }],
    ["foreign job label", r => { r.metadata.labels["run.googleapis.com/job"] = "another"; }],
    ["label object", r => { r.metadata.labels.other = {}; }],
    ["label controls", r => { r.metadata.labels.other = "x\ny"; }],
    ["too many labels", r => { for (let i = 0; i < 64; i++) r.metadata.labels[`k${i}`] = "v"; }],
    ["missing creation", r => { delete r.metadata.creationTimestamp; }],
    ["invalid calendar", r => { r.metadata.creationTimestamp = "2026-02-30T00:00:00Z"; }],
    ["year zero", r => { r.metadata.creationTimestamp = "0000-01-01T00:00:00Z"; }],
    ["invalid hour", r => { r.metadata.creationTimestamp = "2026-09-12T24:00:00Z"; }],
    ["extra precision", r => { r.metadata.creationTimestamp = "2026-09-12T12:00:00.0000000001Z"; }],
    ["date only", r => { r.metadata.creationTimestamp = "2026-09-12"; }],
    ["unsupported timezone", r => { r.metadata.creationTimestamp = "2026-09-12T12:00:00+00:00"; }],
    ["missing status", r => { delete r.status; }],
    ["unknown status key", r => { r.status.nextPageToken = "another"; }],
    ["missing completion", r => { delete r.status.completionTime; }],
    ["null completion", r => { r.status.completionTime = null; }],
    ["completion before creation", r => { r.status.completionTime = "2026-09-12T11:59:59.999999999Z"; }],
    ["nanosecond completion before creation", r => { r.metadata.creationTimestamp = "2026-09-12T12:00:00.000000002Z"; r.status.completionTime = "2026-09-12T12:00:00.000000001Z"; }],
    ["invalid completion", r => { r.status.completionTime = "2026-13-01T00:00:00Z"; }],
    ["active", r => { r.status.runningCount = 1; }],
    ["negative", r => { r.status.runningCount = -1; }],
    ["string count", r => { r.status.runningCount = "0"; }],
    ["null count", r => { r.status.runningCount = null; }],
  ];
  it.each(mutations)("rejects %s with a fixed sanitized error", (_, change) => {
    const row = entry(); change(row);
    expect(() => validate([row])).toThrow(/^acquisition_inventory_rejected$/);
  });
  it.each([
    ['"runningCount":0', '"runningCount":0,"runningCount":0'],
    ['"uid":"TEST_ONLY_a"', '"uid":"TEST_ONLY_a","\\u0075id":"TEST_ONLY_a"'],
  ])("rejects duplicate decoded keys %s", (key, replacement) => {
    const raw = JSON.stringify([entry()]).replace(key, replacement);
    expect(() => validateSyntheticAcquisitionInventory(raw, options)).toThrow("acquisition_inventory_rejected");
  });
  it.each([undefined, {}, { mode: "PRODUCTION" }, { mode: "TEST_ONLY", complete: true }])("rejects unsupported qualification %j", option => {
    expect(() => validateSyntheticAcquisitionInventory(JSON.stringify([entry()]), option)).toThrow("acquisition_inventory_rejected");
  });
  it("rejects non-string and over-limit raw responses", () => {
    expect(() => validateSyntheticAcquisitionInventory([entry()], options)).toThrow("acquisition_inventory_rejected");
    const raw = `${JSON.stringify([entry()])}${" ".repeat(4194304)}`;
    expect(() => validateSyntheticAcquisitionInventory(raw, options)).toThrow("acquisition_inventory_rejected");
  });
});
