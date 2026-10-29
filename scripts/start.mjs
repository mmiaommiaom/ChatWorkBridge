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

/** Never adopt another installation's service; remember a fallback port for repeat starts. */
export async function bindSetup({root=projectRoot,port=setupPort(),allowFallback=process.env.WB_BRIDGE_SETUP_PORT===undefined,maxAttempts=20}={}){
  const data=assertControlledPath(path.join(root,'data'));fs.mkdirSync(data,{recursive:true});
  const recordFile=path.join(data,'setup-launch.json');
  let record;try{record=JSON.parse(fs.readFileSync(recordFile,'utf8'));}catch{}
  if(record&&allowFallback){
    let saved;try{saved=new URL(record.origin);}catch{}
    if(saved?.protocol==='http:'&&saved.hostname==='127.0.0.1'&&saved.pathname==='/'&&Number(saved.port)>=1024&&await existingSetup(saved.origin,record))return {reused:true,origin:saved.origin};
  }
  const setup=createOnboardingServer({root});
  const limit=allowFallback?maxAttempts:1;
  for(let attempt=0;attempt<limit&&port+attempt<=65535;attempt++){
    const candidate=port+attempt,origin='http://127.0.0.1:'+candidate;
    try{
      await new Promise((resolve,reject)=>{
        const ready=()=>{setup.server.off('error',failed);resolve();};
        const failed=e=>{setup.server.off('listening',ready);reject(e);};
        setup.server.once('error',failed);setup.server.once('listening',ready);setup.server.listen(candidate,'127.0.0.1');
      });
      try{fs.writeFileSync(recordFile,JSON.stringify({pid:process.pid,origin,instanceId:setup.instanceId,startedAt:new Date().toISOString()},null,2)+'\n');}
      catch(e){await new Promise(resolve=>setup.server.close(resolve));throw e;}
      return {reused:false,origin,server:setup.server};
    }catch(e){
      if(e.code!=='EADDRINUSE')throw e;
      if(await existingSetup(origin,record))return {reused:true,origin};
      if(!allowFallback)throw Error('指定的向导端口 '+candidate+' 已被其他服务占用。请更改 WB_BRIDGE_SETUP_PORT 或清除该设置后自动选择端口。');
    }
  }
  throw Error('未找到可用的向导端口，请设置 WB_BRIDGE_SETUP_PORT 后重新运行。');
}

/** Opening this entry point only shows setup. No prompts or model calls are submitted. */
export async function main(){
  checkNode();
  const root=assertControlledPath(projectRoot);
  const temp=assertControlledPath(path.join(root,'runtime/temp'));
  fs.mkdirSync(temp,{recursive:true});process.env.TEMP=temp;process.env.TMP=temp;
  process.env.WB_BRIDGE_CONFIG=path.join(root,'config/local.json');
  const {origin,reused,server}=await bindSetup({root});
  console.log((reused?'复用已有向导：':'首次配置向导：')+origin);
  console.log('这里只打开配置页面；点击按钮后才打开应用、连接会话，任务需在协作台明确开始。');
  let config=null;
  try{config=loadConfig({checkExecutables:true});}catch(e){console.log(e.message);}
  const found=await discoverApplications({root,workbuddyExe:config?.workbuddyExe});
  const chromeExe=config?.chromeExe??found.chrome[0]?.path;
  try{
    const result=await openManagedPage(origin,{root,config,chromeExe});
    if(result.opened===false)console.log(result.reason);
  }catch(e){console.error('浏览器未自动打开：'+e.message+'\n请手动打开 '+origin);}
  if(reused)return {reused,origin};
  server.on('error',e=>console.error('向导错误：'+e.message));
  return {reused,origin,server};
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  main().catch(e=>{console.error('启动失败：'+e.message);console.error('请查看项目 logs/start.log。');process.exitCode=1;});
}
