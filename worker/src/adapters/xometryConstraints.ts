export const XOMETRY_URLS = {
  quoteHome: "https://www.xometry.com/quoting/home/",
  login: "https://www.xometry.com/login/",
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
    /requires review/i,
    /drawing required/i,
    /upload drawing/i,
    /add drawing/i,
  ],
  uploadInputs: [
    '[data-testid="file-upload"] input[type="file"]',
    'input[type="file"]',
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
  itarConfirmContinueButtons: [
    'button:has-text("Continue")',
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
  quoteReadySignals: [
    /configure part/i,
    /edit specifications/i,
    /part configuration/i,
    /process[:\s]+cnc/i,
  ],
  quantityInputs: [
    '[data-testid*="quantity"] input',
    'input[name*="quantity"]',
    'input[id*="quantity"]',
    'input[type="number"][pattern="^[0-9]*$"]',
    'input[type="number"]',
  ],
  materialButtons: [
    '[data-testid="requirement-Material"]',
    '[data-testid*="material" i]',
    '[aria-label*="material" i]',
    'button:has-text("Material")',
  ],
  materialOptions: [
    '[role="option"]',
    '[data-testid*="option" i]',
    '[data-testid*="material" i] button',
  ],
  finishButtons: [
    '[data-testid="requirement-Finish"]',
    '[data-testid*="finish" i]',
    '[aria-label*="finish" i]',
    'button:has-text("Finish")',
    'button:has-text("Post-Processing")',
  ],
  finishOptions: [
    '[role="option"]',
    '[data-testid*="option" i]',
  ],
  priceText: [
    '[data-testid="tierAndLeadTime"]',
    '[data-testid*="price" i]',
    '[data-testid*="total" i]',
    '[aria-label*="price" i]',
    '[class*="price" i]',
  ],
  leadTimeText: [
    '[data-testid*="lead" i]',
    '[data-testid*="delivery" i]',
    '[aria-label*="lead" i]',
    '[class*="lead" i]',
    '[class*="delivery" i]',
    // tierAndLeadTime contains both lead-time and price text; placed last so its
    // selector key doesn't collide with priceText[0] in the unit-test mock.
    '[data-testid="tierAndLeadTime"]',
  ],
  manualReviewText: [
    '[data-testid*="review" i]',
    '[data-testid*="drawing" i]',
    '[aria-label*="review" i]',
    '[class*="review" i]',
  ],
  drawingInputs: [
    '[data-testid*="drawing" i] input[type="file"]',
    '[aria-label*="drawing" i] input[type="file"]',
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
