// Export helpers: copy.json and the markdown handoff note.
import { currentVersion, assetIdFor } from "./ops.mjs";

export function buildCopyJson(project, now = new Date()) {
  const sections = project.sections.map((s) => {
    const fields = {};
    for (const f of Object.values(project.fields).filter((x) => x.sectionId === s.id)) {
      const v = currentVersion(f);
      fields[f.id] = { label: f.label, text: v.text, versionId: v.id };
    }
    const asset = project.assets[assetIdFor(s.id)];
    const av = asset ? currentVersion(asset) : null;
    return { id: s.id, label: s.label, fields, asset: av ? { versionId: av.id, assetPath: av.assetPath, tool: av.tool, engine: av.engine } : null };
  });
  return { schema: 1, exportedAt: now.toISOString(), sections };
}

export function buildHandoffMarkdown(project, now = new Date()) {
  const data = buildCopyJson(project, now);
  const out = ["# Homepage Studio handoff", "", `Exported ${data.exportedAt}. Merge into a page by hand; the studio never writes into public/ or src/.`, ""];
  for (const s of data.sections) {
    out.push(`## ${s.label}`, "");
    for (const [id, f] of Object.entries(s.fields)) {
      out.push(`- **${f.label}** (\`${id}\`, copy version \`${f.versionId}\`)`, `  > ${f.text.replace(/\n/g, "\n  > ")}`);
    }
    out.push("", s.asset ? `Asset version: \`${s.asset.versionId}\` (${s.asset.engine}, ${s.asset.tool})` : "Asset version: none (baseline page only)", "");
  }
  return out.join("\n");
}
