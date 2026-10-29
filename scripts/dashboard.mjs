import http from 'node:http';
import {deleteSavedWork} from '../src/delete-work.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {BridgeStore} from '../src/store.mjs';
import {connectGpt} from '../src/chatgpt-web.mjs';
import {runtimeMode} from '../src/workbuddy-desktop.mjs';
import {loadConfig,assertControlledPath} from '../src/local-config.mjs';
import {connectionFingerprint} from '../src/onboarding.mjs';
import {recheckRunCapabilities} from '../src/loop.mjs';
import {checkRecovery} from '../src/worker-recovery.mjs';

const projectRoot=fileURLToPath(new URL('..',import.meta.url));
const terminalStates=new Set(['done','failed','cancelled']);
const failure=(message,status=400)=>Object.assign(new Error(message),{status});

// Importing this module neither opens a socket nor starts an application.
export function createDashboardServer({root=projectRoot,configLoader=loadConfig,getRuntime=runtimeMode,spawnRunner=spawn,recheck=recheckRunCapabilities,reconcile=checkRecovery,token=randomUUID(),bodyLimit=65536}={}){
 root=assertControlledPath(root);
 const store=new BridgeStore(path.join(root,'data/bridge.sqlite'));
 let child=null,output='',job=null;
 const localPath=name=>assertControlledPath(path.join(root,'data',name));
 const writeJson=(name,value)=>{const destination=localPath(name),pending=localPath(name+'.pending-'+randomUUID());fs.writeFileSync(pending,JSON.stringify(value,null,2)+'\n',{flag:'wx'});fs.renameSync(pending,destination);};
 const withLease=fn=>{const lease=store.acquireRunner();try{return fn(lease);}finally{store.releaseRunner(lease);}};
 const recover=()=>withLease(lease=>store.recover(lease));
 try{recover();}catch(e){if(e.code!=='RUNNER_ACTIVE'){store.close();throw e;}}
 const configState=()=>{
  const config=configLoader({configPath:path.join(root,'config/local.json')}),mode=getRuntime();
  if(!['test','normal'].includes(mode))throw failure('运行模式无效，请重新连接会话');
  let connection;try{connection=JSON.parse(fs.readFileSync(path.join(root,'config/active-runtime.json'),'utf8'));}catch{}
  const connected=connection?.mode===mode&&connection?.configurationHash===connectionFingerprint(config);
  return {config,mode,connected};
 };
 const requireConfigured=()=>{
  const {config,mode,connected}=configState();
  if(!config.allowNativeRuntimeRecords)throw failure('尚未允许 WorkBuddy 原生运行数据，请在向导确认设置');
  if(mode!==(config.workbuddyMode??'test'))throw failure('所选模式与已连接会话不同，请先在向导重新连接会话');
  if(mode==='normal'&&!config.allowNormalProfile)throw failure('日常配置授权已撤回，请先在向导确认设置');
  if(!connected)throw failure('当前配置尚未连接成功或已改变，请先在向导点击“登录后连接会话”');
  if(config.ports?.dashboard&&config.ports.dashboard!==server.address()?.port)throw failure('协作台端口配置已改变，请重新打开协作台');
  return config;
 };
 const persist=()=>writeJson('dashboard-job.json',job);
 function launch(args){
  if(child)throw failure('当前任务仍在运行',409);
  // Check a runner owned by a different/restarted dashboard too.
  withLease(()=>{});
  requireConfigured();
  if(store.list().some(r=>r.state==='uncertain'))throw failure('有工作结果待核验，请先检查中断状态；不会自动重发。',409);
  const current={id:randomUUID(),startedAt:new Date().toISOString(),state:'running'};
  output='';job=current;persist();
  let proc;
  try{proc=spawnRunner(process.execPath,[path.join(root,'scripts/run-text-loop.mjs'),'--live',...args],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});}
  catch(e){current.state='failed';current.error=e.message;persist();throw e;}
  child=proc;current.pid=proc.pid;
  const add=b=>{output=(output+b.toString()).slice(-16000);};
  proc.stdout?.on('data',add);proc.stderr?.on('data',add);
  const finish=(code,error)=>{
   if(current.finishedAt)return;
   current.state=error||code!==0?'failed':'finished';current.exitCode=code;current.finishedAt=new Date().toISOString();
   if(error){current.error=error.message;add(error.message);}
   if(child===proc)child=null;
   try{persist();recover();}catch(e){if(e.code!=='RUNNER_ACTIVE')add('\n保存/恢复任务状态失败：'+e.message);}
  };
  proc.once('error',e=>finish(null,e));proc.once('exit',code=>finish(code));
  // A failure to save the PID must not make a running child look retryable.
  try{persist();}catch(e){add('\n保存进程记录失败：'+e.message);}
  return current;
 }
 const server=http.createServer(async(req,res)=>{
  const send=(status,value,type='application/json')=>{
   if(res.writableEnded||res.destroyed)return;
   res.writeHead(status,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'});
   res.end(type==='application/json'?JSON.stringify(value):value);
  };
  const origin='http://127.0.0.1:'+server.address().port;
  if(req.headers.host!==new URL(origin).host||req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&req.headers.origin!==origin))return send(403,{error:'请求来源不允许'});
  try{
   const url=new URL(req.url,origin);
   if(req.method==='GET'&&url.pathname==='/')return send(200,fs.readFileSync(path.join(root,'ui/dashboard.html'),'utf8').replaceAll('__TOKEN__',token),'text/html');
   if(req.headers['x-bridge-token']!==token)return send(403,{error:'请求未授权，请刷新协作台'});
   if(req.method==='GET'&&url.pathname==='/api/status'){
    const {config,mode,connected}=configState();
    const runs=store.list(),selected=runs.find(r=>r.id===url.searchParams.get('runId'))??runs.find(r=>['waiting_gpt','waiting_workbuddy'].includes(r.state))??runs[0];
    return send(200,{job,output,runtime:mode,connected,selectedRunId:selected?.id,normalAuthorized:config.allowNormalProfile,verification:fs.existsSync(localPath('local-verification.json'))?JSON.parse(fs.readFileSync(localPath('local-verification.json'))):null,runs:runs.map(r=>r.id===selected?.id?{...r,notices:store.notices(r.id),interactions:store.interactions(r.id)}:{id:r.id,state:r.state,goal:r.goal,workTitle:r.workTitle,displayName:r.displayName,createdAt:r.createdAt,updatedAt:r.updatedAt,workArchived:r.workArchived,workerRounds:r.workerRounds,stage:r.stage,gptUrl:r.gptUrl}),models:fs.existsSync(localPath('model-state.json'))?JSON.parse(fs.readFileSync(localPath('model-state.json'))):{}});
   }
   if(req.method==='GET'&&url.pathname==='/api/work-history')return send(200,store.history(url.searchParams.get('runId'),{before:url.searchParams.has('before')?Number(url.searchParams.get('before')):null}));
   if(req.method!=='POST')return send(404,{error:'未找到'});
   if(req.headers.origin!==origin)return send(403,{error:'请求未授权'});
   if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))return send(415,{error:'只接受 JSON 请求'});
   const chunks=[];let bytes=0;
   for await(const chunk of req){bytes+=chunk.length;if(bytes>bodyLimit){send(413,{error:'任务过长'});return;}chunks.push(chunk);}
   let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw failure('请求不是有效 JSON');}
   if(!data||Array.isArray(data)||typeof data!=='object')throw failure('请求必须是 JSON 对象');
   const fields={'/api/delete-work':['runId','confirmation'],'/api/start':['goal'],'/api/resume':['runId'],'/api/cancel':['runId'],'/api/user-reply':['runId','clientMessageId','text'],'/api/recheck-capabilities':['runId','confirmApplications'],'/api/approve-standard':['runId','proposalId','clientMessageId'],'/api/reconcile':['runId'],'/api/archive-uncertain':['runId','confirmation'],'/api/continue-work':['runId','goal','clientMessageId'],'/api/rename-work':['runId','title'],'/api/archive-work':['runId','archived']};
   const allowedFields=fields[url.pathname]??[];
   if(Object.keys(data).some(k=>!allowedFields.includes(k)))throw failure('请求包含不允许的字段');
   if(url.pathname==='/api/delete-work'){if(child)throw failure('请先暂停正在执行的工作',409);return send(200,withLease(()=>deleteSavedWork(store,root,data)));}
   if(url.pathname==='/api/start'){
    requireConfigured();
    if(typeof data.goal!=='string'||!data.goal.trim()||data.goal.length>12000)return send(400,{error:'请输入 1～12000 字的文字任务'});
    if(child||store.list().some(r=>['prepared','waiting_gpt','waiting_workbuddy','uncertain'].includes(r.state)))return send(409,{error:'请先暂停正在执行的工作或核对不确定结果；其他已暂停工作会保留'});
    const file=localPath('goal-'+randomUUID()+'.txt');fs.writeFileSync(file,data.goal,{flag:'wx'});return send(202,launch(['--goal-file',file]));
   }
   if(url.pathname==='/api/continue-work'){
    requireConfigured();if(child)throw failure('请先暂停正在执行的工作，再继续其他工作',409);
    if(store.list().some(r=>r.state==='uncertain'))throw failure('请先核对待确认的执行结果',409);
    const result=withLease(()=>store.continueWork(data.runId,data));
    if(result.reused)return send(200,{message:'后续目标已保存，没有重复开始。',runId:result.run.id});
    return send(202,{...launch(['--resume-run',result.run.id]),runId:result.run.id,message:'已保存后续目标，将沿用原聊天、会话和目录继续。'});
   }
   if(['/api/rename-work','/api/archive-work'].includes(url.pathname)){
    if(child)throw failure('请先暂停正在执行的工作',409);
    if(url.pathname==='/api/rename-work'&&(typeof data.title!=='string'||!data.title.trim()||data.title.length>100))throw failure('工作名称须为 1～100 个字');
    if(url.pathname==='/api/archive-work'&&typeof data.archived!=='boolean')throw failure('归档状态无效');
    const run=withLease(()=>{const r=store.get(data.runId);if(['waiting_gpt','waiting_workbuddy','prepared'].includes(r.state))throw failure('请先暂停此工作',409);return store.update(r.id,r.state,url.pathname==='/api/rename-work'?{workTitle:data.title.trim()}:{workArchived:data.archived});});
    return send(200,{runId:run.id,message:url.pathname==='/api/rename-work'?'工作名称已保存，聊天和目录不变。':data.archived?'已归档，全部记录保留，可随时找回。':'已恢复到工作列表。'});
   }
   if(url.pathname==='/api/pause'){
    const run=store.list().find(r=>['prepared','waiting_gpt','waiting_workbuddy'].includes(r.state));if(!run)return send(409,{error:'当前没有可暂停的任务'});
    writeJson('pause-request.json',{runId:run.id,requestedAt:new Date().toISOString()});return send(200,{message:'已请求暂停；当前一次回复结束后停止派工'});
   }
   if(url.pathname==='/api/resume'){
    requireConfigured();
    const run=store.list().find(r=>r.id===data.runId);
    if(!run||!['paused','needs_user'].includes(run.state)||run.acceptanceProposal||run.cursor===undefined||store.messages(run.id).some(m=>!['delivered','prepared'].includes(m.state)))return send(409,{error:'请先处理待核验结果或验收变更，不能自动重发'});
    return send(202,launch(['--resume-run',run.id]));
   }
   if(url.pathname==='/api/user-reply'){
    requireConfigured();
    const interaction=store.queueInteraction(data.runId,data),run=store.get(data.runId);
    let launched=false;
    if(!child&&['paused','needs_user'].includes(run.state)&&!run.acceptanceProposal&&run.cursor!==undefined&&!store.messages(run.id).some(m=>['sending','uncertain'].includes(m.state))){launch(['--resume-run',run.id]);launched=true;}
    return send(202,{message:launched?'回复已保存，将发送至原 GPT 聊天。':'回复已保存，安全边界再交给 GPT；不会中断当前执行。',interactionId:interaction.id,state:interaction.state});
   }
   if(url.pathname==='/api/recheck-capabilities'){
    requireConfigured();if(child)throw failure('当前执行仍在进行，请等待安全边界',409);
    const lease=store.acquireRunner();let report,run;
    try{
     run=store.get(data.runId);if(!['needs_user','paused'].includes(run.state)||!Array.isArray(run.requirements))throw failure('当前任务没有可重新检查的能力要求',409);
     const names=data.confirmApplications??[];
     if(!Array.isArray(names)||names.length>30||names.some(id=>!run.requirements.some(r=>r.id===id&&r.kind==='application')))throw failure('只能确认本任务列出的软件状态');
     const confirmations=[...(run.capabilityConfirmations??[]),...names.map(id=>({id,kind:'application',at:new Date().toISOString()}))];
     report=await recheck({...run,capabilityConfirmations:confirmations});
     store.update(run.id,run.state,{capabilityReport:report,capabilityConfirmations:confirmations,nextOutgoing:JSON.stringify({kind:'capability_recheck',runId:run.id,resultId:run.replyToResultId??null,report,instruction:report.invalidRequirements?'请根据 report.available 的真实连接器名称及工具标识重新 plan，tools 未知时填 []；保持冻结验收标准。已就绪连接器无需用户重复开启。':undefined})});
     store.notice(run.id,'bridge',report.ready?'重新检查通过；即将把报告交给 GPT。':report.invalidRequirements?'连接器已识别，但 GPT 的工具要求填写无效；正在将真实工具清单交回 GPT 修正，未派工。':'重新检查仍有必需项未就绪，请按步骤处理。');
    }finally{store.releaseRunner(lease);}
    if((report.ready||report.invalidRequirements)&&!run.acceptanceProposal)launch(['--resume-run',run.id]);
    return send(200,{message:report.ready?'检查通过，将交给 GPT 继续规划。':report.invalidRequirements?'已发现 GPT 的工具名称填写错误，将实际清单交回 GPT 修正；未派工。':'仍有必需能力缺失，未派工。',report});
   }
   if(url.pathname==='/api/approve-standard'){
    if(child)throw failure('请等待当前回复结束',409);requireConfigured();
    const approval=withLease(()=>store.approveAcceptance(data.runId,data));
    if(approval.reused)return send(200,{message:'该批准已保存，没有重复发送。'});
    return send(202,launch(['--resume-run',approval.run.id]));
   }
   if(url.pathname==='/api/reconcile'){
    if(child)throw failure('当前执行尚在进行，不进行恢复',409);
    const lease=store.acquireRunner();let result;
    try{const run=store.get(data.runId);result=await reconcile(run,store);store.update(run.id,store.get(run.id).state,{recovery:result,question:result.message});store.notice(run.id,'bridge',result.message);}finally{store.releaseRunner(lease);}
    return send(200,result);
   }
   if(url.pathname==='/api/archive-uncertain'){
    if(child||data.confirmation!=='保留记录并结束跟踪')throw failure('请明确确认保留记录并结束跟踪',409);
    withLease(()=>{const run=store.get(data.runId);if(run.state!=='uncertain')throw failure('只可结束待核验任务的跟踪');store.update(run.id,'cancelled',{trackingEndedAt:new Date().toISOString(),unverifiedResultRetained:true});});
    return send(200,{message:'记录和产物已保留；未确认完成、未重做，也未取消 WorkBuddy 原任务。'});
   }
   if(url.pathname==='/api/recover'){
    if(child)return send(409,{error:'当前任务仍在运行，不能恢复'});
    recover();return send(200,{message:'已检查中断记录；不确定的发送保留待核验，不会重发'});
   }
   if(url.pathname==='/api/cancel'){
    if(child)return send(409,{error:'请先暂停并等待当前任务结束'});
    const run=withLease(()=>{
     const r=store.get(data.runId);
     if(!['paused','needs_user'].includes(r.state)||store.messages(r.id).some(m=>['sending','uncertain'].includes(m.state)))throw failure('只可结束已暂停或等待补充信息的任务；不确定结果需先核验',409);
     return store.update(r.id,'cancelled',{cancelledAt:new Date().toISOString()});
    });
    return send(200,{message:'任务已结束，历史记录保留',runId:run.id});
   }
   return send(404,{error:'未找到'});
  }catch(e){send(e.code==='RUNNER_ACTIVE'?409:e.status??400,{error:e.message});}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;
 server.on('close',()=>store.close());
 return {server,store,token,get origin(){return 'http://127.0.0.1:'+server.address()?.port;}};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const config=loadConfig(),app=createDashboardServer();
 app.server.on('error',e=>{console.error(e.message);app.store.close();process.exitCode=1;});
 app.server.listen(config.ports.dashboard,'127.0.0.1',async()=>{
  fs.writeFileSync(assertControlledPath(path.join(projectRoot,'data/dashboard-launch.json')),JSON.stringify({pid:process.pid,origin:app.origin,startedAt:new Date().toISOString()}));console.log('操作界面：'+app.origin+'，请保持此窗口打开。');
  if(process.env.WB_BRIDGE_NO_AUTO_OPEN==='1')return;
  try{const {browser}=await connectGpt();try{const context=browser.contexts()[0];const page=context.pages().find(p=>p.url()===app.origin+'/')??await context.newPage();await page.goto(app.origin);await page.bringToFront();}finally{await browser.close();}}catch{console.log('浏览器未连接，请手动打开上方地址。');}
 });
}
