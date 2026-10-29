import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {connectGpt} from '../src/chatgpt-web.mjs';
import {connectDesktop} from '../src/workbuddy-desktop.mjs';
import {loadConfig,assertControlledPath,validateDailyProfile} from '../src/local-config.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const occupied=port=>new Promise(resolve=>{
 const socket=net.connect({host:'127.0.0.1',port});let settled=false;
 const finish=value=>{if(!settled){settled=true;socket.destroy();resolve(value);}};
 socket.setTimeout(1000);
 socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.once('timeout',()=>finish(false));
});
async function ready(connect){const connection=await connect();await connection.browser.close();}

/** The launcher monitors readiness; it never waits for the application itself to exit. */
export async function openApplications({local=loadConfig({checkExecutables:true}),spawnProcess=spawn,isOccupied=occupied,connectWorker=connectDesktop,connectBrowser=connectGpt,wait=delay,attempts=45,now=Date.now,readinessTimeoutMs=45000,log=console.log}={}){
const root=local.projectRoot;
if(!local.allowNativeRuntimeRecords)throw Error('请先核对本机配置并明确允许 WorkBuddy 自身的原生系统运行记录。');
const mode=local.workbuddyMode??'test',normal=mode==='normal';
if(!['test','normal'].includes(mode))throw Error('WorkBuddy 模式无效，请在向导重新保存配置。');
if(normal&&!local.allowNormalProfile)throw Error('当前选择日常模式，但本机配置未允许沿用日常 WorkBuddy。');
if(normal)validateDailyProfile(local);
const apps=[
 {name:'WorkBuddy',port:normal?local.ports.normalWorkbuddy:local.ports.workbuddy,script:normal?'launch-normal-workbuddy.mjs':'launch-workbuddy.mjs',connect:()=>connectWorker({mode})},
 {name:'ChatGPT 浏览器',port:local.ports.gpt,script:'launch-gpt-browser.mjs',connect:connectBrowser},
];
for(const app of apps){
 const deadline=now()+readinessTimeoutMs;
 if(await isOccupied(app.port)){
  let lastError;
  for(let i=0;i<attempts&&now()<deadline;i++){
   try{await ready(app.connect);lastError=null;break;}catch(e){lastError=e;}
   await wait(1000);
  }
  if(lastError)throw Error(app.name+' 的连接端口已占用，但未能确认连接。'+lastError.message);
  log(app.name+' 已连接。');continue;
 }
 fs.mkdirSync(assertControlledPath(path.join(root,'logs')),{recursive:true});
 fs.mkdirSync(assertControlledPath(local.tempDir),{recursive:true});
 const fd=fs.openSync(path.join(root,'logs/launcher.log'),'a');
 let child;
 try{child=spawnProcess(process.execPath,[path.join(root,'scripts',app.script)],{
  cwd:root,detached:true,windowsHide:app.script!=='launch-normal-workbuddy.mjs',stdio:['ignore',fd,fd],
  env:{...process.env,WB_BRIDGE_CONFIG:local.configPath,TEMP:local.tempDir,TMP:local.tempDir},
 });}finally{fs.closeSync(fd);}
 let launchError,exitCode;child.on('error',error=>{launchError=error;});child.once('exit',code=>{exitCode=code;});child.unref();
 let connected=false,lastError;
 for(let i=0;i<attempts&&now()<deadline;i++){
  if(launchError)throw launchError;
  if(exitCode!==undefined)throw Error(app.name+' 启动器提前退出（'+exitCode+'）。'+(normal&&app.name==='WorkBuddy'&&exitCode===2?'请先保存工作并从托盘彻底退出已有 WorkBuddy，再重试。':'请查看 logs/launcher.log 中的具体错误。'));
  await wait(1000);
  if(await isOccupied(app.port)){
   // The debug port can become available before the app renderer is ready.
   try{await ready(app.connect);connected=true;break;}catch(e){lastError=e;}
  }
 }
 if(!connected)throw Error(app.name+' 启动未确认，请查看项目 logs/launcher.log。'+(lastError?' 最后连接错误：'+lastError.message:''));
 log(app.name+' 已打开。');
}
const message='请保持两个窗口打开。首次使用需在对应窗口手动登录，再点击“登录后连接会话”。';
log(message);return {message,mode};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 openApplications().catch(error=>{console.error(error.message);process.exitCode=1;});
}
