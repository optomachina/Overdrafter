declare module "occt-import-js" {
  export type OcctLinearUnit = "millimeter" | "centimeter" | "meter" | "inch" | "foot";
  export type OcctLinearDeflectionType = "bounding_box_ratio" | "absolute_value";

  export type OcctReadParams = {
    linearUnit?: OcctLinearUnit;
    linearDeflectionType?: OcctLinearDeflectionType;
    linearDeflection?: number;
    angularDeflection?: number;
  };

  export type OcctMesh = {
    name?: string;
    color?: [number, number, number];
    attributes: {
      position: {
        array: number[];
      };
      normal?: {
        array: number[];
      };
    };
    index: {
      array: number[];
    };
  };

  export type OcctNode = {
    name?: string;
    meshes: number[];
    children: OcctNode[];
  };

  export type OcctReadResult = {
    success: boolean;
    root: OcctNode;
    meshes: OcctMesh[];
  };

  export type OcctModule = {
    ReadStepFile(content: Uint8Array, params?: OcctReadParams | null): OcctReadResult;
    ReadIgesFile(content: Uint8Array, params?: OcctReadParams | null): OcctReadResult;
    ReadBrepFile(content: Uint8Array, params?: OcctReadParams | null): OcctReadResult;
  };

  type OcctImportModuleConfig = {
    locateFile?: (path: string, prefix: string) => string;
  };

  type OcctImportJsFactory = (config?: OcctImportModuleConfig) => Promise<OcctModule>;

  const occtImportJsFactory: OcctImportJsFactory;

  export default occtImportJsFactory;
}
