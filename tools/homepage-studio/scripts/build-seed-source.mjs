// One-off helper kept for provenance: extracts copy from public/v9/index.html
// into data/seed.json. Re-run only when v9 copy changes. Read-only on public/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const html = fs.readFileSync(path.resolve(root, "../../public/v9/index.html"), "utf8");
const decode = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&middot;/g, "·").trim();
const grab = (re, label) => {
  const m = html.match(re);
  if (!m) throw new Error(`seed extraction failed: ${label}`);
  return decode(m[1]);
};
const h2 = (id) => grab(new RegExp(`<h2 id="${id}">([\\s\\S]*?)</h2>`), id);
const nth = (re, i, label) => {
  const all = [...html.matchAll(re)];
  if (!all[i]) throw new Error(`seed extraction failed: ${label}`);
  return decode(all[i][1]);
};

const sections = [
  { id: "hero", label: "Hero" },
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => ({ id: `ch${n}`, label: `Chapter ${n}` })),
  { id: "mission", label: "Mission" },
  { id: "roadmap", label: "Roadmap" },
  { id: "final", label: "Final CTA" },
];

// Capability phrases used by the "planned capability exists" lint rule.
const PHRASES = {
  text2cad: ["text to CAD"], cad2drawing: ["CAD to drawing"], fulfillment: ["fulfillment"], marketplace: ["marketplace"],
  "texttocad-controlyourcad": ["control your CAD seat"], "texttocad-controlanycad": ["control any CAD seat"],
  "texttocad-open-sourcecad": ["open-source CAD"], "texttocad-vrcad": ["VR CAD"],
  "drawings-drawingcreatio": ["drawing creation"], "drawings-drawingcheckin": ["drawing checking"],
  "drawings-datumselection": ["datum selection"], "drawings-viewselection": ["view selection"],
  "drawings-detailandsecti": ["detail and section views"], "sourcing-bestdealonstan": ["best deal on standardized hardware"],
  "analysis-toleranceanaly": ["tolerance analysis"], "analysis-everykindofana": ["every kind of analysis"],
  "analysis-cfd": ["CFD"], "analysis-dfm": ["DFM"], "analysis-dfa": ["DFA"],
  "build-assemblyinstru": ["assembly instructions"], "build-inspection": ["inspection"],
  "enterprise-pdm": ["PDM"], "enterprise-eco": ["ECO"], "enterprise-erpintegration": ["ERP integration"],
  "channels-chatbots": ["chat bots"], "channels-teamchat": ["team chat apps"],
  "product-providerexpans": ["provider expansion"], "product-teamprocuremen": ["team procurement"], "product-nativeapps": ["native apps"],
};
const LIVE_PHRASES = { specs: ["reads specs from drawings", "reads material"], quotes: ["quotes in parallel", "compared on price and lead time"] };

const capSrc = html.slice(html.indexOf("const CAPABILITIES="), html.indexOf("];", html.indexOf("const CAPABILITIES=")) + 2);
const capabilities = [...capSrc.matchAll(/\{id:'([^']+)'[^}]*?label:'([^']+)'[^}]*?status:'(live|planned)'/g)].map((m) => ({
  id: m[1], label: m[2], status: m[3], phrases: m[3] === "live" ? LIVE_PHRASES[m[1]] || [] : PHRASES[m[1]] || [],
}));
if (capabilities.length < 30) throw new Error("capability extraction failed");

const F = [];
const add = (sectionId, id, label, role, text, extra = {}) => F.push({ id: `${sectionId}-${id}`, sectionId, label, role, text, multiline: text.length > 70 || text.includes("\n"), ...extra });

const lockup = [...html.matchAll(/<span class="l(?: l3)?">([^<]+)<\/span>/g)].map((m) => m[1]).slice(0, 3).join("\n");
add("hero", "eyebrow", "Eyebrow", "eyebrow", grab(/<p class="eyebrow">([^<]+)<\/p>\s*<h1>/, "hero eyebrow"));
add("hero", "headline", "Headline lockup (one line per row)", "headline", lockup);
add("hero", "lede", "Lede", "body", grab(/<p class="lede">([\s\S]*?)<\/p>/, "lede"));
add("hero", "cta-primary", "Primary button label", "cta", grab(/<div class="cta-row"><a class="btn primary" href="\/">([^<]+)<\/a><a class="btn" href="#story">/, "cta1"));
add("hero", "cta-secondary", "Secondary button label", "cta", grab(/<a class="btn" href="#story">([^<]+)<\/a>/, "cta2"));
add("hero", "beta-note", "Beta note", "body", grab(/<p class="beta">([\s\S]*?)<\/p>/, "beta"));

const bands = [...html.matchAll(/<p class="bandtag"[^>]*>([^<]+)<\/p>\s*<h2 id="h-(\d)">/g)].map((m) => [m[2], decode(m[1])]);
const sents = [...html.matchAll(/<h2 id="h-(\d)">[\s\S]*?<\/h2>\s*<p class="sent">([\s\S]*?)<\/p>/g)].map((m) => [m[1], decode(m[2])]);
const bandMap = Object.fromEntries(bands);
const sentMap = Object.fromEntries(sents);
for (let n = 1; n <= 7; n++) {
  const s = `ch${n}`;
  add(s, "band", "Band tag", "eyebrow", n === 7 ? grab(/<p class="bandtag">(What you get[^<]*)<\/p>/, "band7") : bandMap[n]);
  add(s, "headline", "Headline", "headline", h2(`h-${n}`));
  add(s, "sentence", "Body sentence", "body", sentMap[n]);
}
for (let b = 0; b < 3; b++) {
  add("ch7", `beat${b + 1}-title`, `Beat ${b + 1} title`, "headline", nth(/<h3 class="bt">([^<]+)<\/h3>/g, b, "beat title"));
  add("ch7", `beat${b + 1}-body`, `Beat ${b + 1} body`, "body", nth(/<p class="bp">([\s\S]*?)<\/p>/g, b, "beat body"));
}

const promptSrc = html.slice(html.indexOf("{id:'c1-plate'"), html.indexOf("];", html.indexOf("{id:'c1-plate'")));
for (const m of promptSrc.matchAll(/\{id:'(c(\d)-[a-z]+)',\s*chapter:\d,\s*status:'(live|planned)'(?:,[^}]*?)?text:'([^']+)'\}/g)) {
  const [, pid, ch, status, text] = m;
  add(`ch${ch}`, `prompt-${pid.split("-")[1]}`, `Example prompt (${pid.split("-")[1]})`, "prompt", text, { status });
}
if (F.filter((f) => f.role === "prompt").length !== 10) throw new Error("expected 10 example prompts");

add("mission", "eyebrow", "Label", "eyebrow", grab(/<p class="eyebrow" id="h-mission">([^<]+)<\/p>/, "mission eyebrow"));
add("mission", "text", "Mission statement (a goal, not progress)", "body", grab(/<p class="mtext">([\s\S]*?)<\/p>/, "mission"));
add("roadmap", "band", "Band tag", "eyebrow", grab(/<p class="bandtag" style="color:var\(--muted\)">([^<]+)<\/p>/, "road band"));
add("roadmap", "headline", "Headline", "headline", h2("h-road"));
add("roadmap", "sentence", "Body sentence", "body", nth(/<h2 id="h-road">[\s\S]*?<\/h2>\s*<p class="sent">([\s\S]*?)<\/p>/g, 0, "road sent"));
const closing = grab(/<p class="closing">([\s\S]*?)<\/p>/, "closing");
add("final", "closing", "Closing statement (required wording)", "body", closing, { mustEqual: closing });
add("final", "headline", "Headline", "headline", grab(/<h2 style="margin-top:44px">([^<]+)<\/h2>/, "final h2"));
add("final", "cta-primary", "Primary button label", "cta", grab(/<div class="cta-row"><a class="btn primary" href="\/">([^<]+)<\/a><button class="btn" type="button" id="replay2">/, "final cta1"));
add("final", "cta-secondary", "Secondary button label", "cta", grab(/id="replay2">([^<]+)<\/button>/, "final cta2"));

const seed = {
  seededFrom: "public/v9/index.html",
  sections,
  baselines: ["v6", "v7", "v8", "v9"].map((v) => ({
    id: v, label: { v6: "v6 Drawing in, six quotes out", v7: "v7 Scroll story + roadmap wires", v8: "v8 Dialed-in scroll story", v9: "v9 Prompt bar + coming-soon panel" }[v],
    path: `../../public/${v}/index.html`,
  })),
  capabilities,
  fields: F,
};
fs.writeFileSync(path.join(root, "data/seed.json"), JSON.stringify(seed, null, 2) + "\n");
console.log(`seed.json: ${sections.length} sections, ${F.length} fields, ${capabilities.length} capabilities`);
