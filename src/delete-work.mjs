import fs from 'node:fs';import path from 'node:path';import {assertControlledPath} from './local-config.mjs';
function inside(base,target){const relative=path.relative(base,target);return relative!==''&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);}
function scan(target){if(!fs.existsSync(target)){try{fs.lstatSync(target);throw Error('Linked deletion target denied');}catch(e){if(e.code==='ENOENT')return 0;throw e;}}const st=fs.lstatSync(target);if(st.isSymbolicLink()||fs.realpathSync.native(target).toLowerCase()!==path.resolve(target).toLowerCase())throw Error('Linked deletion target denied');if(st.isDirectory())return fs.readdirSync(target).reduce((n,name)=>n+scan(path.join(target,name)),0);if(!st.isFile())throw Error('Unsupported deletion target');return st.size;}
export function deleteSavedWork(store,root,{runId,confirmation}){
 root=assertControlledPath(root);if(confirmation!=='永久删除本地工作')throw Error('请确认永久删除本地工作');const run=store.get(runId);
 if(!['done','failed','cancelled','paused','needs_user'].includes(run.state)||store.messages(runId).some(m=>['sending','uncertain'].includes(m.state)))throw Error('运行中或结果待核验的工作不能删除，请先暂停或核验');
 if(!/^run-[a-f0-9-]+$/i.test(runId))throw Error('Invalid saved work identity');
 const registryFile=path.join(root,'data/capability-bindings.json'),registry=fs.existsSync(registryFile)?JSON.parse(fs.readFileSync(registryFile,'utf8')):[],binding=registry.find(b=>b.taskRunId===runId),targets=[path.join(root,'artifacts',runId)];
 if(run.workerWorkspace||binding?.workspace){const workspace=assertControlledPath(run.workerWorkspace??binding.workspace);if(!binding||binding.workspace.toLowerCase()!==workspace.toLowerCase()||!inside(path.join(root,'workspaces/probe'),workspace)||!path.basename(workspace).endsWith('_'+runId.slice(-8)))throw Error('工作目录归属不明确，未删除；请先核对');targets.push(workspace);}
 for(const target of targets){assertControlledPath(target);if(!inside(root,target))throw Error('Deletion outside local project denied');}const bytes=targets.reduce((n,target)=>n+scan(target),0);
 for(const target of targets)if(fs.existsSync(target))fs.rmSync(target,{recursive:true});
 if(binding){const next=registryFile+'.delete-pending';fs.writeFileSync(next,JSON.stringify(registry.filter(b=>b.taskRunId!==runId),null,2)+'\n',{flag:'wx'});fs.renameSync(next,registryFile);}
 store.transaction(()=>{for(const table of ['interactions','notices','events','messages'])store.db.prepare('DELETE FROM '+table+' WHERE run_id=?').run(runId);store.db.prepare('DELETE FROM runs WHERE id=?').run(runId);});
 store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
 return {runId,bytes,message:'已删除本地记录、附件和专属工作目录。GPT 与 WorkBuddy 原聊天、既有备份未删除。'};
}
