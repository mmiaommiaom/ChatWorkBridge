import fs from 'node:fs';
import {browserStatus,readTurns} from './chatgpt-web.mjs';
const bindingFile=new URL('../data/gpt-tab.json',import.meta.url);
export async function targetId(page){
  const cdp=await page.context().newCDPSession(page);
  try{return (await cdp.send('Target.getTargetInfo')).targetInfo.targetId;}finally{await cdp.detach();}
}
export async function rememberGptTab(page){
  const binding={targetId:await targetId(page),url:page.url(),updatedAt:new Date().toISOString()};
  fs.writeFileSync(bindingFile,JSON.stringify(binding,null,2)+'\n');return binding;
}
export async function assertTabIdle(page){
  const status=await browserStatus(page);
  if(status.loginRequired||status.composerCount!==1)throw Error('GPT tab not ready');
  const draft=await page.locator('#prompt-textarea:visible,textarea#mobile-composer-prompt:visible,[contenteditable=true][role=textbox]:visible').evaluate(el=>'value' in el?el.value:el.innerText);
  if(draft.replace(/[\s\u200b\ufeff]/g,''))throw Error('Existing draft; tab retained');
  if(await page.getByRole('button',{name:/^(停止|停止生成|Stop|Stop generating)$/i}).count())throw Error('GPT generating; tab retained');
  const turns=await readTurns(page);
  if(turns.length&&(turns.at(-1).role!=='assistant'||!turns.at(-1).hasCopy))throw Error('GPT turn incomplete; tab retained');
}
// Browser target IDs are ephemeral. Rebind only after verifying the saved
// conversation's latest delivered user/assistant pair; never resend here.
export async function resolveRunTab(context,run,messages,{idOf=targetId,read=readTurns,idle=assertTabIdle}={}){
  const last=messages.filter(m=>m.direction==='gpt'&&m.state==='delivered').at(-1)?.result;
  const expected=last?.url??run.gptUrl;
  if(!/^https:\/\/chatgpt\.com\/c\/[\w-]+$/.test(expected??'')||!last?.id||!last?.userMessageId)throw Error('原聊天缺少可核验的消息记录，请先检查中断状态。');
  const matches=context.pages().filter(p=>p.url()===expected);
  let page;
  for(const p of matches)if(await idOf(p)===run.gptTargetId)page=p;
  if(!page&&matches.length>1)throw Error('同一聊天打开了多个标签，请只保留一个后继续。');
  page??=matches[0];
  if(!page){page=await context.newPage();await page.goto(expected,{waitUntil:'domcontentloaded',timeout:45000});}
  await page.bringToFront?.();
  if(page.waitForFunction)await page.waitForFunction(ids=>{
    const visible=[...document.querySelectorAll('[data-chatgpt-search-message-ids],[data-message-id]')].flatMap(e=>(e.getAttribute('data-chatgpt-search-message-ids')??e.getAttribute('data-message-id')??'').split(' '));
    return ids.every(id=>visible.includes(id));
  },[last.userMessageId,last.id],{timeout:45000});
  if(page.url()!==expected)throw Error('原聊天地址发生变化，已停止恢复。');
  const turns=await read(page),user=turns.findIndex(t=>t.id===last.userMessageId&&t.role==='user');
  if(user<0||!turns.slice(user+1).some(t=>t.id===last.id&&t.role==='assistant')||turns.at(-1)?.id!==last.id)throw Error('原聊天消息与记录不一致，请核对新增消息；不会重发任务。');
  await idle(page);
  return {page,targetId:await idOf(page),url:expected,priorTargetId:run.gptTargetId};
}
export async function prepareGptTab(context,runs){
  // Every saved work owns a conversation. Never navigate an old work to /.
  const usedIds=new Set(runs.map(r=>r.gptTargetId)),usedUrls=new Set(runs.map(r=>r.gptUrl));
  const blanks=[];for(const page of context.pages())if(page.url()==='https://chatgpt.com/'&&!usedUrls.has(page.url())&&!usedIds.has(await targetId(page)))blanks.push(page);
  let page;
  if(blanks.length===1&&(await readTurns(blanks[0])).length===0){page=blanks[0];await assertTabIdle(page);}
  else{page=await context.newPage();await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:45000});}
  await rememberGptTab(page);return page;
}
