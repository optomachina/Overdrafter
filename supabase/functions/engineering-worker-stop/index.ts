import { createNativeStopHandler } from "../../../server/engineering/native-stop-transport.ts";
import { createNativeStopRepository } from "../../../server/engineering/native-stop-repository.ts";

/** Source-only route. Dedicated executor provisioning and enablement are separate
 * protected operations; absence of configuration never falls back to service_role. */
export function createWorkerStopHandler(overrides: Partial<Parameters<typeof createNativeStopHandler>[0]> = {}) {
  return createNativeStopHandler({
    enabled: () => Deno.env.get("ENGINEERING_WORKER_STOP_ENABLED") === "true",
    repository: () => createNativeStopRepository({
      url: Deno.env.get("ENGINEERING_STOP_EXECUTOR_URL"),
      token: Deno.env.get("ENGINEERING_STOP_EXECUTOR_TOKEN"),
    }),
    ...overrides,
  });
}
if (import.meta.main) Deno.serve(createWorkerStopHandler());
