import {chromium} from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {approvedModel,providerFailure} from './model-policy.mjs';
import {loadConfig,expectedRendererPrefix} from './local-config.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const testWorkspace=path.join(root,'workspaces/probe');
export function runtimeMode(){const file=path.join(root,'config/active-runtime.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).mode:'test';}
export function loadWorkerBinding(){
  const mode=runtimeMode();if(!['test','normal'].includes(mode))throw Error('Unknown runtime mode');
  const binding=JSON.parse(fs.readFileSync(path.join(root,'data',mode==='normal'?'normal-binding.json':'desktop-binding.json'),'utf8'));
  const expected=mode==='normal'?path.join(testWorkspace,'normal'):testWorkspace;
  if(!['ready','completed_rpc'].includes(binding.stage)||typeof binding.sessionId!=='string'||!binding.sessionId||path.resolve(binding.workspace??'')!==expected||(mode==='normal'&&binding.mode!=='normal'))throw Error('Worker session is not initialized or its binding changed; run initialize-session or reconcile prior initialization');
  return binding;
}
export async function connectDesktop({mode=runtimeMode()}={}){
  if(!['test','normal'].includes(mode))throw Error('Unknown runtime mode');
  const state=JSON.parse(fs.readFileSync(new URL(mode==='normal'?'../data/normal-launch.json':'../data/native-launch.json',import.meta.url),'utf8'));
  const config=loadConfig();
  const port=mode==='normal'?config.ports.normalWorkbuddy:config.ports.workbuddy;
  if(state.exitedAt||!state.pid||state.port!==port)throw new Error('No owned live desktop launcher record');
  if(mode==='normal'&&(!config.allowNormalProfile||!config.workbuddyProfile||path.resolve(state.profile)!==config.workbuddyProfile))throw Error('Unexpected or unauthorized daily profile');
  if(mode==='test'&&path.resolve(state.profile)!==config.testProfile)throw Error('Unexpected test profile');
  process.kill(state.pid,0);
  const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{timeout:10000});
  const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url().split('?')[0]===expectedRendererPrefix(config));
  if(pages.length!==1){await browser.close();throw new Error('Expected exactly one WorkBuddy test renderer');}
  return {browser,page:pages[0],state,mode};
}

// Protocol independently implemented from the installed application's observed
// preload transport contract. No code copied from unlicensed reference repos.
export async function readNative(page,channel,args=[]){
  if(!['config:getProductConfiguration','daemon:getActiveSessions'].includes(channel))throw new Error('P0 read-only channel not allowed');
  return nativeRpc(page,channel,args);
}

export async function nativeRpc(page,channel,args=[],timeoutMs=15000){
  const readOnly=['config:getProductConfiguration','daemon:getActiveSessions','mcp:list','mcp:describe','mcp:refresh'];
  if(['mcp:approve','mcp:connect'].includes(channel))throw Error('Approve and connect MCP in WorkBuddy itself; historical machine approvals are not portable');
  if(!readOnly.includes(channel)){
    const registryFile=path.join(root,'data/capability-bindings.json');
    const registry=fs.existsSync(registryFile)?JSON.parse(fs.readFileSync(registryFile,'utf8')):[];
    const cap=registry.find(b=>b.sessionId===(channel==='session:create'?args[0]?.sessionId:args[0]));
    if(cap){
      if(!path.resolve(cap.workspace).startsWith(path.join(root,'workspaces/probe')+path.sep))throw Error('Capability workspace outside probe');
      if(channel==='session:create'){
        if(JSON.stringify(args)!==JSON.stringify([cap.create]))throw Error('Capability create scope mismatch');
        approvedModel(cap.create.config.model);
      }else if(channel==='session:updateConfig'){
        if(Object.keys(args[1]??{}).length!==1)throw Error('Only model patch allowed');approvedModel(args[1].model);
      }else if(!['session:get','session:load','session:sendMessage','session:rename','session:cancel','session:rejectPermission'].includes(channel))throw Error('Capability channel not allowed');
    }else{
    const binding=JSON.parse(fs.readFileSync(path.join(root,'data/desktop-binding.json'),'utf8'));
    if(binding.workspace!==testWorkspace)throw new Error('P0 workspace binding mismatch');
    if(channel==='workspace:initialize'){
      if(args.length!==1||args[0]?.cwd!==testWorkspace)throw new Error('Invalid workspace initialization');
    }else if(channel==='session:create'){
      if(args.length!==1||args[0]?.sessionId!==binding.sessionId||args[0]?.cwd!==testWorkspace||args[0]?.isPlayground!==false)throw new Error('Invalid P0 session');
      if(args[0].config!==undefined){if(Object.keys(args[0].config??{}).length!==1||!args[0].config.model)throw Error('Only an approved model is allowed while initializing');approvedModel(args[0].config.model);}
    }else{
      if(!['session:get','session:load','session:updateConfig','session:sendMessage','session:rename'].includes(channel)||args[0]!==binding.sessionId)throw new Error('P0 native operation outside binding');
      if(channel==='session:updateConfig'){if(Object.keys(args[1]??{}).length!==1)throw Error('Only model patch allowed');approvedModel(args[1].model);}
    }
    }
  }
  return page.evaluate(({channel,args,timeoutMs})=>new Promise((resolve,reject)=>{
    const id='bridge-read-'+crypto.randomUUID();
    const pair=new MessageChannel();
    const port=pair.port1;
    let settled=false;
    const timer=setTimeout(()=>finish(new Error('Native RPC timeout; outcome may be uncertain')),timeoutMs);
    function finish(error,value){if(settled)return;settled=true;clearTimeout(timer);port.close();error?reject(error):resolve(value);}
    port.onmessage=event=>{
      const payload=event.data;
      if(payload?.kind==='open'){port.postMessage({kind:'message',text:JSON.stringify({id,type:'request',channel,args})});return;}
      if(payload?.kind==='error'||payload?.kind==='close'){finish(new Error('Native transport closed or failed'));return;}
      if(payload?.kind!=='message')return;
      try{const reply=payload.json??JSON.parse(payload.text);if(reply.id!==id)return;if(reply.type==='error'||reply.error)finish(new Error('PROVIDER_ERROR '+JSON.stringify(reply.error??{message:reply.message??'Native RPC error'})));else finish(null,reply.result);}catch(e){finish(e);}
    };
    port.onmessageerror=()=>finish(new Error('Native transport decoding error'));
    port.start();
    window.postMessage({type:'workbuddy:open-local-daemon-transport-port',target:{transportType:'local'}},'*',[pair.port2]);
  }),{channel,args,timeoutMs});
}

export async function observeSession(page,sessionId){
  await page.evaluate(async sid=>{
    if(globalThis.__chatWorkObserver){if(globalThis.__chatWorkObserver.sid===sid&&globalThis.__chatWorkObserver.revision===2)return;globalThis.__chatWorkObserver.port.close();}
    const channel=new MessageChannel();
    const observer={sid,revision:2,events:[],bytes:0,overflow:false,port:channel.port1,opened:false};
    globalThis.__chatWorkObserver=observer;
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Observer connection timeout')),10000);
      channel.port1.onmessage=({data})=>{
        if(data?.kind==='open'){observer.opened=true;clearTimeout(timer);resolve();return;}
        if(data?.kind!=='message')return;
        try{const packet=data.json??JSON.parse(data.text);if(packet.type==='event'&&packet.channel==='session:event:'+sid&&packet.result?.update?.sessionUpdate!=='agent_thought_chunk'){const size=JSON.stringify(packet).length;if(observer.events.length>=20000||observer.bytes+size>4*1024*1024){observer.overflow=true;return;}observer.events.push(packet);observer.bytes+=size;}}catch{}
      };
      channel.port1.start();
      window.postMessage({type:'workbuddy:open-local-daemon-transport-port',target:{transportType:'local'}},'*',[channel.port2]);
    });
  },sessionId);
}

export async function sessionEvents(page){return page.evaluate(()=>globalThis.__chatWorkObserver?.events??[]);}

export async function sendWorkerText(page,{sessionId,requestId,instruction,attachments=[]}){
  const binding=loadWorkerBinding();const normal=binding.mode==='normal'&&binding.sessionId===sessionId;
  const before=await nativeRpc(page,'session:get',[sessionId]);
  const active=await nativeRpc(page,'daemon:getActiveSessions',[]);
  if(!['completed','idle','stopped','pending'].includes(String(before?.status).toLowerCase())||before.isProcessing||before.pendingInputKind||before.pendingPermissions?.length||before.pendingQuestions?.length||before.hasActiveToolCalls||!Array.isArray(active)||active.some(s=>(s.sessionId??s.id)===sessionId))throw new Error('Worker not confirmed idle or needs user input');
  const selected=approvedModel(before.model??before.config?.model);
  await observeSession(page,sessionId);
  await page.evaluate(()=>{const o=globalThis.__chatWorkObserver;o.events=[];o.bytes=0;o.overflow=false;});
  const prompt=(normal?'这是用户授权的 GPT 与日常 WorkBuddy 协作。按任务使用现有 MCP、Skill 和正常工具权限；不写 C 盘。模型仅限用户批准的三个免费模型，其他模型须申请。不要仅描述计划，需要实际执行并报告证据。\n':'这是 ChatWorkBridge 通信测试。只做文本推理，禁止修改文件或执行命令；可以阅读明确附带的参考附件。\n')+'以下是协调者任务：\n'+instruction;
  const {nativeBlocks}=await import('./attachments.mjs');
  const result=await nativeRpc(page,'session:sendMessage',[sessionId,[{type:'text',text:prompt},...nativeBlocks(attachments)],{'codebuddy.ai':{requestId,userMessageId:requestId,messageRequestId:requestId,emitSyntheticUserPromptLive:true}}],180000);
  if(await page.evaluate(()=>globalThis.__chatWorkObserver?.overflow))throw new Error('Native event capture exceeded limit; no automatic resend');
  const events=await sessionEvents(page);
  const messages=events.filter(e=>e.result?.update?.sessionUpdate==='agent_message_chunk'&&e.result.update._meta?.['codebuddy.ai/messageRequestId']===requestId);
  const seen=new Set();const unique=messages.filter(e=>!seen.has(e.id)&&seen.add(e.id));
  const streamed=unique.map(e=>e.result.update.content?.text??'').join('');
  const answer=result?._meta?.['codebuddy.ai']?.lastAssistantText;
  const models=[...new Set(unique.map(e=>e.result.update._meta?.['codebuddy.ai/responseModelId']).filter(Boolean))];
  const toolEvents=events.filter(e=>/^tool_call/.test(e.result?.update?.sessionUpdate??''));
  const failure=providerFailure(result);
  if(failure){
    const state=await nativeRpc(page,'session:get',[sessionId]);
    const running=await nativeRpc(page,'daemon:getActiveSessions',[]);
    failure.safeToRetry=toolEvents.length===0&&!streamed&&['completed','idle','stopped'].includes(String(state?.status).toLowerCase())&&Array.isArray(running)&&!running.some(s=>(s.sessionId??s.id)===sessionId);
    throw failure;
  }
  if(typeof answer!=='string'||!answer||answer!==streamed||result?.stopReason!=='end_turn'||(!normal&&toolEvents.length)||models.length!==1||models[0]!==selected)throw new Error('Desktop response, model or tool-scope evidence failed verification');
  return {text:answer,model:models[0],streamAgrees:true,eventCount:events.length,toolCallCount:toolEvents.length,stopReason:result.stopReason,userMessageId:result.userMessageId};
}
