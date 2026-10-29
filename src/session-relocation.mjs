import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertControlledPath} from './local-config.mjs';

/** A relocated completed binding is archived, never sent to or silently rewritten. */
export function bindingWasRelocated(binding,root,relativeWorkspace){
  if(typeof binding?.workspace!=='string')return false;
  const parts=relativeWorkspace.split('/');
  let previousRoot=path.resolve(binding.workspace);
  for(const _part of parts)previousRoot=path.dirname(previousRoot);
  const expected=path.join(previousRoot,...parts);
  if(path.resolve(binding.workspace).toLowerCase()!==expected.toLowerCase()||previousRoot.toLowerCase()===path.resolve(root).toLowerCase())return false;
  if(binding.installationRoot&&path.resolve(binding.installationRoot).toLowerCase()!==previousRoot.toLowerCase())return false;
  return ['ready','completed_rpc'].includes(binding.stage);
}

export function archiveRelocatedBinding(filename){
  const source=assertControlledPath(filename),backup=assertControlledPath(filename+'.before-relocation-'+randomUUID()+'.json');
  if(path.dirname(source)!==path.dirname(backup))throw Error('Relocation backup must stay beside the original binding');
  fs.renameSync(source,backup);
  return backup;
}
