import fs from 'node:fs';
import path from 'node:path';
import {loadConfig} from './local-config.mjs';
import {chromium} from 'playwright-core';
import {createHash} from 'node:crypto';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const digest=s=>createHash('sha256').update(s).digest('hex');
const validUrl=url=>{try{const u=new URL(url);return u.origin==='https://chatgpt.com'&&(u.pathname==='/'||/^\/c\/[\w-]+$/.test(u.pathname));}catch{return false;}};
export async function connectGpt(){
  const state=JSON.parse(fs.readFileSync(new URL('../data/gpt-browser-launch.json',import.meta.url),'utf8'));
  const config=loadConfig();
  if(state.exitedAt||!state.pid||state.port!==config.ports.gpt||path.resolve(state.profile)!==config.gptBrowserProfile)throw new Error('Unexpected browser binding');
  process.kill(state.pid,0);
  const browser=await chromium.connectOverCDP('http://127.0.0.1:'+config.ports.gpt,{noDefaults:true,timeout:15000});
  return {browser,state};
}
export async function browserStatus(page){
  if(!validUrl(page.url()))throw new Error('Not a ChatGPT conversation');
  const auth=await page.getByRole('button',{name:/^(登录|Log in)$/}).count();
  return {url:page.url(),loginRequired:auth>0,composerCount:await page.locator('#prompt-textarea:visible,textarea#mobile-composer-prompt:visible,[contenteditable=true][role=textbox]:visible').count()};
}
export async function readTurns(page){
  if(!validUrl(page.url()))throw new Error('Conversation navigation changed');
  const modern=page.locator('[data-chatgpt-search-unit-key][data-chatgpt-search-message-ids]');
  if(await modern.count())return modern.evaluateAll(elements=>elements.map(el=>{
    const role=el.getAttribute('data-chatgpt-search-unit-key').split(':').at(-1);
    const turn=el.closest('[data-talvt-turn-state]');
    const content=role==='user'?el.querySelector('[data-user-message-bubble] .whitespace-pre-wrap'):el.querySelector('[data-markdown-text-style="assistant-message"]');
    if(!content)return null;
    let text=content.innerText;
    if(role==='user'){
      const clone=content.cloneNode(true);
      for(const pre of clone.querySelectorAll('pre')){const code=pre.querySelector('code');pre.replaceWith(document.createTextNode('```'+(code?.getAttribute('data-language')??'')+'\n'+(code?.textContent??pre.textContent)+'\n```'));}
      for(const code of clone.querySelectorAll('code'))code.replaceWith(document.createTextNode('`'+code.textContent+'`'));
      text=clone.textContent;
    }
    return {role,id:el.getAttribute('data-chatgpt-search-message-ids').split(' ')[0],text,codes:[...content.querySelectorAll('pre code,[data-code-block] code')].map(e=>e.textContent),hasCopy:turn?.getAttribute('data-talvt-turn-state')==='complete'};
  }).filter(Boolean));
  return page.locator('[data-message-author-role]').evaluateAll(elements=>elements.map(el=>{
    const turn=el.closest('section[data-testid^="conversation-turn-"],article')??el;
    const role=el.getAttribute('data-message-author-role');
    const codes=[...el.querySelectorAll('pre code')].map(code=>code.innerText);
    return {role,id:el.getAttribute('data-message-id')??turn.getAttribute('data-testid')??null,text:el.innerText,codes,hasCopy:[...turn.querySelectorAll('button')].some(b=>/复制|Copy/i.test(b.getAttribute('aria-label')??b.getAttribute('data-testid')??''))};
  }));
}
export function commandText(turn){
  const candidates=(turn.codes??[]).filter(s=>{try{return JSON.parse(s).protocol==='chat-work-bridge/1';}catch{return false;}});
  if(candidates.length===1)return '```bridge-command\n'+candidates[0]+'\n```';
  return turn.text;
}
export async function sendGpt(page,text,{timeoutMs=300000,onReceipt=()=>{},existingOwnedDraft=false}={}){
  const status=await browserStatus(page);if(status.loginRequired)throw new Error('ChatGPT login required');
  if(status.composerCount!==1)throw new Error('Composer ambiguous or unavailable');
  const startingUrl=page.url();let boundUrl=startingUrl;
  const composer=page.locator('#prompt-textarea:visible,textarea#mobile-composer-prompt:visible,[contenteditable=true][role=textbox]:visible');
  const draft=await composer.evaluate(el=>'value' in el?el.value:[...el.children].map(p=>p.textContent).join('\n'));
  if(existingOwnedDraft){if(draft!==text)throw Error('Owned draft differs; refusing send');}
  else if(draft.replace(/[\s\u200b\ufeff]/g,''))throw new Error('Existing human draft; refusing overwrite');
  if(await page.getByRole('button',{name:/^(停止|停止生成|Stop|Stop generating)$/i}).count())throw new Error('ChatGPT already generating');
  const before=await readTurns(page);const oldIds=new Set(before.map(t=>t.id).filter(Boolean));
  await page.bringToFront();if(!existingOwnedDraft)await composer.fill(text);
  const send=page.getByRole('button',{name:/^(发送|发送消息|发送提示|Send|Send message|Send prompt)$/i});
  if(await send.count()!==1)throw new Error('Send button not uniquely identified; draft retained');
  const uploadDeadline=Date.now()+60000;
  while(!await send.isEnabled()){
    if(page.url()!==startingUrl||Date.now()>uploadDeadline)throw Error('Send not ready; draft retained');
    await delay(400);
  }
  const submittedDraft=await composer.evaluate(el=>'value' in el?el.value:[...el.children].map(p=>p.textContent).join('\n'));
  if(submittedDraft!==text)throw Error('Draft changed before submit; refusing send');
  // Native DOM activation avoids animation-frame actionability waits when
  // Chrome throttles a background tab. Identity, draft and uniqueness were
  // checked above; this activates the observed submit button exactly once.
  await send.evaluate(el=>{
    if(el.disabled||el.getAttribute('aria-disabled')==='true'||el.getBoundingClientRect().width<=0)throw Error('Send button disabled or hidden; draft retained');
    el.click();
  });
  const deadline=Date.now()+timeoutMs;let acknowledged=false,lastHash=null,lastChange=Date.now(),transientSince=null;
  while(Date.now()<deadline){
    const current=page.url();if(!validUrl(current)){
      if(new URL(current).origin!=='https://chatgpt.com'||new URL(startingUrl).pathname!=='/')throw new Error('ChatGPT navigated away during send');
      transientSince??=Date.now();if(Date.now()-transientSince>10000)throw new Error('New conversation URL did not settle');
      await delay(400);continue;
    }
    if(current!==boundUrl){if(new URL(boundUrl).pathname!=='/'||!new URL(current).pathname.startsWith('/c/'))throw new Error('Conversation changed during send');boundUrl=current;}
    const turns=await readTurns(page);
    const freshUsers=turns.filter(t=>t.role==='user'&&(!t.id||!oldIds.has(t.id)));
    const user=freshUsers.find(t=>t.text.trim()===text.trim());
    if(freshUsers.some(t=>t.text.trim()!==text.trim()))throw new Error('Competing human message detected');
    if(user&&!acknowledged){acknowledged=true;await onReceipt({url:boundUrl,userMessageId:user.id});}
    const answer=turns.filter(t=>t.role==='assistant'&&(!t.id||!oldIds.has(t.id))).at(-1);
    if(acknowledged&&answer?.text){const checksum=digest(JSON.stringify({text:answer.text,codes:answer.codes}));if(checksum!==lastHash){lastHash=checksum;lastChange=Date.now();}
      const stop=await page.getByRole('button',{name:/^(停止|停止生成|Stop|Stop generating)$/i}).count();
      if(!stop&&answer.hasCopy&&Date.now()-lastChange>=1200)return {...answer,url:boundUrl,userMessageId:user?.id,textHash:digest(answer.text)};
    }
    await delay(400);
  }
  throw new Error(acknowledged?'ChatGPT reply incomplete; do not resend':'ChatGPT send unconfirmed; do not resend');
}
