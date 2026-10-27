import { getIdentityConfig, login, logout, signup, refreshSession, requestPasswordRecovery, confirmEmail, recoverPassword, acceptInvite, verifyRequestOrigin, getSettings, AuthError } from '@netlify/identity';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { records } from '../../db/schema.js';
import { plannedTimes } from '../../db/attendance-automation.js';
import { assistantPropose, assistantApply, operationsWrite, defaultOpeningHours, validateOpening, importNovemberRoster } from '../../db/operations-assistant.js';

type Item = Record<string, any>;
const clean = (v: unknown, max=120) => String(v??'').trim().slice(0,max);
const reply = (value: unknown, status=200) => Response.json(value, {status,headers:{'Cache-Control':'no-store'}});
const employees: Item[] = [
  {id:'martin',username:'martin',name:'Martin',role:'Vedoucí barman',contract:'HPP – plný úvazek',grossRate:185,netRate:150,active:true,email:'iz.marti@seznam.com'},
  {id:'daniela',username:'daniela',name:'Daniela',role:'Vedoucí barmanka',contract:'HPP – plný úvazek',grossRate:180,netRate:145,active:true,email:''},
];
const managerEmail='barneysbarlounge@gmail.com';
const emailOf=(v:unknown)=>clean(v,254).toLowerCase();
const validEmail=(v:string)=>!v||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const rows = async (kind:string):Promise<Item[]> => (await db.select().from(records).where(eq(records.kind,kind))).map(r=>r.payload as Item);
const get = async (kind:string,id:string):Promise<Item|undefined> => (await db.select().from(records).where(eq(records.key,`${kind}:${id}`)))[0]?.payload as Item|undefined;
async function save(kind:string,item:Item){await operationsWrite(async tx=>{await tx.insert(records).values({key:`${kind}:${item.id}`,kind,payload:item}).onConflictDoUpdate({target:records.key,set:{payload:item}})})}
// Attendance corrections use the restaurant's timezone, including daylight saving time.
function pragueTime(value:string){
  const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Prague',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));
  const v=(type:string)=>parts.find(p=>p.type===type)!.value;
  return `${v('year')}-${v('month')}-${v('day')}T${v('hour')}:${v('minute')}:${v('second')}`;
}
function correctionTime(value:unknown,original?:string){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(value))return null;
  const local=value.length===16?value+':00':value;
  if(original&&pragueTime(original)===local)return original;
  const base=Date.parse(local+'Z');
  if(!Number.isFinite(base))return null;
  // Try both Czech offsets; a nonexistent spring-forward time matches neither.
  for(const hours of [2,1]){
    const iso=new Date(base-hours*3600000).toISOString();
    if(pragueTime(iso)===local)return iso;
  }
  return null;
}
async function seed(){
  // The one-time production reset and initial profiles commit atomically.
  await db.transaction(async tx=>{
    const inserted=await tx.insert(records).values({key:'meta:production-v1',kind:'meta',payload:{version:1}}).onConflictDoNothing().returning();
    if(!inserted.length)return;
    await tx.delete(records).where(inArray(records.kind,['emp','shift','plan','event','revenue']));
    await tx.insert(records).values(employees.map(e=>({key:`emp:${e.id}`,kind:'emp',payload:e})));
  });
}
async function allowedEmail(email:string){
  return email===managerEmail||(await rows('emp')).some(e=>e.active&&e.email&&emailOf(e.email)===email);
}
async function sessionUser(req:Request){
  const refreshed=await refreshSession();
  const cookie=req.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith('nf_jwt='));
  let token=refreshed;
  if(!token&&cookie){try{token=decodeURIComponent(cookie.slice(7))}catch{return null}}
  if(!token)return null;
  // Identity 2.0 getUser() prefers the platform operator token over the user's
  // cookie. Validate the actual session with Identity, including confirmed_at.
  const identityUrl=getIdentityConfig()?.url??new URL('/.netlify/identity',req.url).href;
  let response:Response;
  try{response=await fetch(`${identityUrl.replace(/\/$/,'')}/user`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)})}
  catch{throw new AuthError('Identity unavailable',503)}
  if(response.status===401||response.status===403)return null;
  if(!response.ok)throw new AuthError('Identity unavailable',503);
  const user=await response.json();
  return {id:user.id,email:user.email,confirmedAt:user.confirmed_at};
}
async function authAction(q:Item):Promise<Response|undefined>{
  if(!String(q.action).startsWith('auth.'))return;
  const email=emailOf(q.email);
  if(q.action==='auth.logout'){await logout();return reply({ok:true})}
  if(q.action==='auth.confirm'){await confirmEmail(clean(q.token,2048));return reply({ok:true})}
  if(q.action==='auth.recover'||q.action==='auth.invite'){
    if(typeof q.password!=='string'||q.password.length<10||q.password.length>128)return reply({error:'Použijte heslo o délce 10 až 128 znaků.'},400);
    if(q.action==='auth.recover')await recoverPassword(clean(q.token,2048),q.password);
    else await acceptInvite(clean(q.token,2048),q.password);
    return reply({ok:true});
  }
  if(q.action==='auth.recovery'){
    if(await allowedEmail(email))await requestPasswordRecovery(email);
    return reply({ok:true,message:'Pokud je účet nastavený, přijde vám e-mail pro obnovení hesla.'});
  }
  if(!['auth.login','auth.signup'].includes(q.action))return reply({error:'Neznámá operace přihlášení.'},400);
  if(!await allowedEmail(email))return reply({error:'Pro tento e-mail není nastavený přístup. Obraťte se na správce.'},403);
  if(typeof q.password!=='string'||!q.password||q.password.length>128)return reply({error:'Vyplňte heslo.'},400);
  if(q.action==='auth.signup'){
    if(q.password.length<10)return reply({error:'Použijte heslo alespoň o 10 znacích.'},400);
    const settings=await getSettings();
    if(settings.autoconfirm)return reply({error:'Aktivace účtu vyžaduje zapnuté ověřování e-mailu. Obraťte se na správce.'},503);
    await signup(email,q.password);
    return reply({ok:true,message:'Zkontrolujte e-mail a potvrďte aktivaci účtu. Poté se přihlaste.'});
  }
  const user=await login(email,q.password);
  if(!user.confirmedAt){await logout();return reply({error:'Nejprve potvrďte svůj e-mail.'},403)}
  return reply({ok:true});
}
export default async (req:Request) => {
  if(req.method!=='POST')return reply({error:'Použijte POST'},405);
  try{verifyRequestOrigin(req)}catch{return reply({error:'Požadavek musí pocházet z této aplikace.'},403)}
  let q:Item;try{q=await req.json();if(!q||typeof q!=='object'||Array.isArray(q))throw Error()}catch{return reply({error:'Neplatná data'},400)}
  try{
    await seed();
    const auth=await authAction(q);if(auth)return auth;
    const user=await sessionUser(req);
    if(!user?.email||!user.confirmedAt)return reply({error:'Přihlaste se ke svému účtu.',code:'AUTH_REQUIRED'},401);
    const action=q.action;
    const account=emailOf(user.email);
    const manager=account===managerEmail;
    const employee=manager?undefined:(await rows('emp')).find(e=>e.email&&emailOf(e.email)===account&&e.active);
    if(!manager&&!employee)return reply({error:'Účet nemá přístup. Obraťte se na správce.'},403);
    const support=!manager&&employee!.role==='Výpomoc';
    if(support&&!['session','dashboard','support.submit'].includes(action))return reply({error:'Výpomoc má přístup pouze k vlastním směnám, výdělku a přehledu akcí.'},403);
    if(action==='session')return reply({user:{id:employee?.id??'spravce',role:manager?'manager':'employee'}});
    if(action==='dashboard'){
      let rosterImport:Item;
      try{rosterImport=await importNovemberRoster()}catch{rosterImport={total:0,errors:['Rozpis se nepodařilo uložit. Žádné částečné změny nebyly provedeny; uložení se zopakuje automaticky.']}}
      const [allEmp,shifts,plans,events,revenue]=await Promise.all(['emp','shift','plan','event','revenue'].map(rows));
      return reply({rosterImport,me:manager?{name:'Správa Barney’s',role:'manager'}:employee,employees:manager?allEmp:allEmp.filter(e=>e.id===employee!.id),shifts:shifts.filter(s=>manager||s.employeeId===employee!.id),plans:plans.filter(s=>manager||s.employeeId===employee!.id),events,requests:(manager||support)?(await rows('shiftRequest')).filter(r=>manager||r.employeeId===employee!.id):[],openingHours:manager?((await get('settings','opening'))?.days??defaultOpeningHours):undefined,revenue:support?[]:revenue.filter(r=>manager||r.employeeId===employee!.id)});
    }
    if(action==='support.submit'){
      if(!support)return reply({error:'Tento zápis je určen výpomoci.'},403);
      const id=clean(q.id,60),start=correctionTime(q.start),end=correctionTime(q.end);
      if(!/^[a-f0-9-]{36}$/.test(id)||!start||!end||Date.parse(end)<=Date.parse(start)||Date.parse(end)>Date.now())return reply({error:'Vyplňte platný příchod a pozdější odchod v minulosti (český čas).'},400);
      return await operationsWrite(async tx=>{
        await tx.select().from(records).where(eq(records.key,`emp:${employee!.id}`)).for('update');
        const existing=(await tx.select().from(records).where(eq(records.key,`shiftRequest:${id}`)))[0]?.payload as Item|undefined;
        if(existing)return reply(existing.employeeId===employee!.id&&existing.start===start&&existing.end===end?{ok:true}:{error:'Identifikátor již byl použit.'},existing.employeeId===employee!.id&&existing.start===start&&existing.end===end?200:409);
        const occupied=(await tx.select().from(records).where(inArray(records.kind,['shift','shiftRequest']))).map(r=>r.payload as Item);
        if(occupied.some(s=>s.employeeId===employee!.id&&s.status!=='rejected'&&Date.parse(s.start)<Date.parse(end)&&Date.parse(start)<(s.end?Date.parse(s.end):Infinity)))return reply({error:'Zápis se překrývá s jinou směnou nebo žádostí.'},409);
        const item={id,employeeId:employee!.id,start,end,status:'pending',submittedAt:new Date().toISOString()};
        await tx.insert(records).values({key:`shiftRequest:${id}`,kind:'shiftRequest',payload:item});
        return reply({ok:true});
      });
    }
    if(action==='clock'){
      const employeeId=manager?clean(q.employeeId,60):employee!.id;
      const e=await get('emp',employeeId);
      if(!e?.active)return reply({error:'Vyberte aktivního zaměstnance.'},400);
      if(!['start','end'].includes(q.mode))return reply({error:'Neplatná operace'},400);
      const result=await db.transaction(async tx=>{
        // Lock the employee row so simultaneous clicks cannot open overlapping shifts.
        await tx.select().from(records).where(eq(records.key,`emp:${employeeId}`)).for('update');
        const open=(await tx.select().from(records).where(eq(records.kind,'shift'))).map(r=>r.payload as Item).filter(s=>s.employeeId===employeeId&&!s.end);
        if(q.mode==='start'&&open.length)return {error:'Směna již běží'};
        if(q.mode==='end'&&open.length!==1)return {error:'Není nalezena právě jedna otevřená směna'};
        const gps=null;
        const now=Date.now();
        const plans=(await tx.select().from(records).where(eq(records.kind,'plan'))).map(r=>r.payload as Item).filter(p=>p.employeeId===employeeId).map(p=>({plan:p,times:plannedTimes(p)})).filter(p=>p.times&&now>=p.times.start-4*3600000&&now<p.times.end).sort((a,b)=>Math.abs(a.times!.start-now)-Math.abs(b.times!.start-now));
        const planId=plans[0]?.plan.id;

        const item=q.mode==='start'?{id:randomUUID(),employeeId,...(planId?{planId}:{}),start:new Date().toISOString(),end:null,startGps:gps,endGps:null,grossRate:e.grossRate,netRate:e.netRate}:{...open[0],end:new Date().toISOString(),endGps:gps};
        await tx.insert(records).values({key:`shift:${item.id}`,kind:'shift',payload:item}).onConflictDoUpdate({target:records.key,set:{payload:item}});
        return {ok:true,item};
      });
      return reply(result,'error' in result?409:200);
    }
    if(action==='revenue.save'){
      const date=clean(q.date,10),raw=String(q.amount??'').trim(),amount=Number(raw);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)return reply({error:'Neplatné datum'},400);
      if(!raw||!Number.isFinite(amount)||amount<0||amount>1e10)return reply({error:'Vyplňte platnou nezápornou tržbu.'},400);
      const id=clean(q.id,60);
      if(!/^[a-f0-9-]{36}$/.test(id))return reply({error:'Neplatný identifikátor odeslání.'},400);
      const item={id,date,amount:Math.round(amount*100)/100,note:clean(q.note,220),employeeId:employee?.id??null,submittedBy:employee?.name??'Správce',submittedAt:new Date().toISOString()};
      return await operationsWrite(async tx=>{
        const inserted=await tx.insert(records).values({key:`revenue:${id}`,kind:'revenue',payload:item}).onConflictDoNothing().returning();
        if(!inserted.length){
          const existing=(await tx.select().from(records).where(eq(records.key,`revenue:${id}`)))[0]?.payload as Item|undefined;
          if(existing?.employeeId!==item.employeeId||existing?.date!==date||existing?.amount!==item.amount||existing?.note!==item.note)return reply({error:'Tento požadavek už byl odeslán s jinými údaji. Obnovte přehled.'},409);
        }
        return reply({ok:true});
      });
    }
    if(!manager)return reply({error:'Tuto operaci může provést pouze správce.'},403);
    if(action==='support.review'){
      if(!['approved','rejected'].includes(q.status))return reply({error:'Neplatné rozhodnutí.'},400);
      return await operationsWrite(async tx=>{
        const key=`shiftRequest:${clean(q.id,60)}`;
        const current=(await tx.select().from(records).where(eq(records.key,key)).for('update'))[0]?.payload as Item|undefined;
        if(!current)return reply({error:'Žádost nebyla nalezena.'},404);
        if(current.status!=='pending')return reply(current.status===q.status?{ok:true}:{error:'Žádost již byla vyřízena.'},current.status===q.status?200:409);
        const e=(await tx.select().from(records).where(eq(records.key,`emp:${current.employeeId}`)).for('update'))[0]?.payload as Item|undefined;
        if(q.status==='approved'){
          if(!e?.active||![e.grossRate,e.netRate].every(v=>Number.isFinite(v)&&v>=0))return reply({error:'Zaměstnanec není aktivní nebo nemá platné sazby.'},400);
          const shifts=(await tx.select().from(records).where(eq(records.kind,'shift'))).map(r=>r.payload as Item);
          if(shifts.some(s=>s.employeeId===current.employeeId&&Date.parse(s.start)<Date.parse(current.end)&&Date.parse(current.start)<(s.end?Date.parse(s.end):Infinity)))return reply({error:'Směna se překrývá s docházkou. Nejprve opravte evidenci.'},409);
          await tx.insert(records).values({key:`shift:${current.id}`,kind:'shift',payload:{id:current.id,employeeId:current.employeeId,start:current.start,end:current.end,grossRate:e!.grossRate,netRate:e!.netRate,approvedAt:new Date().toISOString(),approvedBy:account}});
        }
        const item={...current,status:q.status,reviewedAt:new Date().toISOString(),reviewedBy:account};
        await tx.insert(records).values({key,kind:'shiftRequest',payload:item}).onConflictDoUpdate({target:records.key,set:{payload:item}});
        return reply({ok:true});
      });
    }
    if(action==='assistant.propose'||action==='assistant.apply'){
      try{
        if(action==='assistant.apply')return reply(await assistantApply(clean(q.id,60),account));
        const prompt=clean(q.prompt,6000);
        if(!prompt)return reply({error:'Napište požadavek pro asistenta.'},400);
        return reply(await assistantPropose(prompt,Array.isArray(q.history)?q.history:[],account));
      }catch(error){return reply({error:error instanceof Error&&error.name==='AssistantValidationError'?error.message:'Asistent je dočasně nedostupný. Žádné změny nebyly uloženy.'},400)}
    }
    if(action==='opening.save'){
      try{await save('settings',{id:'opening',days:validateOpening(q.days)});return reply({ok:true})}
      catch{return reply({error:'Vyplňte platnou otevírací dobu všech sedmi dnů.'},400)}
    }
    if(action==='shift.save'||action==='shift.delete'){
      const id=clean(q.id,60),existing=await get('shift',id);
      if(!existing)return reply({error:'Směna nebyla nalezena. Obnovte přehled.'},404);
      const result=await operationsWrite(async tx=>{
        await tx.select().from(records).where(eq(records.key,`emp:${existing.employeeId}`)).for('update');
        const shifts=(await tx.select().from(records).where(eq(records.kind,'shift'))).map(r=>r.payload as Item);
        const current=shifts.find(s=>s.id===id);
        if(!current)return {error:'Směna již neexistuje.'};
        if(action==='shift.delete'){
          const plans=(await tx.select().from(records).where(eq(records.kind,'plan'))).map(r=>r.payload as Item);
          for(const plan of plans){
            const times=plannedTimes(plan);
            if(plan.employeeId===current.employeeId&&(current.planId===plan.id||(!current.planId&&times&&Date.parse(current.start)<=times.end&&(!current.end||Date.parse(current.end)>times.start))))await tx.insert(records).values({key:`automation:${plan.id}`,kind:'automation',payload:{shiftId:current.id}}).onConflictDoNothing();
          }
          await tx.delete(records).where(eq(records.key,`shift:${id}`));
          return {ok:true};
        }
        const start=correctionTime(q.start,current.start),end=q.end===''||q.end===null?null:correctionTime(q.end,current.end);
        if(!start||(q.end!==''&&q.end!==null&&!end))return {error:'Vyplňte platný příchod a odchod v českém čase.'};
        if(Date.parse(start)>Date.now()||(end&&Date.parse(end)>Date.now()))return {error:'Docházka nemůže být v budoucnosti.'};
        if(end&&Date.parse(end)<=Date.parse(start))return {error:'Odchod musí být později než příchod.'};
        if(shifts.some(s=>s.id!==id&&s.employeeId===current.employeeId&&Date.parse(s.start)<(end?Date.parse(end):Infinity)&&Date.parse(start)<(s.end?Date.parse(s.end):Infinity)))return {error:'Časy se překrývají s jinou směnou zaměstnance.'};
        const item={...current,start,end,automationOverride:true};
        await tx.insert(records).values({key:`shift:${id}`,kind:'shift',payload:item}).onConflictDoUpdate({target:records.key,set:{payload:item}});
        return {ok:true};
      });
      return reply(result,'error' in result?409:200);
    }
    if(action==='employee.save'){
      const id=clean(q.id,60)||randomUUID(),username=clean(q.username,40).toLowerCase();
      if(!/^[a-z0-9._-]{3,40}$/.test(username)||username==='spravce')return reply({error:'Uživatelské jméno: 3–40 znaků bez mezer'},400);
      if((await rows('emp')).some(e=>e.username===username&&e.id!==id))return reply({error:'Uživatelské jméno již existuje'},409);
      const email=emailOf(q.email);
      if(!validEmail(email)||email===managerEmail)return reply({error:'Vyplňte platný zaměstnanecký e-mail, nebo jej nechte prázdný.'},400);
      if(email&&(await rows('emp')).some(e=>emailOf(e.email)===email&&e.id!==id))return reply({error:'E-mail již používá jiný zaměstnanec.'},409);
      const item={id,username,email,name:clean(q.name,80),role:clean(q.role,60),contract:clean(q.contract,60),grossRate:Number(q.grossRate),netRate:Number(q.netRate),active:!!q.active};
      if(!item.name||![item.grossRate,item.netRate].every(v=>Number.isFinite(v)&&v>=0))return reply({error:'Doplňte jméno a platné nezáporné sazby.'},400);
      await save('emp',item);return reply({ok:true,employee:item});
    }
    if(['plan.save','event.save'].includes(action)){
      const kind=action.split('.')[0],id=clean(q.id,60)||randomUUID(),date=clean(q.date,10);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)return reply({error:'Neplatné datum'},400);
      let item:Item={id,date,note:clean(q.note,220)};
      if(kind==='plan'){
        const e=await get('emp',clean(q.employeeId,60));
        if(!e?.active)return reply({error:'Zaměstnanec nenalezen'},400);
        item={...item,employeeId:e.id,from:clean(q.from,5),to:clean(q.to,5)};
        if(![item.from,item.to].every(t=>/^([01]\d|2[0-3]):[0-5]\d$/.test(t)))return reply({error:'Neplatný čas'},400);
      }else if(kind==='event'){
        item.title=clean(q.title,100);if(!item.title)return reply({error:'Doplňte název akce'},400);
      }
      await save(kind,item);return reply({ok:true,item});
    }
    if(action==='record.delete'){
      const kind=clean(q.kind,12);if(!['plan','event','revenue'].includes(kind))return reply({error:'Neplatný typ'},400);
      await operationsWrite(async tx=>{await tx.delete(records).where(and(eq(records.kind,kind),eq(records.key,`${kind}:${clean(q.id,60)}`)))});return reply({ok:true});
    }
    return reply({error:'Neznámá operace'},400);
  }catch(error){
    if(error instanceof AuthError)return reply({error:error.status===400||error.status===401?'Přihlášení nebo odkaz se nepodařilo ověřit. Zkontrolujte e-mail a heslo, případně obnovte heslo.':error.status===422?'Účet již může existovat nebo heslo nesplňuje požadavky. Zkuste přihlášení nebo obnovu hesla.':'Přihlašovací služba je dočasně nedostupná. Zkuste to znovu.'},error.status&&error.status>=400&&error.status<500?error.status:503);
    const cause=error instanceof Error?(error as Error & {cause?:{name?:string,code?:string}}).cause:undefined;
    console.error('team.operation.failed',{type:error instanceof Error?error.name:'Unknown',causeType:cause?.name??'Unknown',code:/^[A-Z0-9_]{1,30}$/.test(cause?.code??'')?cause?.code:undefined});
    return reply({error:'Operaci se nepodařilo dokončit. Zkuste to znovu.'},500)
  }
};
