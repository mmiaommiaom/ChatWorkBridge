import {initializeSession} from '../src/initialize-session.mjs';

try{
  const result=await initializeSession();
  if(process.argv.includes('--json'))console.log(JSON.stringify(result,null,2));
  else console.log(result.reused?'专用测试会话已核验，可开始任务。未发送模型消息。':'专用测试会话已创建，可开始任务。未发送模型消息；模型可用性和剩余额度尚未验证。');
}catch(error){
  process.exitCode=1;
  if(process.argv.includes('--json'))console.log(JSON.stringify({ok:false,code:error.code??'SESSION_INITIALIZATION_FAILED',error:error.message},null,2));
  else console.error(error.message);
}
