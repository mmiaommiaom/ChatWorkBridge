import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveRunTab} from '../src/gpt-tab.mjs';
const url='https://chatgpt.com/c/saved-chat';
const run={gptTargetId:'old',gptUrl:url};
const messages=[{direction:'gpt',state:'delivered',result:{id:'assistant',userMessageId:'user',url}}];
function fixture(pages,turns=[{id:'user',role:'user'},{id:'assistant',role:'assistant'}]){
 let opens=0,navigations=0;
 const context={pages:()=>pages,newPage:async()=>{opens++;return {id:'new',url:()=>url,goto:async target=>{assert.equal(target,url);navigations++;}};}};
 return {context,options:{idOf:async p=>p.id,read:async()=>turns,idle:async()=>{}},counts:()=>({opens,navigations})};
}
test('reopened browser rebinds saved conversation by verified message pair without opening another tab',async()=>{
 const page={id:'reopened',url:()=>url},f=fixture([page]);const binding=await resolveRunTab(f.context,run,messages,f.options);
 assert.equal(binding.page,page);assert.equal(binding.targetId,'reopened');assert.equal(binding.priorTargetId,'old');assert.deepEqual(f.counts(),{opens:0,navigations:0});
});
test('closed saved conversation opens only its saved URL once and never sends anything',async()=>{
 const f=fixture([{id:'human',url:()=> 'https://chatgpt.com/c/other'}]);await resolveRunTab(f.context,run,messages,f.options);assert.deepEqual(f.counts(),{opens:1,navigations:1});
});
test('wrong history, competing human input, duplicate tabs and missing receipts cannot rebind',async()=>{
 for(const turns of [[{id:'wrong',role:'assistant'}],[{id:'user',role:'user'},{id:'assistant',role:'assistant'},{id:'human',role:'user'}]]){
  const f=fixture([{id:'new',url:()=>url}],turns);await assert.rejects(resolveRunTab(f.context,run,messages,f.options),/消息/);
 }
 const f=fixture([{id:'one',url:()=>url},{id:'two',url:()=>url}]);await assert.rejects(resolveRunTab(f.context,run,messages,f.options),/多个标签/);
 await assert.rejects(resolveRunTab(f.context,run,[],f.options),/缺少/);
});
test('an existing human draft remains protected after target ID changes',async()=>{
 const f=fixture([{id:'new',url:()=>url}]);await assert.rejects(resolveRunTab(f.context,run,messages,{...f.options,idle:async()=>{throw Error('Existing draft; tab retained');}}),/Existing draft/);assert.deepEqual(f.counts(),{opens:0,navigations:0});
});
