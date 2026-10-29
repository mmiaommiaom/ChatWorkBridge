import {loadConfig,projectRoot} from '../src/local-config.mjs';
import {createDefaultActions} from '../src/onboarding.mjs';

try{
  const config=loadConfig({checkExecutables:true});
  if(!config.allowNativeRuntimeRecords)throw Error('请先在设置中明确允许 WorkBuddy 自身的系统运行记录。');
  const result=await createDefaultActions(projectRoot).connectSession({config});
  if(process.argv.includes('--json'))console.log(JSON.stringify(result,null,2));
  else console.log(result.message+' 未发送模型消息；模型可用性和剩余额度尚未验证。');
}catch(error){
  process.exitCode=1;
  if(process.argv.includes('--json'))console.log(JSON.stringify({ok:false,code:error.code??'SESSION_INITIALIZATION_FAILED',error:error.message},null,2));
  else console.error(error.message);
}
