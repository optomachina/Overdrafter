import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Browser, Locator, Page, Request } from "@playwright/test";
import { test, expect } from "./test";

// Authenticated lane only (no @fixture tag): these cases need the local stack
// seeded by scripts/seed-dev.mjs, whose e2e/fixtures/beta-access.sql enrolls
// client.demo's organization in Founding Beta. No worker runs in this lane, so
// CAD extraction never completes; the cases stop at browser intake, routing and
// the in-browser CAD viewer.
const CLIENT_EMAIL = "client.demo@overdrafter.local";
const CLIENT_PASSWORD = "Overdrafter123!";
const SUPABASE_ORIGIN = new URL(process.env.VITE_SUPABASE_URL ?? "http://127.0.0.1:54321").origin;

// Fixture Machine Co., client.demo's organization: uuid(1) from scripts/seed-dev.mjs.
const CLIENT_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";

const SAMPLE_STEP = fixtureFile("../test-fixtures/quoted-sample/1093-05589-02.STEP");
// Intake titles the draft with the file name; the part header splits it into part number and revision.
const SAMPLE_JOB_TITLE = "1093-05589-02";
const SAMPLE_PART_LABEL = /^1093-05589 rev 02$/i;
const EMPTY_STEP = fixtureFile("./fixtures/intake/empty.step");
const GARBAGE_STEP = fixtureFile("./fixtures/intake/garbage.step");
// Storage objects holding the quoted-sample model: the seeded copy (fixtures/quoted-sample.step),
// which a same-bytes intake reuses, and a fresh upload (org-sha256/<org>/<sha256>/1093-05589-02.step).
const SAMPLE_MODEL_OBJECT = /^\/storage\/v1\/object\/.+\/(?:quoted-sample|1093-05589-02)\.step$/i;

const PART_URL = /\/parts\/([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})(?:[?#]|$)/;
const CREATE_DRAFT_RPC = "api_create_client_draft";
// Every RPC the client intake path calls once a selection passes validation.
const INTAKE_RPCS = new Set([
  "api_prepare_part_intake",
  CREATE_DRAFT_RPC,
  "api_create_job",
  "api_prepare_job_file_upload",
  "api_finalize_job_file_upload",
  "api_reconcile_job_parts",
  "api_request_extraction",
]);
const BUSY_MESSAGE = "An upload is already in progress. Please wait before adding more files.";
const EMPTY_FILE_MESSAGE = "empty.step is empty. Choose a file with content.";

function fixtureFile(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

/** The PostgREST function a browser POST calls, or null for any other request. */
function rpcCalled(request: Request): string | null {
  const url = new URL(request.url());
  const match = /^\/rest\/v1\/rpc\/(\w+)$/.exec(url.pathname);

  return request.method() === "POST" && url.origin === SUPABASE_ORIGIN && match ? match[1] : null;
}

type ClientSession = {
  page: Page;
  /** Intake RPCs this page has sent, in order. */
  intakeCalls: () => string[];
  /** Counts the organization's jobs through PostgREST with the page's own session. */
  countJobs: () => Promise<number>;
  readJob: (jobId: string) => Promise<unknown>;
  close: () => Promise<void>;
};

/** Signs client.demo in through the auth dialog in a fresh browser context. */
async function openClientSession(browser: Browser, baseURL: string | undefined): Promise<ClientSession> {
  const context = await browser.newContext({ baseURL });
  // Meshing the quoted-sample model blocks a page's main thread for seconds (about 3.6 s per
  // copy on a 4-vCPU runner), and client.demo pages mesh every copy they show: the seeded parts
  // listed on /parts and the part page viewer. These cases test intake, routing and the intake
  // guards, not rendering, so their pages skip downloading that model for previews and do not
  // compete with parallel specs for CPU. Uploads still go through, and case 4 still runs the
  // browser CAD kernel on its own fixture.
  await context.route(
    (url) => url.origin === SUPABASE_ORIGIN && SAMPLE_MODEL_OBJECT.test(url.pathname),
    (route) => (route.request().method() === "GET" ? route.abort() : route.continue()),
  );
  const page = await context.newPage();
  const intakeCalls: string[] = [];
  let publishableKey: string | undefined;

  page.on("request", (request) => {
    if (new URL(request.url()).origin !== SUPABASE_ORIGIN) {
      return;
    }

    publishableKey ??= request.headers()["apikey"];
    const rpc = rpcCalled(request);
    if (rpc && INTAKE_RPCS.has(rpc)) {
      intakeCalls.push(rpc);
    }
  });

  await page.goto("/?auth=signin&debug=1");
  await page.locator("#auth-email").fill(CLIENT_EMAIL);
  await page.locator("#auth-password").fill(CLIENT_PASSWORD);
  await page.locator("form").getByRole("button", { name: /^Log in$/ }).click();
  await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/parts/);
  await expect(page.getByRole("heading", { name: "Parts", exact: true })).toBeVisible();

  const restGet = async (pathAndQuery: string): Promise<unknown> => {
    const accessToken = await page.evaluate(() => {
      const key = Object.keys(window.localStorage).find((name) => /^sb-.+-auth-token$/.test(name));
      const stored: { access_token?: unknown } | null = key
        ? JSON.parse(window.localStorage.getItem(key) ?? "null")
        : null;
      return typeof stored?.access_token === "string" ? stored.access_token : null;
    });
    expect(accessToken, "the page should hold client.demo's Supabase session").toBeTruthy();
    expect(publishableKey, "the app should have called Supabase with its publishable key").toBeTruthy();

    const response = await page.request.get(`${SUPABASE_ORIGIN}/rest/v1/${pathAndQuery}`, {
      headers: { apikey: publishableKey!, Authorization: `Bearer ${accessToken}` },
    });
    expect(response.status(), `GET /rest/v1/${pathAndQuery}`).toBe(200);
    return response.json();
  };

  return {
    page,
    intakeCalls: () => [...intakeCalls],
    countJobs: async () => {
      const rows = await restGet(`jobs?select=id&organization_id=eq.${CLIENT_ORGANIZATION_ID}`);
      expect(Array.isArray(rows)).toBe(true);
      return (rows as unknown[]).length;
    },
    readJob: (jobId) => restGet(`jobs?select=id,title&id=eq.${jobId}`),
    close: () => context.close(),
  };
}

type HeldRpc = {
  calls: () => number;
  answered: () => number;
  release: () => void;
};

/** Holds the page's first call to `rpc` until release(); later calls pass straight through. */
async function holdFirstRpc(page: Page, rpc: string): Promise<HeldRpc> {
  let calls = 0;
  let answered = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const countAnswer = (request: Request) => {
    if (rpcCalled(request) === rpc) {
      answered += 1;
    }
  };

  page.on("requestfinished", countAnswer);
  page.on("requestfailed", countAnswer);
  await page.route(
    (url) => url.origin === SUPABASE_ORIGIN && url.pathname === `/rest/v1/rpc/${rpc}`,
    async (route) => {
      if (rpcCalled(route.request()) === rpc) {
        calls += 1;
        if (calls === 1) {
          await released;
        }
      }

      await route.continue();
    },
  );

  return { calls: () => calls, answered: () => answered, release };
}

function intakeInput(page: Page): Locator {
  return page.getByLabel("Choose part files to upload");
}

function toastWithText(page: Page, text: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
}

test.describe("client STEP intake from the parts page", () => {
  test.describe.configure({ timeout: 120_000 });

  test("a STEP upload opens its part, and a reload shows the same part", async ({ browser, baseURL }) => {
    const session = await openClientSession(browser, baseURL);

    try {
      const { page } = session;
      await intakeInput(page).setInputFiles(SAMPLE_STEP);
      await expect(page).toHaveURL(PART_URL, { timeout: 60_000 });

      const partUrl = page.url();
      const jobId = PART_URL.exec(partUrl)![1];
      const title = page.getByRole("heading", { level: 1, name: SAMPLE_PART_LABEL });
      // The CAD panel names the uploaded file; its preview download is skipped (see openClientSession).
      const cadPreview = page.getByLabel("CAD preview for 1093-05589-02.STEP");
      await expect(title).toBeVisible();
      await expect(cadPreview).toBeVisible();

      await page.reload();
      await expect(page).toHaveURL(partUrl);
      await expect(page.getByRole("button", { name: /open account menu/i })).toBeVisible({ timeout: 15_000 });
      await expect(title).toBeVisible();
      await expect(cadPreview).toBeVisible();
      await expect(page.getByText("This part could not be loaded.")).toHaveCount(0);
      expect(await session.readJob(jobId)).toEqual([{ id: jobId, title: SAMPLE_JOB_TITLE }]);
    } finally {
      await session.close();
    }
  });

  test("a repeated selection while intake is pending creates exactly one job", async ({ browser, baseURL }) => {
    const session = await openClientSession(browser, baseURL);

    try {
      const { page } = session;
      const jobsBefore = await session.countJobs();
      const held = await holdFirstRpc(page, CREATE_DRAFT_RPC);
      const busyToast = toastWithText(page, BUSY_MESSAGE);

      await intakeInput(page).setInputFiles(SAMPLE_STEP);
      await expect
        .poll(held.calls, { message: `the first selection should reach ${CREATE_DRAFT_RPC}`, timeout: 30_000 })
        .toBe(1);

      await intakeInput(page).setInputFiles(SAMPLE_STEP);
      // The repeated selection is handled once it is either refused or has started its own intake.
      let busyToastSeen = false;
      await expect
        .poll(
          async () => {
            busyToastSeen ||= (await busyToast.count()) > 0;
            return busyToastSeen || held.calls() > 1;
          },
          { message: "the repeated selection should be handled while the first intake is held", timeout: 15_000 },
        )
        .toBe(true);

      held.release();
      await expect(page).toHaveURL(PART_URL, { timeout: 60_000 });
      await expect
        .poll(() => held.answered() === held.calls(), { message: `every ${CREATE_DRAFT_RPC} call should be answered` })
        .toBe(true);

      expect(await session.countJobs(), "the organization's job count should rise by exactly one").toBe(jobsBefore + 1);
      expect(held.calls()).toBe(1);
      expect(session.intakeCalls().filter((rpc) => rpc === "api_prepare_part_intake")).toHaveLength(1);
      expect(busyToastSeen, "the repeated selection should be refused with the in-progress toast").toBe(true);
    } finally {
      await session.close();
    }
  });

  test("an empty STEP file shows the empty-file toast and never reaches intake", async ({ browser, baseURL }) => {
    expect(statSync(EMPTY_STEP).size, "the empty.step fixture must stay 0 bytes").toBe(0);
    const session = await openClientSession(browser, baseURL);

    try {
      const { page } = session;
      const jobsBefore = await session.countJobs();
      const emptyToast = toastWithText(page, EMPTY_FILE_MESSAGE);

      await intakeInput(page).setInputFiles(EMPTY_STEP);
      await expect
        .poll(async () => (await emptyToast.count()) > 0 || session.intakeCalls().length > 0, {
          message: "the empty selection should be handled",
          timeout: 15_000,
        })
        .toBe(true);

      expect(session.intakeCalls(), "an empty file must not reach any intake RPC").toEqual([]);
      await expect(emptyToast).toBeVisible();
      expect(page.url()).not.toMatch(PART_URL);
      expect(await session.countJobs(), "an empty file must not create a job").toBe(jobsBefore);
    } finally {
      await session.close();
    }
  });

  test("a non-STEP payload named .step ends in the CAD viewer's error state", async ({ browser, baseURL }) => {
    const session = await openClientSession(browser, baseURL);

    try {
      const { page } = session;
      // Intake does not inspect STEP headers, so this upload is expected to succeed;
      // only the in-browser viewer's terminal state is asserted.
      await intakeInput(page).setInputFiles(GARBAGE_STEP);
      await expect(page).toHaveURL(PART_URL, { timeout: 60_000 });

      const viewer = page.getByLabel("CAD preview for garbage.step");
      await expect(viewer).toBeVisible();
      await expect(viewer.getByText("Preview unavailable")).toBeVisible({ timeout: 30_000 });
      await expect(viewer.getByText("The STEP file could not be triangulated for preview.")).toBeVisible();
      await expect(viewer.getByRole("button", { name: "Download garbage.step" })).toBeVisible();
      await expect(viewer.getByText("Generating preview")).toHaveCount(0);
      await expect(viewer.locator("canvas")).toHaveCount(0);
    } finally {
      await session.close();
    }
  });
});
