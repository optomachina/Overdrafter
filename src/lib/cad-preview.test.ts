import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import occtImportJsFactory from "occt-import-js";

describe("STEP file triangulation", () => {
  it("triangulates the planar single-solid fixture (regression for OVD-668)", async () => {
    const fixturePath = path.resolve(
      process.cwd(),
      "worker/src/adapters/fixtures/occt-triangulation-planar-solid.step",
    );
    const stepContent = new Uint8Array(readFileSync(fixturePath));
    const wasmDir = path.resolve(process.cwd(), "node_modules/occt-import-js/dist");
    const occt = await occtImportJsFactory({
      locateFile: (file: string) => path.join(wasmDir, file),
    });

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
