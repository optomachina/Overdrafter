import type { ProjectedCadGeometry } from "@/lib/cad-iso-thumbnail";

export type CadProjectionCache = {
  getOrCreate: (
    cacheKey: string,
    load: () => Promise<ProjectedCadGeometry>,
  ) => Promise<ProjectedCadGeometry>;
};

/**
 * Creates a least-recently-used cache for CAD thumbnail projections. Failed
 * loads are removed so later attempts can recover.
 */
export function createCadProjectionCache(capacity: number): CadProjectionCache {
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new Error("CAD projection cache capacity must be a positive integer.");
  }

  const entries = new Map<string, Promise<ProjectedCadGeometry>>();

  return {
    getOrCreate(cacheKey, load) {
      const existing = entries.get(cacheKey);
      if (existing !== undefined) {
        entries.delete(cacheKey);
        entries.set(cacheKey, existing);
        return existing;
      }

      const pending = load().catch((error: unknown) => {
        if (entries.get(cacheKey) === pending) {
          entries.delete(cacheKey);
        }
        throw error;
      });
      entries.set(cacheKey, pending);

      while (entries.size > capacity) {
        const oldestKey = entries.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        entries.delete(oldestKey);
      }

      return pending;
    },
  };
}
