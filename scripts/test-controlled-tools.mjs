import {assertControlledPath} from '../src/local-config.mjs';
import fs from 'node:fs';import {randomUUID} from 'node:crypto';
import {connectDesktop,nativeRpc,observeSession,sessionEvents} from '../src/workbuddy-desktop.mjs';
if(!process.argv.includes('--live'))throw Error('Manual live probe: add --live only after reviewing this script and authorizing its tool actions.');
const probeRoot=assertControlledPath(fs.realpathSync(new URL('..',import.meta.url)));process.chdir(probeRoot);fs.mkdirSync('data',{recursive:true});
if(!fs.existsSync('data/capability-tools.json'))throw Error('Missing local capability policy. Configure the dedicated test workspace and test MCP before this live probe.');
if(!fs.existsSync('data/capability-bindings.json'))fs.writeFileSync('data/capability-bindings.json','[]\n');
const connected=process.argv.includes('--connected');
const discovery=process.argv.includes('--discovery');
const journal=discovery?'data/controlled-tools-discovery-probe.json':connected?'data/controlled-tools-fresh-probe.json':'data/controlled-tools-probe.json';
const prior=fs.existsSync(journal)?JSON.parse(fs.readFileSync(journal)):null;
if(prior&&(!process.argv.includes('--resume-create')||prior.stage!=='creating'||prior.requestId))throw Error('Existing test attempt; reconcile first');
const cfg=JSON.parse(fs.readFileSync('data/capability-tools.json'));const sid=prior?.sessionId??randomUUID();
const create=prior?.create??{cwd:cfg.workspace,sessionId:sid,isPlayground:false,tools:discovery?'ToolSearch,DeferExecuteTool':connected?'mcp__bridge_test__read_file,mcp__bridge_test__write_file,mcp__bridge_test__run_command,mcp__bridge_test__browser_action':'',config:{model:'deepseek-v4.1-flash',permissionMode:'default'}};
if(!prior){const registry=JSON.parse(fs.readFileSync('data/capability-bindings.json'));registry.push({sessionId:sid,workspace:cfg.workspace,create});fs.writeFileSync('data/capability-bindings.json',JSON.stringify(registry,null,2));}
const r={sessionId:sid,create,stage:'creating',startedAt:new Date().toISOString()};const save=()=>fs.writeFileSync(journal,JSON.stringify(r,null,2));save();
const {browser,page}=await connectDesktop({mode:'test'});try{
 const mcps=await nativeRpc(page,'mcp:list',[]);const bridge=Array.isArray(mcps)?mcps.find(item=>item.name==='bridge_test'):null;
 if(!bridge||bridge.enabled===false)throw Error('请先在测试 WorkBuddy 的 MCP 设置中添加、信任并连接名为 bridge_test 的本地测试服务器，然后检查本次日志并使用 --resume-create --live 继续。脚本不会自动批准或连接 MCP。');
 if((await nativeRpc(page,'daemon:getActiveSessions',[])).length)throw Error('Active task');
 if(prior&&await nativeRpc(page,'session:get',[sid]))throw Error('Session already exists; no automatic recreation');
 await nativeRpc(page,'session:create',[create],45000);await nativeRpc(page,'session:load',[sid,{cwd:cfg.workspace,forceRendererHistoryReplay:true}],45000);await observeSession(page,sid);
 r.stage='sending';r.requestId=randomUUID();save();let done=false;
 const task=nativeRpc(page,'session:sendMessage',[sid,[{type:'text',text:'这是用户授权的受限工具验收。只使用 bridge_test MCP 的工具，禁止内置 Bash/Read/Write/Edit、其他工具或访问其他目录。依次：1) write_file 写 note.txt 内容 BRIDGE_TOOLS_OK；2) read_file 读回核对；3) run_command 的 command=node_version，报告真实输出；4) browser_action read，再 fill 文本 BRIDGE_UI_OK，再 click，再 read，报告页面显示与点击次数。最后逐项汇总真实工具结果。不要假装操作。如果没有 bridge_test 工具则明确报告工具未加载并停止。'}],{'codebuddy.ai':{requestId:r.requestId,messageRequestId:r.requestId,userMessageId:r.requestId,emitSyntheticUserPromptLive:true}}],180000).then(x=>{r.result=x;done=true;},e=>{r.error=e.message;done=true;});
 let printed=false;while(!done){await new Promise(x=>setTimeout(x,2000));const state=await nativeRpc(page,'session:get',[sid]);if(!printed&&state.pendingInputKind){console.log(JSON.stringify({pendingInputKind:state.pendingInputKind,pendingPermissions:state.pendingPermissions}));printed=true;}}
 await task;r.events=await sessionEvents(page);r.stage=r.error?'uncertain':'rpc_completed';r.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({stage:r.stage,answer:r.result?._meta?.['codebuddy.ai']?.lastAssistantText,stopReason:r.result?.stopReason,error:r.error,tools:[...new Set(r.events.filter(e=>e.result?.update?.sessionUpdate==='tool_call').map(e=>e.result.update._meta?.['codebuddy.ai/toolName']))]}));
}finally{await browser.close();}
