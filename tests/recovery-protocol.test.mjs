import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {testDirectory} from './helpers.mjs';
import {BridgeStore} from '../src/store.mjs';
import {parseCommand} from '../src/protocol.mjs';
import {verifiedCoordinatorAttachments} from '../src/loop.mjs';
const command={protocol:'chat-work-bridge/1',runId:'run-test',commandId:'step-1',replyToResultId:'result-1',action:'execute',instruction:'Compute 19+23',acceptance:['42']};
const text=c=>'```bridge-command\n'+JSON.stringify(c)+'\n```';
test('only correlated commands accepted; external data cannot widen scope',()=>{
  assert.equal(parseCommand(text(command),{runId:'run-test',replyToResultId:'result-1'}).instruction,'Compute 19+23');
  for(const bad of [{...command,runId:'other'},{...command,replyToResultId:'old'},{...command,workspace:'C:/'},{...command,action:'powershell'},{...command,instruction:''}])assert.throws(()=>parseCommand(text(bad),{runId:'run-test',replyToResultId:'result-1'}));
  assert.throws(()=>parseCommand(text(command)+'\n'+text(command),{runId:'run-test',replyToResultId:'result-1'}));
});
test('durable outbox prevents resend after interrupted delivery and preserves accepted messages',()=>{
  const file=path.join(testDirectory('recovery'),'state.sqlite');
  let s=new BridgeStore(file);const r=s.create('probe');
  const m=s.prepare(r.id,0,'gpt',{text:'first'});assert.equal(s.prepare(r.id,0,'gpt',{text:'first'}).id,m.id);
  assert.throws(()=>s.prepare(r.id,0,'gpt',{text:'changed'}));
  s.markSending(m.id);s.delivered(m.id,{reply:'ok'});
  const pending=s.prepare(r.id,1,'workbuddy',{text:'task'});s.markSending(pending.id);s.close();
  s=new BridgeStore(file);const lease=s.acquireRunner();assert.deepEqual(s.recover(lease),[pending.id]);assert.equal(s.get(r.id).state,'uncertain');assert.equal(s.message(m.id).state,'delivered');assert.equal(s.message(pending.id).state,'uncertain');assert.throws(()=>s.markSending(pending.id));assert.deepEqual(s.recover(lease),[]);s.releaseRunner(lease);s.close();
});

test('structured completion summary remains bounded inert data',()=>{
  const done={...command,action:'done',summary:{sum:82,sumOfSquares:2486}};
  const parsed=parseCommand(text(done),{runId:'run-test',replyToResultId:'result-1'});
  assert.equal(parsed.summary,'{"sum":82,"sumOfSquares":2486}');
  for(const summary of [null,[],{text:'x'.repeat(12001)}])assert.throws(()=>parseCommand(text({...done,summary}),{runId:'run-test',replyToResultId:'result-1'}));
});

test('live runner lease prevents a concurrent runner from recovering its messages',()=>{
 const file=path.join(testDirectory('lease'),'state.sqlite');
 const a=new BridgeStore(file),b=new BridgeStore(file);const lease=a.acquireRunner();
 assert.throws(()=>b.acquireRunner(),/Another bridge runner is active/);
 const run=a.create('still running'),message=a.prepare(run.id,0,'gpt',{text:'first'});a.markSending(message.id);
 assert.throws(()=>b.recover(),/Runner lease required/);assert.throws(()=>b.recover('wrong-token'),/Runner lease required/);
 assert.equal(a.message(message.id).state,'sending');
 a.releaseRunner(lease);const next=b.acquireRunner();assert.ok(next);b.releaseRunner(next);a.close();b.close();
});

test('crash after durable delivery becomes resumable without replaying accepted messages',()=>{
 const file=path.join(testDirectory('delivered-crash'),'state.sqlite');
 let s=new BridgeStore(file);const run=s.create('resume delivery');const message=s.prepare(run.id,0,'workbuddy',{instruction:'once'});
 s.update(run.id,'waiting_workbuddy');s.markSending(message.id);s.delivered(message.id,{text:'already finished'});s.close();
 s=new BridgeStore(file);const lease=s.acquireRunner();assert.deepEqual(s.recover(lease),[]);
 assert.equal(s.get(run.id).state,'paused');assert.equal(s.message(message.id).state,'delivered');assert.throws(()=>s.markSending(message.id),/already attempted/);
 s.releaseRunner(lease);s.close();
});

test('saved coordinator attachment failure or absent manifest cannot resume without references',()=>{
 assert.throws(()=>verifiedCoordinatorAttachments({attachments:[],attachmentError:'download failed'}),/attachment transfer failed/);
 assert.throws(()=>verifiedCoordinatorAttachments({id:'old-response-with-no-manifest'}),/manifest is missing/);
 assert.deepEqual(verifiedCoordinatorAttachments({attachments:[]}),[]);
 const attachments=[{path:'E:/synthetic-reference.png'}];assert.equal(verifiedCoordinatorAttachments({attachments}),attachments);
});
