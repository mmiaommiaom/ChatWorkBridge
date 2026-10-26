import fs from 'node:fs';
const policy=JSON.parse(fs.readFileSync(new URL('../config/model-policy.json',import.meta.url)));
export const allowedModels=Object.freeze([...policy.allowedModels]);
export function approvedModel(value){
  const id=policy.aliases[value]??value;
  if(!allowedModels.includes(id)){const e=new Error('Model requires explicit user approval: '+value);e.code='MODEL_APPROVAL_REQUIRED';throw e;}
  return id;
}
// Only call with transport/provider errors, never natural-language assistant replies.
export function classifyProviderError(error){
  const code=String(error?.code??error?.providerError?.code??'').toLowerCase();
  const message=String(error?.message??'')+' '+(error?.providerError?JSON.stringify(error.providerError):'');
  if(/insufficient_quota|quota_exceeded|quota_exhausted|usage_limit_exceeded/.test(code)||/quota (?:exceeded|exhausted)|insufficient (?:quota|credits)|额度.{0,12}(?:耗尽|用尽|上限)|配额.{0,12}(?:耗尽|用尽|超限)/i.test(message))return 'quota_exhausted';
  if(Number(error?.status??error?.providerError?.status)===429||/rate_limit/.test(code)||/rate limit exceeded|too many requests/i.test(message))return 'rate_limited';
  if(Number(error?.status)>=500&&Number(error?.status)<600)return 'service_error';
  if(/unauthorized|authentication|not logged in/i.test(message)||[401,403].includes(Number(error?.status)))return 'auth_or_permission';
  return 'uncertain';
}
export function providerFailure(result){
  const meta=result?._meta;if(meta?.['codebuddy.ai/outcome']!=='FAILED_MODEL_REQUEST')return null;
  let raw;try{raw=JSON.parse(meta['codebuddy.ai/errorMessage']);}catch{raw={message:String(meta['codebuddy.ai/errorMessage']??'Unknown model failure')};}
  const error=new Error(raw.data?.details??raw.message??'Model request failed');
  error.code=raw.data?.code??raw.code;error.status=raw.data?.statusCode??raw.status;error.providerError=raw;
  error.category=classifyProviderError(error);return error;
}
export function selectModel({preferred,states={},exclude=[],now=Date.now()}={}){
  const order=preferred?[approvedModel(preferred),...allowedModels.filter(m=>m!==approvedModel(preferred))]:allowedModels;
  const id=order.find(m=>!exclude.includes(m)&&!states[m]?.quotaExhausted&&!(states[m]?.cooldownUntil>now));
  if(!id){const e=new Error('All approved models unavailable; paid models require user approval');e.code='NO_APPROVED_MODEL';throw e;}
  return id;
}
