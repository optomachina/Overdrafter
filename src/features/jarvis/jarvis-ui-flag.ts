// Server-side rollout flag for the Jarvis UI front door (OVD-795 section 8). Default off:
// only the exact string "true" turns it on, matching the billing flags.
export const JARVIS_UI_FLAG = "JARVIS_UI_ENABLED";

export function isJarvisUiEnabled(value: string | undefined): boolean {
  return value === "true";
}
