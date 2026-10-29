import {loadConfig} from '../src/local-config.mjs';
import {openManagedPage} from '../src/onboarding.mjs';

const config=loadConfig({checkExecutables:true});
const result=await openManagedPage('https://chatgpt.com/',{root:config.projectRoot,config});
if(result.opened===false)throw Error(result.reason);
console.log(result.reused?'已复用专用 ChatGPT 浏览器。':'专用 ChatGPT 浏览器已打开。首次使用请在此窗口登录。');
