import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {activateNormal} from '../scripts/activate-normal-workbuddy.mjs';
import {validateDesktopState} from '../src/workbuddy-desktop.mjs';
import {testDirectory} from './helpers.mjs';

function fixture(label,{onCreate,onGet,active=[]}={}){
 const projectDir=testDirectory('normal-'+label),calls=[];
 let session=null,closed=0;
 const configLoader=()=>({allowNormalProfile:true,allowNativeRuntimeRecords:true,workbuddyProfile:path.join(projectDir,'synthetic-profile')});
 const connect=async ({mode})=>{assert.equal(mode,'normal');return {page:{synthetic:true},browser:{async close(){closed++;}}};};
 const rpc=async(page,channel,args)=>{
  assert.equal(page.synthetic,true);calls.push({channel,args});
  if(channel==='daemon:getActiveSessions')return active;
  if(channel==='session:create'){
   session={sessionId:args[0].sessionId,cwd:args[0].cwd,model:args[0].config.model,status:'pending'};
   return onCreate?onCreate(session):session;
  }
  if(channel==='session:rename'||channel==='session:load')return {};
  if(channel==='session:get')return onGet?onGet(session):session;
  if(channel==='mcp:list')return [{name:'synthetic-mcp',enabled:true,state:'connected'}];
  throw Error('Unexpected native mutation '+channel);
 };
 return {projectDir,calls,rpc,connect,configLoader,bindingFile:path.join(projectDir,'data/normal-binding.json'),modeFile:path.join(projectDir,'config/active-runtime.json'),get closed(){return closed;}};
}

test('normal initialization sends no model messages and reuse does not reset the selected model',async()=>{
 const f=fixture('reuse');const first=await activateNormal(f);
 assert.equal(first.messagesSent,0);assert.equal(first.stage,'ready');assert.equal(first.reused,false);
 assert.equal(JSON.parse(fs.readFileSync(f.modeFile)).mode,'normal');
 const initial=fs.readFileSync(f.bindingFile,'utf8'),count=f.calls.length;
 const second=await activateNormal({...f,rpc:async(page,channel,args)=>channel==='session:get'?{sessionId:first.sessionId,cwd:first.workspace,model:'hy3',status:'idle'}:f.rpc(page,channel,args)});
 assert.equal(second.reused,true);assert.equal(second.model,'hy3');assert.equal(fs.readFileSync(f.bindingFile,'utf8'),initial);
 assert.equal(f.calls.some(c=>['session:sendMessage','session:updateConfig'].includes(c.channel)),false);
 assert.deepEqual(f.calls.slice(count).map(c=>c.channel),['daemon:getActiveSessions','mcp:list']);assert.equal(f.closed,2);
});

test('normal connection failure and busy tasks do not reserve sessions or switch mode',async()=>{
 const f=fixture('offline');await assert.rejects(activateNormal({...f,connect:async()=>{throw Error('offline');}}),/offline/);
 assert.equal(fs.existsSync(f.bindingFile),false);assert.equal(fs.existsSync(f.modeFile),false);
 const busy=fixture('busy',{active:[{id:'existing-user-task'}]});await assert.rejects(activateNormal(busy),{code:'SESSION_NOT_IDLE'});
 assert.equal(fs.existsSync(busy.bindingFile),false);assert.deepEqual(busy.calls.map(c=>c.channel),['daemon:getActiveSessions']);
});

test('uncertain normal creation is persisted and retry cannot create a second session',async()=>{
 const f=fixture('timeout',{onCreate(){throw Error('transport timeout after creation');}});
 await assert.rejects(activateNormal(f),/timeout/);
 assert.equal(JSON.parse(fs.readFileSync(f.bindingFile)).stage,'uncertain');assert.equal(fs.existsSync(f.modeFile),false);
 await assert.rejects(activateNormal(f),{code:'SESSION_INITIALIZATION_UNCERTAIN'});
 assert.equal(f.calls.filter(c=>c.channel==='session:create').length,1);
});

test('normal session identity, directory, model and pending approvals are verified before activation',async()=>{
 const alterations=[{cwd:'E:/some-other-project'},{sessionId:'some-other-session'},{model:'paid-model'},{pendingPermissions:[{id:'pending'}]}];
 for(const [i,patch] of alterations.entries()){
  const f=fixture('mismatch-'+i,{onGet:s=>({...s,...patch})});await assert.rejects(activateNormal(f));
  assert.equal(JSON.parse(fs.readFileSync(f.bindingFile)).stage,'uncertain');assert.equal(fs.existsSync(f.modeFile),false);
 }
});

test('tampered normal binding is rejected before connecting',async()=>{
 const f=fixture('tampered');await activateNormal(f);
 const b=JSON.parse(fs.readFileSync(f.bindingFile));b.workspace=path.join(f.projectDir,'not-owned');fs.writeFileSync(f.bindingFile,JSON.stringify(b));
 await assert.rejects(activateNormal({...f,connect:async()=>{throw Error('Must not connect');}}),{code:'SESSION_BINDING_MISMATCH'});
});

test('desktop binding rejects stale executable, daily config, port and revoked permission',()=>{
 const cfg={workbuddyExe:'D:/Apps/WorkBuddyAI.exe',workbuddyProfile:'D:/Profile',workbuddyConfigDir:'D:/Profile/.workbuddy-ai',testProfile:'E:/TestProfile',allowNormalProfile:true,allowNativeRuntimeRecords:true,ports:{normalWorkbuddy:18693,workbuddy:18690}};
 const state={exe:cfg.workbuddyExe,profile:cfg.workbuddyProfile,config:cfg.workbuddyConfigDir,port:18693,pid:123};
 assert.equal(validateDesktopState(state,cfg,'normal'),18693);
 for(const patch of [{exe:'D:/Other/WorkBuddyAI.exe'},{config:'D:/Profile/Other'},{profile:'D:/Other'},{pid:'123'},{port:18690},{exitedAt:'today'}])assert.throws(()=>validateDesktopState({...state,...patch},cfg,'normal'));
 assert.throws(()=>validateDesktopState(state,{...cfg,allowNormalProfile:false},'normal'));
 assert.throws(()=>validateDesktopState(state,{...cfg,allowNativeRuntimeRecords:false},'normal'));
});
