L=/workspace/qa-batch/776-r2.log; S=08b27cd406242961404a65aff29630c399c3c31b
for i in $(seq 1 12); do sleep 300; echo "== $(date +%T)" >>$L; gh pr checks 776 >>$L 2>&1; R=$(gh run list --commit $S --json databaseId,name,status,conclusion,url); echo "$R" >>$L
 if [ "$R" != "[]" ] && ! echo "$R" | jq -r '.[].status' | grep -vq completed; then echo DONE>>$L; exit; fi; done; echo TIMEOUT>>$L
