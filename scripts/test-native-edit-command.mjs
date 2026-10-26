import {assertControlledPath} from '../src/local-config.mjs';
import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {connectDesktop,nativeRpc,observeSession,sessionEvents} from '../src/workbuddy-desktop.mjs';
if(!process.argv.includes('--live'))throw Error('Manual live probe: add --live to ask HY3 to edit a newly generated file and Step to run Node --version.');
const probeRoot=assertControlledPath(fs.realpathSync(new URL('..',import.meta.url)));process.chdir(probeRoot);fs.mkdirSync('data',{recursive:true});
if(!fs.existsSync('data/native-file-probe.json'))throw Error('Run test-native-file.mjs --live first in this checkout; no historical file or session is bundled.');
const journal='data/native-edit-command-probe.json';if(fs.existsSync(journal))throw Error('Existing journal; no blind replay');
const source=JSON.parse(fs.readFileSync('data/native-file-probe.json'));const report={startedAt:new Date().toISOString(),attempts:[]};const save=()=>fs.writeFileSync(journal,JSON.stringify(report,null,2));save();
const {browser,page}=await connectDesktop({mode:'test'});
async function send(sid,model,prompt){
 const entry={sid,model,requestId:randomUUID(),stage:'sending',startedAt:new Date().toISOString()};report.attempts.push(entry);save();
 await nativeRpc(page,'session:updateConfig',[sid,{model}],45000);await nativeRpc(page,'session:load',[sid,{cwd:source.workspace,forceRendererHistoryReplay:true}],45000);await observeSession(page,sid);await page.evaluate(()=>{const o=globalThis.__chatWorkObserver;o.events=[];o.bytes=0;o.overflow=false;});
 try{entry.result=await nativeRpc(page,'session:sendMessage',[sid,[{type:'text',text:prompt}],{'codebuddy.ai':{requestId:entry.requestId,messageRequestId:entry.requestId,userMessageId:entry.requestId,emitSyntheticUserPromptLive:true}}],180000);entry.stage='completed';}catch(e){entry.error=e.message;entry.stage='uncertain';throw e;}finally{entry.events=await sessionEvents(page);entry.finishedAt=new Date().toISOString();save();}
 console.log(JSON.stringify({model,stage:entry.stage,answer:entry.result?._meta?.['codebuddy.ai']?.lastAssistantText,tools:entry.events.filter(e=>e.result?.update?.sessionUpdate==='tool_call').map(e=>e.result.update)}));return entry;
}
try{
 if((await nativeRpc(page,'daemon:getActiveSessions',[])).length)throw Error('Another task active');
 await send(source.sessionId,'hy3',`这是授权的文件修改测试。只使用 Read 和 Edit 工具，将 ${source.file} 中的 verified 替换成 edited，其他字符和换行不变。不读其他文件，不运行命令，不使用其他工具。完成后报告。`);
 report.editVerified=fs.readFileSync(source.file,'utf8')===source.expected.replace('verified','edited');save();
 const registry=JSON.parse(fs.readFileSync('data/capability-bindings.json'));const sid=randomUUID();const create={cwd:source.workspace,sessionId:sid,isPlayground:false,tools:'Bash',config:{model:'step-5-preview',permissionMode:'default'}};registry.push({sessionId:sid,workspace:source.workspace,create});fs.writeFileSync('data/capability-bindings.json',JSON.stringify(registry,null,2));
 await nativeRpc(page,'session:create',[create],45000);
 await send(sid,'step-5-preview',`这是用户授权的最小命令执行测试。只运行一次以下命令并原样报告 stdout 和退出码："${process.execPath}" --version 。禁止其他命令、安装软件、写文件、联网或读取其他文件。`);
 report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({editVerified:report.editVerified,stages:report.attempts.map(a=>({model:a.model,stage:a.stage}))}));
}finally{await browser.close();}
