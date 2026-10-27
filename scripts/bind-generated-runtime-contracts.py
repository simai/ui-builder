#!/usr/bin/env python3
"""Bind existing curated owner contracts to verified immutable native outputs.

Does not modify runtime bytes or promote readiness. Recipe consumers remain
external curated contracts.

Two layouts:

* v1 (``--smart-root`` is a separate ui-smart checkout): Smart metadata is
  committed in ui-smart before its Core reference is created, avoiding
  circular runtime/metadata revision bindings. Writes
  ``ui/contracts/releases/ui-<12>-smart-<12>.lock.json`` (schema v1) and the
  ui-smart owner-manifest reference.
* v2 (``--smart-root`` equals ``--ui-root``): a Framework release is one ui
  build commit with Smart in ``distr/smart``. The Smart owner manifest is
  ui's own (``ui/contracts/owners/smart-component.manifest.json``, seeded from
  the mirror's on the first v2 release). Writes
  ``ui/contracts/releases/ui-<12>.lock.json`` (schema v2). With
  ``--mirror-root`` (ui-smart, kept as a mirror for v1 readers) the mirror's
  manifest is bound too, the lock records the mirror and its v1-shaped
  ``pair``, and a v1 alias lock is written under that pair id, because v1
  readers (ui-admin's pin) resolve a release by the ui-smart commit.
"""
import argparse,copy,hashlib,importlib.util,json,re,subprocess
from pathlib import Path

UI='simai/ui'
MIRROR='simai/ui-smart'
SMART_MANIFEST='contracts/owners/smart-component.manifest.json'
SMART_TREE='distr/smart'


def sha(data):return hashlib.sha256(data).hexdigest()
def git(root,*args):return subprocess.check_output(['git','-C',str(root),*args])
def text(root,*args):return git(root,*args).decode().strip()
def write(path,value):path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')


def rebind(value,bindings):
 """Rewrite every owner@<40 hex>:path reference to the revision bound to it.

 `bindings` maps an owner either to a revision or to a list of
 (path prefix, revision) pairs, first match wins, so `simai/ui@...:distr/smart`
 and `simai/ui@...:distr/rule/rule.json` can name different build commits.
 """
 if isinstance(value,dict):return {k:rebind(v,bindings) for k,v in value.items()}
 if isinstance(value,list):return [rebind(v,bindings) for v in value]
 if isinstance(value,str):
  for owner,binding in bindings.items():
   rules=[('',binding)] if isinstance(binding,str) else binding
   def choose(match,rules=rules):
    path=value[match.end():]
    for prefix,revision in rules:
     if path.startswith(prefix):return owner+'@'+revision+':'
    return match.group(0)
   value=re.sub(re.escape(owner)+r'@[0-9a-f]{40}:',choose,value)
 return value


def owner_of(repository):
 """The owner an entry's provenance repository URL names."""
 name=str(repository or '').rstrip('/')
 for suffix in ('.git',):
  if name.endswith(suffix):name=name[:-len(suffix)]
 parts=name.split('/')
 return '/'.join(parts[-2:]) if len(parts)>=2 else ''


def rebind_provenance(manifest,bindings):
 """Move the bare revisions that an owner@revision: rewrite cannot reach.

 Every entry records the runtime it came from as provenance.commit, a plain
 revision with no owner prefix. Left behind, it names the previous runtime while
 the release block names the new one, and the owner repository's own contract
 test fails on every entry.
 """
 moved=0
 for entry in manifest.get('entries',[]):
  provenance=entry.get('provenance')
  if not isinstance(provenance,dict) or 'commit' not in provenance:continue
  revision=bindings.get(owner_of(provenance.get('repository')))
  if revision is None:
   raise ValueError('unbound provenance repository: '+str(provenance.get('repository')))
  if provenance['commit']!=revision:
   provenance['commit']=revision;moved+=1
 return moved


def assert_no_stale_revisions(manifest,previous,current):
 """Nothing may still name the revisions this binding replaces.

 The guard is deliberately blunt: any field that carries a superseded revision,
 including one added to the schema later, fails here rather than in a consumer.
 """
 current=set(current)
 stale={revision for revision in previous if revision and revision not in current}
 if not stale:return
 serialized=json.dumps(manifest)
 found=sorted(revision for revision in stale if revision in serialized)
 if found:
  raise ValueError('stale revision left in the manifest: '+', '.join(found))


def previous_revisions(manifest):
 return [(manifest.get('release') or {}).get('commit')]+[(entry.get('provenance') or {}).get('commit') for entry in manifest.get('entries',[])]


def seed_ui_smart_manifest(mirror_manifest):
 """The ui-owned Smart manifest, made once from the one ui-smart keeps.

 Same entries and curated decisions; owner, repository and every
 `simai/ui-smart@<rev>:smart/...` reference move to `simai/ui@<rev>:distr/smart/...`.
 Revisions are left as they were and moved by the normal binding after this.
 """
 def move(value):
  if isinstance(value,dict):return {k:move(v) for k,v in value.items()}
  if isinstance(value,list):return [move(v) for v in value]
  if isinstance(value,str):
   value=re.sub(r'simai/ui-smart@([0-9a-f]{40}):smart(?=/|$)',r'simai/ui@\1:'+SMART_TREE,value)
   value=re.sub(r'simai/ui-smart@([0-9a-f]{40}):',r'simai/ui@\1:',value)
   if value=='https://github.com/simai/ui-smart':return 'https://github.com/simai/ui'
   if value==MIRROR:return UI
  return value
 seeded=move(mirror_manifest)
 seeded['owner']={'id':UI,'repository':'https://github.com/simai/ui','manifest_path':SMART_MANIFEST}
 if MIRROR in json.dumps(seeded):raise ValueError('seeded manifest still names '+MIRROR)
 return seeded


def package_components(ui_root):
 """The Smart components component packages provide, by id -> runtime folder.

 Read from ui's distr/core/contracts/packages/*.package.json (SIMAI Framework Pro is the
 first package). Such a component ships from its own distribution, so it has
 no entry in the free Smart owner manifests.
 """
 provided={}
 directory=ui_root/'distr/core/contracts/packages'
 for path in sorted(directory.glob('*.package.json')) if directory.is_dir() else []:
  for item in json.loads(path.read_text())['provides']:provided[item['id']]=item['folder']
 return provided


def retire_package_entries(manifest,provided,root,revision,tree):
 """Drop the entries a package provides; the release must not carry them.

 The entry leaves the free owner manifest in the release that stops shipping
 its folder, and only then: a folder still present at the release is an error,
 because the manifest would deny a component the bytes still hold.
 """
 retired=[entry['id'] for entry in manifest['entries'] if entry['id'] in provided]
 if not retired:return manifest,[]
 for public_id in retired:
  folder=tree+'/'+provided[public_id]
  if subprocess.run(['git','-C',str(root),'cat-file','-e',revision+':'+folder],capture_output=True).returncode==0:
   raise ValueError(public_id+': a package provides it, but '+folder+' is still in the release')
 manifest=dict(manifest)
 manifest['entries']=[entry for entry in manifest['entries'] if entry['id'] not in provided]
 manifest['inventory']=dict(manifest['inventory'],expected=manifest['inventory']['expected']-len(retired))
 return manifest,retired


def smart_tree_files(root,revision,tree):
 """Every file under `tree` at `revision`, relative to the repository root."""
 return git(root,'ls-tree','-r','--name-only',revision,'--',tree+'/').decode().splitlines()


def sync_smart_entries(manifest,ui_root,smart_revision,release,source_root,source_revision,provided,relation_id):
 """Make the Smart owner manifest list exactly the Smart components the release ships.

 A component ships when its folder is in distr/smart (as of the commit that last
 wrote it) and its `cl-<folder>` rule of type smart is in distr/rule/rule.json
 (as of the release). An entry whose component no longer ships is dropped. A
 shipped component with no entry gets one, built from the bytes, the rule and
 the source smart.manifest.json, with the readiness a component outside the
 curated plan has: discoverable, not suggested, curated for nothing. Existing
 entries, and every curated decision in them, are left as they are; the
 owner promotes a new entry by hand. inventory.expected is recounted.

 A component whose folder and rule were renamed (sf-input: inputs/cl-inputs ->
 input/cl-input, and its id smart.inputs -> smart.input) is one component, not
 one dropped and one new: an added entry whose tags are a dropped entry's takes
 that entry's curated decisions (title, lifecycle, readiness, examples,
 curated_for), and every other entry that required the old id requires the new
 one. `requires` itself is a fact of the rule, as the registry checks it
 (smart_rule_relations_mismatch), so it is recounted for every entry.
 """
 files=smart_tree_files(ui_root,smart_revision,SMART_TREE)
 folders={path[len(SMART_TREE)+1:].split('/',1)[0] for path in files}
 rules=json.loads(git(ui_root,'show',release+':distr/rule/rule.json'))
 rule_kinds={rule['name']:rule.get('type','utility') for rule in rules}
 shipped={rule['name']:rule for rule in rules if rule.get('type')=='smart' and rule['name'].startswith('cl-') and rule['name'][3:] in folders}
 kept=[entry for entry in manifest['entries'] if entry['runtime'].get('rule_name') in shipped]
 # The runtime assets are a fact of the bytes, not a curated decision: they are
 # recounted for a kept entry as for a new one. Kept as written, they named
 # files a release no longer ships -- the licence notes went when the Smart
 # bundles stopped carrying lit (shared runtime, 2026-10-13).
 def assets_of(name):
  folder=SMART_TREE+'/'+name+'/'
  return sorted((path for path in files if path.startswith(folder) and '/' in path[len(folder):] and not path.endswith('.gz')),key=lambda path:path.split('/'))
 def requires_of(rule):
  return sorted(set(relation_id(item['name'],rule_kinds) for item in rule.get('relation',[])))
 kept=[{**entry,'runtime':{**entry['runtime'],'asset_paths':[UI+'@'+smart_revision+':'+path for path in assets_of(entry['runtime']['rule_name'][3:])]},
  'requires':requires_of(shipped[entry['runtime']['rule_name']])} for entry in kept]
 dropped=[entry for entry in manifest['entries'] if entry['runtime'].get('rule_name') not in shipped]
 removed=[entry['id'] for entry in dropped]
 claimed={entry['runtime'].get('rule_name') for entry in kept}
 added=[]
 for rule_name in sorted(set(shipped)-claimed):
  rule=shipped[rule_name];name=rule_name[3:];public_id='smart.'+name
  if public_id in provided:continue
  try:source=json.loads(git(source_root,'show',source_revision+':src/smart/'+name+'/smart.manifest.json'))
  except subprocess.CalledProcessError:
   raise ValueError(public_id+': distr/smart/'+name+' and '+rule_name+' ship, but the source has no src/smart/'+name+'/smart.manifest.json to describe it')
  # The runtime assets are the files below the component's subfolders (js,
  # css, template); its own top-level files are metadata, and .gz are copies.
  assets=assets_of(name)
  added.append({
   'id':public_id,'kind':'smart-component','name':name,'title':source['title'],'owner':UI,'lifecycle':source['lifecycle'],
   'readiness':{'status':'discoverable','safe_to_suggest':False,'profiles':list(manifest['defaults']['readiness']['profiles']),'blockers':[]},
   'provenance':{'repository':'https://github.com/simai/ui','tag':None,'commit':smart_revision,
    'source_refs':[UI+'@'+smart_revision+':'+SMART_TREE+'/'+name,UI+'@'+release+':distr/rule/rule.json#name='+rule_name]},
   'documentation_refs':[UI+'@'+release+':README.md'],
   'example_refs':[],
   'runtime':{'rule_name':rule_name,'tags':list(rule.get('tags',[])),'asset_paths':[UI+'@'+smart_revision+':'+path for path in assets],
    'declared':{'js':bool(rule.get('js',False)),'css':bool(rule.get('css',False))}},
   'requires':requires_of(rule),
   'curated_for':[],
  })
  tags=sorted(rule.get('tags',[]))
  renamed=[entry for entry in dropped if tags and sorted(entry['runtime'].get('tags',[]))==tags]
  if len(renamed)==1:
   for key in ('title','lifecycle','readiness','example_refs','curated_for'):
    added[-1][key]=copy.deepcopy(renamed[0][key])
   added[-1]['renamed_from']=renamed[0]['id']
 renames={entry.pop('renamed_from'):entry['id'] for entry in added if 'renamed_from' in entry}
 for old,new in renames.items():print('Renamed in the ui Smart owner manifest (curated decisions kept): '+old+' -> '+new)
 manifest=dict(manifest)
 manifest['entries']=kept+added
 manifest['inventory']=dict(manifest['inventory'],expected=len(manifest['entries']))
 return manifest,[entry['id'] for entry in added if entry['id'] not in renames.values()],[public_id for public_id in removed if public_id not in renames]


def verify(root,item,label):
 """The receipt entry describes exactly this commit of this checkout."""
 revision=item['revision']
 assert text(root,'rev-parse',revision+'^{tree}')==item['tree'],label+': tree'
 assert text(root,'rev-parse',revision+':'+item['runtime_path'])==item['runtime_tree'],label+': runtime tree'
 assert sha(git(root,'archive','--format=tar',revision))==item['candidate_archive']['sha256'],label+': candidate archive'
 assert sha(git(root,'archive','--format=tar',revision,item['runtime_path']))==item['runtime_archive']['sha256'],label+': runtime archive'
 for line in text(root,'status','--porcelain','--',item['runtime_path']).splitlines():raise ValueError('dirty runtime: '+line)
 return {'tag':None,'commit':revision,'tree':item['tree'],'runtime_subtree':item['runtime_tree'],'archive_sha256':item['runtime_archive']['sha256']}


def lock_source(owner,release,runtime_path,revision=None):
 value={'owner':owner,'tag':None,'tag_object':None}
 if revision:value['revision']=revision
 return {**value,'commit':release['commit'],'tree':release['tree'],'runtime_path':runtime_path,'runtime_tree':release['runtime_subtree'],'archive_sha256':release['archive_sha256']}


def main():
 p=argparse.ArgumentParser()
 p.add_argument('--ui-root',type=Path,required=True)
 p.add_argument('--smart-root',type=Path,required=True,help='ui-smart (v1), or the ui root itself (v2: Smart in distr/smart)')
 p.add_argument('--mirror-root',type=Path,help='v2 only: the ui-smart checkout kept as a mirror')
 p.add_argument('--receipt',type=Path,required=True)
 p.add_argument('--source-root',type=Path,required=True)
 p.add_argument('--phase',choices=['owners','reference'],required=True)
 a=p.parse_args()
 receipt=json.loads(a.receipt.read_text());sources=receipt['runtime_sources']
 v2=a.smart_root.resolve()==a.ui_root.resolve()
 if a.mirror_root and not v2:raise ValueError('--mirror-root is for the v2 layout (--smart-root equal to --ui-root)')
 if v2 and bool(a.mirror_root)!=('mirror' in receipt):raise ValueError('the receipt and --mirror-root disagree about the mirror')
 roots={'core':a.ui_root,'smart':a.smart_root}
 releases={name:verify(root,sources[name],name) for name,root in roots.items()}
 module_path=a.ui_root/'scripts/build-framework-registry.py';spec=importlib.util.spec_from_file_location('registry_builder',module_path);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
 if v2:
  release=receipt['release_revision']
  # One ui build commit is the release. Each tree is named by the build commit
  # that last wrote it as of the release: always the release for distr, the
  # release or an earlier build for distr/smart.
  for name,path in (('core','distr'),('smart',SMART_TREE)):
   item=sources[name]
   if item['runtime_path']!=path:raise ValueError(name+': runtime path must be '+path)
   writer=text(a.ui_root,'log','-1','--format=%H',release,'--',path)
   if item['revision']!=writer:raise ValueError(name+': the receipt names '+item['revision'][:12]+', '+path+' was last written by '+writer[:12])
  if sources['core']['revision']!=release:raise ValueError('the release commit did not write distr')
  if 'mirror' in receipt:
   mirror=receipt['mirror']
   if mirror['runtime_path']!='smart':raise ValueError('mirror runtime path must be smart')
   releases['mirror']=verify(a.mirror_root,mirror,'mirror')
   if releases['mirror']['runtime_subtree']!=releases['smart']['runtime_subtree']:
    raise ValueError('the mirror is not byte-identical to distr/smart')
  smart_bindings=[(SMART_TREE,sources['smart']['revision']),('',release)]
  ui_bindings={UI:release}
 else:
  release=sources['core']['revision']
  ui_bindings={UI:release,MIRROR:sources['smart']['revision']}
 if a.phase=='owners':
  for kind in ('utility','component'):
   path=a.ui_root/f'contracts/owners/{kind}.manifest.json';original=json.loads(path.read_text())
   manifest=rebind(original,ui_bindings);manifest['release']=releases['core']
   rebind_provenance(manifest,{UI:release})
   assert_no_stale_revisions(manifest,previous_revisions(original),list(ui_bindings.values()))
   assert manifest['defaults']['readiness']==original['defaults']['readiness']
   mod.validate_manifest_envelope(manifest,kind);write(path,manifest)
  targets=[]
  provided=package_components(a.ui_root)
  if v2:
   path=a.ui_root/SMART_MANIFEST
   if path.is_file():original=json.loads(path.read_text())
   elif a.mirror_root:original=seed_ui_smart_manifest(json.loads((a.mirror_root/SMART_MANIFEST).read_text()))
   else:raise ValueError('no Smart owner manifest in ui and no mirror to seed it from')
   original,retired=retire_package_entries(original,provided,a.ui_root,sources['smart']['revision'],SMART_TREE)
   if retired:print('Retired from the ui Smart owner manifest (provided by a package): '+', '.join(retired))
   original,added,removed=sync_smart_entries(original,a.ui_root,sources['smart']['revision'],release,a.source_root,receipt['source_revision'],provided,mod.relation_id)
   if added:print('Added to the ui Smart owner manifest (discoverable, not suggested; promote by hand): '+', '.join(added))
   if removed:print('Removed from the ui Smart owner manifest (no longer shipped): '+', '.join(removed))
   targets.append((path,original,{UI:smart_bindings},{UI:sources['smart']['revision']},releases['smart'],a.ui_root))
   if 'mirror' in releases:
    path=a.mirror_root/SMART_MANIFEST;original=json.loads(path.read_text())
    original,retired=retire_package_entries(original,provided,a.mirror_root,releases['mirror']['commit'],'smart')
    if retired:print('Retired from the mirror Smart owner manifest (provided by a package): '+', '.join(retired))
    targets.append((path,original,{UI:release,MIRROR:releases['mirror']['commit']},{MIRROR:releases['mirror']['commit']},releases['mirror'],a.mirror_root))
  else:
   path=a.smart_root/SMART_MANIFEST;original=json.loads(path.read_text())
   targets.append((path,original,ui_bindings,{MIRROR:releases['smart']['commit']},releases['smart'],a.smart_root))
  for path,original,bindings,provenance,smart_release,root in targets:
   manifest=rebind(original,bindings);manifest['release']=smart_release
   rebind_provenance(manifest,provenance)
   current=[revision for binding in bindings.values() for revision in ([binding] if isinstance(binding,str) else [r for _,r in binding])]
   assert_no_stale_revisions(manifest,previous_revisions(original),current)
   # Keep all independently curated lifecycle/readiness/dependency decisions.
   assert manifest['defaults']['readiness']==original['defaults']['readiness']
   mod.validate_manifest_envelope(manifest,'smart-component')
   for entry in manifest['entries']:
    for ref in entry['runtime']['asset_paths']:
     revision,relative=ref.split('@',1)[1].split(':',1);git(root,'cat-file','-e',revision+':'+relative)
   write(path,manifest)
  print('Owner metadata bound; commit '+('the mirror' if v2 else 'Smart')+' metadata before reference phase.');return
 # Reference phase.
 build_inputs={}
 for name,root in [('source',a.source_root),('builder',Path(__file__).resolve().parents[1])]:
  revision=receipt[name+'_revision'];build_inputs[name]={'owner':'simai/ui-'+name,'commit':revision,'tree':text(root,'rev-parse',revision+'^{tree}'),'archive_sha256':sha(git(root,'archive','--format=tar',revision))}
 build_inputs['legacy_compatibility']={'required':False}
 manifests={kind:json.loads((a.ui_root/f'contracts/owners/{kind}.manifest.json').read_text()) for kind in ('utility','component','recipe')}
 smart_path=(a.ui_root if v2 else a.smart_root)/SMART_MANIFEST;smart=json.loads(smart_path.read_text());assert smart['release']==releases['smart']
 # What the release holds, from the manifests the registry is built from (the
 # v1 route copied it from a template lock and it went stale).
 inventory={'utility_rules':manifests['utility']['inventory']['expected']['rules'],'utility_families':manifests['utility']['inventory']['expected']['entries'],'components':manifests['component']['inventory']['expected']['entries'],'smart_components':smart['inventory']['expected'],'recipes':manifests['recipe']['inventory']['expected']['entries']}
 tail={'build_inputs':build_inputs,'inventory':inventory,'exclusions':[],'claims':{'full_compatible':False,'production_ready':False,'all_items_ready':False}}
 def head(version,compatibility):return {'schema_id':'simai.framework.release-lock','schema_version':version,'compatibility_id':compatibility,'status':'bounded','profile':'plain-assets-v1'}
 if not v2:
  assert not git(a.smart_root,'status','--porcelain','--',SMART_MANIFEST)
  contract_revision=text(a.smart_root,'rev-parse','HEAD')
  compatibility='ui-'+release[:12]+'-smart-'+releases['smart']['commit'][:12]
  lock={**head(1,compatibility),'runtime_sources':{'ui':lock_source(UI,releases['core'],'distr'),'ui-smart':lock_source(MIRROR,releases['smart'],'smart')},**tail}
  mod.validate_lock(lock)
  reference={'schema_id':'simai.framework.owner-manifest-reference','schema_version':1,'owner':MIRROR,'runtime':{'tag':None,'commit':releases['smart']['commit'],'tree':releases['smart']['tree'],'subtree':releases['smart']['runtime_subtree'],'archive_sha256':releases['smart']['archive_sha256']},'manifest':{'path':SMART_MANIFEST,'hash_mode':'canonical-json-v1','sha256':mod.canonical_manifest_hash(smart),'file_sha256':sha(smart_path.read_bytes())},'contract_revision':contract_revision,'status':'committed'}
  mod.validate_smart_reference(reference,smart,lock,sha(smart_path.read_bytes()))
  write(a.ui_root/f'contracts/releases/{compatibility}.lock.json',lock);write(a.ui_root/f'contracts/registry-inputs/ui-smart-{contract_revision[:12]}.ref.json',reference)
  print(json.dumps({'compatibility_id':compatibility,'smart_contract_revision':contract_revision}));return
 compatibility='ui-'+release[:12]
 core=lock_source(UI,releases['core'],'distr',release)
 smart_source=lock_source(UI,releases['smart'],SMART_TREE,release)
 lock={**head(2,compatibility),'runtime_sources':{'core':core,'smart':smart_source}}
 written={'compatibility_id':compatibility}
 if 'mirror' in releases:
  mirror_manifest=json.loads((a.mirror_root/SMART_MANIFEST).read_text());assert mirror_manifest['release']==releases['mirror']
  assert not git(a.mirror_root,'status','--porcelain','--',SMART_MANIFEST),'commit the mirror metadata before the reference phase'
  pair='ui-'+release[:12]+'-smart-'+releases['mirror']['commit'][:12]
  lock['mirror']={**lock_source(MIRROR,releases['mirror'],'smart'),'mirrors':'smart'};lock['pair']=pair
  written['pair']=pair
 lock.update(tail)
 mod.validate_lock(lock)
 write(a.ui_root/f'contracts/releases/{compatibility}.lock.json',lock)
 if 'pair' in lock:
  # v1 readers resolve a release by the ui-smart commit they pin (ui-admin's
  # pin reads runtime_sources[*].commit); the alias names the same bytes in v1.
  alias={**head(1,lock['pair']),'runtime_sources':{'ui':lock_source(UI,releases['core'],'distr'),'ui-smart':lock_source(MIRROR,releases['mirror'],'smart')},**tail}
  mod.validate_lock(alias)
  write(a.ui_root/f'contracts/releases/{lock["pair"]}.lock.json',alias)
 print(json.dumps(written))

if __name__=='__main__':main()
