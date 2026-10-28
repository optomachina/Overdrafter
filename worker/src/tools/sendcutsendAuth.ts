import {
  checkSendCutSendCurrentUser,
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

/** What the signed-in check saw: the outcome and the HTTP status only, never the body. */
export type SendCutSendSessionCheck = { signedIn: boolean; detail: string };

/**
 * Runs the shared in-page check (`checkSendCutSendCurrentUser`) on the quote
 * page: only a boolean and a status come back, never the body. The whole
 * check is raced against `timeoutMs`.
 */
async function checkSignedInUser(page: SessionPage, timeoutMs: number): Promise<SendCutSendSessionCheck> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<SendCutSendSessionCheck>((resolve) => {
    timer = setTimeout(() => resolve({ signedIn: false, detail: "timed out" }), timeoutMs);
  });
  const check = (async () => {
    await page.goto(SENDCUTSEND_QUOTE_URL, { waitUntil: "domcontentloaded" });
    const result: unknown = await page.evaluate(checkSendCutSendCurrentUser);
    const record = result !== null && typeof result === "object" ? result as Record<string, unknown> : {};
    // Only an explicit `true` counts; anything malformed is not signed in.
    return {
      signedIn: record.signedIn === true,
      detail: typeof record.detail === "string" ? record.detail : "malformed session check",
    };
  })().catch(() => ({ signedIn: false, detail: "page check failed" }));
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
  const headed = await checkSignedInUser(session.page, timeoutMs);
  if (!headed.signedIn) {
    throw new Error(`SendCutSend did not report a signed-in user (${headed.detail}); nothing was saved.`);
  }
  const filtered = filterSendCutSendStorageState(await session.context.storageState());
  if (filtered.keptCookies === 0) {
    throw new Error("No SendCutSend app cookie was found; nothing was saved.");
  }
  const verification = await session.browser.newContext({ storageState: filtered.state as never });
  try {
    const kept = await checkSignedInUser(await verification.newPage(), timeoutMs);
    if (!kept.signedIn) {
      throw new Error(
        `The SendCutSend session does not survive the exact-host filter (${kept.detail}; dropped cookies for: `
        + `${filtered.droppedCookieDomains.join(", ") || "none"}); nothing was saved.`,
      );
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
