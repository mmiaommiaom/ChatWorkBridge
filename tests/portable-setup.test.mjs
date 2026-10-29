import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {loadConfig} from '../src/local-config.mjs';
import {saveLocalConfig,createOnboardingServer} from '../src/onboarding.mjs';
import {discoverApplications,dailyProfileFromSelection} from '../src/app-discovery.mjs';
import {pickConfigurationPath,validatePickedPath} from '../src/path-picker.mjs';
import {initializeSession} from '../src/initialize-session.mjs';
import {testDirectory} from './helpers.mjs';

function apps(root){
  const config={chromeExe:path.join(root,'apps/Chrome/chrome.exe'),workbuddyExe:path.join(root,'apps/WorkBuddy/WorkBuddyAI.exe'),workbuddyMode:'test',allowNormalProfile:false,allowNativeRuntimeRecords:false};
  const pe=Buffer.alloc(256);pe.write('MZ');pe.writeUInt32LE(128,60);pe.write('PE\0\0',128);
  for(const file of [config.chromeExe,config.workbuddyExe]){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,pe);}
  return config;
}
function profile(directory){fs.mkdirSync(path.join(directory,'.workbuddy-ai'),{recursive:true});fs.writeFileSync(path.join(directory,'.workbuddy-ai/workbuddy.db'),'Synthetic marker; never opened.');return directory;}

test('fresh install detects portable programs and a real profile by metadata without a prebuilt config',async()=>{
  const root=testDirectory('portable-first-run');const config=apps(root);
  const daily=profile(path.join(root,'apps/WorkBuddy/Profile'));
  const found=await discoverApplications({root,env:{},registry:false});
  assert.ok(found.chrome.some(p=>p.path===config.chromeExe));assert.ok(found.workbuddy.some(p=>p.path===config.workbuddyExe));
  assert.equal(found.profiles.length,1);assert.equal(found.profiles[0].workbuddyProfile,daily);
  assert.equal(fs.existsSync(path.join(root,'config/local.json')),false);
});

test('a selected custom installation discovers its adjacent profile without machine specific paths',async()=>{
  const root=testDirectory('portable-custom-location'),config=apps(path.join(root,'custom layout/App'));
  const daily=profile(path.join(path.dirname(config.workbuddyExe),'..','Profile'));
  const found=await discoverApplications({root,workbuddyExe:config.workbuddyExe,env:{},registry:false});
  assert.ok(found.profiles.some(item=>item.workbuddyProfile===daily));
  assert.equal(dailyProfileFromSelection(path.join(daily,'.workbuddy-ai')).workbuddyProfile,daily);
  assert.throws(()=>dailyProfileFromSelection(path.join(root,'missing-documents')),/没有找到/);
});

test('saved internal paths remain relative and resolve after copying to a new Unicode and space directory',()=>{
  const before=testDirectory('portable-original'),config=apps(before);
  const saved=saveLocalConfig(config,{root:before});
  const raw=fs.readFileSync(saved.configPath,'utf8');assert.ok(raw.includes('./apps/'));assert.ok(!raw.includes(before));
  const after=path.join(testDirectory('portable-destination'),'中文 location');
  for(const relative of ['apps/Chrome/chrome.exe','apps/WorkBuddy/WorkBuddyAI.exe','config/local.json']){
    const destination=path.join(after,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(before,relative),destination,fs.constants.COPYFILE_EXCL);
  }
  const loaded=loadConfig({projectDir:after,configPath:path.join(after,'config/local.json'),checkExecutables:true});
  assert.equal(loaded.chromeExe,path.join(after,'apps/Chrome/chrome.exe'));
  assert.equal(loaded.workspace,path.join(after,'workspaces/probe'));
  assert.equal(loaded.workbuddyProfile,null);assert.equal(loaded.allowNormalProfile,false);
});

test('native picker uses fixed Windows Shell script and treats selected paths as data',async()=>{
  const root=testDirectory('portable-picker'),config=apps(root);let launches=0;
  const picked=await pickConfigurationPath('chromeExe',{root,platform:'win32',spawnProcess:(exe,args,options)=>{
    launches++;assert.ok(exe.endsWith('cscript.exe'));assert.ok(args.some(value=>value.endsWith('select-path.vbs')));assert.ok(args.includes('//U'));assert.equal(options.windowsHide,false);assert.ok(options.env.TEMP.startsWith(root));
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    queueMicrotask(()=>{child.stdout.emit('data',Buffer.from(config.chromeExe+'\r\n','utf16le'));child.emit('exit',0);});return child;
  }});
  assert.equal(picked.chromeExe,config.chromeExe);assert.equal(launches,1);
  assert.deepEqual(validatePickedPath('chromeExe',{cancelled:true}),{cancelled:true});
  assert.throws(()=>validatePickedPath('shellCommand',{path:'anything'}),/不允许/);
  assert.throws(()=>validatePickedPath('workbuddyProfile',{path:'C:/not-selected'}),/C 盘/);
});

test('picker and detection API validate fields and never save a selection or permissions implicitly',async t=>{
  const root=testDirectory('portable-picker-api');apps(root);let picks=0;
  const app=createOnboardingServer({root,pickPath:async field=>{picks++;assert.equal(field,'chromeExe');return {cancelled:true};},discovery:async()=>({chrome:[],workbuddy:[],profiles:[]})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{app.server.closeAllConnections();app.server.close(resolve);}));
  const post=(endpoint,data,token=app.token)=>fetch(app.origin+endpoint,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json','X-Bridge-Token':token},body:JSON.stringify(data)});
  assert.equal((await post('/api/pick-path',{field:'chromeExe'},'')).status,403);
  assert.equal((await post('/api/pick-path',{field:'command'})).status,400);
  assert.equal((await post('/api/pick-path',{field:'chromeExe',command:'no'})).status,400);
  assert.equal((await post('/api/pick-path',{field:'chromeExe'})).status,200);
  assert.equal((await post('/api/detect',{command:'no'})).status,400);
  assert.equal(picks,1);assert.equal(fs.existsSync(path.join(root,'config/local.json')),false);
});

test('moving an idle ready binding archives its old workspace and creates only one new dedicated session',async()=>{
  const before=testDirectory('portable-session-before'),after=testDirectory('portable-session-after');
  const file=path.join(after,'data/desktop-binding.json');fs.mkdirSync(path.dirname(file));
  const old={sessionId:'previous-id',mode:'test',stage:'ready',model:'deepseek-v4.1-flash',installationRoot:before,workspace:path.join(before,'workspaces/probe')};
  fs.writeFileSync(file,JSON.stringify(old));let session,creates=0;
  const result=await initializeSession({projectDir:after,connect:async()=>({page:{},browser:{close:async()=>{}}}),rpc:async(_page,channel,args)=>{
    if(channel==='daemon:getActiveSessions')return[];
    if(channel==='workspace:initialize')return{success:true};
    if(channel==='session:create'){creates++;session={sessionId:args[0].sessionId,cwd:args[0].cwd,model:args[0].config.model,status:'idle'};return session;}
    if(channel==='session:get')return session;
    if(['session:rename','session:updateConfig','session:load'].includes(channel))return{};
    assert.fail('No task or model may run: '+channel);
  }});
  assert.equal(creates,1);assert.notEqual(result.sessionId,old.sessionId);assert.equal(result.messagesSent,0);
  const backups=fs.readdirSync(path.dirname(file)).filter(name=>name.includes('before-relocation'));
  assert.equal(backups.length,1);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(file),backups[0]))),old);
  assert.equal(fs.existsSync(path.join(before,'data')),false);
});
