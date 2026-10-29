import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {BridgeStore} from '../src/store.mjs';
import {driveRun} from '../src/workflow.mjs';
import {rendererRequest} from '../src/native-transport.mjs';
import {checkRequirements} from '../src/capability-preflight.mjs';
import {workerArtifacts,collect} from '../src/attachments.mjs';
import {ensureTaskWorker,taskName} from '../src/task-worker.mjs';
import {testDirectory} from './helpers.mjs';
const wrap=c=>'```bridge-command\n'+JSON.stringify(c)+'\n```';
function fixture(){const dir=testDirectory('workflow-v2'),store=new BridgeStore(path.join(dir,'state.sqlite')),run=store.create('sandbox',{runtimeMode:'test',cursor:0,workerRounds:0});return {dir,store,run};}
function reply(run,step,action,data={}){return {text:wrap({protocol:'chat-work-bridge/1',runId:run.id,commandId:'command-'+step,replyToResultId:null,action,...data}),attachments:[]};}
test('acceptance loop continues after three rounds and queues user feedback until next GPT boundary',async()=>{
 const {store,run}=fixture();let calls=0,resultId=null,sawReply=false;
 try{
  const outcome=await driveRun({store,runId:run.id,checkCapabilities:async()=>({ready:true,checks:[]}),coordinator:async(payload,m)=>{
   if(payload.text.includes('safe boundary reply'))sawReply=true;
   const r=reply(run,m.step,m.step===0?'plan':calls<5?'execute':'done',m.step===0?{acceptance:['five verified steps'],requirements:[],requiredImages:0}:calls<5?{instruction:'step '+calls,acceptance:['per-step explanatory criterion']}:{summary:'verified',checks:[{id:'A1',passed:true,evidence:'five actual replies'}]});
   const c=JSON.parse(r.text.split('\n')[1]);c.replyToResultId=resultId;r.text=wrap(c);return r;
  },worker:async(payload,m)=>{calls++;resultId=m.id;if(calls===2){store.queueInteraction(run.id,{clientMessageId:'same-id',text:'safe boundary reply'});store.queueInteraction(run.id,{clientMessageId:'same-id',text:'safe boundary reply'});}return {text:'actual '+calls,model:'hy3'};}});
  assert.equal(outcome.state,'done');assert.equal(calls,5);assert.equal(outcome.workerRounds,5);assert.deepEqual(outcome.acceptance,['five verified steps']);assert.equal(sawReply,true);assert.equal(store.interactions(run.id).length,1);assert.equal(store.interactions(run.id)[0].state,'delivered');
 }finally{store.close();}
});
test('missing capability and missing reference independently prevent any business dispatch',async()=>{
 for(const missingCapability of [true,false]){
  const {store,run}=fixture();let sends=0;
  try{const result=await driveRun({store,runId:run.id,checkCapabilities:async()=>({ready:!missingCapability,checks:[]}),coordinator:async(p,m)=>reply(run,m.step,m.step===0?'plan':'execute',m.step===0?{acceptance:['real image'],requirements:[],requiredImages:1}:{instruction:'execute'}),worker:async()=>{sends++;}});
   assert.equal(result.state,'needs_user');assert.equal(result.waitReason,missingCapability?'capability':'image');assert.equal(sends,0);
  }finally{store.close();}
 }
});
test('acceptance cannot silently change and done requires all frozen evidence',async()=>{
 for(const command of [{action:'plan',requirements:[],requiredImages:0,acceptance:['lowered']},{action:'done',checks:[]}]){
  const {store,run}=fixture();store.update(run.id,'prepared',{acceptance:['original'],workerRounds:1});
  try{const options={store,runId:run.id,checkCapabilities:async()=>({ready:true}),coordinator:async(p,m)=>reply(run,m.step,command.action,command),worker:async()=>{throw Error('must not dispatch');}};if(command.action==='plan')await assert.rejects(driveRun(options),/Frozen acceptance/);else{const result=await driveRun(options);assert.equal(result.state,'needs_user');assert.equal(result.waitReason,'protocol');}assert.deepEqual(store.get(run.id).acceptance,['original']);}finally{store.close();}
 }
});
test('durable GPT reply and user delivery acknowledgement share a transaction, uncertain sends cannot replay',()=>{
 const {dir,store,run}=fixture();const item=store.queueInteraction(run.id,{clientMessageId:'reloaded',text:'message'});
 const m=store.prepare(run.id,0,'gpt',{text:'with message',interactionIds:[item.id]});store.markSending(m.id);store.delivered(m.id,{text:'answer'});store.close();
 const next=new BridgeStore(path.join(dir,'state.sqlite'));try{assert.equal(next.interactions(run.id)[0].delivered_with,m.id);assert.throws(()=>next.markSending(m.id),/already attempted/);assert.equal(next.queueInteraction(run.id,{clientMessageId:'reloaded',text:'message'}).id,item.id);}finally{next.close();}
});
test('persistent native transport timeout preserves remote request and reuses its exact response',async()=>{
 let port,posts=0,closes=0;const timers=[];
 class Channel{constructor(){this.port1={start(){},close(){closes++;},postMessage(){posts++;}};this.port2={};port=this.port1;}}
 const context=vm.createContext({MessageChannel:Channel,Map,Promise,JSON,Error,Date,setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},window:{postMessage(){queueMicrotask(()=>port.onmessage({data:{kind:'open'}}));}}});
 vm.runInContext('var request='+rendererRequest.toString(),context);
 const first=vm.runInContext('request({channel:"session:sendMessage",args:["sid"],id:"fixed",timeoutMs:180000})',context);
 await new Promise(resolve=>setImmediate(resolve));timers.at(-1)();await assert.rejects(first,/transport retained/);assert.equal(closes,0);assert.equal(posts,1);
 const second=vm.runInContext('request({channel:"session:sendMessage",args:["sid"],id:"fixed",timeoutMs:0})',context);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(posts,1);
 port.onmessage({data:{kind:'message',text:JSON.stringify({id:'fixed',result:{stopReason:'end_turn'}})}});
 assert.equal((await second).stopReason,'end_turn');assert.equal(closes,0);assert.equal(posts,1);
});
test('capability recheck reports disabled MCP and Skill, unknown expert, and distinguishes manual software confirmation',async()=>{
 const inventory={checkedAt:'now',errors:{},mcps:[{name:'blender',enabled:false,state:'idle',tools:[]}],skills:[{name:'design',enabled:false}],experts:[]};
 const requirements=[{kind:'mcp',name:'blender'},{kind:'skill',name:'design'},{kind:'expert',name:'artist'},{kind:'application',name:'Other'}];
 let result=await checkRequirements(null,requirements,{inventory,confirmations:[{id:'application:other',kind:'application'}]});
 assert.deepEqual(result.checks.map(c=>c.status),['disabled','disabled','unknown','user_confirmed']);assert.equal(result.ready,false);
 inventory.mcps[0]={name:'blender',enabled:true,state:'ready',trusted:true,tools:[{name:'look',enabled:true}]};inventory.skills[0].enabled=true;
 result=await checkRequirements(null,requirements.slice(0,2),{inventory});assert.equal(result.ready,true);
});
test('logical GPT reply includes image sibling with a distinct message ID and excludes user uploads',async()=>{
 const img={currentSrc:'blob:https://chatgpt.com/generated',alt:'image',getAttribute(){return null},closest(){return null}};
 const userImg={...img,currentSrc:'blob:https://chatgpt.com/user',closest(){return {getAttribute:key=>key==='data-chatgpt-search-unit-key'?'turn:0:user':null}}};
 const logical={querySelectorAll:selector=>selector==='img'?[img,userImg]:[]};
 const message={getAttribute:key=>key==='data-chatgpt-search-message-ids'?'command-id':'turn:3:assistant',closest:()=>logical};
 const context=vm.createContext({document:{querySelectorAll:()=>[message]},URL});
 const page={url:()=> 'https://chatgpt.com/c/test',evaluate:async(fn,arg)=>{context.arg=arg;context.document.querySelectorAll=()=>[message];return vm.runInContext('('+fn.toString()+')(arg)',context);}};
 assert.equal(JSON.stringify((await collect(page,{messageId:'command-id'})).map(i=>i.url)),JSON.stringify(['blob:https://chatgpt.com/generated']));
});
test('workspace/session identity survives display rename; an uncertain creation is never duplicated',async()=>{
 const root=testDirectory('task-binding');let creates=0,remote;
 const rpc=async(page,channel,args)=>{if(channel==='session:create'){creates++;remote={id:args[0].sessionId,cwd:args[0].cwd,model:'hy3'};return remote;}if(channel==='session:get')return {...remote,name:'user renamed'};return true;};
 const run={id:'run-test1234',goal:'image modelling'};
 const first=await ensureTaskWorker(null,run,{root,rpc,base:{mode:'normal',model:'hy3'}}),second=await ensureTaskWorker(null,run,{root,rpc,base:{mode:'normal',model:'hy3'}});
 assert.equal(first.sessionId,second.sessionId);assert.equal(creates,1);assert.match(taskName('hello',new Date('2026-10-27T01:00:00Z')),/^2026-10-27 hello$/);
 const manifest=JSON.parse(fs.readFileSync(path.join(root,'data/capability-bindings.json')));manifest[0].stage='uncertain';fs.writeFileSync(path.join(root,'data/capability-bindings.json'),JSON.stringify(manifest));
 await assert.rejects(ensureTaskWorker(null,run,{root,rpc,base:{mode:'normal',model:'hy3'}}),/uncertain/);assert.equal(creates,1);
});
test('large and native project artifacts retain honest metadata while render images carry verified bytes',()=>{
 const workspace=testDirectory('artifact-v2'),file=path.join(workspace,'project.blend');fs.writeFileSync(file,'BLENDER');
 const files=workerArtifacts('```bridge-artifacts\n'+JSON.stringify({files:[file]})+'\n```',{workspace});assert.equal(files[0].uploadable,false);assert.equal(files[0].sha256,undefined);
 assert.throws(()=>workerArtifacts('```bridge-artifacts\n'+JSON.stringify({files:[path.join(workspace,'../outside')]})+'\n```',{workspace}),/OUTSIDE_TASK/);
});
test('acceptance revisions need an explicit, atomic and idempotent approval',()=>{
 const {store,run}=fixture();
 try{
  store.update(run.id,'needs_user',{acceptance:['original'],acceptanceVersion:1,acceptanceProposal:{id:'proposal-1',acceptance:['approved change']}});
  store.queueInteraction(run.id,{clientMessageId:'ordinary',text:'继续'});assert.deepEqual(store.get(run.id).acceptance,['original']);
  assert.throws(()=>store.approveAcceptance(run.id,{proposalId:'proposal-1',clientMessageId:'bad!'}),/identity/);assert.deepEqual(store.get(run.id).acceptance,['original']);
  const first=store.approveAcceptance(run.id,{proposalId:'proposal-1',clientMessageId:'approval-1'}),again=store.approveAcceptance(run.id,{proposalId:'proposal-1',clientMessageId:'approval-1'});
  assert.equal(first.reused,false);assert.equal(again.reused,true);assert.equal(again.run.acceptanceVersion,2);assert.deepEqual(again.run.acceptance,['approved change']);assert.equal(store.interactions(run.id).filter(i=>i.kind==='acceptance_approval').length,1);
 }finally{store.close();}
});
test('native JSON artifact blocks are parsed without treating unrelated JSON as a file manifest',()=>{
 const workspace=testDirectory('artifact-json'),file=path.join(workspace,'proof.txt');fs.writeFileSync(file,'proof');
 const result=workerArtifacts('```json\n{"elapsedMs":190012}\n```\n```json\n'+JSON.stringify({files:[file]})+'\n```',{workspace});assert.equal(result.length,1);assert.equal(result[0].uploadable,true);
});
test('proven upload failure before submit can resume the same outbox without repeating completed worker work',async()=>{
 const {store,run}=fixture();let workerCalls=0,resultId=null,failed=false;
 const coordinator=async(payload,m)=>{
  if(m.step===2&&!failed){failed=true;throw Object.assign(Error('upload failed before submit'),{noSubmit:true});}
  const c={protocol:'chat-work-bridge/1',runId:run.id,commandId:'c-'+m.step,replyToResultId:resultId,action:m.step===0?'plan':m.step===1?'execute':'done',...(m.step===0?{acceptance:['proof'],requirements:[],requiredImages:0}:m.step===1?{instruction:'one safe task'}:{checks:[{id:'A1',passed:true,evidence:'actual completed worker'}]})};
  return {text:wrap(c),attachments:[]};
 };
 const options={store,runId:run.id,coordinator,checkCapabilities:async()=>({ready:true}),worker:async(p,m)=>{workerCalls++;resultId=m.id;return {text:'completed'};}};
 try{
  await assert.rejects(driveRun(options),/before submit/);const before=store.messageAt(run.id,2,'gpt');assert.equal(before.state,'prepared');assert.equal(workerCalls,1);
  const final=await driveRun(options);assert.equal(final.state,'done');assert.equal(workerCalls,1);assert.equal(store.messageAt(run.id,2,'gpt').id,before.id);
 }finally{store.close();}
});

 test('saved completed work executes a fresh phase without replaying prior commands',async()=>{
 const {store,run}=fixture();try{
 const prior=store.prepare(run.id,2,'gpt',{text:'old phase'});store.markSending(prior.id);store.delivered(prior.id,{text:'old done'});store.update(run.id,'done',{cursor:2,acceptance:['old standard'],workerRounds:1,replyToResultId:'old-result',commands:[{id:'old-command',step:2}],workerWorkspace:'E:/retained'});
 store.continueWork(run.id,{goal:'new requested phase',clientMessageId:'phase-two'});let resultId='old-result',calls=0;
 const done=await driveRun({store,runId:run.id,checkCapabilities:async()=>({ready:true}),coordinator:async(payload,m)=>{if(m.step===3){assert.match(payload.text,/new requested phase/);assert.match(payload.text,/stage2-/);}const action=m.step===3?'plan':m.step===4?'execute':'done';return reply(run,m.step,action,{commandId:'stage2-'+m.step,replyToResultId:resultId,...(action==='plan'?{acceptance:['new standard'],requirements:[],requiredImages:0}:action==='execute'?{instruction:'new work only'}:{summary:'second phase passed',checks:[{id:'A1',passed:true,evidence:'actual new result'}]})});},worker:async(payload,m)=>{calls++;resultId=m.id;return{text:'new artifact',model:'hy3'};}});
 assert.equal(done.state,'done');assert.equal(calls,1);assert.equal(done.stage,2);assert.deepEqual(done.acceptance,['new standard']);assert.deepEqual(done.completedStages[0].acceptance,['old standard']);assert.equal(store.messages(run.id).filter(m=>m.direction==='workbuddy').length,1);
 }finally{store.close();}
 });
 test('saved WorkBuddy session reloads by identity after restart and never creates a replacement',async()=>{
 const dir=testDirectory('reload-saved-worker'),workspace=path.join(dir,'saved');fs.mkdirSync(workspace,{recursive:true});fs.mkdirSync(path.join(dir,'data'),{recursive:true});const binding={taskRunId:'saved',stage:'ready',mode:'test',sessionId:'stable-id',workspace,model:'hy3'};fs.writeFileSync(path.join(dir,'data/capability-bindings.json'),JSON.stringify([binding]));
 let loaded=false;const calls=[];const rpc=async(p,channel,args)=>{calls.push(channel);if(channel==='session:get')return loaded?{sessionId:'stable-id',cwd:workspace,model:'hy3',name:'user renamed'}:null;if(channel==='daemon:getActiveSessions')return[];if(channel==='session:load'){assert.equal(args[0],'stable-id');loaded=true;return; }throw Error('Unexpected mutation');};
 const result=await ensureTaskWorker(null,{id:'saved'},{root:dir,base:{mode:'test'},rpc});assert.equal(result.displayName,'user renamed');assert.deepEqual(calls,['session:get','daemon:getActiveSessions','session:load','session:get']);
 });
