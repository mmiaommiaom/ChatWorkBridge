import fs from 'node:fs';
import path from 'node:path';
import {loadConfig,assertControlledPath} from '../src/local-config.mjs';

const local=loadConfig({checkExecutables:true});
let asar;
try{
 const module=await import('@electron/asar');
 asar=typeof module.extractFile==='function'?module:module.default;
}catch{
 throw Error('静态检查需要可选开发依赖 @electron/asar。请先安装项目开发依赖；本脚本不会安装或修改 WorkBuddy。');
}
const archive=path.join(path.dirname(local.workbuddyExe),'resources/app.asar');
if(!fs.existsSync(archive))throw Error('指定 WorkBuddy 安装目录中没有 resources/app.asar。');
const pkg=JSON.parse(asar.extractFile(archive,'package.json').toString());
if(typeof pkg.main!=='string')throw Error('WorkBuddy archive 缺少 main 入口。');
const mainEntry=pkg.main.replace(/^\.[\\/]/,'').split(/[\\/]/).join(path.sep);
const main=asar.extractFile(archive,mainEntry).toString();
const terms=['WORKBUDDY_CONFIG_DIR','WORKBUDDY_USER_DATA_DIR','setAsDefaultProtocolClient','requestSingleInstanceLock','remote-debugging','registerProtocol','disable-protocol','WORKBUDDY_DISABLE','crashReporter.start','setLoginItemSettings'];
// Save only observed symbol counts, not proprietary application source snippets.
const symbolCounts=Object.fromEntries(terms.map(term=>[term,main.split(term).length-1]));
const report={
 inspectedAt:new Date().toISOString(),applicationReadOnly:true,archive,
 package:{name:pkg.name,version:pkg.version,main:pkg.main},symbolCounts,
 note:'Symbol presence alone does not verify that environment redirection or live messaging works.',
};
const directory=assertControlledPath(path.join(local.projectRoot,'data'));
fs.mkdirSync(directory,{recursive:true});
fs.writeFileSync(path.join(directory,'desktop-static-inspection.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
