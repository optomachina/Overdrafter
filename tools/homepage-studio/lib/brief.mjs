// Builds the brief handed to a headless Claude run. Shared by the local
// claude-cli engine and the hosted worker so both obey the same contract.

export const WORDING_RULES = [
  '1. "Live" means exactly "Live in Founding Beta". Never a bare "Live".',
  '2. Planned items are labelled "Coming soon" and are visibly unpowered (dashed, open gap), never distinguished by colour alone.',
  '3. No dates, quarters, years, timelines or percentages. "Coming soon" is the only timing word; "next", "later" and "next year" are not allowed.',
  "4. Never imply a planned capability exists. Never name third-party hardware or product brands, including CAD tools. Use generic CAD wording.",
  "5. The mission is shown only as a labelled goal, never as progress, a metric or a result.",
  '6. Required closing statement: "Powered nodes are live in the invitation-only Founding Beta. Unpowered nodes are our intentions, not commitments."',
  "7. Capability status lives in one data object; do not hard-code a status in prose.",
  '8. Example prompts are labelled "Example prompt".',
  "9. No sign-up or notify form that stores anything.",
  "Live capabilities today: reads specs from drawings; quotes in parallel, compared on price and lead time.",
  "No fabricated statistics, customer logos, compliance badges or made-up timelines.",
];

export const ASSET_CONTRACT = [
  "Write exactly one file named index.html in the current directory. It must be a complete, self-contained HTML document.",
  "No network: no external scripts, stylesheets, fonts, images, fetch or XHR. Inline everything (SVG and CSS are fine).",
  "Support both themes with CSS custom variables: define light and dark tokens, honor @media (prefers-color-scheme) and a data-theme attribute on <html> (the studio sets data-theme=dark or light; also react to window messages of the form {type:'od-studio-theme', theme}).",
  "Honor prefers-reduced-motion: no animation when it is set.",
  "Label sample data honestly (for example 'Sample data'). Never present sample figures as live quotes.",
  "Style: bone #F2EFE8 / near-black, hairline rules, mono for metadata, one accent #C2410C family, no shadows, no gradients, left-aligned.",
  "Keep it accessible: a role and accessible name on the figure, 4.5:1 text contrast, 44px interactive targets.",
];

export function buildBrief({ kind, tool, section, currentCopy = [], prompt, currentText = "", fieldLabel = "", budget = {} }) {
  const lines = [];
  const minutes = budget.minutes ?? 20;
  if (kind === "asset") {
    lines.push(`You are generating a homepage asset for the "${section.label}" section of the OverDrafter homepage prototype.`);
    if (tool && tool.entryPath) {
      lines.push(`First read the skill instructions at ${tool.entryPath} and follow them. The skill reference folder is available to read.`);
    } else {
      lines.push("No skill is selected. Build the asset by hand with plain HTML, CSS and SVG.");
    }
  } else {
    lines.push(`You are rewriting one copy field, "${fieldLabel}", in the "${section.label}" section of the OverDrafter homepage prototype.`);
  }
  lines.push("", "Current copy for this section:");
  if (currentCopy.length === 0) lines.push("(none)");
  for (const c of currentCopy) lines.push(`- ${c.label}: ${c.text}`);
  lines.push("", "Owner instruction:", String(prompt || "").trim() || "(none)", "");
  lines.push("Public wording rules (binding):", ...WORDING_RULES, "");
  if (kind === "asset") {
    lines.push("Output contract:", ...ASSET_CONTRACT.map((l) => `- ${l}`));
  } else {
    lines.push(
      `Current text of the field: ${currentText}`,
      'Reply with ONLY a JSON object {"text": "<the new text>"} and nothing else. Keep the same role and roughly the same length unless told otherwise.',
    );
  }
  lines.push(
    "",
    `Budget: finish within ${minutes} minutes and keep model spend small${budget.usd ? ` (hard cap about $${budget.usd})` : ""}. Do not browse, do not install anything, do not read files outside the current directory and the skill folder.`,
    "If you cannot meet the contract, say so plainly instead of guessing. Never fabricate results.",
  );
  return lines.join("\n");
}
