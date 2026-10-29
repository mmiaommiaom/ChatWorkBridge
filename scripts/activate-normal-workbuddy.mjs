import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadConfig,projectRoot,assertControlledPath} from '../src/local-config.mjs';
import {connectDesktop,nativeRpc} from '../src/workbuddy-desktop.mjs';
import {approvedModel} from '../src/model-policy.mjs';
import {assertNoPendingTask,connectionFingerprint} from '../src/onboarding.mjs';
import {bindingWasRelocated,archiveRelocatedBinding} from '../src/session-relocation.mjs';

const samePath=(a,b)=>typeof a==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const read=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
function failure(code,message){return Object.assign(new Error(message),{code});}
function writeJson(file,value){
 const tmp=assertControlledPath(file+'.'+randomUUID()+'.tmp');
 fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});fs.renameSync(tmp,file);
}
function checkSession(session,binding,{expectedModel}={}){
 if((session?.sessionId??session?.id)!==binding.sessionId||!samePath(session?.cwd,binding.workspace))throw failure('SESSION_BINDING_MISMATCH','日常协作会话的标识或工作目录不匹配，已停止接入。');
 const model=approvedModel(session.model??session.config?.model);
 if(expectedModel&&model!==expectedModel)throw failure('SESSION_BINDING_MISMATCH','新建会话的模型未确认，已停止接入。');
 if(!['idle','pending','completed','stopped'].includes(String(session.status).toLowerCase())||session.isProcessing||session.pendingInputKind||session.pendingPermissions?.length||session.pendingQuestions?.length||session.hasActiveToolCalls)throw failure('SESSION_NOT_IDLE','日常协作会话正在执行或等待你的确认，请先完成当前操作。');
 return model;
}

/** Connect an approved daily profile's dedicated session; never sends a model message. */
export async function activateNormal({connect=connectDesktop,rpc=nativeRpc,projectDir=projectRoot,configLoader=loadConfig}={}){
 const root=assertControlledPath(projectDir),local=configLoader({checkExecutables:true});
 if(!local.allowNormalProfile||!local.allowNativeRuntimeRecords)throw Error('请先明确允许日常配置和 WorkBuddy 自身的运行记录。');
 assertNoPendingTask(root,{allowSaved:true});
 const workspace=assertControlledPath(path.join(root,'workspaces/probe/normal'));
 const bindingFile=assertControlledPath(path.join(root,'data/normal-binding.json'));
 const registryFile=assertControlledPath(path.join(root,'data/capability-bindings.json'));
 let binding=read(bindingFile),createdHere=false;
 const relocated=binding&&bindingWasRelocated(binding,root,'workspaces/probe/normal');
 const reused=Boolean(binding)&&!relocated;
 if(binding&&(binding.mode!=='normal'||typeof binding.sessionId!=='string'||!/^[a-zA-Z0-9-]{1,100}$/.test(binding.sessionId)||(!relocated&&!samePath(binding.workspace,workspace))))throw failure('SESSION_BINDING_MISMATCH','已有日常会话绑定不属于此工作区。');
 const {browser,page}=await connect({mode:'normal'});
 try{
  const active=await rpc(page,'daemon:getActiveSessions',[]);
  if(!Array.isArray(active)||active.length)throw failure('SESSION_NOT_IDLE','日常 WorkBuddy 有正在运行的任务，等待完成后再接入。');
  if(relocated){archiveRelocatedBinding(bindingFile);binding=null;}
  let model;
  if(binding){
   if(binding.stage!=='ready')throw failure('SESSION_INITIALIZATION_UNCERTAIN','上次日常会话初始化尚未确认。保留原会话 ID，请先核验，不会自动创建第二个会话。');
   model=checkSession(await rpc(page,'session:get',[binding.sessionId]),binding);
  }else{
   fs.mkdirSync(assertControlledPath(path.join(root,'data')),{recursive:true});
   fs.mkdirSync(workspace,{recursive:true});
   const sessionId=randomUUID();model=approvedModel('deepseek-v4.1-flash');
   const create={cwd:workspace,sessionId,isPlayground:false,config:{model}};
   binding={version:1,mode:'normal',installationRoot:root,sessionId,workspace,create,model,stage:'reserved',createdAt:new Date().toISOString()};
   fs.writeFileSync(bindingFile,JSON.stringify(binding,null,2)+'\n',{flag:'wx'});createdHere=true;
   const registry=read(registryFile)??[];
   if(!Array.isArray(registry)||registry.some(item=>item.sessionId===sessionId))throw Error('会话登记表无效，未请求创建。');
   registry.push(binding);writeJson(registryFile,registry);
   binding.stage='creating';writeJson(bindingFile,binding);
   const session=await rpc(page,'session:create',[create],45000);
   if((session?.sessionId??session?.id)!==sessionId||!samePath(session?.cwd,workspace))throw failure('SESSION_BINDING_MISMATCH','WorkBuddy 返回的新会话目录或标识不一致。');
   binding.stage='created';writeJson(bindingFile,binding);
   await rpc(page,'session:rename',[sessionId,'GPT 协作 · 日常配置']);
   await rpc(page,'session:load',[sessionId,{cwd:workspace,forceRendererHistoryReplay:true}],45000);
   checkSession(await rpc(page,'session:get',[sessionId]),binding,{expectedModel:model});
   binding.stage='ready';binding.initializedAt=new Date().toISOString();writeJson(bindingFile,binding);
  }
  const mcp=await rpc(page,'mcp:list',[]);
  if(!Array.isArray(mcp))throw Error('WorkBuddy 的 MCP 列表无法核对，未切换运行模式。');
  fs.mkdirSync(assertControlledPath(path.join(root,'config')),{recursive:true});
  writeJson(assertControlledPath(path.join(root,'data/normal-activation.json')),{activatedAt:new Date().toISOString(),sessionId:binding.sessionId,profile:local.workbuddyProfile,model,mcp:mcp.map(m=>({name:m.name,enabled:m.enabled,state:m.state})),permissions:'Inherited from daily profile; no bypass flag'});
  writeJson(assertControlledPath(path.join(root,'config/active-runtime.json')),{mode:'normal',configurationHash:connectionFingerprint(local),activatedAt:new Date().toISOString()});
  return {message:'日常 WorkBuddy 已接入，沿用现有 MCP 和 Skill。尚未发送任务。',sessionId:binding.sessionId,workspace,model,stage:'ready',reused,messagesSent:0,modelInferenceRequested:false};
 }catch(error){
  if(createdHere&&binding.stage!=='ready'){binding.stage='uncertain';binding.error=error.message;binding.failedAt=new Date().toISOString();writeJson(bindingFile,binding);}
  throw error;
 }finally{await browser?.close().catch(()=>{});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 activateNormal().then(result=>console.log(result.message)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
