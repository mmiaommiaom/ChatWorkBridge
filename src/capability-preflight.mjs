import {nativeRpc} from './workbuddy-desktop.mjs';

const canonical=name=>String(name??'').toLowerCase().replace(/^custom-mcp:/,'').replace(/^mcp[_:-]+|[_:-]+mcp$/g,'').replace(/[^\p{L}\p{N}]/gu,'');
const list=value=>Array.isArray(value)?value:Array.isArray(value?.skills)?value.skills:Array.isArray(value?.experts)?value.experts:Array.isArray(value?.results)?value.results.flatMap(v=>Array.isArray(v?.skills)?v.skills:Array.isArray(v)?v:[v]):[];
export function normalizeRequirements(requirements=[]){
  if(!Array.isArray(requirements)||requirements.length>30)throw Error('Invalid capability requirements');
  return requirements.map((r,i)=>{
    if(!r||!['mcp','skill','expert','application'].includes(r.kind)||typeof r.name!=='string'||!r.name.trim()||r.name.length>150||r.required!==undefined&&typeof r.required!=='boolean')throw Error('Invalid capability requirement');
    if(r.tools!==undefined&&(!Array.isArray(r.tools)||r.tools.length>20||r.tools.some(t=>typeof t!=='string'||t.length>150)))throw Error('Invalid required tools');
    return {id:r.kind+':'+canonical(r.name),kind:r.kind,name:r.name,required:r.required!==false,tools:r.tools??[],reason:String(r.reason??'').slice(0,1000),instructions:String(r.instructions??'').slice(0,2000)};
  });
}
export async function inspectCapabilities(page,{workspace,rpc=nativeRpc}={}){
  const result={mcps:[],skills:[],experts:[],errors:{},checkedAt:new Date().toISOString()};
  for(const [key,channel,args] of [['mcps','mcp:list',[]],['skills','skill:list',[workspace]],['experts','expert:getActivePlugins',[]]]){
    try{result[key]=list(await rpc(page,channel,args));}catch(e){result.errors[key]=e.message;}
  }
  // Never retain server forms, credentials or Skill contents in the task log.
  result.mcps=result.mcps.map(m=>({id:m.id,name:m.name,displayName:m.displayName,enabled:m.enabled,state:m.state,trusted:m.trusted,blockedReason:m.blockedReason,tools:(m.tools??[]).map(t=>({name:t.name,enabled:t.enabled}))}));
  result.skills=result.skills.map(s=>({id:s.id??s.name,name:s.name??s.skillName,enabled:s.enabled??(typeof s.disable==='boolean'?!s.disable:typeof s.disabled==='boolean'?!s.disabled:undefined),automaticInvocation:s.disableModelInvocation===false,scope:s.scope??s.source,path:s.path??s.filePath??s.directory}));
  result.experts=result.experts.map(e=>({id:e.id??e.expertId,name:e.name??e.displayName,sessionId:e.sessionId,model:e.model}));
  return result;
}
const mcpNames=name=>String(name??'').split(/\s*[/／|]\s*/).map(canonical).map(n=>n==='mcpforblender'?'blender':n);
export async function checkRequirements(page,requirements,{workspace,confirmations=[],rpc=nativeRpc,inventory}={}){
  requirements=normalizeRequirements(requirements);
  inventory??=await inspectCapabilities(page,{workspace,rpc});
  const checks=[];
  for(const requirement of requirements){
    let status='unknown',evidence='尚未验证',instructions='',invalidRequirement=false;
    const name=canonical(requirement.name);
    if(requirement.kind==='mcp'){
      const exact=inventory.mcps.filter(m=>[m.id,m.name,m.displayName].some(n=>String(n??'').trim().toLowerCase()===requirement.name.trim().toLowerCase()));
      const matches=exact.length?exact:inventory.mcps.filter(m=>[m.id,m.name,m.displayName].some(n=>mcpNames(n).some(key=>mcpNames(requirement.name).includes(key))));
      const m=matches.length===1?matches[0]:null;
      if(inventory.errors.mcps){status='unknown';evidence='连接器查询失败：'+inventory.errors.mcps;}
      else if(!m){status=matches.length?'unknown':'missing';evidence=matches.length?'存在多个同名连接器，请指定准确名称':'未发现该连接器';}
      else if(m.enabled===false){status='disabled';evidence='连接器已配置但未启用';}
      else if(m.trusted===false){status='needs_trust';evidence='首次信任尚未完成';}
      else if(m.state!=='ready'){status='disconnected';evidence='连接状态：'+m.state;}
      else if(requirement.tools.some(t=>! /^[A-Za-z0-9_.:/-]+$/.test(t))){status='unknown';invalidRequirement=true;evidence='GPT 填写了工具说明文字，未提供真实工具标识；需 GPT 根据实际工具清单重新规划，不需要用户重新启用连接器';}
      else if(requirement.tools.some(t=>!m.tools.some(tool=>tool.name===t&&tool.enabled!==false))){status='tool_missing';evidence='必需工具不可见或被禁用';}
      else if(!m.tools.some(t=>t.enabled!==false)){status='tool_missing';evidence='连接成功但没有可调用工具';}
      else{status='ready';evidence='已启用、连接就绪，工具可见';}
      instructions='WorkBuddy → 专家·技能·连接器 → 连接器 → '+requirement.name+'：检查启用、信任、登录和连接状态，然后重新检查。';
    }else if(requirement.kind==='skill'){
      const s=inventory.skills.find(s=>[s.name,s.id].some(n=>canonical(n)===name));
      if(!s){status=inventory.errors.skills?'unknown':'missing';evidence='当前工作区未发现该技能';}
      else if(s.enabled===false){status='disabled';evidence='技能已禁用';}
      else if(s.enabled===true&&s.automaticInvocation===false){status='unknown';evidence='技能已启用，但禁止模型自动调用；请确认手动使用方式';}
      else if(s.enabled===true){status='ready';evidence='技能已安装、启用并对当前工作区可见';}
      else{evidence='已找到技能，但启用状态未被接口确认';}
      instructions='WorkBuddy → 专家·技能·连接器 → 技能：找到 '+requirement.name+' 并启用；项目专用技能需对当前任务目录可见。';
    }else if(requirement.kind==='expert'){
      evidence='专家自动召唤及其全部模型/费用尚未可靠验证；普通确认不能代替付费模型批准。';
      instructions='在 WorkBuddy 的专家页面检查角色、使用模型和费用；将具体情况回复 GPT。优先使用已获准免费模型的 MCP/Skill 方案。';
    }else{
      instructions=requirement.instructions||'打开 '+requirement.name+' 及其需要的连接服务，再点击“确认已打开并重新检查”。';
      if(name==='blender'){
        const blender=inventory.mcps.find(m=>canonical(m.name)==='blender'&&m.enabled&&m.state==='ready'&&m.tools.some(t=>t.name==='get_addon_status'&&t.enabled!==false));
        if(blender)try{
          const probe=await rpc(page,'mcp:callTool',[{toolName:'mcp__blender__get_addon_status',args:{}}],10000);
          if(probe?.isError)throw Error('Blender 插件报告错误');
          status='ready';evidence='Blender MCP 只读插件状态查询成功';
        }catch(e){evidence=/not callable from the daemon/.test(e.message)?'连接器就绪，但 WorkBuddy 禁止桥接层直接调用该工具；软件连通性未自动验证，可由用户确认，不能据此判定 Blender 未启动':'连接器可见，但软件连通性检查未通过：'+e.message;}
        instructions='打开 Blender，在其已安装的 MCP 插件中开启连接服务；回到 WorkBuddy 确认 blender 连接器就绪后重新检查。';
      }
      if(status!=='ready'&&confirmations.some(c=>c.id===requirement.id&&c.kind==='application')){status='user_confirmed';evidence='用户确认已打开；程序未独立验证软件状态';}
    }
    checks.push({...requirement,status,evidence,instructions,invalidRequirement,availableTools:requirement.kind==='mcp'?inventory.mcps.filter(m=>mcpNames(m.name).some(n=>mcpNames(requirement.name).includes(n))).flatMap(m=>m.tools.filter(t=>t.enabled!==false).map(t=>t.name)):undefined,verifiedBy:status==='ready'?'machine':status==='user_confirmed'?'user':'none'});
  }
  return {checkedAt:inventory.checkedAt,checks,invalidRequirements:checks.some(c=>c.invalidRequirement),available:{mcps:inventory.mcps.map(m=>({name:m.name,enabled:m.enabled,state:m.state,tools:m.tools.filter(t=>t.enabled!==false).map(t=>t.name)})),skills:inventory.skills.map(s=>({name:s.name,enabled:s.enabled}))},ready:checks.every(c=>!c.required||['ready','user_confirmed'].includes(c.status))};
}
