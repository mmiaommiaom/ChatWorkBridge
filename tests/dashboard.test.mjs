import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {createDashboardServer} from '../scripts/dashboard.mjs';
import {connectionFingerprint} from '../src/onboarding.mjs';
import {BridgeStore} from '../src/store.mjs';
import {reconcileUnsentDraft} from '../src/reconcile-gpt.mjs';
import {testDirectory} from './helpers.mjs';

async function serve(t,label,options={}){
 const root=options.root??testDirectory('dashboard-'+label);fs.mkdirSync(path.join(root,'ui'),{recursive:true});
 fs.copyFileSync(new URL('../ui/dashboard.html',import.meta.url),path.join(root,'ui/dashboard.html'));
 const calls=[],config={workbuddyMode:'test',allowNativeRuntimeRecords:true,allowNormalProfile:false};let mode='test';
 const connectConfiguration=()=>{fs.mkdirSync(path.join(root,'config'),{recursive:true});fs.writeFileSync(path.join(root,'config/active-runtime.json'),JSON.stringify({mode,configurationHash:connectionFingerprint(config)}));};
 connectConfiguration();
 const app=createDashboardServer({root,configLoader:()=>config,getRuntime:()=>mode,spawnRunner:(exe,args,settings)=>{
  const proc=new EventEmitter();proc.stdout=new EventEmitter();proc.stderr=new EventEmitter();proc.pid=123456;
  calls.push({exe,args,settings,proc});return proc;
 },...options});
 await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
 t.after(()=>new Promise(resolve=>{app.server.closeAllConnections();app.server.close(resolve);}));
 const request=(route,{method='GET',data,headers={}}={})=>fetch(app.origin+route,{method,headers:{'X-Bridge-Token':app.token,...(method==='POST'?{'Content-Type':'application/json',Origin:app.origin}:{}),...headers},...(data!==undefined?{body:typeof data==='string'?data:JSON.stringify(data)}:{})});
 return {...app,root,calls,config,request,connectConfiguration,setMode:value=>{mode=value;}};
}

test('dashboard guards task/status API against foreign origins, missing tokens and malformed bodies',async t=>{
 const f=await serve(t,'security',{bodyLimit:256});
 assert.equal((await fetch(f.origin)).status,200);
 assert.equal((await f.request('/api/status',{headers:{'X-Bridge-Token':''}})).status,403);
 assert.equal((await f.request('/api/status',{headers:{Origin:'https://foreign.example'}})).status,403);
 assert.equal((await f.request('/api/status',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
 const host=await new Promise((resolve,reject)=>{const req=http.get(f.origin+'/api/status',{headers:{Host:'foreign.example','X-Bridge-Token':f.token}},res=>{res.resume();resolve(res.statusCode);});req.once('error',reject);});
 assert.equal(host,403);
 for(const [data,status,headers] of [[{},403,{Origin:''}],['{}',415,{'Content-Type':'text/plain'}],['x'.repeat(300),413],['{',400],['null',400],['[]',400],[{goal:'text',command:'powershell'},400]]){
  assert.equal((await f.request('/api/start',{method:'POST',data,headers})).status,status);
 }
 assert.deepEqual(f.calls,[]);
});

test('dashboard reloads revoked permissions and mode changes before starting or resuming',async t=>{
 const f=await serve(t,'permissions');f.config.workbuddyMode='normal';f.config.allowNormalProfile=true;f.setMode('normal');
 assert.equal((await(await f.request('/api/status')).json()).normalAuthorized,true);
 f.config.allowNormalProfile=false;
 assert.equal((await(await f.request('/api/status')).json()).normalAuthorized,false);
 assert.equal((await f.request('/api/start',{method:'POST',data:{goal:'must not execute'}})).status,400);
 const run=f.store.create('pause');f.store.update(run.id,'paused');
 assert.equal((await f.request('/api/resume',{method:'POST',data:{runId:run.id}})).status,400);
 f.config.allowNormalProfile=true;f.config.workbuddyMode='test';
 assert.equal((await f.request('/api/resume',{method:'POST',data:{runId:run.id}})).status,400);
 f.config.workbuddyMode='normal';f.config.allowNativeRuntimeRecords=false;
 assert.equal((await f.request('/api/resume',{method:'POST',data:{runId:run.id}})).status,400);
 assert.deepEqual(f.calls,[]);
});

test('dashboard accepts full length Chinese tasks as file data and refuses concurrent or arbitrary commands',async t=>{
 const f=await serve(t,'launch');const goal='测'.repeat(12000);
 assert.equal((await f.request('/api/start',{method:'POST',data:{goal}})).status,202);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].exe,process.execPath);
 assert.ok(f.calls[0].args[0].endsWith('scripts'+path.sep+'run-text-loop.mjs'));assert.equal(f.calls[0].args[1],'--live');assert.equal(f.calls[0].args[2],'--goal-file');
 assert.equal(fs.readFileSync(f.calls[0].args[3],'utf8'),goal);
 assert.equal((await f.request('/api/start',{method:'POST',data:{goal:'second'}})).status,409);
 assert.equal((await f.request('/api/recover',{method:'POST',data:{}})).status,409);
 f.calls[0].proc.emit('error',new Error('synthetic spawn failure'));f.calls[0].proc.emit('exit',0);
 const status=await(await f.request('/api/status')).json();assert.equal(status.job.state,'failed');assert.match(status.output,/synthetic spawn failure/);
});

test('changed executable, profile or ports require a matching successful connection fingerprint',async t=>{
 const f=await serve(t,'connection');
 assert.equal((await(await f.request('/api/status')).json()).connected,true);
 for(const patch of [{chromeExe:'D:/other/chrome.exe'},{workbuddyExe:'D:/other/WorkBuddyAI.exe'},{workbuddyProfile:'D:/other/Profile'},{ports:{gpt:19091}}]){
  Object.assign(f.config,patch);
  assert.equal((await(await f.request('/api/status')).json()).connected,false);
  const result=await f.request('/api/start',{method:'POST',data:{goal:'blocked until connected'}});
  assert.equal(result.status,400);assert.match((await result.json()).error,/登录后连接会话/);
  f.connectConfiguration();
 }
 assert.deepEqual(f.calls,[]);
 fs.writeFileSync(path.join(f.root,'config/active-runtime.json'),'{}');
 const run=f.store.create('paused',{cursor:0});f.store.update(run.id,'paused');
 assert.equal((await f.request('/api/resume',{method:'POST',data:{runId:run.id}})).status,400);
 f.connectConfiguration();
 assert.equal((await f.request('/api/resume',{method:'POST',data:{runId:run.id}})).status,202);
 assert.equal(f.calls.length,1);f.calls[0].proc.emit('exit',0);
});

test('restart recovery preserves uncertain delivery and never cancels or resends it',async t=>{
 const root=testDirectory('dashboard-crash'),prior=new BridgeStore(path.join(root,'data/bridge.sqlite'));
 const run=prior.create('uncertain send'),message=prior.prepare(run.id,0,'workbuddy',{instruction:'once'});prior.markSending(message.id);prior.update(run.id,'waiting_workbuddy');prior.close();
 const f=await serve(t,'crash',{root});assert.equal(f.store.get(run.id).state,'uncertain');assert.equal(f.store.message(message.id).state,'uncertain');
 assert.equal((await f.request('/api/resume',{method:'POST',data:{runId:run.id}})).status,409);
 assert.equal((await f.request('/api/cancel',{method:'POST',data:{runId:run.id}})).status,409);
 assert.equal((await f.request('/api/start',{method:'POST',data:{goal:'another'}})).status,409);assert.deepEqual(f.calls,[]);
});

test('recovery refuses live runner and safe cancellation preserves messages and user question',async t=>{
 const f=await serve(t,'cancel'),run=f.store.create('needs input');f.store.update(run.id,'needs_user',{question:'请选择目标文件'});
 const message=f.store.prepare(run.id,0,'gpt',{text:'original'});f.store.markSending(message.id);f.store.delivered(message.id,{text:'question'});
 const status=await(await f.request('/api/status')).json();assert.equal(status.runs[0].question,'请选择目标文件');
 const lease=f.store.acquireRunner();
 assert.equal((await f.request('/api/recover',{method:'POST',data:{}})).status,409);
 assert.equal((await f.request('/api/cancel',{method:'POST',data:{runId:run.id}})).status,409);
 let connections=0;await assert.rejects(()=>reconcileUnsentDraft(f.store,run.id,{connect:async()=>{connections++;}}),/Another bridge runner/);assert.equal(connections,0);
 f.store.releaseRunner(lease);
 assert.equal((await f.request('/api/cancel',{method:'POST',data:{runId:run.id}})).status,200);
 assert.equal(f.store.get(run.id).state,'cancelled');assert.equal(f.store.message(message.id).state,'delivered');assert.deepEqual(f.calls,[]);
});

test('completion rendering presents coordinator data without inventing verification',()=>{
 const html=fs.readFileSync(new URL('../ui/dashboard.html',import.meta.url),'utf8');
 const source=html.match(/<script>([\s\S]*?)const token=/)[1];const context=vm.createContext({});vm.runInContext(source,context);
 const summary=vm.runInContext('prettySummary(\'{"sum":82,"sumOfSquares":2486,"verified":false}\')',context);
 assert.deepEqual(JSON.parse(summary),{sum:82,sumOfSquares:2486,verified:false});assert.doesNotMatch(summary,/核对.*通过/);
 assert.equal(vm.runInContext('prettySummary("not JSON")',context),'not JSON');
});
test('two-way replies persist with one client ID and never interrupt an active worker',async t=>{
 const f=await serve(t,'reply');await f.request('/api/start',{method:'POST',data:{goal:'new'}});
 const run=f.store.create('running',{cursor:1});f.store.update(run.id,'waiting_workbuddy');
 const data={runId:run.id,clientMessageId:'fixed-reply',text:'请保留原验收标准'};
 for(let i=0;i<2;i++)assert.equal((await f.request('/api/user-reply',{method:'POST',data})).status,202);
 assert.equal(f.store.interactions(run.id).length,1);assert.equal(f.store.interactions(run.id)[0].state,'queued');assert.equal(f.calls.length,1);
 assert.equal((await f.request('/api/user-reply',{method:'POST',data:{...data,text:'changed'}})).status,400);
 const status=await(await f.request('/api/status')).json();assert.equal(status.runs[0].notices.filter(n=>n.author==='user').length,1);
 f.calls[0].proc.emit('exit',0);
});
test('capability recheck cannot be replaced with a claimed success or enable arbitrary tools',async t=>{
 let ready=false;const f=await serve(t,'recheck',{recheck:async()=>({ready,checks:[{status:ready?'ready':'disabled'}]})});
 const run=f.store.create('capability',{cursor:1,requirements:[{id:'mcp:blender',kind:'mcp',name:'blender'}]});f.store.update(run.id,'needs_user');
 assert.equal((await f.request('/api/recheck-capabilities',{method:'POST',data:{runId:run.id,ready:true}})).status,400);
 assert.equal((await f.request('/api/recheck-capabilities',{method:'POST',data:{runId:run.id,confirmApplications:['mcp:blender']}})).status,400);
 assert.equal((await f.request('/api/recheck-capabilities',{method:'POST',data:{runId:run.id}})).status,200);assert.equal(f.calls.length,0);assert.equal(f.store.get(run.id).capabilityReport.ready,false);
 ready=true;assert.equal((await f.request('/api/recheck-capabilities',{method:'POST',data:{runId:run.id}})).status,200);assert.equal(f.calls.length,1);f.calls[0].proc.emit('exit',0);
});

 test('saved work selection, rename, archive and paginated history stay scoped after reopen',async t=>{
 const f=await serve(t,'saved-works');const a=f.store.create('first',{gptUrl:'https://chatgpt.com/c/first',workerSessionId:'first-session',cursor:2});f.store.update(a.id,'paused');const b=f.store.create('second');f.store.update(b.id,'needs_user');
 for(let i=0;i<24;i++){const m=f.store.prepare(a.id,i,'gpt',{text:'message-'+i});f.store.markSending(m.id);f.store.delivered(m.id,{text:'answer-'+i});}
 let status=await(await f.request('/api/status?runId='+a.id)).json();assert.equal(status.selectedRunId,a.id);assert.equal(status.runs.find(r=>r.id===a.id).gptUrl,'https://chatgpt.com/c/first');
 const page=await(await f.request('/api/work-history?runId='+a.id)).json();assert.equal(page.messages.length,20);assert.ok(page.nextBefore);const older=await(await f.request('/api/work-history?runId='+a.id+'&before='+page.nextBefore)).json();assert.equal(older.messages.length,4);assert.equal(new Set([...page.messages,...older.messages].map(m=>m.id)).size,24);
 for(const [route,data] of [['rename-work',{title:'renamed'}],['archive-work',{archived:true}]])assert.equal((await f.request('/api/'+route,{method:'POST',data:{runId:a.id,...data}})).status,200);
 const saved=f.store.get(a.id);assert.equal(saved.workerSessionId,'first-session');assert.equal(saved.workTitle,'renamed');assert.equal(saved.workArchived,true);assert.equal(f.store.messages(a.id).length,24);assert.equal(f.store.get(b.id).goal,'second');assert.equal(f.calls.length,0);
 const second=new BridgeStore(path.join(f.root,'data/bridge.sqlite'));try{assert.equal(second.get(a.id).workTitle,'renamed');assert.equal(second.list().length,2);}finally{second.close();}
 assert.equal((await f.request('/api/start',{method:'POST',data:{goal:'third saved work'}})).status,202);assert.equal(f.calls.length,1);f.calls[0].proc.emit('exit',0);
 });
 test('completed work follow-up retains original conversation and criteria history, deduplicates clicks',async t=>{
 const f=await serve(t,'follow-up'),run=f.store.create('phase one',{cursor:2,gptUrl:'https://chatgpt.com/c/one',workerSessionId:'same-session',workerWorkspace:'E:/same',acceptance:['original'],summary:'passed',replyToResultId:'result-one',commands:['step-1']});
 const m=f.store.prepare(run.id,2,'gpt',{text:'prior'});f.store.markSending(m.id);f.store.delivered(m.id,{text:'done'});f.store.update(run.id,'done');
 const data={runId:run.id,goal:'phase two',clientMessageId:'follow-up-fixed'};
 assert.equal((await f.request('/api/continue-work',{method:'POST',data})).status,202);assert.equal(f.calls.length,1);f.calls[0].proc.emit('exit',0);
 assert.equal((await f.request('/api/continue-work',{method:'POST',data})).status,200);assert.equal(f.calls.length,1);
 const saved=f.store.get(run.id);assert.equal(saved.stage,2);assert.equal(saved.cursor,3);assert.equal(saved.workerSessionId,'same-session');assert.equal(saved.gptUrl,run.gptUrl);assert.deepEqual(saved.completedStages[0].acceptance,['original']);assert.equal(saved.acceptance,null);assert.equal(saved.replyToResultId,'result-one');assert.equal(f.store.messages(run.id).length,1);
 assert.equal((await f.request('/api/continue-work',{method:'POST',data:{...data,clientMessageId:'other'}})).status,400);
 });
 test('more than thirty saved works remain available and only one can execute',async t=>{
 const f=await serve(t,'many');for(let i=0;i<36;i++){const r=f.store.create('work '+i);f.store.update(r.id,'paused');}assert.equal(f.store.list().length,36);
 const [a,b]=f.store.list();f.store.update(a.id,'waiting_gpt');assert.throws(()=>f.store.update(b.id,'waiting_workbuddy'));assert.equal(f.store.get(b.id).state,'paused');
 });

 test('delete endpoint requires explicit confirmation and preserves other saved works',async t=>{const f=await serve(t,'delete'),a=f.store.create('delete me'),b=f.store.create('keep me');f.store.update(a.id,'paused');f.store.update(b.id,'paused');assert.equal((await f.request('/api/delete-work',{method:'POST',data:{runId:a.id}})).status,400);assert.equal((await f.request('/api/delete-work',{method:'POST',data:{runId:a.id,confirmation:'永久删除本地工作',path:'E:/arbitrary'}})).status,400);assert.equal((await f.request('/api/delete-work',{method:'POST',data:{runId:a.id,confirmation:'永久删除本地工作'}})).status,200);assert.throws(()=>f.store.get(a.id));assert.equal(f.store.get(b.id).goal,'keep me');assert.equal(f.calls.length,0);});
