import fs from 'node:fs';
import path from 'node:path';
import {loadConfig,projectRoot} from '../src/local-config.mjs';

const requirements=[
 {name:'playwright-core',module:'playwright-core'},
 {name:'@modelcontextprotocol/sdk',module:'@modelcontextprotocol/sdk/server/mcp.js'},
 {name:'zod',module:'zod'},
];
const dependencies=Object.fromEntries(requirements.map(({name,module})=>{
 try{import.meta.resolve(module);return[name,{installed:true}];}
 catch{return[name,{installed:false,instruction:'请先运行 npm install。'}];}
}));
let local,configuration;
try{
 local=loadConfig({checkExecutables:true});
 configuration={
  configured:true,dataDrive:local.dataDrive,executablesFound:true,
  normalProfileAllowed:local.allowNormalProfile,nativeRuntimeRecordsAllowed:local.allowNativeRuntimeRecords,
  ports:local.ports,
 };
}catch(error){
 configuration={configured:false,error:error.message,code:error.code??'LOCAL_CONFIG_INVALID'};
}
const policyFile=path.join(projectRoot,'config/model-policy.json');
let policy;
try{policy=JSON.parse(fs.readFileSync(policyFile,'utf8'));}
catch{policy={error:'缺少或无法解析 config/model-policy.json。'};}
const report={
 checkedAt:new Date().toISOString(),
 checkType:'local prerequisites only; does not log in, launch applications, or replay saved task results',
 windows:process.platform==='win32',
 node:{version:process.version,supported:Number(process.versions.node.split('.')[0])>22||(Number(process.versions.node.split('.')[0])===22&&Number(process.versions.node.split('.')[1])>=13)},
 configuration,dependencies,modelPolicy:policy,
 verifiedLiveCapabilities:false,
 nativeLaunchAllowed:configuration.configured&&configuration.nativeRuntimeRecordsAllowed===true,
 notes:[
  '本检查无需既有 data 目录，不读取旧验收记录，不写入任何文件。',
  '通过检查表示本机配置和依赖齐全；不代表已经登录、模型可用或自动协作实测通过。',
  '日常 MCP/Skill 沿用已授权的本机 profile；下载版本不包含任何人的配置、登录数据或授权记录。',
  '模型费用、剩余额度和额度恢复时间未由此检查验证。',
 ],
};
report.ok=report.windows&&report.node.supported&&configuration.configured&&Object.values(dependencies).every(value=>value.installed)&&!policy.error;
console.log(JSON.stringify(report,null,2));
if(!report.ok)process.exitCode=1;
