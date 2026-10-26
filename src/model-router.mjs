import fs from 'node:fs';import {selectModel,classifyProviderError} from './model-policy.mjs';
import {nativeRpc,sendWorkerText} from './workbuddy-desktop.mjs';
const stateFile=new URL('../data/model-state.json',import.meta.url);
export async function routeApprovedTask(invoke,{preferred,states={},persist=()=>{}}={}){
 const attempts=[];
 for(let attempt=0;attempt<3;attempt++){
  const model=selectModel({preferred,states,exclude:attempts.map(a=>a.model)});const started=Date.now();
  try{
   const result=await invoke(model,attempt);const entry=states[model]??={};entry.successes=(entry.successes??0)+1;entry.lastSuccessAt=new Date().toISOString();entry.lastMs=Date.now()-started;await persist(states);
   return {...result,model,attempts:[...attempts,{model,ok:true,ms:Date.now()-started}]};
  }catch(e){
   const category=e.category??classifyProviderError(e),entry=states[model]??={};entry.failures=(entry.failures??0)+1;entry.lastError={category,message:e.message,at:new Date().toISOString()};
   if(category==='quota_exhausted')entry.quotaExhausted=true;
   if(['rate_limited','service_error'].includes(category))entry.cooldownUntil=Date.now()+60000;
   attempts.push({model,ok:false,category,safeToRetry:e.safeToRetry===true});await persist(states);
   if(e.safeToRetry!==true||!['quota_exhausted','rate_limited','service_error'].includes(category))throw e;
  }
 }
 throw Error('Approved model attempts exhausted; no paid model called');
}
export async function dispatchWorkerText(page,request){
 const states=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile)):{};
 return routeApprovedTask(async(model,attempt)=>{
  await nativeRpc(page,'session:updateConfig',[request.sessionId,{model}],45000);
  return sendWorkerText(page,{...request,requestId:request.requestId+'-attempt-'+attempt});
 },{states,persist:s=>fs.writeFileSync(stateFile,JSON.stringify(s,null,2)+'\n')});
}
