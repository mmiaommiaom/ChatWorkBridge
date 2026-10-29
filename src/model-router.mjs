import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';import {selectModel,classifyProviderError} from './model-policy.mjs';
import {nativeRpc,sendWorkerText} from './workbuddy-desktop.mjs';
import {assertControlledPath} from './local-config.mjs';
const stateFile=new URL('../data/model-state.json',import.meta.url);
export async function routeApprovedTask(invoke,{preferred,states={},persist=()=>{}}={}){
 const attempts=[];
 for(let attempt=0;attempt<3;attempt++){
  const model=selectModel({preferred,states,exclude:attempts.map(a=>a.model)});const started=Date.now();
  let result;
  try{result=await invoke(model,attempt);}catch(e){
   const category=e.category??classifyProviderError(e),entry=states[model]??={};entry.failures=(entry.failures??0)+1;entry.lastError={category,message:e.message,at:new Date().toISOString()};
   if(category==='quota_exhausted')entry.quotaExhausted=true;
   if(['rate_limited','service_error'].includes(category))entry.cooldownUntil=Date.now()+60000;
   attempts.push({model,ok:false,category,safeToRetry:e.safeToRetry===true});await persist(states);
   if(e.safeToRetry!==true||!['quota_exhausted','rate_limited','service_error'].includes(category))throw e;
   continue;
  }
  // A local disk error after an accepted worker result is never a provider error
  // and must not cause the successful task to run again on another model.
  if(result?.model!==undefined&&result.model!==model)throw Error('Worker returned a model different from the approved selection');
  const entry=states[model]??={};entry.successes=(entry.successes??0)+1;entry.lastSuccessAt=new Date().toISOString();entry.lastMs=Date.now()-started;await persist(states);
  return {...result,model,attempts:[...attempts,{model,ok:true,ms:Date.now()-started}]};
 }
 throw Error('Approved model attempts exhausted; no paid model called');
}
export async function dispatchWorkerText(page,request){
 const states=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile)):{};
 return routeApprovedTask(async(model,attempt)=>{
  await nativeRpc(page,'session:updateConfig',[request.sessionId,{model}],45000);
  return sendWorkerText(page,{...request,requestId:request.requestId+'-attempt-'+attempt});
 },{states,persist:s=>{
  const destination=assertControlledPath(fileURLToPath(stateFile));fs.mkdirSync(path.dirname(destination),{recursive:true});
  const pending=assertControlledPath(destination+'.pending-'+randomUUID());
  fs.writeFileSync(pending,JSON.stringify(s,null,2)+'\n',{flag:'wx'});fs.renameSync(pending,destination);
 }});
}
