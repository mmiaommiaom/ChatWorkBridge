import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createOnboardingServer,saveLocalConfig,validateConfigFields,openManagedPage,setupPort} from '../src/onboarding.mjs';
import {discoverApplications} from '../src/app-discovery.mjs';
import {checkNode} from '../scripts/start.mjs';
import {testDirectory} from './helpers.mjs';

function fixture(label){
  const root=testDirectory('onboarding-'+label);
  fs.mkdirSync(path.join(root,'ui'));
  fs.copyFileSync(new URL('../ui/setup.html',import.meta.url),path.join(root,'ui/setup.html'));
  const config={workbuddyExe:path.join(root,'WorkBuddyAI.exe'),chromeExe:path.join(root,'chrome.exe'),allowNativeRuntimeRecords:false,allowNormalProfile:false};
  for(const filename of [config.workbuddyExe,config.chromeExe])fs.writeFileSync(filename,'synthetic fixture; never execute');
  return {root,config};
}

async function serve(t,label,options={}){
  const f=fixture(label),calls=[];
  const actions=Object.fromEntries(['openApps','connectSession','openDashboard'].map(name=>[name,async()=>{calls.push(name);return {message:'synthetic '+name};}]));
  const app=createOnboardingServer({root:f.root,actions,discovery:async()=>({chrome:[],workbuddy:[],registryChecked:false}),...options});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>{app.server.closeAllConnections();app.server.close(resolve);}));
  const request=(route,{method='GET',data,headers={}}={})=>fetch(app.origin+route,{method,headers:{'X-Bridge-Token':app.token,...(method==='POST'?{'Content-Type':'application/json',Origin:app.origin}:{}),...headers},...(data!==undefined?{body:typeof data==='string'?data:JSON.stringify(data)}:{})});
  return {...f,...app,request,calls};
}

test('setup loads without a local config and does not start apps or create a config',async t=>{
  const f=await serve(t,'missing');
  const page=await fetch(f.origin);assert.equal(page.status,200);
  const html=await page.text();assert.match(html,/打开两边应用/);assert.match(html,/登录后连接会话/);assert.match(html,/打开协作台/);assert.ok(html.includes(f.token));
  const state=await(await f.request('/api/state')).json();assert.equal(state.configured,false);assert.equal(state.mode,'test');
  assert.equal(state.config.allowNormalProfile,false);assert.equal(state.config.allowNativeRuntimeRecords,false);assert.equal(fs.existsSync(path.join(f.root,'config/local.json')),false);assert.deepEqual(f.calls,[]);
});

test('HTTP rejects foreign Host/Origin, missing tokens, non-JSON and oversized bodies',async t=>{
  const f=await serve(t,'security',{bodyLimit:256});
  const foreignHost=await new Promise((resolve,reject)=>{
    const req=http.get(f.origin+'/api/state',{headers:{Host:'attacker.example','X-Bridge-Token':f.token}},res=>{res.resume();resolve(res.statusCode);});req.once('error',reject);
  });
  assert.equal(foreignHost,403);
  assert.equal((await f.request('/api/state',{headers:{Origin:'https://attacker.example'}})).status,403);
  assert.equal((await f.request('/api/state',{headers:{'X-Bridge-Token':''}})).status,403);
  assert.equal((await f.request('/api/state',{headers:{'Sec-Fetch-Site':'cross-site'}})).status,403);
  assert.equal((await f.request('/api/config',{method:'POST',data:{},headers:{Origin:''}})).status,403);
  assert.equal((await f.request('/api/config',{method:'POST',data:'{}',headers:{'Content-Type':'text/plain'}})).status,415);
  assert.equal((await f.request('/api/config',{method:'POST',data:'x'.repeat(300)})).status,413);
  assert.equal((await f.request('/api/config',{method:'POST',data:'{'})).status,400);
  assert.deepEqual(f.calls,[]);
});

test('only whitelisted fields and explicit permission booleans reach configuration validation',()=>{
  const {config}=fixture('fields');
  assert.throws(()=>validateConfigFields({...config,command:'whoami'}),/不允许/);
  assert.throws(()=>validateConfigFields(JSON.parse(JSON.stringify(config).replace(/}$/,',"__proto__":{}}'))),/不允许/);
  assert.throws(()=>validateConfigFields({...config,ports:{constructor:18690}}),/无效端口/);
  const missing={...config};delete missing.allowNativeRuntimeRecords;assert.throws(()=>validateConfigFields(missing),/复选框/);
});

test('candidate validation preserves current configuration and successful replacement retains an exact backup',()=>{
  const f=fixture('atomic');
  const first=saveLocalConfig(f.config,{root:f.root});
  const original=fs.readFileSync(first.configPath,'utf8');
  assert.equal(first.backup,null);
  assert.throws(()=>saveLocalConfig({...f.config,allowNormalProfile:'true'},{root:f.root}),/复选框/);
  assert.throws(()=>saveLocalConfig({...f.config,allowNormalProfile:true,workbuddyProfile:'C:/not-written'},{root:f.root}),/C 盘/);
  assert.throws(()=>saveLocalConfig({...f.config,chromeExe:path.join(f.root,'missing.exe')},{root:f.root}),/不存在/);
  assert.equal(fs.readFileSync(first.configPath,'utf8'),original);
  const second=saveLocalConfig({...f.config,allowNativeRuntimeRecords:true},{root:f.root});
  assert.equal(fs.readFileSync(second.backup,'utf8'),original);
  assert.equal(JSON.parse(fs.readFileSync(second.configPath)).allowNativeRuntimeRecords,true);
});

test('fixed actions require saved explicit consent and never accept arbitrary arguments or activate normal mode',async t=>{
  const f=await serve(t,'actions');
  assert.equal((await f.request('/api/open-apps',{method:'POST',data:{}})).status,400);
  assert.equal((await f.request('/api/config',{method:'POST',data:f.config})).status,200);
  assert.equal((await f.request('/api/open-apps',{method:'POST',data:{}})).status,409);
  assert.equal((await f.request('/api/config',{method:'POST',data:{...f.config,allowNativeRuntimeRecords:true}})).status,200);
  assert.equal((await f.request('/api/open-apps',{method:'POST',data:{command:'arbitrary'}})).status,400);
  for(const route of ['open-apps','connect-session','open-dashboard'])assert.equal((await f.request('/api/'+route,{method:'POST',data:{}})).status,200);
  assert.deepEqual(f.calls,['openApps','connectSession','openDashboard']);
  fs.writeFileSync(path.join(f.root,'config/active-runtime.json'),JSON.stringify({mode:'normal'}));
  assert.equal((await f.request('/api/open-apps',{method:'POST',data:{}})).status,409);
  assert.equal((await f.request('/api/connect-session',{method:'POST',data:{}})).status,409);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'config/active-runtime.json'))).mode,'normal');
});

test('concurrent action clicks are refused while the original operation is pending',async t=>{
  let release,started;const begin=new Promise(resolve=>{started=resolve;});
  const f=await serve(t,'busy',{actions:{openApps:()=>new Promise(resolve=>{release=resolve;started();})}});
  saveLocalConfig({...f.config,allowNativeRuntimeRecords:true},{root:f.root});
  const first=f.request('/api/open-apps',{method:'POST',data:{}});await begin;
  assert.equal((await f.request('/api/open-apps',{method:'POST',data:{}})).status,409);
  release({message:'synthetic complete'});assert.equal((await first).status,200);
});

test('discovery only queries known App Paths keys and never scans account stores',async()=>{
  const queried=[];
  const result=await discoverApplications({root:'D:\\Bridge',env:{ProgramFiles:'C:\\Program Files'},platform:'win32',isFile:filename=>/chrome\.exe$/i.test(filename),registryQuery:async key=>{queried.push(key);return '    (Default)    REG_SZ    "D:\\Browsers\\chrome.exe"';}});
  assert.equal(queried.length,6);assert.ok(queried.every(key=>/^HK(?:CU|LM)\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\(?:chrome|WorkBuddyAI|WorkBuddy)\.exe$/.test(key)));
  assert.ok(result.chrome.some(item=>item.path==='D:\\Browsers\\chrome.exe'));assert.deepEqual(result.workbuddy,[]);
});

test('owned Chrome reuse keeps an existing ChatGPT conversation and never launches another process',async()=>{
  const f=fixture('reuse'),profile=path.join(f.root,'runtime/gpt-browser');
  fs.mkdirSync(path.join(f.root,'data'));
  fs.writeFileSync(path.join(f.root,'data/gpt-browser-launch.json'),JSON.stringify({pid:12345,port:18691,profile,exe:f.config.chromeExe}));
  let navigations=0,fronts=0,closed=0,newPages=0;
  const page={url:()=> 'https://chatgpt.com/c/test-conversation',goto:async()=>{navigations++;},bringToFront:async()=>{fronts++;}};
  const connect=async()=>({contexts:()=>[{pages:()=>[page],newPage:async()=>{newPages++;return page;}}],close:async()=>{closed++;}});
  const result=await openManagedPage('https://chatgpt.com/',{root:f.root,chromeExe:f.config.chromeExe,connect,isAlive:()=>true,spawnProcess:()=>{throw Error('No process may launch in this test');}});
  assert.equal(result.reused,true);assert.equal(navigations,0);assert.equal(newPages,0);assert.equal(fronts,1);assert.equal(closed,1);
});

test('unknown browser ports and changed browser identity cannot be adopted',async()=>{
  const f=fixture('identity');
  await assert.rejects(()=>openManagedPage('http://127.0.0.1:18694/',{root:f.root,chromeExe:f.config.chromeExe,isPortOccupied:async()=>true,spawnProcess:()=>assert.fail('must not spawn')}),/有效启动记录/);
  fs.mkdirSync(path.join(f.root,'data'));
  fs.writeFileSync(path.join(f.root,'data/gpt-browser-launch.json'),JSON.stringify({pid:12345,port:18691,profile:path.join(f.root,'other-profile'),exe:f.config.chromeExe}));
  await assert.rejects(()=>openManagedPage('http://127.0.0.1:18694/',{root:f.root,chromeExe:f.config.chromeExe,isAlive:()=>true,spawnProcess:()=>assert.fail('must not spawn')}),/不匹配/);
});

test('setup ports and Node versions are validated without changing system configuration',()=>{
  assert.equal(setupPort('18694'),18694);for(const value of ['80','abc',65536,18694.1])assert.throws(()=>setupPort(value));
  for(const version of ['22.13.0','22.22.2','24.0.0'])checkNode(version);
  for(const version of ['20.19.0','22.12.0','garbage'])assert.throws(()=>checkNode(version),/22.13/);
});
