import path from 'node:path';
import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {validateExecutable,assertControlledPath} from './local-config.mjs';

const execFileAsync=promisify(execFile);
const registryRoots=['HKCU','HKLM'];
const appNames={chrome:['chrome.exe'],workbuddy:['WorkBuddyAI.exe','WorkBuddy.exe']};

export function dailyProfileFromSelection(directory){
  const selected=assertControlledPath(directory,{requireDataDrive:false});
  for(const configDir of [selected,path.join(selected,'.workbuddy-ai')]){
    const candidate=assertControlledPath(configDir,{requireDataDrive:false});
    const database=assertControlledPath(path.join(candidate,'workbuddy.db'),{requireDataDrive:false});
    if(fs.existsSync(database)&&fs.statSync(database).isFile())return {workbuddyProfile:path.dirname(candidate),workbuddyConfigDir:candidate};
  }
  throw Error('所选目录中没有找到已有 WorkBuddy 配置。请选择日常用户资料目录，或其包含 workbuddy.db 的配置子目录。');
}

async function queryRegistry(key){
  const {stdout}=await execFileAsync('reg.exe',['query',key,'/ve'],{encoding:'utf8',windowsHide:true,timeout:3000,maxBuffer:16384});
  return stdout;
}

/** Inspect known executable locations only. Never read account databases or start an application. */
export async function discoverApplications({env=process.env,platform=process.platform,root=process.cwd(),workbuddyExe,registry=true,registryQuery=queryRegistry,isFile=filename=>{
  try{validateExecutable(filename,path.win32.basename(filename).toLowerCase()==='chrome.exe'?'chromeExe':'workbuddyExe');return true;}catch{return false;}
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
      p.join(root,'apps','Chrome','Application','chrome.exe'),
      p.join(root,'apps','Chrome','chrome.exe'),
    ],
    workbuddy:[
      workbuddyExe,
      p.join(root,'apps','WorkBuddy','WorkBuddyAI.exe'),
      p.join(root,'apps','WorkBuddy','WorkBuddy.exe'),
      ...['WorkBuddy','WorkBuddy AI','WorkBuddyAI'].flatMap(name=>[
        join(env.LOCALAPPDATA,'Programs',name,'WorkBuddyAI.exe'),
        join(env.LOCALAPPDATA,name,'WorkBuddyAI.exe'),
        join(env.ProgramFiles,name,'WorkBuddyAI.exe'),
        p.join(drive+'\\','Apps',name,'WorkBuddyAI.exe'),
        p.join(drive+'\\',name,'WorkBuddyAI.exe'),
      ]),
    ],
  };
  const result={chrome:[],workbuddy:[],profiles:[],registryChecked:false};
  const add=(kind,candidate,source)=>{
    if(typeof candidate!=='string'||candidate.includes('\0')||!p.isAbsolute(candidate)||!appNames[kind].some(name=>name.toLowerCase()===p.basename(candidate).toLowerCase()))return;
    if(isFile(candidate)&&!result[kind].some(item=>item.path.toLowerCase()===candidate.toLowerCase()))result[kind].push({path:candidate,source});
  };
  for(const kind of Object.keys(common))for(const candidate of common[kind])add(kind,candidate,'common-location');
  for(const directory of (env.PATH??env.Path??'').split(';').filter(Boolean).slice(0,64))for(const [kind,names] of Object.entries(appNames))for(const name of names)add(kind,p.join(directory,name),'path-environment');
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
  const profileLocations=[
    env.WORKBUDDY_CONFIG_DIR,env.CODEBUDDY_CONFIG_DIR,
    env.WORKBUDDY_USER_DATA_DIR?p.dirname(env.WORKBUDDY_USER_DATA_DIR):null,
    env.USERPROFILE,
    p.join(root,'apps','WorkBuddy','Profile'),
    ...result.workbuddy.flatMap(item=>[
      p.join(p.dirname(item.path),'Profile'),
      p.join(p.dirname(item.path),'..','Profile'),
      p.join(p.dirname(item.path),'.workbuddy-ai'),
    ]),
  ];
  for(const location of profileLocations){
    if(!location)continue;
    try{
      const profile=dailyProfileFromSelection(location);
      if(!result.profiles.some(item=>item.workbuddyConfigDir.toLowerCase()===profile.workbuddyConfigDir.toLowerCase()))result.profiles.push({...profile,source:'existing-profile-metadata'});
    }catch{/* A missing or unsupported profile must never become an invented default. */}
  }
  return result;
}
