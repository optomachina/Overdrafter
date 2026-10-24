QA: PASS on 99541dc615b15a7a030f7e97c1b107cebe9673c0
- The diff is one line in .sonarcloud.properties: it adds the continuation `\`. The only new exclusion that takes effect is `docs/migration-drafts/ovd-766-*.sql`, which matches the a–e drafts and their rollbacks (10 files). The other entries on that line were already listed.
- SonarCloud Code Analysis shows "Quality Gate passed", and all 16 checks are green.
- Note: this does not clear #776's Sonar failure, because those duplicated lines are under supabase/migrations/.
CI: https://github.com/optomachina/Overdrafter/actions/runs/38838799180
