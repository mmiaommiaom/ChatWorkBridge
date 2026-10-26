import {assertControlledPath} from '../src/local-config.mjs';
import fs from 'node:fs';
import {connectDesktop,nativeRpc,observeSession,sessionEvents} from '../src/workbuddy-desktop.mjs';
if(!process.argv.includes('--live'))throw Error('Manual live probe: add --live to send a follow-up in the dedicated test session.');
const probeRoot=assertControlledPath(fs.realpathSync(new URL('..',import.meta.url)));process.chdir(probeRoot);fs.mkdirSync('data',{recursive:true});
if(!fs.existsSync('data/desktop-binding.json'))throw Error('Run test-desktop-message.mjs --live first in this checkout; no historical evidence is bundled.');
const binding=JSON.parse(fs.readFileSync(new URL('../data/desktop-binding.json',import.meta.url),'utf8'));
if(typeof binding.expectedText!=='string'||!binding.expectedText.startsWith('BRIDGE_P0_'))throw Error('Existing binding is not the first-message probe; do not send a follow-up to another conversation.');
const journal=new URL('../data/desktop-followup.json',import.meta.url);
if(fs.existsSync(journal))throw new Error('Followup journal exists; do not resend');
const report={sessionId:binding.sessionId,requestId:crypto.randomUUID(),startedAt:new Date().toISOString(),stage:'prepared'};
const save=()=>fs.writeFileSync(journal,JSON.stringify(report,null,2)+'\n');save();
const {browser,page}=await connectDesktop({mode:'test'});
try{
  const before=await nativeRpc(page,'session:get',[binding.sessionId]);
  if(before.status!=='completed'||before.isProcessing||before.pendingInputKind||before.pendingPermissions?.length)throw new Error('Session not confirmed idle');
  await observeSession(page,binding.sessionId);
  report.stage='sending';save();
  const result=await nativeRpc(page,'session:sendMessage',[binding.sessionId,[{type:'text',text:'继续上一轮收发测试，不调用任何工具。请回忆你上一条回复的完整字符串，在末尾追加 |ROUND2 后只回复这个新字符串。'}],{'codebuddy.ai':{requestId:report.requestId,userMessageId:report.requestId,messageRequestId:report.requestId,emitSyntheticUserPromptLive:true}}],180000);
  const answer=result?._meta?.['codebuddy.ai']?.lastAssistantText;
  const events=(await sessionEvents(page)).filter(e=>e.result?.update?.sessionUpdate==='agent_message_chunk'&&e.result.update?._meta?.['codebuddy.ai/messageRequestId']===report.requestId);
  const seen=new Set();const text=events.filter(e=>!seen.has(e.id)&&seen.add(e.id)).map(e=>e.result.update.content?.text??'').join('');
  Object.assign(report,{stage:'finished',finishedAt:new Date().toISOString(),expected:binding.expectedText+'|ROUND2',answer,streamedAnswer:text,exactReply:answer===binding.expectedText+'|ROUND2',streamAgrees:text===answer,stopReason:result?.stopReason});save();
  if(!report.exactReply||!report.streamAgrees)throw new Error('Followup answer mismatch');
  console.log(JSON.stringify(report,null,2));
}catch(e){report.stage='uncertain_or_failed';report.error=e.message;save();throw e;}finally{await browser.close();}
