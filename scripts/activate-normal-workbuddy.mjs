import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {loadConfig,projectRoot,assertControlledPath} from '../src/local-config.mjs';
import {connectDesktop,nativeRpc} from '../src/workbuddy-desktop.mjs';import {approvedModel} from '../src/model-policy.mjs';
const root=projectRoot,bindingFile=path.join(root,'data/normal-binding.json');
export async function activateNormal(){
 const local=loadConfig({checkExecutables:true});
 if(!local.allowNormalProfile||!local.allowNativeRuntimeRecords)throw Error('日常配置和原生系统运行记录尚未在 config/local.json 中明确允许。');
 for(const directory of [path.join(root,'data'),path.join(root,'config')])fs.mkdirSync(assertControlledPath(directory),{recursive:true});
 const {browser,page}=await connectDesktop({mode:'normal'});try{
  const active=await nativeRpc(page,'daemon:getActiveSessions',[]);if(!Array.isArray(active)||active.length)throw Error('日常 WorkBuddy 有正在运行的任务，等待完成后再接入。');
  let binding;
  if(fs.existsSync(bindingFile)){binding=JSON.parse(fs.readFileSync(bindingFile));if(binding.stage!=='ready')throw Error('正常会话上次接入结果不确定，请核验，不自动重建。');if(!await nativeRpc(page,'session:get',[binding.sessionId]))throw Error('正常会话不存在，需要核验。');}
  else{
   const workspace=assertControlledPath(path.join(root,'workspaces/probe/normal'));fs.mkdirSync(workspace,{recursive:true});
   const sessionId=randomUUID(),model=approvedModel('deepseek-v4.1-flash');const create={cwd:workspace,sessionId,isPlayground:false,config:{model}};
   binding={mode:'normal',sessionId,workspace,create,stage:'creating',createdAt:new Date().toISOString()};
   const registryFile=path.join(root,'data/capability-bindings.json'),registry=fs.existsSync(registryFile)?JSON.parse(fs.readFileSync(registryFile,'utf8')):[];registry.push(binding);fs.writeFileSync(registryFile,JSON.stringify(registry,null,2));fs.writeFileSync(bindingFile,JSON.stringify(binding,null,2));
   const result=await nativeRpc(page,'session:create',[create],45000);if(result.sessionId!==sessionId)throw Error('正常会话标识不一致');
   await nativeRpc(page,'session:rename',[sessionId,'GPT 协作 · 日常配置']);binding.stage='ready';fs.writeFileSync(bindingFile,JSON.stringify(binding,null,2));
  }
  await nativeRpc(page,'session:updateConfig',[binding.sessionId,{model:approvedModel('deepseek-v4.1-flash')}],45000);
  const session=await nativeRpc(page,'session:get',[binding.sessionId]);if(session.model!=='deepseek-v4.1-flash')throw Error('模型未确认，禁止派工');
  const mcp=await nativeRpc(page,'mcp:list',[]);
  fs.writeFileSync(path.join(root,'config/active-runtime.json'),JSON.stringify({mode:'normal',activatedAt:new Date().toISOString()},null,2));
  fs.writeFileSync(path.join(root,'data/normal-activation.json'),JSON.stringify({activatedAt:new Date().toISOString(),sessionId:binding.sessionId,profile:local.workbuddyProfile,model:session.model,mcp:mcp.map(m=>({name:m.name,enabled:m.enabled,state:m.state})),permissions:'Inherited from daily profile; no artificial tool list or bypass flag'},null,2));
  console.log('日常 WorkBuddy 已接入，现有 MCP/Skill 原地复用，权限沿用正常设置。');
 }finally{await browser.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await activateNormal();
