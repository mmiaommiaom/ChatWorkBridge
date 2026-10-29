import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
import {testDirectory} from './helpers.mjs';
import {approvedModel,selectModel,providerFailure} from '../src/model-policy.mjs';
import {routeApprovedTask} from '../src/model-router.mjs';import {performCapability} from '../src/capability-tools.mjs';
test('only the three explicitly approved model IDs are callable',()=>{
 assert.equal(approvedModel('deepseek-4.1flash'),'deepseek-v4.1-flash');
 for(const id of ['auto','default-model','gpt-6-astra','deepseek-v4.1-flash-sg'])assert.throws(()=>approvedModel(id),/approval/);
 assert.throws(()=>selectModel({states:Object.fromEntries(['hy3','step-5-preview','deepseek-v4.1-flash'].map(m=>[m,{quotaExhausted:true}]))}),/paid models require/);
});
test('simulated quota exhaustion skips model without calling paid models',async()=>{
 const calls=[],states={};const result=await routeApprovedTask(async model=>{calls.push(model);if(calls.length===1){const e=new Error('quota exhausted');e.safeToRetry=true;throw e;}return{text:'ok'};},{states});
 assert.deepEqual(calls,['deepseek-v4.1-flash','hy3']);assert.equal(result.model,'hy3');assert.equal(states['deepseek-v4.1-flash'].quotaExhausted,true);
 assert.equal(selectModel({states}),'hy3');
});
test('uncertain or side-effecting failures never trigger automatic replay',async()=>{
 let calls=0;await assert.rejects(routeApprovedTask(async()=>{calls++;throw new Error('quota exhausted');}),/quota/);assert.equal(calls,1);
});
test('saving accepted output never triggers another model even if disk error resembles quota',async()=>{
 let calls=0;const localError=Object.assign(new Error('quota exhausted while saving state'),{safeToRetry:true});
 await assert.rejects(routeApprovedTask(async()=>{calls++;return {text:'already executed'};},{persist:()=>{throw localError;}}),error=>error===localError);
 assert.equal(calls,1);
});
test('result model mismatch is never retried or counted as a verified success',async()=>{
 let calls=0;const states={};await assert.rejects(routeApprovedTask(async()=>{calls++;return {text:'wrong model',model:'paid-model'};},{states}),/different from the approved/);
 assert.equal(calls,1);assert.deepEqual(states,{});
});
test('synthetic Step 500 fixture is a service error, not quota exhaustion',()=>{
 // Synthetic protocol fixture, not a captured provider response or live test.
 const result={_meta:{'codebuddy.ai/outcome':'FAILED_MODEL_REQUEST','codebuddy.ai/errorMessage':JSON.stringify({message:'Synthetic provider failure',data:{statusCode:500,code:'internal_server_error',details:'Synthetic service unavailable'}})}};
 const e=providerFailure(result);assert.equal(e.status,500);assert.equal(e.category,'service_error');
});
test('controlled tools reject paths, arbitrary commands and browser actions before execution',async()=>{
 const workspace=testDirectory('boundaries');const policy=path.join(workspace,'policy.json');
 fs.writeFileSync(policy,JSON.stringify({workspace,browserTargetId:'synthetic-target',browserUrl:'http://127.0.0.1/synthetic-test'}));
 const previous=process.env.WB_BRIDGE_CAPABILITY_CONFIG;process.env.WB_BRIDGE_CAPABILITY_CONFIG=policy;
 try{
  for(const p of ['../escape.txt','C:/synthetic-test.txt','note.txt:stream','NOTE.TXT','sub/note.txt'])await assert.rejects(performCapability('write_file',{path:p,content:'blocked'}),/PATH_DENIED/);
  await assert.rejects(performCapability('run_command',{command:'powershell'}),/COMMAND_DENIED/);
  await assert.rejects(performCapability('browser_action',{action:'navigate',text:'https://example.com'}),/UI_ACTION_DENIED/);
  await assert.rejects(performCapability('delete_file',{}),/TOOL_DENIED/);
  assert.equal(fs.existsSync(path.join(workspace,'note.txt')),false);
 }finally{if(previous===undefined)delete process.env.WB_BRIDGE_CAPABILITY_CONFIG;else process.env.WB_BRIDGE_CAPABILITY_CONFIG=previous;}
});
