import { createJarvisPwaDeps, createJarvisPwaHandler } from "../../server/jarvis/pwa-gate";

// Every other /api/jarvis/* path. Same admission rules, never a thread payload.
export default {
  fetch: (request: Request) => createJarvisPwaHandler(createJarvisPwaDeps(process.env), "other")(request),
};
