/**
 * Agent-generated parts are ordinary jobs. They are marked only by job tags so
 * extraction, quoting, archive and delete run unchanged.
 *
 * Tags written by scripts/ingest-generated-part.mjs:
 *   - "source:generated"         always
 *   - "generator:<agent-name>"   e.g. generator:cad-monkey
 */
export const GENERATED_SOURCE_TAG = "source:generated";
export const GENERATOR_TAG_PREFIX = "generator:";

export type GeneratedPartInfo = { generator: string | null };

export function getGeneratedPartInfo(tags: readonly string[] | null | undefined): GeneratedPartInfo | null {
  if (!tags || !tags.includes(GENERATED_SOURCE_TAG)) {
    return null;
  }
  const generatorTag = tags.find((tag) => tag.startsWith(GENERATOR_TAG_PREFIX));
  const generator = generatorTag ? generatorTag.slice(GENERATOR_TAG_PREFIX.length).trim() : "";
  return { generator: generator.length > 0 ? generator : null };
}
