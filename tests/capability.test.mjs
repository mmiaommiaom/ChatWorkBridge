import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {testDirectory} from './helpers.mjs';
import {performCapability} from '../src/capability-tools.mjs';

async function withPolicy(workspace,fn,extra={}){
  const policy=path.join(testDirectory('capability-policy'),'policy.json');
  fs.writeFileSync(policy,JSON.stringify({workspace,...extra}));
  const old=process.env.WB_BRIDGE_CAPABILITY_CONFIG;
  process.env.WB_BRIDGE_CAPABILITY_CONFIG=policy;
  try{return await fn();}finally{if(old===undefined)delete process.env.WB_BRIDGE_CAPABILITY_CONFIG;else process.env.WB_BRIDGE_CAPABILITY_CONFIG=old;}
}

test('capability tools reject C, unrelated workspaces, and redirected workspaces before execution',async()=>{
  const owner=testDirectory('capability-paths'),target=path.join(owner,'physical');fs.mkdirSync(target);
  const link=path.join(owner,'redirected');fs.symlinkSync(target,link,'junction');
  for(const workspace of ['C:/Windows',path.resolve(owner,'../../..'),link]){
    await withPolicy(workspace,async()=>{
      await assert.rejects(performCapability('write_file',{path:'note.txt',content:'denied'}));
      await assert.rejects(performCapability('run_command',{command:'node_version'}));
    });
  }
  assert.equal(fs.existsSync(path.join(target,'note.txt')),false);
});

test('capability hard links and directories cannot be overwritten as approved filenames',async()=>{
  const workspace=testDirectory('capability-hardlink'),original=path.join(workspace,'original.txt');
  fs.writeFileSync(original,'keep this');fs.linkSync(original,path.join(workspace,'note.txt'));
  fs.mkdirSync(path.join(workspace,'input.json'));
  await withPolicy(workspace,async()=>{
    for(const filename of ['note.txt','input.json'])await assert.rejects(performCapability('write_file',{path:filename,content:'replace'}),/FILE_LINK_DENIED/);
    await assert.rejects(performCapability('read_file',{path:'note.txt'}),/FILE_LINK_DENIED/);
  });
  assert.equal(fs.readFileSync(original,'utf8'),'keep this');
});

test('capability writes and reads are bounded by UTF-8 byte length',async()=>{
  const workspace=testDirectory('capability-content');
  await withPolicy(workspace,async()=>{
    const result=await performCapability('write_file',{path:'note.txt',content:'测试成功'});
    assert.equal(result.bytes,12);assert.equal((await performCapability('read_file',{path:'note.txt'})).text,'测试成功');
    await assert.rejects(performCapability('write_file',{path:'note.txt',content:'测'.repeat(2000)}),/CONTENT_LIMIT/);
    fs.writeFileSync(path.join(workspace,'input.json'),'x'.repeat(4097));
    await assert.rejects(performCapability('read_file',{path:'input.json'}),/CONTENT_LIMIT/);
  });
});

test('capability writes reject dangling links before creating their target',async()=>{
  const workspace=testDirectory('capability-dangling'),outside=testDirectory('capability-dangling-target');
  const target=path.join(outside,'new-file.txt');
  fs.symlinkSync(target,path.join(workspace,'note.txt'),'file');
  assert.equal(fs.existsSync(path.join(workspace,'note.txt')),false);
  await withPolicy(workspace,()=>assert.rejects(performCapability('write_file',{path:'note.txt',content:'must not escape'}),/PATH_LINK_DENIED|目录联接或软链接/));
  assert.equal(fs.existsSync(target),false);
});

test('node_version ignores injected Node startup options and browser action rejects remote pages',async()=>{
  const workspace=testDirectory('capability-command'),old=process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS='--not-a-real-node-option';
  try{await withPolicy(workspace,async()=>{
    const result=await performCapability('run_command',{command:'node_version'});
    assert.match(result.stdout,/^v\d+\.\d+\.\d+\s*$/);assert.equal(result.exitCode,0);
    await assert.rejects(performCapability('browser_action',{action:'click'}),/UI_TARGET_DENIED/);
  },{browserTargetId:'fake-target',browserUrl:'https://example.com/real-form'});}finally{if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;}
});
