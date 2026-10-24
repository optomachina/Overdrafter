import json,sys
d=json.load(open(sys.argv[1]));d=d['check_runs']
from collections import Counter
print(len(d),Counter((c['status'],c.get('conclusion')) for c in d))
for c in d:
  if c.get('conclusion')!='success': print(' ',c['name'],c['status'],c.get('conclusion'),c['html_url'])
