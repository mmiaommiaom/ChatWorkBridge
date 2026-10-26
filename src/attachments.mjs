import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

const projectRoot=fileURLToPath(new URL('..',import.meta.url));
const limit=10*1024*1024;
const sha=value=>createHash('sha256').update(value).digest('hex');
const types={
  'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif','image/bmp':'bmp',
  'text/plain':'txt','text/markdown':'md','text/csv':'csv','application/json':'json',
  'application/pdf':'pdf','application/msword':'doc','application/vnd.ms-excel':'xls','application/vnd.ms-powerpoint':'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx'
};
const extensionMime=Object.fromEntries(Object.entries(types).map(([mime,ext])=>[ext,mime]));
Object.assign(extensionMime,{jpeg:'image/jpeg',markdown:'text/markdown'});

export function allowedAttachmentUrl(value){
  try{
    const u=new URL(value);
    if(u.username||u.password||u.port)return false;
    if(u.protocol==='blob:')return u.origin==='https://chatgpt.com'&&u.pathname.startsWith('https://chatgpt.com/');
    const attachmentEndpoint=u.pathname==='/backend-api/estuary/content'||/^\/backend-api\/files\/[A-Za-z0-9_-]+\/(?:download|content)$/.test(u.pathname)||/^\/backend-api\/files\/download\/[A-Za-z0-9_-]+$/.test(u.pathname);
    return u.protocol==='https:'&&((u.hostname==='chatgpt.com'&&attachmentEndpoint)||u.hostname==='files.oaiusercontent.com');
  }catch{return false;}
}
function requirePage(page){
  const u=new URL(page.url());
  if(u.origin!=='https://chatgpt.com'||!(u.pathname==='/'||/^\/c\/[\w-]+$/.test(u.pathname)))throw Error('ATTACHMENT_PAGE_DENIED');
}

// Only rendered content from the requested turn is considered. Account avatars,
// sidebar links, other conversations, and hidden application state are excluded.
export async function collect(page,{messageId,role='assistant'}={}){
  requirePage(page);
  if(!messageId||!['assistant','user'].includes(role))throw Error('ATTACHMENT_TURN_REQUIRED');
  const candidates=await page.evaluate(({messageId,role})=>{
    const modern=[...document.querySelectorAll('[data-chatgpt-search-unit-key][data-chatgpt-search-message-ids]')];
    let matches=modern.filter(el=>el.getAttribute('data-chatgpt-search-message-ids').split(' ').includes(messageId)&&el.getAttribute('data-chatgpt-search-unit-key').split(':').at(-1)===role);
    if(!matches.length)matches=[...document.querySelectorAll('[data-message-author-role]')].filter(el=>el.getAttribute('data-message-author-role')===role&&(el.getAttribute('data-message-id')===messageId||el.closest('section[data-testid^="conversation-turn-"],article')?.getAttribute('data-testid')===messageId));
    if(matches.length!==1)throw Error('ATTACHMENT_TURN_AMBIGUOUS');
    const el=matches[0];
    // User uploads are siblings of the text bubble inside this exact message
    // element. Scoping to the bubble alone silently loses those attachments.
    const content=role==='user'?el:el.querySelector('[data-markdown-text-style="assistant-message"]')??el;
    const items=[];
    for(const img of content.querySelectorAll('img')){
      const url=img.currentSrc||img.src;
      if(url)items.push({url,kind:'image',name:(img.getAttribute('data-filename')||img.alt||'image').slice(0,200)});
    }
    for(const a of content.querySelectorAll('a[href]')){
      const url=a.href;
      if(url)items.push({url,kind:'file',name:(a.getAttribute('download')||a.innerText||'attachment').trim().slice(0,200)});
    }
    return items.slice(0,100);
  },{messageId,role});
  const seen=new Set();
  return candidates.filter(item=>allowedAttachmentUrl(item.url)&&!seen.has(item.url)&&seen.add(item.url)).map(item=>({...item,messageId,role}));
}

function checkContent(buffer,mime,name){
  mime=String(mime??'').split(';')[0].trim().toLowerCase();
  if(mime==='image/jpg')mime='image/jpeg';
  if(mime==='application/octet-stream'||!mime)mime=extensionMime[path.extname(name??'').slice(1).toLowerCase()]??'';
  if(!Object.hasOwn(types,mime))throw Error('ATTACHMENT_MIME_DENIED');
  const starts=bytes=>buffer.subarray(0,bytes.length).equals(Buffer.from(bytes));
  let valid=true;
  if(mime==='image/png')valid=starts([137,80,78,71,13,10,26,10]);
  else if(mime==='image/jpeg')valid=starts([255,216,255]);
  else if(mime==='image/gif')valid=/^GIF8[79]a$/.test(buffer.subarray(0,6).toString('ascii'));
  else if(mime==='image/webp')valid=buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP';
  else if(mime==='image/avif')valid=buffer.subarray(4,8).toString()==='ftyp'&&/avif|avis/.test(buffer.subarray(8,32).toString('ascii'));
  else if(mime==='image/bmp')valid=buffer.subarray(0,2).toString()==='BM';
  else if(mime==='application/pdf')valid=buffer.subarray(0,5).toString()==='%PDF-';
  else if(['doc','xls','ppt'].includes(types[mime]))valid=starts([208,207,17,224,161,177,26,225]);
  else if(['docx','xlsx','pptx'].includes(types[mime]))valid=starts([80,75,3,4]);
  else{try{const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);valid=!text.includes('\0');}catch{valid=false;}}
  if(!valid)throw Error('ATTACHMENT_CONTENT_MISMATCH');
  return {mimeType:mime,extension:types[mime],kind:mime.startsWith('image/')?'image':'file'};
}
function attachmentDir(root,runId){
  if(!/^[\w-]{1,100}$/.test(runId))throw Error('ATTACHMENT_RUN_ID_DENIED');
  root=path.resolve(root);
  if(!/^E:[\\/]/i.test(root))throw Error('ATTACHMENT_ROOT_MUST_BE_E');
  for(const part of [root,path.join(root,'artifacts'),path.join(root,'artifacts',runId),path.join(root,'artifacts',runId,'attachments')]){
    if(fs.existsSync(part)){if(fs.lstatSync(part).isSymbolicLink()||path.resolve(fs.realpathSync(part)).toLowerCase()!==part.toLowerCase())throw Error('ATTACHMENT_PATH_LINK_DENIED');}
    else fs.mkdirSync(part);
  }
  return path.join(root,'artifacts',runId,'attachments');
}

// The caller must pass candidates from collect(). The URL is checked against
// that same turn again immediately before fetching, and signed URLs are never
// persisted in returned metadata or filenames. Redirects are refused.
export async function download(page,candidates,{runId,root=projectRoot,maxBytes=limit}={}){
  requirePage(page);
  if(!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>limit)throw Error('ATTACHMENT_SIZE_POLICY_DENIED');
  if(!Array.isArray(candidates)||candidates.length>20)throw Error('ATTACHMENT_COUNT_DENIED');
  const dir=attachmentDir(root,runId);
  const files=[],seen=new Set(),turns=new Map();
  for(const item of candidates){
    if(!allowedAttachmentUrl(item.url))throw Error('ATTACHMENT_URL_DENIED');
    const key=JSON.stringify([item.messageId,item.role]);
    if(!turns.has(key))turns.set(key,await collect(page,{messageId:item.messageId,role:item.role}));
    if(!turns.get(key).some(entry=>entry.url===item.url))throw Error('ATTACHMENT_NOT_IN_BOUND_TURN');
    const fetched=await page.evaluate(async({url,maxBytes})=>{
      const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),30000);
      try{
        // The cross-origin file URL already carries its short-lived signature;
        // avoid sending cookies and requiring credentialed CORS to that host.
        const u=new URL(url),credentials=u.protocol==='https:'&&u.hostname==='files.oaiusercontent.com'?'omit':'include';
        const response=await fetch(url,{method:'GET',credentials,redirect:'error',signal:abort.signal});
        if(!response.ok)throw Error('ATTACHMENT_HTTP_'+response.status);
        const length=response.headers.get('content-length');
        if(length&&Number(length)>maxBytes)throw Error('ATTACHMENT_TOO_LARGE');
        if(!response.body)throw Error('ATTACHMENT_EMPTY_BODY');
        const reader=response.body.getReader(),parts=[];let size=0;
        while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw Error('ATTACHMENT_TOO_LARGE');}parts.push(value);}
        if(!size)throw Error('ATTACHMENT_EMPTY_BODY');
        const data=new Uint8Array(size);let offset=0;
        for(const part of parts){data.set(part,offset);offset+=part.byteLength;}
        let binary='';for(let i=0;i<data.length;i+=32768)binary+=String.fromCharCode(...data.subarray(i,i+32768));
        return {data:btoa(binary),mimeType:response.headers.get('content-type')};
      }finally{clearTimeout(timer);}
    },{url:item.url,maxBytes});
    const bytes=Buffer.from(fetched.data,'base64');
    if(!bytes.length||bytes.length>maxBytes)throw Error('ATTACHMENT_TOO_LARGE');
    const content=checkContent(bytes,fetched.mimeType,item.name);
    const hash=sha(bytes);if(seen.has(hash))continue;seen.add(hash);
    const name=hash+'.'+content.extension,filePath=path.join(dir,name);
    if(fs.existsSync(filePath)){
      if(fs.lstatSync(filePath).isSymbolicLink()||sha(fs.readFileSync(filePath))!==hash)throw Error('ATTACHMENT_EXISTING_FILE_MISMATCH');
    }else fs.writeFileSync(filePath,bytes,{flag:'wx'});
    files.push({sha256:hash,path:filePath,name,mimeType:content.mimeType,kind:content.kind,size:bytes.length,sourceUrlHash:sha(item.url),messageId:item.messageId});
  }
  return files;
}

export function nativeBlocks(files){
  if(!Array.isArray(files)||files.length>20)throw Error('ATTACHMENT_COUNT_DENIED');
  return files.map(file=>{
    const resolved=path.resolve(file.path);
    if(!/^E:[\\/]/i.test(resolved)||fs.lstatSync(resolved).isSymbolicLink())throw Error('ATTACHMENT_FILE_DENIED');
    const bytes=fs.readFileSync(resolved);
    if(bytes.length>limit||bytes.length!==file.size||sha(bytes)!==file.sha256)throw Error('ATTACHMENT_FILE_CHANGED');
    const checked=checkContent(bytes,file.mimeType,file.name);
    if(checked.kind==='image')return {type:'image',data:bytes.toString('base64'),mimeType:checked.mimeType,uri:pathToFileURL(resolved).href,_meta:{filename:file.name}};
    return {type:'resource_link',uri:pathToFileURL(resolved).href,name:file.name,title:file.name,mimeType:checked.mimeType,size:bytes.length,_meta:{filename:file.name,filePath:resolved,size:bytes.length}};
  });
}
