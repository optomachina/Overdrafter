export const AR_UNAVAILABLE = "AR needs Safari on iPhone or iPad, or Chrome on an Android phone with Google Play Services for AR. The 3D view works on this device.";
export const AR_SAFARI = "AR may not open inside the installed app on iPhone. Open this model in Safari to view it in AR.";

export interface ArModel {
  name: string;
  glbUrl?: string;
  usdzUrl?: string;
  viewUrl: string;
}
export interface ArDevice {
  userAgent: string;
  maxTouchPoints: number;
  standalone: boolean;
  supportsAr: boolean;
}
export type ArSupport = { state: "available"; mode: "quick-look" | "scene-viewer"; href: string }
  | { state: "ar-safari"; href: string }
  | { state: "unavailable" };

export function isHttps(url?: string): boolean {
  // Loopback http is a secure context in every browser, so local and fixture runs behave like https.
  try { const u = new URL(url ?? ""); return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)); } catch { return false; }
}

// Small adapter boundary for model-viewer's canActivateAR/activateAR after OVD-804.
export function detectAr(model: ArModel, device: ArDevice): ArSupport {
  const ios = /iPad|iPhone|iPod/i.test(device.userAgent)
    || (/Macintosh/i.test(device.userAgent) && device.maxTouchPoints > 1);
  if (ios && device.standalone) return isHttps(model.usdzUrl) && isHttps(model.viewUrl)
    ? { state: "ar-safari", href: model.viewUrl } : { state: "unavailable" };
  if (ios && device.supportsAr && isHttps(model.usdzUrl)) return { state: "available", mode: "quick-look", href: model.usdzUrl! };
  if (!ios && /Android/i.test(device.userAgent) && isHttps(model.glbUrl) && isHttps(model.viewUrl)) {
    return { state: "available", mode: "scene-viewer", href: `intent://arvr.google.com/scene-viewer/1.0?file=${encodeURIComponent(model.glbUrl!)}&mode=ar_preferred&title=${encodeURIComponent(model.name)}#Intent;scheme=https;package=com.google.ar.core;action=android.intent.action.VIEW;S.browser_fallback_url=${encodeURIComponent(model.viewUrl)};end;` };
  }
  return { state: "unavailable" };
}

export function browserArDevice(): ArDevice {
  if (typeof navigator === "undefined" || typeof document === "undefined") {
    return { userAgent: "", maxTouchPoints: 0, standalone: false, supportsAr: false };
  }
  let supportsAr = false;
  try { supportsAr = document.createElement("a").relList.supports("ar"); } catch { /* Older browsers. */ }
  return { userAgent: navigator.userAgent, maxTouchPoints: navigator.maxTouchPoints,
    standalone: (navigator as Navigator & { standalone?: boolean }).standalone === true, supportsAr };
}
