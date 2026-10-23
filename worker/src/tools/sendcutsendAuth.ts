import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { chromium } from "playwright";
import {
  filterSendCutSendStorageState,
  SENDCUTSEND_ALLOWED_HOSTS,
  SENDCUTSEND_QUOTE_URL,
} from "../adapters/sendcutsendPortal.js";
import { writePrivateStorageState } from "./privateStorageState.js";

/**
 * OVD-1056: saves the operator's own SendCutSend session for the quote-only
 * sheet evaluation. The operator signs in by hand in a visible browser; this
 * tool never types or reads credentials. It saves only the cookies and local
 * storage of the definition's exact hosts (the kernel refuses any other) and
 * refuses to save unless the app reports a signed-in user.
 */
export async function bootstrapSendCutSendSession(outputPath: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
  try {
    console.log("");
    console.log("SendCutSend Playwright Session Bootstrap");
    console.log(`Storage state output: ${outputPath}`);
    console.log("");
    console.log("What to do:");
    console.log("1. A Chromium window opens on the SendCutSend quote page.");
    console.log("2. Click LOGIN and sign in to your existing account by hand.");
    console.log("3. Confirm the header no longer shows LOGIN. Do not upload anything.");
    console.log("4. Return here and press Enter.");
    console.log("");

    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(SENDCUTSEND_QUOTE_URL, { waitUntil: "domcontentloaded" });
    await rl.question("Press Enter after you are signed in...");

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

    console.log("");
    console.log(`Saved SendCutSend storage state to: ${outputPath}`);
    console.log(`Kept ${filtered.keptCookies} cookie(s) for ${SENDCUTSEND_ALLOWED_HOSTS.join(", ")}.`);
    if (filtered.droppedCookieDomains.length > 0) {
      console.log(`Dropped cookies for: ${filtered.droppedCookieDomains.join(", ")}`);
    }
  } finally {
    rl.close();
    await browser?.close();
  }
}
