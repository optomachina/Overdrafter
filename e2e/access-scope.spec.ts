import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { test, expect } from "./test";

// Authenticated lane only (no @fixture tag): these cases need the local stack
// seeded by scripts/seed-dev.mjs, including e2e/fixtures/beta-access.sql.
const PASSWORD = "Overdrafter123!";
const CLIENT_EMAIL = "client.demo@overdrafter.local";
const OUTSIDER_EMAIL = "outsider.demo@overdrafter.local";
const UNENROLLED_EMAIL = "unenrolled.demo@overdrafter.local";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321";

// Seeded org A job: uuid(101) from scripts/seed-dev.mjs.
const CLIENT_QUOTED_JOB_ID = "00000000-0000-4000-8000-000000000101";

const NOT_ENROLLED_MESSAGE = /Founding Beta invitation required to create new parts or upload files/;
const PART_DENIED_MESSAGE = "This part could not be loaded.";
const ACCESS_STATE_RPC = "api_get_founding_beta_access_state";
const WRITE_RPCS = [
  "api_create_client_draft",
  "api_create_job",
  "api_prepare_job_file_upload",
  "api_finalize_job_file_upload",
];

type Actor = { context: BrowserContext; page: Page; spy: SupabaseSpy };

type SupabaseSpy = {
  apiKey: () => string | null;
  rpcNames: () => string[];
  storageUploads: () => string[];
  accessStates: () => string[];
};

/** Records this page's PostgREST RPC and Storage object traffic. */
function installSupabaseSpy(page: Page): SupabaseSpy {
  let apiKey: string | null = null;
  const rpcNames: string[] = [];
  const storageUploads: string[] = [];
  const accessStates: string[] = [];

  page.on("request", (request) => {
    const url = new URL(request.url());

    if (url.origin !== new URL(SUPABASE_URL).origin) {
      return;
    }

    apiKey ??= request.headers()["apikey"] ?? null;

    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      rpcNames.push(url.pathname.slice("/rest/v1/rpc/".length));
    }

    if (url.pathname.startsWith("/storage/v1/object/") && ["POST", "PUT"].includes(request.method())) {
      storageUploads.push(`${request.method()} ${url.pathname}`);
    }
  });

  page.on("response", async (response) => {
    if (!response.url().includes(`/rest/v1/rpc/${ACCESS_STATE_RPC}`) || !response.ok()) {
      return;
    }

    const body = (await response.json().catch(() => null)) as { state?: unknown } | null;
    if (typeof body?.state === "string") {
      accessStates.push(body.state);
    }
  });

  return {
    apiKey: () => apiKey,
    rpcNames: () => [...rpcNames],
    storageUploads: () => [...storageUploads],
    accessStates: () => [...accessStates],
  };
}

async function submitSignIn(page: Page, email: string, password: string) {
  await page.locator("#auth-email").fill(email);
  await page.locator("#auth-password").fill(password);
  await page.locator("form").getByRole("button", { name: /^Log in$/ }).click();
  await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible({ timeout: 15_000 });
}

/** Signs in with the e2e/auth.mjs selectors inside a fresh browser context. */
async function openActor(browser: Browser, baseURL: string | undefined, email: string, password = PASSWORD): Promise<Actor> {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const spy = installSupabaseSpy(page);

  await page.goto("/?auth=signin&debug=1", { waitUntil: "networkidle" });
  await submitSignIn(page, email, password);

  return { context, page, spy };
}

async function readAccessToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);

      if (key && /^sb-.+-auth-token$/.test(key)) {
        const session = JSON.parse(window.localStorage.getItem(key) ?? "null") as { access_token?: unknown } | null;
        return typeof session?.access_token === "string" ? session.access_token : null;
      }
    }

    return null;
  });

  expect(token, "the page should hold a Supabase session").toBeTruthy();
  return token!;
}

/** Reads one job through PostgREST with the page's own session token. */
async function readJobRows(actor: Actor, jobId: string): Promise<unknown> {
  const apiKey = actor.spy.apiKey();
  expect(apiKey, "the app should have called Supabase with its publishable key").toBeTruthy();

  const response = await actor.page.request.get(`${SUPABASE_URL}/rest/v1/jobs?id=eq.${jobId}&select=id`, {
    headers: {
      apikey: apiKey!,
      Authorization: `Bearer ${await readAccessToken(actor.page)}`,
    },
  });

  expect(response.status()).toBe(200);
  return response.json();
}

function foundingBetaNotice(page: Page): Locator {
  return page.locator("section").filter({ hasText: "Founding Beta new-part access" });
}

function notEnrolledToast(page: Page): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: NOT_ENROLLED_MESSAGE });
}

test.describe("Founding Beta enrollment and organization access scope", () => {
  test.describe.configure({ timeout: 120_000 });

  test("an enrolled client's intake control opens a file chooser", async ({ browser, baseURL }) => {
    const actor = await openActor(browser, baseURL, CLIENT_EMAIL);

    try {
      const { page } = actor;
      await expect(page).toHaveURL(/\/parts/);
      await expect(page.getByRole("heading", { name: "Parts", exact: true })).toBeVisible();
      await expect.poll(() => actor.spy.accessStates()).toContain("eligible");
      await expect(foundingBetaNotice(page)).toHaveCount(0);

      const fileChooser = page.waitForEvent("filechooser", { timeout: 10_000 });
      await page.getByRole("button", { name: "Upload", exact: true }).click();

      expect((await fileChooser).isMultiple()).toBe(true);
    } finally {
      await actor.context.close();
    }
  });

  test("an unenrolled client's intake shows the not-enrolled message and writes nothing", async ({ browser, baseURL }) => {
    const actor = await openActor(browser, baseURL, UNENROLLED_EMAIL);

    try {
      const { page, spy } = actor;
      let fileChooserCount = 0;
      page.on("filechooser", () => {
        fileChooserCount += 1;
      });

      await expect(page).toHaveURL(/\/parts/);
      await expect(foundingBetaNotice(page)).toContainText(NOT_ENROLLED_MESSAGE);

      await page.getByRole("button", { name: "Upload", exact: true }).click();
      await expect(notEnrolledToast(page)).toHaveCount(1);

      // Files placed straight into the hidden input must stay client-side too.
      await page.getByLabel("Choose part files to upload").setInputFiles({
        name: "blocked-part.step",
        mimeType: "model/step",
        buffer: Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n"),
      });
      await expect(notEnrolledToast(page)).toHaveCount(2);

      // Positive control: the spy saw this page's live access checks, all of which
      // classified the actor as not enrolled.
      const accessChecks = spy.rpcNames().filter((name) => name === ACCESS_STATE_RPC);
      expect(accessChecks.length).toBeGreaterThanOrEqual(3);
      expect(new Set(spy.accessStates())).toEqual(new Set(["not_enrolled"]));

      expect(fileChooserCount).toBe(0);
      expect(spy.rpcNames().filter((name) => WRITE_RPCS.includes(name))).toEqual([]);
      expect(spy.storageUploads()).toEqual([]);
    } finally {
      await actor.context.close();
    }
  });

  test("an outsider cannot open or read another organization's part", async ({ browser, baseURL }) => {
    const partPath = `/parts/${CLIENT_QUOTED_JOB_ID}?debug=1`;
    const owner = await openActor(browser, baseURL, CLIENT_EMAIL);
    const outsider = await openActor(browser, baseURL, OUTSIDER_EMAIL);

    try {
      // Positive control: the owning client opens the same URL and reads the job.
      await owner.page.goto(partPath);
      await expect(owner.page.getByText("FX-101").first()).toBeVisible();
      await expect(owner.page.getByText(PART_DENIED_MESSAGE)).toHaveCount(0);
      expect(await readJobRows(owner, CLIENT_QUOTED_JOB_ID)).toEqual([{ id: CLIENT_QUOTED_JOB_ID }]);

      await outsider.page.goto(partPath);
      await expect(outsider.page.getByRole("button", { name: /open account menu/i })).toBeVisible();
      await expect(outsider.page.getByText(PART_DENIED_MESSAGE)).toBeVisible();
      await expect(outsider.page.getByText(/FX-10[01]/)).toHaveCount(0);
      expect(await readJobRows(outsider, CLIENT_QUOTED_JOB_ID)).toEqual([]);
    } finally {
      await owner.context.close();
      await outsider.context.close();
    }
  });
});
