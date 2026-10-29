import {connectGpt,readTurns} from './chatgpt-web.mjs';import {targetId} from './gpt-tab.mjs';
export async function reconcileUnsentDraft(store,runId,{connect=connectGpt}={}){
 const lease=store.acquireRunner();let browser;
 try{
 const run=store.get(runId),messages=store.messages(runId),pending=messages.filter(m=>m.state==='uncertain');
 if(run.state!=='uncertain'||pending.length!==1||pending[0].direction!=='gpt')throw Error('Not an eligible uncertain GPT send');
 const m=pending[0],error=m.result?.error??'';
 if(!error.startsWith('locator.click: Timeout')||!error.includes('waiting for element to be visible, enabled and stable')||error.includes('click action done'))throw Error('Send outcome requires manual review');
 ({browser}=await connect());
  let page;for(const p of browser.contexts()[0].pages())if(await targetId(p)===run.gptTargetId)page=p;
  if(!page||page.url()!==run.gptUrl)throw Error('Bound conversation changed');
  const turns=await readTurns(page),known=messages.filter(m=>m.direction==='gpt'&&m.state==='delivered');
  const ids=new Set(known.flatMap(m=>[m.result.id,m.result.userMessageId]));
  if(turns.length!==ids.size||turns.some(t=>!ids.has(t.id)))throw Error('Additional or missing remote messages; cannot prove unsent');
  const composer=page.locator('#prompt-textarea:visible,textarea#mobile-composer-prompt:visible,[contenteditable=true][role=textbox]:visible');
  const draft=await composer.evaluate(el=>'value' in el?el.value:[...el.children].map(e=>e.textContent).join('\n'));
  if(draft!==m.payload.text)throw Error('Draft was edited or disappeared');
  if(await page.getByRole('button',{name:/^(停止|停止生成|Stop|Stop generating)$/i}).count())throw Error('GPT is still generating');
  await composer.fill('');
  store.transaction(()=>{store.db.prepare("UPDATE messages SET state='prepared',result=NULL WHERE id=? AND state='uncertain'").run(m.id);store.db.prepare("UPDATE runs SET state='paused' WHERE id=?").run(runId);store.event(runId,'reconciled_unsent_draft',{messageId:m.id,priorError:error,reason:'Exact owned draft, unchanged remote message IDs, bound target and pre-click timeout verified. No worker task replay.'});});
  return store.update(runId,'paused',{error:null,reconciledAt:new Date().toISOString()});
 }finally{try{await browser?.close();}finally{store.releaseRunner(lease);}}
}
