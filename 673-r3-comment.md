QA: FAIL on 7ada3fe
Round-2 gaps closed: TBD-only, ### -only, and describe.each([]) now fail; TBD./- TBD/**TBD**/n/a/NA/.../?/commented TBD fail; a real sentence containing TBD passes; provider:check ok; 117 + 785 related tests pass; 14/14 checks green.
Blocking (doc only): 'TBD - later', 'Coming soon', 'None', 'TBD TODO', 'WIP', 'TBC' still pass as section bodies, but the residuals header in provider-readiness-doc.mjs only lists `&nbsp;`. Document these as best-effort residuals (or reject them) and this flips to PASS.
