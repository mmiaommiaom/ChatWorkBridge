import {connectDesktop,nativeRpc} from './workbuddy-desktop.mjs';
import {transportSnapshot} from './native-transport.mjs';
import {approvedModel} from './model-policy.mjs';
import {recoverGptHistory} from './gpt-recovery.mjs';
export async function checkRecovery(run,store,{connect=connectDesktop,rpc=nativeRpc,snapshot=transportSnapshot}={}){
 const unresolved=store.messages(run.id).filter(m=>m.state==='uncertain');
 if(!unresolved.length)return {verified:false,message:'没有待核验发送；可从已保存的结果继续。'};
 const worker=unresolved.find(m=>m.direction==='workbuddy');
 if(!worker)return recoverGptHistory(run,store);
 const desktop=await connect();
 try{
  const sessionId=run.workerSessionId??worker.payload.sessionId;
  const state=await rpc(desktop.page,'session:get',[sessionId]);
  const cache=await snapshot(desktop.page,sessionId);
  const matches=(cache.requests??[]).filter(r=>r.id==='bridge-request-'+worker.id||r.id.startsWith('bridge-request-'+worker.id+'-attempt-'));
  const complete=matches.find(r=>r.status==='completed'&&r.result?.stopReason==='end_turn'&&r.result?._meta?.['codebuddy.ai']?.lastAssistantText);
  if(!complete)return {verified:false,sessionId,remoteStatus:state?.status,transportAvailable:cache.available,message:'未找到与原请求 ID 对应的完整结果。请核对 WorkBuddy 原任务及产物；不会自动继续或重做。可回复补充证据，或保留记录并结束跟踪。'};
  const result={text:complete.result._meta['codebuddy.ai'].lastAssistantText,model:approvedModel(state.model??state.config?.model),modelEvidence:'session_configuration_at_recovery',requestId:complete.id.replace(/^bridge-request-/,''),stopReason:'end_turn',recovered:true};
  store.reconcileDelivered(worker.id,result,{kind:'native_response',requestId:result.requestId});
  if(run.cursor!==undefined)store.update(run.id,'paused',{error:null,question:null});
  return {verified:true,sessionId,text:result.text,message:run.cursor===undefined?'已核对原请求完成结果。旧任务缺少冻结的验收与附件记录，请人工确认产物；不会自动重做。':'已核对原请求完成结果，可点击继续，由 GPT 审核已保存结果。'};
 }finally{await desktop.browser.close();}
}
