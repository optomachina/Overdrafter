# Proof check

`scripts/proof-check.mjs` reads the `## Proof` section of a PR body and runs in the `Proof check` workflow (`.github/workflows/proof-check.yml`, check name `proof-check`). It is separate from the PR body gate (`pr-body-gate.yml`, check `provider-go-live`) and shares no code with it. The workflow runs in report mode (`PROOF_CHECK_MODE=report`) and is not a required check.

## Item rules

| Item | Accepted when | Failure message |
| --- | --- | --- |
| `Test: <path>` | the path is in the PR diff or in the base checkout | ``Test: `e2e/foo.spec.ts` does not exist in the repo or this PR`` |
| `Command: <cmd>` + fenced output | the output block is non-empty and the command refers to real things (below) | ``Command: `npm run verify:foo` — no such script `verify:foo` in package.json`` |
| `Live: <url>` | the value has an http(s) URL | `Live item has no http(s) URL` |
| `Screenshot: <image/url>` | the value, or the next line, has an image or URL | `Screenshot item has no image or URL` |

Recognised command shapes (several may be joined with `&&`; leading `VAR=value` assignments are ignored):

- `npm run <script> [-- <args>]` and `npm test [-- <args>]`: the script must be in the base or the head `package.json`;
- `npx vitest run [<args>]`: no script needed;
- `node <file>`, `bash <file>`, `scripts/<file>`: the file must be in the repository or the diff.

Arguments that look like paths (contain `/`, no glob or `$`) after `--` for npm, or after `run` for vitest, must also exist in the repository or the diff. Any other shape, or a command with a pipe, redirect, `;` or substitution, is `unverifiable`: a warning in report mode, a failure in enforce mode.

Any rejected item fails the check. Report mode never fails the job; enforce mode exits 1 on any failure.

## JSON report

`--json <file>` (or `PROOF_CHECK_JSON`) writes the report. The workflow uploads it as the `proof-check-report` artifact and sets the step outputs `status` and `json` (step id `proof`).

```jsonc
{
  "version": 1,                       // bumped on a breaking change
  "mode": "report",                   // "report" | "enforce"
  "status": "pass",                   // "pass" | "fail" | "exempt" across both rules
  "rules": {
    "proof": { "status": "pass", "reasons": ["Command: `npm run lint`"], "warnings": [] },
    "journey-test": { "status": "not-applicable", "reasons": ["..."] }
  },
  "items": [                          // every parsed item, in body order
    {
      "kind": "Command",              // "Test" | "Command" | "Live" | "Screenshot"
      "value": "npm run lint",
      "status": "accepted",           // "accepted" | "rejected" | "unverifiable"
      "evidence": [{ "kind": "npm-script", "ref": "lint", "source": "base" }],
      "message": "..."                // present on rejected and unverifiable items
    }
  ],
  "accepted": [ /* items that count as proof in this mode */ ],
  "evidenceKinds": ["npm-script"]     // sorted unique evidence kinds of accepted items
}
```

Evidence kinds: `file` (source `diff` or `repo`), `npm-script` (source `base` or `head`), `url` (Live, or a Screenshot URL), `image` (Screenshot markdown or `<img>`). In report mode, `unverifiable` Command items appear in `accepted` with empty evidence; in enforce mode they do not.
