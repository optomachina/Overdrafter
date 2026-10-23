import {
  filterSendCutSendStorageState,
  SENDCUTSEND_ALLOWED_HOSTS,
  SENDCUTSEND_QUOTE_URL,
} from "../adapters/sendcutsendPortal.js";
import { writePrivateStorageState } from "./privateStorageState.js";

type SessionContext = { storageState(): Promise<unknown> };
type SessionPage = {
  goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown>;
  evaluate<T>(fn: () => Promise<T>): Promise<T>;
};

/**
 * OVD-1056: how `auth:vendor sendcutsend` saves the operator's own session for
 * the quote-only sheet evaluation. The operator signs in by hand in the
 * headed browser that vendorAuth opens; nothing here types or reads
 * credentials. Only the definition's exact-host cookies and local storage
 * are kept (the kernel refuses any other), and nothing is saved unless the
 * app reports a signed-in user.
 */
export const SENDCUTSEND_SESSION_BOOTSTRAP = Object.freeze({
  vendor: "sendcutsend" as const,
  displayName: "SendCutSend",
  loginUrl: SENDCUTSEND_QUOTE_URL,
  instructions: [
    "1. A Chromium window opens on the SendCutSend quote page.",
    "2. Click LOGIN and sign in to your existing account by hand.",
    "3. Confirm the header no longer shows LOGIN. Do not upload anything.",
    "4. Return here and press Enter.",
  ],
  save: saveSendCutSendSession,
});

export async function saveSendCutSendSession(
  context: SessionContext,
  page: SessionPage,
  outputPath: string,
  log: (line: string) => void = console.log,
): Promise<void> {
  // A same-origin status read only; the response body is never read.
  await page.goto(SENDCUTSEND_QUOTE_URL, { waitUntil: "domcontentloaded" });
  const status = await page.evaluate(async () => {
    const response = await fetch("/users/current", { credentials: "same-origin", headers: { Accept: "application/json" } });
    return response.status;
  }).catch(() => 0);
  if (status !== 200) {
    throw new Error(`SendCutSend did not report a signed-in user (status ${status}); nothing was saved.`);
  }
  const filtered = filterSendCutSendStorageState(await context.storageState());
  if (filtered.keptCookies === 0) {
    throw new Error("No SendCutSend app cookie was found; nothing was saved.");
  }
  await writePrivateStorageState({ storageState: async () => filtered.state }, outputPath);
  log(`Saved SendCutSend storage state to: ${outputPath}`);
  log(`Kept ${filtered.keptCookies} cookie(s) for ${SENDCUTSEND_ALLOWED_HOSTS.join(", ")}.`);
  if (filtered.droppedCookieDomains.length > 0) {
    log(`Dropped cookies for: ${filtered.droppedCookieDomains.join(", ")}`);
  }
}
