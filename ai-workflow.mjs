import * as C from './dist/core.js';

// Provider calls never run inside a database transaction. A draft is accepted
// only if the triggering inbound message and conversation authority still match.
export function receiveSms(s,p,now=Date.now()) {
 if(!p.MessageSid||!p.From||!p.To)throw Error('Incomplete SMS webhook');
 if(s.receipts.some(r=>r.key==='in:'+p.MessageSid))return null;
 let l=s.leads.find(l=>l.phone===p.From);
 if(!l)l=C.ingest(s,{name:'Incoming SMS',phone:p.From,source:'Website',externalId:p.MessageSid},now);
 if(!l.optOut&&!l.consent?.granted){l.consent={granted:true,scope:'inquiry-replies',evidence:'Customer initiated SMS to dealership number',at:now,recordedAt:now,messageSid:p.MessageSid};C.event(s,'consent',l.id,l.consent);}
 const first=l.messages.length===0;
 // Reuse core STOP/human protections, but never accept its simulated reply as AI.
 const generated=C.inbound(s,l.id,p.Body||'',p.MessageSid,now);
 if(generated){generated.status='suppressed';generated.body='[Rule-based draft replaced by Charlotte workflow]';}
 for(const old of l.messages)if(old.direction==='out'&&!old.human&&['queued','ai-review','drafting'].includes(old.status))old.status='superseded';
 if(!C.eligible(l))return l;
 if(/\b(human|manager|complaint|refund|lawyer|guarantee|approved|apr|monthly payment|best price|discount)\b/i.test(p.Body||'')){C.takeover(s,l.id);C.alert(s,l,'Owner decision required');return l;}
 const inbound=l.messages.filter(m=>m.direction==='in').at(-1);
 l.aiRequest={messageId:inbound.id,status:'pending',first,createdAt:now};
 return l;
}

export function createReplyWorker({load,update,draft,config={}}){
 let busy=false;
 return async function run(){
  if(busy||config.AI_DRAFTING_ENABLED!=='true')return;
  busy=true;
  try{
   for(const original of load().leads){
    if(original.aiRequest?.status!=='pending')continue;
    const job=update(s=>{
     const l=C.lead(s,original.id),r=l.aiRequest;
     if(r?.status!=='pending'||!C.eligible(l))return null;
     const count=s.aiDraftAttempts||0;
     if(count>=20){r.status='blocked';C.alert(s,l,'AI test allowance exhausted');return null;}
     s.aiDraftAttempts=count+1;r.status='drafting';
     return {id:l.id,messageId:r.messageId,settings:s.settings,inventory:s.inventory.filter(v=>v.status==='available'&&Number.isFinite(v.verifiedAt)&&v.verifiedAt<=Date.now()&&Date.now()-v.verifiedAt<s.settings.inventoryMaxAgeHours*3600000),conversation:l.messages.filter(m=>m.direction==='in'||!['suppressed','superseded'].includes(m.status)).slice(-20),knowledgeBase:s.knowledge||[]};
    });
    if(!job)continue;
    try{
     const reply=await draft(job);
     if(typeof reply.text!=='string'||!reply.text.trim()||reply.text.length>1600)throw Error('Invalid AI response');
     update(s=>{const l=C.lead(s,job.id),r=l.aiRequest;if(r?.messageId!==job.messageId||r.status!=='drafting'||!C.eligible(l)||l.messages.filter(m=>m.direction==='in').at(-1)?.id!==job.messageId)return;
      const m=C.message(s,l,reply.text.trim(),'out','ai-review');m.ai=true;m.triggerMessageId=job.messageId;r.status='review';
      // Automatic SMS remains a separate, explicitly gated activation.
      if(config.AI_AUTO_SEND_APPROVED==='true'&&config.CONTROLLED_TEST_APPROVED==='true'&&l.phone===config.TEST_PHONE){m.status='queued';r.status='queued';}
     });
    }catch{update(s=>{const l=C.lead(s,job.id);if(l.aiRequest?.messageId===job.messageId)l.aiRequest.status='failed';C.takeover(s,l.id);C.alert(s,l,'Charlotte response failed — human reply needed');});}
   }
  }finally{busy=false;}
 };
}
