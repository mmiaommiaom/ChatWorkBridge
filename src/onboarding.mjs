import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {randomBytes,randomUUID,timingSafeEqual,createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {loadConfig,projectRoot,assertControlledPath,validateExecutable,validateDailyProfile,dataDriveForPath} from './local-config.mjs';
import {discoverApplications} from './app-discovery.mjs';
import {pickConfigurationPath,pickerFields} from './path-picker.mjs';

export const defaultSetupPort=18694;
const defaultPorts={workbuddy:18690,gpt:18691,dashboard:18692,normalWorkbuddy:18693};
const fields=new Set(['workbuddyExe','chromeExe','workbuddyProfile','workbuddyConfigDir','workbuddyMode','allowNormalProfile','allowNativeRuntimeRecords','ports','dataDrive']);
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const alive=pid=>{try{if(!Number.isInteger(pid)||pid<1)return false;process.kill(pid,0);return true;}catch{return false;}};
const readJson=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{return null;}};
const error=(message,status=400)=>Object.assign(new Error(message),{status});

export function setupPort(value=process.env.WB_BRIDGE_SETUP_PORT??defaultSetupPort){
  if(!/^\d+$/.test(String(value)))throw error('WB_BRIDGE_SETUP_PORT 必须是 1024～65535 的整数。');
  const port=Number(value);
  if(!Number.isInteger(port)||port<1024||port>65535)throw error('WB_BRIDGE_SETUP_PORT 必须是 1024～65535 的整数。');
  return port;
}

export function configForForm(config){
  return {
    workbuddyExe:config?.workbuddyExe??'',chromeExe:config?.chromeExe??'',
    workbuddyProfile:config?.workbuddyProfile??'',workbuddyConfigDir:config?.workbuddyConfigDir??'',
    workbuddyMode:config?.workbuddyMode??'test',
    allowNormalProfile:config?.allowNormalProfile===true,allowNativeRuntimeRecords:config?.allowNativeRuntimeRecords===true,
    ports:{...defaultPorts,...config?.ports},
  };
}

export const connectionFingerprint=config=>createHash('sha256').update(JSON.stringify(configForForm(config))).digest('hex');

/** Reject unrecognised fields before touching a file. Both permission choices must be explicit booleans. */
export function validateConfigFields(input){
  if(!isObject(input))throw error('配置必须是 JSON 对象。');
  for(const key of Object.keys(input))if(!fields.has(key))throw error('不允许的配置字段：'+key);
  for(const key of ['allowNormalProfile','allowNativeRuntimeRecords'])if(typeof input[key]!=='boolean')throw error(key+' 必须由复选框明确选择 true 或 false。');
  if(input.workbuddyMode!==undefined&&!['test','normal'].includes(input.workbuddyMode))throw error('请选择独立测试或日常 WorkBuddy 模式。');
  if(input.workbuddyMode==='normal'&&input.allowNormalProfile!==true)throw error('使用日常 WorkBuddy 前，请明确勾选沿用日常资料目录。');
  for(const key of ['workbuddyExe','chromeExe'])if(typeof input[key]!=='string'||input[key].length>4096||!input[key].toLowerCase().endsWith('.exe'))throw error(key+' 必须填写实际 .exe 程序的完整路径。');
  for(const key of ['workbuddyProfile','workbuddyConfigDir'])if(input[key]!==undefined&&input[key]!==null&&(typeof input[key]!=='string'||input[key].length>4096))throw error(key+' 必须是目录路径或留空。');
  if(input.ports!==undefined){
    if(!isObject(input.ports))throw error('ports 必须是端口对象。');
    for(const [key,value] of Object.entries(input.ports))if(!Object.hasOwn(defaultPorts,key)||!Number.isInteger(value)||value<1024||value>65535)throw error('无效端口：'+key);
  }
  const result={...input};
  for(const key of ['workbuddyProfile','workbuddyConfigDir'])if(result[key]==='')result[key]=null;
  return result;
}

export function saveLocalConfig(input,{root=projectRoot,configLoader=loadConfig}={}){
  const candidate=validateConfigFields(input);
  if(candidate.dataDrive!==undefined&&String(candidate.dataDrive).toUpperCase()!==dataDriveForPath(root))throw error('dataDrive 必须与程序所在盘符一致。');
  for(const field of ['chromeExe','workbuddyExe','workbuddyProfile','workbuddyConfigDir'])if(candidate[field]){
    if(!/^[A-Za-z]:[\\/]/.test(candidate[field])&&!/^\.[\\/]/.test(candidate[field]))throw error(field+' 必须是完整路径或程序目录内的 ./ 相对路径。');
    if(/^\.[\\/]/.test(candidate[field])){
      const relative=path.relative(root,path.resolve(root,candidate[field]));
      if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw error(field+' 的相对路径不能离开程序目录。');
    }
    candidate[field]=path.resolve(root,candidate[field]);
  }
  assertNoPendingTask(root);
  const directory=assertControlledPath(path.join(root,'config'));
  const configPath=assertControlledPath(path.join(directory,'local.json'));
  const browserRecord=readJson(path.join(root,'data/gpt-browser-launch.json'));
  if(browserRecord&&!browserRecord.exitedAt&&alive(browserRecord.pid)){
    if(browserRecord.port!==(candidate.ports?.gpt??defaultPorts.gpt)||!samePath(browserRecord.exe,candidate.chromeExe))throw error('受管浏览器仍在运行。请保留当前 Chrome 路径和端口；如需更改，先正常关闭受管浏览器。',409);
  }
  for(const [file,mode] of [['native-launch.json','test'],['normal-launch.json','normal']]){
    const record=readJson(path.join(root,'data',file));
    if(!record||record.exitedAt||!alive(record.pid))continue;
    const port=candidate.ports?.[mode==='normal'?'normalWorkbuddy':'workbuddy']??defaultPorts[mode==='normal'?'normalWorkbuddy':'workbuddy'];
    const profile=mode==='normal'?candidate.workbuddyProfile:path.join(root,'runtime/workbuddy-profile');
    const configDir=candidate.workbuddyConfigDir??(profile?path.join(profile,'.workbuddy-ai'):null);
    if(record.port!==port||!samePath(record.exe,candidate.workbuddyExe)||!samePath(record.profile,profile)||(mode==='normal'&&!samePath(record.config,configDir)))throw error('WorkBuddy 仍在运行。更改程序、资料目录、配置子目录或端口前，请先保存工作并从托盘退出该 WorkBuddy。',409);
  }
  fs.mkdirSync(directory,{recursive:true});
  const pending=assertControlledPath(path.join(directory,'local.pending-'+randomUUID()+'.json'));
  const stored={...candidate};
  // Data follows this installation. Application files bundled beside it keep relative paths.
  delete stored.dataDrive;
  for(const field of ['chromeExe','workbuddyExe','workbuddyProfile','workbuddyConfigDir']){
    if(!stored[field])continue;
    const relative=path.relative(root,stored[field]);
    if(relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep))stored[field]='./'+relative.split(path.sep).join('/');
  }
  fs.writeFileSync(pending,JSON.stringify(stored,null,2)+'\n',{flag:'wx'});
  // A rejected candidate remains as a local diagnostic file; the active configuration is untouched.
  const validated=configLoader({configPath:pending,projectDir:root,checkExecutables:true});
  if(validated.workbuddyMode==='normal')validateDailyProfile(validated);
  let backup=null;
  if(fs.existsSync(configPath)){
    backup=assertControlledPath(path.join(directory,'local.backup-'+Date.now()+'-'+randomUUID()+'.json'));
    fs.copyFileSync(configPath,backup,fs.constants.COPYFILE_EXCL);
  }
  fs.renameSync(pending,configPath);
  return {config:configForForm(validated),configPath,backup};
}

function controlledEnvironment(root){
  const temp=assertControlledPath(path.join(root,'runtime/temp'));
  fs.mkdirSync(temp,{recursive:true});
  return {...process.env,TEMP:temp,TMP:temp,WB_BRIDGE_CONFIG:path.join(root,'config/local.json')};
}

function runFixedScript(root,name,{timeoutMs=150000}={}){
  return new Promise((resolve,reject)=>{
    let output='',settled=false;
    let completed;const operationCompletion=new Promise(resolve=>{completed=resolve;});
    const child=spawn(process.execPath,[path.join(root,'scripts',name)],{cwd:root,windowsHide:false,env:controlledEnvironment(root),stdio:['ignore','pipe','pipe']});
    const append=chunk=>{output=(output+chunk.toString()).slice(-16000);};
    child.stdout.on('data',append);child.stderr.on('data',append);
    const timer=setTimeout(()=>{
      // The child may still be opening its owned apps. Do not terminate it or retry implicitly.
      if(!settled){settled=true;reject(Object.assign(error('操作仍未确认完成，请查看日志；不要重复启动。\n'+output,504),{operationCompletion}));}
    },timeoutMs);
    child.once('error',failure=>{clearTimeout(timer);completed();if(!settled){settled=true;reject(failure);}});
    child.once('exit',code=>{clearTimeout(timer);completed();if(!settled){settled=true;code===0?resolve({message:output.trim()}):reject(error(output.trim()||name+' 退出：'+code));}});
  });
}

export function createDefaultActions(root=projectRoot,{runScript=runFixedScript,openPage=openManagedPage,initializeTest,initializeNormal}={}){
  return {
    openApps:async({config})=>{
      const result=await runScript(root,'open-apps.mjs');
      const browser=await openPage('https://chatgpt.com/',{root,config});
      if(browser.opened===false)throw error(browser.reason||'浏览器未确认打开，请检查日志。',503);
      return result;
    },
    connectSession:async({config})=>{
      let result;
      if(config.workbuddyMode==='normal'){
        const activate=initializeNormal??(await import('../scripts/activate-normal-workbuddy.mjs')).activateNormal;
        result=await activate({projectDir:root,configLoader:()=>config});
      }else{
        const initialize=initializeTest??(await import('./initialize-session.mjs')).initializeSession;
        result=await initialize({projectDir:root});
      }
      const file=assertControlledPath(path.join(root,'config/active-runtime.json'));
      fs.mkdirSync(path.dirname(file),{recursive:true});
      const pending=file+'.'+randomUUID()+'.tmp';
      fs.writeFileSync(pending,JSON.stringify({mode:config.workbuddyMode??'test',configurationHash:connectionFingerprint(config),activatedAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
      fs.renameSync(pending,file);
      return {message:config.workbuddyMode==='normal'?'日常 WorkBuddy 会话已连接。':'独立测试会话已连接。此模式只做文字推理和读取明确附带的附件。',...result};
    },
    openDashboard:async({config})=>{
      const origin='http://127.0.0.1:'+config.ports.dashboard;
      const record=readJson(path.join(root,'data/dashboard-launch.json'));
      if(await portOccupied(config.ports.dashboard)){
        if(!record||record.origin!==origin||!alive(record.pid))throw error('协作台端口已被占用，且无法确认属于本项目。请检查已有服务。',409);
        const opened=await openPage(origin,{root,config});
        if(opened.opened===false)return {message:'协作台已运行，请手动打开：'+origin,url:origin};
        return {message:'协作台已打开。输入目标后再开始任务。',url:origin};
      }
      const logs=assertControlledPath(path.join(root,'logs'));fs.mkdirSync(logs,{recursive:true});
      const fd=fs.openSync(path.join(logs,'dashboard.log'),'a');
      const child=spawn(process.execPath,[path.join(root,'scripts/dashboard.mjs')],{cwd:root,windowsHide:true,detached:true,env:controlledEnvironment(root),stdio:['ignore',fd,fd]});
      fs.closeSync(fd);let failure;child.on('error',e=>{failure=e;});child.unref();
      for(let i=0;i<60;i++){
        if(failure)throw failure;
        const started=readJson(path.join(root,'data/dashboard-launch.json'));
        if(started?.pid===child.pid&&started.origin===origin&&await portOccupied(config.ports.dashboard)){
          return {message:'协作台已打开。输入目标后再开始任务。',url:origin};
        }
        await delay(250);
      }
      throw error('协作台启动未确认，请查看 logs/dashboard.log。',504);
    },
  };
}

/** Read existing state only. Never switch the worker while a saved task can still resume. */
export function assertNoPendingTask(root,{allowSaved=false}={}){
  const filename=assertControlledPath(path.join(root,'data/bridge.sqlite'));
  if(!fs.existsSync(filename))return;
  const db=new DatabaseSync(filename,{readOnly:true});
  try{
    const table=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runs'").get();
    if(!table)throw error('任务数据库尚未就绪，请先检查协作台。',409);
    const run=db.prepare(allowSaved?"SELECT id,state FROM runs WHERE state IN ('prepared','waiting_gpt','waiting_workbuddy','uncertain') LIMIT 1":"SELECT id,state FROM runs WHERE state NOT IN ('done','failed','cancelled') LIMIT 1").get();
    if(run)throw error('有尚未结束的任务（'+run.state+'）。请先在协作台处理，不能修改配置、重新连接或切换执行会话。',409);
    const leaseTable=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runner_lease'").get();
    if(leaseTable){const lease=db.prepare('SELECT pid FROM runner_lease WHERE id=1').get();if(alive(lease?.pid))throw error('协作任务仍在运行，请等待任务结束后再连接会话。',409);}
  }finally{db.close();}
}

function readBody(req,maximum){
  return new Promise((resolve,reject)=>{
    let bytes=0,finished=false;const chunks=[];
    req.on('data',chunk=>{if(finished)return;bytes+=chunk.length;if(bytes>maximum){finished=true;reject(error('请求内容过长。',413));return;}chunks.push(chunk);});
    req.once('error',reject);
    req.once('end',()=>{if(finished)return;finished=true;try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch{reject(error('请求不是有效的 JSON。'));}});
  });
}

/** No sockets are opened until the caller explicitly invokes server.listen(). */
export function createOnboardingServer({root=projectRoot,actions=createDefaultActions(root),discovery=discoverApplications,pickPath=pickConfigurationPath,configLoader=loadConfig,bodyLimit=16384,token=randomBytes(32).toString('hex'),instanceId=randomUUID()}={}){
  root=assertControlledPath(root);
  let activeAction=null;
  const configPath=path.join(root,'config/local.json');
  const readConfig=()=>configLoader({configPath,projectDir:root,checkExecutables:true});
  const runtimeMode=()=>{
    const filename=path.join(root,'config/active-runtime.json');
    if(!fs.existsSync(filename))return 'test';
    const mode=readJson(filename)?.mode;
    if(!['test','normal'].includes(mode))throw error('运行模式记录无效，请检查 config/active-runtime.json。',409);
    return mode;
  };
  const bridge={token,instanceId,get origin(){const address=server.address();return address&&typeof address!=='string'?'http://127.0.0.1:'+address.port:null;}};
  const server=http.createServer(async(req,res)=>{
    const send=(status,value,type='application/json')=>{
      if(res.headersSent)return;
      res.writeHead(status,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
      res.end(type==='application/json'?JSON.stringify(value):value);
    };
    try{
      const origin=bridge.origin;
      if(!origin||req.headers.host!==new URL(origin).host)return send(403,{error:'主机不允许。'});
      if(req.headers.origin&&req.headers.origin!==origin)return send(403,{error:'来源不允许。'});
      if(req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'跨站请求不允许。'});
      const url=new URL(req.url,origin);
      if(req.method==='GET'&&url.pathname==='/'){
        const html=fs.readFileSync(path.join(root,'ui/setup.html'),'utf8').replaceAll('__SETUP_TOKEN__',token);
        return send(200,html,'text/html');
      }
      if(req.method==='GET'&&url.pathname==='/api/identity')return send(200,{service:'chat-work-bridge/setup',instanceId});
      const supplied=Buffer.from(String(req.headers['x-bridge-token']??'')),expected=Buffer.from(token);
      if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return send(403,{error:'请求未授权，请刷新向导页面。'});
      if(req.method==='GET'&&url.pathname==='/api/state'){
        let config=null,problem=null;
        try{config=readConfig();}catch(e){problem={code:e.code??'LOCAL_CONFIG_INVALID',message:e.message};}
        const detected=await discovery({root,workbuddyExe:config?.workbuddyExe});
        const runtime=readJson(path.join(root,'config/active-runtime.json'));
        const connected=Boolean(config&&runtime?.mode===(config.workbuddyMode??'test')&&runtime.configurationHash===connectionFingerprint(config));
        return send(200,{configured:config!==null,connected,config:configForForm(config),problem,detected,root,mode:runtimeMode(),activeAction});
      }
      if(req.method!=='POST')return send(404,{error:'未找到。'});
      if(req.headers.origin!==origin)return send(403,{error:'来源未确认。'});
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))return send(415,{error:'必须使用 application/json。'});
      if(Number(req.headers['content-length'])>bodyLimit)return send(413,{error:'请求内容过长。'});
      const data=await readBody(req,bodyLimit);
      if(activeAction)return send(409,{error:'当前操作尚未结束：'+activeAction});
      if(url.pathname==='/api/pick-path'){
        if(!isObject(data)||Object.keys(data).length!==1||!pickerFields.has(data.field))throw error('只允许选择 Chrome、WorkBuddy 程序或已有日常资料目录。');
        activeAction='pickPath';
        try{return send(200,await pickPath(data.field,{root}));}finally{activeAction=null;}
      }
      if(url.pathname==='/api/detect'){
        if(!isObject(data)||Object.keys(data).some(key=>key!=='workbuddyExe'))throw error('检测请求字段无效。');
        if(data.workbuddyExe)validateExecutable(data.workbuddyExe,'workbuddyExe');
        activeAction='detect';
        try{return send(200,await discovery({root,workbuddyExe:data.workbuddyExe}));}finally{activeAction=null;}
      }
      if(url.pathname==='/api/config'){
        if(Object.values(data?.ports??{}).includes(server.address().port))throw error('应用端口不能与当前配置向导端口相同。');
        return send(200,saveLocalConfig(data,{root,configLoader}));
      }
      const actionName={'/api/open-apps':'openApps','/api/connect-session':'connectSession','/api/open-dashboard':'openDashboard'}[url.pathname];
      if(!actionName)return send(404,{error:'未找到。'});
      if(!isObject(data)||Object.keys(data).length)return send(400,{error:'此操作不接受命令、路径或其他参数。'});
      const config=readConfig();
      const selected=config.workbuddyMode??'test';
      if(selected==='normal'&&!config.allowNormalProfile)return send(409,{error:'请先明确允许沿用日常 WorkBuddy 资料目录。'});
      if(!config.allowNativeRuntimeRecords)return send(409,{error:'请先在配置中明确选择是否允许 WorkBuddy 自身的系统运行记录。未勾选时不会启动或连接应用。'});
      const runtime=readJson(path.join(root,'config/active-runtime.json'));
      if(actionName==='openDashboard'&&(runtime?.mode!==selected||runtime.configurationHash!==connectionFingerprint(config)))return send(409,{error:'当前配置尚未连接成功。请先点击“登录后连接会话”，确认完成后再打开协作台。'});
      if(typeof actions[actionName]!=='function')throw error('操作尚未配置。',503);
      activeAction=actionName;
      let deferredRelease=false;
      try{
        if(actionName==='connectSession')await assertNoPendingTask(root,{allowSaved:true});
        return send(200,{ok:true,...await actions[actionName]({config,root})});
      }catch(e){
        if(e.operationCompletion){deferredRelease=true;Promise.resolve(e.operationCompletion).then(()=>{activeAction=null;},()=>{activeAction=null;});}
        throw e;
      }finally{if(!deferredRelease)activeAction=null;}
    }catch(e){send(e.status??400,{error:e.message});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  return {server,...bridge,get origin(){return bridge.origin;}};
}

export function portOccupied(port){
  return new Promise(resolve=>{
    const socket=net.connect({host:'127.0.0.1',port});let settled=false;
    const finish=value=>{if(!settled){settled=true;socket.destroy();resolve(value);}};
    socket.setTimeout(1000);socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.once('timeout',()=>finish(false));
  });
}

/** Reuse only this checkout's recorded browser. Creating a tab never sends a model message. */
export async function openManagedPage(url,{root=projectRoot,config=null,chromeExe,connect=endpoint=>chromium.connectOverCDP(endpoint,{noDefaults:true,timeout:10000}),spawnProcess=spawn,isAlive=alive,isPortOccupied=portOccupied,wait=delay,now=Date.now,readinessTimeoutMs=10000}={}){
  const profile=assertControlledPath(path.join(root,'runtime/gpt-browser'));
  const home=assertControlledPath(path.join(root,'runtime/chrome-home'));
  const temp=assertControlledPath(path.join(root,'runtime/temp'));
  const stateFile=assertControlledPath(path.join(root,'data/gpt-browser-launch.json'));
  const port=config?.ports.gpt??defaultPorts.gpt;
  const executable=config?.chromeExe??chromeExe;
  const record=readJson(stateFile);
  if(record&&!record.exitedAt&&isAlive(record.pid)){
    if(record.port!==port||!samePath(record.profile,profile)||!samePath(record.exe,executable))throw error('已有受管浏览器的身份、资料目录或端口不匹配；请先核对，不会启动第二个窗口。',409);
    const browser=await connect('http://127.0.0.1:'+port);
    try{
      const context=browser.contexts()[0];if(!context)throw error('受管浏览器没有可用窗口。');
      const target=new URL(url);
      const preserveChat=target.origin==='https://chatgpt.com';
      const page=context.pages().find(p=>{try{const current=new URL(p.url());return current.origin===target.origin&&(current.pathname===target.pathname||(preserveChat&&/^\/c\/[\w-]+$/.test(current.pathname)));}catch{return false;}})??await context.newPage();
      if(page.url()!==url&&!(preserveChat&&page.url().startsWith('https://chatgpt.com/')))await page.goto(url);
      await page.bringToFront();
      return {reused:true,pid:record.pid,port};
    }finally{await browser.close();}
  }
  if(await isPortOccupied(port))throw error('浏览器端口 '+port+' 已被占用，但没有本项目的有效启动记录；不会连接未知浏览器。',409);
  if(!executable||!fs.existsSync(executable)||!fs.statSync(executable).isFile())return {opened:false,reason:'未找到 Chrome，请手动打开 '+url};
  validateExecutable(executable,'chromeExe');
  for(const dir of [profile,home,temp,path.join(home,'AppData/Roaming'),path.join(home,'AppData/Local'),path.join(root,'logs'),path.join(root,'data')])fs.mkdirSync(assertControlledPath(dir),{recursive:true});
  const env={...process.env,TEMP:temp,TMP:temp,USERPROFILE:home,HOME:home,HOMEDRIVE:path.parse(home).root.slice(0,2),HOMEPATH:home.slice(2),APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local')};
  for(const key of Object.keys(env))if(/^(OPENAI|ANTHROPIC|CODEBUDDY|WORKBUDDY|WB_)/i.test(key))delete env[key];
  const fd=fs.openSync(path.join(root,'logs/gpt-browser.log'),'a');
  let child;
  try{child=spawnProcess(executable,['--user-data-dir='+profile,'--disk-cache-dir='+path.join(profile,'Cache'),'--remote-debugging-port='+port,'--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','--disable-component-update','--disable-breakpad','--disable-crash-reporter',url],{env,cwd:root,detached:true,windowsHide:false,stdio:['ignore',fd,fd]});child.unref?.();}finally{fs.closeSync(fd);}
  let failure,exited=false;child.once('error',e=>{failure=e;});
  const state={startedAt:new Date().toISOString(),exe:executable,pid:child.pid,profile,port,openedBy:'setup'};
  if(child.pid)fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n');
  child.once('exit',(code,signal)=>{
    exited=true;
    if(readJson(stateFile)?.pid===child.pid)fs.writeFileSync(stateFile,JSON.stringify({...state,exitedAt:new Date().toISOString(),code,signal},null,2)+'\n');
  });
  const deadline=now()+readinessTimeoutMs;
  for(let i=0;i<40&&now()<deadline;i++){
    if(failure)throw failure;
    if(exited)return {opened:false,reason:'Chrome 启动后已退出，请检查 logs/gpt-browser.log；向导地址：'+url};
    if(await isPortOccupied(port)){
      let browser;
      try{
        browser=await connect('http://127.0.0.1:'+port);
        if(browser.contexts()[0])return {opened:true,pid:child.pid,port};
      }catch{/* The port may be ready before the browser context exists. */}
      finally{await browser?.close().catch(()=>{});}
    }
    await wait(250);
  }
  return {opened:false,reason:'Chrome 启动尚未确认，请查看 logs/gpt-browser.log；向导地址：'+url};
}
