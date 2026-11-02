import { createJarvisPwaDeps, createJarvisPwaHandler } from "../../server/jarvis/pwa-gate";

// GET /api/jarvis/session is rewritten here. The handler ignores every client role claim.
export default {
  fetch: (request: Request) => createJarvisPwaHandler(createJarvisPwaDeps(process.env), "session")(request),
};
