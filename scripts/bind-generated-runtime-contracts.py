#!/usr/bin/env python3
"""Bind existing curated owner contracts to verified immutable native outputs.

Does not modify runtime bytes or promote readiness. Recipe consumers remain
external curated contracts. Smart metadata is committed before creating its
Core reference, avoiding circular runtime/metadata revision bindings.
"""
import argparse,copy,hashlib,importlib.util,json,re,subprocess
from pathlib import Path


def sha(data):return hashlib.sha256(data).hexdigest()
def git(root,*args):return subprocess.check_output(['git','-C',str(root),*args])
def write(path,value):path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
REPOSITORY_OWNERS={
 'https://github.com/simai/ui':'simai/ui',
 'https://github.com/simai/ui-smart':'simai/ui-smart',
}


def rebind(value,bindings):
 if isinstance(value,dict):
  rebound={k:rebind(v,bindings) for k,v in value.items()}
  owner=REPOSITORY_OWNERS.get(rebound.get('repository'))
  if owner in bindings and re.fullmatch(r'[0-9a-f]{40}',str(rebound.get('commit',''))):
   rebound['commit']=bindings[owner]
  return rebound
 if isinstance(value,list):return [rebind(v,bindings) for v in value]
 if isinstance(value,str):
  for owner,revision in bindings.items():value=re.sub(re.escape(owner)+r'@[0-9a-f]{40}:',owner+'@'+revision+':',value)
 return value


def main():
 p=argparse.ArgumentParser();p.add_argument('--ui-root',type=Path,required=True);p.add_argument('--smart-root',type=Path,required=True);p.add_argument('--receipt',type=Path,required=True);p.add_argument('--source-root',type=Path,required=True);p.add_argument('--phase',choices=['owners','reference'],required=True);a=p.parse_args()
 receipt=json.loads(a.receipt.read_text());sources=receipt['runtime_sources']; roots={'core':a.ui_root,'smart':a.smart_root}
 bindings={}; releases={}
 for name,root in roots.items():
  item=sources[name];revision=item['revision'];owner='simai/ui' if name=='core' else 'simai/ui-smart';bindings[owner]=revision
  assert git(root,'rev-parse',revision+'^{tree}').decode().strip()==item['tree']
  assert git(root,'rev-parse',revision+':'+item['runtime_path']).decode().strip()==item['runtime_tree']
  assert sha(git(root,'archive','--format=tar',revision))==item['candidate_archive']['sha256']
  assert sha(git(root,'archive','--format=tar',revision,item['runtime_path']))==item['runtime_archive']['sha256']
  for line in git(root,'status','--porcelain','--',item['runtime_path']).decode().splitlines():raise ValueError('dirty runtime: '+line)
  releases[name]={'tag':None,'commit':revision,'tree':item['tree'],'runtime_subtree':item['runtime_tree'],'archive_sha256':item['runtime_archive']['sha256']}
 module_path=a.ui_root/'scripts/build-framework-registry.py';spec=importlib.util.spec_from_file_location('registry_builder',module_path);mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
 if a.phase=='owners':
  for kind,root,name in [('utility',a.ui_root,'core'),('component',a.ui_root,'core'),('smart-component',a.smart_root,'smart')]:
   path=root/f'contracts/owners/{kind}.manifest.json';original=json.loads(path.read_text());manifest=rebind(original,bindings);manifest['release']=releases[name]
   # Keep all independently curated lifecycle/readiness/dependency decisions.
   assert manifest['defaults']['readiness']==original['defaults']['readiness']
   mod.validate_manifest_envelope(manifest,kind)
   if kind=='smart-component':
    for entry in manifest['entries']:
     for ref in entry['runtime']['asset_paths']:
      relative=ref.split(':',1)[1];git(root,'cat-file','-e',bindings['simai/ui-smart']+':'+relative)
   write(path,manifest)
  print('Owner metadata bound; commit Smart metadata before reference phase.');return
 smart_path=a.smart_root/'contracts/owners/smart-component.manifest.json';smart=json.loads(smart_path.read_text());assert smart['release']==releases['smart']
 assert not git(a.smart_root,'status','--porcelain','--','contracts/owners/smart-component.manifest.json')
 contract_revision=git(a.smart_root,'rev-parse','HEAD').decode().strip()
 old=a.ui_root/'contracts/releases/ui-8c22fe2b80bb-smart-400d80e501ca.lock.json';lock=json.loads(old.read_text());compatibility='ui-'+sources['core']['revision'][:12]+'-smart-'+sources['smart']['revision'][:12];lock['compatibility_id']=compatibility
 for name,key in [('core','ui'),('smart','ui-smart')]:
  item=sources[name];lock['runtime_sources'][key]={**lock['runtime_sources'][key],'commit':item['revision'],'tree':item['tree'],'runtime_tree':item['runtime_tree'],'archive_sha256':item['runtime_archive']['sha256'],'tag':None,'tag_object':None}
 for name,root in [('source',a.source_root),('builder',Path(__file__).resolve().parents[1])]:
  revision=receipt[name+'_revision'];lock['build_inputs'][name]={'owner':'simai/ui-'+name,'commit':revision,'tree':git(root,'rev-parse',revision+'^{tree}').decode().strip(),'archive_sha256':sha(git(root,'archive','--format=tar',revision))}
 mod.validate_lock(lock)
 reference={'schema_id':'simai.framework.owner-manifest-reference','schema_version':1,'owner':'simai/ui-smart','runtime':{'tag':None,'commit':sources['smart']['revision'],'tree':sources['smart']['tree'],'subtree':sources['smart']['runtime_tree'],'archive_sha256':sources['smart']['runtime_archive']['sha256']},'manifest':{'path':'contracts/owners/smart-component.manifest.json','hash_mode':'canonical-json-v1','sha256':mod.canonical_manifest_hash(smart),'file_sha256':sha(smart_path.read_bytes())},'contract_revision':contract_revision,'status':'committed'}
 mod.validate_smart_reference(reference,smart,lock,sha(smart_path.read_bytes()))
 write(a.ui_root/f'contracts/releases/{compatibility}.lock.json',lock);write(a.ui_root/f'contracts/registry-inputs/ui-smart-{contract_revision[:12]}.ref.json',reference)
 print(json.dumps({'compatibility_id':compatibility,'smart_contract_revision':contract_revision}))

if __name__=='__main__':main()
