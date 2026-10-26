import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {connectGpt} from './chatgpt-web.mjs';import {targetId} from './gpt-tab.mjs';
const root=new URL('..',import.meta.url);const cfg=()=>JSON.parse(fs.readFileSync(process.env.WB_BRIDGE_CAPABILITY_CONFIG??new URL('data/capability-tools.json',root)));
const hash=x=>createHash('sha256').update(x).digest('hex');
export function safeFile(name){
 const c=cfg();if(!['note.txt','input.json'].includes(name))throw Error('PATH_DENIED');
 if(fs.realpathSync(c.workspace)!==c.workspace)throw Error('WORKSPACE_LINK_DENIED');
 const file=path.join(c.workspace,name);if(fs.existsSync(file)&&(fs.lstatSync(file).isSymbolicLink()||fs.realpathSync(file)!==file))throw Error('FILE_LINK_DENIED');return file;
}
export async function performCapability(name,args){
 const c=cfg();
 if(name==='read_file')return {text:fs.readFileSync(safeFile(args.path),'utf8')};
 if(name==='write_file'){
  if(typeof args.content!=='string'||args.content.length>4096)throw Error('CONTENT_LIMIT');
  const file=safeFile(args.path);fs.writeFileSync(file,args.content);return {path:file,bytes:fs.statSync(file).size,sha256:hash(fs.readFileSync(file))};
 }
 if(name==='run_command'){
  if(args.command!=='node_version')throw Error('COMMAND_DENIED');
  const node=process.execPath;
  const result=await promisify(execFile)(node,['--version'],{cwd:c.workspace,windowsHide:true,timeout:5000,maxBuffer:8192,env:{...process.env,TEMP:c.workspace,TMP:c.workspace}});
  return {command:node+' --version',stdout:result.stdout,stderr:result.stderr,exitCode:0};
 }
 if(name==='browser_action'){
  if(!['read','fill','click'].includes(args.action))throw Error('UI_ACTION_DENIED');
  const {browser}=await connectGpt();try{
   let page;for(const p of browser.contexts()[0].pages())if(await targetId(p)===c.browserTargetId)page=p;
   if(!page||page.url()!==c.browserUrl)throw Error('UI_TARGET_CHANGED');
   if(args.action==='fill'){if(typeof args.text!=='string'||args.text.length>200)throw Error('UI_TEXT_LIMIT');await page.locator('#entry').fill(args.text);}
   if(args.action==='click')await page.locator('#apply').click();
   return {input:await page.locator('#entry').inputValue(),result:await page.locator('#result').innerText(),clicks:await page.locator('#count').innerText()};
  }finally{await browser.close();}
 }
 throw Error('TOOL_DENIED');
}
export async function auditedCapability(name,args){
 const c=cfg();const log=new URL('data/capability-tool-log.jsonl',root);const started=Date.now();
 try{const result=await performCapability(name,args);fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),name,args,result,ok:true,ms:Date.now()-started})+'\n');return result;}
 catch(e){fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),name,args,ok:false,error:e.message})+'\n');throw e;}
}
