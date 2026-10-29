import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {assertControlledPath} from './local-config.mjs';
export const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export class BridgeStore{
  constructor(file){
    const resolved=assertControlledPath(file);
    fs.mkdirSync(path.dirname(resolved),{recursive:true});this.db=new DatabaseSync(resolved);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,state TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runner_lease(id INTEGER PRIMARY KEY CHECK(id=1),pid INTEGER,token TEXT);
      DROP INDEX IF EXISTS one_active_run;
      CREATE UNIQUE INDEX IF NOT EXISTS one_running_run ON runs((1)) WHERE state IN ('waiting_gpt','waiting_workbuddy');
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),step INTEGER NOT NULL,direction TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,result TEXT,UNIQUE(run_id,step,direction));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),at TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),client_id TEXT NOT NULL,text TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL,delivered_with TEXT,UNIQUE(run_id,client_id));
      CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),author TEXT NOT NULL,text TEXT NOT NULL,created_at TEXT NOT NULL);`);
  }
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  acquireRunner(){return this.transaction(()=>{
    const prior=this.db.prepare('SELECT * FROM runner_lease WHERE id=1').get();
    if(prior?.pid){try{process.kill(prior.pid,0);throw Object.assign(Error('Another bridge runner is active'),{code:'RUNNER_ACTIVE'});}catch(e){if(e.code!=='ESRCH')throw e;}}
    const token=randomUUID();this.db.prepare('INSERT INTO runner_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,token=excluded.token').run(process.pid,token);return token;
  });}
  releaseRunner(token){this.db.prepare('UPDATE runner_lease SET pid=NULL,token=NULL WHERE id=1 AND token=?').run(token);}
  event(id,kind,data={}){this.db.prepare('INSERT INTO events(run_id,at,kind,data) VALUES(?,?,?,?)').run(id,new Date().toISOString(),kind,JSON.stringify(data));}
  create(goal,options={}){const id='run-'+randomUUID();const data={goal,...options,createdAt:new Date().toISOString()};this.transaction(()=>{this.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(id,'prepared',JSON.stringify(data));this.event(id,'created');});return this.get(id);}
  get(id){const r=this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);if(!r)throw new Error('Run not found');return{id:r.id,state:r.state,...JSON.parse(r.data)};}
  list(){return this.db.prepare('SELECT * FROM runs ORDER BY rowid DESC').all().map(r=>({id:r.id,state:r.state,...JSON.parse(r.data)}));}
  history(id,{before=null,limit=20}={}){
    this.get(id);if(!Number.isInteger(limit)||limit<1||limit>50||before!==null&&(!Number.isInteger(before)||before<1))throw Error('Invalid history page');
    const rows=before===null?this.db.prepare('SELECT rowid AS cursor,* FROM messages WHERE run_id=? ORDER BY rowid DESC LIMIT ?').all(id,limit+1):this.db.prepare('SELECT rowid AS cursor,* FROM messages WHERE run_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(id,before,limit+1);
    const more=rows.length>limit,visible=rows.slice(0,limit);
    return {messages:visible.reverse().map(r=>({...this.decode(r),cursor:r.cursor})),nextBefore:more?visible[0].cursor:null};
  }
  continueWork(id,{goal,clientMessageId}){return this.transaction(()=>{
    if(typeof goal!=='string'||!goal.trim()||goal.length>12000||typeof clientMessageId!=='string'||!/^[\w-]{1,100}$/.test(clientMessageId))throw Error('请输入后续工作目标');
    const run=this.get(id);
    if(run.lastContinuation?.clientMessageId===clientMessageId){if(run.lastContinuation.goal!==goal)throw Error('Continuation identity conflict');return {run,reused:true};}
    if(run.state!=='done'||run.cursor===undefined||this.messages(id).some(m=>['sending','uncertain'].includes(m.state)))throw Error('只有已经验收完成的工作可追加新目标；未完成工作请继续或核验');
    const stage=(run.stage??1)+1,lastStep=Math.max(-1,...this.messages(id).filter(m=>m.direction==='gpt').map(m=>m.step));
    const snapshot={stage:run.stage??1,goal:run.goal,acceptance:run.acceptance,checks:run.checks,summary:run.summary,workerRounds:run.workerRounds,finishedAt:run.finishedAt,endStep:lastStep};
    const {id:_,state:__,...data}=run;
    Object.assign(data,{goal,workTitle:run.workTitle??run.displayName??run.goal.slice(0,60),workArchived:false,stage,cursor:lastStep+1,completedStages:[...(run.completedStages??[]),snapshot],lastContinuation:{clientMessageId,goal},acceptance:null,acceptanceVersion:1,acceptanceProposal:null,requirements:[],requiredImages:0,workerRounds:0,checks:null,summary:null,finishedAt:null,question:null,error:null,waitReason:null,protocolErrors:0,sameInstructionCount:0,lastInstruction:null,nextOutgoing:null,nextAttachments:[],updatedAt:new Date().toISOString()});
    this.db.prepare("UPDATE runs SET state='paused',data=? WHERE id=?").run(JSON.stringify(data),id);this.notice(id,'user','后续工作目标：'+goal);this.event(id,'work_continued',{stage,clientMessageId});return {run:this.get(id),reused:false};
  });}
  notice(id,author,text){
    if(!['gpt','bridge','user'].includes(author)||typeof text!=='string'||text.length>20000)throw Error('Invalid task notice');
    this.get(id);const noticeId='notice-'+randomUUID();this.db.prepare('INSERT INTO notices VALUES(?,?,?,?,?)').run(noticeId,id,author,text,new Date().toISOString());return noticeId;
  }
  notices(id){return this.db.prepare('SELECT * FROM notices WHERE run_id=? ORDER BY rowid DESC LIMIT 100').all(id).reverse();}
  queueInteraction(id,{clientMessageId,text,kind='message'}){return this.transaction(()=>{
    const run=this.get(id);if(['done','failed','cancelled'].includes(run.state))throw Error('Task has ended');
    if(typeof clientMessageId!=='string'||!/^[\w-]{1,100}$/.test(clientMessageId)||typeof text!=='string'||!text.trim()||text.length>12000||!['message','capability_confirmation','acceptance_approval'].includes(kind))throw Error('Invalid user reply');
    const existing=this.db.prepare('SELECT * FROM interactions WHERE run_id=? AND client_id=?').get(id,clientMessageId);
    if(existing){if(existing.text!==text||existing.kind!==kind)throw Error('User reply identity conflict');return existing;}
    const interactionId='user-'+randomUUID(),at=new Date().toISOString();this.db.prepare('INSERT INTO interactions VALUES(?,?,?,?,?,?,?,NULL)').run(interactionId,id,clientMessageId,text,kind,'queued',at);
    this.notice(id,'user',text);return this.db.prepare('SELECT * FROM interactions WHERE id=?').get(interactionId);
  });}
  interactions(id){return this.db.prepare('SELECT * FROM interactions WHERE run_id=? ORDER BY rowid').all(id);}
  pendingInteractions(id){return this.interactions(id).filter(i=>i.state==='queued');}
  approveAcceptance(id,{proposalId,clientMessageId}){return this.transaction(()=>{
    if(typeof clientMessageId!=='string'||!/^[\w-]{1,100}$/.test(clientMessageId))throw Error('Invalid approval identity');
    const run=this.get(id),existing=this.interactions(id).find(i=>i.client_id===clientMessageId);
    if(existing){if(existing.kind!=='acceptance_approval'||!existing.text.includes(proposalId))throw Error('Approval identity conflict');return {run,reused:true};}
    const proposal=run.acceptanceProposal;
    if(!proposal||proposal.id!==proposalId||!['needs_user','paused'].includes(run.state))throw Error('Acceptance proposal expired');
    const at=new Date().toISOString(),{id:_,state:__,...data}=run;
    Object.assign(data,{acceptance:proposal.acceptance,acceptanceVersion:(run.acceptanceVersion??1)+1,acceptanceHistory:[...(run.acceptanceHistory??[]),{acceptance:run.acceptance,approvedProposal:proposalId,at}],acceptanceProposal:null,nextOutgoing:JSON.stringify({kind:'acceptance_change_approved',runId:id,resultId:run.replyToResultId??null,acceptance:proposal.acceptance})});
    const text='我明确批准验收标准变更 '+proposalId+'：'+JSON.stringify(proposal.acceptance);
    this.db.prepare('UPDATE runs SET data=? WHERE id=?').run(JSON.stringify(data),id);
    this.db.prepare('INSERT INTO interactions VALUES(?,?,?,?,?,?,?,NULL)').run('user-'+randomUUID(),id,clientMessageId,text,'acceptance_approval','queued',at);
    this.notice(id,'user',text);this.event(id,'acceptance_approved',{proposalId,at});return {run:this.get(id),reused:false};
  });}
  acknowledgeInteractions(ids,messageId){for(const id of ids??[])this.db.prepare("UPDATE interactions SET state='delivered',delivered_with=? WHERE id=? AND state='queued'").run(messageId,id);}
  messageAt(id,step,direction){const m=this.db.prepare('SELECT * FROM messages WHERE run_id=? AND step=? AND direction=?').get(id,step,direction);return m?this.decode(m):null;}
  reconcileDelivered(id,result,evidence){return this.transaction(()=>{
    const m=this.message(id);if(m.state!=='uncertain'||!evidence?.requestId||!['native_response','gpt_history','human_confirmed_candidate'].includes(evidence.kind))throw Error('Verified reconciliation evidence required');
    this.db.prepare("UPDATE messages SET state='delivered',result=? WHERE id=?").run(JSON.stringify({...result,reconciliation:evidence}),id);if(m.direction==='gpt')this.acknowledgeInteractions(m.payload.interactionIds,id);this.event(m.runId,'reconciled',{messageId:id,evidence});return this.message(id);
  });}
  update(id,state,patch={}){return this.transaction(()=>{const old=this.get(id);const{id:_,state:__,...data}=old;Object.assign(data,patch,{updatedAt:new Date().toISOString()});this.db.prepare('UPDATE runs SET state=?,data=? WHERE id=?').run(state,JSON.stringify(data),id);this.event(id,state,patch);return this.get(id);});}
  prepare(id,step,direction,payload){return this.transaction(()=>{
    this.get(id);const old=this.db.prepare('SELECT * FROM messages WHERE run_id=? AND step=? AND direction=?').get(id,step,direction);const checksum=hash(payload);
    if(old){if(old.payload_hash!==checksum)throw new Error('Idempotency payload conflict');return this.decode(old);}
    const messageId='msg-'+randomUUID();this.db.prepare('INSERT INTO messages(id,run_id,step,direction,state,payload,payload_hash,result) VALUES(?,?,?,?,?,?,?,NULL)').run(messageId,id,step,direction,'prepared',JSON.stringify(payload),checksum);
    this.event(id,'message_prepared',{messageId,step,direction,hash:checksum});return this.message(messageId);
  });}
  message(id){const m=this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);if(!m)throw new Error('Message not found');return this.decode(m);}
  decode(m){return{id:m.id,runId:m.run_id,step:m.step,direction:m.direction,state:m.state,payload:JSON.parse(m.payload),payloadHash:m.payload_hash,result:m.result?JSON.parse(m.result):null};}
  messages(id){return this.db.prepare('SELECT * FROM messages WHERE run_id=? ORDER BY step,rowid').all(id).map(m=>this.decode(m));}
  markSending(id){return this.transaction(()=>{const m=this.message(id);if(m.state!=='prepared')throw new Error('Message already attempted; reconcile before resending');this.db.prepare('UPDATE messages SET state=? WHERE id=?').run('sending',id);this.event(m.runId,'send_started',{messageId:id});return this.message(id);});}
  notSubmitted(id,error){return this.transaction(()=>{const m=this.message(id);if(m.direction!=='gpt'||m.state!=='sending')throw Error('Only a proven pre-submit GPT failure can be reset');this.db.prepare("UPDATE messages SET state='prepared',result=NULL WHERE id=?").run(id);this.event(m.runId,'not_submitted',{messageId:id,error,reason:'Local upload threw before submit activation'});});}
  delivered(id,result){return this.transaction(()=>{const m=this.message(id);if(m.state!=='sending')throw new Error('Message not in sending state');this.db.prepare('UPDATE messages SET state=?,result=? WHERE id=?').run('delivered',JSON.stringify(result),id);if(m.direction==='gpt')this.acknowledgeInteractions(m.payload.interactionIds,id);this.event(m.runId,'delivered',{messageId:id,resultHash:hash(result)});return this.message(id);});}
  uncertain(id,error){return this.transaction(()=>{const m=this.message(id);if(m.state!=='sending')throw new Error('Only attempted messages may become uncertain');this.db.prepare('UPDATE messages SET state=?,result=? WHERE id=?').run('uncertain',JSON.stringify({error}),id);this.event(m.runId,'uncertain',{messageId:id,error});});}
  // The caller must own the runner lease before recovering, so a dashboard restart
  // cannot change messages that an existing worker process is still delivering.
  recover(token){return this.transaction(()=>{
    const lease=this.db.prepare('SELECT * FROM runner_lease WHERE id=1').get();
    if(!token||lease?.token!==token||lease.pid!==process.pid)throw Error('Runner lease required for recovery');
    const rows=this.db.prepare("SELECT * FROM messages WHERE state='sending'").all();
    for(const row of rows){
      this.db.prepare('UPDATE messages SET state=? WHERE id=?').run('uncertain',row.id);
      const run=this.get(row.run_id);const{id:_,state:__,...data}=run;data.interruptedMessage=row.id;
      this.db.prepare('UPDATE runs SET state=?,data=? WHERE id=?').run('uncertain',JSON.stringify(data),row.run_id);
      this.event(row.run_id,'interrupted_send',{messageId:row.id});
    }
    // A crash after durable delivery but before the next transition is safe to
    // resume from that delivery. Previously these runs stayed "waiting" forever.
    const interrupted=this.db.prepare("SELECT id FROM runs WHERE state IN ('prepared','waiting_gpt','waiting_workbuddy')").all();
    for(const {id} of interrupted){
      const pending=this.messages(id).find(m=>m.state==='uncertain');
      const state=pending?'uncertain':'paused';
      this.db.prepare('UPDATE runs SET state=? WHERE id=?').run(state,id);
      this.event(id,'runner_interrupted',{state,...(pending?{messageId:pending.id}:{})});
    }
    return rows.map(r=>r.id);
  });}
  close(){this.db.close();}
}
