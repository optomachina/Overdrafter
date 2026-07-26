import { z } from "zod";

/**
 * The extraction contract: what the model is asked for, and the shape it must
 * answer in. Kept separate from the orchestration so the prompt version can be
 * derived from this content rather than maintained by hand.
 */

export const EXTRACTION_SYSTEM_INSTRUCTION =
  "You extract structured title-block fields from engineering drawings. Return JSON only that matches the schema exactly.";

export const EXTRACTION_USER_INSTRUCTIONS = [
  "Extract raw manufacturing metadata from this engineering drawing.",
  "Return raw drawing truth only. Do not normalize or shorten text for quoting.",
  "Prefer explicit titled blocks such as DWG. NO., PART NUMBER, REV, TITLE, DESCRIPTION, MATERIAL, FINISH, and PROCESS.",
  "Reject approval names, dates, signoff blocks, standards/specs as part number, and stray isolated letters for revision.",
  "If a field is not visible, return null with low confidence.",
] as const;

export const modelFieldSchema = z.object({
  value: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  fieldSource: z.enum(["title_block", "note", "unknown"]),
  reasons: z.array(z.string()).max(8).default([]),
});

export const modelResponseSchema = z.object({
  partNumber: modelFieldSchema,
  revision: modelFieldSchema,
  description: modelFieldSchema,
  material: modelFieldSchema,
  finish: modelFieldSchema,
  process: modelFieldSchema,
  titleBlockSufficient: z.boolean().default(true),
});

export type ModelFieldResponse = z.infer<typeof modelFieldSchema>;
export type ParsedModelResponse = z.infer<typeof modelResponseSchema>;
