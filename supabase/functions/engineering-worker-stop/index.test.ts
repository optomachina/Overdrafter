import { assertEquals } from "@std/assert";
import { createWorkerStopHandler } from "./index.ts";

Deno.test("stop route is off without explicit configuration and never builds its repository", async () => {
  const before = Deno.env.get("ENGINEERING_WORKER_STOP_ENABLED");
  Deno.env.delete("ENGINEERING_WORKER_STOP_ENABLED");
  try {
    let calls = 0;
    const handler = createWorkerStopHandler({ repository: () => { calls++; throw new Error("must not run"); } });
    const response = await handler(new Request("https://fixture.invalid/functions/v1/engineering-worker-stop"));
    assertEquals(response.status, 503); assertEquals(calls, 0);
    assertEquals((await response.json()).error, "stop_disabled");
  } finally {
    if (before !== undefined) Deno.env.set("ENGINEERING_WORKER_STOP_ENABLED", before);
  }
});
