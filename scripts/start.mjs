import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createOnboardingServer,openManagedPage,setupPort} from '../src/onboarding.mjs';
import {discoverApplications} from '../src/app-discovery.mjs';
import {loadConfig,assertControlledPath,projectRoot} from '../src/local-config.mjs';

export function checkNode(version=process.versions.node){
  const [major,minor]=version.split('.').map(Number);
  if(!Number.isInteger(major)||major<22||(major===22&&minor<13))throw Error('需要 Node.js 22.13 或更新版本。请使用完整 Windows 发行包，或安装新版 Node.js。');
}

async function existingSetup(origin,record){
  if(!record||record.origin!==origin||!Number.isInteger(record.pid)||!record.instanceId)return false;
  try{
    process.kill(record.pid,0);
    const response=await fetch(origin+'/api/identity',{signal:AbortSignal.timeout(2000)});
    const body=await response.json();
    return response.ok&&body.service==='chat-work-bridge/setup'&&body.instanceId===record.instanceId;
  }catch{return false;}
}

/** Opening this entry point only shows setup. No prompts or model calls are submitted. */
export async function main(){
  checkNode();
  const root=assertControlledPath(projectRoot);
  const temp=assertControlledPath(path.join(root,'runtime/temp'));
  fs.mkdirSync(temp,{recursive:true});process.env.TEMP=temp;process.env.TMP=temp;
  process.env.WB_BRIDGE_CONFIG=path.join(root,'config/local.json');
  const port=setupPort();
  const origin='http://127.0.0.1:'+port;
  const data=assertControlledPath(path.join(root,'data'));fs.mkdirSync(data,{recursive:true});
  const recordFile=path.join(data,'setup-launch.json');
  const setup=createOnboardingServer({root});
  let reused=false;
  try{
    await new Promise((resolve,reject)=>{setup.server.once('error',reject);setup.server.listen(port,'127.0.0.1',resolve);});
    fs.writeFileSync(recordFile,JSON.stringify({pid:process.pid,origin,instanceId:setup.instanceId,startedAt:new Date().toISOString()},null,2)+'\n');
  }catch(e){
    if(e.code!=='EADDRINUSE')throw e;
    let record;try{record=JSON.parse(fs.readFileSync(recordFile,'utf8'));}catch{}
    if(!await existingSetup(origin,record))throw Error('向导端口 '+port+' 已被其他服务占用。可设置 WB_BRIDGE_SETUP_PORT 后重新运行。');
    reused=true;
  }
  console.log((reused?'复用已有向导：':'首次配置向导：')+origin);
  console.log('这里只打开配置页面；点击按钮后才打开应用、连接会话，任务需在协作台明确开始。');
  let config=null;
  try{config=loadConfig({checkExecutables:true});}catch(e){console.log(e.message);}
  const found=await discoverApplications({root});
  const chromeExe=config?.chromeExe??found.chrome[0]?.path;
  try{
    const result=await openManagedPage(origin,{root,config,chromeExe});
    if(result.opened===false)console.log(result.reason);
  }catch(e){console.error('浏览器未自动打开：'+e.message+'\n请手动打开 '+origin);}
  if(reused)return {reused,origin};
  setup.server.on('error',e=>console.error('向导错误：'+e.message));
  return {reused,origin,server:setup.server};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  main().catch(e=>{console.error('启动失败：'+e.message);console.error('请查看项目 logs/start.log。');process.exitCode=1;});
}
