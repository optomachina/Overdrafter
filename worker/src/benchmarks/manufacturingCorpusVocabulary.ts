import { z } from "zod";

export const MANUFACTURING_PROCESS_FAMILIES = [
  "cnc_milling",
  "cnc_turning",
  "mill_turn",
  "sheet_metal",
  "additive_polymer",
  "additive_metal",
  "welding_fabrication",
  "casting",
  "injection_molding",
  "other",
] as const;

export const MANUFACTURING_QUALIFICATION_TARGETS = [
  "characterization_only",
  "broad_estimate",
] as const;

export const manufacturingProcessFamilySchema = z.enum(
  MANUFACTURING_PROCESS_FAMILIES,
);
export const manufacturingQualificationTargetSchema = z.enum(
  MANUFACTURING_QUALIFICATION_TARGETS,
);
export const manufacturingCorpusSourceClassSchema = z.enum([
  "synthetic",
  "public_standard",
  "open_license",
  "company_owned",
  "consented_customer",
]);
export const manufacturingCorpusArtifactClassSchema = z.enum([
  "cad_model",
  "drawing",
  "bom",
  "annotation",
  "quote_outcome",
  "other",
]);
export const manufacturingCorpusDataClassificationSchema = z.enum([
  "public",
  "internal",
  "confidential",
  "controlled",
]);
export const manufacturingCorpusRedistributionLevelSchema = z.enum([
  "internal_only",
  "metadata_only",
  "derived_noninvertible",
  "full_assets",
]);

export const manufacturingCorpusStableIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must be a stable lowercase identifier");
export const manufacturingCorpusOpaqueReferenceSchema = z
  .string()
  .trim()
  .min(1)
  .max(512);
export const manufacturingCorpusSha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 digest");
export const manufacturingCorpusUtcTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine(
    (value) => value.endsWith("Z"),
    "must be a UTC timestamp ending in Z",
  );

export type ManufacturingCorpusJsonValue =
  | boolean
  | number
  | string
  | null
  | ManufacturingCorpusJsonValue[]
  | { [key: string]: ManufacturingCorpusJsonValue };

interface JsonValidationFrame {
  exiting: boolean;
  value: unknown;
}

/** Safely checks arbitrary JavaScript input without allowing reflection traps to escape. */
export function manufacturingCorpusIsJsonValue(
  value: unknown,
): value is ManufacturingCorpusJsonValue {
  const activeContainers = new WeakSet<object>();
  const stack: JsonValidationFrame[] = [{ exiting: false, value }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) {
      return false;
    }

    const candidate = frame.value;
    if (candidate === null || typeof candidate === "string") {
      continue;
    }
    if (typeof candidate === "boolean") {
      continue;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        return false;
      }
      continue;
    }
    if (typeof candidate !== "object") {
      return false;
    }

    if (frame.exiting) {
      activeContainers.delete(candidate);
      continue;
    }
    if (activeContainers.has(candidate)) {
      return false;
    }

    try {
      const prototype = Object.getPrototypeOf(candidate);
      if (Array.isArray(candidate)) {
        if (prototype !== Array.prototype && prototype !== null) {
          return false;
        }
        for (let index = 0; index < candidate.length; index += 1) {
          if (!Object.hasOwn(candidate, index)) {
            return false;
          }
        }
        const arrayKeys = Reflect.ownKeys(candidate);
        if (
          arrayKeys.some(
            (key) => {
              if (key === "length") {
                return false;
              }
              if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) {
                return true;
              }
              return Number(key) >= candidate.length;
            },
          )
        ) {
          return false;
        }
      } else if (prototype !== Object.prototype && prototype !== null) {
        return false;
      }

      activeContainers.add(candidate);
      stack.push({ exiting: true, value: candidate });

      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (Array.isArray(candidate) && key === "length") {
          continue;
        }
        if (typeof key !== "string") {
          return false;
        }
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          return false;
        }
        stack.push({ exiting: false, value: descriptor.value });
      }
    } catch {
      return false;
    }
  }

  return true;
}

/** Accepts only finite, acyclic data that has an unambiguous JSON representation. */
export const manufacturingCorpusJsonValueSchema =
  z.custom<ManufacturingCorpusJsonValue>(manufacturingCorpusIsJsonValue, {
    message: "must be a finite serializable JSON value",
  });

/** Reports whether a list contains the same stable value more than once. */
export function manufacturingCorpusHasDuplicates(
  values: readonly string[],
): boolean {
  return new Set(values).size !== values.length;
}

export type ManufacturingProcessFamily = z.infer<
  typeof manufacturingProcessFamilySchema
>;
export type ManufacturingQualificationTarget = z.infer<
  typeof manufacturingQualificationTargetSchema
>;
export type ManufacturingCorpusSourceClass = z.infer<
  typeof manufacturingCorpusSourceClassSchema
>;
export type ManufacturingCorpusArtifactClass = z.infer<
  typeof manufacturingCorpusArtifactClassSchema
>;
export type ManufacturingCorpusDataClassification = z.infer<
  typeof manufacturingCorpusDataClassificationSchema
>;
export type ManufacturingCorpusRedistributionLevel = z.infer<
  typeof manufacturingCorpusRedistributionLevelSchema
>;
