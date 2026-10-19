// Pure field-to-element matcher. Browser-safe, no imports: it is unit-tested here AND inlined
// into the editor script that runs inside the sandboxed page (see lib/editor-inject.mjs).
//
// fields:     [{ id, sectionId, text, alts?: string[] }]   (text = the text the page was built with;
//                                                            alts = other texts to try, e.g. later saved versions)
// candidates: [{ elementKey, text, order, sectionId? }]    (text actually found in the page)
// Result:     { mapping: { [fieldId]: elementKey }, unmatched: [fieldId], how: { [fieldId]: "exact"|"loose"|"alt" } }

export function normalizeText(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[  -​  　]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function looseText(s) {
  return normalizeText(s).replace(/[^\p{L}\p{N}]+/gu, "");
}

export function matchFields(fields, candidates) {
  const cands = candidates
    .map((c) => ({ ...c, n: normalizeText(c.text), l: looseText(c.text) }))
    .sort((a, b) => a.order - b.order);
  const used = new Set();
  const mapping = {};
  const how = {};

  const sectionOk = (c, f) => c.sectionId === undefined || c.sectionId === null || c.sectionId === f.sectionId;
  const take = (field, normFn, prop, label, altsOnly) => {
    const texts = altsOnly ? field.alts || [] : [field.text];
    for (let i = 0; i < texts.length; i++) {
      const want = normFn(texts[i]);
      if (!want) continue;
      const hit = cands.find((c) => !used.has(c.elementKey) && c[prop] === want && sectionOk(c, field));
      if (hit) {
        used.add(hit.elementKey);
        mapping[field.id] = hit.elementKey;
        how[field.id] = altsOnly ? "alt" : label;
        return true;
      }
    }
    return false;
  };

  // Primary texts before alternates (older saved versions) so an alternate never steals another field's element;
  // exact (after normalisation) before loose (punctuation and spacing ignored). Field order resolves duplicates.
  const passes = [[normalizeText, "n", "exact", false], [normalizeText, "n", "exact", true], [looseText, "l", "loose", false], [looseText, "l", "loose", true]];
  for (const [fn, prop, label, alt] of passes) for (const f of fields) if (!mapping[f.id]) take(f, fn, prop, label, alt);

  return { mapping, unmatched: fields.filter((f) => !mapping[f.id]).map((f) => f.id), how };
}
