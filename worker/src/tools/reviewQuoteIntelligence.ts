import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createJevChoiceDecider, type JsonValue } from "../jev/choice.js";
import { reviewQuoteRequest } from "../quoteIntelligence/service.js";
import type { ChoiceProvider, DecisionMode } from "../quoteIntelligence/decision.js";

/** Offline by default. Explicit --jev permits only synthetic packets using an already configured key. */
export async function runQuoteReviewCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const [path, mode = "off", inference] = args;
  if (!path || args.length > 3 || !["off", "shadow", "apply"].includes(mode)
    || (inference !== undefined && inference !== "--jev")) throw new Error("usage: reviewQuoteIntelligence <synthetic.json> [off|shadow|apply] [--jev]");
  const bytes = await readFile(path);
  if (bytes.length > 1_000_000) throw new Error("review_input_budget");
  const input: unknown = JSON.parse(bytes.toString("utf8"));
  let provider: ChoiceProvider | undefined;
  if (inference === "--jev" && mode !== "off" && env.TYPESAFE_API_KEY) {
    const transport = createJevChoiceDecider(env.TYPESAFE_API_KEY);
    provider = (question, signal) => transport({ ...question, state: question.state as JsonValue }, signal);
  }
  return reviewQuoteRequest(input, { mode: mode as DecisionMode, provider });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runQuoteReviewCli(process.argv.slice(2)).then((result) => console.log(JSON.stringify(result, null, 2))).catch(() => {
    console.error("Quote intelligence review failed: check the synthetic input and command arguments.");
    process.exitCode = 1;
  });
}
