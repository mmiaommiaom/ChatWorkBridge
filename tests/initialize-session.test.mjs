import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {initializeSession} from '../src/initialize-session.mjs';
import {BridgeStore} from '../src/store.mjs';
import {testDirectory} from './helpers.mjs';

function fixture(label,{onCreate,onGet,active=[]}={}){
  const projectDir=testDirectory('initialize-'+label),calls=[];
  let session=null,closed=0;
  const connect=async options=>{assert.equal(options.mode,'test');return{page:{synthetic:true},browser:{async close(){closed++;}}};};
  const rpc=async(page,channel,args)=>{
    assert.equal(page.synthetic,true);calls.push({channel,args});
    if(channel==='daemon:getActiveSessions')return active;
    if(channel==='workspace:initialize')return{success:true};
    if(channel==='session:create'){
      session={sessionId:args[0].sessionId,cwd:args[0].cwd,model:args[0].config.model,status:'pending'};
      if(onCreate)return onCreate(session);
      return{sessionId:session.sessionId,cwd:session.cwd};
    }
    if(channel==='session:updateConfig'){session.model=args[1].model;return{};}
    if(channel==='session:rename'||channel==='session:load')return{};
    if(channel==='session:get')return onGet?onGet(session):session;
    throw Error('Unexpected RPC; no model or external tool may be called: '+channel);
  };
  const bindingFile=path.join(projectDir,'data/desktop-binding.json');
  return{projectDir,connect,rpc,calls,bindingFile,get closed(){return closed;}};
}

test('failed connection leaves no reserved binding or workspaces',async()=>{
  const f=fixture('connection-failed');
  await assert.rejects(initializeSession({...f,connect:async()=>{throw Error('synthetic offline');}}),/offline/);
  assert.equal(fs.existsSync(f.bindingFile),false);
  assert.equal(fs.existsSync(path.join(f.projectDir,'workspaces')),false);
  assert.equal(f.calls.length,0);
});

test('initialization never sends messages and ready reuse only reads the existing session',async()=>{
  const f=fixture('create-reuse');
  const first=await initializeSession(f);
  assert.equal(first.stage,'ready');assert.equal(first.reused,false);
  assert.equal(first.messagesSent,0);assert.equal(first.modelInferenceRequested,false);
  assert.equal(first.model,'deepseek-v4.1-flash');
  assert.deepEqual(f.calls.map(call=>call.channel),['daemon:getActiveSessions','workspace:initialize','session:create','session:rename','session:updateConfig','session:load','session:get']);
  assert.equal(f.calls.some(call=>/sendMessage/.test(call.channel)),false);
  const original=fs.readFileSync(f.bindingFile,'utf8');
  const before=f.calls.length;
  const second=await initializeSession(f);
  assert.equal(second.sessionId,first.sessionId);assert.equal(second.reused,true);
  assert.equal(fs.readFileSync(f.bindingFile,'utf8'),original);
  assert.deepEqual(f.calls.slice(before).map(call=>call.channel),['daemon:getActiveSessions','session:get']);
  assert.equal(f.closed,2);
});

test('create timeout persists uncertainty and repeated initialization never creates again',async()=>{
  const f=fixture('create-timeout',{onCreate(){throw Error('Synthetic transport timeout after remote creation');}});
  await assert.rejects(initializeSession(f),/timeout/);
  const saved=JSON.parse(fs.readFileSync(f.bindingFile,'utf8'));
  assert.equal(saved.stage,'uncertain');
  const original=fs.readFileSync(f.bindingFile,'utf8');
  await assert.rejects(initializeSession(f),error=>error.code==='SESSION_INITIALIZATION_UNCERTAIN'&&error.sessionId===saved.sessionId&&error.remoteSessionFound===true);
  assert.equal(f.calls.filter(call=>call.channel==='session:create').length,1);
  assert.equal(fs.readFileSync(f.bindingFile,'utf8'),original);
  assert.equal(f.closed,2);
});

test('reconnect preserves an approved fallback model without resetting configuration',async()=>{
  const f=fixture('fallback');
  const first=await initializeSession(f);
  const original=fs.readFileSync(f.bindingFile,'utf8');
  const before=f.calls.length;
  const rpc=async(page,channel,args)=>{
    const result=await f.rpc(page,channel,args);
    return channel==='session:get'?{...result,model:'hy3'}:result;
  };
  const result=await initializeSession({...f,rpc});
  assert.equal(result.model,'hy3');
  assert.equal(result.sessionId,first.sessionId);
  assert.equal(fs.readFileSync(f.bindingFile,'utf8'),original);
  assert.deepEqual(f.calls.slice(before).map(call=>call.channel),['daemon:getActiveSessions','session:get']);
});

test('uncertain local tasks block reconnection before any remote calls',async()=>{
  const f=fixture('paused-local-task');
  fs.mkdirSync(path.join(f.projectDir,'data'),{recursive:true});
  const store=new BridgeStore(path.join(f.projectDir,'data/bridge.sqlite'));
  try{const run=store.create('Synthetic uncertain task');store.update(run.id,'uncertain');}
  finally{store.close();}
  await assert.rejects(initializeSession({...f,connect:async()=>{throw Error('Must not connect');}}),/尚未结束/);
  assert.equal(f.calls.length,0);
  assert.equal(fs.existsSync(f.bindingFile),false);
});

test('mismatched remote directory or model fails initialization and is never marked ready',async()=>{
  for(const kind of ['directory','model']){
    const f=fixture('wrong-'+kind,{onGet(session){return{...session,...(kind==='directory'?{cwd:path.join(session.cwd,'another-workspace')}:{model:'hy3'})};}});
    await assert.rejects(initializeSession(f),{code:'SESSION_BINDING_MISMATCH'});
    assert.equal(JSON.parse(fs.readFileSync(f.bindingFile,'utf8')).stage,'uncertain');
    assert.equal(f.closed,1);
  }
});

test('an active task blocks reservation before any write or create RPC',async()=>{
  const f=fixture('busy',{active:[{sessionId:'synthetic-running-task'}]});
  await assert.rejects(initializeSession(f),{code:'SESSION_NOT_IDLE'});
  assert.equal(fs.existsSync(f.bindingFile),false);
  assert.deepEqual(f.calls.map(call=>call.channel),['daemon:getActiveSessions']);
  assert.equal(f.closed,1);
});

test('tampered ready binding is refused without connecting or changing it',async()=>{
  const f=fixture('tampered');
  await initializeSession(f);
  const binding=JSON.parse(fs.readFileSync(f.bindingFile,'utf8'));
  binding.workspace=path.join(f.projectDir,'other-workspace');
  fs.writeFileSync(f.bindingFile,JSON.stringify(binding));
  const original=fs.readFileSync(f.bindingFile,'utf8');
  await assert.rejects(initializeSession({...f,connect:async()=>{throw Error('Must not connect for invalid binding');}}),{code:'SESSION_BINDING_MISMATCH'});
  assert.equal(fs.readFileSync(f.bindingFile,'utf8'),original);
});

test('initialization and database reject C, relative, UNC and C-linked data destinations before creating files',async()=>{
  for(const value of ['C:/must-not-write','relative-must-not-write','\\\\server\\share\\must-not-write']){
    await assert.rejects(initializeSession({projectDir:value,connect:async()=>{throw Error('Must not connect for invalid path');}}));
    assert.throws(()=>new BridgeStore(value));
  }
  const projectDir=testDirectory('initialize-c-link'),link=path.join(projectDir,'c-junction');
  fs.symlinkSync('C:\\',link,'junction');
  await assert.rejects(initializeSession({projectDir:path.join(link,'synthetic-missing'),connect:async()=>{throw Error('Must not connect for C junction');}}),/C 盘/);
  assert.throws(()=>new BridgeStore(path.join(link,'synthetic-missing','bridge.sqlite')),/C 盘/);
});
