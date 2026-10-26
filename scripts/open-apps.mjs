import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {connectGpt} from '../src/chatgpt-web.mjs';
import {connectDesktop,runtimeMode} from '../src/workbuddy-desktop.mjs';
import {loadConfig,assertControlledPath} from '../src/local-config.mjs';

const local=loadConfig({checkExecutables:true}),root=local.projectRoot;
if(!local.allowNativeRuntimeRecords)throw Error('请先核对本机配置并明确允许 WorkBuddy 自身的原生系统运行记录。');
const normal=runtimeMode()==='normal';
if(normal&&!local.allowNormalProfile)throw Error('当前选择日常模式，但本机配置未允许沿用日常 WorkBuddy。');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const occupied=port=>new Promise(resolve=>{
 const socket=net.connect({host:'127.0.0.1',port});
 socket.setTimeout(1000);
 socket.once('connect',()=>{socket.destroy();resolve(true);});
 socket.once('error',()=>{socket.destroy();resolve(false);});
 socket.once('timeout',()=>{socket.destroy();resolve(false);});
});
async function ready(connect){const connection=await connect();await connection.browser.close();}
const apps=[
 {name:'WorkBuddy',port:normal?local.ports.normalWorkbuddy:local.ports.workbuddy,script:normal?'launch-normal-workbuddy.mjs':'launch-workbuddy.mjs',connect:()=>connectDesktop({mode:normal?'normal':'test'})},
 {name:'ChatGPT 浏览器',port:local.ports.gpt,script:'launch-gpt-browser.mjs',connect:connectGpt},
];
for(const app of apps){
 if(await occupied(app.port)){await ready(app.connect);console.log(app.name+' 已连接。');continue;}
 fs.mkdirSync(assertControlledPath(path.join(root,'logs')),{recursive:true});
 fs.mkdirSync(assertControlledPath(local.tempDir),{recursive:true});
 const fd=fs.openSync(path.join(root,'logs/launcher.log'),'a');
 const child=spawn(process.execPath,[path.join(root,'scripts',app.script)],{
  cwd:root,detached:true,windowsHide:true,stdio:['ignore',fd,fd],
  env:{...process.env,TEMP:local.tempDir,TMP:local.tempDir},
 });
 fs.closeSync(fd);let launchError;child.on('error',error=>{launchError=error;});child.unref();
 let connected=false;
 for(let i=0;i<45;i++){
  if(launchError)throw launchError;
  await delay(1000);
  if(await occupied(app.port)){await ready(app.connect);connected=true;break;}
 }
 if(!connected)throw Error(app.name+' 启动未确认，请查看项目 logs/launcher.log。');
 console.log(app.name+' 已打开。');
}
console.log('请保持两个窗口打开。首次使用需在对应窗口手动登录，然后再运行任务。');
