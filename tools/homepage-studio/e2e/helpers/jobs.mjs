// Small helpers for driving generation jobs through the studio API.
import { expect } from "@playwright/test";

export const FINAL = ["succeeded", "failed", "blocked", "cancelled", "timed_out"];

export async function submitJob(sp, body) {
  const res = await sp.post("/api/generate", { tool: "hand-built", prompt: "e2e figure", ...body });
  expect(res.status(), `POST /api/generate ${JSON.stringify(body)}`).toBeLessThan(300);
  return (await res.json()).job;
}

export async function jobState(sp, id) {
  const res = await sp.get(`/api/jobs/${id}`);
  expect(res.status()).toBe(200);
  return (await res.json()).job;
}

export async function waitFinal(sp, id, timeout = 20_000) {
  await expect.poll(async () => FINAL.includes((await jobState(sp, id)).state), { timeout }).toBe(true);
  return jobState(sp, id);
}

export async function generateDemo(sp, sectionId, prompt = "e2e figure") {
  const job = await submitJob(sp, { kind: "asset", sectionId, engine: "template-demo", prompt });
  const done = await waitFinal(sp, job.id);
  expect(done.state).toBe("succeeded");
  return done;
}
