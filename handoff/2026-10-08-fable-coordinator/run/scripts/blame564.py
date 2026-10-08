import subprocess, sys, collections, json
repo='/home/user/Overdrafter'; D=sys.argv[1]
head='f9348a2768088214be0febb5b08def3f40674e20'
branch=set(subprocess.check_output(['git','-C',repo,'rev-list','9d0c79ba04b4b600cc054b323fbf9649569105b4..'+head],text=True).split())
rec=set(open(D+'/recovered.txt').read().split())
files=[l for l in open(D+'/files564.txt').read().splitlines() if l]
cnt=collections.Counter(); perfile=collections.defaultdict(collections.Counter)
for f in files:
    try:
        out=subprocess.check_output(['git','-C',repo,'blame','--porcelain','-w',head,'--',f],text=True,errors='replace')
    except subprocess.CalledProcessError: cnt['blame_error']+=1; continue
    for line in out.splitlines():
        p=line.split(' ')
        if len(p)>=3 and len(p[0])==40 and all(c in '0123456789abcdef' for c in p[0]):
            sha=p[0]
            if sha not in branch: continue
            k='recovered' if sha in rec else sha[:9]
            cnt[k]+=1; perfile[f][k]+=1
json.dump({'counts':cnt,'perfile':{f:dict(c) for f,c in perfile.items()}},open(D+'/blame564.json','w'),indent=1)
for k,v in cnt.most_common(): print(k,v)
