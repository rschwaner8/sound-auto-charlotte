export const knowledgeCategories=['General','Visits','Inventory','Financing','Trades','Payments & fees','Ownership & service'];
export function initializeKnowledge(state,seed){if(!Array.isArray(state.knowledge))state.knowledge=structuredClone(seed);return state.knowledge;}
export function saveKnowledge(entries,input,actor='Dealer admin',now=Date.now()){
 const old=input.id?entries.find(e=>e.id===input.id):null;if(input.id&&!old)throw Error('Answer not found');if(old&&input.revision!==old.revision)throw Error('This answer changed. Reload before saving.');
 const question=String(input.question||'').trim(),answer=String(input.answer||'').trim(),category=input.category||'General',status=input.status||'draft';
 if(question.length<5||question.length>300)throw Error('Question must contain 5–300 characters');if(answer.length>4000)throw Error('Answer is too long');if(!knowledgeCategories.includes(category)||!['active','draft','archived'].includes(status))throw Error('Invalid category or status');
 if(status==='active'&&!answer)throw Error('An active answer cannot be empty');if(status==='active'&&old?.reviewReason&&!input.reviewConfirmed)throw Error('Confirm this policy has been reviewed before activation');
 if(status==='active'&&old?.reviewReason?.includes('Screenshot cuts off')&&answer===old.originalAnswer)throw Error('Complete the clipped answer before activation');
 if(status==='active'&&/guaranteed?\s+(approval|financing)|everyone\s+(is\s+)?approved|100%\s+(approval|approved)/i.test(answer))throw Error('Approval guarantees are outside Charlotte’s authority');
 const expiresAt=input.expiresAt?Date.parse(input.expiresAt):null;if(expiresAt!==null&&(!Number.isFinite(expiresAt)||expiresAt<=now))throw Error('Review expiry must be in the future');
 const duplicate=entries.find(e=>e.id!==old?.id&&e.status!=='archived'&&e.question.toLowerCase()===question.toLowerCase());if(duplicate&&status!=='archived')throw Error('That question already exists');
 const row={...old,id:old?.id||crypto.randomUUID(),question,answer,category,status,source:old?.source||'Dealer-entered answer',reviewReason:old?.reviewReason||'',expiresAt,updatedAt:now,updatedBy:actor,revision:(old?.revision||0)+1,reviewedAt:status==='active'?now:old?.reviewedAt||null,history:[...(old?.history||[]),...(old?[{question:old.question,answer:old.answer,status:old.status,revision:old.revision,at:old.updatedAt,by:old.updatedBy}]:[])]};
 if(old)entries[entries.indexOf(old)]=row;else entries.push(row);return row;
}
export function activeKnowledge(entries,now=Date.now()){return (entries||[]).filter(e=>e.status==='active'&&e.answer.trim()&&(!e.expiresAt||e.expiresAt>now));}
export function knowledgeContext(entries,query='',now=Date.now()){
 const words=String(query).toLowerCase().match(/[a-z0-9]{3,}/g)||[];
 return activeKnowledge(entries,now).map(e=>({e,score:words.reduce((n,w)=>n+(e.question+' '+e.answer+' '+e.category).toLowerCase().includes(w),0)})).sort((a,b)=>b.score-a.score).slice(0,10).map(({e})=>({id:e.id,question:e.question,answer:e.answer,category:e.category,source:e.source,revision:e.revision}));
}
