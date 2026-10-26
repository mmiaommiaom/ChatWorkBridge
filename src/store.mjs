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
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs((1)) WHERE state IN ('prepared','waiting_gpt','waiting_workbuddy','uncertain','paused','needs_user');
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES runs(id),step INTEGER NOT NULL,direction TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL,payload_hash TEXT NOT NULL,result TEXT,UNIQUE(run_id,step,direction));
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES runs(id),at TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL);`);
  }
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  acquireRunner(){return this.transaction(()=>{
    const prior=this.db.prepare('SELECT * FROM runner_lease WHERE id=1').get();
    if(prior?.pid){try{process.kill(prior.pid,0);throw Error('Another bridge runner is active');}catch(e){if(e.code!=='ESRCH')throw e;}}
    const token=randomUUID();this.db.prepare('INSERT INTO runner_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid,token=excluded.token').run(process.pid,token);return token;
  });}
  releaseRunner(token){this.db.prepare('UPDATE runner_lease SET pid=NULL,token=NULL WHERE id=1 AND token=?').run(token);}
  event(id,kind,data={}){this.db.prepare('INSERT INTO events(run_id,at,kind,data) VALUES(?,?,?,?)').run(id,new Date().toISOString(),kind,JSON.stringify(data));}
  create(goal,options={}){const id='run-'+randomUUID();const data={goal,...options,createdAt:new Date().toISOString()};this.transaction(()=>{this.db.prepare('INSERT INTO runs VALUES(?,?,?)').run(id,'prepared',JSON.stringify(data));this.event(id,'created');});return this.get(id);}
  get(id){const r=this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);if(!r)throw new Error('Run not found');return{id:r.id,state:r.state,...JSON.parse(r.data)};}
  list(){return this.db.prepare('SELECT * FROM runs ORDER BY rowid DESC LIMIT 30').all().map(r=>({id:r.id,state:r.state,...JSON.parse(r.data)}));}
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
  delivered(id,result){return this.transaction(()=>{const m=this.message(id);if(m.state!=='sending')throw new Error('Message not in sending state');this.db.prepare('UPDATE messages SET state=?,result=? WHERE id=?').run('delivered',JSON.stringify(result),id);this.event(m.runId,'delivered',{messageId:id,resultHash:hash(result)});return this.message(id);});}
  uncertain(id,error){return this.transaction(()=>{const m=this.message(id);if(m.state!=='sending')throw new Error('Only attempted messages may become uncertain');this.db.prepare('UPDATE messages SET state=?,result=? WHERE id=?').run('uncertain',JSON.stringify({error}),id);this.event(m.runId,'uncertain',{messageId:id,error});});}
  recover(){return this.transaction(()=>{const rows=this.db.prepare("SELECT * FROM messages WHERE state='sending'").all();for(const row of rows){this.db.prepare('UPDATE messages SET state=? WHERE id=?').run('uncertain',row.id);const run=this.get(row.run_id);const{id:_,state:__,...data}=run;data.interruptedMessage=row.id;this.db.prepare('UPDATE runs SET state=?,data=? WHERE id=?').run('uncertain',JSON.stringify(data),row.run_id);this.event(row.run_id,'interrupted_send',{messageId:row.id});}return rows.map(r=>r.id);});}
  close(){this.db.close();}
}
