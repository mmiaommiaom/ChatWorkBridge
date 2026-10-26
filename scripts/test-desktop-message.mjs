import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {connectDesktop,nativeRpc,observeSession,sessionEvents} from '../src/workbuddy-desktop.mjs';
import {initializeSession} from '../src/initialize-session.mjs';
import {assertControlledPath} from '../src/local-config.mjs';
if(!process.argv.includes('--live'))throw Error('Manual live probe: add --live to create a dedicated WorkBuddy session and send one text message.');
const probeRoot=assertControlledPath(fs.realpathSync(new URL('..',import.meta.url)));process.chdir(probeRoot);
const root=fileURLToPath(new URL('..',import.meta.url));
const bindingFile=path.join(root,'data/desktop-binding.json');
await initializeSession();
const binding=JSON.parse(fs.readFileSync(bindingFile,'utf8'));
if(binding.requestId||binding.expectedText||fs.existsSync(path.join(root,'data/desktop-message-result.json')))throw new Error('A first-message probe already exists; inspect prior evidence instead of resending');
const save=()=>fs.writeFileSync(bindingFile,JSON.stringify(binding,null,2)+'\n');
const {browser,page}=await connectDesktop({mode:'test'});
try{
  const state=await nativeRpc(page,'session:get',[binding.sessionId]);
  if((state?.model??state?.config?.model)!=='deepseek-v4.1-flash')throw new Error('Selected desktop model not confirmed');
  await observeSession(page,binding.sessionId);
  await nativeRpc(page,'session:load',[binding.sessionId,{cwd:binding.workspace,forceRendererHistoryReplay:true}],45000);
  const nonce='BRIDGE_P0_'+randomUUID().replaceAll('-','');
  const prompt=`这是聊天桥接收发测试。不要调用任何工具，不要读写文件，不要执行命令。请只回复以下字符串，不要添加其他文字：${nonce}`;
  binding.stage='sending';binding.requestId=randomUUID();binding.expectedText=nonce;binding.sentAt=new Date().toISOString();save();
  const result=await nativeRpc(page,'session:sendMessage',[binding.sessionId,[{type:'text',text:prompt}],{'codebuddy.ai':{requestId:binding.requestId,userMessageId:binding.requestId,messageRequestId:binding.requestId,emitSyntheticUserPromptLive:true}}],180000);
  const events=await sessionEvents(page);
  fs.writeFileSync(path.join(root,'data/desktop-message-events.json'),JSON.stringify(events,null,2)+'\n');
  const finished=await nativeRpc(page,'session:get',[binding.sessionId]);
  const report={checkedAt:new Date().toISOString(),sessionId:binding.sessionId,model:binding.model,requestId:binding.requestId,expectedText:nonce,result,eventCount:events.length,updateKinds:[...new Set(events.map(e=>e.result?.update?.sessionUpdate).filter(Boolean))],state:{status:finished?.status,model:finished?.model??finished?.config?.model,pendingInputKind:finished?.pendingInputKind}};
  fs.writeFileSync(path.join(root,'data/desktop-message-result.json'),JSON.stringify(report,null,2)+'\n');
  binding.stage='completed_rpc';save();console.log(JSON.stringify(report,null,2));
}catch(e){binding.stage='uncertain';binding.error=e.message;save();try{fs.writeFileSync(path.join(root,'data/desktop-message-events.json'),JSON.stringify(await sessionEvents(page),null,2)+'\n');}catch{}throw e;}
finally{await browser.close();}
