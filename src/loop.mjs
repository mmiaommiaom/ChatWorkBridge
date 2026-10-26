import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {BridgeStore} from './store.mjs';
import {connectGpt,browserStatus,sendGpt,commandText} from './chatgpt-web.mjs';
import {connectDesktop,loadWorkerBinding} from './workbuddy-desktop.mjs';
import {coordinatorPrompt,parseCommand} from './protocol.mjs';
import {prepareGptTab,rememberGptTab} from './gpt-tab.mjs';
import {dispatchWorkerText} from './model-router.mjs';
import {collect as collectAttachments,download as downloadAttachments} from './attachments.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
export async function runTextLoop(goal,{maxRounds=3,onProgress=()=>{},resumeRunId=null}={}){
  if(typeof goal!=='string'||!goal.trim()||goal.length>12000||!Number.isInteger(maxRounds)||maxRounds<1||maxRounds>3)throw new Error('Invalid text-only goal or round limit');
  const store=new BridgeStore(path.join(root,'data/bridge.sqlite'));
  let gpt,desktop,run,page,lease;
  try{
    lease=store.acquireRunner();
    store.recover();
    const unfinished=store.list().find(r=>!['done','failed','cancelled'].includes(r.state));
    if(unfinished&&unfinished.id!==resumeRunId)throw new Error('Existing run needs resume/reconciliation: '+unfinished.id+' '+unfinished.state);
    if(resumeRunId&&(!unfinished||unfinished.state==='uncertain'))throw new Error('Resume requires an existing reconciled run');
    gpt=await connectGpt();desktop=await connectDesktop();
    const context=gpt.browser.contexts()[0];
    const source=context.pages().find(p=>p.url().startsWith('https://chatgpt.com/'));
    if(!source||(await browserStatus(source)).loginRequired)throw new Error('Log in to ChatGPT in the E-drive test window first');
    const worker=loadWorkerBinding();
    if(resumeRunId){
      run=unfinished;
      if(run.goal!==goal||run.maxRounds!==maxRounds||run.workerSessionId!==worker.sessionId)throw new Error('Resume binding mismatch');
      for(const candidate of context.pages()){const cdp=await context.newCDPSession(candidate);const {targetInfo}=await cdp.send('Target.getTargetInfo');await cdp.detach();if(targetInfo.targetId===run.gptTargetId)page=candidate;}
      const lastReply=store.messages(run.id).filter(m=>m.direction==='gpt'&&m.state==='delivered').at(-1)?.result;
      const expectedUrl=lastReply?.url??run.gptUrl;
      if(!page||page.url()!==expectedUrl)throw new Error('Bound GPT tab changed or missing');
      if(expectedUrl!==run.gptUrl)run=store.update(run.id,run.state,{gptUrl:expectedUrl});
    }else{page=await prepareGptTab(context,store.list());}
    await page.waitForTimeout(1500);
    const initialStatus=await browserStatus(page);if(initialStatus.loginRequired||initialStatus.composerCount!==1)throw new Error('Fresh GPT test conversation not ready');
    const cdp=await context.newCDPSession(page);const target=await cdp.send('Target.getTargetInfo');await cdp.detach();
    run??=store.create(goal,{maxRounds,scope:worker.mode==='normal'?'normal WorkBuddy permissions; existing MCP and Skills; no C writes; approved models only':'text-only; no tools/files/commands',runtimeMode:worker.mode??'test',workerSessionId:worker.sessionId,gptTargetId:target.targetInfo.targetId,gptUrl:page.url()});
    const pauseRequested=()=>{
      const file=path.join(root,'data/pause-request.json');
      return fs.existsSync(file)&&JSON.parse(fs.readFileSync(file,'utf8')).runId===run.id;
    };
    const pause=()=>{store.update(run.id,'paused',{pausedAt:new Date().toISOString()});onProgress({runId:run.id,state:'paused'});return store.get(run.id);};
    onProgress({runId:run.id,state:run.state});
    const deadline=Date.now()+30*60*1000;
    let outgoing=(resumeRunId?store.messages(run.id).find(m=>m.direction==='gpt'&&m.step===0)?.payload.text:null)??coordinatorPrompt({runId:run.id,goal,maxRounds,mode:worker.mode??'test'}),replyTo=null;
    const usedCommands=new Set();
    for(let step=0;step<=maxRounds;step++){
      if(pauseRequested())return pause();
      if(Date.now()>deadline)throw new Error('Overall loop deadline exceeded');
      const g=store.prepare(run.id,step,'gpt',{text:outgoing});
      let response=g.state==='delivered'?g.result:null;
      if(!response){
      store.update(run.id,'waiting_gpt',{step});store.markSending(g.id);onProgress({runId:run.id,state:'waiting_gpt',step});
      try{response=await sendGpt(page,outgoing,{onReceipt:async receipt=>{store.update(run.id,'waiting_gpt',{gptUrl:receipt.url,gptUserMessageId:receipt.userMessageId});await rememberGptTab(page);}});
        const sources=await collectAttachments(page,{messageId:response.id,role:'assistant'});
        response.attachments=await downloadAttachments(page,sources,{runId:run.id});
        store.delivered(g.id,response);store.update(run.id,'waiting_gpt',{gptUrl:response.url,gptUserMessageId:response.userMessageId});await rememberGptTab(page);
      }
      catch(e){if(store.message(g.id).state==='sending'){if(response)store.delivered(g.id,{...response,attachmentError:e.message});else store.uncertain(g.id,e.message);}throw e;}
      }
      if(pauseRequested())return pause();
      const command=parseCommand(commandText(response),{runId:run.id,replyToResultId:replyTo});
      if(usedCommands.has(command.commandId))throw new Error('Repeated GPT command ID');usedCommands.add(command.commandId);
      if(command.action==='done'){
        if(step===0)throw new Error('GPT claimed done without any worker evidence');
        store.update(run.id,'done',{summary:command.summary??'',workerRounds:step,finishedAt:new Date().toISOString()});onProgress({runId:run.id,state:'done',step});return store.get(run.id);
      }
      if(command.action==='ask_user'){store.update(run.id,'needs_user',{question:command.summary??command.instruction??'GPT requests input'});return store.get(run.id);}
      if(step>=maxRounds)throw new Error('Worker round limit reached');
      const attachments=response.attachments??[];
      const w=store.prepare(run.id,step,'workbuddy',{command,sessionId:worker.sessionId,...(attachments.length?{attachments}:{})});
      let result=w.state==='delivered'?w.result:null;
      if(!result){
      store.update(run.id,'waiting_workbuddy',{commandId:command.commandId});store.markSending(w.id);onProgress({runId:run.id,state:'waiting_workbuddy',step});
      try{result=await dispatchWorkerText(desktop.page,{sessionId:worker.sessionId,requestId:w.id,instruction:command.instruction,attachments});store.delivered(w.id,result);}
      catch(e){store.uncertain(w.id,e.message);throw e;}
      }
      replyTo=w.id;
      const dir=path.join(root,'artifacts',run.id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,`worker-${step+1}.json`),JSON.stringify(result,null,2)+'\n');
      outgoing=JSON.stringify({kind:'workbuddy_result',runId:run.id,resultId:replyTo,commandId:command.commandId,status:'completed',evidence:{model:result.model,streamAgrees:result.streamAgrees,toolCallCount:result.toolCallCount},text:result.text})+'\n请根据实际结果决定下一步，只输出约定的 bridge-command 块。';
    }
    throw new Error('Loop ended without coordinator decision');
  }catch(e){if(run)store.update(run.id,store.messages(run.id).some(m=>m.state==='uncertain')?'uncertain':'failed',{error:e.message});throw e;}
  finally{await gpt?.browser.close().catch(()=>{});await desktop?.browser.close().catch(()=>{});if(lease)store.releaseRunner(lease);store.close();}
}
