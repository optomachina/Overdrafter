export const FICTIV_URLS = {
  home: "https://app.fictiv.com/home",
  quotes: "https://app.fictiv.com/quotes",
  upload: "https://app.fictiv.com/pages/quotes/upload",
  login: "https://app.fictiv.com/login",
} as const;

/**
 * OVD-1052 round 8 (H2): what a click, key press or fill target must never
 * name, in its text, aria-label, title, value, href or data-test-target
 * (read with separators and camel case split into spaces, so
 * "request-quote" and "placeOrder" count). The adapter refuses such a target
 * as unsafe_click before acting on it, whatever selector resolved to it.
 */
export const FICTIV_FORBIDDEN_CLICK_TARGET =
  /checkout|check out|place order|order now|pay|payment|credit|purchase|buy|add to cart|request (a )?quote|submit order/i;

export const FICTIV_LOCATORS = {
  // Login form labels sit on their own line. The logged-in quote summary says
  // "update your account with a company email address", which is not a login.
  loginSignals: [/log in to your account/i, /^\s*email address\s*$/im, /^\s*password\s*$/im],
  captchaSignals: [/captcha/i, /verify you are human/i, /cloudflare/i],
  manualReviewSignals: [
    /manual review/i,
    /request(?:ed)?\s+for\s+quote/i,
    /rfq required/i,
    /pending review/i,
    /requires review/i,
    /quote will be reviewed/i,
    /unable to provide an instant quote/i,
  ],
  capabilityLimitSignals: [
    /not available for your account/i,
    /does not have access/i,
    /contact your account manager/i,
    /contact support to enable/i,
    /requires enterprise/i,
    /feature is unavailable/i,
    // Quote summary when the account tier cannot instant-price the specs.
    /to access advanced quoting/i,
  ],
  configurationRequiredSignals: [
    /configuration required/i,
    /complete configuration/i,
    /requires additional configuration/i,
    /missing required configuration/i,
    /choose (?:a )?material/i,
    /select (?:a )?material/i,
    /choose (?:a )?finish/i,
    /select (?:a )?finish/i,
    // Quote summary until every part is configured and the prototype or
    // commercial classification is chosen; no price renders before then.
    /configure all parts/i,
  ],
  inProgressSignals: [
    /uploading your parts/i,
    /uploading part/i,
    /processing your parts/i,
    /analyzing (?:your )?(?:parts?|geometry)/i,
    /extracting geometry/i,
    /generating quote/i,
    /calculating quote/i,
    /uploading files/i,
    /creating new quote/i,
    /parts are being analyzed/i,
  ],
  // OVD-1052 (G1): standing helper text on the real fresh upload page (the
  // 2026-10-23 02:46Z capture, CNC selected, dropzone shown), taken out of the
  // text before any portal state is read. None of it is a progress, review or
  // quote state. The export-control notice under the dropzone begins
  // "Uploading parts", which /uploading part/ above read as an upload in
  // progress, so the live upload page was refused as upload_surface_not_fresh
  // and nothing was ever uploaded. Each pattern covers one notice only, never
  // a bare "Uploading parts", so real progress text is still read.
  standingNoticeText: [
    /uploading parts subject to (?:any )?export control regulations\b[^\n]*/gi,
  ],
  // OVD-1052 (G1): a progress bar on the upload page means files are already
  // on their way: the page is not fresh, whatever its text says. (The live
  // upload progress panel showed an Ant Design line progress bar next to
  // "Uploading files (0/0)".)
  uploadProgressIndicators: [
    '.ant-progress',
    '[role="progressbar"]',
    '.ant-upload-list-item-uploading',
  ],
  // OVD-1052 (G2): what the quote page shows while Fictiv reprices. The 02:46Z
  // configured capture had no reprice text at all, only Ant Design spinners:
  // a nested spin over the Prototype / Commercial card (.ant-spin-spinning
  // next to an .ant-spin-container.ant-spin-blur) and a standalone spin over
  // the summary card. aria-busy and skeleton placeholders are Ant Design's
  // other loading states (modeled, not observed). While any of these is
  // visible no price is read and no settle poll counts.
  repriceIndicators: [
    '.ant-spin-spinning',
    '.ant-spin-blur',
    '[aria-busy="true"]',
    '.ant-skeleton',
  ],
  // OVD-1052 round 8 (H1): the hooks that tie a reprice indicator to the
  // price or the summary panel, the only indicators that show the price
  // itself updating. A visible indicator counts when it sits inside a
  // lead-time hook, or when the region it covers holds a lead-time or
  // summary-card hook and none of `otherRegions`. Live 02:46Z, after the
  // Prototype click: the summary card's standalone spinner covers a region
  // holding Fictiv's summary-card hook (counts); the classification card's
  // nested spinner covers the classification radios (never counts). A page
  // wide spinner covers the other regions too and never counts either, though
  // like every indicator it still holds each settle poll back.
  pricePanelHooks: {
    price: '[data-test-target^="quote-level-lead-time"]',
    summary: '[data-test-target*="summary-card"]',
    otherRegions: [
      '[data-test-target^="quote-classification"]',
      '[data-test-target="edit-config-link"]',
      '[data-test-target="select-quantity"]',
      '[data-test-target="top-nav-layout-header"]',
      '[data-test-target="quote-upload-toolbar"]',
      '[data-test-target="quote-activity-logs"]',
    ].join(", "),
  },
  // 2026-10-23 step titles: "Select a process", "Upload your files".
  uploadSurfaceSignals: [
    /upload your (?:parts|files)/i,
    /drag (?:and|&) drop/i,
    /drop files here/i,
    /select (?:a )?process/i,
    /choose (?:a )?process/i,
  ],
  // Both step titles of the process-first create-a-quote page. Readiness
  // needs both, next to a process card hook, before radio cards count.
  processFirstStepSignals: [
    /select (?:a )?process/i,
    /upload your (?:parts|files)/i,
  ],
  uploadInputs: [
    '[data-test-target*="upload"] input[type="file"]',
    '[data-test-target*="dropzone"] input[type="file"]',
    'input[type="file"][accept*=".step"]',
    'input[type="file"][accept*=".stp"]',
    'input[type="file"]',
  ],
  // Every click hook below is an exact match (OVD-1052 round 8, H2). A
  // substring hook reaches whatever else carries the word: "process" is in
  // Fictiv's process-lock-icon (OVD-1053 round 2) and in "Process payment",
  // "option" in a payment option, "finish" in "Finish checkout". The click
  // guard refuses a forbidden target anyway (FICTIV_FORBIDDEN_CLICK_TARGET).
  processButtons: [
    '[data-test-target="process-select"]',
    '[data-test-target="select-process"]',
    '[aria-label="Process" i]',
    'button:text-is("Process")',
  ],
  // Dropdown options: ARIA options and Ant Design's own select options.
  processOptions: [
    '[role="option"]',
    '.ant-select-item-option',
  ],
  processRadioCards: [
    '.ant-radio-wrapper',
  ],
  // Fictiv's own hook inside a process card (2026-10-23: the lock icon on
  // locked cards). A bare .ant-radio-wrapper is not enough: the quote page's
  // Prototype / Commercial classification radios are radio cards too.
  processCardHooks: [
    '.ant-radio-wrapper [data-test-target*="process"]',
  ],
  selectedProcessRadios: [
    '.ant-radio-wrapper-checked',
  ],
  // dataName: the option's data-name, which the selected option keeps when
  // its data-test-target becomes quote-level-lead-time-selected-option (live,
  // 02:46Z); the overseas options' own text never names their region.
  leadTimeOptionTargets: [
    { region: "domestic", tier: "fastest", dataName: "quote-level-lead-time-domesticFastest", selector: '[data-test-target="quote-level-lead-time-domesticFastest"]' },
    { region: "domestic", tier: "standard", dataName: "quote-level-lead-time-domesticStandard", selector: '[data-test-target="quote-level-lead-time-domesticStandard"]' },
    { region: "domestic", tier: "cost_effective", dataName: "quote-level-lead-time-domesticCostEffective", selector: '[data-test-target="quote-level-lead-time-domesticCostEffective"]' },
    { region: "overseas", tier: "fastest", dataName: "quote-level-lead-time-overseasFastest", selector: '[data-test-target="quote-level-lead-time-overseasFastest"]' },
    { region: "overseas", tier: "standard", dataName: "quote-level-lead-time-overseasStandard", selector: '[data-test-target="quote-level-lead-time-overseasStandard"]' },
    { region: "overseas", tier: "cost_effective", dataName: "quote-level-lead-time-overseasCostEffective", selector: '[data-test-target="quote-level-lead-time-overseasCostEffective"]' },
  ] as const,
  // OVD-1053 round 6 (F19): what marks a lead-time option the page shows but
  // does not offer, on the option element or inside it. Ant Design renders a
  // disabled radio card with these classes; an option carrying any of them,
  // a disabled input, or unavailable wording is never published.
  leadTimeOptionUnavailableMarkers: [
    '[aria-disabled="true"]',
    '.ant-radio-wrapper-disabled',
    '.ant-radio-disabled',
  ],
  modalCloseButtons: [
    '.ant-modal-close',
    'button.ant-modal-close',
  ],
  autoConfigModalContinue: [
    '.guide-auto-config-loading-modal-auto-config-loading-modal-continue',
  ],
  autoConfigModalHideCheckbox: [
    '.guide-auto-config-loading-modal-auto-config-loading-modal-hide-checkbox',
  ],
  endUseButtons: [
    '[data-test-target="quote-classification-selection-import-classification-radio-button-prototype"]',
    '[data-test-target="end-use"]',
    '[data-test-target="end_use"]',
    '[aria-label="End use" i]',
    'button:text-is("End use")',
  ],
  endUseOptions: [
    '[data-test-target="quote-classification-selection-import-classification-radio-button-prototype"]',
    '[role="option"]',
    '.ant-select-item-option',
  ],
  configurationDrawerButtons: [
    // Fictiv's own Edit configuration link in each part row (2026-10-23 live
    // quote page).
    'a[data-test-target="edit-config-link"]',
    '[data-test-target="configuration"]',
    '[data-test-target="part-config"]',
    '[aria-label="Configuration" i]',
    '[aria-label="Edit configuration" i]',
    '[aria-label="Part details" i]',
    // Whole, exact text only (OVD-1053 round 6, F20). `:has-text()` is a
    // case-insensitive substring match: "Edit" also matched "Credit" and
    // "Add credit", so the fallback could click a payment control. Every
    // other click fallback in this file is exact for the same reason
    // ("Finish" is in "Finish checkout", "Process" in "Process payment").
    'button:text-is("Configuration")',
    'button:text-is("Part details")',
    'button:text-is("Edit configuration")',
  ],
  quoteReadySignals: [
    // Fictiv's lead-time prices render "$ --" before pricing, so a priced one
    // may keep the space after the dollar sign.
    /\$ ?\d[\d,]*\.\d{2}/,
    /\d{1,4}\s+production\s+days/i,
  ],
  // OVD-1053 round 6 (F16): Fictiv's own quantity control, the only quantity
  // input on the 2026-10-23 live quote page (an Ant Design number input, role
  // spinbutton). It is typed into first and, unlike any other input, read
  // back: its value and its aria-valuenow (the quantity the control holds)
  // once the priced quote has settled after the fill.
  quantityControls: [
    'input[data-test-target="select-quantity"]',
  ],
  // Quantity-specific hooks only. A bare input[type="number"] is not one: a
  // thread count or any other numeric field would be typed into as the
  // quantity. No match means the quantity is never set and no price is
  // published (OVD-1053 round 4). Exact hooks (round 8, H2): Enter is
  // pressed in this input, so a substring hook such as a checkout quantity
  // field's would submit that form.
  quantityInputs: [
    '[data-test-target="part-quantity"] input',
    '[data-test-target="quantity"] input',
    'input[name="quantity"]',
    'input[id="quantity"]',
  ],
  // Fictiv's own quantity display or summary, the only quantity readback a
  // price is published on. The input the adapter typed into, and any element
  // that wraps one, is never read back (the adapter filters those out).
  quantityDisplays: [
    '[data-test-target*="quantity"]:not(input)',
  ],
  // OVD-1053 round 5 (structure of the 2026-10-23 live quote page): each part
  // row's configuration cell lists the process, the material and the finish,
  // one per line, ahead of Fictiv's own Edit configuration link. It is the
  // only place the priced quote shows what it priced, so it is the only
  // configuration a price is published on; nothing the adapter clicked or
  // chose is read back.
  partConfigurationSummaries: [
    'td:has([data-test-target="edit-config-link"])',
  ],
  // Hooks that only an existing quote renders: its lead-time options and its
  // Prototype / Commercial classification. A fresh upload page has neither.
  existingQuoteMarkers: [
    '[data-test-target^="quote-level-lead-time"]',
    '[data-test-target^="quote-classification"]',
  ],
  materialButtons: [
    '[data-test-target="material"]',
    '[data-test-target="material-select"]',
    '[aria-label="Material" i]',
    'button:text-is("Material")',
  ],
  materialOptions: [
    '[role="option"]',
    '.ant-select-item-option',
  ],
  finishButtons: [
    '[data-test-target="finish"]',
    '[data-test-target="finish-select"]',
    '[aria-label="Finish" i]',
    'button:text-is("Finish")',
    'button:text-is("Surface")',
  ],
  finishOptions: [
    '[role="option"]',
    '.ant-select-item-option',
  ],
  // OVD-1052 (G3), from the 02:46Z result capture: each lead-time option is
  // an li with Fictiv's per-option hook (quote-level-lead-time-<region><Tier>;
  // the selected one's is swapped to quote-level-lead-time-selected-option,
  // its data-name keeps the per-option value) holding a price span with this
  // hook, which read "$ --" unpriced: a bare dollar amount, no currency code
  // and no Total label. There is no quote-level-lead-time-price-selected hook
  // on the live page. The part table's Price cell has no hook of its own
  // (hashed classes only; it read "Please request a quote") and is never read.
  leadTimeOptionPrice: '[data-test-target="quote-level-lead-time-price"]',
  // The selected price, in order: the modeled selected-price hook, the price
  // span of the live selected option, then the whole selected option.
  selectedPriceText: [
    '[data-test-target="quote-level-lead-time-price-selected"]',
    '[data-test-target="quote-level-lead-time-selected-option"] [data-test-target="quote-level-lead-time-price"]',
    '[data-test-target="quote-level-lead-time-selected-option"]',
  ],
  // The lead-time panel's header; live it states "Below is the price for part
  // production. See the summary card for total cost with shipping, duties,
  // and tariffs."
  leadTimePanelHeader: '[data-test-target="qllt-header-wrapper"]',
  // Where a quote page could name its currency. None rendered in the 02:46Z
  // captures (no currency selector, label or account currency, and no "USD"
  // anywhere), so a bare "$" price there is never read as USD.
  currencyContextHooks: [
    '[data-test-target*="currency" i]',
    '[aria-label*="currency" i]',
  ],
  priceText: [
    '[data-test-target="quote-level-lead-time-price-selected"]',
    '[data-test-target="quote-level-lead-time-selected-option"]',
    '[data-test-target*="price"]',
    '[data-test-target*="cost"]',
    '[aria-label*="price" i]',
    '[class*="price"]',
    '[class*="cost"]',
  ],
  leadTimeText: [
    '[data-test-target="quote-level-lead-time-selected-option"]',
    '[data-test-target="quote-summary-est-delivery-value"]',
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
 * These terms only steer what the adapter clicks; a price is published only on
 * the material the priced quote reads back (see materialReadbackMatches).
 *
 * @param material Material text from requirements.
 * @returns Matched search terms or `null` when unmapped.
 */
export function buildMaterialSearchTerms(material: string) {
  const source = material.toLowerCase();
  return MATERIAL_TERM_MAPPINGS.find((mapping) => mapping.patterns.some((pattern) => source.includes(pattern)))?.terms
    ?? null;
}

// ---------------------------------------------------------------------------
// Material readback (OVD-1053 round 6, F18)
// ---------------------------------------------------------------------------

type MaterialFamily = "aluminum" | "stainless" | "steel" | "brass" | "copper" | "titanium" | "plastic";

/** Words that only name a material family; each one must agree with the alloy's family. */
const MATERIAL_FAMILY_WORDS: Readonly<Record<string, readonly MaterialFamily[]>> = {
  aluminum: ["aluminum"],
  al: ["aluminum"],
  alu: ["aluminum"],
  stainless: ["stainless"],
  ss: ["stainless"],
  ph: ["stainless"],
  steel: ["stainless", "steel"],
  carbon: ["steel"],
  mild: ["steel"],
  alloy: ["aluminum", "stainless", "steel", "brass", "copper", "titanium"],
  brass: ["brass"],
  copper: ["copper"],
  titanium: ["titanium"],
  ti: ["titanium"],
  plastic: ["plastic"],
};

/**
 * Alloys whose family is known, and for aluminum the temper class a
 * requirement that names no temper is read as (6061 aluminum is 6061-T6).
 * Any other three or four digit designation is still compared exactly.
 */
const KNOWN_ALLOYS: Readonly<Record<string, { family: MaterialFamily; defaultTemperClass?: string }>> = {
  "2024": { family: "aluminum", defaultTemperClass: "t3" },
  "6061": { family: "aluminum", defaultTemperClass: "t6" },
  "7075": { family: "aluminum", defaultTemperClass: "t6" },
  "303": { family: "stainless" },
  "304": { family: "stainless" },
  "304l": { family: "stainless" },
  "316": { family: "stainless" },
  "316l": { family: "stainless" },
  "17-4": { family: "stainless" },
  "1018": { family: "steel" },
  "4140": { family: "steel" },
  c360: { family: "brass" },
  c101: { family: "copper" },
  c110: { family: "copper" },
  peek: { family: "plastic" },
  abs: { family: "plastic" },
  acetal: { family: "plastic" },
  nylon: { family: "plastic" },
  nylon66: { family: "plastic" },
};

/** Plastic names, each read as one alloy (Delrin is Fictiv's acetal). */
const PLASTIC_ALIASES: Readonly<Record<string, string>> = {
  peek: "peek",
  abs: "abs",
  delrin: "acetal",
  acetal: "acetal",
  pom: "acetal",
  nylon: "nylon",
  nylon66: "nylon66",
};

/** An own entry of a lookup table, never an inherited one ("constructor" is not a material). */
function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

const MATERIAL_COLORS = new Set(["black", "white", "natural", "clear", "gray", "grey", "blue", "red", "beige", "tan"]);

type MaterialReading = {
  alloy: string;
  tempers: ReadonlySet<string>;
  colors: ReadonlySet<string>;
};

/** Lowercased tokens of a material label; designations written with a temper ("6061-T6") are split. */
function materialTokens(label: string) {
  const normalized = label
    .toLowerCase()
    .replaceAll(/[‐-―−]/g, "-")
    .replaceAll("aluminium", "aluminum")
    .replaceAll(/\bti[\s-]?6al[\s-]?4v\b|\b6al[\s-]?4v\b/g, " ti64 ")
    .replaceAll(/\b(?:grade|gr\.?)\s*(\d{1,2})\b/g, " grade$1 ")
    .replaceAll(/\b17[\s-]?4(?:\s*-?\s*ph)?\b/g, " 17-4 ")
    .replaceAll(/\bnylon\s*(?:6\s*\/\s*6|6\.6|6-6|66)\b|\bpa\s*66\b/g, " nylon66 ");
  const tokens: string[] = [];
  for (const raw of normalized.split(/[\s,/()+;:|&[\].]+/)) {
    if (!/[a-z0-9]/.test(raw)) continue;
    const designation = /^(al|ss)?-?(\d{3,4}[a-z]?)(?:-(t\d{1,5}|h\d{2,4}|o|f))?$/.exec(raw);
    if (designation) {
      if (designation[1]) tokens.push(designation[1]);
      tokens.push(designation[2]);
      if (designation[3]) tokens.push(`temper:${designation[3]}`);
      continue;
    }
    tokens.push(raw);
  }
  return tokens;
}

/** The one alloy a designation names, read with the family words around it; null when it names none. */
function canonicalAlloy(designation: string, familyWords: ReadonlySet<string>) {
  if (designation === "ti64") return "ti-grade5";
  const grade = /^grade(\d{1,2})$/.exec(designation);
  if (grade) return familyWords.has("titanium") || familyWords.has("ti") ? `ti-grade${grade[1]}` : null;
  const copperAlloy = /^c(\d{3})(?:00)?$/.exec(designation);
  if (copperAlloy) return `c${copperAlloy[1]}`;
  if (/^\d{3}$/.test(designation) && (familyWords.has("brass") || familyWords.has("copper"))) return `c${designation}`;
  return ownEntry(PLASTIC_ALIASES, designation) ?? designation;
}

/**
 * The alloy, tempers and colors a material label names, or null when the
 * label names no alloy, more than one, a family that contradicts the alloy,
 * or anything this reading does not know. Exported for tests.
 */
export function readMaterialLabel(label: string): MaterialReading | null {
  const familyWords = new Set<string>();
  const designations: string[] = [];
  const tempers = new Set<string>();
  const colors = new Set<string>();
  for (const token of materialTokens(label)) {
    if (token.startsWith("temper:")) {
      tempers.add(token.slice("temper:".length));
    } else if (ownEntry(MATERIAL_FAMILY_WORDS, token)) {
      familyWords.add(token);
    } else if (/^t\d{1,5}$/.test(token) || /^h\d{2,4}$/.test(token)) {
      tempers.add(token);
    } else if (MATERIAL_COLORS.has(token)) {
      colors.add(token === "grey" ? "gray" : token);
    } else if (
      /^\d{3,4}[a-z]?$/.test(token)
      || /^c\d{3}(?:00)?$/.test(token)
      || /^grade\d{1,2}$/.test(token)
      || token === "17-4"
      || token === "ti64"
      || ownEntry(PLASTIC_ALIASES, token) !== undefined
    ) {
      designations.push(token);
    } else {
      return null;
    }
  }

  const alloys = new Set(designations.map((designation) => canonicalAlloy(designation, familyWords)));
  if (alloys.size !== 1 || alloys.has(null)) return null;
  const alloy = [...alloys][0]!;
  const family = alloy.startsWith("ti-grade") ? "titanium" : ownEntry(KNOWN_ALLOYS, alloy)?.family ?? null;
  if (family && [...familyWords].some((word) => !ownEntry(MATERIAL_FAMILY_WORDS, word)!.includes(family))) return null;
  return { alloy, tempers, colors };
}

/**
 * An aluminum temper's class: the temper without its stress-relief suffix
 * (T651 and T6511 are T6, T7351 is T73, T351 is T3). Other tempers are their
 * own class.
 */
function temperClass(temper: string) {
  return /^(t\d+?)(?:51[01]?|52)?$/.exec(temper)?.[1] ?? temper;
}

function temperReadbackMatches(alloy: string, requested: ReadonlySet<string>, observed: ReadonlySet<string>) {
  const requestedClasses = new Set([...requested].map(temperClass));
  if (requestedClasses.size > 1) return false;
  const requiredClass = requestedClasses.size === 1
    ? [...requestedClasses][0]
    : ownEntry(KNOWN_ALLOYS, alloy)?.defaultTemperClass ?? null;
  if (observed.size === 0) return requested.size === 0;
  if (requiredClass === null) return false;
  if (![...observed].every((temper) => temperClass(temper) === requiredClass)) return false;
  return requested.size === 0 || [...requested].some((temper) => observed.has(temper));
}

function sameMembers(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  return left.size === right.size && [...left].every((member) => right.has(member));
}

/**
 * OVD-1053 round 6 (F18): whether the material label a priced Fictiv quote
 * shows is the requested material. The requirement's own alloy or grade is
 * compared, never the search mapping's: a different alloy (304L for 304), a
 * different titanium grade, or a requirement that names no grade at all
 * ("titanium") does not match. Tempers must agree by class: a requested
 * 6061-T6, T651 or T6511, or a 6061 requirement naming no temper (read as T6),
 * matches the live label "6061 Aluminum (T6 / T651 / T6511)"; a label that
 * names a temper of another class (O, T7351) or none at all for a requested
 * temper does not. Any label this reading does not know fails closed.
 */
export function materialReadbackMatches(requirementMaterial: string, observedLabel: string) {
  const requested = readMaterialLabel(requirementMaterial);
  const observed = readMaterialLabel(observedLabel);
  return requested !== null
    && observed !== null
    && requested.alloy === observed.alloy
    && sameMembers(requested.colors, observed.colors)
    && temperReadbackMatches(requested.alloy, requested.tempers, observed.tempers);
}

/** The label Fictiv shows for its CNC process on a priced quote: "CNC" or "CNC Machining", nothing else. */
const CNC_PROCESS_READBACK = /^CNC(?:\s+Machining)?$/i;

export function processReadbackMatches(observedLabel: string) {
  return CNC_PROCESS_READBACK.test(observedLabel.trim());
}

// ---------------------------------------------------------------------------
// Finish readback (OVD-1053 round 6, F17)
// ---------------------------------------------------------------------------

type FinishTreatment =
  | "as_machined"
  | "anodize"
  | "chem_film"
  | "bead_blast"
  | "media_blast"
  | "passivation"
  | "powder_coat"
  | "tumble";

type FinishParts = {
  treatments: Set<FinishTreatment>;
  types: Set<string>;
  classes: Set<string>;
  specs: Set<string>;
  colors: Set<string>;
};

const ROMAN_TYPES: Readonly<Record<string, string>> = { i: "1", ii: "2", iii: "3", "1": "1", "2": "2", "3": "3" };

/**
 * Every phrase a finish label is read from, in match order. Whatever is left
 * once these are taken out (separators aside) is unknown, and an unknown word
 * makes the whole label unreadable.
 */
const FINISH_PHRASES: ReadonlyArray<readonly [RegExp, (parts: FinishParts, match: RegExpMatchArray) => void]> = [
  [/\bmil-(?:a|c|dtl|prf|std)-\d{3,6}[a-z]?\b/g, (parts, match) => parts.specs.add(match[0])],
  [/\bno\s+finish\b|\bas[\s-]?machined\b|\bnone\b/g, (parts) => parts.treatments.add("as_machined")],
  [/\bhard[\s-]?(?:coat(?:ed|ing)?|anodi[sz](?:e|ed|ing))\b/g, (parts) => {
    parts.treatments.add("anodize");
    parts.types.add("3");
  }],
  [/\banodi[sz](?:e|ed|ing)\b/g, (parts) => parts.treatments.add("anodize")],
  [/\btype\s*(iii|ii|i|3|2|1)\b/g, (parts, match) => parts.types.add(ROMAN_TYPES[match[1]])],
  [/\bclass\s*(1a|1|2|3)\b/g, (parts, match) => parts.classes.add(match[1])],
  [
    /\bchem(?:ical)?[\s-]?film\b|\bchromate(?:\s+conversion)?(?:\s+coat(?:ed|ing)?)?\b|\balodine\b|\biridite\b/g,
    (parts) => parts.treatments.add("chem_film"),
  ],
  [/\bbead[\s-]?blast(?:ed|ing)?\b/g, (parts) => parts.treatments.add("bead_blast")],
  [/\bmedia[\s-]?blast(?:ed|ing)?\b/g, (parts) => parts.treatments.add("media_blast")],
  [/\bpassivat(?:e|ed|ion|ing)\b/g, (parts) => parts.treatments.add("passivation")],
  [/\bpowder[\s-]?coat(?:ed|ing)?\b/g, (parts) => parts.treatments.add("powder_coat")],
  [/\btumbl(?:e|ed|ing)\b/g, (parts) => parts.treatments.add("tumble")],
  [
    /\b(black|clear|red|blue|gold|green|orange|purple|gray|grey|bronze|yellow|natural|white)\b/g,
    (parts, match) => parts.colors.add(match[1] === "grey" ? "gray" : match[1]),
  ],
  [/\b(?:per|finish|color|colour|and|with)\b/g, () => undefined],
];

function readFinishParts(label: string): FinishParts | null {
  let rest = label.toLowerCase().replaceAll(/[‐-―−]/g, "-").replaceAll("&", " and ");
  const parts: FinishParts = {
    treatments: new Set(),
    types: new Set(),
    classes: new Set(),
    specs: new Set(),
    colors: new Set(),
  };
  for (const [pattern, read] of FINISH_PHRASES) {
    for (const match of rest.matchAll(pattern)) read(parts, match);
    rest = rest.replaceAll(pattern, " ");
  }
  return /[a-z0-9]/.test(rest) ? null : parts;
}

/**
 * A finish label as a sorted list of concepts (treatments, and the type,
 * class and color of the one treatment they belong to, and specs), or null
 * when it cannot be read whole. A requirement with no finish is as machined;
 * a requirement that names a treatment is that treatment even when it also
 * says "none", "no finish" or "as machined" somewhere (a note). A page label
 * keeps every treatment it names, as machined included, so "As machined +
 * Bead blast" never reads as either one alone.
 */
function finishConcepts(label: string | null, side: "requested" | "observed"): string[] | null {
  if (label === null || !label.trim()) return side === "requested" ? ["as_machined"] : null;
  const parts = readFinishParts(label);
  if (!parts) return null;
  const treatments = new Set(parts.treatments);
  if (side === "requested" && treatments.size > 1) treatments.delete("as_machined");
  if (treatments.size === 0) return null;

  // A type or class belongs to the one anodize or chem film treatment named;
  // with neither or both, the label is ambiguous.
  const typed = [...treatments].filter((treatment) => treatment === "anodize" || treatment === "chem_film");
  if ((parts.types.size > 0 || parts.classes.size > 0) && typed.length !== 1) return null;
  if (parts.types.size > 1 || parts.classes.size > 1) return null;
  const colorable = [...treatments].filter((treatment) =>
    treatment === "anodize" || treatment === "chem_film" || treatment === "powder_coat");
  if (parts.colors.size > 0 && colorable.length !== 1) return null;

  return [...new Set([
    ...treatments,
    ...[...parts.types].map((type) => `${typed[0]}:type:${type}`),
    ...[...parts.classes].map((finishClass) => `${typed[0]}:class:${finishClass}`),
    ...[...parts.colors].map((color) => `${colorable[0]}:color:${color}`),
    ...[...parts.specs].map((spec) => `spec:${spec}`),
  ])].sort();
}

/**
 * OVD-1053 round 6 (F17): whether the finish label a priced Fictiv quote
 * shows is exactly the requested finish. Both are read into the same
 * concepts (see finishConcepts) and must be equal: every treatment of a
 * compound finish, and its type, class, color and spec. Chem film per
 * MIL-DTL-5541 Type II is not Type II anodize; a Type II anodize requirement
 * with no color does not match a label naming one. Anything either side does
 * not read whole, or reads only in part, fails closed.
 */
export function finishReadbackMatches(requirementFinish: string | null, observedLabel: string) {
  const requested = finishConcepts(requirementFinish, "requested");
  const observed = finishConcepts(observedLabel, "observed");
  return requested !== null
    && observed !== null
    && requested.length === observed.length
    && requested.every((concept, index) => concept === observed[index]);
}

/**
 * Map a finish description to canonical Fictiv finish search terms.
 * Returns an empty array for "as-machined"/no-finish values, mapped terms for known finishes,
 * and `null` when the finish is present but unmapped. The finish is read the
 * way the readback reads it (see finishConcepts), so a finish the readback
 * can never confirm is unmapped (manual follow-up) instead of configured.
 *
 * @param finish Finish text from requirements, or `null` when absent.
 * @returns Search terms array, empty array for ignored/no-finish, or `null` when unmapped.
 */
export function buildFinishSearchTerms(finish: string | null) {
  const concepts = finishConcepts(finish, "requested");
  if (!concepts) return null;
  const has = (concept: string) => concepts.includes(concept);

  if (concepts.length === 1 && has("as_machined")) return [];
  if (has("anodize")) {
    if (has("anodize:type:3")) return ["Type III", "Hard Anodize"];
    if (has("anodize:type:2")) return has("anodize:color:black") ? ["Type II", "Black"] : ["Type II"];
    return null;
  }
  if (has("bead_blast")) return ["Bead Blast"];
  if (has("chem_film")) return ["Chromate", "Chem Film"];
  if (has("passivation")) return ["Passivation"];
  if (has("powder_coat")) return ["Powder Coat"];
  if (has("media_blast")) return ["Media Blast"];
  if (has("tumble")) return ["Tumbled", "Deburr"];

  return null;
}
