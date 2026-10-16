# Skill evals

Repo skills are tested like code: each skill has a spec of tasks, expected behaviors and a 0-10 rubric. A model runs the tasks, and a judge from a different model scores them. This is the OVD-860 deliverable under the pstack auto-merge epic (OVD-840).

## Where things live

- Skills: `.agents/skills/*`, `.codex/skills/*`, plus `.claude/skills/*` and `.cursor/skills/*` when present. `verify-overdrafter` is expected at `.cursor/skills/verify-overdrafter/` (OVD-842). Its spec ships here first and the tooling tolerates the skill being absent.
- Specs: `evals/skills/<skill>/spec.json`, one per skill. Each case has `id`, `task`, `expectedBehaviors[]` and `rubric[]` (`{id, criterion, points}`, integer points summing to exactly 10). `passScore` is 10.
- Tooling: `scripts/skill-evals.mjs` (offline, no model API calls). Tests: `scripts/skill-evals.test.mjs`.

## The loop

1. **Run (model A).** For each case in scope, give the runner model the skill and the case `task`, in a clean session, and capture its output.
2. **Judge (model B).** A different model gets the case, its `expectedBehaviors` and `rubric`, plus the runner output. It scores each rubric item from 0 to that item's `points` and writes a result: `{ "skill", "case", "runner", "judge", "scores": [{ "id", "points" }] }`. Run `check-judge` first, because judge and runner must differ.
3. **Aggregate.** `report` totals the scores. A case passes only at 10/10.
4. **Loop.** For any case below 10, fix the skill (or the spec if the rubric was wrong), then re-run and re-judge. Stop at 10/10 everywhere, or stop after a bounded number of rounds and attach the report with the remaining gaps. Never lower a rubric or edit a score to get green.

## Re-run trigger

Re-run a skill's evals on any change under its skill directory, or under `evals/skills/<skill>/`. List them for a range:

```bash
node scripts/skill-evals.mjs changed --base origin/main --head HEAD
```

It prints one skill name per line (empty when nothing changed). A deleted skill is listed too, so its spec can be retired.

## Commands

```bash
node scripts/skill-evals.mjs validate                  # specs are well formed; every present skill has one
node scripts/skill-evals.mjs check-judge --runner <model-a> --judge <model-b>
node scripts/skill-evals.mjs report scores/*.json      # markdown; add --json for JSON
```

`report` accepts files holding one result or an array. The latest result for a case wins, so a re-run replaces earlier attempts. It exits 1 unless every case is 10/10. Missing, unknown, duplicated or out-of-range scores mark the case `invalid`, and a judge equal to the runner (case-insensitive) is also invalid.

## Adding or changing a skill

Add `evals/skills/<skill>/spec.json` in the same change. `validate` fails for a present skill with no spec. Write cases that probe the skill's rules, such as refusals and guardrails, and not just the happy path.

## Not in scope

The scripts never call a model. Running and judging is done by the operator or agent harness. No CI workflow runs this yet; wiring `validate` into CI is a separate, workflow-touching change.
