import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const execFileAsync=promisify(execFile);
const registryRoots=['HKCU','HKLM'];
const appNames={chrome:['chrome.exe'],workbuddy:['WorkBuddyAI.exe','WorkBuddy.exe']};

async function queryRegistry(key){
  const {stdout}=await execFileAsync('reg.exe',['query',key,'/ve'],{encoding:'utf8',windowsHide:true,timeout:3000,maxBuffer:16384});
  return stdout;
}

/** Inspect known executable locations only. Never read account databases or start an application. */
export async function discoverApplications({env=process.env,platform=process.platform,root=process.cwd(),registry=true,registryQuery=queryRegistry,isFile=filename=>{
  try{return fs.statSync(filename).isFile();}catch{return false;}
}}={}){
  const p=path.win32;
  const drive=/^[A-Za-z]:/.test(root)?root.slice(0,2):'E:';
  const join=(base,...parts)=>base?p.join(base,...parts):null;
  const common={
    chrome:[
      join(env.ProgramFiles,'Google','Chrome','Application','chrome.exe'),
      join(env['ProgramFiles(x86)'],'Google','Chrome','Application','chrome.exe'),
      join(env.LOCALAPPDATA,'Google','Chrome','Application','chrome.exe'),
      p.join(drive+'\\','Apps','Chrome','Application','chrome.exe'),
      p.join(drive+'\\','Program Files','Google','Chrome','Application','chrome.exe'),
    ],
    workbuddy:[
      ...['WorkBuddy','WorkBuddy AI','WorkBuddyAI'].flatMap(name=>[
        join(env.LOCALAPPDATA,'Programs',name,'WorkBuddyAI.exe'),
        join(env.LOCALAPPDATA,name,'WorkBuddyAI.exe'),
        join(env.ProgramFiles,name,'WorkBuddyAI.exe'),
        p.join(drive+'\\','Apps',name,'WorkBuddyAI.exe'),
        p.join(drive+'\\',name,'WorkBuddyAI.exe'),
      ]),
    ],
  };
  const result={chrome:[],workbuddy:[],registryChecked:false};
  const add=(kind,candidate,source)=>{
    if(typeof candidate!=='string'||candidate.includes('\0')||!p.isAbsolute(candidate)||!appNames[kind].some(name=>name.toLowerCase()===p.basename(candidate).toLowerCase()))return;
    if(isFile(candidate)&&!result[kind].some(item=>item.path.toLowerCase()===candidate.toLowerCase()))result[kind].push({path:candidate,source});
  };
  for(const kind of Object.keys(common))for(const candidate of common[kind])add(kind,candidate,'common-location');
  if(registry&&platform==='win32'){
    result.registryChecked=true;
    await Promise.all(Object.entries(appNames).flatMap(([kind,names])=>names.flatMap(name=>registryRoots.map(async hive=>{
      const key=hive+'\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\'+name;
      try{
        const output=await registryQuery(key);
        for(const line of String(output).split(/\r?\n/)){
          const match=line.match(/\sREG_(?:EXPAND_)?SZ\s+(.+)$/i);
          if(!match)continue;
          const candidate=match[1].trim().replace(/^"(.*)"$/,'$1').replace(/%([^%]+)%/g,(_,name)=>env[name]??'%'+name+'%');
          add(kind,candidate,'app-paths-registry');
        }
      }catch{/* Missing keys and inaccessible registry views are ordinary discovery misses. */}
    }))));
  }
  return result;
}
