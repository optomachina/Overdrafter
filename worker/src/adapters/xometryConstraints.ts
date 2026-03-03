export const XOMETRY_URLS = {
  quoteHome: "https://www.xometry.com/quoting/home/",
  login: "https://www.xometry.com/login/",
} as const;

export const XOMETRY_LOCATORS = {
  loginSignals: [/sign in/i, /log in/i, /continue with/i],
  captchaSignals: [/captcha/i, /verify you are human/i, /recaptcha/i],
  uploadInputs: [
    '[data-testid="file-upload"] input[type="file"]',
    'input[type="file"]',
  ],
  quoteReadySignals: [
    /configure part/i,
    /edit specifications/i,
    /\$\d[\d,]*\.?\d*/i,
  ],
  quantityInputs: [
    '[data-testid*="quantity"] input',
    'input[name*="quantity"]',
    'input[id*="quantity"]',
  ],
  materialButtons: [
    '[data-testid*="material"]',
    '[aria-label*="material"]',
    'button:has-text("Material")',
  ],
  materialOptions: [
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
    '[role="option"]',
    '[data-testid*="option"]',
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
  if (source.includes("304")) return ["304 Stainless", "304"];
  if (source.includes("316")) return ["316 Stainless", "316"];
  if (source.includes("17-4")) return ["17-4 PH", "17-4"];
  if (source.includes("delrin")) return ["Delrin", "Acetal"];

  return [material];
}

export function buildFinishSearchTerms(finish: string | null) {
  if (!finish) return [];

  const source = finish.toLowerCase();

  if (source.includes("type iii")) return ["Type III", "Hard Anodize"];
  if (source.includes("type ii") && source.includes("black")) return ["Type II", "Black"];
  if (source.includes("type ii")) return ["Type II"];
  if (source.includes("bead")) return ["Bead Blast"];
  if (source.includes("chem")) return ["Chromate", "Chem Film"];
  if (source.includes("passivat")) return ["Passivation"];
  if (source.includes("powder")) return ["Powder Coat"];

  return [finish];
}
