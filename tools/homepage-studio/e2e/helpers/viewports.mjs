// The three layouts the studio is exercised at. Touch contexts use CDP touch emulation (not a real device).
export const DESKTOP = { name: "desktop 1024x768", viewport: { width: 1024, height: 768 }, touch: false };
export const TABLET = { name: "tablet 768x1024 touch", viewport: { width: 768, height: 1024 }, touch: true };
export const PHONE = { name: "phone 390x844 touch", viewport: { width: 390, height: 844 }, touch: true };
export const VIEWPORTS = [DESKTOP, TABLET, PHONE];
