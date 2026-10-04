import { randomUUID } from "node:crypto";
import type { APIRequestContext, Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { test, expect } from "./test";

// Authenticated lane only (no @fixture tag): these cases need the local stack
// seeded by scripts/seed-dev.mjs, including e2e/fixtures/beta-access.sql.
const PASSWORD = "Overdrafter123!";
const CLIENT_EMAIL = "client.demo@overdrafter.local";
const OUTSIDER_EMAIL = "outsider.demo@overdrafter.local";
const UNENROLLED_EMAIL = "unenrolled.demo@overdrafter.local";
const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321";
const MAILPIT_URL = process.env.MAILPIT_URL ?? "http://127.0.0.1:54324";

// Seeded org A records: uuid(101) and uuid(21) from scripts/seed-dev.mjs.
const CLIENT_QUOTED_JOB_ID = "00000000-0000-4000-8000-000000000101";
const CLIENT_QUOTED_PROJECT_ID = "00000000-0000-4000-8000-000000000021";
const CLIENT_QUOTED_PROJECT_NAME = "Synthetic quote comparison";
// Seeded part names owned by client.demo; job titles contain them too.
const CLIENT_PART_NAMES = ["FX-100", "FX-101", "FX-200"];

const NOT_ENROLLED_MESSAGE = /Founding Beta invitation required to create new parts or upload files/;
const PART_DENIED_MESSAGE = "This part could not be loaded.";
const ACCESS_STATE_RPC = "api_get_founding_beta_access_state";
const WRITE_RPCS = [
  "api_create_client_draft",
  "api_create_job",
  "api_prepare_job_file_upload",
  "api_finalize_job_file_upload",
];

type ProbeRecord = { phase: string; name: string; text: string; path: string; at: number; signedIn: boolean };
type AccessScopeProbe = { phase: string; records: ProbeRecord[] };

declare global {
  interface Window {
    __accessScopeProbe?: AccessScopeProbe;
  }
}

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

/** Client-side route change without a document reload, as an in-app link would do. */
async function navigateWithinApp(page: Page, target: string) {
  await page.evaluate((path) => {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  }, target);
}

/** Records every rendered text or label that contains a watched name, tagged by phase. */
async function installPartNameObserver(page: Page, names: string[]) {
  await page.evaluate((watchedNames) => {
    const probe: AccessScopeProbe = { phase: "installed", records: [] };
    window.__accessScopeProbe = probe;

    const inspect = (text: string | null | undefined) => {
      if (!text) {
        return;
      }

      for (const name of watchedNames) {
        if (text.includes(name)) {
          probe.records.push({
            phase: probe.phase,
            name,
            text: text.slice(0, 200),
            path: window.location.pathname,
            at: Math.round(performance.now()),
            signedIn: Array.from(document.querySelectorAll("button")).some((button) =>
              /open account menu/i.test(button.getAttribute("aria-label") ?? button.textContent ?? ""),
            ),
          });
        }
      }
    };
    const inspectLabels = (element: Element) => {
      inspect(element.getAttribute("aria-label"));
      inspect(element.getAttribute("title"));
    };

    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "characterData") {
          inspect(mutation.target.textContent);
        } else if (mutation.type === "attributes") {
          inspectLabels(mutation.target as Element);
        } else {
          mutation.addedNodes.forEach((node) => {
            inspect(node.textContent);

            if (node instanceof Element) {
              inspectLabels(node);
              node.querySelectorAll("[aria-label], [title]").forEach(inspectLabels);
            }
          });
        }
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "title"],
    });
  }, names);
}

async function setProbePhase(page: Page, phase: string) {
  await page.evaluate((nextPhase) => {
    window.__accessScopeProbe!.phase = nextPhase;
  }, phase);
}

async function readProbeRecords(page: Page, ...phases: string[]): Promise<ProbeRecord[]> {
  return page.evaluate(
    (wantedPhases) => (window.__accessScopeProbe?.records ?? []).filter((record) => wantedPhases.includes(record.phase)),
    phases,
  );
}

async function readConfirmationUrl(request: APIRequestContext, email: string): Promise<string> {
  let confirmationUrl: string | null = null;

  await expect
    .poll(
      async () => {
        const search = await request.get(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
        if (!search.ok()) {
          return null;
        }

        const { messages = [] } = (await search.json()) as { messages?: Array<{ ID: string }> };
        if (messages.length === 0) {
          return null;
        }

        const message = (await (await request.get(`${MAILPIT_URL}/api/v1/message/${messages[0].ID}`)).json()) as {
          Text?: string;
        };
        const match = /https?:\/\/[^\s"'<>]+\/auth\/v1\/verify\?[^\s"'<>]+/.exec(message.Text ?? "");
        confirmationUrl = match ? match[0].replaceAll("&amp;", "&") : null;
        return confirmationUrl;
      },
      { message: `Mailpit should receive the confirmation email for ${email}`, timeout: 20_000 },
    )
    .not.toBeNull();

  return confirmationUrl!;
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

  test("switching accounts without a reload never renders the previous client's parts", async ({ browser, baseURL }) => {
    // Guards the access-scope reset in useWorkspaceNavigationModel: its stabilized parts
    // list is keyed by the signed-in user and membership, so it cannot outlive an in-tab
    // sign-out and sign-in. The leak it catches was timing-dependent; run it repeated.
    const actor = await openActor(browser, baseURL, CLIENT_EMAIL);

    try {
      const { page } = actor;
      const reviewPath = `/projects/${CLIENT_QUOTED_PROJECT_ID}/review?debug=1`;
      await expect(page).toHaveURL(/\/parts/);
      await expect(page.getByText("FX-100").first()).toBeVisible();

      await installPartNameObserver(page, CLIENT_PART_NAMES);

      // Positive control: the observer records the owner's own in-app render of
      // project-review data, which the client caches under unscoped keys.
      await setProbePhase(page, "owner");
      await navigateWithinApp(page, reviewPath);
      await expect(page.getByRole("heading", { name: CLIENT_QUOTED_PROJECT_NAME })).toBeVisible();
      await expect.poll(async () => (await readProbeRecords(page, "owner")).length).toBeGreaterThan(0);
      await navigateWithinApp(page, "/parts?debug=1");
      await expect(page.getByText("FX-100").first()).toBeVisible();

      await setProbePhase(page, "owner-parts");
      await page.getByRole("button", { name: /open account menu/i }).click();
      await page.getByRole("menuitem", { name: "Log out" }).click();
      await setProbePhase(page, "logout");
      await page.getByRole("button", { name: "Log out" }).click();
      await expect(page.getByRole("button", { name: /open account menu/i })).toHaveCount(0);

      await setProbePhase(page, "anonymous");
      await page.getByRole("button", { name: "Sign in" }).first().click();
      await setProbePhase(page, "outsider");
      await submitSignIn(page, OUTSIDER_EMAIL, PASSWORD);
      await expect(page.getByRole("heading", { name: "Parts", exact: true })).toBeVisible();
      await expect(page.getByText("No matching parts")).toBeVisible();

      // The outsider revisits the previous client's routes inside the same document.
      await navigateWithinApp(page, reviewPath);
      await expect(page.getByRole("heading", { name: "Project", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: CLIENT_QUOTED_PROJECT_NAME })).toHaveCount(0);
      await navigateWithinApp(page, `/parts/${CLIENT_QUOTED_JOB_ID}?debug=1`);
      await expect(page.getByText(PART_DENIED_MESSAGE)).toBeVisible();

      const records = await page.evaluate(() => window.__accessScopeProbe?.records ?? []);
      await test.info().attach("part-name-observer.json", {
        body: JSON.stringify(records, null, 2),
        contentType: "application/json",
      });

      // The probe survives only if no document reload purged the client state.
      expect(await page.evaluate(() => window.__accessScopeProbe?.phase)).toBe("outsider");
      expect(await readProbeRecords(page, "logout", "anonymous", "outsider")).toEqual([]);
    } finally {
      await actor.context.close();
    }
  });

  test("a confirmed self-service signup lands in the not-enrolled state", async ({ browser, baseURL, request }) => {
    const email = `signup-${randomUUID()}@overdrafter.local`;
    const password = `Signup-${randomUUID()}`;
    const context = await browser.newContext({ baseURL });

    try {
      const page = await context.newPage();
      const spy = installSupabaseSpy(page);

      await page.goto("/?auth=signup&debug=1", { waitUntil: "networkidle" });
      await page.locator("#auth-email").fill(email);
      await page.locator("#auth-password").fill(password);
      await page.locator("form").getByRole("button", { name: "Create account" }).click();
      await expect(page.getByText("Email verification required")).toBeVisible();

      // Positive control: the account cannot sign in before the emailed link is used.
      const apiKey = spy.apiKey();
      expect(apiKey).toBeTruthy();
      const unconfirmed = await request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        headers: { apikey: apiKey! },
        data: { email, password },
      });
      expect(unconfirmed.status()).toBe(400);
      expect(await unconfirmed.text()).toMatch(/email[_ ]not[_ ]confirmed/i);

      // The verify request itself confirms the address; its redirect is not followed
      // into the app, so no browser code exchange is needed before password sign-in.
      const confirmation = await request.get(await readConfirmationUrl(request, email), { maxRedirects: 0 });
      expect([302, 303]).toContain(confirmation.status());
      const location = confirmation.headers()["location"] ?? "";
      expect(location).toMatch(/[?#&](code|access_token)=/);
      expect(location).not.toMatch(/error/i);

      await page.goto("/?auth=signin&debug=1", { waitUntil: "networkidle" });
      await submitSignIn(page, email, password);
      await expect(page).toHaveURL(/\/parts/, { timeout: 15_000 });
      await expect(foundingBetaNotice(page)).toContainText(NOT_ENROLLED_MESSAGE);
      expect(new Set(spy.accessStates())).toEqual(new Set(["not_enrolled"]));
    } finally {
      await context.close();
    }
  });
});
