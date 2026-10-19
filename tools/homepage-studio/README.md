# Homepage Studio (Phase 1)

A small web app for iterating on the OverDrafter homepage prototypes: edit and version copy, generate
assets and keep every older one, switch the generation tool and engine, toggle dark mode. It runs
locally (`node`) and can run hosted (see `HOSTING.md`) from the same code. It never writes to `public/` or `src/`.

Zero npm dependencies: Node 20+ standard library, vanilla HTML/CSS/JS.

## Run it locally

```
node tools/homepage-studio/server.mjs        # http://127.0.0.1:5177 (PORT=... to change)
node --test tools/homepage-studio            # tests
```

The server binds `127.0.0.1` only and rejects any request whose Host or Origin is not loopback. On first start it
creates `data/project.json` from `data/seed.json` (copy seeded from `public/v9/index.html`). To re-seed without losing
versions: `node tools/homepage-studio/scripts/seed.mjs`.

## Page mode (default) and Outline view

`/` opens **Page mode**: a slim top bar (baseline page v6 to v9, tool, engine, Interact, dark/light, History, save status, Outline view link,
Log out when hosted) and the chosen baseline page (default v9) full width in one sandboxed iframe. Tap any text to edit it in place
(Save, Cancel, copy history, regenerate; the copy lint runs before every save and blocks errors inline). Each figure gets a version-history
and a regenerate icon in its top-right corner; a generated figure replaces the built-in one live. History, figure versions and generate open
as a right drawer (wide) or bottom sheet (narrow or touch). **Interact** switches editing off so the page's own prompt bar, panels and
chapters work. The Outline view (`/outline.html`, the panel UI described below) stays as the secondary bulk-editing view.

How it works: the API injects `ui/page-editor.js` (plus `lib/field-match.mjs` and `lib/page-protocol.mjs`) into BASELINE previews only
(`?editor=0` opts out; generated assets are never instrumented). The page runs with `sandbox="allow-scripts"` and no same-origin, so it
talks to the shell only by postMessage: the shell checks `event.source` is the iframe and `event.origin` is `"null"` and validates every
message against a strict schema; the page checks the sender is its parent at the one origin it was told at load. Field matching runs in
the live DOM after the page renders: texts are normalised (case, typography, whitespace), matched to the element whose own text equals the
field text, disambiguated by section region and document order; the hero lockup is read from its three lines; example prompts are matched
against the page's own `PROMPTS` data. Older saved texts are tried too, so saved wording is re-applied after the page re-renders. Fields
that cannot be found are listed in History as "not editable in place yet: edit in Outline view". Limits: all 52 v9 fields match; older
baselines (v6 to v8) have fewer matching fields; the roadmap "Coming soon" panel keeps the original example prompt until reload; the lockup's
muted third line colour follows line position, not meaning; generated figures are passed to the page as `srcdoc` (the page cannot fetch).

## What is in the Outline view

- Left rail (a section picker on narrow screens): Hero, Chapter 1 to 7, Mission, Roadmap, Final CTA.
- Center: sandboxed preview (`sandbox="allow-scripts"`, no same-origin) of the selected asset version, or the baseline page (v6 to v9).
- Right: **Copy** (edit, note, live copy lint, version timeline, word diff, restore as new version, star, regenerate from an instruction) and **Generate asset** (engine, model, prompt, job status, tool status).
- Every asset with versions shows a 44px **Version history** button in the preview's top-right corner. The drawer lists all versions newest first with a live mini preview, prompt, engine/tool/model receipt, time and note; actions: Preview, Restore (creates a NEW version pointing at the old one), Star, Compare (side by side), Use prompt.
- Top bar: asset tool dropdown, baseline page, dark mode switch (studio chrome and preview; default dark, saved in localStorage, honors prefers-color-scheme on first load).
- Export current copy (`copy.json`) and Copy as handoff note (markdown with current copy and asset version ids).

## Config and tools

`studio.config.json` lists the tools: id, label, description, "good for", the local skill folder (`skillPath`) and a pinned
`source` for the hosted worker. Third-party skill code is NOT vendored here. Copy each reference folder to
`~/.homepage-studio/skills/<tool>/` (so `~/.homepage-studio/skills/anatomy/SKILL.md` exists). Tool ids: `anatomy`,
`anatomy-asset`, `isoglow`, `machine`. A tool whose folder is missing is shown as "(unavailable)" with a specific message
and jobs for it are BLOCKED, never silently skipped.

## Generation

Engines: `claude-cli` (local: `claude -p --no-session-persistence --output-format json --model <sonnet|opus>
--allowedTools "Read,Write,Edit,Glob,Grep" --add-dir <skill folder>`, cwd = `data/versions/<section>/<versionId>/`, 20 minute
hard timeout, process tree killed on cancel, receipt = `modelUsage`), `template-demo` (offline, deterministic, every
version labelled "demo engine, not generated by a model"), `github-actions` (hosted only, queues a worker job).

Check login yourself with `claude auth status`; log in with `claude auth login` (the studio never logs in for you). If the CLI is
missing or logged out the job is BLOCKED with "Claude CLI is not logged in: run `claude auth login`" and nothing is fabricated;
use **Retry with demo engine** to continue with a clearly labelled placeholder.

Job states: queued, running, succeeded, failed, blocked, cancelled, timed_out, each with a recovery action. Failed,
timed out and cancelled jobs still add a version record of kind `failed` with the log. Output is checked against the asset
contract (self-contained, no network, both themes, reduced motion) and rejected otherwise.

## Copy lint

`lib/lint.mjs` (rules as data). Errors block saving and generated candidates: dates or years 2026 to 2039, Q1 to Q4, "next year",
"next"/"later" as timing, percentages other than the mission's exact 10% sentence, third-party names, a bare "Live",
"Coming soon" on a live capability, claiming a planned capability exists, a changed closing statement. Warnings can be saved with
"Save anyway": sentences over 25 words, "soon" outside "Coming soon", superlatives.

## Data layout (`data/`, gitignored except `seed.json`)

`project.json` (sections, copy fields and assets with append-only version arrays and a `currentVersionId` pointer, plus star marks),
`jobs/<id>.json`, `versions/<section>/<versionId>/index.html` and `job.log`, optional `baselines/vN/index.html`. Writes are atomic
(temp + rename), serialized in one in-process queue, schema-validated, and checked to be append-only.

## Safety notes

Loopback only and same-origin checks locally; ids are `/^[a-z0-9-]+$/` and all paths stay inside the data directory; 1 MB body cap;
previews are served with their own strict CSP (`sandbox allow-scripts`, no network). Hosted adds password login with a signed
HttpOnly cookie and fails closed when unconfigured.

## End-to-end tests

`npx playwright test -c tools/homepage-studio/e2e/playwright.config.mjs` from the repo root runs a real-browser suite against the studio (local and
hosted-with-fake-GitHub) and the prototype pages. See `e2e/README.md` for projects, isolation and what is not covered.

## Not built / not verified

No real GitHub, Vercel or model call has been made (all covered by fakes). Touch behavior was checked at iPad and phone widths with CDP touch emulation in desktop Chromium, not on a device (soft keyboard and
Safari-specific contenteditable behavior are unverified).
