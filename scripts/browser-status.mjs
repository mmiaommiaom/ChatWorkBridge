import {connectGpt,browserStatus} from '../src/chatgpt-web.mjs';
const {browser}=await connectGpt();
try{const pages=browser.contexts().flatMap(c=>c.pages()).filter(p=>p.url().startsWith('https://chatgpt.com/'));for(const page of pages)console.log(JSON.stringify(await browserStatus(page)));}
finally{await browser.close();}
