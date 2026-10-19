import { createTemplateDemoEngine } from "./template-demo.mjs";
import { createClaudeCliEngine } from "./claude-cli.mjs";
import { createGithubActionsEngine } from "./github-actions.mjs";

export const HOSTED_CLI_REASON = "claude-cli runs only on a machine with the CLI.";

export function createEngines({ mode, storage, probe, extra = [] }) {
  const list = [
    createTemplateDemoEngine(),
    createClaudeCliEngine({ probe, unavailableReason: mode === "hosted" ? HOSTED_CLI_REASON : null }),
    createGithubActionsEngine({ storage }),
    ...extra,
  ];
  return Object.fromEntries(list.map((e) => [e.id, e]));
}
