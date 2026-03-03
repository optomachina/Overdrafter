import type { OcctModule } from "occt-import-js";
import occtWasmUrl from "occt-import-js/dist/occt-import-js.wasm?url";

let occtModulePromise: Promise<OcctModule> | null = null;

export function getOcctImportModule(): Promise<OcctModule> {
  if (!occtModulePromise) {
    occtModulePromise = import("occt-import-js").then(({ default: occtImportJsFactory }) =>
      occtImportJsFactory({
        locateFile: (path) => (path.endsWith(".wasm") ? occtWasmUrl : path),
      }),
    );
  }

  return occtModulePromise;
}
