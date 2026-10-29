import {chromium} from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {approvedModel,providerFailure} from './model-policy.mjs';
import {loadConfig,expectedRendererPrefix,assertControlledPath} from './local-config.mjs';
import {requestOnPage,transportSnapshot} from './native-transport.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const testWorkspace=path.join(root,'workspaces/probe');
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
export function validateDesktopState(state,config,mode){
  if(!['test','normal'].includes(mode))throw Error('Unknown runtime mode');
  const port=mode==='normal'?config.ports.normalWorkbuddy:config.ports.workbuddy;
  if(!state||state.exitedAt||!Number.isInteger(state.pid)||state.pid<1||state.port!==port||!samePath(state.exe,config.workbuddyExe))throw Error('No owned live desktop launcher record for the configured application');
  if(mode==='normal'&&(!config.allowNormalProfile||!config.workbuddyProfile||!samePath(state.profile,config.workbuddyProfile)||!samePath(state.config,config.workbuddyConfigDir)))throw Error('Unexpected or unauthorized daily profile');
  if(mode==='test'&&!samePath(state.profile,config.testProfile))throw Error('Unexpected test profile');
  if(!config.allowNativeRuntimeRecords)throw Error('WorkBuddy native runtime records are not authorized');
  return port;
}
export function runtimeMode(){const file=path.join(root,'config/active-runtime.json');return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).mode:'test';}
export function loadWorkerBinding(sessionId){
  const mode=runtimeMode();if(!['test','normal'].includes(mode))throw Error('Unknown runtime mode');
  let binding=JSON.parse(fs.readFileSync(path.join(root,'data',mode==='normal'?'normal-binding.json':'desktop-binding.json'),'utf8'));
  if(sessionId&&sessionId!==binding.sessionId){
    const registry=JSON.parse(fs.readFileSync(path.join(root,'data/capability-bindings.json'),'utf8'));
    binding=registry.find(b=>b.sessionId===sessionId&&b.taskRunId&&b.mode===mode);
    if(!binding||binding.stage!=='ready'||!assertControlledPath(binding.workspace).startsWith(path.join(testWorkspace,path.sep)))throw Error('Task worker binding is not ready');
    return binding;
  }
  const expected=mode==='normal'?path.join(testWorkspace,'normal'):testWorkspace;
  if(!['ready','completed_rpc'].includes(binding.stage)||typeof binding.sessionId!=='string'||!binding.sessionId||path.resolve(binding.workspace??'')!==expected||(mode==='normal'&&binding.mode!=='normal'))throw Error('Worker session is not initialized or its binding changed; run initialize-session or reconcile prior initialization');
  return binding;
}
export async function connectDesktop({mode=runtimeMode()}={}){
  if(!['test','normal'].includes(mode))throw Error('Unknown runtime mode');
  const state=JSON.parse(fs.readFileSync(new URL(mode==='normal'?'../data/normal-launch.json':'../data/native-launch.json',import.meta.url),'utf8'));
  const config=loadConfig();
  const port=validateDesktopState(state,config,mode);
  process.kill(state.pid,0);
  const browser=await chromium.connectOverCDP('http://127.0.0.1:'+port,{noDefaults:true,timeout:10000});
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
  const readOnly=['config:getProductConfiguration','daemon:getActiveSessions','mcp:list','skill:list','expert:getActivePlugins'];
  const safeProbe=channel==='mcp:callTool'&&args.length===1&&args[0]?.toolName==='mcp__blender__get_addon_status'&&Object.keys(args[0]?.args??{}).length===0;
  if(['mcp:approve','mcp:connect'].includes(channel))throw Error('Approve and connect MCP in WorkBuddy itself; historical machine approvals are not portable');
  if(!readOnly.includes(channel)&&!safeProbe){
    const registryFile=path.join(root,'data/capability-bindings.json');
    const registry=fs.existsSync(registryFile)?JSON.parse(fs.readFileSync(registryFile,'utf8')):[];
    const cap=registry.find(b=>b.sessionId===(channel==='session:create'?args[0]?.sessionId:args[0]));
    if(cap){
      if(!assertControlledPath(cap.workspace).startsWith(path.join(root,'workspaces/probe')+path.sep))throw Error('Capability workspace outside probe');
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
  return requestOnPage(page,channel,args,timeoutMs);
}

export async function observeSession(page,sessionId){
  await nativeRpc(page,'session:get',[sessionId]);
}

export async function sessionEvents(page,sessionId){return (await transportSnapshot(page,sessionId)).events??[];}

export async function sendWorkerText(page,{sessionId,requestId,instruction,attachments=[],onActivity=()=>{}}){
  const binding=loadWorkerBinding(sessionId);const normal=binding.mode==='normal'&&binding.sessionId===sessionId;
  if(sessionId!==binding.sessionId)throw Error('Requested worker session differs from the active binding');
  const before=await nativeRpc(page,'session:get',[sessionId]);
  if((before?.sessionId??before?.id)!==sessionId||!samePath(before?.cwd,binding.workspace))throw Error('Worker identity or workspace changed; no message sent');
  const active=await nativeRpc(page,'daemon:getActiveSessions',[]);
  if(!['completed','idle','stopped','pending'].includes(String(before?.status).toLowerCase())||before.isProcessing||before.pendingInputKind||before.pendingPermissions?.length||before.pendingQuestions?.length||before.hasActiveToolCalls||!Array.isArray(active)||active.some(s=>(s.sessionId??s.id)===sessionId))throw new Error('Worker not confirmed idle or needs user input');
  const selected=approvedModel(before.model??before.config?.model);
  await observeSession(page,sessionId);
  const prompt=(normal?'这是用户授权的 GPT 与日常 WorkBuddy 协作。按任务使用现有 MCP、Skill 和正常工具权限；不写 C 盘，不隐藏执行 PowerShell。模型仅限用户批准的三个免费模型，其他模型须申请。不要仅描述计划，需要实际执行并报告证据。缺少必需能力、图片或权限时停止并说明，不得用文字猜测替代参考图。产物保存到当前任务目录。若协调者给出另一个输出目录，停止并报告目录冲突；参考源文件可以只读访问。最终回复附上 bridge-artifacts JSON 代码块，内容为 {"files":["实际产物绝对路径"]}，最多十个文件。\n':'这是 ChatWorkBridge 通信测试。只做文本推理，禁止修改文件或执行命令；可以阅读明确附带的参考附件。\n')+'当前任务目录：'+binding.workspace+'\n参考附件：'+JSON.stringify(attachments.map(a=>({path:a.path,mimeType:a.mimeType,sha256:a.sha256,size:a.size})))+'\n以下是协调者任务：\n'+instruction;
  const {nativeBlocks}=await import('./attachments.mjs');
  const sequence=(await transportSnapshot(page,sessionId)).events?.at(-1)?.bridgeSequence??0;
  let monitoring=false,finished=false;
  const heartbeat=setInterval(async()=>{
    if(monitoring||finished)return;monitoring=true;
    try{const remote=await nativeRpc(page,'session:get',[sessionId]);if(!finished)onActivity({sessionId,requestId,state:'waiting_workbuddy',remoteStatus:remote.status,pendingInputKind:remote.pendingInputKind,needsUser:Boolean(remote.pendingInputKind||remote.pendingPermissions?.length||remote.pendingQuestions?.length),at:new Date().toISOString()});}catch{}finally{monitoring=false;}
  },5000);heartbeat.unref?.();
  let result;try{result=await nativeRpc(page,'session:sendMessage',[sessionId,[{type:'text',text:prompt},...nativeBlocks(attachments)],{'codebuddy.ai':{requestId,userMessageId:requestId,messageRequestId:requestId,emitSyntheticUserPromptLive:true}}],0);}finally{finished=true;clearInterval(heartbeat);}
  const events=(await sessionEvents(page,sessionId)).filter(e=>e.bridgeSequence>sequence);
  const messages=events.filter(e=>e.result?.update?.sessionUpdate==='agent_message_chunk'&&e.result.update._meta?.['codebuddy.ai/messageRequestId']===requestId);
  const unique=messages;
  const streamed=unique.map(e=>e.result.update.content?.text??'').join('');
  const answer=result?._meta?.['codebuddy.ai']?.lastAssistantText;
  const models=[...new Set(unique.map(e=>e.result.update._meta?.['codebuddy.ai/responseModelId']).filter(Boolean))];
  const toolEvents=events.filter(e=>/^tool_call/.test(e.result?.update?.sessionUpdate??''));
  const failure=providerFailure(result);
  if(failure){
    const state=await nativeRpc(page,'session:get',[sessionId]);
    const running=await nativeRpc(page,'daemon:getActiveSessions',[]);
    failure.safeToRetry=toolEvents.length===0&&!streamed&&['completed','idle','stopped'].includes(String(state?.status).toLowerCase())&&!state?.isProcessing&&!state?.pendingInputKind&&!state?.pendingPermissions?.length&&!state?.pendingQuestions?.length&&!state?.hasActiveToolCalls&&Array.isArray(running)&&!running.some(s=>(s.sessionId??s.id)===sessionId);
    throw failure;
  }
  if(typeof answer!=='string'||!answer||result?.stopReason!=='end_turn'||(!normal&&toolEvents.length)||models.some(model=>model!==selected))throw new Error('Desktop response, model or tool-scope evidence failed verification');
  return {text:answer,model:models[0]??selected,modelEvidence:models.length?'response_events':'approved_session_config',streamAgrees:answer===streamed,eventCount:events.length,toolCallCount:new Set(toolEvents.map(e=>e.result?.update?.toolCallId).filter(Boolean)).size,stopReason:result.stopReason,userMessageId:result.userMessageId,requestId};
}
