# Create checklist (for the orchestrator, after review)

Ordered, copy-paste exact. Nothing here has been run. Steps marked **[HUMAN SECRET]**
need a value only the owner can produce; no agent can create or paste them.
Replace `<REPO_ROOT>` with the OverDrafter checkout that contains `tools/homepage-studio/`.

## A. Private data repo (gh)

1. Create it (private, with a README so the `main` branch exists):
   `gh repo create optomachina/homepage-studio-data --private --add-readme --description "Homepage Studio data (versions, jobs)"`
2. Clone and seed it:
   ```
   git clone https://github.com/optomachina/homepage-studio-data.git /tmp/hsd && cd /tmp/hsd
   node <REPO_ROOT>/tools/homepage-studio/scripts/seed.mjs --dir /tmp/hsd --with-baselines
   mkdir -p .github/workflows studio/hosted
   cp <REPO_ROOT>/tools/homepage-studio/hosted/studio-generate.yml.template .github/workflows/studio-generate.yml
   cp <REPO_ROOT>/tools/homepage-studio/hosted/worker.mjs <REPO_ROOT>/tools/homepage-studio/hosted/fetch-skill.mjs studio/hosted/
   cp -R <REPO_ROOT>/tools/homepage-studio/lib studio/lib
   cp <REPO_ROOT>/tools/homepage-studio/studio.config.json studio/studio.config.json
   git add -A && git commit -m "studio: initial data, worker and workflow" && git push origin main
   ```
   Files that go in: `project.json`, `baselines/v6..v9/index.html` (from the seed script), `.github/workflows/studio-generate.yml`,
   `studio/hosted/{worker,fetch-skill}.mjs`, `studio/lib/**`, `studio/studio.config.json`. `data/seed.json` is not needed in the data repo.
3. **[HUMAN SECRET]** Model credential. On the owner's Mac: `claude setup-token`, copy the token it prints, then on GitHub
   (iPad is fine): data repo > Settings > Secrets and variables > Actions > New repository secret, name `CLAUDE_CODE_OAUTH_TOKEN`.
   Alternative: secret `ANTHROPIC_API_KEY`. Do not paste either into chat.
4. **[HUMAN SECRET]** Fine-grained token for the studio: GitHub > Settings > Developer settings > Fine-grained tokens >
   Only select repositories: `homepage-studio-data`; Repository permissions: Contents = Read and write, Actions = Read and write,
   Metadata = Read. Copy it once; it is needed in step B3.
5. Confirm the workflow is listed: `gh workflow list --repo optomachina/homepage-studio-data` (shows `studio-generate`).

## B. Separate Vercel project (vercel CLI or dashboard)

1. From `<REPO_ROOT>/tools/homepage-studio`: `vercel link --yes --project homepage-studio` (creates a NEW project; do not link to the main OverDrafter project).
2. Settings: Framework Preset `Other`; Root Directory `tools/homepage-studio`; no build command. (`vercel.json` already sets `outputDirectory: ui`.)
3. Environment variables (names only; Production scope), set with `vercel env add <NAME> production`:
   - `STUDIO_HOSTED` (value `1`)
   - `STUDIO_PASSWORD` **[HUMAN SECRET]**
   - `STUDIO_SESSION_SECRET` **[HUMAN SECRET]** (random, 32+ characters; `openssl rand -base64 32`)
   - `GITHUB_TOKEN` **[HUMAN SECRET]** (the fine-grained token from A4)
   - `STUDIO_DATA_REPO` (value `optomachina/homepage-studio-data`)
   - `STUDIO_DATA_BRANCH` (optional, default `main`)
4. Enable Vercel Authentication (Project > Settings > Deployment Protection > Vercel Authentication, all deployments).
5. Deploy: `vercel deploy --prod` from `tools/homepage-studio` (a deployment spends Vercel quota: needs the owner's OK).

## C. First-run checks

`GET /api/me` returns `configured: true`; log in with the password; the page shows no "Temporary storage" banner; Generate with the
demo engine and confirm a commit "studio: generated ..." appears in the data repo; then Generate with the GitHub Actions worker and
watch the run in the Actions tab.
