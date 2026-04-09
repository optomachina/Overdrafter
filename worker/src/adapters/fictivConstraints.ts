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

export function buildMaterialSearchTerms(material: string) {
  const source = material.toLowerCase();

  if (source.includes("6061")) return ["6061", "6061-T6"];
  if (source.includes("7075")) return ["7075", "7075-T6"];
  if (source.includes("2024")) return ["2024", "2024-T3"];
  if (source.includes("303")) return ["303", "303 Stainless"];
  if (source.includes("304")) return ["304", "304 Stainless"];
  if (source.includes("316")) return ["316", "316 Stainless"];
  if (source.includes("17-4")) return ["17-4", "17-4 PH"];
  if (source.includes("1018")) return ["1018", "1018 Steel"];
  if (source.includes("4140")) return ["4140", "4140 Alloy Steel"];
  if (source.includes("brass")) return ["Brass", "Brass 360"];
  if (source.includes("copper")) return ["Copper", "Copper 101"];
  if (source.includes("titanium") || source.includes("6al-4v") || source.includes("ti-6al-4v")) {
    return ["Titanium Grade 5", "Ti 6Al-4V"];
  }
  if (source.includes("peek")) return ["PEEK"];
  if (source.includes("nylon")) return ["Nylon", "Nylon 6/6"];
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
