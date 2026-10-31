import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectFunctionEvents, DRAFTS_DIR, MIGRATIONS_DIR } from "./check-migration-function-collisions.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const promoted = readdirSync(join(root, MIGRATIONS_DIR)).filter((name) => /^\d+_ovd979u\d_.*\.sql$/.test(name));

// Pinned on purpose: a later OVD-979 unit must add itself here, so its review
// confirms that its draft was retired too.
const UNITS = ["u2", "u3", "u4", "u5"];

describe("OVD-979 drafts stay retired", () => {
  it("covers every promoted OVD-979 unit migration", () => {
    expect(promoted.map((name) => name.match(/ovd979(u\d)/)?.[1])).toEqual(UNITS);
  });

  it.each(UNITS)("keeps no forward or stored rollback copy of %s in the drafts folder", (unit) => {
    expect(existsSync(join(root, DRAFTS_DIR, `ovd-979${unit}.sql`))).toBe(false);
    expect(existsSync(join(root, DRAFTS_DIR, `ovd-979${unit}.rollback.sql`))).toBe(false);
  });

  // collectFunctionEvents skips rollback files, so a renamed rollback copy needs its own check.
  it("keeps no OVD-979 rollback copy in the drafts folder under any name", () => {
    const rollbacks = readdirSync(join(root, DRAFTS_DIR)).filter((name) => /^ovd-979.*\.rollback\.sql$/.test(name));
    expect(rollbacks).toEqual([]);
  });

  it("lets no OVD-979 draft define a function unless it is marked SUPERSEDED", () => {
    const live = collectFunctionEvents(root).filter((event) => event.kind === "draft" && /\/ovd-979/.test(event.file));
    expect(live.map((event) => `${event.file}: ${event.signature}`)).toEqual([]);
  });
});
