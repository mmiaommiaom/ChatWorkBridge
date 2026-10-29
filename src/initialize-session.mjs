import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {connectDesktop,nativeRpc} from './workbuddy-desktop.mjs';
import {approvedModel} from './model-policy.mjs';
import {projectRoot,assertControlledPath} from './local-config.mjs';
import {assertNoPendingTask} from './onboarding.mjs';
import {bindingWasRelocated,archiveRelocatedBinding} from './session-relocation.mjs';

const samePath=(left,right)=>typeof left==='string'&&path.resolve(left).toLowerCase()===path.resolve(right).toLowerCase();
function failure(code,message){const error=new Error(message);error.code=code;return error;}
function validateBinding(binding,workspace,{relocated=false}={}){
  if(!binding||typeof binding.sessionId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(binding.sessionId)||(!relocated&&!samePath(binding.workspace,workspace))||(binding.mode!==undefined&&binding.mode!=='test'))throw failure('SESSION_BINDING_MISMATCH','已有测试会话绑定不属于此工作区，停止初始化。');
}
function validateSession(session,binding,{reused=false}={}){
  const id=session?.sessionId??session?.id;
  if(id!==binding.sessionId||!samePath(session?.cwd,binding.workspace))throw failure('SESSION_BINDING_MISMATCH','WorkBuddy 返回的会话标识或工作区与绑定不一致。');
  const model=approvedModel(session?.model??session?.config?.model);
  if(!reused&&model!==binding.model)throw failure('SESSION_BINDING_MISMATCH','WorkBuddy 返回的模型与绑定不一致。');
  if(!['idle','pending','completed','stopped'].includes(String(session?.status).toLowerCase())||session.isProcessing||session.pendingInputKind||session.pendingPermissions?.length||session.pendingQuestions?.length||session.hasActiveToolCalls)throw failure('SESSION_NOT_IDLE','专用会话尚未空闲，或正在等待用户输入。');
  return model;
}

/** Create or verify one dedicated test session. Never sends a model message. */
export async function initializeSession({connect=connectDesktop,rpc=nativeRpc,projectDir=projectRoot}={}){
  const root=assertControlledPath(projectDir);
  assertNoPendingTask(root,{allowSaved:true});
  const workspace=assertControlledPath(path.join(root,'workspaces/probe'));
  const bindingFile=assertControlledPath(path.join(root,'data/desktop-binding.json'));
  let existing=fs.existsSync(bindingFile)?JSON.parse(fs.readFileSync(bindingFile,'utf8')):null;
  const relocated=existing&&bindingWasRelocated(existing,root,'workspaces/probe');
  if(existing)validateBinding(existing,workspace,{relocated});
  // A failed connection must not leave a reserved binding that blocks first use.
  const {browser,page}=await connect({mode:'test'});
  let binding=existing,createdHere=false;
  const save=()=>{
    const temporary=assertControlledPath(bindingFile+'.'+randomUUID()+'.tmp');
    fs.writeFileSync(temporary,JSON.stringify(binding,null,2)+'\n',{flag:'wx'});
    fs.renameSync(temporary,bindingFile);
  };
  try{
    const active=await rpc(page,'daemon:getActiveSessions',[]);
    if(!Array.isArray(active)||active.length)throw failure('SESSION_NOT_IDLE','WorkBuddy 存在正在运行的任务，请完成后再初始化。');
    if(relocated){archiveRelocatedBinding(bindingFile);existing=null;binding=null;}
    if(existing){
      if(!['ready','completed_rpc'].includes(existing.stage)){
        let remoteSessionFound=null;
        try{remoteSessionFound=Boolean(await rpc(page,'session:get',[existing.sessionId]));}catch{}
        const error=failure('SESSION_INITIALIZATION_UNCERTAIN','上次会话初始化未确认完成。已保留原会话 ID，请先核验；不会自动重新创建。');
        error.sessionId=existing.sessionId;error.remoteSessionFound=remoteSessionFound;throw error;
      }
      binding={...existing,model:approvedModel(existing.model??existing.create?.config?.model)};
      const model=validateSession(await rpc(page,'session:get',[binding.sessionId]),binding,{reused:true});
      return {sessionId:binding.sessionId,workspace,model,stage:'ready',reused:true,messagesSent:0,modelInferenceRequested:false};
    }
    fs.mkdirSync(assertControlledPath(path.dirname(bindingFile)),{recursive:true});
    fs.mkdirSync(workspace,{recursive:true});
    binding={version:1,mode:'test',installationRoot:root,sessionId:randomUUID(),workspace,model:approvedModel('deepseek-v4.1-flash'),stage:'reserved',reservedAt:new Date().toISOString()};
    // Exclusive creation prevents two initialization processes reserving two IDs.
    fs.writeFileSync(bindingFile,JSON.stringify(binding,null,2)+'\n',{flag:'wx'});createdHere=true;
    const initialized=await rpc(page,'workspace:initialize',[{cwd:workspace}],45000);
    if(initialized?.success!==true)throw failure('SESSION_INITIALIZATION_REJECTED','WorkBuddy 拒绝初始化专用工作区。');
    binding.stage='creating';save();
    const create={cwd:workspace,sessionId:binding.sessionId,isPlayground:false,config:{model:binding.model}};
    const session=await rpc(page,'session:create',[create],45000);
    if((session?.sessionId??session?.id)!==binding.sessionId||!samePath(session?.cwd,workspace))throw failure('SESSION_BINDING_MISMATCH','新会话标识或目录与预留记录不一致。');
    binding.stage='created';save();
    await rpc(page,'session:rename',[binding.sessionId,'GPT 协作 · 专用测试会话']);
    await rpc(page,'session:updateConfig',[binding.sessionId,{model:binding.model}],45000);
    await rpc(page,'session:load',[binding.sessionId,{cwd:workspace,forceRendererHistoryReplay:true}],45000);
    validateSession(await rpc(page,'session:get',[binding.sessionId]),binding);
    binding.stage='ready';binding.initializedAt=new Date().toISOString();binding.messagesSent=0;save();
    return {sessionId:binding.sessionId,workspace,model:binding.model,stage:'ready',reused:false,messagesSent:0,modelInferenceRequested:false};
  }catch(error){
    if(createdHere){binding.stage='uncertain';binding.error=error.message;binding.failedAt=new Date().toISOString();save();}
    throw error;
  }finally{await browser?.close().catch(()=>{});}
}
