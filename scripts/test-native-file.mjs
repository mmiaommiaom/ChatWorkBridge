import {assertControlledPath} from '../src/local-config.mjs';
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {connectDesktop,nativeRpc,observeSession,sessionEvents} from '../src/workbuddy-desktop.mjs';
if(!process.argv.includes('--live'))throw Error('Manual live probe: add --live to create a dedicated local test file using WorkBuddy Write.');
const probeRoot=assertControlledPath(fs.realpathSync(new URL('..',import.meta.url)));process.chdir(probeRoot);fs.mkdirSync('data',{recursive:true});
const root=fileURLToPath(new URL('..',import.meta.url));
const journal=path.join(root,'data/native-file-probe.json');if(fs.existsSync(journal))throw Error('Existing attempt: reconcile first, do not resend');
const sid=randomUUID(),workspace=path.join(root,'workspaces/probe','capability-'+sid);fs.mkdirSync(workspace,{recursive:true});
const create={cwd:workspace,sessionId:sid,isPlayground:false,tools:'Read,Write,Edit',config:{model:'deepseek-v4.1-flash',permissionMode:'default'}};
const registryFile=path.join(root,'data/capability-bindings.json');const registry=fs.existsSync(registryFile)?JSON.parse(fs.readFileSync(registryFile)):[];registry.push({sessionId:sid,workspace,create});fs.writeFileSync(registryFile,JSON.stringify(registry,null,2));
const file=path.join(workspace,'native-file.txt'),content='ChatWorkBridge native file capability verified.\n';
const state={sessionId:sid,workspace,file,expected:content,stage:'creating',startedAt:new Date().toISOString()};const save=()=>fs.writeFileSync(journal,JSON.stringify(state,null,2)+'\n');save();
const {browser,page}=await connectDesktop({mode:'test'});
try{
 if((await nativeRpc(page,'daemon:getActiveSessions',[])).length)throw Error('Another task active');
 const created=await nativeRpc(page,'session:create',[create],45000);if(created.sessionId!==sid)throw Error('Session mismatch');
 await nativeRpc(page,'session:rename',[sid,'ChatWorkBridge 文件能力测试']);
 await nativeRpc(page,'session:load',[sid,{cwd:workspace,forceRendererHistoryReplay:true}],45000);
 await observeSession(page,sid);state.stage='sending';state.requestId=randomUUID();save();
 let done=false;
 const task=nativeRpc(page,'session:sendMessage',[sid,[{type:'text',text:`这是已授权的专用工作区文件写入测试。只使用 Write 工具创建文件 ${file}，内容必须精确为 ${JSON.stringify(content)}。不运行命令、不读其他文件、不调用其他工具、不申请扩大权限。完成后简短报告。`}],{'codebuddy.ai':{requestId:state.requestId,messageRequestId:state.requestId,userMessageId:state.requestId,emitSyntheticUserPromptLive:true}}],180000).then(r=>{state.result=r;done=true;},e=>{state.error=e.message;done=true;});
 let reported=false;while(!done){await new Promise(r=>setTimeout(r,1500));const s=await nativeRpc(page,'session:get',[sid]);if(!reported&&s.pendingInputKind){console.log(JSON.stringify({pendingInputKind:s.pendingInputKind,pendingPermissions:s.pendingPermissions,keys:Object.keys(s)}));reported=true;}}
 await task;state.events=await sessionEvents(page);state.exists=fs.existsSync(file);state.matches=state.exists&&fs.readFileSync(file,'utf8')===content;state.stage=state.error?'uncertain':'completed';state.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({stage:state.stage,exists:state.exists,matches:state.matches,result:state.result,error:state.error,eventKinds:[...new Set(state.events.map(e=>e.result?.update?.sessionUpdate))]}));
}catch(e){state.stage='uncertain';state.error=e.message;state.events=await sessionEvents(page);save();throw e;}finally{await browser.close();}
