QA: FAIL on b9f3d4f. The over-blocks are fixed: commit messages that mention supabase, `git blame`/`git diff`, `find -name`, and `sort | uniq` now exit 0. Pipes into `tcsh`/`csh`/`fish` now exit 2. Node tests pass 59/59 and all checks are green.
Regression: `git commit -m "$(touch supabase/migrations/a.sql)"`, the backtick form, `-m x --file=supabase/migrations/a.sql`, and `-m x -m "$(cp a supabase/migrations/)"` exit 0 again. They exited 2 in round 5.
Bypasses through the new exemptions: `find supabase/migrations -exec/-execdir/-ok/-delete`, `find -fprint/-fprintf/-fls <mig>`, `sort -o/--output=<mig>`, `git diff --output=<mig>`, and `uniq in <mig>` all exit 0. Over-block: `git commit -m x -- supabase/migrations/a.sql` exits 2.
Evidence: /workspace/qa-batch/664-r6.log
