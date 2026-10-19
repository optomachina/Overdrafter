// Append-only checks over GET /api/project snapshots.
import { expect } from "@playwright/test";

const idsOf = (entity) => entity.versions.map((v) => v.id);

/** Every version id of `before` is still present, in the same order, and nothing earlier changed. */
export function expectAppendOnly(before, after) {
  const b = idsOf(before);
  const a = idsOf(after);
  expect(a.length, "version count never decreases").toBeGreaterThanOrEqual(b.length);
  expect(a.slice(0, b.length), "older versions keep their place").toEqual(b);
}
