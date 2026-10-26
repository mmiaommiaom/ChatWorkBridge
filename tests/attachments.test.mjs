import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {testDirectory} from './helpers.mjs';
import {allowedAttachmentUrl,collect,download,nativeBlocks} from '../src/attachments.mjs';

const root=testDirectory('attachments');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=','base64');
function fakePage(items,responses){
  const requests=[];
  return {
    requests,url:()=> 'https://chatgpt.com/c/test-chat',
    async evaluate(fn,args){
      if(fn.toString().includes('document.querySelectorAll'))return items;
      requests.push(args.url);
      const response=responses.get(args.url);
      if(response instanceof Error)throw response;
      return response;
    }
  };
}
const candidate=(url,name='reference.png',kind='image')=>({url,name,kind,messageId:'test-message',role:'assistant'});
const payload=(data,mimeType)=>({data:Buffer.from(data).toString('base64'),mimeType});

test('attachment URL rules refuse local, internal, unrelated and disguised origins',()=>{
  for(const value of ['https://chatgpt.com/backend-api/files/download/1','https://chatgpt.com/backend-api/files/file-123/download','https://chatgpt.com/backend-api/files/file-123/content','https://chatgpt.com/backend-api/estuary/content?id=file-123','blob:https://chatgpt.com/abc','https://files.oaiusercontent.com/file-1?signature=secret'])assert.equal(allowedAttachmentUrl(value),true,value);
  for(const value of ['file:///E:/secret.txt','http://127.0.0.1/x','https://192.168.0.1/x','https://example.com/x','https://chatgpt.com/c/other','https://chatgpt.com/backend-api/me','https://chatgpt.com/backend-api/accounts','https://chatgpt.com/backend-api/settings','https://chatgpt.com/backend-api/conversations','https://chatgpt.com/backend-api/me/accounts/settings/conversations','https://chatgpt.com/backend-api/files','https://chatgpt.com/backend-api/files/file-123/metadata','https://chatgpt.com/backend-api/estuary/content/extra','https://chatgpt.com.evil.test/backend-api/x','https://files.oaiusercontent.com.evil.test/x','https://user:pass@files.oaiusercontent.com/x','https://files.oaiusercontent.com:8443/x','blob:https://example.com/abc','data:image/png;base64,abc'])assert.equal(allowedAttachmentUrl(value),false,value);
});

test('user uploads beside the bubble are collected without guessing file-button URLs',async()=>{
  const blob='blob:https://chatgpt.com/fixture-image';
  const bubble={querySelectorAll:()=>[]};
  const image={currentSrc:blob,src:blob,alt:'用户附件',getAttribute:()=>null};
  const message={
    getAttribute:name=>name==='data-chatgpt-search-message-ids'?'uploaded-message':name==='data-chatgpt-search-unit-key'?'message:user':null,
    querySelector:()=>bubble,
    querySelectorAll:selector=>selector==='img'?[image]:[]
  };
  const prior=globalThis.document;
  globalThis.document={querySelectorAll:selector=>selector.startsWith('[data-chatgpt-search-unit-key]')?[message]:[]};
  try{
    const page={url:()=> 'https://chatgpt.com/c/fixture',evaluate:(fn,args)=>fn(args)};
    const items=await collect(page,{messageId:'uploaded-message',role:'user'});
    assert.equal(items.length,1);assert.equal(items[0].url,blob);assert.equal(items[0].kind,'image');
    // The real sibling file button has aria-label="reference.txt" but no URL.
    // Its filename alone must never be used to invent an authenticated endpoint.
    assert.equal(items.some(item=>item.name==='reference.txt'),false);
  }finally{if(prior===undefined)delete globalThis.document;else globalThis.document=prior;}
});

test('download verifies bound turn, deduplicates binary, persists hashes without signed URL, emits native blocks',async()=>{
  const image=candidate('https://files.oaiusercontent.com/a?signature=secret');
  const sameImage=candidate('https://files.oaiusercontent.com/b?signature=second');
  const document=candidate('https://chatgpt.com/backend-api/files/download/doc','instructions.txt','file');
  const plain=Buffer.from('测试附件 BRIDGE_ATTACHMENT_OK\n');
  const page=fakePage([image,sameImage,document],new Map([[image.url,payload(png,'image/png')],[sameImage.url,payload(png,'image/png')],[document.url,payload(plain,'text/plain; charset=utf-8')]]));
  const items=await collect(page,{messageId:image.messageId});
  const files=await download(page,items,{root,runId:'test-attachments-'+randomUUID()});
  assert.equal(files.length,2);assert.equal(page.requests.length,3);
  assert.equal(JSON.stringify(files).includes('signature'),false);
  assert.equal(JSON.stringify(files).includes('secret'),false);
  assert.equal(files[0].sha256,createHash('sha256').update(png).digest('hex'));
  assert.deepEqual(fs.readFileSync(files[1].path),plain);
  const blocks=nativeBlocks(files);
  assert.equal(blocks[0].type,'image');assert.equal(blocks[0].data,png.toString('base64'));assert.equal(blocks[0].mimeType,'image/png');
  assert.equal(blocks[1].type,'resource_link');assert.equal(blocks[1].uri,pathToFileURL(files[1].path).href);assert.equal(blocks[1]._meta.filePath,files[1].path);
  fs.appendFileSync(files[1].path,'changed');
  assert.throws(()=>nativeBlocks(files),/ATTACHMENT_FILE_CHANGED/);
});

test('download fails closed for injected URL, excess size, active MIME and mismatched content',async()=>{
  const image=candidate('https://files.oaiusercontent.com/test.png');
  const hidden=candidate('https://files.oaiusercontent.com/not-in-turn.png');
  const page=fakePage([image],new Map([[image.url,payload(png,'image/png')]]));
  const options={root,runId:'test-attachments-reject-'+randomUUID()};
  await assert.rejects(download(page,[hidden],options),/ATTACHMENT_NOT_IN_BOUND_TURN/);
  await assert.rejects(download(page,[candidate('file:///E:/outside.txt')],options),/ATTACHMENT_URL_DENIED/);
  await assert.rejects(download(page,[image],{...options,maxBytes:5}),/ATTACHMENT_TOO_LARGE/);
  const html=fakePage([image],new Map([[image.url,payload('<html>unsafe</html>','text/html')]]));
  await assert.rejects(download(html,[image],options),/ATTACHMENT_MIME_DENIED/);
  const mismatch=fakePage([image],new Map([[image.url,payload('not a png','image/png')]]));
  await assert.rejects(download(mismatch,[image],options),/ATTACHMENT_CONTENT_MISMATCH/);
  await assert.rejects(download(page,[image],{...options,runId:'../outside'}),/ATTACHMENT_RUN_ID_DENIED/);
  await assert.rejects(download(page,[image],{...options,root:'C:/must-not-write'}),/ATTACHMENT_ROOT_DENIED/);
  await assert.rejects(download(page,[image],{...options,root:'relative-must-not-write'}),/ATTACHMENT_ROOT_DENIED/);
  await assert.rejects(download(page,[image],{...options,root:'\\\\server\\share\\must-not-write'}),/ATTACHMENT_ROOT_DENIED/);
  await assert.rejects(collect(page),/ATTACHMENT_TURN_REQUIRED/);
});

test('browser fetch refuses redirects and stops streams above the configured byte limit',async()=>{
  const image=candidate('https://files.oaiusercontent.com/stream.png');
  const original=globalThis.fetch;
  const page={url:()=> 'https://chatgpt.com/c/test-chat',async evaluate(fn,args){
    if(fn.toString().includes('document.querySelectorAll'))return [image];
    return fn(args);
  }};
  const options={root,runId:'test-attachment-stream-'+randomUUID(),maxBytes:128};
  try{
    globalThis.fetch=async(url,init)=>{
      assert.equal(url,image.url);assert.equal(init.redirect,'error');assert.equal(init.method,'GET');assert.equal(init.credentials,'omit');
      return new Response(png,{headers:{'content-type':'image/png'}});
    };
    assert.equal((await download(page,[image],options)).length,1);
    globalThis.fetch=async()=>new Response(png,{headers:{'content-type':'image/png','content-length':'999999'}});
    await assert.rejects(download(page,[image],options),/ATTACHMENT_TOO_LARGE/);
    let cancelled=false;
    globalThis.fetch=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(129));},cancel(){cancelled=true;}}),{headers:{'content-type':'image/png'}});
    await assert.rejects(download(page,[image],options),/ATTACHMENT_TOO_LARGE/);
    assert.equal(cancelled,true);
  }finally{globalThis.fetch=original;}
});

test('same-origin and blob attachment reads retain browser authentication',async()=>{
  const original=globalThis.fetch;
  try{
    for(const url of ['https://chatgpt.com/backend-api/estuary/content?id=file-1','blob:https://chatgpt.com/authenticated-image']){
      const image=candidate(url);
      const page={url:()=> 'https://chatgpt.com/c/test-chat',async evaluate(fn,args){
        if(fn.toString().includes('document.querySelectorAll'))return [image];
        return fn(args);
      }};
      globalThis.fetch=async(requestUrl,init)=>{
        assert.equal(requestUrl,url);assert.equal(init.credentials,'include');assert.equal(init.redirect,'error');
        return new Response(png,{headers:{'content-type':'image/png'}});
      };
      assert.equal((await download(page,[image],{root,runId:'test-attachment-auth-'+randomUUID()})).length,1);
    }
  }finally{globalThis.fetch=original;}
});
