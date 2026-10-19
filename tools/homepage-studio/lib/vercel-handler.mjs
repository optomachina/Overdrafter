// Web-standard fetch handler for hosting. The Vercel function file only calls this.
import { createApp } from "./app.mjs";

let app = null;
export function getApp() {
  if (!app) app = createApp();
  return app;
}
export function resetApp() {
  app = null;
}

export async function fetchHandler(request) {
  return getApp().api.handle(request);
}
