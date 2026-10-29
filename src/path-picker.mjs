import path from 'node:path';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {projectRoot,assertControlledPath,validateExecutable} from './local-config.mjs';
import {dailyProfileFromSelection} from './app-discovery.mjs';

export const pickerFields=new Set(['chromeExe','workbuddyExe','workbuddyProfile']);
export function validatePickedPath(field,selection){
  if(!pickerFields.has(field))throw Error('不允许选择此配置字段。');
  if(selection?.cancelled===true)return {cancelled:true};
  if(typeof selection?.path!=='string'||!path.win32.isAbsolute(selection.path))throw Error('文件选择器没有返回有效本地路径。');
  if(field==='workbuddyProfile')return {cancelled:false,...dailyProfileFromSelection(selection.path)};
  validateExecutable(selection.path,field);
  return {cancelled:false,[field]:path.resolve(selection.path)};
}

/** Only the fixed Windows Shell picker is executed; no path becomes shell code. */
export async function pickConfigurationPath(field,{root=projectRoot,spawnProcess=spawn,platform=process.platform}={}){
  if(!pickerFields.has(field))throw Error('不允许选择此配置字段。');
  if(platform!=='win32')throw Error('自动浏览仅支持 Windows，请直接填写实际路径。');
  const temp=assertControlledPath(path.join(root,'runtime/temp'));fs.mkdirSync(temp,{recursive:true});
  const executable=path.win32.join(process.env.SystemRoot??'C:\\Windows','System32','cscript.exe');
  const selected=await new Promise((resolve,reject)=>{
    const child=spawnProcess(executable,['//NoLogo','//U',path.join(root,'scripts/select-path.vbs'),field],{cwd:root,windowsHide:false,env:{...process.env,TEMP:temp,TMP:temp},stdio:['ignore','pipe','pipe']});
    let output='',diagnostic='';
    const decoder=new StringDecoder('utf16le'),errorDecoder=new StringDecoder('utf16le');
    child.stdout.on('data',b=>{output=(output+decoder.write(b)).slice(-16384);});
    child.stderr.on('data',b=>{diagnostic=(diagnostic+errorDecoder.write(b)).slice(-2000);});
    child.once('error',e=>reject(Error('无法打开系统文件选择器，请手动填写路径。'+e.message)));
    child.once('exit',code=>{
      output+=decoder.end();diagnostic+=errorDecoder.end();
      if(code!==0)return reject(Error('文件选择器未完成。请直接填写路径；没有修改执行策略或系统设置。'+diagnostic));
      const selected=output.replace(/^\uFEFF/,'').trim();resolve({cancelled:!selected,path:selected});
    });
  });
  return validatePickedPath(field,selected);
}
