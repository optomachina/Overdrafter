# Third-Party Attribution

## heerich

- Project: https://github.com/meodai/heerich
- Intended usage scope: ConceptsGallery experimental geometry rendering prototypes (non-production)
- Current integration surface: `src/concepts/set-3/PartPage.tsx`
- Notes: This repository currently uses mock `geometry_projection` style data in concept UI to validate interaction patterns.

## @google/model-viewer

- Project: https://github.com/google/model-viewer (npm `@google/model-viewer`, Apache-2.0)
- Intended usage scope: the lazy-loaded interactive 3D review (GLB) in the Jarvis web thread, and the planned AR launcher (OVD-904)
- Current integration surface: `src/features/jarvis/thread/model-loader.ts` (the only file that may import it; enforced by `src/features/jarvis/import-boundary.test.ts`)
- Notes: pinned to an exact version (`4.4.0`). Its peer dependency `three ^0.183` is met by the repository's existing `three`, so upgrading `three` past that range has to wait for a matching `@google/model-viewer` release. It loads only on demand through a dynamic `import()`.
