import fs from 'node:fs';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {BridgeStore} from '../src/store.mjs';
import {commandText} from '../src/chatgpt-web.mjs';
import {parseCommand} from '../src/protocol.mjs';
const s=new BridgeStore(fileURLToPath(new URL('../data/bridge.sqlite',import.meta.url)));
try{
  const run=s.get(process.argv[2]);assert.equal(run.state,'done');assert.equal(run.workerRounds,3);
  const messages=s.messages(run.id);assert.equal(messages.length,7);assert.ok(messages.every(m=>m.state==='delivered'));
  const events=s.db.prepare('SELECT * FROM events WHERE run_id=? ORDER BY seq').all(run.id);
  assert.equal(events.filter(e=>e.kind==='send_started').length,7);
  assert.ok(!events.some(e=>/uncertain|reconciled|interrupted|resume_after/.test(e.kind)));
  const commands=[];let previous=null;
  for(let step=0;step<=3;step++){
    const g=messages.find(m=>m.direction==='gpt'&&m.step===step);const c=parseCommand(commandText(g.result),{runId:run.id,replyToResultId:previous});commands.push(c);
    if(step<3){const w=messages.find(m=>m.direction==='workbuddy'&&m.step===step);assert.equal(w.result.model,'deepseek-v4.1-flash');assert.equal(w.result.toolCallCount,0);assert.equal(w.result.streamAgrees,true);previous=w.id;}
  }
  assert.equal(commands[1].action,'rework');assert.equal(commands[3].action,'done');
  const workers=messages.filter(m=>m.direction==='workbuddy');assert.match(workers[0].result.text,/\b82\b/);assert.match(workers[1].result.text,/\b2486\b/);assert.match(workers[2].result.text,/\b2486\b/);
  const timings=messages.map(m=>{const a=events.find(e=>e.kind==='send_started'&&JSON.parse(e.data).messageId===m.id);const b=events.find(e=>e.kind==='delivered'&&JSON.parse(e.data).messageId===m.id);return {step:m.step,direction:m.direction,milliseconds:Date.parse(b.at)-Date.parse(a.at)};});
  const result={verifiedAt:new Date().toISOString(),runId:run.id,conversation:run.gptUrl,passed:true,uninterrupted:true,workerRounds:3,gptExchanges:4,totalMilliseconds:Date.parse(run.finishedAt)-Date.parse(run.createdAt),timings,workerModel:'deepseek-v4.1-flash',gptExactModel:'unknown; current logged-in chat selection',price:'unknown',remainingQuota:'unknown',expected:{sum:17+26+39,sumOfSquares:17**2+26**2+39**2},limitations:['Text-only task contract and post-execution tool-event verification; not OS isolation','One clean live run does not establish long-term reliability']};
  fs.writeFileSync(new URL('../data/text-loop-verification.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
  fs.writeFileSync(new URL('../data/latest-result.json',import.meta.url),JSON.stringify(run,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}finally{s.close();}
