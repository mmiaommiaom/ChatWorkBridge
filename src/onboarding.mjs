import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright-core';
import {loadConfig,projectRoot,assertControlledPath} from './local-config.mjs';
import {discoverApplications} from './app-discovery.mjs';

export const defaultSetupPort=18694;
const defaultPorts={workbuddy:18690,gpt:18691,dashboard:18692,normalWorkbuddy:18693};
const fields=new Set(['workbuddyExe','chromeExe','workbuddyProfile','workbuddyConfigDir','allowNormalProfile','allowNativeRuntimeRecords','ports','dataDrive']);
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
    allowNormalProfile:config?.allowNormalProfile===true,allowNativeRuntimeRecords:config?.allowNativeRuntimeRecords===true,
    ports:{...defaultPorts,...config?.ports},
  };
}

/** Reject unrecognised fields before touching a file. Both permission choices must be explicit booleans. */
export function validateConfigFields(input){
  if(!isObject(input))throw error('配置必须是 JSON 对象。');
  for(const key of Object.keys(input))if(!fields.has(key))throw error('不允许的配置字段：'+key);
  for(const key of ['allowNormalProfile','allowNativeRuntimeRecords'])if(typeof input[key]!=='boolean')throw error(key+' 必须由复选框明确选择 true 或 false。');
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
  const directory=assertControlledPath(path.join(root,'config'));
  const configPath=assertControlledPath(path.join(directory,'local.json'));
  const browserRecord=readJson(path.join(root,'data/gpt-browser-launch.json'));
  if(browserRecord&&!browserRecord.exitedAt&&alive(browserRecord.pid)){
    if(browserRecord.port!==(candidate.ports?.gpt??defaultPorts.gpt)||!samePath(browserRecord.exe,candidate.chromeExe))throw error('受管浏览器仍在运行。请保留当前 Chrome 路径和端口；如需更改，先正常关闭受管浏览器。',409);
  }
  fs.mkdirSync(directory,{recursive:true});
  const pending=assertControlledPath(path.join(directory,'local.pending-'+randomUUID()+'.json'));
  fs.writeFileSync(pending,JSON.stringify(candidate,null,2)+'\n',{flag:'wx'});
  // A rejected candidate remains as a local diagnostic file; the active configuration is untouched.
  const validated=configLoader({configPath:pending,checkExecutables:true});
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

function runFixedScript(root,name,{timeoutMs=120000}={}){
  return new Promise((resolve,reject)=>{
    let output='',settled=false;
    const child=spawn(process.execPath,[path.join(root,'scripts',name)],{cwd:root,windowsHide:true,env:controlledEnvironment(root),stdio:['ignore','pipe','pipe']});
    const append=chunk=>{output=(output+chunk.toString()).slice(-16000);};
    child.stdout.on('data',append);child.stderr.on('data',append);
    const timer=setTimeout(()=>{
      // The child may still be opening its owned apps. Do not terminate it or retry implicitly.
      if(!settled){settled=true;reject(error('操作仍未确认完成，请查看日志；不要重复启动。\n'+output,504));}
    },timeoutMs);
    child.once('error',failure=>{clearTimeout(timer);if(!settled){settled=true;reject(failure);}});
    child.once('exit',code=>{clearTimeout(timer);if(!settled){settled=true;code===0?resolve({message:output.trim()}):reject(error(output.trim()||name+' 退出：'+code));}});
  });
}

export function createDefaultActions(root=projectRoot){
  return {
    openApps:async({config})=>{
      const result=await runFixedScript(root,'open-apps.mjs');
      await openManagedPage('https://chatgpt.com/',{root,config});
      return result;
    },
    connectSession:async()=>{
      const {initializeSession}=await import('./initialize-session.mjs');
      return initializeSession();
    },
    openDashboard:async({config})=>{
      const origin='http://127.0.0.1:'+config.ports.dashboard;
      const record=readJson(path.join(root,'data/dashboard-launch.json'));
      if(await portOccupied(config.ports.dashboard)){
        if(!record||record.origin!==origin||!alive(record.pid))throw error('协作台端口已被占用，且无法确认属于本项目。请检查已有服务。',409);
        await openManagedPage(origin,{root,config});
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

function readBody(req,maximum){
  return new Promise((resolve,reject)=>{
    let bytes=0,finished=false;const chunks=[];
    req.on('data',chunk=>{if(finished)return;bytes+=chunk.length;if(bytes>maximum){finished=true;reject(error('请求内容过长。',413));return;}chunks.push(chunk);});
    req.once('error',reject);
    req.once('end',()=>{if(finished)return;finished=true;try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch{reject(error('请求不是有效的 JSON。'));}});
  });
}

/** No sockets are opened until the caller explicitly invokes server.listen(). */
export function createOnboardingServer({root=projectRoot,actions=createDefaultActions(root),discovery=discoverApplications,configLoader=loadConfig,bodyLimit=16384,token=randomBytes(32).toString('hex'),instanceId=randomUUID()}={}){
  root=assertControlledPath(root);
  let activeAction=null;
  const configPath=path.join(root,'config/local.json');
  const readConfig=()=>configLoader({configPath,checkExecutables:true});
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
        const detected=await discovery({root});
        return send(200,{configured:config!==null,config:configForForm(config),problem,detected,root,mode:runtimeMode(),activeAction});
      }
      if(req.method!=='POST')return send(404,{error:'未找到。'});
      if(req.headers.origin!==origin)return send(403,{error:'来源未确认。'});
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??''))return send(415,{error:'必须使用 application/json。'});
      if(Number(req.headers['content-length'])>bodyLimit)return send(413,{error:'请求内容过长。'});
      const data=await readBody(req,bodyLimit);
      if(activeAction)return send(409,{error:'当前操作尚未结束：'+activeAction});
      if(url.pathname==='/api/config')return send(200,saveLocalConfig(data,{root,configLoader}));
      const actionName={'/api/open-apps':'openApps','/api/connect-session':'connectSession','/api/open-dashboard':'openDashboard'}[url.pathname];
      if(!actionName)return send(404,{error:'未找到。'});
      if(!isObject(data)||Object.keys(data).length)return send(400,{error:'此操作不接受命令、路径或其他参数。'});
      if(runtimeMode()!=='test')return send(409,{error:'此向导只操作独立测试模式。当前是日常模式，请使用已有的日常入口；向导不会替你切换。'});
      const config=readConfig();
      if(!config.allowNativeRuntimeRecords)return send(409,{error:'请先在配置中明确选择是否允许 WorkBuddy 自身的系统运行记录。未勾选时不会启动或连接应用。'});
      if(typeof actions[actionName]!=='function')throw error('操作尚未配置。',503);
      activeAction=actionName;
      try{return send(200,{ok:true,...await actions[actionName]({config,root})});}finally{activeAction=null;}
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
export async function openManagedPage(url,{root=projectRoot,config=null,chromeExe,connect=endpoint=>chromium.connectOverCDP(endpoint,{noDefaults:true,timeout:10000}),spawnProcess=spawn,isAlive=alive,isPortOccupied=portOccupied,wait=delay}={}){
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
  for(const dir of [profile,home,temp,path.join(home,'AppData/Roaming'),path.join(home,'AppData/Local'),path.join(root,'logs'),path.join(root,'data')])fs.mkdirSync(assertControlledPath(dir),{recursive:true});
  const env={...process.env,TEMP:temp,TMP:temp,USERPROFILE:home,HOME:home,HOMEDRIVE:path.parse(home).root.slice(0,2),HOMEPATH:home.slice(2),APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local')};
  for(const key of Object.keys(env))if(/^(OPENAI|ANTHROPIC|CODEBUDDY|WORKBUDDY|WB_)/i.test(key))delete env[key];
  const fd=fs.openSync(path.join(root,'logs/gpt-browser.log'),'a');
  let child;
  try{child=spawnProcess(executable,['--user-data-dir='+profile,'--disk-cache-dir='+path.join(profile,'Cache'),'--remote-debugging-port='+port,'--remote-debugging-address=127.0.0.1','--no-first-run','--no-default-browser-check','--disable-component-update','--disable-breakpad','--disable-crash-reporter',url],{env,cwd:root,windowsHide:false,stdio:['ignore',fd,fd]});}finally{fs.closeSync(fd);}
  let failure;child.once('error',e=>{failure=e;});
  const state={startedAt:new Date().toISOString(),exe:executable,pid:child.pid,profile,port,openedBy:'setup'};
  if(child.pid)fs.writeFileSync(stateFile,JSON.stringify(state,null,2)+'\n');
  child.once('exit',(code,signal)=>{
    if(readJson(stateFile)?.pid===child.pid)fs.writeFileSync(stateFile,JSON.stringify({...state,exitedAt:new Date().toISOString(),code,signal},null,2)+'\n');
  });
  for(let i=0;i<40;i++){
    if(failure)throw failure;
    if(await isPortOccupied(port))return {opened:true,pid:child.pid,port};
    await wait(250);
  }
  return {opened:false,reason:'Chrome 启动尚未确认，请查看 logs/gpt-browser.log；向导地址：'+url};
}
