// The daemon owns work for the lifetime of the transport. Keep one transport
// in the renderer; timing out a local waiter must never close its MessagePort.
export async function rendererRequest({channel,args,id,timeoutMs}){
  let state=globalThis.__chatWorkTransportV3;
  if(!state){
    const pair=new MessageChannel();
    state={port:pair.port1,opened:false,closed:false,requests:new Map(),events:new Map(),eventBytes:0,sequence:0,overflow:false};
    globalThis.__chatWorkTransportV3=state;
    state.ready=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Native transport did not open; no request sent')),10000);
      state.port.onmessage=({data})=>{
        if(data?.kind==='open'){state.opened=true;clearTimeout(timer);resolve();return;}
        if(data?.kind==='close'||data?.kind==='error'){
          state.closed=true;clearTimeout(timer);reject(Error('Native transport disconnected'));
          for(const request of state.requests.values())if(request.status==='pending'){request.status='uncertain';request.error='Native transport disconnected; request may still be running';request.reject(Error(request.error));}
          return;
        }
        if(data?.kind!=='message')return;
        let packet;try{packet=data.json??JSON.parse(data.text);}catch{return;}
        if(packet.type==='event'){
          if(!packet.channel?.startsWith('session:event:'))return;
          const update=packet.result?.update;if(update?.sessionUpdate==='agent_thought_chunk'){state.lastActivityAt=Date.now();return;}
          const sessionId=packet.channel.slice('session:event:'.length),events=state.events.get(sessionId)??[];
          const size=JSON.stringify(packet).length;state.lastActivityAt=Date.now();
          if(state.eventBytes+size>32*1024*1024||events.length>=100000){state.overflow=true;return;}
          events.push({...packet,bridgeSequence:++state.sequence});state.events.set(sessionId,events);state.eventBytes+=size;return;
        }
        const request=state.requests.get(packet.id);if(!request||request.status!=='pending')return;
        request.finishedAt=Date.now();
        if(packet.type==='error'||packet.error){request.status='failed';request.error='PROVIDER_ERROR '+JSON.stringify(packet.error??{message:packet.message??'Native RPC error'});request.reject(Error(request.error));}
        else{request.status='completed';request.result=packet.result;request.resolve(packet.result);}
      };
      state.port.onmessageerror=()=>{state.lastDecodeError=Date.now();};
      state.port.start();
      window.postMessage({type:'workbuddy:open-local-daemon-transport-port',target:{transportType:'local'}},'*',[pair.port2]);
    });
    // A rejected connection is inspected by the next request, not an unhandled rejection.
    state.ready.catch(()=>{});
  }
  await state.ready;
  if(state.closed)throw Error('Native transport disconnected; do not resend');
  const checksum=JSON.stringify({channel,args});let request=state.requests.get(id);
  if(request&&request.checksum!==checksum)throw Error('Native request identity conflict');
  if(!request){
    request={id,channel,checksum,status:'pending',startedAt:Date.now()};
    request.promise=new Promise((resolve,reject)=>{request.resolve=resolve;request.reject=reject;});request.promise.catch(()=>{});
    state.requests.set(id,request);
    state.port.postMessage({kind:'message',text:JSON.stringify({id,type:'request',channel,args})});
  }
  if(request.status==='completed')return request.result;
  if(['failed','uncertain'].includes(request.status))throw Error(request.error);
  if(timeoutMs===0)return request.promise;
  let timer;
  try{return await Promise.race([request.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Native RPC wait timed out; transport retained; do not resend')),timeoutMs);})]);}
  finally{clearTimeout(timer);}
}

export async function requestOnPage(page,channel,args=[],timeoutMs=15000){
  const key=channel==='session:sendMessage'?args[2]?.['codebuddy.ai']?.requestId:null;
  const id=key?'bridge-request-'+key:'bridge-rpc-'+crypto.randomUUID();
  return page.evaluate(rendererRequest,{channel,args,id,timeoutMs});
}

export async function transportSnapshot(page,sessionId){
  return page.evaluate(sid=>{
    const state=globalThis.__chatWorkTransportV3;if(!state)return {available:false};
    return {available:true,closed:state.closed,overflow:state.overflow,lastActivityAt:state.lastActivityAt,events:state.events.get(sid)??[],requests:[...state.requests.values()].filter(r=>r.channel==='session:sendMessage').map(({id,status,result,error,startedAt,finishedAt})=>({id,status,result,error,startedAt,finishedAt}))};
  },sessionId);
}
