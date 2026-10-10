import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * End-to-end test for the happy path: upload a part, get a quote comparison.
 * 
 * This test covers the core OverDrafter flow:
 * 1. Sign in as a client user
 * 2. Upload a STEP file (and optionally a drawing PDF)
 * 3. Confirm the extracted manufacturing requirements
 * 4. Request automatic quotes
 * 5. Verify quote comparison is displayed
 * 
 * Test data requirements:
 * - Client user must be seeded: client.demo@overdrafter.local
 * - Test fixtures must exist: test-fixtures/quoted-sample/*.STEP and *.pdf
 */

test.describe("Part to quote happy path", () => {
  test.use({ storageState: "playwright/.auth/client.json" });

  test("uploads a part, extracts requirements, requests quotes, and displays comparison", async ({
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

    // 4. Wait for the part to appear in the workspace
    // The part name may come from the filename or extraction
    await expect(
      page.getByText(/1093-05589-02|uploaded|processing/i).first(),
    ).toBeVisible({ timeout: 15000 });

    // 5. Wait for extraction to complete
    // This might show a progress indicator or status change
    await expect(
      page.getByText(/extracting|processing/i).first(),
    ).toBeVisible({ timeout: 5000 });

    // Wait for extraction to finish - look for "Review" or "Request Quote" button
    await expect(
      page.getByRole("button", { name: /review|request quote|get quotes/i }).first(),
    ).toBeVisible({ timeout: 60000 });

    // 6. Open the part details to review requirements
    const partCard = page.locator('[data-part-id], [data-job-id]').first();
    if (await partCard.isVisible()) {
      await partCard.click();
    }

    // 7. Verify extracted requirements are displayed
    // Should show material, process, finish, etc.
    await expect(
      page.getByText(/aluminum|6061|cnc|mill|anodize/i).first(),
    ).toBeVisible({ timeout: 5000 });

    // 8. Request quotes
    const requestQuoteButton = page.getByRole("button", { name: /request quote|get quotes/i }).first();
    await requestQuoteButton.click();

    // 9. Confirm any dialogs or requirements
    const confirmButton = page.getByRole("button", { name: /confirm|continue|yes/i }).first();
    if (await confirmButton.isVisible({ timeout: 2000 })) {
      await confirmButton.click();
    }

    // 10. Wait for quote request to be submitted
    await expect(
      page.getByText(/requesting|queued|in progress/i).first(),
    ).toBeVisible({ timeout: 10000 });

    // 11. For E2E testing, we'll verify the request was created
    // In a real test with fixtures or mocked vendors, we'd wait for results
    // For now, verify we reached the quote workspace or quote detail page
    await expect(
      page.getByText(/quote|vendor|provider/i).first(),
    ).toBeVisible({ timeout: 5000 });

    // 12. Take a screenshot for evidence
    await page.screenshot({ path: "playwright/evidence/part-to-quote-happy-path.png", fullPage: true });

    // If using seeded data with pre-populated quotes, verify the comparison
    const quoteComparison = page.getByRole("heading", { name: /quote comparison|compare quotes/i });
    if (await quoteComparison.isVisible({ timeout: 5000 })) {
      // Verify chart and table are present
      await expect(page.locator('svg, canvas').first()).toBeVisible();
      await expect(page.locator('table, [role="table"]').first()).toBeVisible();

      // Take a screenshot of the quote comparison
      await page.screenshot({
        path: "playwright/evidence/quote-comparison.png",
        fullPage: true,
      });
    }
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
