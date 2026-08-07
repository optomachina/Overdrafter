declare module "occt-import-js" {
  export type OcctReadParams = {
    linearUnit?: "millimeter" | "centimeter" | "meter" | "inch" | "foot";
    linearDeflectionType?: "bounding_box_ratio" | "absolute_value";
    linearDeflection?: number;
    angularDeflection?: number;
  };

  export type OcctMesh = {
    name?: string;
    attributes: {
      position: { array: number[] };
      normal?: { array: number[] };
    };
    index: { array: number[] };
  };

  export type OcctReadResult = {
    success: boolean;
    meshes: OcctMesh[];
  };

  export type OcctModule = {
    ReadStepFile(content: Uint8Array, params?: OcctReadParams | null): OcctReadResult;
  };

  type OcctImportJsFactory = () => Promise<OcctModule>;

  const occtImportJsFactory: OcctImportJsFactory;
  export default occtImportJsFactory;
}
