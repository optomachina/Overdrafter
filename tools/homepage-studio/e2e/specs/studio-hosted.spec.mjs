// D. Hosted mode against a loopback GitHub stub: login, session cookie, commits in the data repo, GitHub failures,
// the github-actions engine, logout and fail-closed behaviour.
//
// Secure cookie handling: Chromium treats http://127.0.0.1 as a potentially trustworthy origin and stores and sends
// `Secure` cookies there, so these tests run over plain http and assert the real Set-Cookie attributes directly
// (HttpOnly, Secure, SameSite=Strict) instead of needing a self-signed certificate.
import { test, expect } from "../helpers/fixtures.mjs";
import { HOSTED_PASSWORD } from "../helpers/studio-server.mjs";
import { expectAppendOnly } from "../helpers/versions.mjs";
import { setRun, workerSucceeds, workerBlocks, readQueuedJob, NO_CREDENTIAL } from "../helpers/fake-worker.mjs";

async function uiLogin(sp, password = HOSTED_PASSWORD) {
  await sp.goto("/");
  await expect(sp.page.locator("#login")).toBeVisible();
  await sp.page.locator("#loginPw").fill(password);
  await sp.page.locator('#loginForm button[type="submit"]').click();
}

/** Fast path for tests that are not about the login UI. The browser context shares the cookie jar. */
async function apiLogin(hsp) {
  await hsp.page.goto(`${hsp.studio.url}/api/me`);
  await hsp.apiLogin(HOSTED_PASSWORD);
}

test.describe("authentication", { tag: ["@studio-hosted"] }, () => {
  test("unauthenticated API calls are 401 'unauthenticated'", async ({ hosted, request }) => {
    for (const path of ["/api/project", "/api/jobs", "/api/export/copy.json", "/api/preview/baseline/v9"]) {
      const res = await request.get(`${hosted.url}${path}`);
      expect(res.status(), path).toBe(401);
      expect((await res.json()).error).toBe("unauthenticated");
    }
    const me = await (await request.get(`${hosted.url}/api/me`)).json();
    expect(me).toMatchObject({ mode: "hosted", configured: true, authenticated: false });
    // A forged cookie is no better than none.
    const forged = await request.get(`${hosted.url}/api/project`, { headers: { cookie: "studio_session=eyJ4IjoxfQ.AAAA" } });
    expect(forged.status()).toBe(401);
    // Nothing reached GitHub for any of it.
    expect(hosted.gh.calls).toHaveLength(0);
  });

  test("a wrong password is 401 and five wrong passwords trip the rate limit (429), even for the right password", async ({ hosted, request }) => {
    for (let i = 0; i < 5; i++) {
      const res = await request.post(`${hosted.url}/api/login`, { data: { password: `wrong-${i}` } });
      expect(res.status(), `attempt ${i + 1}`).toBe(401);
      expect((await res.json()).error).toBe("login_failed");
      expect(res.headers()["set-cookie"]).toBeUndefined();
    }
    const limited = await request.post(`${hosted.url}/api/login`, { data: { password: HOSTED_PASSWORD } });
    expect(limited.status()).toBe(429);
    expect((await limited.json()).message).toMatch(/Too many failed attempts/);
    expect(limited.headers()["set-cookie"]).toBeUndefined();
  });

  test("the wrong password shows an inline error in the login dialog", async ({ hsp, guard }) => {
    guard.allowConsole(/status of 401/); // the browser logs the intentional 401 of the failed login
    await uiLogin(hsp, "not-the-password");
    await expect(hsp.page.locator("#loginErr")).toHaveText("Wrong password.");
    await expect(hsp.page.locator("#login")).toBeVisible();
  });

  test("the correct password sets an HttpOnly, Secure, SameSite=Strict cookie and Page mode loads", async ({ hsp, page, hosted, request }) => {
    await uiLogin(hsp);
    await hsp.waitReady();
    const cookie = (await page.context().cookies()).find((c) => c.name === "studio_session");
    expect(cookie, "session cookie").toBeTruthy();
    expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });
    expect(cookie.expires - Date.now() / 1000).toBeLessThanOrEqual(12 * 3600 + 5);
    expect(await page.evaluate(() => document.cookie)).not.toContain("studio_session");
    await expect(page.locator("#logout")).toBeAttached();
    await expect(page.locator("#strip")).toBeHidden(); // no "Temporary storage" banner: the data repo is in use
    expect((await hsp.project()).storage).toEqual({ kind: "github", ephemeral: false });
    // The raw Set-Cookie header carries all three attributes.
    const raw = await request.post(`${hosted.url}/api/login`, { data: { password: HOSTED_PASSWORD } });
    expect(raw.headers()["set-cookie"]).toMatch(/HttpOnly/);
    expect(raw.headers()["set-cookie"]).toMatch(/Secure/);
    expect(raw.headers()["set-cookie"]).toMatch(/SameSite=Strict/);
  });

  test("Log out clears the session", async ({ hsp, page, hosted, guard }) => {
    guard.expectHttp(401); // the post-logout API probe below
    await uiLogin(hsp);
    await hsp.waitReady();
    await hsp.openSettings();
    await page.locator("#logout").click();
    await expect(page.locator("#login")).toBeVisible(); // the page reloads into the login dialog
    expect((await page.context().cookies()).find((c) => c.name === "studio_session")).toBeUndefined();
    const res = await hsp.get("/api/project");
    expect(res.status()).toBe(401);
  });

  test.describe("without STUDIO_PASSWORD (fail closed)", () => {
    test.use({ studioOptions: { password: "" } });

    test("every endpoint answers 'not configured' and nothing reaches GitHub", async ({ hosted, request }) => {
      const calls = [
        ["GET", "/api/me"], ["GET", "/api/project"], ["POST", "/api/login", { password: "" }], ["POST", "/api/login", { password: HOSTED_PASSWORD }],
        ["GET", "/api/preview/baseline/v9"], ["POST", "/api/generate", { kind: "asset", sectionId: "hero" }],
      ];
      for (const [method, path, data] of calls) {
        const res = await request.fetch(`${hosted.url}${path}`, { method, data });
        expect(res.status(), `${method} ${path}`).toBe(503);
        const body = await res.json();
        expect(body.error).toBe("not_configured");
        expect(body.message).toMatch(/STUDIO_PASSWORD/);
        expect(res.headers()["set-cookie"]).toBeUndefined();
      }
      expect(hosted.gh.calls).toHaveLength(0);
    });

    test("the UI says the studio is not configured", async ({ hsp, page, guard }) => {
      guard.allowConsole(/status of 503/); // the browser logs the intentional 503 of /api/me
      await hsp.goto("/");
      await expect(page.locator("#strip")).toContainText("Studio is not configured");
      await expect(page.locator("#login")).toBeHidden();
    });
  });

  test.describe("with a too-short session secret (fail closed)", () => {
    test.use({ studioOptions: { secret: "short" } });
    test("the right password still gets no session", async ({ hosted, request }) => {
      const res = await request.post(`${hosted.url}/api/login`, { data: { password: HOSTED_PASSWORD } });
      expect(res.status()).toBe(503);
      expect(res.headers()["set-cookie"]).toBeUndefined();
    });
  });
});

test.describe("saving to the GitHub data repo", { tag: ["@studio-hosted"] }, () => {
  test("a saved edit becomes a commit 'studio: manual ...' in the data repo and history is read back from it", async ({ hsp, hosted, page }) => {
    await apiLogin(hsp);
    await hsp.open();
    const before = await hsp.field("hero-eyebrow");
    const gh = hosted.gh;
    const commitsBefore = gh.commitMessages().length;
    await hsp.editField("hero-eyebrow", "One part, idea to shelf, hosted");
    await hsp.saveAndWait();
    const messages = gh.commitMessages();
    expect(messages).toHaveLength(commitsBefore + 1);
    expect(messages.at(-1)).toMatch(/^studio: manual hero [a-z0-9]+$/);
    expect(gh.callsMatching("POST", /^\/git\/commits$/).at(-1).body.message).toBe(messages.at(-1));
    expect(gh.callsMatching("PATCH", /^\/git\/refs\/heads\/main$/).every((c) => c.body.force === false)).toBe(true); // never forced
    expect(gh.calls.every((c) => c.auth === "Bearer e2e-fake-token")).toBe(true);
    const saved = gh.json("project.json").fields["hero-eyebrow"];
    expect(saved.versions.at(-1)).toMatchObject({ kind: "manual", text: "One part, idea to shelf, hosted" });
    // History is read back from the repo: an edit made by someone else shows up after a reload.
    const p = gh.json("project.json");
    const f = p.fields["hero-eyebrow"];
    f.versions.push({ ...f.versions.at(-1), id: "ext0000000000000001", text: "Edited by another editor", createdAt: new Date().toISOString() });
    f.currentVersionId = "ext0000000000000001";
    gh.externalCommit("project.json", JSON.stringify(p, null, 2) + "\n", "external: another editor");
    await page.reload();
    await hsp.waitReady();
    await expect(hsp.fieldEl("hero-eyebrow")).toHaveText("Edited by another editor");
    const after = await hsp.field("hero-eyebrow");
    expect(after.versions.map((v) => v.text)).toEqual([...before.versions.map((v) => v.text), "One part, idea to shelf, hosted", "Edited by another editor"]);
    expectAppendOnly(before, after);
    await hsp.startEdit("hero-eyebrow");
    await hsp.frame.getByRole("button", { name: "Copy history" }).click();
    await expect(hsp.copyTimelineItems()).toHaveCount(3);
  });

  test("a 409/422 conflict is retried against the new head and the save succeeds", async ({ hsp, hosted }) => {
    await apiLogin(hsp);
    await hsp.open();
    const gh = hosted.gh;
    const patches = () => gh.callsMatching("PATCH", /^\/git\/refs\/heads\/main$/).length;
    const p0 = patches();
    gh.failNext({ method: "PATCH", path: /^\/git\/refs\/heads\/main$/, status: 422, message: "Update is not a fast forward" });
    await hsp.editField("hero-eyebrow", "Retried after a conflict");
    await hsp.saveAndWait();
    expect(patches() - p0, "one rejected and one accepted ref update").toBe(2);
    expect(gh.json("project.json").fields["hero-eyebrow"].versions.at(-1).text).toBe("Retried after a conflict");
    expect(gh.commitMessages().filter((m) => m.startsWith("studio: manual hero"))).toHaveLength(1); // one commit, no duplicate
  });

  test("conflicts that never clear are refused with a specific 409 and nothing is written; the retry then succeeds", async ({ hsp, hosted, guard }) => {
    guard.expectHttp(409);
    await apiLogin(hsp);
    await hsp.open();
    const gh = hosted.gh;
    gh.failNext({ method: "PATCH", path: /^\/git\/refs\/heads\/main$/, status: 409, message: "Reference update failed", times: 4 });
    const first = await hsp.post("/api/copy/hero-eyebrow/save", { text: "Eventually saved" });
    expect(first.status()).toBe(409);
    expect((await first.json()).error).toBe("conflict_exhausted");
    expect((await first.json()).message).toMatch(/Could not save after 3 retries/);
    expect(gh.json("project.json").fields["hero-eyebrow"].versions).toHaveLength(1);
    const retry = await hsp.post("/api/copy/hero-eyebrow/save", { text: "Eventually saved" });
    expect(retry.status()).toBe(200);
    expect(gh.json("project.json").fields["hero-eyebrow"].versions.at(-1).text).toBe("Eventually saved");
  });

  // KNOWN PRODUCT BUG found by this suite: ui/page.js saveFromPage() treats every 409 as "a lint outcome, nothing was
  // written" and sets the status to Saved, but the storage layer also answers 409 for conflict_exhausted (a real failed
  // save). The status indicator says "Saved" although nothing was committed.
  test("a save that fails with conflict_exhausted shows Failed with the reason and keeps the edit, never Saved", async ({ hsp, hosted, page, guard }) => {
    guard.allowConsole(/status of 409/);
    await apiLogin(hsp);
    await hsp.open();
    hosted.gh.failNext({ method: "PATCH", path: /^\/git\/refs\/heads\/main$/, status: 409, message: "Reference update failed", times: 4 });
    await hsp.editField("hero-eyebrow", "Never lands");
    await hsp.saveBtn.click();
    await expect(page.locator("#saveStatus")).toHaveAttribute("data-state", "failed");
    await expect(page.locator("#saveText")).toContainText("Could not save after 3 retries");
    await expect(page.locator("#saveText")).not.toHaveText("Saved");
    // The edit stays open and unsaved, the toolbar says why, and Save is still available to retry.
    await expect(hsp.frame.locator('[data-od-editing="1"]')).toContainText("Never lands");
    await expect(hsp.msg).toContainText(/Not saved\. Could not save after 3 retries/);
    await expect(hsp.saveBtn).toBeEnabled();
    expect(hosted.gh.json("project.json").fields["hero-eyebrow"].versions).toHaveLength(1);
  });

  test("when the data repo cannot be read the studio says why and Retry recovers, never a blank page that says Saved", async ({ hsp, hosted, page, guard }) => {
    guard.expectHttp(502);
    await apiLogin(hsp);
    hosted.gh.failNext({ method: "GET", path: /^\/contents\/project\.json/, status: 401, message: "Bad credentials", times: 5 });
    await page.goto(`${hosted.url}/`);
    await expect(page.locator("#strip")).toBeVisible();
    await expect(page.locator("#strip")).toContainText(/Could not load the project: .*GitHub rejected GITHUB_TOKEN \(401\)/);
    await expect(page.locator("#saveStatus")).toHaveAttribute("data-state", "failed");
    await expect(page.locator("#saveText")).not.toHaveText("Saved");
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    // The cause goes away (a corrected token): Retry loads the studio without a manual reload.
    hosted.gh.failures.length = 0;
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.locator("#baseline option")).not.toHaveCount(0);
    await expect(page.locator("#strip")).toBeHidden();
    await expect(page.locator("#saveStatus")).toHaveAttribute("data-state", "saved");
  });

  const FAILURES = [
    ["a GitHub rate limit (403)", { status: 403, message: "API rate limit exceeded for user", headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" } }, /GitHub rate limit reached\. Resets at 2030-01-01/],
    ["a token without permission (403)", { status: 403, message: "Resource not accessible by personal access token" }, /GITHUB_TOKEN lacks permission for the data repo/],
    ["a rejected token (401)", { status: 401, message: "Bad credentials" }, /GitHub rejected GITHUB_TOKEN \(401\)/],
  ];
  for (const [name, failure, message] of FAILURES) {
    test(`${name} shows a specific error in the status indicator, not a generic failure`, async ({ hsp, hosted, page, guard }) => {
      guard.expectHttp(429, 502);
      await apiLogin(hsp);
      await hsp.open();
      hosted.gh.failNext({ method: "POST", path: /^\/git\/blobs$/, ...failure });
      await hsp.editField("hero-eyebrow", "Not saved because GitHub refused");
      await expect(hsp.saveBtn).toBeEnabled();
      await hsp.saveBtn.click();
      await expect(page.locator("#saveStatus")).toHaveAttribute("data-state", "failed");
      await expect(page.locator("#saveText")).toContainText(message);
      expect(hosted.gh.json("project.json").fields["hero-eyebrow"].versions).toHaveLength(1);
    });
  }
});

test.describe("the github-actions engine", { tag: ["@studio-hosted"] }, () => {
  async function startGeneration(hsp, prompt) {
    await hsp.open();
    await hsp.openSettings();
    await hsp.page.locator("#engine").selectOption("github-actions");
    await hsp.closeSettings();
    await hsp.sparkleIcon("Hero").click();
    await hsp.page.locator("#genPrompt").fill(prompt);
    await hsp.page.locator("#genGo").click();
    const status = hsp.page.locator("#job-asset-hero .status");
    await expect(status).toHaveAttribute("data-state", "queued");
    const gh = hsp.studio.gh;
    await expect.poll(() => gh.dispatches.length).toBe(1);
    return { status, dispatch: gh.dispatches[0], jobId: gh.dispatches[0].inputs.jobId };
  }

  test("Generate dispatches the workflow without the prompt text; queued, running, succeeded follow the stub", async ({ hsp, hosted }) => {
    test.setTimeout(90_000);
    await apiLogin(hsp);
    const secretPrompt = "SECRET-PROMPT-TEXT-12345 draw a bracket";
    const { status, dispatch, jobId } = await startGeneration(hsp, secretPrompt);
    expect(dispatch).toMatchObject({ workflow: "studio-generate.yml", ref: "main" });
    expect(dispatch.inputs).toEqual({ jobId, section: "hero", tool: "hand-built", engine: "claude-cli", promptRef: `jobs/${jobId}.json` });
    expect(JSON.stringify(dispatch)).not.toContain("SECRET-PROMPT-TEXT");
    // The prompt travels only through the data repo's job file.
    const job = await readQueuedJob(hosted, jobId);
    expect(job).toMatchObject({ state: "queued", prompt: secretPrompt, engine: "github-actions" });
    expect(hosted.gh.commitMessages().some((m) => m === `studio: queued asset hero ${jobId}`)).toBe(true);
    // The worker picks it up.
    setRun(hosted, jobId, { status: "in_progress" });
    await expect(status).toHaveAttribute("data-state", "running", { timeout: 25_000 });
    await expect(status.getByRole("link", { name: "Open worker run" })).toHaveAttribute("href", /\/runs\/4242$/);
    // It finishes: the worker commits the version and the job file.
    const before = await hsp.asset("hero");
    await workerSucceeds(hosted, jobId, { prompt: secretPrompt });
    await expect(status).toHaveAttribute("data-state", "succeeded", { timeout: 25_000 });
    await expect(hsp.frame.locator('iframe[title="Generated figure, Hero"]')).toBeVisible({ timeout: 15_000 });
    const after = await hsp.asset("hero");
    expect(after.versions).toHaveLength(before.versions.length + 1);
    expect(after.versions.at(-1)).toMatchObject({ kind: "generated", engine: "github-actions", model: "e2e-simulated-worker" });
    expect(hosted.gh.commitMessages().some((m) => /^studio: generated hero /.test(m))).toBe(true);
  });

  test("a worker 'No model credential' job is shown with that exact message and creates no version", async ({ hsp, hosted }) => {
    test.setTimeout(90_000);
    await apiLogin(hsp);
    const { status, jobId } = await startGeneration(hsp, "needs a credential");
    const before = await hsp.asset("hero");
    await workerBlocks(hosted, jobId);
    await expect(status).toHaveAttribute("data-state", "blocked", { timeout: 25_000 });
    await expect(status).toContainText(NO_CREDENTIAL);
    await expect(hsp.page.locator("#toast")).toContainText(NO_CREDENTIAL);
    expect((await hsp.asset("hero")).versions).toHaveLength(before.versions.length);
    await expect(hsp.frame.locator('iframe[title^="Generated figure"]')).toHaveCount(0);
    expect(hosted.gh.json(`jobs/${jobId}.json`)).toMatchObject({ state: "blocked", message: NO_CREDENTIAL });
  });
});

test.describe("the offline demo engine works hosted too", { tag: ["@studio-hosted"] }, () => {
  test("Generate with the demo engine commits a labelled version to the data repo", async ({ hsp, hosted }) => {
    await apiLogin(hsp);
    await hsp.open();
    await hsp.openSettings();
    await expect(hsp.page.locator("#engine")).toHaveValue("github-actions"); // hosted prefers the worker engine when it is available
    await hsp.page.locator("#engine").selectOption("template-demo");
    await hsp.closeSettings();
    await hsp.sparkleIcon("Hero").click();
    await hsp.page.locator("#genPrompt").fill("hosted demo");
    await hsp.page.locator("#genGo").click();
    await expect(hsp.page.locator("#job-asset-hero .status")).toHaveAttribute("data-state", "succeeded", { timeout: 25_000 });
    const asset = hosted.gh.json("project.json").assets["asset-hero"];
    expect(asset.versions.at(-1).note).toContain("demo engine, not generated by a model");
    expect(hosted.gh.file(asset.versions.at(-1).assetPath)).toContain("Demo asset: Hero");
  });
});
