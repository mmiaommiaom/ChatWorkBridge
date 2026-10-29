import {connectGpt,readTurns,commandText} from './chatgpt-web.mjs';
import {targetId} from './gpt-tab.mjs';
import {collect,download} from './attachments.mjs';
export async function recoverGptHistory(run,store,{connect=connectGpt}={}){
 const m=store.messages(run.id).find(m=>m.direction==='gpt'&&m.state==='uncertain');
 if(!m)throw Error('No uncertain GPT message');
 const {browser}=await connect();
 try{
  let page;for(const p of browser.contexts()[0].pages())if(await targetId(p)===run.gptTargetId)page=p;
  if(!page||page.url()!==run.gptUrl)return {verified:false,message:'原 GPT 标签页或聊天地址不匹配，未恢复，也未重发。'};
  const turns=await readTurns(page),knownUsers=new Set(store.messages(run.id).filter(v=>v.direction==='gpt'&&v.state==='delivered').map(v=>v.result.userMessageId));
  const users=turns.filter(t=>t.role==='user'&&!knownUsers.has(t.id)&&t.text.trim()===m.payload.text.trim());
  if(!users.length&&String(m.result?.error??'').startsWith('GPT artifact upload unconfirmed;')){
   const known=new Set(store.messages(run.id).filter(v=>v.direction==='gpt'&&v.state==='delivered').flatMap(v=>[v.result.id,v.result.userMessageId]));
   const composer=page.locator('#prompt-textarea:visible,textarea#mobile-composer-prompt:visible,[contenteditable=true][role=textbox]:visible');
   const draft=await composer.innerText(),remaining=await page.locator('form button[aria-label^="移除 "],form button[aria-label^="Remove "]').count();
   if(turns.every(t=>known.has(t.id))&&!draft.trim()&&!remaining){
    store.transaction(()=>{store.db.prepare("UPDATE messages SET state='prepared',result=NULL WHERE id=? AND state='uncertain'").run(m.id);store.event(run.id,'gpt_unsent_upload_verified',{messageId:m.id,reason:'Upload failed before submit; unchanged remote IDs and empty composer verified'});});
    store.update(run.id,'paused',{error:null,question:null});return {verified:true,message:'已核对上传在提交前停止，原消息未发送。可继续，已完成文件操作不会重做。'};
   }
   return {verified:false,message:'上传曾在提交前停止。请到原 GPT 聊天核对并移除未发送的产物附件，然后再次检查；不会重做 WorkBuddy 任务。'};
  }
  if(users.length!==1)return {verified:false,message:'GPT 历史无法唯一匹配原消息，需人工核对，未重发。'};
  const user=users[0],after=turns.slice(turns.indexOf(user)+1);
  if(after.some(t=>t.role==='user'))return {verified:false,message:'原消息之后出现其他用户输入，请人工核对上下文。'};
  const answer=after.filter(t=>t.role==='assistant').at(-1);
  if(!answer?.hasCopy||!answer.text)return {verified:false,message:'原 GPT 回复尚未完整结束，继续等待；不会重复发送。'};
  const attachments=await download(page,await collect(page,{messageId:answer.id}),{runId:run.id});
  const result={...answer,url:run.gptUrl,userMessageId:user.id,commandText:commandText(answer),attachments};
  store.reconcileDelivered(m.id,result,{kind:'gpt_history',requestId:m.id,userMessageId:user.id,responseId:answer.id,targetId:run.gptTargetId});
  if(run.cursor!==undefined)store.update(run.id,'paused',{error:null,question:null});
  return {verified:true,message:run.cursor!==undefined?'已从同一 GPT 聊天核对原消息及完整回复，可继续；没有重发。':'已找到旧 GPT 回复，旧任务仍需人工核对，不自动重做。'};
 }finally{await browser.close();}
}
