import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const authDir = path.join(repoRoot, "playwright", ".auth");

const accounts = [
  {
    email: "client.demo@overdrafter.local",
    password: "Overdrafter123!",
    storageStatePath: path.join(authDir, "client.json"),
    waitFor: (page) => page.getByRole("button", { name: /open account menu/i }).waitFor({ state: "visible", timeout: 15000 }),
  },
  {
    email: "estimator.demo@overdrafter.local",
    password: "Overdrafter123!",
    storageStatePath: path.join(authDir, "internal.json"),
    waitFor: (page) => page.getByText("Operations Dashboard").waitFor({ state: "visible", timeout: 15000 }),
  },
];

export function getBaseUrl() {
  return process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";
}

export async function ensureAuthStates() {
  await mkdir(authDir, { recursive: true });

  for (const account of accounts) {
    await createStorageState(account);
  }
}

async function createStorageState(account) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(`${getBaseUrl()}/?auth=signin&debug=1`, {
      waitUntil: "networkidle",
    });

    await page.locator("#auth-email").fill(account.email);
    await page.locator("#auth-password").fill(account.password);
    await page.getByRole("button", { name: /^Log in$/ }).click();
    await account.waitFor(page);
    await page.context().storageState({ path: account.storageStatePath });
  } finally {
    await browser.close();
  }
}
