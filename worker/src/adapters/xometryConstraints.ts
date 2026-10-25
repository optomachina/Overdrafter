export const XOMETRY_URLS = {
  quoteHome: "https://www.xometry.com/quoting/home/",
  quoteCreation: "https://www.xometry.com/quoting/new",
  login: "https://www.xometry.com/login/",
  quotePathPattern: /\/quoting\/quote\/Q\d{2}-/,
} as const;

export const XOMETRY_LOCATORS = {
  loginSignals: [/sign in/i, /log in/i, /continue with/i],
  anonymousUploadPromptSignals: [
    /upload a 3d model to see instant pricing, lead time, and dfm feedback/i,
  ],
  anonymousQuoteHomeSignals: [
    /upload a 3d model to see instant pricing, lead time, and dfm feedback/i,
    /already have an account/i,
  ],
  anonymousEmailGateSignals: [
    /enter your email/i,
    /business email/i,
    /view my quote/i,
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
  dashboardUploadPanels: [
    'div:has(> input[type="file"]):has(button:has-text("Start A New Instant Quote"))',
    'div:has(> input[type="file"]):has(button:has-text("Upload 3D Files"))',
  ],
  uploadInputs: [
    'div:has(> input[type="file"]):has(button:has-text("Start A New Instant Quote")) > input[type="file"]',
    'div:has(> input[type="file"]):has(button:has-text("Upload 3D Files")) > input[type="file"]',
  ],
  dashboardUploadButtons: [
    'button:text-is("Upload a CAD File")',
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
  accountQuoteListStartButtons: [
    '[data-testid="DashboardGetInstantQuotePrimary-dashboard-get-instant-quote-primary"]',
  ],
  accountQuoteListStartButtonText: "Get an Instant Quote",
  accountQuoteModalPanels: [
    '[role="dialog"][aria-modal="true"]:has(input[type="file"][aria-label="Choose files to upload"])',
  ],
  accountQuoteModalInputs: [
    '[role="dialog"][aria-modal="true"] input[type="file"][aria-label="Choose files to upload"]',
  ],
  accountQuoteModalSubmitButtons: [
    '[data-testid="UploadView-instant-quote-continue"]',
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
  accountQuoteListSignals: [
    /\bmy account\b/i,
    /\bpart library\b/i,
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
    '[data-testid="ItarView-itar-continue"]',
    'div[role="dialog"] button:has-text("Continue")',
    '[aria-modal="true"] button:has-text("Continue")',
    'button:has-text("Continue"):not(:has-text("Checkout")):not(:has-text("Cart"))',
  ],
  exportControlNo: [
    '[data-testid="ItarView-itar-option-confirmed-not-itar"]',
    'div[role="dialog"] input[type="radio"][value="no" i]',
    '[aria-modal="true"] input[type="radio"][value="no" i]',
    'div[role="dialog"] label:has-text("No")',
    '[aria-modal="true"] label:has-text("No")',
    'div[role="dialog"] button:has-text("No")',
    '[aria-modal="true"] button:has-text("No")',
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
  quoteLoadingSignals: [
    /analyzing geometry/i,
    /loading supported file extensions/i,
  ],
  // OVD-1052: in-progress PRICING text on the quote page. Only these make a
  // configured quote page without a recognizable price `unavailable` (pricing
  // has not finished). The uploader/geometry text above is not one: it says
  // nothing about pricing, so a page showing only that stays selector_drift.
  // Synthetic phrasing, not captured from the live page; add a pattern only
  // from reviewed quote-page evidence. The loading/refreshing phrasing comes
  // from the OVD-1052 review of React re-pricing states, as does "Updating
  // your quote..." in the order summary beside the parts list; no captured
  // quote page shows any of it.
  quotePricingInProgressSignals: [
    /\b(?:re)?calculating (?:the |your )?(?:price|prices|pricing|quote)\b/i,
    /\bupdating (?:the |your )?(?:price|prices|pricing|quote)\b/i,
    /\b(?:loading|refreshing) (?:the |your )?(?:price|prices|pricing|quote)\b/i,
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
  // OVD-776: the part row's own quantity input, read back before any price
  // is captured. Row-scoped selectors come first; the generic number inputs
  // above are deliberately excluded because they can belong to other widgets.
  lineItemQuantityInputs: [
    '[data-testid*="line-item" i] input[aria-label="Quantity" i]',
    '[data-testid*="part-row" i] input[aria-label="Quantity" i]',
    '[data-testid*="line-item" i] [data-testid*="quantity" i] input',
    '[data-testid*="part-row" i] [data-testid*="quantity" i] input',
    'input[aria-label="Quantity"]',
    // OVD-1052: the current part row labels its quantity stepper with a
    // sibling <span>Quantity</span>; the number input has no aria-label. The
    // label anchors this to the part row, never a stray number input.
    'div:has(> span:text-is("Quantity")) > div > input[type="number"]',
  ],
  // Current configuration controls. Material and finish are required inputs;
  // the adapter fails closed when it cannot apply the requested requirement.
  // OVD-777: process mirrors the material/finish control shapes. Xometry can
  // auto-select a non-CNC process (Sheet Cutting) for plate-like geometry.
  processButtons: [
    'input[role="combobox"][placeholder="Search Process"]',
    '#process-multiselect-combobox',
    '[data-testid="requirement-Process"]',
    '[aria-label*="process" i]:not([aria-label*="subprocess" i])',
    'button:has-text("Process")',
  ],
  processOptions: [
    'input[type="radio"][name="process"]',
    '[role="option"]',
    '[data-testid*="option" i]',
  ],
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
  // Fallback price anchors, read only when no offer container parsed. Their
  // amount never reaches a customer: a page with a trusted fallback amount but
  // no offer containers fails closed, and a manual-review page publishes no
  // price. `[data-testid="part-discount"]` is deliberately absent: on the
  // current quote page it holds the struck-through LIST total and its savings
  // note ("$X (Save $Y)"), never the price the customer pays (OVD-1052).
  priceText: [
    'button:has-text("Least Expensive")',
    '.price-tier',
    '[data-testid*="price" i]',
    '[data-testid*="total" i]',
    '[aria-label*="price" i]',
    '[class*="price" i]',
    // The legacy tierAndLeadTime label carried the tier name, lead time and
    // price; the current one holds only the arrival date. Placed last so its
    // selector key doesn't collide with priceText[0] in the unit-test mock.
    '[data-testid="tierAndLeadTime"]',
  ],
  // OVD-1052: the only offer container. Each tier Xometry quotes is one
  // card, and the adapter reads only that card's text so a price cannot be
  // paired with a lead time or sourcing label from another option. A quote
  // page without one fails closed as selector drift; no other element is
  // ever read as an option.
  priceTierCard: ".price-tier",
  // Rendered commercial summary inside each offered card; never the part stepper.
  pricedCardQuantity: '.price-tier [kind="discount"]:not(:empty)',
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

/** OVD-777: the only process the CNC lane quotes. */
export const XOMETRY_CNC_PROCESS_TERMS = ["CNC Machining"];

/**
 * OVD-777: finish options that clear an auto-applied finish when the saved
 * requirement is as-machined. Mirrors the as-machined summary values accepted
 * by saved-requirement verification.
 */
export const XOMETRY_AS_MACHINED_FINISH_TERMS = ["As Machined", "Standard"];

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
const MATERIAL_SUMMARY_MAPPINGS: Array<{
  needles: string[];
  terms: string[];
}> = [
  { needles: ["6061"], terms: ["6061-T6x", "6061-T6"] },
  { needles: ["7075"], terms: ["7075-T6x", "7075-T6"] },
  { needles: ["2024"], terms: ["2024-T3"] },
  { needles: ["303"], terms: ["Stainless Steel 303"] },
  { needles: ["304"], terms: ["Stainless Steel 304/304L"] },
  { needles: ["316"], terms: ["Stainless Steel 316/316L"] },
  { needles: ["17-4"], terms: ["Stainless Steel 17-4"] },
  { needles: ["1018"], terms: ["Steel 1018"] },
  { needles: ["4140"], terms: ["Steel 4140"] },
  { needles: ["brass"], terms: ["Copper C360 (Brass)"] },
  { needles: ["copper"], terms: ["Copper 101"] },
  {
    needles: ["titanium", "6al-4v", "ti-6al-4v"],
    terms: ["Titanium Grade 5", "Ti 6Al-4V"],
  },
  { needles: ["peek"], terms: ["PEEK"] },
  { needles: ["nylon"], terms: ["Nylon 6/6"] },
  { needles: ["abs"], terms: ["ABS"] },
  { needles: ["delrin", "acetal"], terms: ["Delrin", "Acetal"] },
];

export function buildMaterialSummaryTerms(material: string) {
  const source = material.toLowerCase();
  const mapping = MATERIAL_SUMMARY_MAPPINGS.find(({ needles }) =>
    needles.some((needle) => source.includes(needle)),
  );
  return mapping?.terms ?? null;
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
