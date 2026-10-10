#!/usr/bin/env python3
"""Source-only v10 checkpoints; runtime secrets, dependencies and databases are excluded."""
from pathlib import Path
import argparse,datetime,hashlib,json,os,subprocess,zipfile
BUILD_SOURCE={'sites-vite-plugin.ts','sites-vite-plugin.LICENSE'}
MAIN=Path(__file__).resolve().parents[1]
WORK=MAIN.parent
ROOT=WORK.parent
EXCLUDED={'.next','node_modules','.venv','venv','.git','.wrangler','.sites-runtime','__pycache__','.pytest_cache','.mypy_cache','.ruff_cache','.vite','dist','build','out','coverage','logs'}
STATE=[('data',),('evidence',),('integrations','site-finder-v07','data'),('integrations','site-finder-v07','evidence'),('integrations','site-investigator-v01','data'),('integrations','site-investigator-v01','evidence'),('integrations','wallet-investigator','data'),('integrations','form-submitter','data')]
def permitted(p,base):
    rel=p.relative_to(base);parts=rel.parts;n=p.name
    if p.is_symlink():return False
    if any(x in EXCLUDED for x in parts[:-1]) and not (base==MAIN and parts==('build',n) and n in BUILD_SOURCE):return False
    if any(parts[:len(prefix)]==prefix for prefix in STATE):return False
    if n.startswith(('.env','.dev.vars')):return n.endswith('.example')
    if n in {'.DS_Store','.npmrc'}:return False
    if p.suffix.lower() in {'.zip','.db','.sqlite','.sqlite3','.pyc','.pyo','.tmp','.log-journal','.tsbuildinfo'} or n.endswith(('-wal','-shm','-journal')):return False
    return True
def source_files():
    files=[]
    for base in [MAIN,WORK/'operation-hunter-v2.0']:
        for directory,dirs,names in os.walk(base):
            dirs[:]=[d for d in dirs if (d not in EXCLUDED or (d=='build' and Path(directory)==MAIN)) and not (Path(directory)/d).is_symlink()]
            for name in names:
                p=Path(directory)/name
                if p.is_file() and permitted(p,base):files.append((p,p.relative_to(WORK).as_posix()))
    return sorted(files)
def main():
    ap=argparse.ArgumentParser();ap.add_argument('unit');ap.add_argument('--summary',required=True);ap.add_argument('--validation',required=True);ap.add_argument('--next',required=True);ap.add_argument('--freeze',action='store_true')
    a=ap.parse_args();at=datetime.datetime.now(datetime.timezone.utc).isoformat()
    statefile=MAIN/'verification/v10/checkpoint-state.json';statefile.parent.mkdir(parents=True,exist_ok=True)
    old=json.loads(statefile.read_text()) if statefile.exists() else {'number':0}
    number=old['number']+1
    identity_files=[(p,n) for p,n in source_files() if n not in {MAIN.name+'/V10_LIVE_CHECKPOINT.md',MAIN.name+'/V10_FULL_AUTONOMY_RELEASE_REPORT.md'} and '/verification/' not in n]
    identity=hashlib.sha256(''.join(n+':'+hashlib.sha256(p.read_bytes()).hexdigest()+'\n' for p,n in identity_files).encode()).hexdigest()
    git=subprocess.run(['git','rev-parse','HEAD'],cwd=WORK,capture_output=True,text=True)
    live=MAIN/'V10_LIVE_CHECKPOINT.md'
    entry=f"""## Checkpoint {number}: {a.unit}
- Time UTC: {at}
- Completed: {a.summary}
- Validation: {a.validation}
- Source identity (code/docs excluding live log and verification artifacts): {identity}
- Freeze: {'ACTIVE; final gates must match this identity' if a.freeze else 'NOT FROZEN'}
- Migrations: additive only; inspect drizzle for latest.
- Exact next action: {a.next}
- Source ZIP: v10-recovery-latest.zip (complete source, public tests/docs, original sibling paths; no secrets/runtime DB/dependencies).
- Previous Git commit: {git.stdout.strip() if git.returncode==0 else 'none'}

"""
    if not live.exists():live.write_text('# V10 live checkpoint\n\nThis log is a recovery ledger, not a release certification. Each checkpoint is persisted with source; failed/blocked checks remain explicit.\n\n')
    live.write_text(live.read_text()+entry)
    state={'number':number,'unit':a.unit,'at':at,'source_identity':identity,'freeze':a.freeze,'next':a.next}
    statefile.write_text(json.dumps(state,indent=2)+'\n')
    files=source_files()
    # Commit only explicitly screened files. Nothing untracked is discarded.
    subprocess.run(['git','add','-f','--',*[n for _,n in files]],cwd=WORK,check=True,stdout=subprocess.DEVNULL)
    tracked=subprocess.check_output(['git','ls-files','-z'],cwd=WORK,text=True).split('\0')
    deleted=[]
    for n in tracked:
        if not n:continue
        p=WORK/n
        base=MAIN if n.startswith(MAIN.name+'/') else WORK/'operation-hunter-v2.0' if n.startswith('operation-hunter-v2.0/') else None
        if base and not p.exists() and permitted(p,base):deleted.append(n)
    if deleted:subprocess.run(['git','add','-u','--',*deleted],cwd=WORK,check=True,stdout=subprocess.DEVNULL)
    subprocess.run(['git','commit','-m',f'v10 checkpoint {number}: {a.unit}'],cwd=WORK,check=True,stdout=subprocess.DEVNULL)
    commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=WORK,text=True).strip()
    manifest={'checkpoint':number,'at':at,'git_commit':commit,'source_identity':identity,'files':[]}
    target=ROOT/'v10-recovery-latest.zip';temp=ROOT/'v10-recovery-latest.tmp'
    with zipfile.ZipFile(temp,'w',zipfile.ZIP_DEFLATED,compresslevel=6) as z:
        # A verification log may still be growing. Record and archive the same byte snapshot,
        # rather than hashing the live file and reading it again through ZipFile.write.
        for p,n in files:
            data=p.read_bytes();z.writestr(n,data)
            manifest['files'].append({'path':n,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
        z.writestr('V10_SOURCE_MANIFEST.json',json.dumps(manifest,indent=2))
    with zipfile.ZipFile(temp) as z:
        assert z.testzip() is None
        for item in manifest['files']:assert hashlib.sha256(z.read(item['path'])).hexdigest()==item['sha256']
    os.replace(temp,target)
    print(json.dumps({'checkpoint':number,'commit':commit,'source_identity':identity,'archive':str(target),'entries':len(files)+1,'bytes':target.stat().st_size,'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}))
if __name__=='__main__':main()
