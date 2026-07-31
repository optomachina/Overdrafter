export const XOMETRY_URLS = {
  quoteHome: "https://www.xometry.com/quoting/home/",
  login: "https://www.xometry.com/login/",
  quotePathPattern: /\/quoting\/quote\/Q\d{2}-/,
} as const;

export const XOMETRY_LOCATORS = {
  loginSignals: [/sign in/i, /log in/i, /continue with/i],
  anonymousQuoteHomeSignals: [
    /upload a 3d model to see instant pricing, lead time, and dfm feedback/i,
    /already have an account/i,
  ],
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
    'div:has(> input[type="file"]):has(button:has-text("Start A New Instant Quote")) > input[type="file"]',
  ],
  standaloneUploadInputs: [
    '[data-testid="file-upload"] input[type="file"]',
  ],
  uploadTriggers: [
    'text=/^Choose File$/i',
    'text=/^Drag and Drop or Choose File$/i',
    'label:has-text("Choose File")',
    'button:has-text("Choose File")',
    'button:has-text("Start a New Instant Quote")',
    '.xl--dropover-closed',
  ],
  startNewQuoteButtons: [
    'button:has-text("Start a New Instant Quote")',
    'button:has-text("Start a new Instant Quote")',
    'button:has-text("Start An Instant Quote")',
    'button:has-text("Start a New")',
  ],
  editConfigurationButtons: [
    '[data-testid="navigate-to-configuration-button"]',
    'button:has-text("Edit Configuration")',
  ],
  dashboardSignals: [
    /welcome back/i,
    /recent quotes/i,
    /pick up where you left off/i,
  ],
  itarPopupSignals: [
    /are any parts.*subject to export control/i,
    /export.controlled parts/i,
    /export-controlled/i,
    /itar/i,
    /export control regulation/i,
  ],
  // Continue button inside the export-controlled-parts modal that opens
  // immediately after upload while authenticated. Dialog-scoped selectors
  // first (more specific, avoids matching the Checkout/Cart Continue buttons
  // elsewhere on the page); broader fallbacks last.
  exportControlContinue: [
    'div[role="dialog"] button:has-text("Continue")',
    '[aria-modal="true"] button:has-text("Continue")',
    'button:has-text("Continue"):not(:has-text("Checkout")):not(:has-text("Cart"))',
  ],
  itarConfirmContinueButtons: [
    'div[role="dialog"] button:has-text("Continue")',
    '[aria-modal="true"] button:has-text("Continue")',
    'button:has-text("Continue"):not(:has-text("Checkout")):not(:has-text("Cart"))',
    '[role="button"]:has-text("Continue")',
  ],
  itarYesRadios: [
    'label:has-text("Yes")',
    'input[type="radio"][value*="yes" i]',
  ],
  renamePartsPopupSignals: [
    /rename (?:your )?parts?/i,
    /new(?:ly)? able to rename/i,
  ],
  renamePartsAcknowledgeButtons: [
    'button:has-text("Okay")',
    'button:has-text("OK")',
    'button:has-text("Got it")',
    'button:has-text("Continue")',
  ],
  // Configuration page URL pattern. Adapter waits for this in addition to text signals.
  quotePagePathPattern: /\/quoting\/quote\/Q\d{2}-/,
  // Configuration-page-specific text signals. Configurator-specific text first
  // (avoids spurious dashboard tile matches), broader fallbacks later.
  quoteReadySignals: [
    /lead\s+time\s*:\s*\d+\s+business\s+days/i,
    /continue\s+to\s+checkout/i,
    /configure part/i,
    /edit specifications/i,
    /part configuration/i,
    /process[:\s]+cnc/i,
  ],
  quantityInputs: [
    'input[aria-label="Quantity"]',
    'input[type="number"][pattern]',
    '[data-testid*="quantity"] input',
    'input[name*="quantity"]',
    'input[id*="quantity"]',
    'input[type="number"][pattern="^[0-9]*$"]',
    'input[type="number"]',
  ],
  // Current configuration controls. Material and finish are required inputs;
  // the adapter fails closed when it cannot apply the requested requirement.
  materialButtons: [
    'input[role="combobox"][placeholder="Search Material"]',
    '#material-multiselect-combobox',
    '[data-testid="requirement-Material"]',
    '[data-testid*="material" i]:not([data-testid*="navigate" i])',
    '[aria-label*="material" i]',
    'button:has-text("Material")',
  ],
  materialOptions: [
    'input[type="radio"][name="material"]',
    '[role="option"]',
    '[data-testid*="option" i]',
    '[data-testid*="material" i] button',
  ],
  finishButtons: [
    'input[role="combobox"][placeholder="Search Finish"]',
    '#finish-multiselect-combobox',
    '[data-testid="requirement-Finish"]',
    '[data-testid*="finish" i]',
    '[aria-label*="finish" i]',
    'button:has-text("Finish")',
    'button:has-text("Post-Processing")',
  ],
  finishOptions: [
    'input[type="radio"][name*="finish" i]',
    'input[type="radio"][name*="post" i]',
    '[role="option"]',
    '[data-testid*="option" i]',
  ],
  toleranceOptions: {
    looser: "#tolerances-looser-metal",
    standard: "#tolerances-false-metal",
    tighter: "#tolerances-true-metal",
  },
  saveConfigurationButtons: [
    'button:has-text("Save Configuration")',
    'button[type="submit"]:has-text("Save")',
  ],
  // Summary-page price tier after Save Configuration. `[data-testid=part-discount]`
  // exposes the tier total (e.g. "$252.97 (Save $59.81)").
  priceText: [
    'button:has-text("Least Expensive")',
    '[data-testid="part-discount"]',
    '.price-tier',
    '[data-testid*="price" i]',
    '[data-testid*="total" i]',
    '[aria-label*="price" i]',
    '[class*="price" i]',
    // tierAndLeadTime label contains both lead-time and price text; placed last so
    // its selector key doesn't collide with priceText[0] in the unit-test mock.
    '[data-testid="tierAndLeadTime"]',
  ],
  leadTimeText: [
    'button:has-text("Least Expensive")',
    '[data-testid="tierAndLeadTime"]',
    '.price-tier',
    '[data-testid*="lead" i]',
    '[data-testid*="delivery" i]',
    '[aria-label*="lead" i]',
    '[class*="lead" i]',
    '[class*="delivery" i]',
  ],
  manualReviewText: [
    '[data-testid*="review" i]',
    '[data-testid*="drawing" i]',
    '[aria-label*="review" i]',
    '[class*="review" i]',
  ],
  drawingInputs: [
    'div:has(> #uploadFileButton) input#file-handler',
    'input[type="file"][accept*="application/pdf" i]',
    'input[type="file"][accept*=".pdf" i]',
    '[data-testid*="drawing" i] input[type="file"]',
    '[aria-label*="drawing" i] input[type="file"]',
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

/**
 * Returns the exact material tokens accepted from Xometry's saved summary.
 * Search aliases are intentionally broader than these verification values:
 * aluminum summaries must preserve the requested temper, while grade-only
 * tokens remain sufficient for materials without a temper designation.
 */
export function buildMaterialSummaryTerms(material: string) {
  const source = material.toLowerCase();

  if (source.includes("6061")) return ["6061-T6x", "6061-T6"];
  if (source.includes("7075")) return ["7075-T6x", "7075-T6"];
  if (source.includes("2024")) return ["2024-T3"];
  if (source.includes("303")) return ["Stainless Steel 303"];
  if (source.includes("304")) return ["Stainless Steel 304/304L"];
  if (source.includes("316")) return ["Stainless Steel 316/316L"];
  if (source.includes("17-4")) return ["Stainless Steel 17-4"];
  if (source.includes("1018")) return ["Steel 1018"];
  if (source.includes("4140")) return ["Steel 4140"];
  if (source.includes("brass")) return ["Copper C360 (Brass)"];
  if (source.includes("copper")) return ["Copper 101"];
  if (source.includes("titanium") || source.includes("6al-4v") || source.includes("ti-6al-4v")) {
    return ["Titanium Grade 5", "Ti 6Al-4V"];
  }
  if (source.includes("peek")) return ["PEEK"];
  if (source.includes("nylon")) return ["Nylon 6/6"];
  if (source.includes("abs")) return ["ABS"];
  if (source.includes("delrin") || source.includes("acetal")) {
    return ["Delrin", "Acetal"];
  }

  return null;
}

/**
 * Maps an extracted finish to Xometry search terms. Type II black finishes map
 * to "Black Anodize"; null, blank, as-machined, none, and no-finish values map
 * to an empty list, while an unknown non-empty finish returns null.
 */
export function buildFinishSearchTerms(finish: string | null) {
  if (!finish) return [];

  const source = finish.toLowerCase();

  if (!source.trim() || /as.?machined|none|no finish/.test(source)) return [];

  if (source.includes("type iii")) return ["Type III", "Hard Anodize"];
  if (source.includes("type ii") && source.includes("black")) return ["Black Anodize"];
  if (source.includes("type ii")) return ["Type II"];
  if (source.includes("bead")) return ["Bead Blast"];
  if (source.includes("chem")) return ["Chromate", "Chem Film"];
  if (source.includes("passivat")) return ["Passivation"];
  if (source.includes("powder")) return ["Powder Coat"];
  if (source.includes("media blast")) return ["Media Blast"];
  if (source.includes("tumble")) return ["Tumbled", "Deburr"];

  return null;
}
