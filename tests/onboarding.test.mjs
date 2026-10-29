import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {createOnboardingServer,createDefaultActions,saveLocalConfig,validateConfigFields,openManagedPage,setupPort,connectionFingerprint} from '../src/onboarding.mjs';
import {discoverApplications} from '../src/app-discovery.mjs';
import {checkNode} from '../scripts/start.mjs';
import {openApplications} from '../scripts/open-apps.mjs';
import {BridgeStore} from '../src/store.mjs';
import {testDirectory} from './helpers.mjs';

function fixture(label){
  const root=testDirectory('onboarding-'+label);
  fs.mkdirSync(path.join(root,'ui'));
  fs.copyFileSync(new URL('../ui/setup.html',import.meta.url),path.join(root,'ui/setup.html'));
  const config={workbuddyExe:path.join(root,'WorkBuddyAI.exe'),chromeExe:path.join(root,'chrome.exe'),allowNativeRuntimeRecords:false,allowNormalProfile:false};
  const pe=Buffer.alloc(4096);pe.write('MZ');pe.writeUInt32LE(128,0x3c);pe.write('PE\0\0',128);
  for(const filename of [config.workbuddyExe,config.chromeExe])fs.writeFileSync(filename,pe); // Synthetic header; never execute.
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

function dailyProfile(f){
  const workbuddyProfile=path.join(f.root,'existing-daily-profile'),workbuddyConfigDir=path.join(workbuddyProfile,'.workbuddy-ai');
  fs.mkdirSync(workbuddyConfigDir,{recursive:true});fs.writeFileSync(path.join(workbuddyConfigDir,'workbuddy.db'),'Synthetic marker only; never open.');
  return {workbuddyProfile,workbuddyConfigDir};
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
  assert.throws(()=>saveLocalConfig({...f.config,chromeExe:path.join(f.root,'missing','chrome.exe')},{root:f.root}),/不存在/);
  assert.equal(fs.readFileSync(first.configPath,'utf8'),original);
  const second=saveLocalConfig({...f.config,allowNativeRuntimeRecords:true},{root:f.root});
  assert.equal(fs.readFileSync(second.backup,'utf8'),original);
  assert.equal(JSON.parse(fs.readFileSync(second.configPath)).allowNativeRuntimeRecords,true);
});

test('fixed actions require saved explicit consent, reject arbitrary arguments and defer mode switches until connection',async t=>{
  const f=await serve(t,'actions');
  assert.equal((await f.request('/api/open-apps',{method:'POST',data:{}})).status,400);
  assert.equal((await f.request('/api/config',{method:'POST',data:f.config})).status,200);
  assert.equal((await f.request('/api/open-apps',{method:'POST',data:{}})).status,409);
  assert.equal((await f.request('/api/config',{method:'POST',data:{...f.config,allowNativeRuntimeRecords:true}})).status,200);
  assert.equal((await f.request('/api/open-apps',{method:'POST',data:{command:'arbitrary'}})).status,400);
  assert.equal((await f.request('/api/open-dashboard',{method:'POST',data:{}})).status,409);
  for(const route of ['open-apps','connect-session'])assert.equal((await f.request('/api/'+route,{method:'POST',data:{}})).status,200);
  fs.writeFileSync(path.join(f.root,'config/active-runtime.json'),JSON.stringify({mode:'test',configurationHash:connectionFingerprint({...f.config,allowNativeRuntimeRecords:true})}));
  assert.equal((await f.request('/api/open-dashboard',{method:'POST',data:{}})).status,200);
  assert.deepEqual(f.calls,['openApps','connectSession','openDashboard']);
  fs.writeFileSync(path.join(f.root,'config/active-runtime.json'),JSON.stringify({mode:'normal'}));
  assert.equal((await f.request('/api/open-apps',{method:'POST',data:{}})).status,200);
  assert.equal((await f.request('/api/connect-session',{method:'POST',data:{}})).status,200);
  assert.equal((await f.request('/api/open-dashboard',{method:'POST',data:{}})).status,409);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'config/active-runtime.json'))).mode,'normal');
});

test('daily mode is explicit, preserves mode on save, and routes through the daily initializer',async t=>{
  const f=await serve(t,'daily');
  const daily={...f.config,...dailyProfile(f),workbuddyMode:'normal',allowNormalProfile:true,allowNativeRuntimeRecords:true};
  assert.equal((await f.request('/api/config',{method:'POST',data:{...daily,allowNormalProfile:false}})).status,400);
  assert.equal((await f.request('/api/config',{method:'POST',data:daily})).status,200);
  assert.equal(fs.existsSync(path.join(f.root,'config/active-runtime.json')),false);
  const state=await(await f.request('/api/state')).json();assert.equal(state.config.workbuddyMode,'normal');
  assert.equal((await f.request('/api/open-apps',{method:'POST',data:{}})).status,200);
  assert.equal((await f.request('/api/open-dashboard',{method:'POST',data:{}})).status,409);
  let dailyCalls=0;
  const actions=createDefaultActions(f.root,{initializeNormal:async options=>{dailyCalls++;assert.equal(options.projectDir,f.root);return {message:'synthetic daily connected'};},initializeTest:()=>assert.fail('must not initialize test mode')});
  assert.equal((await actions.connectSession({config:daily})).message,'synthetic daily connected');assert.equal(dailyCalls,1);
});

test('test activation changes runtime only after initializer succeeds',async()=>{
  const f=fixture('activate-test'),file=path.join(f.root,'config/active-runtime.json');
  fs.mkdirSync(path.dirname(file));fs.writeFileSync(file,JSON.stringify({mode:'normal'}));
  const failed=createDefaultActions(f.root,{initializeTest:async()=>{throw Error('synthetic connection failure');}});
  await assert.rejects(()=>failed.connectSession({config:{workbuddyMode:'test'}}),/connection failure/);
  assert.equal(JSON.parse(fs.readFileSync(file)).mode,'normal');
  const working=createDefaultActions(f.root,{initializeTest:async()=>({stage:'ready',messagesSent:0})});
  assert.equal((await working.connectSession({config:{workbuddyMode:'test'}})).stage,'ready');
  assert.equal(JSON.parse(fs.readFileSync(file)).mode,'test');
});

test('paused saved work permits reconnecting but still blocks configuration changes',async t=>{
  const f=await serve(t,'pending');saveLocalConfig({...f.config,allowNativeRuntimeRecords:true},{root:f.root});
  const store=new BridgeStore(path.join(f.root,'data/bridge.sqlite'));const run=store.create('synthetic paused task');store.update(run.id,'paused');store.close();
  const response=await f.request('/api/connect-session',{method:'POST',data:{}});assert.equal(response.status,200);assert.ok(f.calls.length>0);
  const configFile=path.join(f.root,'config/local.json'),before=fs.readFileSync(configFile,'utf8');
  const change=await f.request('/api/config',{method:'POST',data:{...f.config,allowNativeRuntimeRecords:true,ports:{gpt:19091}}});
  assert.equal(change.status,409);assert.equal(fs.readFileSync(configFile,'utf8'),before);
});

test('configuration changes invalidate the prior connected session, including same-mode edits',async t=>{
  const f=await serve(t,'connection-hash'),config={...f.config,allowNativeRuntimeRecords:true};
  saveLocalConfig(config,{root:f.root});
  const actions=createDefaultActions(f.root,{initializeTest:async()=>({stage:'ready'})});
  await actions.connectSession({config});
  assert.equal((await(await f.request('/api/state')).json()).connected,true);
  assert.equal((await f.request('/api/open-dashboard',{method:'POST',data:{}})).status,200);
  assert.equal((await f.request('/api/config',{method:'POST',data:{...config,ports:{workbuddy:19090}}})).status,200);
  assert.equal((await(await f.request('/api/state')).json()).connected,false);
  assert.equal((await f.request('/api/open-dashboard',{method:'POST',data:{}})).status,409);
});

test('configuration preserves the identity of a currently running WorkBuddy',()=>{
  const f=fixture('live-worker'),config={...f.config,allowNormalProfile:true,workbuddyProfile:path.join(f.root,'daily')};
  saveLocalConfig(config,{root:f.root});
  fs.mkdirSync(path.join(f.root,'data'));
  fs.writeFileSync(path.join(f.root,'data/normal-launch.json'),JSON.stringify({pid:process.pid,exe:f.config.workbuddyExe,profile:config.workbuddyProfile,config:path.join(config.workbuddyProfile,'.workbuddy-ai'),port:18693}));
  assert.throws(()=>saveLocalConfig({...config,workbuddyProfile:path.join(f.root,'other-daily')},{root:f.root}),/托盘退出/);
  assert.throws(()=>saveLocalConfig({...config,ports:{normalWorkbuddy:19093}},{root:f.root}),/托盘退出/);
  assert.throws(()=>saveLocalConfig({...config,workbuddyConfigDir:path.join(config.workbuddyProfile,'other-config')},{root:f.root}),/配置子目录/);
  assert.equal(saveLocalConfig(config,{root:f.root}).config.workbuddyProfile,config.workbuddyProfile);
});

test('timed-out launch keeps the action locked until its child has actually finished',async t=>{
  let finish;const operationCompletion=new Promise(resolve=>{finish=resolve;});
  const f=await serve(t,'timeout-lock',{actions:{openApps:async()=>{throw Object.assign(Error('synthetic timed-out launcher'),{status:504,operationCompletion});}}});
  saveLocalConfig({...f.config,allowNativeRuntimeRecords:true},{root:f.root});
  assert.equal((await f.request('/api/open-apps',{method:'POST',data:{}})).status,504);
  assert.equal((await f.request('/api/open-apps',{method:'POST',data:{}})).status,409);
  assert.equal((await f.request('/api/config',{method:'POST',data:f.config})).status,409);
  finish();await Promise.resolve();
  assert.equal((await f.request('/api/config',{method:'POST',data:f.config})).status,200);
});

test('onboarding port cannot also be selected for a managed application',async t=>{
  const f=await serve(t,'port-conflict');
  const response=await f.request('/api/config',{method:'POST',data:{...f.config,ports:{gpt:new URL(f.origin).port*1}}});
  assert.equal(response.status,400);assert.match((await response.json()).error,/向导端口/);
});

test('app opening uses selected daily mode and waits for readiness, not application exit',async()=>{
  const f=fixture('normal-open'),spawned=[],connected=[];let ticks=0,workerChecks=0;
  const local={...f.config,...dailyProfile(f),projectRoot:f.root,tempDir:path.join(f.root,'runtime/temp'),workbuddyMode:'normal',allowNormalProfile:true,allowNativeRuntimeRecords:true,ports:{normalWorkbuddy:18693,gpt:18691},configPath:path.join(f.root,'config/local.json')};
  const result=await openApplications({local,log:()=>{},attempts:4,wait:async()=>{ticks++;},isOccupied:async port=>port===18691||ticks>0,
    spawnProcess:(_exe,args,options)=>{spawned.push({args,options});const child=new EventEmitter();child.unref=()=>{};return child;},
    connectWorker:async options=>{connected.push(options.mode);if(++workerChecks===1)throw Error('renderer not ready');return {browser:{close:async()=>{}}};},connectBrowser:async()=>({browser:{close:async()=>{}}})});
  assert.equal(result.mode,'normal');assert.equal(spawned.length,1);assert.ok(spawned[0].args[0].endsWith('launch-normal-workbuddy.mjs'));
  assert.equal(spawned[0].options.windowsHide,false);assert.deepEqual(connected,['normal','normal']);
  assert.equal(fs.existsSync(path.join(f.root,'config/active-runtime.json')),false);
});

test('invalid daily document folder is rejected with the actual profile error before spawning',async()=>{
  const f=fixture('invalid-daily-documents'),profile=path.join(f.root,'documents');
  fs.mkdirSync(profile);
  const local={...f.config,projectRoot:f.root,workbuddyMode:'normal',allowNormalProfile:true,allowNativeRuntimeRecords:true,workbuddyProfile:profile,workbuddyConfigDir:path.join(profile,'.workbuddy-ai')};
  await assert.rejects(openApplications({local,spawnProcess:()=>assert.fail('Must not spawn for missing daily profile')}),/配置目录无效.*已有 workbuddy.db/);
  assert.equal(fs.existsSync(local.workbuddyConfigDir),false);
});

test('app launch failures surface immediately with instructions instead of a full readiness timeout',async()=>{
  const f=fixture('launch-exit');let child,ticks=0;
  const local={...f.config,...dailyProfile(f),projectRoot:f.root,tempDir:path.join(f.root,'runtime/temp'),workbuddyMode:'normal',allowNormalProfile:true,allowNativeRuntimeRecords:true,ports:{normalWorkbuddy:18693,gpt:18691}};
  await assert.rejects(()=>openApplications({local,log:()=>{},isOccupied:async()=>false,wait:async()=>{ticks++;child.emit('exit',2);},spawnProcess:()=>{child=new EventEmitter();child.unref=()=>{};return child;}}),/托盘彻底退出/);
  assert.equal(ticks,1);
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

test('Chrome launch verifies a browser context, retrying a port that opens before its renderer',async()=>{
  const f=fixture('browser-ready');let checks=0,connections=0,closed=0,spawned=0,ticks=0,detached=false,unreferenced=0;
  const result=await openManagedPage('http://127.0.0.1:18694/',{root:f.root,chromeExe:f.config.chromeExe,
    now:()=>ticks,wait:async ms=>{ticks+=ms;},isPortOccupied:async()=>++checks>1,
    spawnProcess:(_exe,_args,options)=>{spawned++;detached=options.detached;const child=new EventEmitter();child.pid=98765;child.unref=()=>{unreferenced++;};return child;},
    connect:async()=>{connections++;if(connections===1)throw Error('renderer not ready');return {contexts:()=>[{}],close:async()=>{closed++;}};}});
  assert.equal(result.opened,true);assert.equal(spawned,1);assert.equal(connections,2);assert.equal(closed,1);assert.equal(detached,true);assert.equal(unreferenced,1);
});

test('Chrome early exit reports an actionable failure and saves its exit state',async()=>{
  const f=fixture('browser-exit');let child;
  const result=await openManagedPage('http://127.0.0.1:18694/',{root:f.root,chromeExe:f.config.chromeExe,
    isPortOccupied:async()=>false,wait:async()=>{child.emit('exit',1,null);},
    spawnProcess:()=>{child=new EventEmitter();child.pid=98766;return child;},connect:()=>assert.fail('no endpoint was ready')});
  assert.equal(result.opened,false);assert.match(result.reason,/已退出/);assert.match(result.reason,/18694/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,'data/gpt-browser-launch.json'))).code,1);
});

test('discovery ignores invalid executable placeholders before any app can launch',async()=>{
  const f=fixture('discovery-exe'),programs=path.join(f.root,'programs'),candidate=path.join(programs,'Google/Chrome/Application/chrome.exe');
  fs.mkdirSync(path.dirname(candidate),{recursive:true});fs.writeFileSync(candidate,'invalid executable fixture');
  const missing=await discoverApplications({env:{ProgramFiles:programs},root:f.root,registry:false});assert.deepEqual(missing.chrome,[]);
  fs.copyFileSync(f.config.chromeExe,candidate);
  const valid=await discoverApplications({env:{ProgramFiles:programs},root:f.root,registry:false});assert.equal(valid.chrome[0].path,candidate);
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
