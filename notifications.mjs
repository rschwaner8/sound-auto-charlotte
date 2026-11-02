// Optional owner notification transport. Customer bodies and phone numbers never leave through this adapter.
export function dueAlerts(state,now=Date.now()){
 return state.alerts.filter(a=>!a.resolved&&!a.notification?.deliveredAt&&(a.notification?.attempts||0)<5&&(a.notification?.nextAttemptAt||0)<=now);
}
export function notificationPayload(alert,origin){
 const url=new URL(origin);if(url.protocol!=='https:')throw Error('CRM origin must use HTTPS');
 return {type:'dealerdesk_attention',eventId:alert.id,leadId:alert.leadId,reason:alert.reason,url:url.origin+'/ops',createdAt:alert.at};
}
export async function sendAlert(alert,config,fetcher=fetch){
 if(config.OWNER_NOTIFICATIONS_APPROVED!=='true')throw Error('Owner notification delivery not approved');
 const target=new URL(config.OWNER_ALERT_WEBHOOK_URL||'');if(target.protocol!=='https:'||target.username||target.password)throw Error('Notification destination must be HTTPS without URL credentials');
 if(!config.OWNER_ALERT_WEBHOOK_TOKEN)throw Error('Notification secret not configured');
 const response=await fetcher(target.href,{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+config.OWNER_ALERT_WEBHOOK_TOKEN,'Content-Type':'application/json','Idempotency-Key':alert.id},body:JSON.stringify(notificationPayload(alert,config.PUBLIC_ORIGIN)),signal:AbortSignal.timeout(10000)});
 if(!response.ok)throw Error('Owner notification delivery failed');return true;
}
export function recordAttempt(alert,ok,now=Date.now()){
 const attempts=(alert.notification?.attempts||0)+1;alert.notification={attempts,...(ok?{deliveredAt:now}:{nextAttemptAt:now+Math.min(3600000,60000*2**(attempts-1)),failedAt:now})};
}
export function createAlertDispatcher({load,update,config,fetcher=fetch,clock=Date.now,onError=()=>{}}){let running=false;return async()=>{
 if(running||config.OWNER_NOTIFICATIONS_APPROVED!=='true')return;running=true;
 try{for(const candidate of dueAlerts(load(),clock())){
 const current=load().alerts.find(a=>a.id===candidate.id);if(!current||!dueAlerts({alerts:[current]},clock()).length)continue;
 let ok=false;try{await sendAlert(current,config,fetcher);ok=true;}catch{onError('owner_notification_failure');}
 update(state=>{const a=state.alerts.find(a=>a.id===current.id);if(a)recordAttempt(a,ok,clock());});
 }}finally{running=false;}
 };}
