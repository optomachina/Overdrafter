export const XOMETRY_URLS = {
  quoteHome: "https://www.xometry.com/quoting/home/",
  login: "https://www.xometry.com/login/",
  quotePathPattern: /\/quoting\/quote\/Q\d{2}-/,
} as const;

export const XOMETRY_LOCATORS = {
  loginSignals: [/sign in/i, /log in/i, /continue with/i],
  captchaSignals: [/captcha/i, /verify you are human/i, /recaptcha/i],
  genericErrorSignals: [
    /there was an error[, ]+please try again/i,
    /something went wrong[, ]+please try again/i,
    /access denied/i,
    /request blocked/i,
  ],
  manualReviewSignals: [
    /manual review/i,
    /manually quoted/i,
    /manually-quoted/i,
    /requires review/i,
    /drawing required/i,
  ],
  uploadInputs: [
    '[data-testid="file-upload"] input[type="file"]',
    'input[type="file"]',
  ],
  // Continue button inside the export-controlled-parts modal that opens
  // immediately after upload while authenticated.
  exportControlContinue: [
    'div[role="dialog"] button:has-text("Continue")',
    '[aria-modal="true"] button:has-text("Continue")',
    'button:has-text("Continue"):not(:has-text("Checkout")):not(:has-text("Cart"))',
  ],
  // Configuration page URL pattern. Adapter waits for this in addition to legacy text signals.
  quotePagePathPattern: /\/quoting\/quote\/Q\d{2}-/,
  // Configuration-page-specific text signals (avoid spurious dashboard tile matches).
  quoteReadySignals: [
    /lead\s+time\s*:\s*\d+\s+business\s+days/i,
    /continue\s+to\s+checkout/i,
  ],
  quantityInputs: [
    'input[type="number"][pattern]',
    '[data-testid*="quantity"] input',
    'input[name*="quantity"]',
    'input[id*="quantity"]',
  ],
  // Material/finish are read-only on the summary page where price tiers live.
  // Editing them requires navigating to the Configure tab (which hides tier
  // pricing). Keep these selectors so the adapter still records what it
  // attempted, but they intentionally do NOT navigate to the Configure tab —
  // the gate only needs price + lead time, not requirement enforcement.
  materialButtons: [
    '[data-testid*="material"]:not([data-testid*="navigate"])',
    '[aria-label*="material"]',
    'button:has-text("Material")',
  ],
  materialOptions: [
    'input[type="radio"][name="material"]',
    '[role="option"]',
    '[data-testid*="option"]',
    '[data-testid*="material"] button',
  ],
  finishButtons: [
    '[data-testid*="finish"]',
    '[aria-label*="finish"]',
    'button:has-text("Finish")',
    'button:has-text("Post-Processing")',
  ],
  finishOptions: [
    'input[type="radio"][name*="finish" i]',
    'input[type="radio"][name*="post" i]',
    '[role="option"]',
    '[data-testid*="option"]',
  ],
  // Configuration-page price tier. `[data-testid=part-discount]` exposes the tier
  // total (e.g. "$252.97 (Save $59.81)"). `.price-tier` is the wrapping container.
  priceText: [
    '[data-testid="part-discount"]',
    '.price-tier',
    '[data-testid*="price"]',
    '[data-testid*="total"]',
    '[aria-label*="price"]',
    '[class*="price"]',
  ],
  leadTimeText: [
    '[data-testid="tierAndLeadTime"]',
    '.price-tier',
    '[data-testid*="lead"]',
    '[data-testid*="delivery"]',
    '[aria-label*="lead"]',
    '[class*="lead"]',
    '[class*="delivery"]',
  ],
  manualReviewText: [
    '[data-testid*="review"]',
    '[data-testid*="drawing"]',
    '[aria-label*="review"]',
    '[class*="review"]',
  ],
  drawingInputs: [
    '[data-testid*="drawing"] input[type="file"]',
    '[aria-label*="drawing"] input[type="file"]',
    'input[type="file"]',
  ],
} as const;

export function buildMaterialSearchTerms(material: string) {
  const source = material.toLowerCase();

  if (source.includes("6061")) return ["6061-T6", "6061"];
  if (source.includes("7075")) return ["7075-T6", "7075"];
  if (source.includes("2024")) return ["2024-T3", "2024"];
  if (source.includes("303")) return ["303 Stainless", "303"];
  if (source.includes("304")) return ["304 Stainless", "304"];
  if (source.includes("316")) return ["316 Stainless", "316"];
  if (source.includes("17-4")) return ["17-4 PH", "17-4"];
  if (source.includes("1018")) return ["1018 Steel", "1018"];
  if (source.includes("4140")) return ["4140 Alloy Steel", "4140"];
  if (source.includes("brass")) return ["Brass 360", "Brass"];
  if (source.includes("copper")) return ["Copper 101", "Copper"];
  if (source.includes("titanium") || source.includes("6al-4v") || source.includes("ti-6al-4v")) {
    return ["Titanium Grade 5", "Ti 6Al-4V"];
  }
  if (source.includes("peek")) return ["PEEK"];
  if (source.includes("nylon")) return ["Nylon 6/6", "Nylon"];
  if (source.includes("abs")) return ["ABS"];
  if (source.includes("delrin") || source.includes("acetal")) return ["Delrin", "Acetal"];

  return null;
}

export function buildFinishSearchTerms(finish: string | null) {
  if (!finish) return [];

  const source = finish.toLowerCase();

  if (!source.trim() || /as.?machined|none|no finish/.test(source)) return [];

  if (source.includes("type iii")) return ["Type III", "Hard Anodize"];
  if (source.includes("type ii") && source.includes("black")) return ["Type II", "Black"];
  if (source.includes("type ii")) return ["Type II"];
  if (source.includes("bead")) return ["Bead Blast"];
  if (source.includes("chem")) return ["Chromate", "Chem Film"];
  if (source.includes("passivat")) return ["Passivation"];
  if (source.includes("powder")) return ["Powder Coat"];
  if (source.includes("media blast")) return ["Media Blast"];
  if (source.includes("tumble")) return ["Tumbled", "Deburr"];

  return null;
}
