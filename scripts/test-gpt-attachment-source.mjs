import fs from 'node:fs';import {randomUUID} from 'node:crypto';import {connectGpt,sendGpt,readTurns} from '../src/chatgpt-web.mjs';import {targetId,rememberGptTab} from '../src/gpt-tab.mjs';import {collect} from '../src/attachments.mjs';
if(!process.argv.includes('--live'))throw Error('Manual live probe: add --live to upload the newly generated local TXT/PNG fixtures and send a GPT message.');
const probeRoot=fs.realpathSync(new URL('..',import.meta.url));if(!/^E:[\\/]/i.test(probeRoot))throw Error('Probe checkout must be on E drive');process.chdir(probeRoot);fs.mkdirSync('data',{recursive:true});
if(!fs.existsSync('data/native-attachments-probe.json'))throw Error('Run test-native-attachments.mjs --live first in this checkout; no historical fixture files are bundled.');
const journal='data/gpt-attachment-transfer-probe.json';if(fs.existsSync(journal))throw Error('Existing attempt; do not upload or send again');
const fixture=JSON.parse(fs.readFileSync('data/native-attachments-probe.json'));const {browser}=await connectGpt();
const report={id:'attachment-'+randomUUID(),stage:'prepared',startedAt:new Date().toISOString()};const save=()=>fs.writeFileSync(journal,JSON.stringify(report,null,2));save();
try{
 const page=browser.contexts()[0].pages().find(p=>p.url()==='https://chatgpt.com/');if(!page)throw Error('Owned blank GPT tab missing');report.targetId=await targetId(page);save();
 await page.locator('input[type=file][aria-label="附加文件"]').setInputFiles([fixture.image,fixture.file]);await page.waitForTimeout(5000);
 report.stage='sending';save();
 const response=await sendGpt(page,'这是附件传递测试。请根据本轮两份附件，为另一位执行者写一条简短任务指令：让他读取文本文件的 Reference code，以及图片上的 Code 和红色、蓝色圆的数量。你只写任务指令，不要自己公布图片或文本文件的校验码，也不要调用工具、改写附件或创建新图。');
 report.response=response;report.stage='gpt_replied';save();await rememberGptTab(page);
 const turns=await readTurns(page);const user=turns.find(t=>t.id===response.userMessageId);report.userMessageId=user.id;
 report.sourceCandidates=await collect(page,{messageId:user.id,role:'user'});
 report.assistantCandidates=await collect(page,{messageId:response.id,role:'assistant'});save();
 console.log(JSON.stringify({stage:report.stage,candidateCount:report.sourceCandidates.length,attachmentKinds:report.sourceCandidates.map(c=>c.kind)}));
}catch(e){report.error=e.message;report.stage='uncertain';save();throw e;}finally{await browser.close();}
