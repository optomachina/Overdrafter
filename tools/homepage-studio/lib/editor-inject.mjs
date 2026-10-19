// Builds the trusted editor script that is injected into BASELINE previews only. The page runs in an
// opaque-origin sandbox with a CSP that allows inline script and nothing else, so the editor cannot load
// modules: the pure modules (field matcher, protocol) are concatenated in front of ui/page-editor.js.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const libDir = path.dirname(fileURLToPath(import.meta.url));
const PARTS = [path.join(libDir, "field-match.mjs"), path.join(libDir, "page-protocol.mjs"), path.join(libDir, "..", "ui", "page-editor.js")];
let cache = null;

export function stripModuleSyntax(src) {
  if (/^\s*import\s/m.test(src)) throw new Error("editor modules must not import");
  return src.replace(/^export\s+(?=(async\s+)?(function|const|let|class)\b)/gm, "");
}

export function editorSource() {
  if (!cache) cache = PARTS.map((p) => stripModuleSyntax(fs.readFileSync(p, "utf8"))).join("\n");
  return cache;
}

export function buildEditorScript(parentOrigin) {
  const src = "(function(){'use strict';var __OD_PARENT_ORIGIN__=" + JSON.stringify(String(parentOrigin)) + ";\n" + editorSource() + "\n})();";
  return src.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

export function injectEditor(html, parentOrigin) {
  const tag = '<script data-od-editor="1">' + buildEditorScript(parentOrigin) + "</script>";
  const i = html.lastIndexOf("</body>");
  return i >= 0 ? html.slice(0, i) + tag + html.slice(i) : html + tag;
}
