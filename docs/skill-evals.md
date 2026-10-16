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

It prints one skill name per line (empty when nothing changed). A deleted skill is listed too, so its spec can be retired. A renamed skill lists both the old and the new name. Loose files directly under a skill root (such as a README) belong to no skill and are not listed. Feed the list to the loop and to `report --skill`:

```bash
skills=$(node scripts/skill-evals.mjs changed --base origin/main --head HEAD | paste -sd, -)
node scripts/skill-evals.mjs report --skill "$skills" scores/*.json
```

If the list includes a skill whose directory and spec were both removed (a retirement), drop that name first: `report --skill` exits 2 for a name with no spec.

The `skillHash` enforces the trigger. `report` only counts results whose `skillHash` matches the current skill directory plus spec. Older results show as `stale` and fail, so a score cannot outlive the skill version it judged.

## Commands

```bash
node scripts/skill-evals.mjs validate                  # specs are well formed; each skill has one root and a spec; each spec has its skill
node scripts/skill-evals.mjs check-judge --runner <model-a> --judge <model-b>
node scripts/skill-evals.mjs hash <skill>...            # skillHash to put on each judge result
node scripts/skill-evals.mjs report [--skill <name>]... scores/*.json   # markdown; add --json for JSON
```

`check-judge` exits 2 when either flag is missing, empty or whitespace, or has no value (for example `--runner $A` with `A` unset).

`report` accepts files that hold one result or an array. A result that is not an object with string `skill` and `case` fields stops the run (exit 2) and names its file and index. Among the results with the current `skillHash`, the last one for a case (in argument order) wins, so a re-run replaces earlier attempts. Results for an older `skillHash` are ignored. `report` exits 0 only when `validate` passes, at least one skill is in scope, and every in-scope case is 10/10. Otherwise it exits 1.

- `report` runs the same checks as `validate` first, scoped or not. A present skill with no spec, a spec with no skill directory, a skill name in two roots, or a malformed spec fails the report and lists the errors.
- A report with nothing in scope fails. It never passes with nothing scored.
- A case with no result is `unscored`, and it fails. A case whose results all carry an older `skillHash` is `stale`, and it fails.
- Missing, unknown, duplicated or out-of-range scores mark the case `invalid`. A judge that is the same base model as the runner also marks the case `invalid`.
- `--skill` with an unknown name, or with no value, exits 2.

## Adding or changing a skill

Add `evals/skills/<skill>/spec.json` in the same change. `validate` fails for a present skill with no spec. To retire a skill, remove its spec in the same change, because `validate` also fails for a spec whose skill is gone. Write cases that probe the skill's rules, such as refusals and guardrails, and not just the happy path.

## Not in scope

The scripts never call a model. Running and judging is done by the operator or agent harness. No CI workflow runs this yet; wiring `validate` into CI is a separate, workflow-touching change.
