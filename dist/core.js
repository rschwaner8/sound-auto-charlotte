export const sources=['CarGurus','AutoTrader','Facebook lead form','Facebook Page','Marketplace manual','Website'];
export const stages=['New','Engaged','Qualified','Appointment','Visited','Sold','Lost'];
const uid=()=>crypto.randomUUID();
export function initial(now=Date.now()){return {version:1,clock:now,leads:[],inventory:[],jobs:[],events:[],receipts:[],alerts:[],settings:{name:'Demo Motors',timezone:'America/Los_Angeles',hours:{start:9,end:18},live:false,inventoryMaxAgeHours:24}};}
export function event(s,type,leadId,detail={}){s.events.push({id:uid(),type,leadId,detail,at:s.clock});}
export function lead(s,id){const l=s.leads.find(l=>l.id===id);if(!l)throw Error('Lead not found');return l;}
export function alert(s,l,reason){if(!s.alerts.some(a=>a.leadId===l.id&&a.reason===reason&&!a.resolved))s.alerts.push({id:uid(),leadId:l.id,reason,resolved:false,at:s.clock});}
export function cancel(s,id,kind){for(const j of s.jobs)if(j.leadId===id&&j.status==='pending'&&(!kind||j.kind===kind))j.status='cancelled';}
export function message(s,l,body,direction='out',status='simulated'){const m={id:uid(),body,direction,status,at:s.clock};l.messages.push(m);event(s,'message',l.id,{messageId:m.id,direction,status});return m;}
export function eligible(l){return !!l.phone&&!!l.consent?.granted&&!l.optOut&&!l.takeover&&!['Sold','Lost'].includes(l.stage);}
export function schedule(s,l,now=s.clock){cancel(s,l.id,'followup');if(!eligible(l)||l.appointments.some(a=>a.status==='booked'))return;[24,72,168].forEach((h,i)=>s.jobs.push({id:uid(),leadId:l.id,kind:'followup',step:i,due:now+h*3600000,status:'pending',generation:l.lastInbound}));}
export function takeover(s,id,value=true){const l=lead(s,id);l.takeover=value;cancel(s,id);event(s,value?'takeover':'resume',id);if(!value)schedule(s,l);}
export function setStage(s,id,stage){if(!stages.includes(stage))throw Error('Invalid stage');const l=lead(s,id);l.stage=stage;if(['Sold','Lost','Appointment'].includes(stage))cancel(s,id,'followup');event(s,'stage',id,{stage});}
export function ingest(s,p,now=Date.now()){
 if(!sources.includes(p.source)||!p.externalId||!p.name)throw Error('Name, source and external ID required');s.clock=now;
 const key=p.source+':'+p.externalId,r=s.receipts.find(r=>r.key===key);if(r)return lead(s,r.leadId);
 const phone=p.phone?String(p.phone).replace(/[ ()-]/g,''):'';if(phone&&!/^\+[1-9]\d{7,14}$/.test(phone))throw Error('Phone requires E.164 format');
 let l=s.leads.find(l=>phone&&l.phone===phone);if(!l){l={id:uid(),name:String(p.name).slice(0,120),phone,source:p.source,sources:[p.source],vehicleId:p.vehicleId||'',stage:'New',takeover:false,optOut:false,consent:null,messages:[],notes:[],appointments:[],createdAt:now,lastInbound:now,summary:'New inquiry; needs qualification.'};s.leads.push(l);}else if(!l.sources.includes(p.source))l.sources.push(p.source);
 s.receipts.push({key,leadId:l.id,at:now});if(!l.optOut&&p.consent?.granted&&p.consent.evidence&&p.consent.at){l.consent={...p.consent,recordedAt:now};event(s,'consent',l.id,l.consent);}
 event(s,'lead_intake',l.id,{source:p.source,externalId:p.externalId});if(p.body)inbound(s,l.id,p.body,key,now);else schedule(s,l);return l;
}
export function answer(s,l,text){const t=text.toLowerCase(),v=s.inventory.find(v=>v.id===l.vehicleId);
 if(/human|manager|complaint|refund|lawyer|accident|warranty|apr|interest rate|guarantee|approved|credit score|monthly payment|discount|best price/.test(t)){alert(s,l,'Manager decision needed');takeover(s,l.id);return 'I will have a team member help with that. I cannot promise financing approval, rates, payments, discounts, or condition beyond verified records.';}
 if(/book|appointment|test drive|come (in|by)|reschedule/.test(t)){alert(s,l,'Appointment time needs confirmation');return 'Happy to arrange a visit. What day and time work for you? Our team will confirm an available slot here.';}
 if(/price|available|mileage|miles|stock|color|vehicle|car|suv|truck/.test(t)){
 if(!v||!v.verifiedAt||s.clock-v.verifiedAt>s.settings.inventoryMaxAgeHours*3600000){alert(s,l,'Inventory verification needed');return 'I need to verify current vehicle details before quoting availability or pricing. Which vehicle are you interested in?';}
 if(v.status!=='available')return 'Our latest verified record marks that vehicle unavailable. What budget and features would you like in an alternative?';
 return `Our verified listing for the ${v.year} ${v.make} ${v.model} shows $${v.price.toLocaleString()} and ${v.mileage.toLocaleString()} miles. Taxes and fees are additional unless the listing says otherwise. Availability can change; we will reconfirm before your visit. What would you like to know next?`;
 }
 if(/too (much|expensive)|budget|afford/.test(t))return 'What price range feels comfortable? We can look at verified inventory in that range. Financing terms require lender review.';
 if(/trade/.test(t))return 'What year, make, model, and approximate mileage is your trade-in? Final value requires an appraisal.';
 return `Thanks for contacting ${s.settings.name}. I am the automated sales assistant. What vehicle are you looking for, and when would you like to visit? Reply STOP to opt out.`;
}
export function inbound(s,id,text,externalId,now=Date.now()){
 const l=lead(s,id),key='in:'+externalId;if(s.receipts.some(r=>r.key===key))return null;s.receipts.push({key,leadId:id,at:now});s.clock=now;
 message(s,l,String(text).slice(0,4000),'in','received');l.lastInbound=now;cancel(s,id,'followup');
 if(/^(stop|stopall|unsubscribe|cancel|end|quit|revoke|opt out)\b|do not (text|contact)|don't (text|contact)/i.test(text.trim())){l.optOut=true;l.consent=null;cancel(s,id);event(s,'opt_out',id);return null;}
 if(l.optOut)return null;l.summary=String(text).slice(0,240);if(l.stage==='New')l.stage='Engaged';
 if(l.takeover){alert(s,l,'Reply awaiting human');return null;}if(!eligible(l)){alert(s,l,'SMS consent required');return null;}
 const m=message(s,l,answer(s,l,text));schedule(s,l);return m;
}
export function hour(s,at){return Number(new Intl.DateTimeFormat('en-US',{timeZone:s.settings.timezone,hour:'numeric',hourCycle:'h23'}).formatToParts(at).find(p=>p.type==='hour').value);}
export function openHours(s,at){const day=new Intl.DateTimeFormat('en-US',{timeZone:s.settings.timezone,weekday:'short'}).format(at);const index=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(day);return s.settings.weeklyHours?.[index]||s.settings.hours;}
export function book(s,id,start,now=Date.now()){
 const l=lead(s,id),at=Date.parse(start);if(!Number.isFinite(at)||at<=now)throw Error('Choose a future appointment');if(hour(s,at)<openHours(s,at).start||hour(s,at)>=openHours(s,at).end)throw Error('Outside opening hours');
 if(s.leads.some(x=>x.appointments.some(a=>a.status==='booked'&&Math.abs(a.start-at)<1800000)))throw Error('Appointment slot unavailable');
 for(const a of l.appointments)if(a.status==='booked')a.status='rescheduled';cancel(s,id);s.clock=now;const a={id:uid(),start:at,status:'booked'};l.appointments.push(a);l.stage='Appointment';
 for(const [kind,due]of [['confirmation',now],['reminder',at-86400000],['reminder',at-7200000],['missed',at+3600000]])if(due>=now)s.jobs.push({id:uid(),leadId:id,appointmentId:a.id,kind,due,status:'pending'});
 event(s,'appointment',id,a);return a;
}
export function appointmentStatus(s,id,aid,status){if(!['cancelled','visited','missed'].includes(status))throw Error('Invalid status');const l=lead(s,id),a=l.appointments.find(a=>a.id===aid);if(!a)throw Error('Appointment missing');a.status=status;cancel(s,id);if(status==='visited')l.stage='Visited';if(status==='cancelled'){l.stage='Engaged';schedule(s,l);}if(status==='missed')alert(s,l,'Missed appointment');event(s,'appointment_'+status,id,{appointmentId:aid});}
export function tick(s,now=Date.now()){
 s.clock=now;for(const j of s.jobs){if(j.status!=='pending'||j.due>now)continue;const l=lead(s,j.leadId);if(j.kind==='followup'&&s.jobs.some(x=>x!==j&&x.leadId===j.leadId&&x.kind==='followup'&&x.status==='pending'&&x.due>j.due&&x.due<=now)){j.status='cancelled';continue;}if(!eligible(l)){j.status='cancelled';continue;}if(hour(s,now)<9||hour(s,now)>=20)continue;
 const a=l.appointments.find(a=>a.id===j.appointmentId);if(j.kind==='followup'&&(l.lastInbound!==j.generation||l.appointments.some(a=>a.status==='booked'))){j.status='cancelled';continue;}if(j.appointmentId&&a?.status!=='booked'){j.status='cancelled';continue;}
 const body=j.kind==='followup'?['Still interested in finding the right vehicle? I can arrange a visit. Reply STOP to opt out.','Would you like us to check current inventory for you? Reply STOP to opt out.','I will close out automatic check-ins for now. Reply whenever you are ready. Reply STOP to opt out.'][j.step]:`${j.kind==='confirmation'?'Your visit is confirmed for':j.kind==='reminder'?'Reminder: your visit is':'We missed you for your visit on'} ${new Intl.DateTimeFormat('en-US',{timeZone:s.settings.timezone,dateStyle:'medium',timeStyle:'short'}).format(a.start)} (${s.settings.timezone}). Reply to reschedule. Reply STOP to opt out.`;
 if(j.kind==='missed'){a.status='missed';alert(s,l,'Missed appointment');}message(s,l,body);j.status='completed';event(s,'job_completed',l.id,{jobId:j.id});
 }return s;
}
export function report(s){return sources.map(source=>{const ls=s.leads.filter(l=>l.source===source);return {source,leads:ls.length,appointments:ls.filter(l=>l.appointments.length).length,visits:ls.filter(l=>l.appointments.some(a=>a.status==='visited')).length,sales:ls.filter(l=>l.stage==='Sold').length};});}
export function seed(){const now=Date.now(),s=initial(now);s.inventory=[{id:'D104',year:2021,make:'Toyota',model:'RAV4 XLE',price:24950,mileage:42810,status:'available',verifiedAt:now},{id:'D108',year:2020,make:'Honda',model:'Accord Sport',price:21900,mileage:58120,status:'available',verifiedAt:now},{id:'D112',year:2022,make:'Ford',model:'F-150 XLT',price:34900,mileage:36100,status:'sold',verifiedAt:now}];
 [['Jordan Rivera','CarGurus','D104','Is the vehicle still available?'],['Alex Morgan','AutoTrader','D108','Can you guarantee financing approval?'],['Taylor Brooks','Facebook lead form','D104','I have a trade-in'],['Casey Lane','Marketplace manual','D112','Interested in the truck']].forEach((a,i)=>ingest(s,{name:a[0],source:a[1],vehicleId:a[2],externalId:'demo-'+i,phone:'+1202555010'+i,consent:i===3?null:{granted:true,evidence:'SIMULATED opt-in form v1',at:now},body:a[3]},now));return s;}
