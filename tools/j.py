import json,sys
def load(p):
    t=open(p).read()
    i=[x for x in [t.find('{'),t.find('[')] if x>=0]; s=min(i)
    e=t.rfind(']' if t[s]=='[' else '}')
    return json.loads(t[s:e+1])
