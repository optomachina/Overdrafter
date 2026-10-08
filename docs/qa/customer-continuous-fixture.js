// Playwright CLI run-code function. Start the app on loopback with
// VITE_ENABLE_FIXTURE_MODE=1 and a closed-loopback synthetic backend URL.
// Supply output/playwright/qa-repeat.step containing any synthetic nonempty text.
// This is frontend acceptance with intercepted services, never provider acceptance.
async (page) => {
  const origin = 'http://127.0.0.1:4187';
  if (!page.url().startsWith(origin + '/')) throw new Error('Local fixture browser required');
  const calls = [];
  const blocked = [];
  let failIntake = true;
  await page.unrouteAll({behavior: 'ignoreErrors'});
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/')) return route.continue();
    if (!url.startsWith('http://127.0.0.1:9/')) {
      blocked.push(url.split('/').slice(0, 3).join('/'));
      return route.abort();
    }
    const name = url.split('?')[0].split('/').pop();
    calls.push(name);
    if (name === 'api_prepare_part_intake' && failIntake) {
      failIntake = false;
      return route.fulfill({status: 503, json: {message: 'Synthetic upload interruption'}});
    }
    const replies = {
      api_get_founding_beta_access_state: {state: 'eligible', policyRevision: 'synthetic-qa', termsPath: '/terms', privacyPath: '/privacy'},
      api_get_job_vendor_preferences: [],
      api_prepare_part_intake: {},
      api_create_client_draft: 'fx-job-published',
      api_prepare_job_file_upload: {status: 'prepared', storageBucket: 'synthetic', storagePath: 'qa.step'},
      api_finalize_job_file_upload: {},
      api_reconcile_job_parts: {parts: 1},
      api_request_extraction: 1,
    };
    if (url.startsWith('http://127.0.0.1:9/storage/')) return route.fulfill({json: {Key: 'synthetic/qa.step'}});
    if (!(name in replies)) throw new Error('Unexpected backend request: ' + name);
    return route.fulfill({json: replies[name]});
  });
  await page.goto(origin + '/parts?fixture=client-published&debug=1');
  await page.getByRole('button', {name: 'Choose part files to upload', exact: true}).waitFor();
  const readSelection = () => page.evaluate(async () => {
    const {getActiveClientWorkspaceGateway} = await import('/src/features/quotes/client-workspace-fixtures.ts');
    const gateway = getActiveClientWorkspaceGateway();
    if (!gateway) throw new Error('Fixture gateway lost');
    return (await gateway.fetchPartDetail('fx-job-published')).job.selected_vendor_quote_offer_id;
  });
  // Clear only this disposable fixture's seeded selection to prove the UI writes it.
  await page.evaluate(async () => {
    const {getActiveClientWorkspaceGateway} = await import('/src/features/quotes/client-workspace-fixtures.ts');
    await getActiveClientWorkspaceGateway().setJobSelectedVendorQuoteOffer('fx-job-published', null);
  });
  if (await readSelection() !== null) throw new Error('Fixture setup did not clear selection');
  const input = page.getByRole('button', {name: 'Choose part files to upload', exact: true});
  const beforeCancel = calls.length;
  await input.setInputFiles([]);
  if (calls.length !== beforeCancel) throw new Error('Cancel triggered a backend call');
  await input.setInputFiles('output/playwright/qa-repeat.step');
  await page.getByText('Synthetic upload interruption', {exact: true}).waitFor();
  if (!page.url().startsWith(origin + '/parts?')) throw new Error('Failed upload navigated');
  await input.setInputFiles('output/playwright/qa-repeat.step');
  await page.waitForURL('**/parts/fx-job-published?fixture=client-published&debug=1');
  await page.getByRole('heading', {name: 'FX-200 rev B', exact: true}).waitFor();
  const uploadCalls = calls.filter(name => name !== 'api_get_founding_beta_access_state' && name !== 'api_get_job_vendor_preferences');
  const expectedCalls = ['api_prepare_part_intake', 'api_prepare_part_intake', 'api_create_client_draft', 'api_prepare_job_file_upload', 'qa.step', 'api_finalize_job_file_upload', 'api_reconcile_job_parts', 'api_request_extraction'];
  if (JSON.stringify(uploadCalls) !== JSON.stringify(expectedCalls)) throw new Error('Upload path mismatch: ' + JSON.stringify(uploadCalls));
  await page.getByRole('button', {name: 'US-only sourcing', exact: true}).click();
  const row = page.getByRole('row').filter({hasText: 'Xometry'});
  await row.waitFor();
  await row.press('Enter');
  // Selection mutation is asynchronous; wait for its visible completion receipt.
  await page.getByText('Selected quote updated.', {exact: true}).first().waitFor();
  const selected = await readSelection();
  if (selected !== 'fx-offer-published-xometry') throw new Error('Selection was not persisted');
  await page.goBack();
  await page.getByRole('heading', {name: 'Parts', exact: true}).waitFor();
  if (await readSelection() !== selected) throw new Error('Back lost selection');
  await page.goForward();
  await page.getByRole('heading', {name: 'FX-200 rev B', exact: true}).waitFor();
  if (await readSelection() !== selected) throw new Error('Forward lost selection');
  await page.goBack();
  await page.getByRole('link', {name: /Isometric CAD sketch preview for fx-200-plate.step/}).click();
  await page.getByRole('heading', {name: 'FX-200 rev B', exact: true}).waitFor();
  if (await readSelection() !== selected) throw new Error('Reopening part lost selection');
  const domestic = page.getByRole('button', {name: 'US-only sourcing', exact: true});
  if (await domestic.count()) await domestic.click();
  await row.waitFor();
  if (await row.getAttribute('aria-selected') !== 'true') throw new Error('Restored selection not rendered');
  await page.evaluate(receipt => { window.qaContinuousReceipt = receipt; }, {
    result: 'PASS', cancel: 'no backend call', retry: 'one failure then successful upload',
    uploadCalls, selected, persistence: 'Back, Forward and part link', blockedExternalOrigins: blocked,
    finalUrl: page.url(), boundary: 'intercepted backend/storage; preseeded synthetic comparison',
  });
}
