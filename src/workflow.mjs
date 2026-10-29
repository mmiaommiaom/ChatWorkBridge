import {parseCommand,verifyDone,coordinatorPrompt} from './protocol.mjs';
import {hash} from './store.mjs';
import {nativeBlocks} from './attachments.mjs';
import {commandText} from './chatgpt-web.mjs';
export function verifiedCoordinatorAttachments(response){
 if(response?.attachmentError)throw Error('Coordinator attachment transfer failed; 图片/附件传输失败，停止派工：'+response.attachmentError);
 if(!Array.isArray(response?.attachments))throw Error('Coordinator attachment manifest is missing');
 return response.attachments;
}
const envelope=(run,kind,data)=>JSON.stringify({kind,runId:run.id,resultId:run.replyToResultId??null,workerWorkspace:run.workerWorkspace,contract:{version:run.acceptanceVersion,criteria:run.acceptance?.map((text,i)=>({id:'A'+(i+1),text}))},...data})+'\n请按 bridge-command 协议决定下一步。所有输出保存在 workerWorkspace，不要自行另建其他输出目录；参考文件可以只读使用。';
/** Durable engine. All external actions are injected so crash windows can be tested. */
export async function driveRun({store,runId,coordinator,checkCapabilities,worker,artifacts=()=>[],pauseRequested=()=>false,onProgress=()=>{}}){
 const read=()=>store.get(runId);
 const wait=(patch)=>{store.update(runId,'needs_user',patch);onProgress({runId,state:'needs_user'});return read();};
 for(;;){
  let run=read(),step=run.cursor??0;
  if(pauseRequested()){store.update(runId,'paused',{pausedAt:new Date().toISOString()});return read();}
  const queued=store.pendingInteractions(runId);
  let g=store.messageAt(runId,step,'gpt');
  if(!g){
   const firstPrompt=coordinatorPrompt({runId,goal:run.goal,mode:run.runtimeMode});
   const continuation=(run.stage??1)>1?'\n这是同一个保存工作的新阶段 '+run.stage+'，用户已明确提交本阶段新目标；此前阶段的验收记录保留。本阶段重新 plan 并制定标准，不要重做此前已完成内容。沿用原 WorkBuddy 会话和工作目录 '+run.workerWorkspace+'。本阶段首条及后续 replyToResultId 必须填写 '+JSON.stringify(run.replyToResultId??null)+'，替代模板首轮 null；commandId 请以 stage'+run.stage+'- 开头，禁止复用历史 ID。此前摘要：'+JSON.stringify(run.completedStages?.at(-1)?.summary??''):'';
   const text=(run.nextOutgoing??firstPrompt+continuation)+(queued.length?'\n用户补充（保持原验收范围；变更必须明确批准）：\n'+JSON.stringify(queued.map(({id,text,kind})=>({id,text,kind}))):'');
   g=store.prepare(runId,step,'gpt',{text,attachments:run.nextAttachments??[],interactionIds:queued.map(i=>i.id)});
  }
  if(!['prepared','delivered'].includes(g.state))throw Error('GPT delivery uncertain; reconcile before resuming');
  let response=g.result;
  if(!response){
   store.update(runId,'waiting_gpt',{step,question:null,error:null});onProgress({runId,state:'waiting_gpt',step});store.markSending(g.id);
   try{response=await coordinator(g.payload,g);store.delivered(g.id,response);if(response.url)store.update(runId,'waiting_gpt',{gptUrl:response.url,gptUserMessageId:response.userMessageId});}
   catch(e){if(store.message(g.id).state==='sending'){if(e.noSubmit===true)store.notSubmitted(g.id,e.message);else store.uncertain(g.id,e.message);}throw e;}
  }
  const attachments=verifiedCoordinatorAttachments(response);
  let command;
  try{command=parseCommand(response.codes?.length?commandText(response):response.commandText??response.text,{runId,replyToResultId:run.replyToResultId??null});}
  catch(e){
   const count=(run.protocolErrors??0)+1;
   store.update(runId,'prepared',{cursor:step+1,protocolErrors:count,nextOutgoing:envelope(read(),'coordinator_format_error',{error:e.message,instruction:'纠正上一条回复为唯一 bridge-command 块，使用正确会话标识；不要重复已完成的执行。'}),nextAttachments:[]});
   if(count>=3)return wait({waitReason:'protocol',question:'GPT 连续未提供可读取的指令，请查看原聊天后继续。'});
   continue;
  }
  const prior=(run.commands??[]).find(c=>c.id===command.commandId);
  if(prior&&prior.step!==step)throw Error('Repeated GPT command ID');
  if(!prior){store.update(runId,read().state,{commands:[...(run.commands??[]),{id:command.commandId,step}]});store.notice(runId,'gpt',command.summary??command.instruction??'GPT 已制定验收与能力要求');}
  run=read();
  const advance=(kind,data,patch={})=>store.update(runId,'prepared',{cursor:step+1,protocolErrors:0,nextOutgoing:envelope(read(),kind,data),nextAttachments:[],...patch});
  if(command.action==='revise_acceptance'){
   const proposal={id:command.commandId,acceptance:command.acceptance,summary:command.summary??'GPT 请求修改标准'};
   advance('acceptance_change_pending',{proposal});return wait({acceptanceProposal:proposal,waitReason:'acceptance',question:'请审核验收标准变更；只有明确批准后才应用。'});
  }
  if(command.action==='ask_user'){
   advance('user_input_requested',{question:command.summary??command.instruction});return wait({waitReason:'question',question:command.summary??command.instruction??'请补充信息'});
  }
  if(command.action==='plan'){
   if(run.acceptance?.length&&JSON.stringify(command.acceptance)!==JSON.stringify(run.acceptance))throw Error('Frozen acceptance cannot change without explicit approval');
   const requiredImages=Math.max(run.requiredImages??0,command.requiredImages??0);
   const references=attachments.length?attachments:run.references??[];
   store.update(runId,'prepared',{acceptance:run.acceptance??command.acceptance,acceptanceVersion:run.acceptanceVersion??1,requirements:command.requirements,requiredImages,references});run=read();
   const report=await checkCapabilities(run);store.update(runId,'prepared',{capabilityReport:report});
   advance('capability_report',{report,acceptance:run.acceptance,referenceFiles:references});
   if(report.invalidRequirements&&(run.capabilityPlanErrors??0)<2){store.update(runId,'prepared',{capabilityPlanErrors:(run.capabilityPlanErrors??0)+1,nextOutgoing:envelope(read(),'capability_requirements_invalid',{report,instruction:'连接器实际清单已提供。修正 plan 的 requirements：name 使用实际名称，tools 仅填写清单中的真实工具名，未知时填空数组；保留全部冻结验收标准。不要让用户重新启用已就绪的连接器。'})});continue;}
   if(!report.ready)return wait({waitReason:'capability',question:'请按下面步骤处理必需能力，再点击“已完成，重新检查”。'});
   continue;
  }
  if(!run.acceptance?.length)return wait({waitReason:'plan',question:'GPT 未先制定验收和能力要求，已阻止派工。'});
  // Per-step criteria are explanatory data. They never replace the frozen
  // contract; completion still requires every original criterion to pass.
  if(command.action==='done'){
   try{verifyDone(command,run);}catch(e){
    const count=(run.protocolErrors??0)+1;
    advance('completion_evidence_required',{error:e.message,expectedChecks:run.acceptance.map((text,i)=>({id:'A'+(i+1),criterion:text,passed:'boolean',evidence:'实际证据字符串'})),instruction:'已完成的 WorkBuddy 工作不要重做。请仅核对原有证据后用 checks 数组逐项回答；证据不足时 ask_user，不得虚构通过。'},{protocolErrors:count});
    if(count>=3)return wait({waitReason:'protocol',question:'GPT 尚未提供完整逐项验收记录，请查看原聊天后继续。'});
    continue;
   }
   if(store.pendingInteractions(runId).length){advance('pending_user_messages',{message:'用户有新补充，请先审阅再决定是否结束'});continue;}
   store.update(runId,'done',{summary:command.summary??'',checks:command.checks,finishedAt:new Date().toISOString()});onProgress({runId,state:'done',step});return read();
  }
  const report=await checkCapabilities(run);store.update(runId,'prepared',{capabilityReport:report});
  if(!report.ready){advance('capability_report',{report});return wait({waitReason:'capability',question:'执行前发现必需能力缺失，已停止派工。'});}
  const references=attachments.length?attachments:run.references??[];
  if(pauseRequested()){store.update(runId,'paused',{pausedAt:new Date().toISOString()});return read();}
  if(references.filter(a=>a.kind==='image').length<Math.max(run.requiredImages??0,command.requiredImages??0)){
   advance('missing_reference',{message:'必要参考图缺失，禁止按文字替代；请提供实际图片后重新规划。'});return wait({waitReason:'image',question:'必要参考图未传输，已阻止执行。请回复 GPT 补充图片。'});
  }
  nativeBlocks(references); // revalidate bytes/hash immediately before every dispatch
  const signature=hash(command.instruction),repeated=signature===run.lastInstruction?(run.sameInstructionCount??0)+1:1;
  if(repeated>3){advance('no_progress',{message:'同一指令反复出现，需要用户检查'});return wait({waitReason:'no_progress',question:'连续相同派工未推进，已暂停。请检查结果或调整后续指令。'});}
  let w=store.messageAt(runId,step,'workbuddy')??store.prepare(runId,step,'workbuddy',{command,attachments:references});
  if(!['prepared','delivered'].includes(w.state))throw Error('Worker delivery uncertain; reconcile before resuming');
  let result=w.result;
  if(!result){
   store.update(runId,'waiting_workbuddy',{step,commandId:command.commandId,question:null});onProgress({runId,state:'waiting_workbuddy',step});store.markSending(w.id);
   try{result=await worker(w.payload,w);store.delivered(w.id,result);}catch(e){if(store.message(w.id).state==='sending')store.uncertain(w.id,e.message);throw e;}
  }
  let files=[],artifactError=null;try{files=await artifacts(result,read());}catch(e){artifactError=e.message;}
  const workerRounds=(run.workerRounds??0)+1;
  advance('workbuddy_result',{resultId:w.id,commandId:command.commandId,status:'completed',evidence:{model:result.model,requestId:result.requestId,toolCallCount:result.toolCallCount,modelEvidence:result.modelEvidence},text:result.text,artifacts:files,artifactError},{replyToResultId:w.id,workerRounds,lastInstruction:signature,sameInstructionCount:repeated,lastArtifacts:files,nextAttachments:files.filter(a=>a.uploadable!==false),references});
  if(artifactError)return wait({waitReason:'artifact',question:'产物核验失败，先检查文件：'+artifactError});
 }
}
