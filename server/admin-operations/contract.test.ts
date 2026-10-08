import { describe, expect, it } from "vitest";
import { OPERATIONS_CATEGORIES, OPERATIONS_SCHEMA, OPERATIONS_SUMMARIES, parseOperationsSnapshot } from "../../src/features/operations/contract";
function fixture() {
  return { schema: OPERATIONS_SCHEMA, generatedAt: "2026-10-02T00:00:00.000Z", refreshAfterMs: 30000,
    items: OPERATIONS_CATEGORIES.map((category) => ({ key: `${category}:database`, category, subsystem: "database", provider: null,
      severity: "unknown", reasonCode: "source_unavailable", summary: OPERATIONS_SUMMARIES.source_unavailable,
      context: { build: null, model: null, runtime: null, adapterVersion: null, sessionEvidenceAgeDays: null, sessionEvidenceKind: null, taskType: null, taskStartedAt: null, taskCompletedAt: null, taskFailedAt: null },
      firstSeenAt: null, lastSeenAt: null, changedAt: null, lastCheckedAt: null,
      freshness: { state: "unknown", ageMs: null, maxAgeMs: null, expiresAt: null }, occurrenceCount: null, action: null })),
    counts: { healthy: 0, attention: 0, blocked: 0, unknown: 9 } };
}
describe("operations closed wire", () => {
  it("accepts complete unknown coverage without inventing evidence", () => expect(parseOperationsSnapshot(fixture()).items).toHaveLength(9));
  it.each(["summary", "key", "provider", "extra"])("rejects private text in %s", (field) => {
    const value = fixture(); Object.assign(value.items[0], { [field]: "private@example.test" });
    expect(() => parseOperationsSnapshot(value)).toThrow("Invalid operations response");
  });
  it("rejects unavailable evidence claiming healthy", () => {
    const value = fixture(); Object.assign(value.items[0], { severity: "healthy" });
    expect(() => parseOperationsSnapshot(value)).toThrow();
  });
  it("rejects invented future freshness and duplicate/missing categories", () => {
    const value = fixture(); value.items[1] = value.items[0];
    expect(() => parseOperationsSnapshot(value)).toThrow();
    const future = fixture(); Object.assign(future.items[0].freshness, { state: "fresh", ageMs: 0, maxAgeMs: 99999999, expiresAt: "2030-01-01T00:00:00.000Z" });
    expect(() => parseOperationsSnapshot(future)).toThrow();
  });
  it("allows bounded storage evidence age while authentication stays unknown", () => {
    const value = fixture(); const item = value.items.find((i) => i.category === "provider_session")!;
    Object.assign(item.context, { sessionEvidenceAgeDays: 1.25, sessionEvidenceKind: "storage_modified_age" });
    expect(parseOperationsSnapshot(value).items.find((i) => i.category === "provider_session")?.severity).toBe("unknown");
    Object.assign(item.context, { sessionEvidenceAgeDays: -1 });
    expect(() => parseOperationsSnapshot(value)).toThrow();
  });
});
