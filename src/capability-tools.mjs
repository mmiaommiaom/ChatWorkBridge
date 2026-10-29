import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {connectGpt} from './chatgpt-web.mjs';import {targetId} from './gpt-tab.mjs';import {assertControlledPath} from './local-config.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
function checkedPath(value){
 const resolved=assertControlledPath(value);
 let ancestor=resolved,stat;
 while(!stat){
  try{stat=fs.lstatSync(ancestor);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(stat)break;
  const parent=path.dirname(ancestor);if(parent===ancestor)throw Error('PATH_UNAVAILABLE');ancestor=parent;
 }
 if(stat.isSymbolicLink()||fs.realpathSync.native(ancestor).toLowerCase()!==ancestor.toLowerCase())throw Error('PATH_LINK_DENIED');
 return resolved;
}
function cfg(){
 const c=JSON.parse(fs.readFileSync(process.env.WB_BRIDGE_CAPABILITY_CONFIG??path.join(root,'data/capability-tools.json')));
 c.workspace=checkedPath(c.workspace);
 if(!fs.statSync(c.workspace).isDirectory())throw Error('WORKSPACE_DIRECTORY_REQUIRED');
 const allowed=[path.join(root,'workspaces/probe'),path.join(root,'runtime/test-runs')];
 if(!allowed.some(base=>{const rel=path.relative(base,c.workspace);return rel!==''&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);}))throw Error('WORKSPACE_OUTSIDE_TEST_SANDBOX');
 return c;
}
const hash=x=>createHash('sha256').update(x).digest('hex');
export function safeFile(name,c=cfg()){
 if(!['note.txt','input.json'].includes(name))throw Error('PATH_DENIED');
 const file=checkedPath(path.join(c.workspace,name));
 if(fs.existsSync(file)){const st=fs.lstatSync(file);if(!st.isFile()||st.nlink!==1)throw Error('FILE_LINK_DENIED');}
 return file;
}
export async function performCapability(name,args){
 const c=cfg();
 if(!args||typeof args!=='object'||Array.isArray(args))throw Error('ARGUMENTS_DENIED');
 if(name==='read_file'){const file=safeFile(args.path,c);if(fs.statSync(file).size>4096)throw Error('CONTENT_LIMIT');return {text:fs.readFileSync(file,'utf8')};}
 if(name==='write_file'){
  if(typeof args.content!=='string'||Buffer.byteLength(args.content,'utf8')>4096)throw Error('CONTENT_LIMIT');
  const file=safeFile(args.path,c);fs.writeFileSync(file,args.content);return {path:file,bytes:fs.statSync(file).size,sha256:hash(fs.readFileSync(file))};
 }
 if(name==='run_command'){
  if(args.command!=='node_version')throw Error('COMMAND_DENIED');
  const node=process.execPath;
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['NODE_OPTIONS','NODE_PATH'].includes(key.toUpperCase())));
  const result=await promisify(execFile)(node,['--version'],{cwd:c.workspace,windowsHide:true,timeout:5000,maxBuffer:8192,env:{...env,TEMP:c.workspace,TMP:c.workspace}});
  return {command:node+' --version',stdout:result.stdout,stderr:result.stderr,exitCode:0};
 }
 if(name==='browser_action'){
  if(!['read','fill','click'].includes(args.action))throw Error('UI_ACTION_DENIED');
  let url;try{url=new URL(c.browserUrl);}catch{throw Error('UI_TARGET_DENIED');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||typeof c.browserTargetId!=='string'||!c.browserTargetId)throw Error('UI_TARGET_DENIED');
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
 cfg();const log=checkedPath(path.join(root,'data/capability-tool-log.jsonl'));const started=Date.now();
 fs.mkdirSync(path.dirname(log),{recursive:true});
 if(fs.existsSync(log)){const st=fs.lstatSync(log);if(!st.isFile()||st.nlink!==1)throw Error('LOG_LINK_DENIED');}
 try{const result=await performCapability(name,args);fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),name,args,result,ok:true,ms:Date.now()-started})+'\n');return result;}
 catch(e){fs.appendFileSync(log,JSON.stringify({at:new Date().toISOString(),name,args,ok:false,error:e.message})+'\n');throw e;}
}
