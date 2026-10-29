import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {BridgeStore} from './store.mjs';
import {connectGpt,browserStatus,sendGpt,commandText} from './chatgpt-web.mjs';
import {connectDesktop,loadWorkerBinding} from './workbuddy-desktop.mjs';
import {prepareGptTab,rememberGptTab,targetId,resolveRunTab} from './gpt-tab.mjs';
import {dispatchWorkerText} from './model-router.mjs';
import {collect,download,workerArtifacts} from './attachments.mjs';
import {driveRun} from './workflow.mjs';
import {checkRequirements} from './capability-preflight.mjs';
import {ensureTaskWorker} from './task-worker.mjs';
import {assertControlledPath} from './local-config.mjs';
export {verifiedCoordinatorAttachments} from './workflow.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
export async function runTextLoop(goal,{onProgress=()=>{},resumeRunId=null,stateFile=null,initialAttachments=[]}={}){
 if(typeof goal!=='string'||!goal.trim()||goal.length>12000)throw Error('Invalid goal');
 if(stateFile){stateFile=assertControlledPath(stateFile);const relative=path.relative(path.join(root,'runtime/test-runs'),stateFile);if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Test state must stay inside runtime/test-runs');}
 const store=new BridgeStore(stateFile??path.join(root,'data/bridge.sqlite'));
 let gpt,desktop,run,page,lease;
 try{
  lease=store.acquireRunner();store.recover(lease);
  const unfinished=resumeRunId?store.get(resumeRunId):null;
  if(store.list().some(r=>r.id!==resumeRunId&&r.state==='uncertain'))throw Error('另一个工作结果待核验，请先检查中断状态；不会自动重发。');
  if(resumeRunId&&(!unfinished||unfinished.id!==resumeRunId||!['paused','needs_user'].includes(unfinished.state)||store.messages(unfinished.id).some(m=>['sending','uncertain'].includes(m.state))))throw Error('Resume requires verified task state');
  gpt=await connectGpt();desktop=await connectDesktop();
  const context=gpt.browser.contexts()[0],base=loadWorkerBinding();
  if(resumeRunId){
   run=unfinished;
   if(run.runtimeMode!==(base.mode??'test'))throw Error('Resume runtime mode differs from the saved task');
   if(run.cursor===undefined)throw Error('Legacy task requires result reconciliation; will not replay old commands');
   const binding=await resolveRunTab(context,run,store.messages(run.id));page=binding.page;
   if(binding.targetId!==run.gptTargetId||binding.url!==run.gptUrl){run=store.update(run.id,run.state,{gptTargetId:binding.targetId,gptUrl:binding.url,gptRebindings:[...(run.gptRebindings??[]),{from:binding.priorTargetId,to:binding.targetId,at:new Date().toISOString(),verified:'latest_delivered_message_pair'}]});await rememberGptTab(page);}
  }else if(stateFile){page=context.pages().find(p=>p.url()==='https://chatgpt.com/')??await context.newPage();await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:45000});}
  else page=await prepareGptTab(context,store.list());
  await page.locator('#prompt-textarea:visible,textarea#mobile-composer-prompt:visible,[contenteditable=true][role=textbox]:visible').first().waitFor({state:'visible',timeout:45000});
  const status=await browserStatus(page);
  if(status.loginRequired||status.composerCount!==1)throw Error('GPT conversation not ready');
  run??=store.create(goal,{cursor:0,workerRounds:0,references:initialAttachments,nextAttachments:initialAttachments,scope:base.mode==='normal'?'normal tools; no C writes; approved models only':'text-only',runtimeMode:base.mode??'test',gptTargetId:await targetId(page),gptUrl:page.url()});
  const pauseRequested=()=>{try{return JSON.parse(fs.readFileSync(path.join(root,'data/pause-request.json'),'utf8')).runId===run.id;}catch{return false;}};
  return await driveRun({store,runId:run.id,pauseRequested,onProgress,
   coordinator:async(payload,message)=>{
    let response;
    try{
     const known=new Set(store.messages(run.id).filter(m=>m.direction==='gpt'&&m.state==='delivered'&&m.result?.url===page.url()).flatMap(m=>(m.result.uploadedAttachments??[]).map(a=>a.sha256+':'+a.name)));
     const uploads=(payload.attachments??[]).filter(a=>!known.has(a.sha256+':'+a.name));
     response=await sendGpt(page,payload.text,{attachments:uploads,onReceipt:async receipt=>{store.update(run.id,'waiting_gpt',{gptUrl:receipt.url,gptUserMessageId:receipt.userMessageId});await rememberGptTab(page);}});
     response.commandText=commandText(response);
     const sources=await collect(page,{messageId:response.id,role:'assistant'});
     response.attachments=await download(page,sources,{runId:run.id});
     await rememberGptTab(page);return response;
    }catch(e){if(response){response.attachmentError=e.message;response.attachments=[];store.delivered(message.id,response);}throw e;}
   },
   checkCapabilities:async current=>{
    const binding=await ensureTaskWorker(desktop.page,current,{base});
    store.update(run.id,store.get(run.id).state,{workerSessionId:binding.sessionId,workerWorkspace:binding.workspace,displayName:binding.displayName});
    return checkRequirements(desktop.page,current.requirements??[],{workspace:binding.workspace,confirmations:current.capabilityConfirmations??[]});
   },
   worker:async(payload,message)=>{
    let current=store.get(run.id);
    const binding=await ensureTaskWorker(desktop.page,current,{base});
    store.update(run.id,'waiting_workbuddy',{workerSessionId:binding.sessionId,workerWorkspace:binding.workspace,displayName:binding.displayName});
    return dispatchWorkerText(desktop.page,{sessionId:binding.sessionId,requestId:message.id,instruction:payload.command.instruction+'\n固定验收标准：'+JSON.stringify(current.acceptance),attachments:payload.attachments,onActivity:activity=>{if(store.get(run.id).state==='waiting_workbuddy')store.update(run.id,'waiting_workbuddy',{workerActivity:activity,question:activity.needsUser?'WorkBuddy 正在等待授权或输入。请到其原任务处理，桥接会继续监听；不会取消或重发。':null});}});
   },
   artifacts:(result,current)=>workerArtifacts(result.text,{workspace:current.workerWorkspace})
  });
 }catch(e){
  if(run){
   const uncertain=store.messages(run.id).some(m=>['sending','uncertain'].includes(m.state));
   store.update(run.id,uncertain?'uncertain':'needs_user',{error:e.message,question:uncertain?'发送或结果待核验；不会自动重发，请检查中断状态。':e.message,waitReason:uncertain?'reconciliation':'error'});
  }
  throw e;
 }finally{
  await gpt?.browser.close().catch(()=>{});await desktop?.browser.close().catch(()=>{});
  if(lease)store.releaseRunner(lease);store.close();
 }
}
export async function recheckRunCapabilities(run,{connect=connectDesktop}={}){
 const desktop=await connect();try{return await checkRequirements(desktop.page,run.requirements??[],{workspace:run.workerWorkspace??loadWorkerBinding().workspace,confirmations:run.capabilityConfirmations??[]});}finally{await desktop.browser.close();}
}
