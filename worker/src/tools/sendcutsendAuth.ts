import {
  filterSendCutSendStorageState,
  SENDCUTSEND_ALLOWED_HOSTS,
  SENDCUTSEND_QUOTE_URL,
} from "../adapters/sendcutsendPortal.js";
import { writePrivateStorageState } from "./privateStorageState.js";

type SessionPage = {
  goto(url: string, options: { waitUntil: "domcontentloaded" }): Promise<unknown>;
  evaluate<T>(fn: () => Promise<T>): Promise<T>;
};
type SessionContext = {
  storageState(): Promise<unknown>;
  newPage(): Promise<SessionPage>;
  close(): Promise<void>;
};
/** Structural, so this module stays free of a browser import; the storage state is Playwright's own shape. */
type SessionBrowser = {
  newContext(options: { storageState: never }): Promise<SessionContext>;
};

/**
 * OVD-1056: how `auth:vendor sendcutsend` saves the operator's own session for
 * the quote-only sheet evaluation. The operator signs in by hand in the
 * headed browser that vendorAuth opens; nothing here types or reads
 * credentials. Only the definition's exact-host cookies and local storage
 * are kept (the kernel refuses any other), and nothing is saved unless the
 * app reports a signed-in, non-guest user before and after that filter.
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

/** Bound for the whole signed-in check; a stalled response or body counts as not signed in. */
export const SENDCUTSEND_SESSION_CHECK_TIMEOUT_MS = 15_000;

/**
 * True only when the app reports a signed-in, non-guest user. The check runs
 * in the page and returns a boolean; the response body never leaves it. The
 * fetch aborts after 10 s inside the page and the evaluation itself is raced
 * against `timeoutMs`, so neither stalled headers nor a stalled body can hang.
 */
async function reportsSignedInUser(page: SessionPage, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const check = (async () => {
    await page.goto(SENDCUTSEND_QUOTE_URL, { waitUntil: "domcontentloaded" });
    return page.evaluate(async () => {
      const controller = new AbortController();
      const abort = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch("/users/current", {
          credentials: "same-origin", headers: { Accept: "application/json" }, signal: controller.signal,
        });
        if (response.status !== 200) return false;
        const user = await response.json() as { id?: unknown; guest?: unknown } | null;
        return Boolean(user && (typeof user.id === "number" || typeof user.id === "string") && !user.guest);
      } catch {
        return false;
      } finally {
        clearTimeout(abort);
      }
    });
  })().catch(() => false);
  try {
    return await Promise.race([check, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Saves the filtered session only after a fresh context built from exactly
 * that filtered state still reports the signed-in user, so a session cookie
 * on a dropped domain cannot produce a file that silently runs signed out.
 */
export async function saveSendCutSendSession(
  session: { browser: SessionBrowser; context: SessionContext; page: SessionPage },
  outputPath: string,
  log: (line: string) => void = console.log,
  timeoutMs: number = SENDCUTSEND_SESSION_CHECK_TIMEOUT_MS,
): Promise<void> {
  if (!(await reportsSignedInUser(session.page, timeoutMs))) {
    throw new Error("SendCutSend did not report a signed-in user; nothing was saved.");
  }
  const filtered = filterSendCutSendStorageState(await session.context.storageState());
  if (filtered.keptCookies === 0) {
    throw new Error("No SendCutSend app cookie was found; nothing was saved.");
  }
  const verification = await session.browser.newContext({ storageState: filtered.state as never });
  try {
    if (!(await reportsSignedInUser(await verification.newPage(), timeoutMs))) {
      throw new Error("The SendCutSend session does not survive the exact-host filter; nothing was saved.");
    }
  } finally {
    await verification.close();
  }
  await writePrivateStorageState({ storageState: async () => filtered.state }, outputPath);
  log(`Saved SendCutSend storage state to: ${outputPath}`);
  log(`Kept ${filtered.keptCookies} cookie(s) for ${SENDCUTSEND_ALLOWED_HOSTS.join(", ")}.`);
  if (filtered.droppedCookieDomains.length > 0) {
    log(`Dropped cookies for: ${filtered.droppedCookieDomains.join(", ")}`);
  }
}
