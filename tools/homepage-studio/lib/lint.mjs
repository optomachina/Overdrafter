// Copy lint: rules are data (RULES) plus checks. Pure and browser-safe (the UI
// imports this file). Source of the rules: docs/product-vision.md "Public wording rules".
// ERRORS block a save outright. WARNINGS can be saved with "Save anyway".

export const MISSION_EXACT =
  "by 10% through creative and efficient deployment of engineering resources";

export const BRAND_NAMES = [
  // Case-insensitive.
  "SolidWorks", "Slack", "Cursor", "Xometry", "Protolabs", "Fictiv", "Onshape", "Autodesk",
  "Fusion 360", "CATIA", "Siemens", "Proto Labs",
];
// Capitalised common words: matched case-sensitively as whole words.
export const BRAND_NAMES_CASE_SENSITIVE = ["Teams", "Meta"];

export const SUPERLATIVES = [
  "best", "fastest", "cheapest", "greatest", "most", "leading", "world-class", "unmatched",
  "perfect", "ultimate", "unrivaled", "unrivalled", "number one", "#1",
];

export const HEDGE_RE =
  /coming soon|planned|intend|intention|goal|example prompt|not available|not a feature|unpowered|not commitments/i;

export const MAX_SENTENCE_WORDS = 25;

export const RULES = [
  { id: "year", severity: "error", rule: 3, text: "No dates or years (2026 to 2039)." },
  { id: "quarter", severity: "error", rule: 3, text: "No quarters (Q1 to Q4)." },
  { id: "timing-word", severity: "error", rule: 3, text: '"next", "later" and "next year" are not allowed as timing.' },
  { id: "percent", severity: "error", rule: 3, text: "No percentages, except the mission's exact 10% sentence." },
  { id: "brand", severity: "error", rule: 4, text: "No third-party brand or product names." },
  { id: "bare-live", severity: "error", rule: 1, text: '"Live" must read "Live in Founding Beta".' },
  { id: "coming-soon-on-live", severity: "error", rule: 2, text: '"Coming soon" cannot label a live capability.' },
  { id: "planned-claim", severity: "error", rule: 4, text: "Never imply a planned capability exists." },
  { id: "closing-statement", severity: "error", rule: 6, text: "The closing statement is required, word for word." },
  { id: "long-sentence", severity: "warning", rule: 0, text: `Sentences over ${MAX_SENTENCE_WORDS} words are hard to scan.` },
  { id: "soon-word", severity: "warning", rule: 3, text: '"soon" is only allowed inside "Coming soon".' },
  { id: "superlative", severity: "warning", rule: 0, text: "Superlatives need evidence; avoid them." },
];

export function splitSentences(text) {
  return String(text)
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function phraseRegex(phrase) {
  const acronym = phrase === phrase.toUpperCase() && /[A-Z]/.test(phrase);
  return new RegExp(`\\b${esc(phrase)}\\b`, acronym ? "" : "i");
}

/**
 * ctx: {
 *   capabilities: [{id,label,status,phrases?:string[]}],
 *   fieldStatus?: "live"|"planned",   // status of the capability this field describes
 *   plannedContext?: boolean,         // whole field is already labelled planned (example prompt)
 *   mustEqual?: string                // required exact text
 * }
 */
export function lintCopy(text, ctx = {}) {
  const errors = [];
  const warnings = [];
  const add = (list, rule, message, match) => list.push({ rule, message, match: match || "" });
  const t = String(text ?? "");

  if (ctx.mustEqual !== undefined && t.trim() !== ctx.mustEqual) {
    add(errors, "closing-statement", `This field must read exactly: "${ctx.mustEqual}"`, t.trim());
  }

  const y = t.match(/\b20(2[6-9]|3[0-9])\b/);
  if (y) add(errors, "year", `Remove the date or year "${y[0]}". Public copy carries no dates.`, y[0]);
  const q = t.match(/\bQ[1-4]\b/);
  if (q) add(errors, "quarter", `Remove the quarter "${q[0]}". Public copy carries no timelines.`, q[0]);
  const ny = t.match(/\bnext year\b/i);
  if (ny) add(errors, "timing-word", `Remove "${ny[0]}". "Coming soon" is the only timing word.`, ny[0]);
  else {
    const w = t.match(/\bnext\b(?!\s+to\b)|\blater\b/i);
    if (w) add(errors, "timing-word", `Remove "${w[0]}" used as timing. "Coming soon" is the only timing word.`, w[0]);
  }

  const withoutMission = t.split(MISSION_EXACT).join(" ");
  const pct = withoutMission.match(/\d+(?:\.\d+)?\s?(?:%|percent\b)/i);
  if (pct) add(errors, "percent", `Remove the percentage "${pct[0]}". Only the mission's exact 10% sentence may carry one.`, pct[0]);

  for (const b of BRAND_NAMES) {
    if (new RegExp(`\\b${esc(b)}\\b`, "i").test(t)) {
      add(errors, "brand", `Remove the third-party name "${b}". Use generic wording.`, b);
    }
  }
  for (const b of BRAND_NAMES_CASE_SENSITIVE) {
    if (new RegExp(`\\b${b}\\b`).test(t)) add(errors, "brand", `Remove the third-party name "${b}". Use generic wording.`, b);
  }

  const live = t.match(/\bLive\b(?! in Founding Beta)/);
  if (live) add(errors, "bare-live", 'Write "Live in Founding Beta", never a bare "Live".', live[0]);

  const caps = ctx.capabilities || [];
  const sentences = splitSentences(t);

  if (ctx.fieldStatus === "live" && /coming soon/i.test(t)) {
    add(errors, "coming-soon-on-live", '"Coming soon" is attached to a capability that is live in Founding Beta.', "Coming soon");
  }
  for (const s of sentences) {
    if (!/coming soon/i.test(s)) continue;
    for (const c of caps.filter((x) => x.status === "live")) {
      for (const p of c.phrases || []) {
        if (phraseRegex(p).test(s)) {
          add(errors, "coming-soon-on-live", `"Coming soon" is attached to "${c.label}", which is live in Founding Beta.`, s);
        }
      }
    }
  }

  if (!ctx.plannedContext) {
    for (const s of sentences) {
      if (HEDGE_RE.test(s)) continue;
      for (const c of caps.filter((x) => x.status === "planned")) {
        for (const p of c.phrases || []) {
          if (phraseRegex(p).test(s)) {
            add(errors, "planned-claim", `This sentence implies "${c.label}" exists. Planned items must be labelled "Coming soon".`, s);
          }
        }
      }
    }
  }

  for (const s of sentences) {
    const words = s.split(/\s+/).filter(Boolean).length;
    if (words > MAX_SENTENCE_WORDS) add(warnings, "long-sentence", `A sentence has ${words} words (over ${MAX_SENTENCE_WORDS}).`, s);
  }
  if (/\bsoon\b/i.test(t.replace(/coming soon/gi, ""))) {
    add(warnings, "soon-word", 'Use "soon" only inside "Coming soon".', "soon");
  }
  for (const w of SUPERLATIVES) {
    if (new RegExp(w.startsWith("#") ? esc(w) : `\\b${esc(w)}\\b`, "i").test(t)) {
      add(warnings, "superlative", `"${w}" is a superlative. Make sure it is true and evidenced.`, w);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function lintContextForField(project, field) {
  return {
    capabilities: project.capabilities || [],
    fieldStatus: field.status,
    plannedContext: field.status === "planned" || field.plannedContext === true,
    mustEqual: field.mustEqual,
  };
}
