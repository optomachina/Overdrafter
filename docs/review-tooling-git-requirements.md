# Review tooling git requirements

Last updated: October 16, 2026

Review tooling that fingerprints a diff with `git patch-id` only gives
reproducible results when local runs and CI use a compatible git and the same
attributes. This applies to the OVD-851 verdict tooling from PR #807
(`docs/verdict-format.md`, `scripts/emit-verdict.mjs`,
`scripts/verdict-schema.mjs`) once that PR is merged.

## Minimum git version: 2.39

`scripts/emit-verdict.mjs` computes `patch_id` as `git patch-id --verbatim`
over `git diff base...head`. The `--verbatim` option was added in git 2.39.
Older versions reject it as an unknown option, so the tool fails instead of
emitting a verdict. With `--verbatim`, whitespace is kept and the hash is
order-independent, so an indentation-only change produces a new patch-id.

Check your version:

```bash
git --version   # must report 2.39 or newer
```

Use the same git version locally and in CI. Git can change diff output between
releases (for example hunk selection or binary handling), which would change
patch-ids even for identical commits. When CI pins or upgrades its git, upgrade
local installs to match, and the reverse.

## .gitattributes affects patch-ids

The patch-id is a hash of the diff text, so anything that changes the diff text
changes the id. Attributes that matter:

- `-diff` or `binary`: the file is shown as "Binary files differ" (or as an
  encoded binary patch with `--binary`) instead of a textual diff.
- `diff=<driver>`: selects a custom diff driver. `emit-verdict` passes
  `--no-ext-diff` and `--no-textconv`, which neutralizes external diff and
  textconv drivers, but other driver settings (such as a driver's `binary`
  option) can still change output.
- `text`, `eol`, `-text`: these control line-ending normalization when files
  are added to or checked out of the repository. Commit-to-commit diffs compare
  stored blobs, so they matter mostly through what got committed (a CRLF vs LF
  blob is a different diff) and through any working-tree comparison.

Attributes are read from the checked-out working tree and from machine-local
sources, not only from the commits being compared. Sources include
`.gitattributes` files, `.git/info/attributes`, and the file named by
`core.attributesFile` (default `$XDG_CONFIG_HOME/git/attributes`). This repo has
no `.gitattributes` on `main`, so a developer's global or per-clone attributes
can silently apply locally while CI has none, producing different patch-ids for
the same commits.

## Keeping local and CI identical

- Use the same git version locally and in CI (see above).
- A committed `.gitattributes` is the source of truth. If the repo needs
  attributes for reviewed files, commit them rather than relying on local
  configuration.
- Do not use machine-local attributes (`.git/info/attributes`,
  `core.attributesFile`) for files that can appear in reviewed diffs. If you
  have them, remove them or run the tooling with a clean environment, for
  example `git -c core.attributesFile=/dev/null` and an empty
  `.git/info/attributes`.
- Compare ids across environments by running `scripts/emit-verdict.mjs` for
  the same `--base` and `--head` SHAs and checking that `patch_id` matches.

## Changing .gitattributes invalidates carried-over verdicts

Adding or editing `.gitattributes` can change patch-ids for diffs that touch
affected files. Under the OVD-845 rebase rule, a verdict for an earlier SHA
carries over only when its `patch_id` equals the patch-id recomputed for the
current head. After an attributes change, earlier verdicts will not match and
must be re-issued. Land attribute changes on their own, ahead of the
work they affect, and expect to re-verify open PRs.
