import json,sys
d=json.load(open(sys.argv[1]))
runs=set()
for r in d["check_runs"]:
  u=r["html_url"]; 
  if "/actions/runs/" in u: runs.add(u.split("/actions/runs/")[1].split("/")[0])
  if r["conclusion"]!="success": print("  NOT GREEN:",r["name"],r["status"],r["conclusion"])
print("  total",d["total_count"],"runs",sorted(runs))
