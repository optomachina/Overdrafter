QA: PASS on 87a31e714af8bf6a28474b5a0a010ad785bcd2c4
- Tests in `liveHarnessArtifacts.test.ts` show: screenshots stay off unless `LIVE_HARNESS_SCREENSHOTS=1` and the harness injects the hook, the adapter source has no screenshot path, a canary in the price-capture DOM is removed by the shared redactor, and quote URLs lose their query/fragment. Local: 3 files / 223 tests pass.
- Local writer run on a temp dir: the run dir is mode 700. A 44-day-old run dir was pruned, while the 5-day-old and unrelated dirs were kept. `?token=…#frag` was stripped. Values like `true` don't enable screenshots.
- CI: `ci` is red only because `ovd591-retention-qualification` hit the public.ecr.aws image-pull rate limit (`toomanyrequests`). That's infra, not this change. All other checks pass.
CI: https://github.com/optomachina/Overdrafter/actions/runs/38828920881
