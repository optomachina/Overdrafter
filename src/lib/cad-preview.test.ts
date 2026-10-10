import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getOcctImportModule } from "./occt-import";

describe("STEP file triangulation", () => {
  it("triangulates the planar single-solid fixture (regression for OVD-668)", async () => {
    const fixturePath = path.resolve(
      process.cwd(),
      "worker/src/adapters/fixtures/sendcutsend-planar-single-solid.step",
    );
    const stepContent = new Uint8Array(readFileSync(fixturePath));
    const occt = await getOcctImportModule();

    const result = occt.ReadStepFile(stepContent, {
      linearUnit: "millimeter",
      linearDeflectionType: "bounding_box_ratio",
      linearDeflection: 0.0025,
      angularDeflection: 0.35,
    });

    expect(result.success).toBe(true);
    expect(result.meshes.length).toBeGreaterThan(0);
    expect(result.meshes[0].attributes.position.array.length).toBeGreaterThan(0);
    expect(result.meshes[0].index.array.length).toBeGreaterThan(0);
  });
});
