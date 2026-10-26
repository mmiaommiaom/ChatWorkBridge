import {assertControlledPath} from '../src/local-config.mjs';
import fs from 'node:fs';import assert from 'node:assert/strict';import {connectGpt} from '../src/chatgpt-web.mjs';import {BridgeStore} from '../src/store.mjs';import {fileURLToPath} from 'node:url';
import {loadConfig} from '../src/local-config.mjs';
if(!process.argv.includes('--live'))throw Error('Manual live probe: add --live to send a new GPT/WorkBuddy task and test dashboard pause/resume.');
const probeRoot=assertControlledPath(fs.realpathSync(new URL('..',import.meta.url)));process.chdir(probeRoot);fs.mkdirSync('data',{recursive:true});
const evidence=new URL('../data/dashboard-recovery-verification.json',import.meta.url);if(fs.existsSync(evidence))throw Error('Existing live verification; do not replay');
const {browser}=await connectGpt();const s=new BridgeStore(fileURLToPath(new URL('../data/bridge.sqlite',import.meta.url)));
try{
 const dashboardUrl='http://127.0.0.1:'+loadConfig().ports.dashboard+'/';
 const page=browser.contexts()[0].pages().find(p=>p.url()===dashboardUrl);assert.ok(page);
 await page.bringToFront();
 assert.equal(await page.locator('h1').innerText(),'GPT × WorkBuddy 协作台');
 const denied=await page.evaluate(async()=>{const r=await fetch('/api/start',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"goal":"must not run"}'});return r.status;});assert.equal(denied,403);
 const before=new Set(s.list().map(r=>r.id));const goal='暂停恢复验收：只派工一轮，让 WorkBuddy 计算 19+23；收到实际结果并核对为 42 后立即 done。只做文字推理，不调用工具。';
 let run;
 if(process.argv.includes('--resume-paused')){run=s.list().find(r=>r.state==='paused'&&r.goal===goal);assert.ok(run);}
 else{
 await page.locator('#goal').fill(goal);await page.locator('#start').click();
 for(let i=0;i<100;i++){run=s.list().find(r=>!before.has(r.id));if(run?.state==='waiting_gpt')break;await page.waitForTimeout(200);}assert.equal(run?.state,'waiting_gpt');
 await page.bringToFront();await page.locator('#pause').click();
 for(let i=0;i<200;i++){run=s.get(run.id);if(['paused','failed','uncertain'].includes(run.state))break;await page.waitForTimeout(300);}assert.equal(run.state,'paused');
 }
 const pausedMessages=s.messages(run.id);assert.equal(pausedMessages.length,1);assert.equal(pausedMessages[0].state,'delivered');
 await page.bringToFront();await page.getByRole('button',{name:'继续此任务',exact:true}).evaluate(el=>el.click());
 for(let i=0;i<300;i++){run=s.get(run.id);if(['done','failed','uncertain'].includes(run.state))break;await page.waitForTimeout(300);}assert.equal(run.state,'done');
 const messages=s.messages(run.id);assert.equal(messages.length,3);assert.ok(messages.every(m=>m.state==='delivered'));assert.equal(messages.filter(m=>m.direction==='workbuddy').length,1);assert.match(messages.find(m=>m.direction==='workbuddy').result.text,/42/);
 const starts=s.db.prepare("SELECT data FROM events WHERE run_id=? AND kind='send_started'").all(run.id);assert.equal(starts.length,3);
 const gptCount=browser.contexts()[0].pages().filter(p=>p.url().startsWith('https://chatgpt.com/')).length;assert.equal(gptCount,1);
 await page.waitForTimeout(2500);await page.screenshot({path:fileURLToPath(new URL('../data/dashboard-verified.png',import.meta.url)),fullPage:true});
 const result={verifiedAt:new Date().toISOString(),runId:run.id,passed:true,uiStart:true,uiPause:true,uiResume:true,missingTokenBlocked:denied,pausedAfterOneGptReply:true,finalOutboundMessages:messages.length,sendAttempts:starts.length,workbuddyExecutions:1,duplicateSends:0,gptTabs:gptCount};fs.writeFileSync(evidence,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{s.close();await browser.close();}
