## Linear issue ID

- Issue: OVD-844 (https://linear.app/overdrafter/issue/OVD-844)
- This is the rework Blaine approved on 2026-10-16 ("I approve of everything"), recorded in the OVD-844 decision comment, its third repair round (the 6e96e47c reviews, pushed as c8a6965a), and the FINAL round Release granted on 2026-10-16, which fills the gaps against Release's binding checklist on top of c8a6965a (no force-push). #818 (OVD-873) is the single sensitive-paths source, and this PR consumes it. Blocks OVD-845.
- This is the main PR for the issue, not a release-outcome parent. #817, #819 and #824 are stacked on this branch. Main was merged in, not rebased (most recently #805 at 873ce540), so they stay intact; they need a restack afterwards.

## Summary

`scripts/sensitive-class-detect.mjs` runs from the base checkout. It classifies every file a PR changes and writes a JSON result keyed to the head SHA, for OVD-845.

**Path classes come only from the shared list.** The detector loads `docs/sensitive-paths.json` from the checkout's working tree (never from a ref) and matches with `scripts/lib/sensitive-paths.mjs` (`loadSensitivePaths`, `createMatcher`, `compileGlob`). The copied class globs are gone from `scripts/sensitive-classes.json`, and its validator rejects a `classes` section. That file holds only the parts the detector adds itself:

- **SQL content rules.** These are the `rls` and `definer` classes. Changed SQL is read at the head as data, with a tokenizer that understands comments and dollar quotes. A `--` comment ends at CR as well as LF, as it does in Postgres.
- **The OVD-845 safe categories.** Their globs compile with the shared `compileGlob`.

**What the detector still does on its own:**

- **Fails closed.** A file with no sensitive class and no safe category gets the class `unclassified` and counts as sensitive (final round). Any config, API, truncation or file-list problem gives `status: error`.
- **Never hits the matcher's fail-open defaults.** Every entry is checked before the matcher sees it: the path must be a non-empty string that is not blank and not just `./`, the entry must have a status, and a rename must have `previous_filename`. An empty file list is accepted only when the PR itself reports `changed_files: 0`. Anything else gives `status: error`. No change to the matcher itself was needed.

**gate_loosening** combines two checks. Both are run by the base copy.

- **This detector's differ**, for its own config and gate files (`category_narrowed`, `category_order_changed`, `exemption_added`, `exemption_widened`, `sql_rule_removed`, `rule_narrowed`, `gate_changed`, `config_unreadable`, `config_invalid`, `not_checked`). The class side is removed; #818 owns glob narrowing.
- **The shared list's `findGateLoosening`**, called as is, not reimplemented (`glob_removed`, `glob_narrowed`, `glob_reclassified`, `config_removed`, `config_invalid`, `matcher_changed` for `GATE_CODE_FILES`).

If a head config can't be read through the API, that is also `status: error`.

**Workflow fix (QA FAIL @ 0163daf7, Codex @ 6e96e47c).** GitHub runs a `run:` block as `bash -e`, so the old `rc=$?` branch never ran. The step now:
- captures the exit code with `rc=0; node … || rc=$?`;
- always writes a summary, with an ERROR line when the detector exits non-zero, or exits 0 and leaves no readable result;
- removes the result file in both of those cases (`rm -f "$out"`), so no artifact is uploaded next to an ERROR summary. Before this round only the non-zero branch removed it;
- always exits 0.

### Final round: Release's binding checklist

Release's decisions for this last round, and where each is met at this head:

| Release item | Status |
| --- | --- |
| Fail closed: any provider, adapter or dispatch path is sensitive | **Added this round.** `docs/sensitive-paths.json` gains `**/*provider*{,/**}` and `**/*adapter*{,/**}` (provider_dispatch). `**/*dispatch*{,/**}` was already there. |
| Fail closed: ANY path not matched by an explicit safe rule is sensitive | **Added this round.** `detect()` gives a file with no sensitive class and no safe category the pseudo-class `unclassified` (reason `unclassified:no-safe-category`). It counts in `sensitive_count`, `classes` (listed last) and `multi_class`. A rename whose two names land in different safe categories, or one in none, gets it too. A file with a safe category and no class is the only non-sensitive outcome. The top-level `unclassified` list is kept. Still `version: 2`, because OVD-845 has not consumed a result yet; the script header documents it. |
| `WORKFLOW.md`, `scripts/symphony-ensure-branch.sh`, `scripts/symphony*` sensitive | Done at c8a6965a (`infra_ci`). Widened in repair round 3 (44751fde): `scripts/symphony-*` is now `scripts/symphony*{,/**}`, so `symphony.sh`, `symphony_agent.sh`, `symphonyHook.mjs` and anything under `scripts/symphony/` are `infra_ci` too. |
| Report mode under `bash -e`: `\|\| rc=$?`, no abort | Done (`rc=0; node … \|\| rc=$?`). The unreadable-result branch also removes the file (c8a6965a). |
| `docs/sensitive-paths.json` is the only path source; `sensitive-classes.json` holds no path list | Holds. `sensitive-classes.json` keeps only the SQL content rules and the OVD-845 safe categories from Blaine's approved decision, and its validator rejects a `classes` section. AGENTS.md changes are limited to the mirror lines between the sensitive-paths markers, which #818's `validate-agent-contract` parity check requires; there is no separate AGENTS.md drift test. |
| Rebase onto main | Main (dc32b9c9, #825; earlier 873ce540, #805) is merged in. It is not rebased, because another writer's round-3 commits are on the branch and must not be force-pushed over. |
| Tests | Provider/adapter/dispatch paths through `classifyPath` and `detect` (9 rows); WORKFLOW.md and the 3 `scripts/symphony*` files; 4 more Symphony name shapes (`scripts/symphony.sh`, `scripts/symphony/run.sh`, `scripts/symphony_agent.sh`, `scripts/symphonyHook.mjs`) exactly `infra_ci` through `classifyPath` and `detect` (round 3); unmatched paths sensitive with `[unclassified]` (4 rows); safe-only paths non-sensitive (3 rows); `unclassified` counted with other classes and listed last; renames; summary rendering. Every report-step test now also runs the real `run:` block as `bash -e -c "<block>"`, beside `bash -e <file>` and `bash --noprofile --norc -eo pipefail <file>`: exit 3, crash after writing, truncated JSON with exit 0, status ok, status error, no result, no detector. |
| Dry-run JSON for #790, #792, #794 | Re-run at this head; in Proof. |

**Main's #805 drift.** #805 added `scripts/qa-handoff/**`, which `.github/workflows/qa-handoff.yml` runs. The CI-script drift test failed on 10 of those files after the merge, so `scripts/qa-handoff/**` is `infra_ci` now.

**Fixture rows (#818's shared fixture).** `src/features/providers/ProviderCard.tsx` was pinned as not sensitive and is now `provider_dispatch`, as Release's provider rule requires. `docs/migration-drafts/ovd707/providers.md` and `scripts/provider-check.mjs` gain `provider_dispatch`. Four rows are added: `src/lib/quoteAdapter.ts`, `src/components/ProviderBadge.tsx`, `docs/adapters/README.md` (provider_dispatch) and `scripts/qa-handoff/gate.mjs` (infra_ci). Round 3 adds `scripts/symphony.sh`, `scripts/symphony/run.sh`, `scripts/symphony_agent.sh` and `scripts/symphonyHook.mjs` (infra_ci). The fixture edit is flagged `matcher_changed`, as expected.

**Effect on tracked files (path level, c8a6965a → this head).** 148 tracked files gain a class (81 were safe, 67 were unclassified), and none loses one. Most are provider docs, skills and `provider-integrations/**`. Separately, the 377 tracked files that match no class and no safe category (for example `vite.config.ts` and `server/design-graph/**`) were `unclassified` and are now **sensitive** in `detect()` output.

**Builder.** This round's code was written by hand on the box. Claude is at 98% usage and review-only until Oct 17, 3 PM MST, and no Cursor cloud agent tool was available.

**Coverage sweep (round 3).** `scripts/sensitive-class-sweep.mjs` checks, systematically, that no name 0163daf7 called sensitive is non-sensitive here outside a residual that no glob can close. Its test runs in `npm test`, and `node scripts/sensitive-class-sweep.mjs` prints the numbers and residual table below, which are pasted unchanged.

### Output schema change for OVD-845 (version 2)

`version` is `2`, because class names changed. The full schema is in the script header.

| Before (v1) | Now (v2) |
| --- | --- |
| `migration` | `migrations` for `supabase/migrations/**`, plus `schema` for any `.sql`, `.pgsql` or `.psql`, `supabase/config.toml` and `docs/migration-drafts/**`. A migration therefore has both. |
| `billing` | `payments` |
| `provider` | `provider_dispatch` |
| `ci`, `infra` | `infra_ci` |
| `auth`, `secrets`, `deps` | unchanged |
| `rls`, `definer` | unchanged, but they now come **only** from SQL content. A path is `auth` on the shared list when a name starts with `rls` or has `rls` after `-`, `_`, `.` or `,` (or after `\`, which the matcher also reads as a separator). `rls` after any other character, or at a camelCase boundary (`quoteRls.ts`), is **not** matched; the residual table below lists every such class the sweep generates. |

`classes` lists the shared list's classes first, in its order, and then `rls` and `definer`.

`files[].reasons` takes one of these forms:
- `<class>:path:<glob>`, one per shared glob that matches;
- `<class>:sql:<tokens>`;
- `<category>:path:<glob>`.

A renamed file's old name gets a `previous:` prefix. Reasons from the shared list keep all of their own fields and also get `kind` (its `code`), `path` (its file) and `source: "sensitive-paths"`.

### Shared list additions (additions only)

`findGateLoosening` finds no glob change against main: main (dc32b9c9) has 53 globs and this head has 137 (84 added), and none of main's is removed, narrowed or reclassified. Against 6e96e47c (115 globs) no glob is removed, narrowed or reclassified either: 22 globs are added. (Generated by the commands under "Repair round 3".) AGENTS.md mirrors the list between the markers, and `validate-agent-contract` passes.

**This round (6e96e47c reviews):**

- **Closing what the sweep found lost** (Codex, Opus and Sonnet blocking 1). Before these, the sweep found 489952 unexplained names against 6e96e47c's list (numbers below); after them, 0.
  - provider_dispatch `**/*provider*/**/*{admission,upload}*{,/**}`: provider admission or upload with any characters on either side of the directory separator, or with directories between (`provider/_upload`, `provider/(admission)`, `x-provider_/upload`, `provider/_/upload`). This is broader than the reviews' suggestion (`*provider*/*{admission,upload}*`) because a one-character directory between the words was also lost. It makes the four tracked `provider-integrations/*/admit/*_admission_revision.sql.review` files `provider_dispatch`; they were unclassified;
  - auth `**/*,rls*{,/**}`: rls after a comma, which a glob can spell (Opus);
  - payments `**/*chec?out*{,/**}`: `checkout` spelled with U+212A (Kelvin sign), which 0163daf7 lower-cased to `k` and the shared matcher does not. The sweep found it by trying every non-ASCII character whose lower case is an ASCII letter; U+212A is the only one.
- **infra_ci: the agent contract and agent configuration** (Opus blocking 2; Codex and Opus non-blocking):
  - `**/WORKFLOW.md`. `validate-agent-contract` reads exactly AGENTS.md, CLAUDE.md and WORKFLOW.md; WORKFLOW.md sets Codex's `approval_policy`, `thread_sandbox` and `networkAccess` and runs the Symphony hooks, and it was `docs` (auto-merge safe) at 0163daf7 and 6e96e47c;
  - `scripts/symphony-*` (since round 3 `scripts/symphony*{,/**}`): the hooks' `symphony-ensure-branch.sh` was `repo_scripts`; `symphony-preflight.sh` and `symphony-agent.sh` were already listed;
  - `scripts/vite-*`: `vite.config.ts` imports `vite-private-fixture-plugin.ts` and `vite-sample-plate-plugin.ts`, so `npm run build` and vitest run them; both were `repo_scripts` (Codex and Sonnet non-blocking);
  - Codex and Claude configuration: `**/.codex/config*`, `**/.codex/hooks*{,/**}`, `**/.claude/settings*`, `**/.claude/hooks/**`, `**/.claude/rules/**`, `**/.claude/launch.json`, `**/.mcp.json` (all unclassified before; the tracked `.claude/launch.json` is now `infra_ci`);
  - `**/GEMINI.md`, an agent instruction file that root `*.md` and `docs/**` otherwise made `docs`;
  - git hook directories and configs: `**/{.husky,.githooks,.git-hooks}/**`, `scripts/{hooks,git-hooks,githooks}/**` (`repo_scripts` before), `**/{lefthook,.lefthook}*`, `**/.pre-commit-config.yaml`.

  `.agents/skills/**` is left unclassified: it holds skills, like the `agent_skills` safe category, so making it a sensitive class is a policy call, not a coverage gap.
- **Shared fixture.** 18 rows are added: three provider examples (`provider/_upload/Form.tsx`, `provider/(admission)/index.tsx`, `provider/_/upload.tsx`), one tracked `provider-integrations` review file, `x,rls.ts`, `checkout` with U+212A, `WORKFLOW.md`, `GEMINI.md`, `scripts/symphony-ensure-branch.sh`, `scripts/vite-sample-plate-plugin.ts`, `.codex/config.toml`, `.claude/settings.json`, `.claude/hooks/pre-tool.sh`, `.mcp.json`, `.husky/pre-commit`, `scripts/hooks/pre-commit`, and two rows that must stay not sensitive (`src/hooks/use-toast.ts`, `src/features/providers/ProviderCard.tsx`). Editing the fixture is flagged `matcher_changed`, as expected.

**Round 2 (f786b942 reviews), with this round's walk roots:**

- **infra_ci: agent instruction files in any directory**: `**/AGENTS.md`, `**/AGENTS.override.md`, `**/CLAUDE.md`, `**/CLAUDE.local.md`. Codex reads one instruction file per directory and prefers `AGENTS.override.md`, so an override replaces the contract for its tree. Before that round:
  - safe: the tracked `src/features/quotes/AGENTS.override.md` (`frontend_ui`), a root `AGENTS.override.md`, `docs/AGENTS.md` and `docs/CLAUDE.md` (`docs`), `scripts/AGENTS.override.md` (`repo_scripts`) and `.codex/skills/AGENTS.override.md` (`agent_skills`);
  - unclassified: root `CLAUDE.md` and the tracked `supabase/AGENTS.override.md` and `worker/AGENTS.override.md`.
- **infra_ci: the scripts CI runs, as the drift test's walk defines them.** That is exactly what the test checks; at this head it reaches 282 files under `scripts/` (279 at 6e96e47c) and follows 23 package.json scripts. The walk starts from every `.github/**` file (the PR template included), and this round also from WORKFLOW.md and from the root tool configs CI's commands load (`*.config.{ts,mts,cts,js,mjs,cjs}`). It follows:
  - every `scripts/` reference in a `.github/**` file or WORKFLOW.md (a path, a prefix or a glob), and every relative import in a root tool config;
  - every `npm run <name>`, `npm test`, `npm start` and `npm --prefix <dir> …` in a `.github/**` file, in WORKFLOW.md, in a package.json script reached that way (with its pre and post scripts), and in a shell script reached. `npm ci` or `npm install` without `--ignore-scripts` follows the install lifecycle scripts; none are defined today;
  - `preflight.sh`'s `npm run "$stage"`, through a name list (`lint`, `typecheck`, `test`) that the test pins to `preflight.sh`'s own stage list. Any other `npm run "$variable"`, and any name with no package.json script, fails the test;
  - the `scripts/` files those package.json scripts name;
  - in each script reached: its `scripts/` references (except a `**` glob, which is prose) and its relative imports, `require`s and `new URL`s.

  The walk does not read JavaScript for npm runs; a test checks that no CI-run JavaScript file starts npm. It does not follow Python imports; CI names `scripts/agent-control` as a directory. It does not follow vitest's own file discovery (`vitest run` with no file), or string paths in a tool config (`vite.config.ts`'s opt-in `OVD_SOURCE_ONLY_TESTS` setup file, which CI does not enable, and its test include globs). Round 2 added 18 globs for files reached only through `npm run`, plus `scripts/check-migration-immutability*` from #820, and kept #813's former `ci` globs, main's gates, the detector's own files and `scripts/symphony-agent.sh`.
- **Coverage 0163daf7's path keywords had:** auth `**/*.rls*{,/**}`; provider_dispatch `**/*provider*{admission,upload}*{,/**}` and `**/*provider/{admission,upload}*{,/**}`.
- **schema: `**/*.{pgsql,psql}`.** These files were sensitive only through the SQL token match, which concatenation and escapes can evade.
- **Earlier rounds:** `**/*.tfvars` and `**/*.Dockerfile` (infra_ci); `**/.env*/**/*` (secrets); `bun.lock`, `Pipfile(.lock)` and `Gemfile(.lock)` (deps).

### Before and after against 0163daf7 (narrowing check)

**The sweep.** `scripts/sensitive-class-sweep.mjs` holds a frozen copy of 0163daf7's path rules and matcher. The copy is checked against `git show 0163daf7:scripts/sensitive-classes.json` by its test (skipped where the commit is absent, as in CI's one-commit checkout), and I ran it against the real 0163daf7 `classifyPath` on all 1699371 generated names: 0 differences. It generates these names. Keyword names are placed in `src/features`, `src/pages`, `src/components`, `worker/src`, `scripts`, `docs`, `e2e` and `.codex/skills`, each as a `.tsx` file, a `.md` file and a directory with `index.ts`. "The characters" are the 33 printable ASCII characters that are not letters or digits (space and the 32 punctuation characters), plus tab, U+00A0, U+00E9, U+4E2D and U+0130.

- For every 0163daf7 path keyword (auth, oauth, permission, session, payment, billing, stripe, pricing, invoice, checkout, dispatch, secret, credential, vault, rls), in lower case, capitalised, upper case, and with a letter replaced by a non-ASCII character that lower-cases to it (only `k` has one, U+212A): after nothing, `a`, `x`, `quote` or `a1` (so a capitalised form after a letter or digit is a camelCase boundary), with each of the characters immediately before it, immediately after it, on both sides, and with `()`, `[]`, `{}` and `<>` around it; and next to the separator in front of it, as the last character of the parent directory and as a one-character parent directory.
- For provider-admission and provider-upload, also each of the characters, and every pair of them, on either side of the `/` between the words; each character, once or doubled, between the words in one name; each character as a one-character directory between them; and each character before or after either word.
- For every 0163daf7 class glob, each brace expansion with every wildcard filled in turn by each of the characters, alone and before or after a letter, in upper and lower case, with a leading `**` filled by each of the directories.

Each name is classified by both. A name sensitive at 0163daf7 and not sensitive here is lost, and the sweep fails on any lost name outside a residual class. A residual class is `rls` right after a character no glob can spell, or at a camelCase boundary. Each class has a witness (`src/lib/<character>rls.ts`, or `src/lib/uRls.ts`) that the test checks: the witness is `rls` at 0163daf7 and not sensitive here, and it differs from `src/lib/urls.ts` only in that character or in case. Any glob that matches the witness needs a wildcard at that character, or ignores case, so it also matches `src/lib/urls.ts`, which #818's fixture pins as not sensitive.

Output of `node scripts/sensitive-class-sweep.mjs` at this head, unchanged. The sweep compares path-level classes. Since the final round, a name that loses its class but lands in no safe category is still sensitive in `detect()` (`unclassified`), so only the "Of which safe here" column (32200 names in all) is actually non-sensitive.

Names generated: 1699371. Sensitive at 0163daf7: 1515277. Still sensitive: 1478477. Lost a path class: 36800 (32200 to a safe category, the only non-sensitive outcome; 4600 to unclassified, which detect() reports as sensitive). Unexplained: 0. Not safe at 0163daf7 and safe here: 0.

| Residual class | Lost names | Of which safe here | Example |
| --- | --- | --- | --- |
| rls after `!` | 864 | 756 | `"src/features/!rls.tsx"` |
| rls after `"` | 864 | 756 | `"src/features/\"rls.tsx"` |
| rls after `#` | 864 | 756 | `"src/features/#rls.tsx"` |
| rls after `$` | 864 | 756 | `"src/features/$rls.tsx"` |
| rls after `%` | 864 | 756 | `"src/features/%rls.tsx"` |
| rls after `&` | 864 | 756 | `"src/features/&rls.tsx"` |
| rls after `'` | 864 | 756 | `"src/features/'rls.tsx"` |
| rls after `(` | 1224 | 1071 | `"src/features/(rls.tsx"` |
| rls after `)` | 864 | 756 | `"src/features/)rls.tsx"` |
| rls after `*` | 864 | 756 | `"src/features/*rls.tsx"` |
| rls after `+` | 864 | 756 | `"src/features/+rls.tsx"` |
| rls after `:` | 864 | 756 | `"src/features/:rls.tsx"` |
| rls after `;` | 864 | 756 | `"src/features/;rls.tsx"` |
| rls after `<` | 1224 | 1071 | `"src/features/<rls.tsx"` |
| rls after `=` | 864 | 756 | `"src/features/=rls.tsx"` |
| rls after `>` | 864 | 756 | `"src/features/>rls.tsx"` |
| rls after `?` | 864 | 756 | `"src/features/?rls.tsx"` |
| rls after `@` | 864 | 756 | `"src/features/@rls.tsx"` |
| rls after U+0009 | 864 | 756 | `"src/features/\trls.tsx"` |
| rls after U+0020 | 864 | 756 | `"src/features/ rls.tsx"` |
| rls after U+00A0 | 864 | 756 | `"src/features/ rls.tsx"` |
| rls after U+00E9 | 864 | 756 | `"src/features/érls.tsx"` |
| rls after U+0130 | 864 | 756 | `"src/features/İrls.tsx"` |
| rls after U+4E2D | 864 | 756 | `"src/features/中rls.tsx"` |
| rls after `[` | 1224 | 1071 | `"src/features/[rls.tsx"` |
| rls after `]` | 864 | 756 | `"src/features/]rls.tsx"` |
| rls after `^` | 864 | 756 | `"src/features/^rls.tsx"` |
| rls after `` ` `` | 864 | 756 | `` "src/features/`rls.tsx" `` |
| rls after `{` | 1224 | 1071 | `"src/features/{rls.tsx"` |
| rls after `\|` | 864 | 756 | `"src/features/\|rls.tsx"` |
| rls after `}` | 864 | 756 | `"src/features/}rls.tsx"` |
| rls after `~` | 864 | 756 | `"src/features/~rls.tsx"` |
| rls at a camelCase boundary | 7712 | 6748 | `"src/features/aRls.tsx"` |

The same generator against 6e96e47c's list (before this round's globs): 526752 names lost (455640 to a safe category, 71112 to unclassified), of which 489952 were unexplained: 237520 provider-admission and 237520 provider-upload names, 14048 `checkout` names with U+212A and 864 `rls` names after a comma. The other 36800 were the residual classes above.

**The residual, stated as a rule.** `rls` is not matched when it follows any character other than an ASCII letter or digit, `.`, `_`, `-`, `,`, `/` or `\`, or when it starts a camelCase word (`quoteRls`, `a1Rls`, `XRls`). That includes every other printable ASCII character, tabs and other control characters, and every non-ASCII character except U+212A (0163daf7 split words on every character outside a-z and 0-9 after lower-casing, and U+212A is the only non-ASCII character that lower-cases to an ASCII letter). The sweep tests the 32 listed characters and camelCase; the rule covers the rest by the same witness argument. These names are not correctly non-sensitive; they are a residual because the shared list matches case-insensitively and allows only letters, digits and `. _ - / * ? { } ,` in a glob. Closing it needs camelCase-aware or character-class matching in `scripts/lib/sensitive-paths.mjs`, which is #818's module and out of scope here. No tracked path has such a name: `git ls-files | grep -iE '[^a-z0-9._/,\\-]rls|[a-z0-9]rls'` is empty, and of the 36 tracked paths with an `rls` word at 0163daf7, every one has it at a name start or after `.`, `_`, `-`, `,`, `/` or `\`.

**Other path sets**, each classified by the 0163daf7 detector and by this head (sensitive, safe or unclassified; class renames ignored). Tracked files and fixture paths that exist were read from the working tree, so SQL content counts on both sides.

| Path set | Paths | Sensitive at 0163daf7, not sensitive at this head | Not sensitive at 0163daf7, sensitive at this head | Safe ↔ unclassified |
| --- | --- | --- | --- | --- |
| Every tracked file at c8a6965a | 2742 | **0** | 223 (127 safe, 96 unclassified) | 0 |
| Shared fixture | 105 (87 at 6e96e47c) | **0** | 39 (26 safe, 13 unclassified) | 0 |
| Generated by the sweep | 1699371 | 36800, all in the residual classes | not counted | not counted; 0 names go from not safe to safe |

This table was measured at c8a6965a. This round's changes only add globs and make `unclassified` sensitive, so the "not sensitive" column cannot grow; the effect on tracked files is under "Final round" above. Against 6e96e47c, 10 tracked files become sensitive and none stops being sensitive: `WORKFLOW.md` (was docs), `scripts/symphony-ensure-branch.sh`, `scripts/vite-private-fixture-plugin.ts`, `scripts/vite-sample-plate-plugin.ts` and `scripts/vite-private-fixture-plugin.test.mjs` (were safe), and `.claude/launch.json` and the four `provider-integrations/*/admit/*_admission_revision.sql.review` files (were unclassified). The two new sweep files are `infra_ci` through `scripts/sensitive-class*`.

### Deliberate deviation from the OVD-844 test plan

The test plan says `security definer` inside a `$$` string gives no false positive. This detector **does** flag it: `select $$ security definer $$;` gives `[definer]`. It scans every string and dollar-quoted body as SQL, so that `DO` blocks and `EXECUTE` bodies are caught. That fails closed. QA asked that this be recorded rather than reverted. The test pins it under "fails closed on a string literal".

## Problem

OVD-845 needs a machine-readable, fail-closed classification of what a PR touches. #818 made `docs/sensitive-paths.json` the single source, so this detector must not keep its own copy of the globs. QA found that the report-mode step could fail red without writing a summary. The f786b942 reviews found that agent instruction files other than the root `AGENTS.md`, and scripts CI reaches only through `npm run`, came out auto-merge safe or unclassified. The 6e96e47c reviews found that provider admission and upload names with punctuation next to the separator, and rls after a comma, still lost sensitivity (two rounds had found such gaps one example at a time); that WORKFLOW.md and its hook script came out auto-merge safe; that the workflow kept an unreadable result for upload; and that the body's residual statement was inexact.

## Acceptance criteria addressed

- [x] **Single source of truth.** Path classes come from `docs/sensitive-paths.json` through the shared matcher, with no copied globs. The AGENTS.md table drift test was dropped in favour of #818's `validate-agent-contract` parity, which CI runs through `npm run test:agent-control-plane` (ci.yml:143); removing a list entry fails it. A drift test walks from `.github/**`, WORKFLOW.md and the root tool configs through `npm run` and package.json, as defined above, and checks that every `scripts/` file it reaches is `infra_ci` on the shared list. Another test checks that the detector returns the shared fixture's classes for every fixture path, and another that every file `validate-agent-contract` reads is `infra_ci`.
- [x] **No narrowing against 0163daf7 outside the residual.** The sweep test fails on any lost name outside the residual classes, and on any residual class whose witness does not hold.
- [x] **Classification by path and by SQL content, failing closed.** This includes the strict file-list checks.
- [x] **A JSON report keyed to the head SHA**, schema version 2, documented above.
- [x] **`gate_loosening` judged by the base copy.** It covers safe categories (`category_narrowed`, `category_order_changed`), SQL rules, and the shared list's `findGateLoosening`.
- [x] **Report mode only, and the `bash -e` fix.** The step never fails the job, always writes a summary, and leaves no result to upload when there is no readable one. It is not a required check; making it one needs Blaine's card.
- [x] **Dry runs on #790, #792 and #794.** The JSON is in Proof.

## Files changed

- `scripts/sensitive-class-detect.mjs`
- `scripts/sensitive-class-detect.test.mjs`
- `scripts/sensitive-class-sweep.mjs` (new: frozen 0163daf7 rules, generator, residual check, CLI)
- `scripts/sensitive-class-sweep.test.mjs` (new)
- `scripts/sensitive-classes.json`
- `.github/workflows/sensitive-class.yml`
- `docs/sensitive-paths.json` (additions only, against main, 6e96e47c and c8a6965a)
- `AGENTS.md` (marker list only, including the infra_ci label)
- `scripts/fixtures/sensitive-paths/paths.json` (against main: 2 entries changed, 44 added, none removed; the last entry moved for its trailing comma)

Merging main brings no other changes into this PR's diff.

## Scope

Included:
- the rework onto the shared matcher;
- the strict input checks;
- the gate_loosening composition;
- the workflow fix;
- the shared-list additions;
- the npm-run drift walk, now also from WORKFLOW.md and the root tool configs;
- the CR line-comment fix;
- the coverage sweep against 0163daf7.

Not included:
- any change to branch protection or required checks;
- the OVD-845 gate;
- any change to `scripts/lib/sensitive-paths.mjs` (so the rls residual stays);
- restacking #817, #819 and #824;
- new dependencies. The workflow test loads `js-yaml`, which is already installed transitively, the same way the matcher's tests load picomatch.

Size: 3215 added and 13 removed lines against main, in 9 files, 1420 of the added lines in the two test files, so this is over the 200-line guideline. It was not split further because the detector, its config and its workflow only work together, and the list additions are what its drift, fixture and sweep tests check. Follow-ups are stacked separately (#817, #819, #824).

## Verification

**Repair round 3 (Release, delta-scoped), at this head (91f1b7e20bbbce63a66fce76ff01901f75ac2ac0), on the box (Linux):**

Commits since 43440dcc: 44751fde (Symphony glob and rows), b6f911c2 (merge of main dc32b9c9, #825, clean), 91f1b7e2 (`scripts/check-secret-paths*` as `infra_ci`: after the merge, the CI-script drift test failed on `scripts/check-secret-paths.mjs`, run by `secret-scan.yml`, and `scripts/check-secret-paths.node-test.mjs`, run by `test:portable-node`).

- `scripts/symphony-*` (added by this PR, not on main) is replaced by `scripts/symphony*{,/**}`, which is `scripts/symphony*` plus `scripts/symphony*/**` in the list's own idiom (as `scripts/deploy*{,/**}`). Two separate globs fail `scripts/lib/sensitive-paths.test.mjs` "matches picomatch {dot, nocase} for every glob and path": `compileGlob` makes a trailing `/**` optional, so a standalone `scripts/symphony*/**` matches `scripts/symphony-ensure-branch.sh`, which picomatch does not.
- Numbers, generated (not typed) by `numbers.sh` and the gate scripts:

```
$ numbers.sh <worktree> origin/main HEAD 43440dcc
base dc32b9c9  head 91f1b7e2
diff stat (origin/main...HEAD):  9 files changed, 3215 insertions(+), 13 deletions(-)
added lines in test files: 1420
vs base: globs 53 -> 137; added 84, removed 0, reclassified 0
  fixture rows 113; added 44, changed 2, removed 0
  changed rows: docs/migration-drafts/ovd707/providers.md  scripts/check-rls-deny-coverage.mjs
vs previous head: globs 136 -> 137; added 2, removed 1, reclassified 0
  removed globs: scripts/symphony-*
  added globs: scripts/symphony*{,/**}  scripts/check-secret-paths*
  fixture rows 113; added 4, changed 0, removed 0
  added rows: scripts/symphony.sh  scripts/symphony/run.sh  scripts/symphony_agent.sh  scripts/symphonyHook.mjs
  changed rows: none
$ numbers.sh <worktree> origin/main HEAD 6e96e47c   (excerpt)
vs previous head: globs 115 -> 137; added 22, removed 0, reclassified 0
  fixture rows 113; added 26, changed 2, removed 0
```

- **gate_loosening dry run against main dc32b9c9.** The shared list's `findGateLoosening` (glob diff, main's list to this head's list): `{"detected":false,"reasons":[],"requires":["grokbot_countersign","blaine_card"]}`. With the changed-file list (`npm run sensitive-paths:report` path: `node scripts/lib/sensitive-paths.mjs report --base-ref origin/main`): `detected: true`, only `matcher_changed` for `scripts/fixtures/sensitive-paths/paths.json`, as before. The detector's composed `gate_loosening` (`gateLooseningForPull`, this head's copy standing in for the base copy main lacks): `detected: true` with `gate_changed` for the workflow and the detector and `matcher_changed` for the fixture, `errors: []`, unchanged from 43440dcc. Against 43440dcc the glob diff reports `glob_narrowed` for `scripts/symphony-*` because a rewrite is not proven a superset; the new glob is a strict superset, and `scripts/symphony-*` was never on main.
- [x] `bash scripts/preflight.sh lint typecheck`: lint PASS, typecheck PASS.
- [x] `npx vitest run --maxWorkers=2 scripts/sensitive-class-detect.test.mjs scripts/sensitive-class-sweep.test.mjs scripts/lib/sensitive-paths.test.mjs scripts/test-lane-contract.test.mjs scripts/check-secret-paths.test.mjs scripts/secret-scan-workflow.test.mjs`: 493/493.
- [x] `node scripts/validate-agent-contract.mjs`: valid. `npm run test:agent-control-plane`: pass. `npm run test:portable-node`: 1704 pass, 0 fail.
- [x] **Delta re-reviews @ 91f1b7e2** (43440dcc..91f1b7e2): Opus APPROVED (https://github.com/optomachina/Overdrafter/pull/813#issuecomment-6229333419), Sonnet APPROVED (https://github.com/optomachina/Overdrafter/pull/813#issuecomment-6229333626), Codex APPROVED (https://github.com/optomachina/Overdrafter/pull/813#issuecomment-6229333881). All three had also approved 44751fde before the merge.
- [x] Full `npx vitest run --maxWorkers=2` at 44751fde (before the merge), with worker dependencies installed: the only failures are the same environmental set as at 43440dcc below: 32 tests (3 OVD-417 docker-only, 29 `providerSessionProbe`) and 4 browser test files (no Playwright browsers on the box).

**Final round, at 43440dcc, on the box (Linux):**

- [x] `bash scripts/preflight.sh lint`: PASS. `bash scripts/preflight.sh typecheck`: PASS.
- [x] `npx vitest run --maxWorkers=2` (full suite): 12641 passed, 32 failed, 76 skipped. All 32 failures are environmental, and #824's preflight on the same box fails the same set:
  - the 3 known OVD-417 docker-only tests (`qualify-ovd417-four-migration-suffix`);
  - 29 tests in `worker/src/providerSessionProbe.test.ts` and 4 browser test files (`providerPortalKernel.offhost.browser`, `quickpartsProductionPortal.browser`, `weergProductionPortal.browser`, `recovery/browserRecovery`), because the box has no Playwright browsers installed.

  None of them touches the detector. Hosted CI's `test` job is the authority.
- [x] `npx vitest run scripts/sensitive-class-detect.test.mjs scripts/sensitive-class-sweep.test.mjs scripts/lib/sensitive-paths.test.mjs scripts/test-lane-contract.test.mjs --maxWorkers=2`: 359/359 (detect 258, sweep 53, sensitive-paths 30, test-lane 18).
- [x] `node scripts/validate-agent-contract.mjs`: valid. `findGateLoosening` from main's list to this head's list gives `detected: false`.
- [x] `npx eslint` on the changed `.mjs` files: clean.
- [x] **Mutation checks this round** (each file was restored afterwards):
  - Without the `unclassified` class in `detect()`, 7 detector tests fail.
  - Without `**/*adapter*{,/**}` (removed from the list and the markers together), 4 tests fail.
  - Without `|| rc=$?`, the 3 non-zero-exit step tests fail (`bash -e`, `bash -eo pipefail` and `bash -e -c`).

Commands run on c8a6965a (round 3, before the final round):

```bash
npx eslint --fix scripts/sensitive-class-sweep.mjs scripts/sensitive-class-sweep.test.mjs scripts/sensitive-class-detect.mjs scripts/sensitive-class-detect.test.mjs
bash scripts/preflight.sh lint
bash scripts/preflight.sh typecheck
npx vitest run scripts/sensitive-class-detect.test.mjs scripts/sensitive-class-sweep.test.mjs scripts/lib/sensitive-paths.test.mjs scripts/test-lane-contract.test.mjs --maxWorkers=2
node scripts/validate-agent-contract.mjs
node --test scripts/validate-agent-contract.node-test.mjs
npm run test:portable-node
node scripts/sensitive-class-sweep.mjs
```

Results:

- [x] eslint: no issues. `preflight: lint PASS`, `preflight: typecheck PASS`.
- [x] vitest:
  - `sensitive-class-detect.test.mjs`: 230/230
  - `sensitive-class-sweep.test.mjs`: 53/53 (the 0163daf7 comparison ran; it skips in CI's one-commit checkout)
  - `lib/sensitive-paths.test.mjs`: 30/30
  - `test-lane-contract.test.mjs`: 18/18
  - Also run on this head: `jev-pr-screen` 16/16, `proof-check` 65/65, `validate-pr-body` 58/58, `vite-private-fixture-plugin` 4/4.
- [x] `agent-contract: valid`. `validate-agent-contract.node-test.mjs`: 3/3.
- [x] `test:portable-node`: 1705 tests, 1703 pass, 0 fail, 2 skipped. The sensitive-paths report there shows 0 parity errors.
- [x] `node scripts/sensitive-class-sweep.mjs`: exit 0, output above.
- [x] **Mutation checks this round**, on this round's commits before the last one, which changes no assertion (each file was restored afterwards):
  - Dropping `rm -f "$out"` from the unreadable branch fails both new workflow rows (`bash -e` and `bash -eo pipefail`).
  - Removing `**/*provider*/**/*{admission,upload}*{,/**}` (list and markers together) fails 15 tests: the sweep, the review-names test, 11 restored-coverage rows and the two shared-fixture tests.
  - Removing `**/*,rls*{,/**}` fails 6 tests; removing `**/*chec?out*{,/**}` fails 5. Both include the sweep.
  - Removing `**/WORKFLOW.md` fails 4 tests, including "classifies every file validate-agent-contract reads as infra_ci". Removing `scripts/symphony-*` or `scripts/vite-*` fails the CI-script drift test and the fixture tests. Removing `**/.claude/settings*` fails 4.
  - Turning off the WORKFLOW.md walk root fails "finds the scripts CI runs".
- [x] **Carried from earlier rounds** (that code has not changed): restoring the old `node …; rc=$?` step fails both non-zero-exit step tests; turning off the strict file-list checks fails 11 tests; removing `**/AGENTS.override.md` fails the instruction-file rows and the shared-fixture test.
- [x] **Before and after on #790, #792 and #794.** Re-run from c8a6965a at the same pinned heads. The JSON is identical to the blocks in Proof, field for field.
- [x] **Before and after against 0163daf7**: the sweep and the tables above.
- [x] **This detector on #813 itself** at c8a6965a: `status: ok`, 9 of 9 files `infra_ci`, `gate_loosening.detected: true` with `gate_changed` for the workflow and the detector and `matcher_changed` for the fixture.

Baseline failures or exceptions: the full `npm test` was not run locally. Hosted CI runs it on this head.

## Tests

`scripts/sensitive-class-detect.test.mjs` was rewritten for the new architecture. It covers:

- class mapping through the shared matcher, including every shared-fixture path;
- agent instruction files in any directory, and (this round) WORKFLOW.md, the Symphony and vite scripts, Codex and Claude configuration, MCP servers and git hooks, all `infra_ci` and never a safe category; that every file `validate-agent-contract` reads is `infra_ci`; and that `src/hooks/**` and provider pages without admission or upload stay out;
- the coverage restored from 0163daf7: `.rls` and `,rls`, provider admission and upload with punctuation next to or between separators (every example the 6e96e47c reviews named), `checkout` with U+212A, `.pgsql` and `.psql`, and the camelCase rls residual next to `src/lib/urls.ts`;
- the strict file list: malformed entries, an empty list, and `classifyPath` refusing non-paths. A spy matcher confirms that a bad entry never reaches the matcher;
- the shared list's `findGateLoosening`, folded in;
- the base copy still judging when the head edits the differ, the matcher, the config and the list;
- the real workflow `run:` block run under `bash -e` and `bash -eo pipefail` with stub detectors: exit 3, a crash after writing a result, status ok, status error, no result, and (this round) exit 0 after writing truncated JSON, an empty file or `null`, which must leave no result file;
- the CI-script drift walk, now also from WORKFLOW.md and the root tool configs.

`scripts/sensitive-class-sweep.test.mjs` (new) covers:

- the frozen rules against `git show 0163daf7:scripts/sensitive-classes.json` (class order, path globs, keywords and safe categories), when the commit is present;
- the frozen matcher on known 0163daf7 results, and that U+212A is the only non-ASCII character that lower-cases to an ASCII letter;
- the residual classifier on examples, and every residual class's witness; a witness a glob could cover (`,rls`) is rejected;
- the sweep itself, with every character and position in `src/features` and `scripts` (161357 names): no unexplained loss, no newly safe name, exactly the 33 expected residual classes, and a table with one row per class that a backtick or pipe cannot break;
- that the generator produces the names the reviews found, and that they are sensitive.

## Migration notes

- [x] No migration impact

## Rollback / risk notes

**What could go wrong:**
- **Class renames.** OVD-845 isn't built yet, so nothing reads the v1 names. The class mapping above is the contract.
- **Broader matching.** Against 0163daf7, 223 tracked files move to sensitive, and none moves the other way.
  - The shared list matches class words anywhere in a name: `Unauthorized.tsx` is `auth`, where #813 required the word to start there.
  - This round makes 10 more tracked files sensitive than 6e96e47c did (listed above). The provider glob is broader than 0163daf7's keyword: any file below a directory whose name contains `provider`, with `admission` or `upload` in a name anywhere below that directory, is `provider_dispatch`.
  - So PRs that only edit those files, scripts or instruction files no longer auto-merge; they need Blaine's card. That is the fail-closed direction.
- **Unmatched files are sensitive now.** 377 tracked files that match no class and no safe category (for example `vite.config.ts`, `server/design-graph/**`, `worker/src/config.ts`) now count as sensitive, so PRs that touch them need Blaine's card. That is Release's fail-closed rule.
- **Residual narrowing.** Only inside a safe category: `rls` after any character other than an ASCII letter or digit, `.`, `_`, `-`, `,`, `/` or `\` (U+212A excepted), or at a camelCase boundary, was `rls` at 0163daf7 and is not sensitive now. No tracked file has such a name. The sweep lists the classes and counts.
- **The sweep is a model of 0163daf7, not the commit.** Its frozen copy was compared with the real detector on every generated name (0 differences), and its test compares the rules with the commit where history exists. The sweep covers the character positions listed above; names with several unusual characters in a row are covered by the same rules but not each generated.
- **The walk is an approximation of "what CI runs".** It errs towards more files. A text reference such as `provider-permissions-check.mjs` reading `scripts/provider-kill.mjs` counts as a run, and so do that file's imports. It misses a script that CI reaches only through vitest discovery, a Python import, a string path in a tool config, or a JavaScript file that starts npm; the last of these is tested to be absent.
- **`scripts/sensitive-classes.json` is not self-sufficient.** The detector needs the base checkout to have the shared list. A missing or invalid list gives `status: error`.

**Rollback:** revert this PR's commits after the merges. Report mode means nothing is gated on this check.

## Documentation

- [x] Docs updated

The script header documents the v2 schema and class mapping, including the exact rls residual. The sweep's header documents what it generates and what a residual class is. The workflow header documents the `bash -e` handling and that an unreadable result is removed. The test file documents the drift walk's definition and roots. The infra_ci description in `docs/sensitive-paths.json` and its AGENTS.md label now name the agent contract, agent configuration and git hooks. The AGENTS.md marker list mirrors the list.

## Gate loosening (plan §6)

This PR edits gate files:
- the detector, its config and its workflow;
- `docs/sensitive-paths.json`, with additions only against main;
- the shared fixture.

The workflow skips on this PR because the base has no detector yet. The detector, run from this head on #813 itself, reports `gate_loosening.detected: true`, with `gate_changed` for the workflow and the detector and `matcher_changed` for the fixture. Under plan §6, merging needs Blaine's card plus a Grok Bot countersign.

## Proof

Test: scripts/sensitive-class-detect.test.mjs

Command: npx vitest run scripts/sensitive-class-detect.test.mjs scripts/sensitive-class-sweep.test.mjs scripts/lib/sensitive-paths.test.mjs --maxWorkers=2

```text
 Test Files  3 passed (3)
      Tests  341 passed (341)
```

Dry runs, re-run from this head (43440dcc). `GITHUB_TOKEN` came from `gh auth token`, and each run was pinned with `--head-sha` to that PR's head. Each JSON block is the file that run wrote. Compared with c8a6965a, the only changes are the final-round `unclassified` class (unclassified files now count as sensitive) and #792's provider files.

Command: node scripts/sensitive-class-detect.mjs --repo optomachina/Overdrafter --pr 790 --head-sha d73642da3ef495ee2e40abfa8c263eb78296cc67 --json sc-790.json

```text
version: 2, status: ok
classes: [unclassified]
multi_class: false
sensitive: 13 of 19 files; unclassified (sensitive): 13
gate_loosening.detected: false
```

<details><summary>#790 JSON (sc-790.json)</summary>

```json
{
  "version": 2,
  "sha": "d73642da3ef495ee2e40abfa8c263eb78296cc67",
  "base_sha": "4d38cd9a371887dafa949a045a82f8b0f11977d4",
  "status": "ok",
  "classes": [
    "unclassified"
  ],
  "sensitive_count": 13,
  "multi_class": false,
  "files": [
    {
      "path": "server/design-graph/README.md",
      "status": "modified",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "server/design-graph/agents.ts",
      "status": "modified",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "server/design-graph/cad-agent.ts",
      "status": "modified",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "server/design-graph/control/commands.ts",
      "status": "added",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "server/design-graph/control/control.test.ts",
      "status": "added",
      "classes": [],
      "category": "tests",
      "reasons": [
        "tests:path:**/*.test.{ts,tsx,mjs}"
      ]
    },
    {
      "path": "server/design-graph/control/errors.ts",
      "status": "added",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "server/design-graph/control/index.ts",
      "status": "added",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "server/design-graph/control/machine.ts",
      "status": "added",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "server/design-graph/control/plate-pause-cancel.test.ts",
      "status": "added",
      "classes": [],
      "category": "tests",
      "reasons": [
        "tests:path:**/*.test.{ts,tsx,mjs}"
      ]
    },
    {
      "path": "server/design-graph/control/step-validator.ts",
      "status": "added",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "server/design-graph/control/store.ts",
      "status": "added",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "server/design-graph/control/test-support.ts",
      "status": "added",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "server/design-graph/events.ts",
      "status": "modified",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "server/design-graph/graph.ts",
      "status": "modified",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "server/design-graph/index.ts",
      "status": "modified",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "server/jarvis/design-graph-port.test.ts",
      "status": "modified",
      "classes": [],
      "category": "tests",
      "reasons": [
        "tests:path:**/*.test.{ts,tsx,mjs}"
      ]
    },
    {
      "path": "src/features/jarvis/core/conversation-service.test.ts",
      "status": "modified",
      "classes": [],
      "category": "tests",
      "reasons": [
        "tests:path:**/*.test.{ts,tsx,mjs}"
      ]
    },
    {
      "path": "src/features/jarvis/core/render.ts",
      "status": "modified",
      "classes": [],
      "category": "frontend_ui",
      "reasons": [
        "frontend_ui:path:src/features/**"
      ]
    },
    {
      "path": "src/features/jarvis/core/types.ts",
      "status": "modified",
      "classes": [],
      "category": "frontend_ui",
      "reasons": [
        "frontend_ui:path:src/features/**"
      ]
    }
  ],
  "unclassified": [
    "server/design-graph/README.md",
    "server/design-graph/agents.ts",
    "server/design-graph/cad-agent.ts",
    "server/design-graph/control/commands.ts",
    "server/design-graph/control/errors.ts",
    "server/design-graph/control/index.ts",
    "server/design-graph/control/machine.ts",
    "server/design-graph/control/step-validator.ts",
    "server/design-graph/control/store.ts",
    "server/design-graph/control/test-support.ts",
    "server/design-graph/events.ts",
    "server/design-graph/graph.ts",
    "server/design-graph/index.ts"
  ],
  "errors": [],
  "gate_loosening": {
    "detected": false,
    "reasons": [],
    "requires": [
      "grokbot_countersign",
      "blaine_card"
    ]
  }
}
```

</details>

Command: node scripts/sensitive-class-detect.mjs --repo optomachina/Overdrafter --pr 792 --head-sha 47541a4b32094b52868943e0a74f42310ac1e872 --json sc-792.json

```text
version: 2, status: ok
classes: [schema, provider_dispatch, secrets, infra_ci, rls, definer, unclassified]
multi_class: true
sensitive: 35 of 44 files; unclassified (sensitive): 6
gate_loosening.detected: false
```

<details><summary>#792 JSON (sc-792.json)</summary>

```json
{
  "version": 2,
  "sha": "47541a4b32094b52868943e0a74f42310ac1e872",
  "base_sha": "ad3476c3d907b94f077189c7344c8a863edbc125",
  "status": "ok",
  "classes": [
    "schema",
    "provider_dispatch",
    "secrets",
    "infra_ci",
    "rls",
    "definer",
    "unclassified"
  ],
  "sensitive_count": 35,
  "multi_class": true,
  "files": [
    {
      "path": ".github/workflows/ovd829-pending-pgtap.yml",
      "status": "added",
      "classes": [
        "infra_ci"
      ],
      "category": null,
      "reasons": [
        "infra_ci:path:.github/workflows/**"
      ]
    },
    {
      "path": "docs/business/business-model.md",
      "status": "modified",
      "classes": [],
      "category": "docs",
      "reasons": [
        "docs:path:docs/**"
      ]
    },
    {
      "path": "docs/migration-drafts/ovd-678-provider-daily-quote-cap.sql",
      "status": "modified",
      "classes": [
        "schema",
        "provider_dispatch",
        "rls",
        "definer"
      ],
      "category": null,
      "reasons": [
        "schema:path:**/*.sql",
        "schema:path:docs/migration-drafts/**",
        "provider_dispatch:path:**/*provider*{,/**}",
        "rls:sql:row level security",
        "definer:sql:security definer"
      ]
    },
    {
      "path": "docs/migration-drafts/ovd-828-s1.rollback.sql",
      "status": "added",
      "classes": [
        "schema",
        "definer"
      ],
      "category": null,
      "reasons": [
        "schema:path:**/*.sql",
        "schema:path:docs/migration-drafts/**",
        "definer:sql:security definer"
      ]
    },
    {
      "path": "docs/migration-drafts/ovd-828-s1.sql",
      "status": "added",
      "classes": [
        "schema",
        "rls",
        "definer"
      ],
      "category": null,
      "reasons": [
        "schema:path:**/*.sql",
        "schema:path:docs/migration-drafts/**",
        "rls:sql:row level security",
        "definer:sql:security definer"
      ]
    },
    {
      "path": "docs/migration-drafts/provider-fanout-guards.sql",
      "status": "modified",
      "classes": [
        "schema",
        "provider_dispatch",
        "definer"
      ],
      "category": null,
      "reasons": [
        "schema:path:**/*.sql",
        "schema:path:docs/migration-drafts/**",
        "provider_dispatch:path:**/*provider*{,/**}",
        "definer:sql:security definer"
      ]
    },
    {
      "path": "docs/release/ovd-206-window-kit.md",
      "status": "modified",
      "classes": [],
      "category": "docs",
      "reasons": [
        "docs:path:docs/**"
      ]
    },
    {
      "path": "docs/workflows/geomiq-live-readiness.md",
      "status": "modified",
      "classes": [],
      "category": "docs",
      "reasons": [
        "docs:path:docs/**"
      ]
    },
    {
      "path": "docs/workflows/ovd678-rmfg-live-readiness.md",
      "status": "modified",
      "classes": [],
      "category": "docs",
      "reasons": [
        "docs:path:docs/**"
      ]
    },
    {
      "path": "e2e/admin-operations.spec.ts",
      "status": "modified",
      "classes": [],
      "category": "tests",
      "reasons": [
        "tests:path:e2e/**"
      ]
    },
    {
      "path": "e2e/admin-operations.vite.config.ts",
      "status": "modified",
      "classes": [],
      "category": "tests",
      "reasons": [
        "tests:path:e2e/**"
      ]
    },
    {
      "path": "src/components/admin/ProviderKillSwitchCard.test.tsx",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    },
    {
      "path": "src/components/admin/ProviderKillSwitchCard.tsx",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    },
    {
      "path": "src/features/quotes/api/provider-kill-switch-api.test.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    },
    {
      "path": "src/features/quotes/api/provider-kill-switch-api.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    },
    {
      "path": "src/features/quotes/provider-fanout.test.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    },
    {
      "path": "src/features/quotes/provider-fanout.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    },
    {
      "path": "supabase/tests/pending/ovd829_provider_settings.sql.pending",
      "status": "added",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    },
    {
      "path": "worker/.env.example",
      "status": "modified",
      "classes": [
        "secrets"
      ],
      "category": null,
      "reasons": [
        "secrets:path:**/.env*"
      ]
    },
    {
      "path": "worker/src/adapters/rmfg.test.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:worker/src/adapters/**",
        "provider_dispatch:path:**/*adapter*{,/**}"
      ]
    },
    {
      "path": "worker/src/adapters/rmfg.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:worker/src/adapters/**",
        "provider_dispatch:path:**/*adapter*{,/**}"
      ]
    },
    {
      "path": "worker/src/adapters/rmfgHttpTransport.test.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:worker/src/adapters/**",
        "provider_dispatch:path:**/*adapter*{,/**}"
      ]
    },
    {
      "path": "worker/src/adapters/rmfgHttpTransport.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:worker/src/adapters/**",
        "provider_dispatch:path:**/*adapter*{,/**}"
      ]
    },
    {
      "path": "worker/src/adapters/weergProductionPortal.test.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:worker/src/adapters/**",
        "provider_dispatch:path:**/*adapter*{,/**}"
      ]
    },
    {
      "path": "worker/src/config.ts",
      "status": "modified",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "worker/src/dispatchRouting.test.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*dispatch*{,/**}"
      ]
    },
    {
      "path": "worker/src/dispatchRouting.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*dispatch*{,/**}"
      ]
    },
    {
      "path": "worker/src/fictivDispatchBinding.test.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*dispatch*{,/**}"
      ]
    },
    {
      "path": "worker/src/fixtureHeal/fixtureHeal.handler.test.ts",
      "status": "modified",
      "classes": [],
      "category": "tests",
      "reasons": [
        "tests:path:**/*.test.{ts,tsx,mjs}"
      ]
    },
    {
      "path": "worker/src/index.ts",
      "status": "modified",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "worker/src/jev/operationalTask.test.ts",
      "status": "modified",
      "classes": [],
      "category": "tests",
      "reasons": [
        "tests:path:**/*.test.{ts,tsx,mjs}"
      ]
    },
    {
      "path": "worker/src/providerKillSwitch.genericRoute.test.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    },
    {
      "path": "worker/src/providerKillSwitch.handler.test.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    },
    {
      "path": "worker/src/providerKillSwitch.test.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    },
    {
      "path": "worker/src/providerKillSwitch.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    },
    {
      "path": "worker/src/providerSettings.test.ts",
      "status": "added",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    },
    {
      "path": "worker/src/providerSettings.ts",
      "status": "added",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    },
    {
      "path": "worker/src/providerTaskPipeline.ts",
      "status": "modified",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    },
    {
      "path": "worker/src/tools/operatorKillSwitchGate.test.ts",
      "status": "modified",
      "classes": [],
      "category": "tests",
      "reasons": [
        "tests:path:**/*.test.{ts,tsx,mjs}"
      ]
    },
    {
      "path": "worker/src/tools/operatorKillSwitchGate.ts",
      "status": "modified",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "worker/src/tools/vendorWorkflowSmoke.ts",
      "status": "modified",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "worker/src/tools/xometryQuantitySweep.ts",
      "status": "modified",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "worker/src/types.ts",
      "status": "modified",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    },
    {
      "path": "worker/test-support/providerDispatchReservation.ts",
      "status": "added",
      "classes": [
        "provider_dispatch"
      ],
      "category": null,
      "reasons": [
        "provider_dispatch:path:**/*dispatch*{,/**}",
        "provider_dispatch:path:**/*provider*{,/**}"
      ]
    }
  ],
  "unclassified": [
    "worker/src/config.ts",
    "worker/src/index.ts",
    "worker/src/tools/operatorKillSwitchGate.ts",
    "worker/src/tools/vendorWorkflowSmoke.ts",
    "worker/src/tools/xometryQuantitySweep.ts",
    "worker/src/types.ts"
  ],
  "errors": [],
  "gate_loosening": {
    "detected": false,
    "reasons": [],
    "requires": [
      "grokbot_countersign",
      "blaine_card"
    ]
  }
}
```

</details>

Command: node scripts/sensitive-class-detect.mjs --repo optomachina/Overdrafter --pr 794 --head-sha b283d73e9d2d173da287b8c3968880eb556cb035 --json sc-794.json

```text
version: 2, status: ok
classes: [schema, auth, infra_ci, rls, definer, unclassified]
multi_class: true
sensitive: 17 of 17 files; unclassified (sensitive): 1
gate_loosening.detected: false
```

<details><summary>#794 JSON (sc-794.json)</summary>

```json
{
  "version": 2,
  "sha": "b283d73e9d2d173da287b8c3968880eb556cb035",
  "base_sha": "ad3476c3d907b94f077189c7344c8a863edbc125",
  "status": "ok",
  "classes": [
    "schema",
    "auth",
    "infra_ci",
    "rls",
    "definer",
    "unclassified"
  ],
  "sensitive_count": 17,
  "multi_class": true,
  "files": [
    {
      "path": ".github/workflows/ovd831-pending-pgtap.yml",
      "status": "added",
      "classes": [
        "infra_ci"
      ],
      "category": null,
      "reasons": [
        "infra_ci:path:.github/workflows/**"
      ]
    },
    {
      "path": "docs/migration-drafts/ovd-831-agent-api-keys.rollback.sql",
      "status": "added",
      "classes": [
        "schema"
      ],
      "category": null,
      "reasons": [
        "schema:path:**/*.sql",
        "schema:path:docs/migration-drafts/**"
      ]
    },
    {
      "path": "docs/migration-drafts/ovd-831-agent-api-keys.sql",
      "status": "added",
      "classes": [
        "schema",
        "rls",
        "definer"
      ],
      "category": null,
      "reasons": [
        "schema:path:**/*.sql",
        "schema:path:docs/migration-drafts/**",
        "rls:sql:create policy",
        "rls:sql:row level security",
        "definer:sql:security definer"
      ]
    },
    {
      "path": "docs/migration-drafts/ovd-831-fixture.sh",
      "status": "added",
      "classes": [
        "schema"
      ],
      "category": null,
      "reasons": [
        "schema:path:docs/migration-drafts/**"
      ]
    },
    {
      "path": "docs/migration-drafts/ovd-831-notes.md",
      "status": "added",
      "classes": [
        "schema"
      ],
      "category": null,
      "reasons": [
        "schema:path:docs/migration-drafts/**"
      ]
    },
    {
      "path": "server/agent-auth/api-key.test.ts",
      "status": "added",
      "classes": [
        "auth"
      ],
      "category": null,
      "reasons": [
        "auth:path:**/*auth*{,/**}"
      ]
    },
    {
      "path": "server/agent-auth/api-key.ts",
      "status": "added",
      "classes": [
        "auth"
      ],
      "category": null,
      "reasons": [
        "auth:path:**/*auth*{,/**}"
      ]
    },
    {
      "path": "server/agent-auth/in-memory-repository.ts",
      "status": "added",
      "classes": [
        "auth"
      ],
      "category": null,
      "reasons": [
        "auth:path:**/*auth*{,/**}"
      ]
    },
    {
      "path": "server/agent-auth/journey.test.ts",
      "status": "added",
      "classes": [
        "auth"
      ],
      "category": null,
      "reasons": [
        "auth:path:**/*auth*{,/**}"
      ]
    },
    {
      "path": "server/agent-auth/redaction.test.ts",
      "status": "added",
      "classes": [
        "auth"
      ],
      "category": null,
      "reasons": [
        "auth:path:**/*auth*{,/**}"
      ]
    },
    {
      "path": "server/agent-auth/redaction.ts",
      "status": "added",
      "classes": [
        "auth"
      ],
      "category": null,
      "reasons": [
        "auth:path:**/*auth*{,/**}"
      ]
    },
    {
      "path": "server/agent-auth/repository.ts",
      "status": "added",
      "classes": [
        "auth"
      ],
      "category": null,
      "reasons": [
        "auth:path:**/*auth*{,/**}"
      ]
    },
    {
      "path": "server/agent-auth/supabase-repository.test.ts",
      "status": "added",
      "classes": [
        "auth"
      ],
      "category": null,
      "reasons": [
        "auth:path:**/*auth*{,/**}"
      ]
    },
    {
      "path": "server/agent-auth/supabase-repository.ts",
      "status": "added",
      "classes": [
        "auth"
      ],
      "category": null,
      "reasons": [
        "auth:path:**/*auth*{,/**}"
      ]
    },
    {
      "path": "server/agent-auth/verifier.test.ts",
      "status": "added",
      "classes": [
        "auth"
      ],
      "category": null,
      "reasons": [
        "auth:path:**/*auth*{,/**}"
      ]
    },
    {
      "path": "server/agent-auth/verifier.ts",
      "status": "added",
      "classes": [
        "auth"
      ],
      "category": null,
      "reasons": [
        "auth:path:**/*auth*{,/**}"
      ]
    },
    {
      "path": "supabase/tests/pending/ovd831_agent_api_keys.sql.pending",
      "status": "added",
      "classes": [
        "unclassified"
      ],
      "category": null,
      "reasons": [
        "unclassified:no-safe-category"
      ]
    }
  ],
  "unclassified": [
    "supabase/tests/pending/ovd831_agent_api_keys.sql.pending"
  ],
  "errors": [],
  "gate_loosening": {
    "detected": false,
    "reasons": [],
    "requires": [
      "grokbot_countersign",
      "blaine_card"
    ]
  }
}
```

</details>

#792 and #794 have no `migrations` class. Their SQL lives under `docs/migration-drafts/**`, which the shared list classes as `schema`, where v1 called it `migration`.

## Review findings and coverage

- **Final PR head SHA:** 91f1b7e2 (full SHA in the Repair round 3 section)
- **Final round (Release):** gaps filled on top of c8a6965a (see "Final round" above). Round-3 reviews and QA did not run on c8a6965a; the Opus, Codex and Sonnet reviews below are at the final head.
- **Reviews @ 6e96e47c (Codex, Opus, Sonnet: changes required). Blockers and what changed:**
  - Provider admission and upload names with punctuation next to the separator lost sensitivity, and the body said only rls names did (all three). The coverage sweep now generates every character in every position against a frozen copy of 0163daf7's rules and fails on any loss outside the residual. It found three coverable classes, closed with `**/*provider*/**/*{admission,upload}*{,/**}`, `**/*,rls*{,/**}` and `**/*chec?out*{,/**}`; every example the reviews named has a test row.
  - The rls residual was stated inexactly (all three). The body, the schema table, the risk note and the detector header now state the exact rule, and the residual table is the sweep's own output.
  - WORKFLOW.md and `scripts/symphony-ensure-branch.sh` came out auto-merge safe (Opus). Both are `infra_ci`, with Codex and Claude configuration, MCP servers and git hooks; the walk starts from WORKFLOW.md; a test requires every file `validate-agent-contract` reads to be `infra_ci`.
  - The workflow left an unreadable result to upload (Codex). The unreadable branch runs `rm -f "$out"`, with a test row.
- **Non-blocking @ 6e96e47c, done here:**
  - the vite plugins `vite.config.ts` imports (Codex #3, Sonnet): `scripts/vite-*` is `infra_ci` and the walk follows root tool-config imports;
  - `.claude/settings*`, `.mcp.json`, `.claude/rules/**`, `.codex/config*`, `.claude/launch.json` listed explicitly (Codex #1, Opus);
  - the round-2 breakdown of the 71 newly sensitive files, which miscounted (Codex), is dropped; this round's 10 files are listed exactly above.
- **Non-blocking @ 6e96e47c, still open:**
  - `addScriptRefs` and `addImports` record nothing when a reference matches no file, so a stale `scripts/` reference passes silently (Codex #4).
  - An unparseable or invalid head config gives `status: ok` with `gate_loosening.detected: true`, and an unknown status (`bogus`, `" "`) gives `status: ok` (Codex #5, #6; adjudicated not defects at f786b942, code unchanged).
  - `scripts/preflight.sh` is `infra_ci` but not `gate_loosening`, since it is not part of the detection gate (Codex #7, not a defect).
  - `worker/src/tools/extractEvalGate.ts` (run by `npm --prefix worker run eval:gate`) is outside `scripts/` and unclassified, so it fails closed (Sonnet).
  - `.agents/skills/**` stays unclassified, and `docs/agent-development-control-plane.md` stays `docs`; whether either belongs in a sensitive class is a policy question (Codex #1, Opus).
- **Still open from earlier rounds:**
  - The PR is read once and its files are paged with no re-check of head and base afterwards. Duplicate filenames and a null sha are not errors. The artifact is not a trusted gate: OVD-845 must recompute it or verify the run's head SHA.
  - Some gate inputs under `docs/**` count as safe docs, for example `docs/release/ovd-510-prechange-compatibility-manifest.json`. This was the same at 0163daf7.
  - No test checks that `safe_categories` matches the AGENTS.md auto-merge category text.
  - API fetches have no timeout.
  - Only the detect step never fails the job. Checkout, setup-node, upload or the timeout can still turn it red. It is not a required check.
  - The OVD-844 Linear description still shows the v1 schema; OVD-845 should point at the v2 mapping above. This PR does not edit Linear.
  - Brace-expansion cost in head globs. It still fails closed, and the step writes ERROR instead of going red.
  - Concatenated or escaped dynamic SQL is not detected by the token match. Every `.sql`, `.pgsql` and `.psql` file is `schema` by path regardless.
  - The rls residual above.
  - Repo-wide OVD-885 and OVD-887 are out of scope.
- **Carried over, non-blocking, now OVD-845's contract:**
  - treat a missing artifact as needs-Blaine;
  - accept the `requires` field;
  - check `base_sha` against the current base;
  - recompute in a trusted context, or confirm the PR touches no `.github/**` file.
- **Sonar and CodeRabbit:** at 3f532948 SonarCloud failed the reliability gate on one bug, a bare `.sort()` in the sweep (S2871); c8a6965a gives it a comparator and fixes four of the sweep's eight code smells (nested ternary, `runSweep` complexity, `fromCharCode`, optional chain); three of the other four are in the frozen 0163daf7 matcher, which stays as copied, and one is a minor `String.raw` suggestion. c8a6965a was not yet analysed when this was written. CodeRabbit skips drafts.
- [ ] Inspected findings and threads on the final head

🤖 Generated with [Claude Code](https://claude.com/claude-code)


