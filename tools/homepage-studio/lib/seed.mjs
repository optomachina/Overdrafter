// Create or top up a project from seed.json WITHOUT destroying versions.
import { newId } from "./ids.mjs";
import { SCHEMA_VERSION, assertValidProject } from "./schema.mjs";
import { assetIdFor } from "./ops.mjs";

export function seedProject(seed, existing = null, { now = () => new Date(), idGen = newId } = {}) {
  const p = existing ? structuredClone(existing) : { schema: SCHEMA_VERSION, createdAt: now().toISOString(), seededFrom: seed.seededFrom, fields: {}, assets: {} };
  p.sections = seed.sections.map((s) => ({ ...s }));
  p.baselines = seed.baselines.map((b) => ({ ...b }));
  p.capabilities = seed.capabilities.map((c) => ({ ...c }));
  for (const f of seed.fields) {
    const meta = { id: f.id, sectionId: f.sectionId, label: f.label, role: f.role, multiline: !!f.multiline };
    for (const k of ["status", "plannedContext", "mustEqual"]) if (f[k] !== undefined) meta[k] = f[k];
    if (p.fields[f.id]) {
      Object.assign(p.fields[f.id], meta);
      continue;
    }
    const id = idGen(now().getTime());
    p.fields[f.id] = {
      ...meta,
      versions: [
        {
          id, parentId: null, kind: "seed", text: f.text, prompt: "", tool: "none", engine: "none", model: "none",
          usage: null, note: `Seeded from ${seed.seededFrom}`, author: "human", createdAt: now().toISOString(),
        },
      ],
      currentVersionId: id,
      marks: [],
    };
  }
  for (const s of seed.sections) {
    const aid = assetIdFor(s.id);
    if (!p.assets[aid]) p.assets[aid] = { id: aid, sectionId: s.id, label: `${s.label} asset`, versions: [], currentVersionId: null, marks: [] };
  }
  return assertValidProject(p);
}
