export const FICTIV_URLS = {
  home: "https://app.fictiv.com/home",
  quotes: "https://app.fictiv.com/quotes",
  upload: "https://app.fictiv.com/quotes/upload",
  login: "https://app.fictiv.com/login",
} as const;

export const FICTIV_LOCATORS = {
  loginSignals: [/log in to your account/i, /email address/i, /password/i],
  captchaSignals: [/captcha/i, /verify you are human/i, /cloudflare/i],
  manualReviewSignals: [
    /manual review/i,
    /request quote/i,
    /rfq required/i,
    /pending review/i,
    /requires review/i,
  ],
  uploadInputs: [
    '[data-test-target*="upload"] input[type="file"]',
    '[data-test-target*="dropzone"] input[type="file"]',
    'input[type="file"][accept*=".step"]',
    'input[type="file"][accept*=".stp"]',
    'input[type="file"]',
  ],
  quoteReadySignals: [
    /active quotes/i,
    /quote/i,
    /\$\d[\d,]*\.?\d*/i,
    /lead time/i,
    /business days?/i,
  ],
  quantityInputs: [
    '[data-test-target*="quantity"] input',
    'input[name*="quantity"]',
    'input[id*="quantity"]',
    'input[type="number"]',
  ],
  materialButtons: [
    '[data-test-target*="material"]',
    '[aria-label*="material" i]',
    'button:has-text("Material")',
    '[role="combobox"][aria-label*="material" i]',
  ],
  materialOptions: [
    '[role="option"]',
    '[data-test-target*="option"]',
    '[data-test-target*="material"] [role="button"]',
  ],
  finishButtons: [
    '[data-test-target*="finish"]',
    '[aria-label*="finish" i]',
    'button:has-text("Finish")',
    'button:has-text("Surface")',
  ],
  finishOptions: [
    '[role="option"]',
    '[data-test-target*="option"]',
  ],
  priceText: [
    '[data-test-target*="price"]',
    '[data-test-target*="cost"]',
    '[aria-label*="price" i]',
    '[class*="price"]',
    '[class*="cost"]',
  ],
  leadTimeText: [
    '[data-test-target*="lead"]',
    '[data-test-target*="delivery"]',
    '[aria-label*="lead" i]',
    '[class*="lead"]',
    '[class*="delivery"]',
  ],
  manualReviewText: [
    '[data-test-target*="review"]',
    '[data-test-target*="rfq"]',
    '[aria-label*="review" i]',
    '[class*="review"]',
    '[class*="rfq"]',
  ],
  quoteLinkAnchors: [
    'a[href*="/quotes/"]',
    'a[href*="/pages/orders/quote"]',
    'a[href*="/orders/"]',
  ],
} as const;

const MATERIAL_TERM_MAPPINGS: ReadonlyArray<{
  patterns: readonly string[];
  terms: string[];
}> = [
  { patterns: ["6061"], terms: ["6061", "6061-T6"] },
  { patterns: ["7075"], terms: ["7075", "7075-T6"] },
  { patterns: ["2024"], terms: ["2024", "2024-T3"] },
  { patterns: ["303"], terms: ["303", "303 Stainless"] },
  { patterns: ["304"], terms: ["304", "304 Stainless"] },
  { patterns: ["316"], terms: ["316", "316 Stainless"] },
  { patterns: ["17-4"], terms: ["17-4", "17-4 PH"] },
  { patterns: ["1018"], terms: ["1018", "1018 Steel"] },
  { patterns: ["4140"], terms: ["4140", "4140 Alloy Steel"] },
  { patterns: ["brass"], terms: ["Brass", "Brass 360"] },
  { patterns: ["copper"], terms: ["Copper", "Copper 101"] },
  { patterns: ["titanium", "6al-4v", "ti-6al-4v"], terms: ["Titanium Grade 5", "Ti 6Al-4V"] },
  { patterns: ["peek"], terms: ["PEEK"] },
  { patterns: ["nylon"], terms: ["Nylon", "Nylon 6/6"] },
  { patterns: ["abs"], terms: ["ABS"] },
  { patterns: ["delrin", "acetal"], terms: ["Delrin", "Acetal"] },
];

/**
 * Map a material description to canonical Fictiv material search terms.
 * Matching is case-insensitive and uses substring checks (for example, "6061" or "ti-6al-4v").
 * Returns `null` when no mapping exists so callers can fail closed to manual follow-up.
 *
 * @param material Material text from requirements.
 * @returns Matched search terms or `null` when unmapped.
 */
export function buildMaterialSearchTerms(material: string) {
  const source = material.toLowerCase();

  for (const mapping of MATERIAL_TERM_MAPPINGS) {
    if (mapping.patterns.some((pattern) => source.includes(pattern))) {
      return mapping.terms;
    }
  }

  return null;
}

/**
 * Map a finish description to canonical Fictiv finish search terms.
 * Returns an empty array for "as-machined"/no-finish values, mapped terms for known finishes,
 * and `null` when the finish is present but unmapped.
 *
 * @param finish Finish text from requirements, or `null` when absent.
 * @returns Search terms array, empty array for ignored/no-finish, or `null` when unmapped.
 */
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
