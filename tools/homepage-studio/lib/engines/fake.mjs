// Test-only engine with injectable behaviour.
import fs from "node:fs";
import path from "node:path";
import { EngineError } from "./errors.mjs";
import { demoAssetHtml } from "./template-demo.mjs";

export function createFakeEngine({ behavior = "success", delayMs = 0, text = "A new line of copy.", message = "" } = {}) {
  return {
    id: "fake",
    label: "Fake (tests)",
    description: "Test only.",
    inline: true,
    usesSkills: false,
    async available() {
      return behavior === "unavailable" ? { ok: false, message: message || "Fake engine is unavailable." } : { ok: true, message: "" };
    },
    async run(ctx) {
      ctx.onLog?.(`fake engine: ${behavior}`);
      if (behavior === "timeout" || behavior === "hang") {
        await new Promise((resolve, reject) => {
          ctx.signal.addEventListener("abort", () => reject(new EngineError("failed", "aborted")), { once: true });
          if (ctx.signal.aborted) reject(new EngineError("failed", "aborted"));
        });
      }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (behavior === "fail") throw new EngineError("failed", message || "Fake engine failed on purpose.");
      if (ctx.kind === "asset") {
        await fs.promises.mkdir(ctx.outDir, { recursive: true });
        const html = behavior === "bad-output" ? "<html><body>no themes</body></html>" : demoAssetHtml({ section: ctx.section, prompt: ctx.prompt, tool: "fake" });
        await fs.promises.writeFile(path.join(ctx.outDir, "index.html"), html);
        return { model: "fake-model", usage: { fake: true } };
      }
      return { text, model: "fake-model", usage: { fake: true } };
    },
  };
}
