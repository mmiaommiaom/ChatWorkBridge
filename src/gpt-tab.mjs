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
export async function prepareGptTab(context,runs){
  const tabs=await Promise.all(context.pages().map(async page=>({page,id:await targetId(page)})));
  const binding=fs.existsSync(bindingFile)?JSON.parse(fs.readFileSync(bindingFile,'utf8')):null;
  let selected=binding?tabs.find(t=>t.id===binding.targetId):null;
  if(selected&&selected.page.url()!==binding.url)throw Error('Bridge tab was navigated manually; refusing overwrite');
  if(!selected){
    for(const run of runs.filter(r=>['done','failed','cancelled'].includes(r.state))){
      selected=tabs.find(t=>(t.id===run.gptTargetId||t.page.url()===run.gptUrl)&&t.page.url()===run.gptUrl);
      if(selected)break;
    }
  }
  if(!selected){
    const blanks=tabs.filter(t=>t.page.url()==='https://chatgpt.com/');
    if(blanks.length===1&&(await readTurns(blanks[0].page)).length===0)selected=blanks[0];
  }
  const page=selected?.page??await context.newPage();
  if(selected)await assertTabIdle(page);
  // A new task starts a fresh conversation in the same owned tab.
  // All rounds within that task continue using this page without navigation.
  await page.goto('https://chatgpt.com/',{waitUntil:'domcontentloaded',timeout:45000});
  await rememberGptTab(page);
  return page;
}
