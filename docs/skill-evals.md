# Skill evals

Repo skills are tested like code: each skill has a spec of tasks, expected behaviors and a 0-10 rubric. A model runs the tasks, and a judge from a different model scores them. This is the OVD-860 deliverable under the pstack auto-merge epic (OVD-840).

## Where things live

- Skills: `.agents/skills/*`, `.codex/skills/*`, plus `.claude/skills/*` and `.cursor/skills/*` when present. In a git checkout only git-tracked skill directories count, so locally installed third-party skills (these roots are gitignored) are ignored. A skill name lives in exactly one root: `validate` rejects a name found in two roots, because a score for one copy says nothing about the other. `verify-overdrafter` lives at `.agents/skills/verify-overdrafter/` (OVD-842, merged in #801).
- Specs: `evals/skills/<skill>/spec.json`, one per skill. Each case has `id`, `task`, `expectedBehaviors[]` and `rubric[]` (`{id, criterion, points}`, integer points summing to exactly 10). `passScore` is 10.
- Tooling: `scripts/skill-evals.mjs` (offline, no model API calls). Tests: `scripts/skill-evals.test.mjs`.

## The loop

1. **Run (model A).** For each case in scope, give the runner model the skill and the case `task`, in a clean session, and capture its output.
2. **Judge (model B).** A different model gets the case, its `expectedBehaviors` and `rubric`, plus the runner output. It scores each rubric item from 0 to that item's `points` and writes a result: `{ "skill", "case", "skillHash", "runner", "judge", "scores": [{ "id", "points" }] }`. `skillHash` comes from `hash <skill>`, taken when the runner ran. Run `check-judge` first, because judge and runner must be different models. Record canonical model ids (for example `claude-opus-5-5`, not an alias). The check also strips provider and region prefixes (`anthropic/`, `us.anthropic.`), `-latest`, dated snapshots, and Vertex `@date` and Bedrock `-v1:0` suffixes, so two aliases of one model are rejected. It cannot catch unrelated nicknames.
3. **Aggregate.** `report` totals the scores. A case passes only at 10/10. For a per-skill re-run, scope it with `--skill <name>` (repeatable, or a comma list) so skills you did not re-run are not reported as `unscored`.
4. **Loop.** For any case below 10, fix the skill (or the spec if the rubric was wrong), then re-run and re-judge. Stop at 10/10 everywhere, or stop after a bounded number of rounds and attach the report with the remaining gaps. Never lower a rubric or edit a score to get green.

## Re-run trigger

Re-run a skill's evals on any change under its skill directory, or under `evals/skills/<skill>/`. List them for a range:

```bash
node scripts/skill-evals.mjs changed --base origin/main --head HEAD
```

It prints one skill name per line (empty when nothing changed). A deleted skill is listed too, so its spec can be retired. A renamed skill lists both the old and the new name. Loose files directly under a skill root (such as a README) belong to no skill and are not listed. File names with non-ASCII or special characters (accents, tabs, newlines, quotes) are handled, so a change to such a file still lists its skill. `changed` only compares commits (`base...head`). It does not see staged, unstaged or untracked edits, so commit before trusting the list, empty or not. Feed the list to the loop and to `report --skill`:

```bash
skills=$(node scripts/skill-evals.mjs changed --base origin/main --head HEAD | paste -sd, -)
node scripts/skill-evals.mjs report --skill "$skills" scores/*.json
```

If the list includes a skill whose directory and spec were both removed (a retirement), drop that name first: `report --skill` exits 2 for a name with no spec.

When no skill changed, `$skills` is empty and `report --skill ""` prints "no skills changed" and exits 0. This is the one case where `report` passes with nothing scored, so its output says `Overall: nothing to re-score`, never `PASS`. It reads no scores files, so a missing `scores/` directory is fine. It still runs the `validate` checks, so a broken repo fails it with exit 1. Only the exact empty string `""` means "none changed". A blank value (only spaces, a tab or a newline), a bare `--skill`, or a list with an empty entry such as `a,,b` exits 2. Keep the quotes around `"$skills"`: unquoted, an empty list would swallow the next argument as a skill name.

Because `changed` cannot see uncommitted work, `report --skill ""` in a git checkout also exits 1 with "uncommitted skill changes; commit first", and lists each path, when it finds any of these under a skill root or `evals/skills`:

- anything `git status` reports there: a staged, unstaged, deleted or renamed change, or an untracked file that is not gitignored;
- an untracked file other than `.DS_Store` under `evals/skills`, gitignored or not;
- an untracked file other than `.DS_Store`, or a wholly untracked directory holding one, under a skill root that holds a tracked file, gitignored or not. Here those are `.agents/skills` and `.codex/skills`.

A wholly untracked directory is listed once as `dir/`. If its files are not gitignored, `git status` reports them too and they are listed as well. A new spec directory under `evals/skills` is listed that way here.

Plain `git status` never lists an untracked file that git ignores. This repo gitignores `.agents/`, `.codex/` and `skills/`, so `git status` misses a new file in `.agents/skills` or `.codex/skills`. `evals/skills` is not ignored here (`!evals/skills/`), but it is listed directly all the same, so a later ignore rule covering `evals/` would not hide a new spec. These files are listed directly with `git ls-files --others`, ignored or not. A new file under a skill root that holds a tracked file or under `evals/skills`, or a new skill dir there, counts as uncommitted skill work until you commit it (`git add -f` first where the path is gitignored, as under `.agents/skills` and `.codex/skills` here). Three things are left alone: gitignored files in a skill root with no tracked file (here `.claude/skills` and `.cursor/skills`, where third-party skills are installed locally), anything outside the skill roots and `evals/skills` (such as `.codex/config.toml`), and `.DS_Store` files and empty directories. The untracked listing skips `.DS_Store` and empty directories, `git status` never lists an empty directory, and this repo gitignores `.DS_Store`. The check cannot tell a third-party skill installed under `.agents/skills` or `.codex/skills` from a new skill of your own, so it fails on one too. Run `report --skill ""` from a clean checkout or worktree, where only tracked files exist.

The `skillHash` enforces the trigger. `report` only counts results whose `skillHash` matches the current skill directory plus spec. Older results show as `stale` and fail, so a score cannot outlive the skill version it judged.

## Commands

```bash
node scripts/skill-evals.mjs validate                  # specs are well formed; each skill has one root and a spec; each spec has its skill
node scripts/skill-evals.mjs check-judge --runner <model-a> --judge <model-b>
node scripts/skill-evals.mjs hash <skill>...            # skillHash to put on each judge result
node scripts/skill-evals.mjs report [--skill <name>]... scores/*.json   # markdown; add --json for JSON
```

`check-judge` exits 2 when either flag is missing, empty or whitespace, or has no value (for example `--runner $A` with `A` unset).

`report` accepts files that hold one result or an array. A result that is not an object with string `skill` and `case` fields stops the run (exit 2) and names its file and index. Among the results with the current `skillHash`, the last one for a case (in argument order) wins, so a re-run replaces earlier attempts. Results for an older `skillHash` are ignored. `report` exits 0 only when `validate` passes, at least one skill is in scope, and every in-scope case is 10/10. The one exception is `--skill ""` (nothing changed), which exits 0 with nothing scored when `validate` passes and the uncommitted-changes check above finds nothing. Otherwise it exits 1.

- `report` runs the same checks as `validate` first, scoped or not. A present skill with no spec, a spec with no skill directory, a skill name in two roots, or a malformed spec fails the report and lists the errors.
- A report with nothing in scope fails, so it never passes with nothing scored. The one exception is `--skill ""` (nothing changed), which exits 0 with "nothing to re-score" and no case scored.
- A case with no result is `unscored`, and it fails. A case whose results all carry an older `skillHash` is `stale`, and it fails.
- Missing, unknown, duplicated or out-of-range scores mark the case `invalid`. A judge that is the same base model as the runner also marks the case `invalid`.
- `--skill` with an unknown name, with no value, or with a blank value (only spaces, a tab or a newline) exits 2.

`--json` prints the same report as an object. A scored report is `{ "ok", "skills": [...] }`, with `reason` added when nothing was in scope. A report that fails before scoring (validation errors, or uncommitted changes) is `{ "ok": false, "reason", "errors": [...], "skills": [] }`, where uncommitted changes appear as `uncommitted: <path>` entries. The nothing-changed report is:

```json
{ "ok": true, "nothingToRescore": true, "reason": "no skills changed, so there is nothing to re-score", "skills": [] }
```

`ok` is `true` there although no case was scored. `nothingToRescore` is present only on this report, so a consumer must check it before reading `ok: true` as a scored pass.

## Adding or changing a skill

Add `evals/skills/<skill>/spec.json` in the same change. `validate` fails for a present skill with no spec. To retire a skill, remove its spec in the same change, because `validate` also fails for a spec whose skill is gone. CI enforces both rules (see the next section). A skill whose files are deleted from the working tree but not yet staged counts as gone. Write cases that probe the skill's rules, such as refusals and guardrails, and not just the happy path.

## What CI enforces

The repo's vitest suite runs in the CI `unit` job (three shards), which the required `ci` check depends on. `scripts/skill-evals.test.mjs` includes a "committed specs" test that runs `validate` against the real repo. So the rules above are CI-enforced: a PR fails CI if it adds a tracked skill without a spec, retires a skill but leaves its spec, uses one skill name in two roots, or breaks a spec. CI does not run the model loop or check any scores.

## Not in scope

The scripts never call a model. Running and judging is done by the operator or agent harness. No CI workflow runs the evals or this CLI. Running `validate` as its own workflow step would be a separate, workflow-touching change.
