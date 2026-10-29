# Vercel preview build policy

`vercel.json` sets `ignoreCommand` to `bash scripts/vercel-ignore-build.sh`.
Vercel's [Ignored Build Step](https://vercel.com/docs/project-configuration/project-settings#ignored-build-step)
runs before dependency installation: **exit 0 skips; exit 1 builds**.
The script uses Bash, curl, and Node, without npm packages or the GitHub CLI.

The decision order is:

1. Always build production deployments (`VERCEL_ENV=production`) and `main`
   (`VERCEL_GIT_COMMIT_REF=main`), without calling GitHub.
2. Build for environments other than `preview`, missing branch/repository metadata,
   unsupported Git providers, or unavailable lookup tools.
3. Query GitHub's [list pull requests API](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests)
   for `state=open` and `head=<owner>:<branch>`, URL encoding the query parameters.
   Use `VERCEL_GIT_REPO_OWNER` and `VERCEL_GIT_REPO_SLUG` for the repository.
4. Skip if no PR is open, or every matching open PR is a draft. A matching ready PR
   continues to the existing changed-file check: docs/tooling-only changes skip;
   app-affecting changes build. The previous-deployment/merge-base comparison and
   build-input exceptions remain in place.

GitHub uncertainty always builds, even for docs-only changes. This includes
timeouts (a 10-second total request limit), authentication/rate-limit/server
errors, malformed responses, missing draft flags, mismatched head branches or
repositories, and a full 100-result page that might omit another PR. The script
logs only a decision reason for the lookup, never token values, request headers,
branch metadata, or API response bodies.

For a private repository, the deployment environment must already supply a
`GITHUB_TOKEN` (or `GH_TOKEN` fallback) with read access to this repository's pull
requests. Fine-grained tokens need **Pull requests: read** permission. Without
usable authentication the lookup fails open and builds. Public repositories can
use unauthenticated requests, subject to GitHub's rate limit. Never use a
`VITE_`/public token variable or commit credentials. Credential provisioning is a
separate operator action; this change does not create or change credentials.
Vercel must expose its system environment variables to the ignore step; when
that setting is disabled, missing metadata builds instead of guessing.

The existing `git.deploymentEnabled` rules still disable `claude/**`, `codex/**`,
and `cursor/**` before the ignore step runs. For an agent preview, use another
branch prefix (for example `preview/`) and an open ready PR. After opening a PR
or marking a draft ready, trigger a new deployment (push a commit or redeploy);
this script checks state when Vercel invokes it and does not schedule builds.

Run the isolated script tests with:

```sh
npm test -- scripts/vercel-ignore-build.test.mjs
```

Tests invoke the real Bash entry point in disposable Git repositories with a fake
curl executable. They make no network requests and use only synthetic credentials.
They cover PR eligibility, main/production bypass, fail-open behavior, and the
existing changed-file rules. They also assert that `vercel.json` invokes the script.
