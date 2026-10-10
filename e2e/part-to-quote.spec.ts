import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * End-to-end test for the happy path: upload a part, get a quote comparison.
 * 
 * This test covers the core OverDrafter flow:
 * 1. Sign in as a client user
 * 2. Upload a STEP file and a drawing PDF
 * 3. Verify the app creates the job(s) and navigates to them
 * 4. Verify a seeded quoted project shows its quote comparison
 * 
 * Test data requirements:
 * - Client user must be seeded: client.demo@overdrafter.local
 * - Test fixtures must exist: test-fixtures/quoted-sample/*.STEP and *.pdf
 */

test.describe("Part to quote happy path", () => {
  test.use({ storageState: "playwright/.auth/client.json" });

  test("uploads a part and lands on the created part or project", async ({
    page,
  }) => {
    // 1. Start at the parts page
    await page.goto("/?debug=1");
    await expect(page.getByRole("heading", { name: "Parts", exact: true })).toBeVisible();

    // 2. Start the upload flow
    // The exact name avoids the file input's "Choose part files to upload" label,
    // and the visible filter skips the duplicate button rendered for the other layout.
    const uploadButton = page
      .getByRole("button", { name: "Upload", exact: true })
      .locator("visible=true");
    await expect(uploadButton).toHaveCount(1);
    await uploadButton.click();

    // 3. Upload STEP and PDF files
    const stepFilePath = path.join(__dirname, "..", "test-fixtures", "quoted-sample", "1093-05589-02.STEP");
    const pdfFilePath = path.join(__dirname, "..", "test-fixtures", "quoted-sample", "1093-05589-02.pdf");

    // Find the file input and upload both files
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles([stepFilePath, pdfFilePath]);

    // 4. A successful upload creates the job(s) and navigates to the part or project page.
    // Extraction and vendor quoting need the worker and live providers, which this
    // suite does not run; the quote comparison is covered by the seeded test below.
    await expect(page).toHaveURL(/\/(parts|projects)\/[0-9a-f-]+/, { timeout: 30000 });

    // 5. Take a screenshot for evidence
    await page.screenshot({ path: "playwright/evidence/part-to-quote-happy-path.png", fullPage: true });
  });

  test("navigates to an existing quoted part and displays the comparison", async ({ page }) => {
    // Use the seeded quoted project from seed-dev.mjs
    // uuid(21) = 00000000-0000-4000-8000-000000000021
    const quotedProjectId = "00000000-0000-4000-8000-000000000021";

    await page.goto(`/projects/${quotedProjectId}/review?debug=1`);

    // Verify the quote comparison is displayed
    await expect(
      page.getByRole("heading", { name: /quote comparison|synthetic quote/i }),
    ).toBeVisible({ timeout: 10000 });

    // Verify chart with quote data points
    const chart = page.locator('[data-testid="quote-chart"], svg, canvas').first();
    await expect(chart).toBeVisible();

    // Verify at least one vendor name is shown
    await expect(
      page.getByText(/xometry|fictiv|protolabs|sendcutsend/i).first(),
    ).toBeVisible();

    // Verify price information is displayed (it appears in several summary cells)
    await expect(page.getByText(/\$\d+/).first()).toBeVisible();

    // Take a screenshot for evidence
    await page.screenshot({
      path: "playwright/evidence/seeded-quote-comparison.png",
      fullPage: true,
    });
  });
});
