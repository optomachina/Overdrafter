// Deterministic, offline engine. Writes a small labelled placeholder asset or a
// trivially shortened copy candidate. Never claims to be model output.
import fs from "node:fs";
import path from "node:path";
import { EngineError, DEMO_LABEL } from "./errors.mjs";
import { splitSentences } from "../lint.mjs";

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export function demoAssetHtml({ section, prompt, tool }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Demo asset: ${esc(section.label)}</title>
<style>
:root{color-scheme:dark;--bg:#0E0E0D;--ink:#F2EFE8;--muted:#A8A397;--rule:#2C2B28;--accent:#F27A45;--fill:#181816}
@media (prefers-color-scheme:light){:root:not([data-theme="dark"]){color-scheme:light;--bg:#F2EFE8;--ink:#1C1B19;--muted:#5B5850;--rule:#D6D1C4;--accent:#C2410C;--fill:#E8E4D8}}
:root[data-theme="light"]{color-scheme:light;--bg:#F2EFE8;--ink:#1C1B19;--muted:#5B5850;--rule:#D6D1C4;--accent:#C2410C;--fill:#E8E4D8}
:root[data-theme="dark"]{color-scheme:dark;--bg:#0E0E0D;--ink:#F2EFE8;--muted:#A8A397;--rule:#2C2B28;--accent:#F27A45;--fill:#181816}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.tag{font:500 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);margin:0 0 8px}
h1{font-size:22px;margin:0 0 8px;letter-spacing:-.02em}
p{margin:0 0 12px;max-width:52ch}
.meta{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
figure{margin:20px 0;padding:16px;border:1px solid var(--rule);background:var(--fill)}
svg{display:block;width:100%;max-width:420px;height:auto}
.rule{stroke:var(--rule);stroke-width:1;fill:none}
.part{stroke:var(--ink);stroke-width:1.5;fill:none}
.acc{stroke:var(--accent);stroke-width:2;fill:none}
.dot{fill:var(--accent)}
@keyframes slide{0%,100%{transform:translateX(0)}50%{transform:translateX(26px)}}
.mover{animation:slide 4s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.mover{animation:none}}
</style>
</head>
<body>
<p class="tag">Demo engine</p>
<h1>${esc(section.label)}: placeholder figure</h1>
<p>This is a placeholder written by the ${DEMO_LABEL}. It exists so the studio works without a login.</p>
<figure role="img" aria-label="Placeholder figure: a bracket sliding along a rail. Sample data.">
<svg viewBox="0 0 240 120" aria-hidden="true">
<path class="rule" d="M10 100H230M10 20H230"/>
<g class="mover"><rect class="part" x="40" y="50" width="70" height="40"/><path class="acc" d="M40 70H110"/><circle class="dot" cx="75" cy="70" r="4"/></g>
</svg>
<figcaption class="meta">Sample data. Not a live quote.</figcaption>
</figure>
<p class="meta">Tool recorded: ${esc(tool)}. Prompt: ${esc(prompt).slice(0, 400) || "(none)"}</p>
<script>
(function(){
  try{var q=new URLSearchParams(location.search).get('theme');if(q==='dark'||q==='light')document.documentElement.setAttribute('data-theme',q)}catch(e){}
  addEventListener('message',function(ev){var d=ev.data;if(d&&d.type==='od-studio-theme'&&(d.theme==='dark'||d.theme==='light'))document.documentElement.setAttribute('data-theme',d.theme)});
})();
</script>
</body>
</html>
`;
}

export function demoShorten(text, instruction) {
  const wantsShort = /short|trim|tight|concise|brief|cut/i.test(instruction || "");
  if (!wantsShort) return null;
  const sentences = splitSentences(text);
  if (sentences.length > 1) return sentences.slice(0, -1).join(" ");
  const words = text.split(/\s+/);
  if (words.length > 6) return words.slice(0, Math.ceil(words.length * 0.75)).join(" ").replace(/[,;:]$/, "");
  return null;
}

export function createTemplateDemoEngine() {
  return {
    id: "template-demo",
    label: "Demo engine (offline)",
    description: `Deterministic placeholder output, ${DEMO_LABEL}.`,
    inline: true,
    usesSkills: false,
    demo: true,
    async available() {
      return { ok: true, message: "" };
    },
    async run(ctx) {
      ctx.onLog?.("demo engine: writing deterministic placeholder");
      if (ctx.kind === "asset") {
        await fs.promises.mkdir(ctx.outDir, { recursive: true });
        await fs.promises.writeFile(path.join(ctx.outDir, "index.html"), demoAssetHtml({ section: ctx.section, prompt: ctx.prompt, tool: ctx.tool?.label || "none" }));
        return { model: DEMO_LABEL, usage: null, demo: true };
      }
      const text = demoShorten(ctx.currentText, ctx.prompt);
      if (text === null || text === ctx.currentText) {
        throw new EngineError("failed", 'The demo engine can only shorten copy (try the word "shorter"). It cannot rewrite freely.');
      }
      return { text, model: DEMO_LABEL, usage: null, demo: true };
    },
  };
}
