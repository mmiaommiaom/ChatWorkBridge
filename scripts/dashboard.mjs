import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {BridgeStore} from '../src/store.mjs';import {connectGpt} from '../src/chatgpt-web.mjs';
import {runtimeMode} from '../src/workbuddy-desktop.mjs';
import {loadConfig} from '../src/local-config.mjs';
const config=loadConfig();
const root=fileURLToPath(new URL('..',import.meta.url)),port=config.ports.dashboard,origin=`http://127.0.0.1:${port}`,token=randomUUID();
const store=new BridgeStore(path.join(root,'data/bridge.sqlite'));let child=null,output='',job=null;
const persist=()=>fs.writeFileSync(path.join(root,'data/dashboard-job.json'),JSON.stringify(job,null,2));
function launch(args){
 if(child)throw Error('当前任务仍在运行');
 output='';job={id:randomUUID(),startedAt:new Date().toISOString(),state:'running'};
 child=spawn(process.execPath,[path.join(root,'scripts/run-text-loop.mjs'),'--live',...args],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});job.pid=child.pid;persist();
 const add=b=>{output=(output+b.toString()).slice(-16000);};child.stdout.on('data',add);child.stderr.on('data',add);
 child.once('error',e=>{add(e.message);job.state='failed';persist();child=null;});
 child.once('exit',code=>{job.state=code===0?'finished':'failed';job.exitCode=code;job.finishedAt=new Date().toISOString();persist();child=null;});return job;
}
const server=http.createServer(async(req,res)=>{
 const send=(status,value,type='application/json')=>{res.writeHead(status,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});res.end(type==='application/json'?JSON.stringify(value):value);};
 if(req.headers.host!==`127.0.0.1:${port}`)return send(403,{error:'主机不允许'});
 const url=new URL(req.url,origin);
 try{
  if(req.method==='GET'&&url.pathname==='/')return send(200,fs.readFileSync(path.join(root,'ui/dashboard.html'),'utf8').replaceAll('__TOKEN__',token),'text/html');
  if(req.method==='GET'&&url.pathname==='/api/status')return send(200,{job,output,runtime:runtimeMode(),normalAuthorized:config.allowNormalProfile,runs:store.list().map(({id,state,goal,summary,step,gptUrl,error})=>({id,state,goal,summary,step,gptUrl,error})),models:fs.existsSync(path.join(root,'data/model-state.json'))?JSON.parse(fs.readFileSync(path.join(root,'data/model-state.json'))):{}});
  if(req.method!=='POST')return send(404,{error:'未找到'});
  if(req.headers.origin!==origin||req.headers['x-bridge-token']!==token)return send(403,{error:'请求未授权'});
  let body='';for await(const chunk of req){body+=chunk;if(body.length>20000)return send(413,{error:'任务过长'});}const data=JSON.parse(body||'{}');
  if(url.pathname==='/api/start'){
   if(typeof data.goal!=='string'||!data.goal.trim()||data.goal.length>12000)return send(400,{error:'请输入 1～12000 字的文字任务'});
   if(child||store.list().some(r=>!['done','failed','cancelled'].includes(r.state)))return send(409,{error:'请先处理当前未完成的任务'});
   const file=path.join(root,'data','goal-'+randomUUID()+'.txt');fs.writeFileSync(file,data.goal);return send(202,launch(['--goal-file',file]));
  }
  if(url.pathname==='/api/pause'){
   const r=store.list().find(r=>['prepared','waiting_gpt','waiting_workbuddy'].includes(r.state));if(!r)return send(409,{error:'当前没有可暂停的任务'});
   fs.writeFileSync(path.join(root,'data/pause-request.json'),JSON.stringify({runId:r.id,requestedAt:new Date().toISOString()}));return send(200,{message:'已请求暂停；当前一次回复结束后停止派工'});
  }
  if(url.pathname==='/api/resume'){
   const r=store.list().find(r=>r.id===data.runId);if(!r||r.state!=='paused'||store.messages(r.id).some(m=>!['delivered','prepared'].includes(m.state)))return send(409,{error:'结果不确定的任务需要核验，不能自动重发'});
   return send(202,launch(['--resume-run',r.id]));
  }
  return send(404,{error:'未找到'});
 }catch(e){send(400,{error:e.message});}
});
server.on('error',e=>{console.error(e.message);store.close();process.exitCode=1;});
server.listen(port,'127.0.0.1',async()=>{
 fs.writeFileSync(path.join(root,'data/dashboard-launch.json'),JSON.stringify({pid:process.pid,origin,startedAt:new Date().toISOString()}));console.log('操作界面：'+origin+'，请保持此窗口打开。');
 try{const {browser}=await connectGpt();try{const context=browser.contexts()[0];const page=context.pages().find(p=>p.url()===origin+'/')??await context.newPage();await page.goto(origin);await page.bringToFront();}finally{await browser.close();}}catch(e){console.log('浏览器未连接，请手动打开上方地址。');}
});
