import fs from 'node:fs';
import {runTextLoop} from '../src/loop.mjs';
import {BridgeStore} from '../src/store.mjs';
import {fileURLToPath} from 'node:url';
if(!process.argv.includes('--live'))throw new Error('Explicit --live required; this sends messages in dedicated test conversations');
const goalIndex=process.argv.indexOf('--goal-file');
const resumeIndex=process.argv.indexOf('--resume-run');const resumeRunId=resumeIndex>=0?process.argv[resumeIndex+1]:null;
let goal=goalIndex>=0?fs.readFileSync(process.argv[goalIndex+1],'utf8'):'请完成三轮协作验收：第一轮让执行者求 17、26、39 的和；第二轮用 rework 指令要求改为计算这三个数各自的平方和；第三轮让执行者用另一种方法核对平方和。三轮结果到达后，汇总两种和并 done。每轮派工必须等待实际回报，不要合并轮次。';
if(resumeRunId){const s=new BridgeStore(fileURLToPath(new URL('../data/bridge.sqlite',import.meta.url)));try{const run=s.get(resumeRunId);if(run.state!=='paused'||s.messages(run.id).some(m=>!['delivered','prepared'].includes(m.state)))throw Error('Only verified paused tasks can resume');goal=run.goal;const pauseFile=new URL('../data/pause-request.json',import.meta.url);fs.writeFileSync(pauseFile,JSON.stringify({runId:null,resumedRunId:run.id}));}finally{s.close();}}
const labels={prepared:'开始任务',waiting_gpt:'等待 GPT 检查并给出下一步',waiting_workbuddy:'等待 WorkBuddy 执行',paused:'已暂停，结果保留，可继续',done:'任务完成'};
const result=await runTextLoop(goal,{resumeRunId,onProgress:p=>console.log(`${labels[p.state]??p.state}（轮次 ${p.step??0}）`)});
fs.writeFileSync(new URL('../data/latest-result.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
console.log(result.summary??result.question??result.state);
console.log('聊天记录：'+result.gptUrl+'\n任务记录：'+result.id);
