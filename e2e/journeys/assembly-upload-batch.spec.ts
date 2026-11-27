import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, test, type Page } from "@playwright/test";

// A reload used to abandon every group after the one that failed, and the
// project title still counted the files that never landed. This journey
// injects that failure on the second group and expects the rest to finish.
//
// The default sandboxed browser stops answering locator queries, and pausing
// the fixture origin with page.route deadlocks the upload that is awaiting
// those responses. The journey launches an unsandboxed browser and answers
// the fixture origin inside the page.
//
// client-empty never settles: an empty project list keeps re-running the
// legacy migration. client-quoted already has a project, so the parts page
// stays usable. The upload itself still starts with no project id.
const FIXTURE_ROOT = fileURLToPath(new URL("../../server/engineering/fixtures/candidate/", import.meta.url));

const ASSEMBLY_PATH = path.join(FIXTURE_ROOT, "synthetic-assembly.SLDASM");
const BASELINE_PATH = path.join(FIXTURE_ROOT, "parts/baseline-5mm.SLDPRT");
const CANDIDATE_PATH = path.join(FIXTURE_ROOT, "parts/candidate-8mm.SLDPRT");

type DraftCall = {
  id: string;
  title: string;
  projectId: string | null;
};

async function readDrafts(page: Page): Promise<DraftCall[]> {
  return page.evaluate(() => window.__assemblyUploadDrafts ?? []);
}

type UploadChoice = string | { sourcePath: string; name: string };

function chosenFile(choice: UploadChoice) {
  const sourcePath = typeof choice === "string" ? choice : choice.sourcePath;
  return {
    name: typeof choice === "string" ? path.basename(sourcePath) : choice.name,
    base64: readFileSync(sourcePath).toString("base64"),
  };
}

async function chooseFiles(page: Page, label: string, files: UploadChoice[]) {
  const payloads = files.map((choice) => chosenFile(choice));
  const input = page.locator(`input[aria-label="${label}"]`);
  await expect(input).toHaveCount(1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    page.evaluate(({ filesInPage, inputLabel }) => {
      const target = document.querySelector(`input[aria-label="${inputLabel}"]`);
      if (!(target instanceof HTMLInputElement)) throw new Error("file input missing");
      const transfer = new DataTransfer();
      for (const file of filesInPage) {
        const bytes = Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0));
        transfer.items.add(new File([bytes], file.name));
      }
      target.files = transfer.files;
      setTimeout(() => {
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      }, 0);
      return "eval-exit";
    }, { filesInPage: payloads, inputLabel: label }),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve("eval-timeout"), 20_000);
    }),
  ]);
  clearTimeout(timer);
  if (result !== "eval-exit") throw new Error(`file choose did not return (${result})`);
}

async function confirmNotControlled(page: Page) {
  const dialog = page.getByRole("dialog", { name: /export-controlled/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: /^Not export-controlled/ }).check();
  await dialog.getByRole("button", { name: "Continue upload" }).click();
}

test.describe("assembly upload batch", { tag: "@fixture" }, () => {
  test("finishes the groups after a mid-batch failure and adds the rest to that project", async () => {
    test.setTimeout(180_000);
    const browser = await chromium.launch({
      chromiumSandbox: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => console.log("pageerror", error.message));

    await page.route("http://127.0.0.1:9/**", (route) => {
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
            "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
          },
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: "[]",
      });
    });
    await page.routeWebSocket(/127\.0\.0\.1:9/, () => {});
    await page.addInitScript({
      path: fileURLToPath(new URL("./assembly-upload-fixture.js", import.meta.url)),
    });

    try {
      await page.goto("http://127.0.0.1:4173/parts?fixture=client-quoted", { waitUntil: "commit" });
      await expect(page.locator('input[aria-label="Choose part files to upload"]')).toHaveCount(1);

      await chooseFiles(page, "Choose part files to upload", [ASSEMBLY_PATH, BASELINE_PATH, CANDIDATE_PATH]);
      await confirmNotControlled(page);

      const outcome = page.getByRole("status", { name: "Upload result" });
      await expect(outcome).toContainText("Uploaded 2 of 3. 1 didn't finish: baseline-5mm.SLDPRT");
      await expect(page).toHaveURL(/\/projects\/fixture-project-[^/?#]+/);
      await expect(page.getByText("synthetic-assembly + 1 parts")).toBeVisible();
      const drafts = await readDrafts(page);
      expect(drafts.map((draft) => draft.title)).toEqual([
        "synthetic-assembly",
        "baseline-5mm",
        "candidate-8mm",
      ]);

      const projectId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
      expect(projectId.startsWith("fixture-project-")).toBe(true);
      expect(drafts.every((draft) => draft.projectId === projectId)).toBe(true);

      mkdirSync("/opt/cursor/artifacts", { recursive: true });
      await page.screenshot({
        path: "/opt/cursor/artifacts/assembly-upload-partial.png",
        fullPage: false,
      });

      const draftsBeforeRetry = drafts.length;
      await outcome.getByRole("button", { name: "Add them to this project" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}`));
      await chooseFiles(page, "Create new job from files", [BASELINE_PATH, CANDIDATE_PATH]);
      await confirmNotControlled(page);

      await expect.poll(async () => (await readDrafts(page)).length).toBe(draftsBeforeRetry + 2);
      const added = (await readDrafts(page)).slice(draftsBeforeRetry);
      expect(added.map((draft) => draft.projectId)).toEqual([projectId, projectId]);
      await expect(page).toHaveURL(new RegExp(`/projects/${projectId}(?:[?#]|$)`));
    } finally {
      await browser.close();
    }
  });

  test("reloads after three of five groups and adds the rest to the same project", async () => {
    test.setTimeout(180_000);
    const browser = await chromium.launch({
      chromiumSandbox: false,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", (error) => console.log("pageerror", error.message));
    page.on("dialog", (dialog) => {
      void dialog.accept();
    });

    await page.route("http://127.0.0.1:9/**", (route) => {
      if (route.request().method() === "OPTIONS") {
        return route.fulfill({
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "*",
            "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
          },
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: "[]",
      });
    });
    await page.routeWebSocket(/127\.0\.0\.1:9/, () => {});
    await page.addInitScript(() => {
      window.__assemblyUploadHoldAfter = 3;
    });
    await page.addInitScript({
      path: fileURLToPath(new URL("./assembly-upload-fixture.js", import.meta.url)),
    });

    // Five groups from the synthetic assembly and its two parts. The extra two
    // names reuse those part bytes so the batch has five groups without new CAD.
    const fiveGroups = [
      ASSEMBLY_PATH,
      { sourcePath: BASELINE_PATH, name: "a.SLDPRT" },
      { sourcePath: CANDIDATE_PATH, name: "b.SLDPRT" },
      BASELINE_PATH,
      CANDIDATE_PATH,
    ];

    try {
      await page.goto("http://127.0.0.1:4173/projects/fx-project-quoted?fixture=client-quoted", {
        waitUntil: "commit",
      });
      await expect(page.locator('input[aria-label="Create new job from files"]')).toHaveCount(1);

      await chooseFiles(page, "Create new job from files", fiveGroups);
      await confirmNotControlled(page);

      const progress = page.getByRole("status", { name: "Upload result" });
      await expect(progress).toContainText("Uploading 3 of 5...");
      const leaving = await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(leaving).toBe(true);

      await page.reload({ waitUntil: "commit" });
      await expect(page).toHaveURL(/\/projects\/fx-project-quoted/);

      const banner = page.getByRole("status", { name: "Unfinished upload" });
      await expect(banner).toContainText(
        "2 files from your last upload didn't finish: baseline-5mm.SLDPRT, candidate-8mm.SLDPRT",
      );
      mkdirSync("/opt/cursor/artifacts", { recursive: true });
      await page.screenshot({
        path: "/opt/cursor/artifacts/assembly-upload-resume.png",
        fullPage: false,
      });

      await banner.getByRole("button", { name: "Add them to this project" }).click();
      await expect(page).toHaveURL(/\/projects\/fx-project-quoted/);
      await chooseFiles(page, "Create new job from files", [BASELINE_PATH, CANDIDATE_PATH]);
      await confirmNotControlled(page);

      await expect.poll(async () => (await readDrafts(page)).length).toBe(2);
      const added = await readDrafts(page);
      expect(added.map((draft) => draft.projectId)).toEqual(["fx-project-quoted", "fx-project-quoted"]);
      await expect(page).toHaveURL(/\/projects\/fx-project-quoted(?:[?#]|$)/);
    } finally {
      await browser.close();
    }
  });
});

declare global {
  interface Window {
    __assemblyUploadDrafts?: Array<{
      id: string;
      title: string;
      projectId: string | null;
    }>;
    __assemblyUploadHoldAfter?: number;
  }
}
