import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { randomUUID, createHash } from 'node:crypto';
import vm from 'node:vm';

// Exercise the real dispatcher with isolated Identity and database boundaries.
// No user accounts, emails, or persistent records are created by these tests.
function setup() {
  const store = new Map([['shift:old', {key:'shift:old',kind:'shift',payload:{id:'old'}}]]);
  const state = {user:null,settings:{autoconfirm:false},signups:0,refreshed:null,identityStatus:200,aiResult:{message:'Hotovo k náhledu.',commands:[]}};
  const eq = (key,value) => row => row[key]===value;
  const and = (...filters) => row => filters.every(f=>f(row));
  const inArray = (key,values) => row => values.includes(row[key]);
  const records = {key:'key',kind:'kind'};
  const db = {
    select:()=>({from:()=>({where:filter=>{
      const result=[...store.values()].filter(filter).map(r=>structuredClone(r));
      return {then:(resolve,reject)=>Promise.resolve(result).then(resolve,reject),for:async()=>result};
    }})}),
    insert:()=>({values:input=>{
      let ignore=false,update;
      const execute=()=>{const result=[];for(const item of Array.isArray(input)?input:[input]){
        if(state.failKey===item.key)throw Error('Simulated database failure');
        if(store.has(item.key)){if(ignore)continue;if(update)store.set(item.key,{...store.get(item.key),...update});else throw Error('duplicate');}
        else store.set(item.key,structuredClone(item));result.push(structuredClone(store.get(item.key)));
      }return result};
      const query={onConflictDoNothing(){ignore=true;return query},onConflictDoUpdate({set}){update=set;return query},returning:async()=>execute(),then:(resolve,reject)=>Promise.resolve().then(execute).then(resolve,reject)};
      return query;
    }}),
    delete:()=>({where:async filter=>{for(const [key,row] of store)if(filter(row))store.delete(key)}}),
    transaction:async fn=>{const snapshot=structuredClone(store);try{return await fn(db)}catch(e){store.clear();for(const [k,v] of snapshot)store.set(k,v);throw e}},
  };
  class AuthError extends Error {}
  const source=readFileSync(new URL('../netlify/functions/team.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replace('export default async','const handler = async');
  const context=vm.createContext({Response,Date,Number,String,Math,JSON,URL,AbortSignal,decodeURIComponent,randomUUID,createHash,structuredClone,OpenAI:class{constructor(){this.chat={completions:{create:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(state.aiResult)}}]})}}}},db,records,eq,and,inArray,AuthError,
    getIdentityConfig:()=>({url:'https://example.test/.netlify/identity',token:'operator-test'}),
    refreshSession:async()=>state.refreshed,
    fetch:async(url,options)=>{
      assert.equal(url,'https://example.test/.netlify/identity/user');
      if(state.identityStatus!==200)return Response.json({}, {status:state.identityStatus});
      if(!state.user||options.headers.Authorization!==`Bearer ${state.refreshed||'session-test'}`)return Response.json({}, {status:401});
      return Response.json({...state.user,confirmed_at:state.user.confirmedAt});
    },
    login:async()=>state.user,logout:async()=>{state.user=null},
    signup:async()=>{state.signups++},getSettings:async()=>state.settings,
    requestPasswordRecovery:async()=>{},confirmEmail:async()=>{},recoverPassword:async()=>{},acceptInvite:async()=>{},
    verifyRequestOrigin:req=>{if(req.headers.get('Origin')!==new URL(req.url).origin)throw Error('origin')},
  });
  const automationSource=readFileSync(new URL('../db/attendance-automation.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replaceAll('export ','');
  const automation=vm.runInContext(stripTypeScriptTypes(automationSource)+';({automateAttendance,plannedTimes})',context);
  context.plannedTimes=automation.plannedTimes;
  const assistantSource=readFileSync(new URL('../db/operations-assistant.ts',import.meta.url),'utf8').replace(/^import .*;\n/gm,'').replaceAll('export ','');
  const assistant=vm.runInContext('(function(){'+stripTypeScriptTypes(assistantSource)+';return {assistantPropose,assistantApply,operationsWrite,defaultOpeningHours,validateOpening,expandPattern,prepareChanges,openingPlan,wageSummary,importNovemberRoster}})()',context);
  Object.assign(context,assistant);
  const handler=vm.runInContext(stripTypeScriptTypes(source)+';handler',context);
  const request=async(action,body={},headers={})=>{
    const response=await handler(new Request('https://example.test/api/team',{method:'POST',headers:{Origin:'https://example.test','Content-Type':'application/json',...(state.user?{Cookie:'nf_jwt=session-test'}:{}),...headers},body:JSON.stringify({action,...body})}));
    return {status:response.status,body:await response.json()};
  };
  const as=async id=>{
    if(!store.has('emp:martin'))await request('session');
    state.user=id==='manager'?{id:'identity-manager',email:'barneysbarlounge@gmail.com',confirmedAt:'2026-01-01'}:id?{id:'identity-'+id,email:store.get('emp:'+id)?.payload.email,confirmedAt:'2026-01-01'}:null;
  };
  return {store,state,request,as,automate:automation.automateAttendance,plannedTimes:automation.plannedTimes,assistant};
}

test('public demo header cannot impersonate a manager; origin check is enforced',async()=>{
  const {request}=setup();
  assert.equal((await request('dashboard',{}, {'X-Demo-Account':'spravce'})).status,401);
  assert.equal((await request('login',{username:'spravce'})).status,401);
  assert.equal((await request('dashboard',{}, {Origin:'https://other.test'})).status,403);
});
test('session verifies the user cookie instead of the platform operator token, including refreshed sessions',async()=>{
  const {request,as,state}=setup();await as('manager');
  assert.equal((await request('session')).status,200);
  assert.equal((await request('session',{}, {Cookie:''})).status,401);
  assert.equal((await request('session',{}, {Cookie:'nf_jwt=forged'})).status,401);
  assert.equal((await request('session',{}, {Cookie:'nf_jwt=%ZZ'})).status,401);
  state.refreshed='renewed-session-test';
  assert.equal((await request('session')).status,200);
  state.identityStatus=401;
  assert.equal((await request('session')).status,401);
  state.identityStatus=503;
  assert.equal((await request('session')).status,503);
});
test('one-time reset leaves two profiles, zero hours and correct Martin rate; later visits preserve records',async()=>{
  const {store,request,as}=setup();await as('manager');
  assert.equal(store.has('shift:old'),false);
  assert.equal(store.get('emp:martin').payload.netRate,150);
  assert.equal(store.get('emp:daniela').payload.email,'');
  store.set('event:new',{key:'event:new',kind:'event',payload:{id:'new'}});
  await request('dashboard');await request('dashboard');
  assert.equal(store.has('event:new'),true);
  const result=await request('dashboard');assert.equal(result.body.employees.length,2);assert.equal(result.body.shifts.length,0);
});
test('employee submits revenue; manager sees author and timestamp; retry cannot duplicate or overwrite',async()=>{
  const {request,as}=setup();await as('martin');
  const body={id:randomUUID(),date:'2026-10-23',amount:'1234.50',note:'Karta',employeeId:'daniela',submittedBy:'forged'};
  assert.equal((await request('revenue.save',body)).status,200);
  assert.equal((await request('revenue.save',body)).status,200);
  assert.equal((await request('revenue.save',{...body,amount:'1'})).status,409);
  await as('manager');const result=await request('dashboard');
  assert.equal(result.body.revenue.length,1);const revenue=result.body.revenue[0];
  assert.equal(revenue.amount,1234.5);assert.equal(revenue.employeeId,'martin');assert.equal(revenue.submittedBy,'Martin');assert.ok(Date.parse(revenue.submittedAt));
});
test('revenue and attendance are scoped; employees cannot manage profiles or delete records',async()=>{
  const {request,store,as}=setup();await as('manager');
  const daniela={...store.get('emp:daniela').payload,email:'daniela@example.test'};
  assert.equal((await request('employee.save',daniela)).status,200);
  await as('daniela');const id=randomUUID();
  assert.equal((await request('revenue.save',{id,date:'2026-10-23',amount:99})).status,200);
  await as('martin');const dashboard=await request('dashboard');
  assert.equal(dashboard.body.revenue.length,0);assert.equal(dashboard.body.employees.length,1);
  assert.equal((await request('employee.save',daniela)).status,403);
  assert.equal((await request('record.delete',{kind:'revenue',id})).status,403);
  await as('manager');assert.equal((await request('dashboard')).body.revenue.length,1);
});
test('invalid revenue values and impossible dates are rejected',async()=>{
  const {request,as}=setup();await as('martin');
  for(const amount of ['',-1,'Infinity','NaN',null,10000000001])assert.equal((await request('revenue.save',{id:randomUUID(),date:'2026-10-23',amount})).status,400);
  assert.equal((await request('revenue.save',{id:randomUUID(),date:'2026-02-30',amount:100})).status,400);
});
test('email can be configured later, duplicates are blocked and inactive or unconfirmed users cannot access',async()=>{
  const {request,as,store,state}=setup();await as('daniela');assert.equal((await request('session')).status,401);
  await as('manager');const daniela={...store.get('emp:daniela').payload};
  assert.equal((await request('employee.save',{...daniela,email:store.get('emp:martin').payload.email})).status,409);
  assert.equal((await request('employee.save',{...daniela,email:'barneysbarlounge@gmail.com'})).status,400);
  assert.equal((await request('employee.save',{...daniela,email:'daniela@example.test'})).status,200);
  await as('daniela');assert.equal((await request('session')).status,200);
  state.user.confirmedAt=undefined;assert.equal((await request('session')).status,401);
  await as('manager');await request('employee.save',{...daniela,email:'daniela@example.test',active:false});
  await as('daniela');assert.equal((await request('session')).status,403);
});
test('clock uses server time, ignores submitted employee/GPS, and refuses overlapping shifts',async()=>{
  const {request,as}=setup();await as('martin');
  const start=await request('clock',{mode:'start',employeeId:'daniela',gps:{lat:0,lon:0},start:'2000-01-01'});
  assert.equal(start.status,200);assert.equal(start.body.item.employeeId,'martin');assert.equal(start.body.item.startGps,null);assert.ok(Date.parse(start.body.item.start)>Date.parse('2026-01-01'));
  assert.equal((await request('clock',{mode:'start'})).status,409);
  assert.equal((await request('clock',{mode:'end'})).status,200);
  assert.equal((await request('clock',{mode:'end'})).status,409);
});
test('manager corrects and deletes only the selected attendance; existing data and rates survive',async()=>{
  const {request,as,store}=setup();await as('manager');
  const shift={id:'kept',employeeId:'martin',start:'2026-10-20T12:00:00.000Z',end:'2026-10-20T18:00:00.000Z',netRate:150,grossRate:185,startGps:null};
  store.set('shift:kept',{key:'shift:kept',kind:'shift',payload:shift});
  const other={...shift,id:'other',employeeId:'daniela'};
  store.set('shift:other',{key:'shift:other',kind:'shift',payload:other});
  const body={id:'kept',start:'2026-10-20T15:00:00',end:'2026-10-20T21:00:00'};
  await as('martin');
  assert.equal((await request('shift.save',body)).status,403);
  assert.equal((await request('shift.delete',{id:'kept'})).status,403);
  await as('manager');assert.equal((await request('shift.save',body)).status,200);
  const saved=store.get('shift:kept').payload;
  assert.equal(saved.start,'2026-10-20T13:00:00.000Z');assert.equal(saved.end,'2026-10-20T19:00:00.000Z');
  assert.equal(saved.netRate,150);assert.equal(saved.grossRate,185);assert.equal(saved.employeeId,'martin');
  assert.equal((await request('shift.delete',{id:'kept'})).status,200);
  assert.equal(store.has('shift:kept'),false);assert.deepEqual(store.get('shift:other').payload,other);
  await request('dashboard');assert.deepEqual(store.get('shift:other').payload,other);
});
test('attendance corrections reject invalid dates, reversed times, future times and overlaps',async()=>{
  const {request,as,store}=setup();await as('manager');
  for(const [id,start,end] of [['a','2026-10-20T12:00:00Z','2026-10-20T16:00:00Z'],['b','2026-10-20T18:00:00Z',null]])store.set('shift:'+id,{key:'shift:'+id,kind:'shift',payload:{id,employeeId:'martin',start,end}});
  for(const [start,end] of [['bad',''],['2026-02-30T12:00',''],['2026-03-29T02:30',''],['2026-10-20T15:00','2026-10-20T14:00'],['2099-01-01T12:00',''],['2026-10-20T15:00','2026-10-20T21:00'],['2026-10-20T15:00','']])assert.equal((await request('shift.save',{id:'a',start,end})).status,409);
  assert.equal(store.get('shift:a').payload.start,'2026-10-20T12:00:00Z');
  assert.equal((await request('shift.save',{id:'missing',start:'2026-10-20T15:00',end:''})).status,404);
});
test('manager can enter a historical revenue from an operations message without replacing existing records',async()=>{
  const {request,as}=setup();await as('martin');
  await request('revenue.save',{id:randomUUID(),date:'2026-10-20',amount:123});
  await as('manager');const body={id:randomUUID(),date:'2026-10-19',amount:'456.50',note:'Ze zprávy provozu'};
  assert.equal((await request('revenue.save',body)).status,200);
  assert.equal((await request('revenue.save',body)).status,200);
  const result=(await request('dashboard')).body.revenue;assert.equal(result.length,2);
  assert.equal(result.find(r=>r.id===body.id).submittedBy,'Správce');
});

test('automation starts after 30 minutes at planned time and closes one hour after planned end exactly once',async()=>{
  const {as,store,automate}=setup();await as('manager');
  const at=s=>Date.parse('2026-10-23T'+s+'Z');
  await automate(at('10:00:00'));
  const plan={id:'scheduled',employeeId:'martin',date:'2026-10-23',from:'14:00',to:'22:00'};
  store.set('plan:scheduled',{key:'plan:scheduled',kind:'plan',payload:plan});
  await automate(at('12:29:59'));assert.equal(store.has('shift:auto-scheduled'),false);
  await automate(at('12:30:00'));
  let shift=store.get('shift:auto-scheduled').payload;
  assert.equal(shift.start,'2026-10-23T12:00:00.000Z');assert.equal(shift.end,null);assert.equal(shift.autoStart,true);assert.match(shift.autoStartNote,/uplynul limit/);
  await automate(at('20:59:59'));assert.equal(store.get('shift:auto-scheduled').payload.end,null);
  await automate(at('21:03:00'));shift=store.get('shift:auto-scheduled').payload;
  assert.equal(shift.end,'2026-10-23T21:00:00.000Z');assert.equal(shift.autoEnd,true);
  await automate(at('21:04:00'));assert.equal([...store.values()].filter(r=>r.kind==='shift').length,1);
});
test('automation preserves manual clock times and does not recreate a manager-deleted shift',async()=>{
  const {as,store,automate,request}=setup();await as('manager');
  const at=s=>Date.parse('2026-10-22T'+s+'Z');await automate(at('10:00:00'));
  store.set('plan:p',{key:'plan:p',kind:'plan',payload:{id:'p',employeeId:'martin',date:'2026-10-22',from:'14:00',to:'22:00'}});
  store.set('shift:manual',{key:'shift:manual',kind:'shift',payload:{id:'manual',employeeId:'martin',start:'2026-10-22T12:10:00Z',end:'2026-10-22T20:10:00Z',netRate:150}});
  await automate(at('12:30:00'));await automate(at('21:00:00'));
  const shift=store.get('shift:manual').payload;assert.equal(shift.start,'2026-10-22T12:10:00Z');assert.equal(shift.end,'2026-10-22T20:10:00Z');assert.equal(shift.autoStart,undefined);assert.equal(shift.autoEnd,undefined);
  assert.equal((await request('shift.delete',{id:'manual'})).status,200);
  await automate(at('21:10:00'));assert.equal([...store.values()].filter(r=>r.kind==='shift').length,0);
});
test('automation closes a manually opened planned shift and respects manager corrections',async()=>{
  const {as,store,automate,request}=setup();await as('manager');
  const at=s=>Date.parse('2026-10-22T'+s+'Z');await automate(at('10:00:00'));
  store.set('plan:p',{key:'plan:p',kind:'plan',payload:{id:'p',employeeId:'martin',date:'2026-10-22',from:'14:00',to:'22:00'}});
  store.set('shift:manual',{key:'shift:manual',kind:'shift',payload:{id:'manual',employeeId:'martin',planId:'p',start:'2026-10-22T12:10:00Z',end:null}});
  await automate(at('21:00:00'));assert.equal(store.get('shift:manual').payload.end,'2026-10-22T21:00:00.000Z');
  assert.equal((await request('shift.save',{id:'manual',start:'2026-10-22T14:10:00',end:'2026-10-22T22:30:00'})).status,200);
  await automate(at('21:10:00'));assert.equal(store.get('shift:manual').payload.end,'2026-10-22T20:30:00.000Z');
});
test('automation does not backfill history, inactive staff or overlapping shifts',async()=>{
  const {as,store,automate}=setup();await as('manager');
  const now=Date.parse('2026-10-23T10:00:00Z');await automate(now);
  store.set('plan:old',{key:'plan:old',kind:'plan',payload:{id:'old',employeeId:'martin',date:'2026-10-20',from:'14:00',to:'22:00'}});
  const p={employeeId:'martin',date:'2026-10-23',from:'14:00',to:'22:00'};
  store.set('plan:new',{key:'plan:new',kind:'plan',payload:{...p,id:'new'}});
  store.get('emp:martin').payload.active=false;await automate(now+3*3600000);assert.equal(store.has('shift:auto-new'),false);
  store.get('emp:martin').payload.active=true;
  store.set('shift:other',{key:'shift:other',kind:'shift',payload:{id:'other',employeeId:'martin',planId:'different',start:'2026-10-23T11:00:00Z',end:null}});
  await automate(now+3*3600000);assert.equal(store.has('shift:auto-new'),false);assert.equal(store.has('shift:auto-old'),false);
});
test('planned times use Czech winter and summer offsets, handle overnight shifts and reject nonexistent times',()=>{
  const {plannedTimes}=setup();
  const night=plannedTimes({date:'2026-10-24',from:'22:00',to:'04:00'});
  assert.equal(new Date(night.start).toISOString(),'2026-10-24T20:00:00.000Z');
  assert.equal(new Date(night.close).toISOString(),'2026-10-25T04:00:00.000Z');
  assert.equal(plannedTimes({date:'2026-03-29',from:'02:30',to:'08:00'}),null);
  assert.equal(plannedTimes({date:'2026-02-30',from:'14:00',to:'22:00'}),null);
});

test('assistant and opening settings require a verified manager',async()=>{
  const {request,as,state}=setup();await as('martin');
  for(const action of ['assistant.propose','assistant.apply','opening.save'])assert.equal((await request(action,{prompt:'Souhrn',days:[]})).status,403);
  await as('manager');state.user.confirmedAt=null;
  assert.equal((await request('assistant.propose',{prompt:'Souhrn'})).status,401);
});
test('opening defaults match supplied week; settings validate and persist without rewriting plans',async()=>{
  const {request,as,store,assistant}=setup();await as('manager');
  const initial=await request('dashboard');assert.deepEqual(initial.body.openingHours,[['08:30','18:30'],['08:30','18:30'],['08:30','18:30'],['08:30','21:30'],['14:30','00:00'],['14:30','00:00'],['14:30','21:30']]);
  store.set('plan:p',{key:'plan:p',kind:'plan',payload:{id:'p',employeeId:'martin',date:'2026-11-02',from:'08:00',to:'18:30'}});
  const days=initial.body.openingHours;days[0]=null;days[4]=['16:00','01:30'];
  assert.equal((await request('opening.save',{days})).status,200);
  assert.equal((await request('dashboard')).body.openingHours[0],null);
  assert.equal(store.get('plan:p').payload.from,'08:00');
  for(const invalid of [[],[null],Array(7).fill(['25:00','18:30']),Array(7).fill(['08:30','08:30'])])assert.equal((await request('opening.save',{days:invalid})).status,400);
  assert.equal(assistant.openingPlan('2026-11-02',days),null);
});
test('alternating weeks expand deterministically with weekday opening hours, midnight, and DST',()=>{
  const {assistant,plannedTimes}=setup();
  const pattern={kind:'pattern',target:'plan',employeeId:'martin',startDate:'2026-10-19',endDate:'2026-11-01',anchorMonday:'2026-10-19',firstWeek:'long'};
  const entries=assistant.expandPattern(pattern,assistant.defaultOpeningHours);
  assert.deepEqual(Array.from(entries,p=>p.date),['2026-10-19','2026-10-20','2026-10-24','2026-10-25','2026-10-28','2026-10-29','2026-10-30']);
  assert.equal(entries[0].from,'08:00');assert.equal(entries[0].to,'18:30');
  assert.equal(entries[2].from,'14:00');assert.equal(entries[2].to,'00:00');
  assert.equal(new Date(plannedTimes(entries[2]).end).toISOString(),'2026-10-24T22:00:00.000Z');
  const sunday=plannedTimes(entries[3]);assert.equal(new Date(sunday.start).toISOString(),'2026-10-25T13:00:00.000Z');
  assert.throws(()=>assistant.expandPattern({...pattern,anchorMonday:'2026-10-20'},assistant.defaultOpeningHours));
});
test('monthly assistant proposal is preview only, applies once, and preserves existing records',async()=>{
  const {request,as,state,store}=setup();await as('manager');
  store.set('event:keep',{key:'event:keep',kind:'event',payload:{id:'keep',date:'2026-11-01',title:'Zachovat'}});
  state.aiResult={message:'Návrh pro Martina.',commands:[{kind:'pattern',target:'plan',employeeId:'martin',startDate:'2026-11-01',endDate:'2026-11-30',anchorMonday:'2026-11-02',firstWeek:'long'}]};
  const draft=await request('assistant.propose',{prompt:'Naplánuj listopad dle schématu'});
  assert.equal(draft.status,200);assert.ok(draft.body.changes.length>10);assert.equal([...store.values()].filter(r=>r.kind==='plan').length,0);
  assert.equal((await request('assistant.apply',{id:draft.body.id,changes:[{kind:'emp',delete:true}]})).status,200);
  const count=[...store.values()].filter(r=>r.kind==='plan').length;assert.equal(count,draft.body.changes.length);
  assert.equal((await request('assistant.apply',{id:draft.body.id})).body.alreadyApplied,true);
  assert.equal([...store.values()].filter(r=>r.kind==='plan').length,count);assert.equal(store.get('event:keep').payload.title,'Zachovat');
  const again=await request('assistant.propose',{prompt:'Znovu stejné schéma'});assert.equal(again.body.changes.length,0);
});
test('assistant supports a complete atomic swap and rejects conflicts without business writes',async()=>{
  const {request,as,state,store}=setup();await as('manager');
  for(const [id,employeeId] of [['a','martin'],['b','daniela']])store.set(`plan:${id}`,{key:`plan:${id}`,kind:'plan',payload:{id,employeeId,date:'2026-11-02',from:'08:00',to:'18:30'}});
  state.aiResult={message:'Výměna',commands:[{kind:'plan',id:'a',employeeId:'daniela'},{kind:'plan',id:'b',employeeId:'martin'}]};
  const result=await request('assistant.propose',{prompt:'Vyměň směny'});assert.equal(result.body.changes.length,2);
  assert.equal((await request('assistant.apply',{id:result.body.id})).status,200);
  assert.equal(store.get('plan:a').payload.employeeId,'daniela');assert.equal(store.get('plan:b').payload.employeeId,'martin');
  state.aiResult.commands=[{kind:'plan',id:'a',employeeId:'martin'}];
  const bad=await request('assistant.propose',{prompt:'Konflikt'});assert.equal(bad.body.changes.length,0);assert.match(bad.body.message,/překrývají/);
  assert.equal(store.get('plan:a').payload.employeeId,'daniela');
});
test('stale, expired and unknown assistant drafts cannot overwrite changed data',async()=>{
  const {request,as,state,store}=setup();await as('manager');
  state.aiResult={message:'Akce',commands:[{kind:'event',date:'2026-11-01',title:'Nová akce'}]};
  const first=await request('assistant.propose',{prompt:'Přidej akci'});
  await request('event.save',{date:'2026-11-02',title:'Jiná akce'});
  const stale=await request('assistant.apply',{id:first.body.id});assert.equal(stale.status,400);assert.match(stale.body.error,/změnila/);
  const second=await request('assistant.propose',{prompt:'Znovu'});store.get('assistant:'+second.body.id).payload.expiresAt=0;
  assert.equal((await request('assistant.apply',{id:second.body.id})).status,400);
  assert.equal((await request('assistant.apply',{id:'unknown'})).status,400);
  assert.equal([...store.values()].filter(r=>r.kind==='event').length,1);
});
test('assistant backfills confirmed past attendance, preserves rates, rejects future and overlapping hours',async()=>{
  const {request,as,state,store}=setup();await as('manager');
  state.aiResult={message:'Docházka',commands:[{kind:'shift',employeeId:'martin',date:'2026-10-01'}]};
  const first=await request('assistant.propose',{prompt:'Zapiš odpracované hodiny 1. října'});assert.equal(first.body.changes.length,1);
  assert.equal((await request('assistant.apply',{id:first.body.id})).status,200);
  const shift=[...store.values()].find(r=>r.kind==='shift').payload;
  assert.equal(shift.start,'2026-10-01T06:00:00.000Z');assert.equal(shift.end,'2026-10-01T19:30:00.000Z');assert.equal(shift.automationOverride,true);
  store.get('emp:martin').payload.grossRate=999;
  state.aiResult.commands=[{kind:'shift',id:shift.id,start:'2026-10-01T08:30',end:'2026-10-01T21:30'}];
  const edit=await request('assistant.propose',{prompt:'Oprav příchod'});assert.equal(edit.body.changes[0].after.grossRate,185);
  for(const command of [{kind:'shift',employeeId:'martin',date:'2099-01-01'},{kind:'shift',employeeId:'martin',date:'2026-10-01'},{kind:'shift',employeeId:'martin',start:'2026-02-30T08:00',end:'2026-03-01T18:00'},{kind:'shift',id:shift.id,employeeId:'daniela'}]){
    state.aiResult.commands=[command];const bad=await request('assistant.propose',{prompt:'Neplatný zápis'});assert.equal(bad.body.changes.length,0);
  }
  assert.equal([...store.values()].filter(r=>r.kind==='shift').length,1);
  state.aiResult.commands=[{kind:'shift',employeeId:'martin',start:'2026-03-28T02:30',end:'2026-03-28T08:00'}];
  const beforeDst=await request('assistant.propose',{prompt:'Doplň skutečnou noční směnu'});assert.equal(beforeDst.body.changes.length,1);assert.equal(beforeDst.body.changes[0].after.start,'2026-03-28T01:30:00.000Z');
});
test('assistant deletions retain automation tombstone and changes remain all or nothing',async()=>{
  const {request,as,state,store,automate}=setup();await as('manager');
  await automate(Date.parse('2026-10-01T00:00:00Z'));
  store.set('plan:p',{key:'plan:p',kind:'plan',payload:{id:'p',employeeId:'martin',date:'2026-10-01',from:'08:00',to:'18:30'}});
  store.set('shift:s',{key:'shift:s',kind:'shift',payload:{id:'s',employeeId:'martin',planId:'p',start:'2026-10-01T06:00:00Z',end:'2026-10-01T16:30:00Z',grossRate:185,netRate:150}});
  state.aiResult={message:'Smazat docházku',commands:[{kind:'shift',id:'s',delete:true}]};
  const draft=await request('assistant.propose',{prompt:'Smaž tento záznam'});await request('assistant.apply',{id:draft.body.id});
  assert.equal(store.has('shift:s'),false);assert.equal(store.get('automation:p').payload.shiftId,'s');
  await automate(Date.parse('2026-10-01T21:00:00Z'));assert.equal([...store.values()].some(r=>r.kind==='shift'),false);
  state.aiResult.commands=[{kind:'event',date:'2026-11-01',title:'Validní'},{kind:'revenue',date:'2026-11-01',amount:-5}];
  assert.equal((await request('assistant.propose',{prompt:'Neplatný balík'})).body.changes.length,0);assert.equal([...store.values()].some(r=>r.kind==='event'),false);
});
test('daily wage summary includes all staff, groups overnight shift by Czech arrival, separates plans and open shifts',()=>{
  const {assistant}=setup();
  const list=[{key:'emp:martin',kind:'emp',payload:{grossRate:185,netRate:150}},...[
    {id:'s1',employeeId:'martin',start:'2026-10-22T22:30:00Z',end:'2026-10-23T02:30:00Z',grossRate:185,netRate:150},
    {id:'s2',employeeId:'daniela',start:'2026-10-23T14:00:00Z',end:'2026-10-23T20:00:00Z',grossRate:180,netRate:145},
    {id:'s3',employeeId:'extra',start:'2026-10-23T16:00:00Z',end:'2026-10-23T18:00:00Z',grossRate:200,netRate:160},
    {id:'s4',employeeId:'extra',start:'2026-10-23T19:00:00Z',end:null,grossRate:200,netRate:160}
  ].map(payload=>({key:'shift:'+payload.id,kind:'shift',payload})),{key:'plan:p',kind:'plan',payload:{id:'p',employeeId:'martin',date:'2026-10-23',from:'14:00',to:'00:00'}}];
  const days=assistant.wageSummary(list,Date.parse('2026-10-23T19:00:00Z'));assert.equal(days.length,1);assert.equal(days[0].date,'2026-10-23');assert.equal(days[0].grossAllEmployees,2220);assert.equal(days[0].netAllEmployees,1790);assert.equal(days[0].hours,12);assert.equal(days[0].employees.length,3);assert.match(days[0].employees.find(e=>e.employeeId==='extra').status,/probíhá/);
  const running=assistant.wageSummary(list,Date.parse('2026-10-23T20:00:00Z'));assert.equal(running[0].grossAllEmployees,2420);assert.equal(running[0].netAllEmployees,1950);
});
test('assistant application rolls back all writes on a storage failure and can be retried safely',async()=>{
  const {request,as,state,store}=setup();await as('manager');
  state.aiResult={message:'Dvě akce',commands:[{kind:'event',date:'2026-11-01',title:'První'},{kind:'event',date:'2026-11-02',title:'Druhá'}]};
  const proposal=await request('assistant.propose',{prompt:'Zapiš obě akce'});
  state.failKey=proposal.body.changes[1].key;
  const failed=await request('assistant.apply',{id:proposal.body.id});assert.equal(failed.status,400);assert.doesNotMatch(failed.body.error,/Simulated/);
  assert.equal([...store.values()].filter(r=>r.kind==='event').length,0);assert.equal(store.get('assistant:'+proposal.body.id).payload.applied,false);
  state.failKey=null;
  assert.equal((await request('assistant.apply',{id:proposal.body.id})).status,200);assert.equal([...store.values()].filter(r=>r.kind==='event').length,2);
});


test('authorized November roster updates existing plans, verifies all 31 and preserves later swaps',async()=>{
  const {store,as,assistant,plannedTimes}=setup();await as('manager');
  store.set('plan:existing',{key:'plan:existing',kind:'plan',payload:{id:'existing',employeeId:'daniela',date:'2026-11-07',from:'15:00',to:'23:00',note:'old'}});
  store.set('plan:duplicate',{key:'plan:duplicate',kind:'plan',payload:{id:'duplicate',employeeId:'daniela',date:'2026-11-07',from:'14:00',to:'00:00'}});
  store.set('event:other',{key:'event:other',kind:'event',payload:{id:'other',date:'2026-11-07',title:'Zachovat'}});
  const receipt=await assistant.importNovemberRoster();assert.equal(receipt.total,31);assert.equal(receipt.errors.length,0);
  const plans=[...store.values()].filter(r=>r.kind==='plan').map(r=>r.payload);
  assert.equal(plans.length,31);assert.equal(plans.filter(p=>p.employeeId==='daniela').length,16);assert.equal(plans.filter(p=>p.employeeId==='martin').length,15);
  assert.ok(plans.every(p=>p.note==='HS'));
  assert.equal(plans.filter(p=>p.to==='00:00').length,8);
  for(const employeeId of ['daniela','martin']){
    const times=plans.filter(p=>p.employeeId===employeeId).map(plannedTimes).sort((a,b)=>a.start-b.start);
    assert.ok(times.every((t,i)=>i===0||t.start>=times[i-1].end));
  }
  const saturday=plans.find(p=>p.employeeId==='daniela'&&p.date==='2026-11-07');
  assert.equal((plannedTimes(saturday).end-plannedTimes(saturday).start)/3600000,10);
  assert.equal(new Date(plannedTimes(saturday).end).toISOString(),'2026-11-07T23:00:00.000Z');
  const key='plan:'+saturday.id;store.get(key).payload.note='Schválená změna';
  await assistant.importNovemberRoster();assert.equal(store.get(key).payload.note,'Schválená změna');assert.ok(store.has('event:other'));
});
test('November roster receipt and all plans roll back together on failure',async()=>{
  const {store,state,as,assistant}=setup();await as('manager');state.failKey='meta:roster-2026-11-hs-v1';
  await assert.rejects(()=>assistant.importNovemberRoster());assert.equal([...store.values()].filter(r=>r.kind==='plan').length,0);
  state.failKey=null;assert.equal((await assistant.importNovemberRoster()).total,31);
});

test('support submits own attendance for manager approval; only approval adds payroll and retries are safe',async()=>{
  const {request,as,store}=setup();await as('martin');store.get('emp:martin').payload.role='Výpomoc';
  store.set('event:team',{key:'event:team',kind:'event',payload:{id:'team',date:'2026-11-01',title:'Akce'}});
  const body={id:randomUUID(),start:'2026-10-01T18:00',end:'2026-10-02T00:30',employeeId:'daniela',status:'approved',netRate:999};
  for(const action of ['clock','shift.note','shift.save','employee.save','revenue.save','support.review','event.save'])assert.equal((await request(action,body)).status,403);
  assert.equal((await request('support.submit',{...body,end:'2026-10-01T17:00'})).status,400);
  assert.equal((await request('support.submit',{...body,start:'2026-02-30T18:00'})).status,400);
  assert.equal((await request('support.submit',body)).status,200);
  assert.equal((await request('support.submit',body)).status,200);
  assert.equal(store.get('shiftRequest:'+body.id).payload.employeeId,'martin');
  assert.equal(store.get('shiftRequest:'+body.id).payload.status,'pending');
  assert.equal(store.has('shift:'+body.id),false);
  assert.equal((await request('support.submit',{...body,id:randomUUID()})).status,409);
  let dashboard=(await request('dashboard')).body;
  assert.equal(dashboard.requests.length,1);assert.equal(dashboard.events.length,1);assert.equal(dashboard.shifts.length,0);assert.equal(dashboard.revenue.length,0);
  await as('daniela');store.get('emp:daniela').payload.email='daniela@example.test';await as('daniela');
  assert.equal((await request('support.review',{id:body.id,status:'approved'})).status,403);
  await as('manager');
  assert.equal((await request('dashboard')).body.requests.length,1);
  assert.equal((await request('support.review',{id:body.id,status:'approved'})).status,200);
  assert.equal((await request('support.review',{id:body.id,status:'approved'})).status,200);
  const shift=store.get('shift:'+body.id).payload;
  assert.equal(shift.netRate,150);assert.equal(shift.grossRate,185);assert.equal(shift.employeeId,'martin');
  assert.equal((Date.parse(shift.end)-Date.parse(shift.start))/3600000,6.5);
  assert.equal((await request('support.review',{id:body.id,status:'rejected'})).status,409);
  await as('martin');const second={...body,id:randomUUID(),start:'2026-10-03T10:00',end:'2026-10-03T12:00'};
  assert.equal((await request('support.submit',second)).status,200);
  await as('manager');assert.equal((await request('support.review',{id:second.id,status:'rejected'})).status,200);
  assert.equal(store.has('shift:'+second.id),false);
  await as('martin');dashboard=(await request('dashboard')).body;
  assert.equal(dashboard.requests.length,2);assert.equal(dashboard.shifts.length,1);
});
test('approval rolls back payroll and remains pending on a storage failure',async()=>{
  const {request,as,store,state}=setup();await as('martin');store.get('emp:martin').payload.role='Výpomoc';
  const id=randomUUID();await request('support.submit',{id,start:'2026-10-01T10:00',end:'2026-10-01T12:00'});
  await as('manager');state.failKey='shiftRequest:'+id;
  assert.equal((await request('support.review',{id,status:'approved'})).status,500);
  assert.equal(store.has('shift:'+id),false);assert.equal(store.get('shiftRequest:'+id).payload.status,'pending');
  state.failKey=null;assert.equal((await request('support.review',{id,status:'approved'})).status,200);
});
test('support plans do not start automatically or appear as estimated wages',async()=>{
 const {store,as,automate,assistant}=setup();await as('manager');
 store.get('emp:martin').payload.role='Výpomoc';
 store.set('plan:support',{key:'plan:support',kind:'plan',payload:{id:'support',employeeId:'martin',date:'2026-10-23',from:'14:00',to:'18:00'}});
 await automate(Date.parse('2026-10-23T11:00:00Z'));await automate(Date.parse('2026-10-23T13:00:00Z'));
 assert.equal([...store.values()].filter(r=>r.kind==='shift').length,0);
 assert.equal(assistant.wageSummary([...store.values()]).length,0);
});
