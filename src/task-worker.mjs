import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {projectRoot,assertControlledPath} from './local-config.mjs';
import {nativeRpc,loadWorkerBinding} from './workbuddy-desktop.mjs';
import {approvedModel} from './model-policy.mjs';
export function taskName(goal,now=new Date()){
 const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(now);
 const keywords=String(goal).replace(/[<>:"/\\|?*\x00-\x1f]/g,' ').replace(/\s+/g,' ').trim().slice(0,24)||'协作任务';
 return date+' '+keywords;
}
export async function ensureTaskWorker(page,run,{root=projectRoot,rpc=nativeRpc,base=loadWorkerBinding()}={}){
 const file=assertControlledPath(path.join(root,'data/capability-bindings.json'));
 let registry=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):[];
 let binding=registry.find(b=>b.taskRunId===run.id);
 const save=()=>{const temp=file+'.'+randomUUID()+'.pending';fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(temp,JSON.stringify(registry,null,2)+'\n',{flag:'wx'});fs.renameSync(temp,file);};
 if(binding){
  if(binding.stage!=='ready')throw Error('Task session initialization uncertain; inspect the reserved session, do not recreate');
  if(binding.mode!==(base.mode??'test')||!fs.existsSync(binding.workspace)||fs.realpathSync.native(binding.workspace).toLowerCase()!==path.resolve(binding.workspace).toLowerCase())throw Error('Task workspace moved or runtime mode changed; recheck required');
  let remote=await rpc(page,'session:get',[binding.sessionId]);
  if(remote==null){
   const active=await rpc(page,'daemon:getActiveSessions',[]);
   if(!Array.isArray(active)||active.length)throw Error('WorkBuddy still has active work; cannot reload a saved session');
   await rpc(page,'session:load',[binding.sessionId,{cwd:binding.workspace,forceRendererHistoryReplay:true}],45000);
   remote=await rpc(page,'session:get',[binding.sessionId]);
  }
  if((remote?.sessionId??remote?.id)!==binding.sessionId||path.resolve(remote.cwd??'').toLowerCase()!==path.resolve(binding.workspace).toLowerCase())throw Error('Task workspace moved or session identity changed');
  approvedModel(remote.model??remote.config?.model);return {...binding,displayName:remote.name??binding.displayName};
 }
 const displayName=taskName(run.goal),workspace=assertControlledPath(path.join(root,'workspaces/probe',displayName.replaceAll(' ','_')+'_'+run.id.slice(-8)));
 fs.mkdirSync(workspace,{recursive:true});
 if(fs.realpathSync.native(workspace).toLowerCase()!==workspace.toLowerCase())throw Error('Task workspace link denied');
 binding={version:1,taskRunId:run.id,mode:base.mode??'test',sessionId:randomUUID(),workspace,model:approvedModel(base.model??'deepseek-v4.1-flash'),displayName,stage:'reserved'};
 binding.create={cwd:workspace,sessionId:binding.sessionId,isPlayground:false,config:{model:binding.model}};
 registry.push(binding);save();
 try{
  binding.stage='creating';save();
  const session=await rpc(page,'session:create',[binding.create],45000);
  if((session?.sessionId??session?.id)!==binding.sessionId||path.resolve(session.cwd??'').toLowerCase()!==workspace.toLowerCase())throw Error('Created task session identity mismatch');
  await rpc(page,'session:rename',[binding.sessionId,displayName]);
  await rpc(page,'session:load',[binding.sessionId,{cwd:workspace,forceRendererHistoryReplay:true}],45000);
  binding.stage='ready';save();return binding;
 }catch(e){binding.stage='uncertain';binding.error=e.message;save();throw e;}
}
