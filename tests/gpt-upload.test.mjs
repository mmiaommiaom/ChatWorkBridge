import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {uploadGptFiles,commandText} from '../src/chatgpt-web.mjs';
import {parseCommand} from '../src/protocol.mjs';
import {testDirectory} from './helpers.mjs';
function fixture(){const file=path.join(testDirectory('gpt-upload'),'reference.png'),bytes=Buffer.from([137,80,78,71,13,10,26,10]);fs.writeFileSync(file,bytes);return {path:file,name:'reference.png',size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mimeType:'image/png',kind:'image'};}
function fakePage(existing=0){
 const uploads=[],types=[['image/*',false],['image/*,video/*',true],['image/*',true],['',true]];
 const inputs=types.map(([accept,multiple],index)=>({getAttribute:async key=>key==='accept'?accept:key==='multiple'&&multiple?'':null,setInputFiles:async files=>uploads.push({index,files})}));
 return {uploads,locator:selector=>selector==='input[type=file]'?{count:async()=>inputs.length,nth:i=>inputs[i]}:{count:async()=>existing},evaluate:async()=>({ready:true,error:false})};
}
test('GPT uses the verified multiple-photo input instead of camera, video or document controls',async()=>{
 const page=fakePage(),file=fixture(),receipt=await uploadGptFiles(page,[file]);assert.equal(page.uploads[0].index,2);assert.equal(receipt[0].sha256,file.sha256);assert.equal(receipt[0].verified,'composer_filename_and_ready');
});
test('GPT upload refuses existing user attachments and changed local bytes before submitting',async()=>{
 const file=fixture(),page=fakePage(1);await assert.rejects(uploadGptFiles(page,[file]),/Existing human attachments/);assert.equal(page.uploads.length,0);
 fs.writeFileSync(file.path,'changed');const next=fakePage();await assert.rejects(uploadGptFiles(next,[file]),/FILE_CHANGED/);assert.equal(next.uploads.length,0);
});
test('exact renderer escape wrapper is normalized without extracting commands from unrelated prose',()=>{
 const c={protocol:'chat-work-bridge/1',runId:'r',commandId:'cmd',replyToResultId:null,action:'execute',instruction:'read reference'};
 const turn={codes:['<escape>'+JSON.stringify(c)+'</escape>'],text:'rendered code'};
 assert.equal(parseCommand(commandText(turn),{runId:'r'}).instruction,'read reference');
 assert.throws(()=>parseCommand(commandText({codes:['prose '+JSON.stringify(c)],text:'prose'}),{runId:'r'}));
});
