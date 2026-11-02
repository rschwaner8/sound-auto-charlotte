import {receiveSms,createReplyWorker} from './ai-workflow.mjs';
import {adminSetup} from './admin-setup.mjs';
import {initializeKnowledge,saveKnowledge} from './dist/knowledge.js';
import {createAlertDispatcher} from './notifications.mjs';
import {verifyPassword} from './auth.mjs';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync} from 'node:fs';
import {createHash,createHmac,timingSafeEqual,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import * as C from './dist/core.js';
import {canSubmit,submitSms} from './outbox.mjs';
import {draftReply} from './ai-adapter.mjs';
import {metaSignature,retrieveMetaLead} from './meta-adapter.mjs';
const env=process.env,root=fileURLToPath(new URL('.',import.meta.url));mkdirSync(root+'data',{recursive:true});
const db=new DatabaseSync(env.DB_PATH||root+'data/dealerdesk.db');db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);');
if(!db.prepare('SELECT id FROM state WHERE id=1').get())db.prepare('INSERT INTO state VALUES (1,?)').run(JSON.stringify(C.initial()));
const setup=adminSetup(db,env);

const knowledgeSeed=JSON.parse(readFileSync(root+'dist/knowledge-seed.json','utf8'));
const load=()=>{const s=JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body);initializeKnowledge(s,knowledgeSeed);return s;},persist=s=>db.prepare('UPDATE state SET body=? WHERE id=1').run(JSON.stringify(s));
function tx(fn){db.exec('BEGIN IMMEDIATE');try{const s=load(),r=fn(s);persist(s);db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);}
const hash=s=>createHash('sha256').update(s).digest('hex');const sessions=new Map(),attempts=new Map();
function session(req){const id=(req.headers.cookie||'').match(/(?:^|;\s*)session=([^;]+)/)?.[1],s=sessions.get(id);return s&&s.expires>Date.now()?s:null;}
function authorize(req,role='staff'){const s=session(req);if(!s||role==='admin'&&s.role!=='admin')throw Object.assign(Error('Unauthorized'),{status:401});return s;}
function origin(req){if(req.headers.origin&&req.headers.origin!==(env.PUBLIC_ORIGIN||'http://localhost:8787'))throw Object.assign(Error('Origin rejected'),{status:403});}
async function body(req){let b='';for await(const c of req){b+=c;if(Buffer.byteLength(b)>128000)throw Object.assign(Error('Payload too large'),{status:413});}return b;}
function signature(req,raw,path){const p=new URLSearchParams(raw);if(new Set(p.keys()).size!==[...p.keys()].length)return false;let text=(env.PUBLIC_ORIGIN||'')+path;for(const k of [...p.keys()].sort())text+=k+p.get(k);return !!env.TWILIO_AUTH_TOKEN&&equal(createHmac('sha1',env.TWILIO_AUTH_TOKEN).update(text).digest('base64'),req.headers['x-twilio-signature']);}
function queueNew(s,ids){for(const l of s.leads)for(const m of l.messages)if(m.direction==='out'&&!ids.has(m.id)&&m.status==='simulated')m.status='queued';}
function mutate(fn){return tx(s=>{const ids=new Set(s.leads.flatMap(l=>l.messages.map(m=>m.id)));s.clock=Date.now();const r=fn(s);queueNew(s,ids);return r;});}
export function launchProblems(s){return ['LIVE_SEND_APPROVED','A2P_APPROVED','DEALER_FACTS_VERIFIED','INVENTORY_FEED_VERIFIED','CONSENT_REVIEWED','CONTROLLED_TEST_APPROVED'].filter(k=>env[k]!=='true').concat(['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM','PUBLIC_ORIGIN'].filter(k=>!env[k])).concat(s.settings.name==='Demo Motors'?['real dealership settings']:[]);}
let sending=false;
async function flush(){if(sending)return;sending=true;try{const s=load();if(launchProblems(s).length)return;
 for(const l of s.leads)for(const m of l.messages.filter(m=>m.status==='queued')){
 const job=tx(fresh=>{const lead=C.lead(fresh,l.id),msg=lead.messages.find(x=>x.id===m.id);if(msg.status!=='queued')return null;
 // Escalation acknowledgments may have been generated in the same transaction as a takeover; block them conservatively too.
 if(!canSubmit(lead,msg)){msg.status='suppressed';return null;}if(C.hour(fresh,Date.now())<9||C.hour(fresh,Date.now())>=20)return null;msg.status='sending';msg.attemptedAt=Date.now();return {to:lead.phone,body:msg.body};});if(!job)continue;
 try{const result=await submitSms(env,job);tx(f=>{const msg=C.lead(f,l.id).messages.find(x=>x.id===m.id);msg.sid=result.sid;msg.status=result.status||'accepted';});
 }catch{tx(f=>{const lead=C.lead(f,l.id),msg=lead.messages.find(x=>x.id===m.id);msg.status='uncertain';C.alert(f,lead,'SMS delivery uncertain — reconcile provider logs before retry');C.event(f,'send_failure',lead.id,{messageId:m.id});});}
 }
 }finally{sending=false;}}
// At-most-once submission: an interrupted send is never blindly retried.
tx(s=>{for(const l of s.leads){if(l.aiRequest?.status==='drafting'){l.aiRequest.status='failed';C.takeover(s,l.id);C.alert(s,l,'Interrupted AI response — human review needed');}for(const m of l.messages)if(m.status==='sending'){m.status='uncertain';C.alert(s,l,'Interrupted send — reconcile provider logs');}}});

const dispatchAlerts=createAlertDispatcher({load,update:tx,config:env,onError:code=>console.error(code)});
const runReplies=createReplyWorker({load,update:tx,draft:draftReply,config:env});
const timer=setInterval(()=>{try{mutate(s=>C.tick(s));runReplies().catch(()=>console.error('ai_workflow_failure'));flush().catch(()=>console.error('outbox_failure'));dispatchAlerts().catch(()=>console.error('owner_notification_failure'));}catch{console.error('scheduler_failure');}},30000);timer.unref();
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
 try{
 if(path==='/'){res.writeHead(302,{Location:'/ops','Cache-Control':'no-store'});return res.end();}
 if(path==='/health'){return json(res,200,{ok:true,mode:'launch-gated',liveConfigured:launchProblems(load()).length===0});}
 if(path==='/setup'||path==='/setup.js'){res.writeHead(200,{'Content-Type':path==='/setup'?'text/html':'text/javascript','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'"});return res.end(readFileSync(root+(path==='/setup'?'setup.html':'setup.js')));}
 if(await setup.handle(req,res,path))return;
 if(path==='/api/login'&&req.method==='POST'){origin(req);const ip=req.socket.remoteAddress,now=Date.now(),a=attempts.get(ip)||{n:0,at:now};if(now-a.at>900000){a.n=0;a.at=now;}if(++a.n>10)throw Object.assign(Error('Try later'),{status:429});attempts.set(ip,a);const p=JSON.parse(await body(req));const role=p.user==='admin'?'admin':p.user==='staff'?'staff':null;const digest=role==='admin'?setup.digest():role==='staff'?env.STAFF_PASSWORD_DIGEST:null;const legacy=role==='admin'?env.ADMIN_PASSWORD_SHA256:role==='staff'?env.STAFF_PASSWORD_SHA256:null;const valid=digest?verifyPassword(p.password,digest):env.NODE_ENV!=='production'&&!!legacy&&equal(hash(p.password||''),legacy);if(!valid)throw Object.assign(Error('Invalid login'),{status:401});const id=randomBytes(32).toString('hex');sessions.set(id,{role,expires:now+8*3600000});attempts.delete(ip);res.setHeader('Set-Cookie',`session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${env.NODE_ENV==='production'?'; Secure':''}`);return json(res,200,{role});}
 if(path==='/webhooks/meta'&&req.method==='GET'){const q=new URL(req.url,'http://localhost').searchParams;if(env.META_VERIFY_TOKEN&&equal(q.get('hub.verify_token'),env.META_VERIFY_TOKEN)&&q.get('hub.mode')==='subscribe'){res.writeHead(200);return res.end(q.get('hub.challenge'));}throw Object.assign(Error('Meta verification failed'),{status:403});}
 if(path==='/webhooks/meta'&&req.method==='POST'){const raw=await body(req);if(!metaSignature(raw,req.headers['x-hub-signature-256'],env.META_APP_SECRET))throw Object.assign(Error('Meta signature invalid'),{status:403});const payload=JSON.parse(raw);for(const entry of payload.entry||[]){if(entry.id!==env.META_PAGE_ID)throw Object.assign(Error('Unapproved Meta Page'),{status:403});for(const change of entry.changes||[])if(change.field==='leadgen'){const p=await retrieveMetaLead(change.value.leadgen_id);mutate(s=>C.ingest(s,p));}for(const msg of entry.messaging||[])if(msg.message?.text&&!msg.message.is_echo){mutate(s=>{const ext='page:'+msg.sender.id;let l=s.leads.find(l=>l.metaPsid===msg.sender.id);if(!l){l=C.ingest(s,{source:'Facebook Page',externalId:ext,name:'Facebook Page customer'});l.metaPsid=msg.sender.id;}if(!s.receipts.some(r=>r.key==='page-message:'+msg.message.mid)){s.receipts.push({key:'page-message:'+msg.message.mid,leadId:l.id});C.message(s,l,msg.message.text,'in','received');l.summary=msg.message.text.slice(0,240);l.lastInbound=Date.now();C.alert(s,l,'Page message needs human reply — use Meta inbox until send approval');}});}}return json(res,200,{ok:true});}
 if(path.startsWith('/webhooks/twilio/')&&req.method==='POST'){const raw=await body(req);if(!signature(req,raw,path))throw Object.assign(Error('Invalid webhook signature'),{status:403});const p=Object.fromEntries(new URLSearchParams(raw));
 if(path.endsWith('/inbound')){if(p.AccountSid!==env.TWILIO_ACCOUNT_SID||p.To!==env.TWILIO_FROM)throw Object.assign(Error('SMS destination rejected'),{status:403});tx(s=>receiveSms(s,p));runReplies().catch(()=>console.error('ai_workflow_failure'));}
 else if(path.endsWith('/status')){tx(s=>{for(const l of s.leads)for(const m of l.messages)if(m.sid===p.MessageSid){const rank={queued:0,sending:1,accepted:2,sent:3,delivered:4,undelivered:4,failed:4};if((rank[p.MessageStatus]??-1)>=(rank[m.status]??-1))m.status=p.MessageStatus;if(['failed','undelivered'].includes(p.MessageStatus))C.alert(s,l,'SMS delivery failed');}});}else throw Error('Unknown webhook');res.writeHead(200,{'Content-Type':'text/xml'});return res.end('<Response/>');}
 if(path==='/api/intake'&&req.method==='POST'){if(!env.INTAKE_TOKEN||!equal(req.headers.authorization,'Bearer '+env.INTAKE_TOKEN))throw Object.assign(Error('Unauthorized intake'),{status:401});const p=JSON.parse(await body(req));const l=mutate(s=>C.ingest(s,p));return json(res,201,{id:l.id});}
 if(path.startsWith('/api/')){const user=authorize(req);if(req.method==='GET'&&path==='/api/state')return json(res,200,load());if(req.method==='GET'&&path==='/api/readiness')return json(res,200,{blocks:launchProblems(load()),adapters:{twilio:'credentials configured; live delivery unverified',metaLeadForms:'requires provider setup',metaPage:'not connected',marketplace:'unsupported',cargurus:'delivery unverified',autotrader:'delivery unverified'}});origin(req);const p=JSON.parse(await body(req));
 if(path==='/api/draft'){const s=load(),l=C.lead(s,p.id),inventory=s.inventory.filter(v=>Date.now()-v.verifiedAt<s.settings.inventoryMaxAgeHours*3600000);return json(res,200,await draftReply({settings:s.settings,inventory,conversation:l.messages.slice(-20),knowledgeBase:s.knowledge}));}
 const result=mutate(s=>{if(path==='/api/lead')return C.ingest(s,p);if(path==='/api/reply')return C.inbound(s,p.id,p.body,p.externalId||crypto.randomUUID());if(path==='/api/takeover')return C.takeover(s,p.id,p.value);if(path==='/api/stage')return C.setStage(s,p.id,p.stage);if(path==='/api/book')return C.book(s,p.id,p.start);if(path==='/api/appointment')return C.appointmentStatus(s,p.id,p.appointmentId,p.status);if(path==='/api/resolve'){const a=s.alerts.find(a=>a.id===p.alertId);if(!a)throw Error('Alert missing');a.resolved=true;C.event(s,'alert_resolved',a.leadId,{alertId:a.id});return;}if(path==='/api/note'){C.lead(s,p.id).notes.push({body:String(p.body).slice(0,4000),by:user.role,at:s.clock});return;}
 if(path==='/api/human'){const l=C.lead(s,p.id);if(l.optOut||!l.consent?.granted)throw Error('SMS consent required');C.takeover(s,p.id);const m=C.message(s,l,String(p.body).slice(0,1600));m.human=true;return m;}
 if(path==='/api/knowledge'){if(user.role!=='admin')throw Object.assign(Error('Admin required'),{status:403});const row=saveKnowledge(s.knowledge,p,user.role);C.event(s,'knowledge_updated',null,{id:row.id,revision:row.revision,status:row.status});return row;}if(path==='/api/inventory'){if(user.role!=='admin')throw Object.assign(Error('Admin required'),{status:403});if(!Array.isArray(p.vehicles)||p.vehicles.some(v=>!v.id||!v.make||!v.model||!Number.isFinite(v.price)||v.price<0||!Number.isFinite(v.mileage)||!['available','sold','pending'].includes(v.status)))throw Error('Invalid inventory');s.inventory=p.vehicles.map(v=>({...v,verifiedAt:Date.now()}));C.event(s,'inventory_import',null,{count:p.vehicles.length});return;}
 if(path==='/api/settings'){if(user.role!=='admin')throw Object.assign(Error('Admin required'),{status:403});if(!p.name||!p.timezone||!p.hours||p.hours.start>=p.hours.end)throw Error('Invalid settings');new Intl.DateTimeFormat('en-US',{timeZone:p.timezone});s.settings={...s.settings,name:p.name,timezone:p.timezone,hours:p.hours,weeklyHours:p.weeklyHours,address:p.address};C.event(s,'settings',null);return;}throw Object.assign(Error('Unknown endpoint'),{status:404});});return json(res,200,{ok:true,result});}
 // The hosted review UI is explicitly browser-only. Production uses /ops and authenticated API.
 if(path==='/ops'){res.writeHead(200,{'Content-Type':'text/html','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});return res.end(readFileSync(root+'ops.html'));}
 if(path==='/ops.js'){res.writeHead(200,{'Content-Type':'text/javascript'});return res.end(readFileSync(root+'ops.js'));}
 const file={'/demo':'index.html','/app.js':'app.js','/core.js':'core.js','/knowledge.js':'knowledge.js','/knowledge-ui.js':'knowledge-ui.js','/knowledge-seed.json':'knowledge-seed.json','/style.css':'style.css'}[path];if(!file)return json(res,404,{error:'Not found'});res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html'});res.end(readFileSync(root+'dist/'+file));
 }catch(e){json(res,e.status||400,{error:e.status===500?'Internal error':e.message});}});
server.listen(Number(env.PORT||8787),env.HOST||'127.0.0.1',()=>console.log('DealerDesk: http://localhost:'+(env.PORT||8787)+' (demo /, operations /ops)'));
process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0);}));
