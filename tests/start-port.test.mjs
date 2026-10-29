import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {bindSetup} from '../scripts/start.mjs';
import {testDirectory} from './helpers.mjs';

async function occupied(t){
  const server=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({service:'unrelated'}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return server.address().port;
}
function cleanup(t,app){if(app.server)t.after(()=>new Promise(resolve=>{app.server.closeAllConnections();app.server.close(resolve);}));}

test('occupied default port selects a different port and persists this installation identity',async t=>{
  const port=await occupied(t),root=testDirectory('startup-port-conflict');
  const app=await bindSetup({root,port,allowFallback:true});cleanup(t,app);
  assert.notEqual(new URL(app.origin).port,String(port));
  const record=JSON.parse(fs.readFileSync(path.join(root,'data/setup-launch.json'),'utf8'));
  const identity=await(await fetch(app.origin+'/api/identity')).json();
  assert.equal(record.origin,app.origin);assert.equal(record.instanceId,identity.instanceId);
});

test('repeat start reuses the saved fallback without creating another service',async t=>{
  const port=await occupied(t),root=testDirectory('startup-port-reuse');
  const first=await bindSetup({root,port,allowFallback:true});cleanup(t,first);
  const before=fs.readFileSync(path.join(root,'data/setup-launch.json'),'utf8');
  const second=await bindSetup({root,port,allowFallback:true});
  assert.equal(second.reused,true);assert.equal(second.origin,first.origin);assert.equal(second.server,undefined);
  assert.equal(fs.readFileSync(path.join(root,'data/setup-launch.json'),'utf8'),before);
});

test('explicit port conflicts fail clearly and do not replace the listener or create a binding',async t=>{
  const port=await occupied(t),root=testDirectory('startup-explicit-port');
  await assert.rejects(bindSetup({root,port,allowFallback:false}),/指定的向导端口/);
  assert.equal(fs.existsSync(path.join(root,'data/setup-launch.json')),false);
  assert.equal((await(await fetch('http://127.0.0.1:'+port)).json()).service,'unrelated');
});

test('a stale record cannot adopt another installation even when its process is alive',async t=>{
  const port=await occupied(t),root=testDirectory('startup-stale-record');
  fs.mkdirSync(path.join(root,'data'));
  fs.writeFileSync(path.join(root,'data/setup-launch.json'),JSON.stringify({pid:process.pid,origin:'http://127.0.0.1:'+port,instanceId:'wrong-instance'}));
  const app=await bindSetup({root,port,allowFallback:true});cleanup(t,app);
  assert.equal(app.reused,false);assert.notEqual(app.origin,'http://127.0.0.1:'+port);
});
