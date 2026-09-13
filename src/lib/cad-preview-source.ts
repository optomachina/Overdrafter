/** Portable STEP input contract shared by verified server results and the viewer. */
export type CadPreviewSource = {
  cacheKey: string;
  fileName: string;
  loadStepBuffer: () => Promise<Uint8Array>;
};
