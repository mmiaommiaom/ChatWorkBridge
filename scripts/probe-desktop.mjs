import fs from 'node:fs';
import {connectDesktop,readNative} from '../src/workbuddy-desktop.mjs';
const {browser,page,state}=await connectDesktop();
try{
  const body=await page.locator('body').innerText();
  const report={checkedAt:new Date().toISOString(),pid:state.pid,cdpConnected:true,rendererIdentityVerified:true,loginRequired:/Work Less, Deliver More/.test(body)&&/Sign In/.test(body),messageSent:false};
  for(const [key,channel,args] of [['configuration','config:getProductConfiguration',[true]],['sessions','daemon:getActiveSessions',[]]]){
    try{const value=await readNative(page,channel,args);report[key]={rpcSucceeded:true,shape:Array.isArray(value)?'array':typeof value};
      if(key==='configuration'){const models=[...(Array.isArray(value?.models)?value.models:[]),...(Array.isArray(value?.availableModels)?value.availableModels:[])];report.modelCandidates=[...new Set(models.map(m=>typeof m==='string'?m:m.id??m.modelId??m.name).filter(x=>typeof x==='string'))];report.modelsVerified=false;}
      if(key==='sessions')report.activeSessionCount=Array.isArray(value)?value.length:null;
    }catch(e){report[key]={rpcSucceeded:false,error:e.message};}
  }
  fs.writeFileSync(new URL('../data/desktop-live-probe.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
