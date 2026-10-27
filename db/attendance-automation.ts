import { eq } from 'drizzle-orm';
import { db } from './index.js';
import { records } from './schema.js';

type Item = Record<string, any>;
export function plannedTimes(plan:Item){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(plan.date)||![plan.from,plan.to].every(v=>/^([01]\d|2[0-3]):[0-5]\d$/.test(v)))return null;
  const convert=(date:string,time:string)=>{
    const local=`${date}T${time}:00`,base=Date.parse(local+'Z');
    if(!Number.isFinite(base))return NaN;
    for(const offset of [2,1]){
      const stamp=base-offset*3600000;
      const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Prague',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(stamp));
      const v=(t:string)=>parts.find(p=>p.type===t)!.value;
      if(`${v('year')}-${v('month')}-${v('day')}T${v('hour')}:${v('minute')}:${v('second')}`===local)return stamp;
    }
    return NaN;
  };
  const start=convert(plan.date,plan.from);
  const next=new Date(plan.date+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);
  const end=convert(plan.to<=plan.from?next.toISOString().slice(0,10):plan.date,plan.to);
  return Number.isFinite(start)&&Number.isFinite(end)?{start,end,deadline:start+30*60000,close:end+3600000}:null;
}

export async function automateAttendance(now=Date.now()){
  // A persistent activation boundary prevents backfilling historical attendance.
  await db.insert(records).values({key:'meta:attendance-automation-v1',kind:'meta',payload:{enabledAt:now}}).onConflictDoNothing();
  const activation=(await db.select().from(records).where(eq(records.key,'meta:attendance-automation-v1')))[0].payload as Item;
  const plans=(await db.select().from(records).where(eq(records.kind,'plan'))).map(r=>r.payload as Item).sort((a,b)=>`${a.date} ${a.from}`.localeCompare(`${b.date} ${b.from}`));
  for(const plan of plans){
    const times=plannedTimes(plan);
    if(!times||times.deadline>now||times.close<activation.enabledAt)continue;
    await db.transaction(async tx=>{
      const employeeRow=(await tx.select().from(records).where(eq(records.key,`emp:${plan.employeeId}`)).for('update'))[0];
      if(!employeeRow)return;
      // Re-read the plan after taking the same lock used by manual clock actions.
      const live=(await tx.select().from(records).where(eq(records.key,`plan:${plan.id}`)))[0]?.payload as Item|undefined;
      if(!live||live.date!==plan.date||live.from!==plan.from||live.to!==plan.to||live.employeeId!==plan.employeeId)return;
      const e=employeeRow.payload as Item;
      if(e.role==='Výpomoc')return;
      const markerKey=`automation:${plan.id}`;
      const marker=(await tx.select().from(records).where(eq(records.key,markerKey)))[0]?.payload as Item|undefined;
      const shifts=(await tx.select().from(records).where(eq(records.kind,'shift'))).map(r=>r.payload as Item).filter(s=>s.employeeId===plan.employeeId);
      let shift=marker?shifts.find(s=>s.id===marker.shiftId):shifts.find(s=>s.planId===plan.id)||shifts.find(s=>!s.planId&&Date.parse(s.start)<=times.end&&(s.end?Date.parse(s.end)>times.start:true));
      if(marker&&!shift)return; // A manager's deletion must never be undone.
      if(!shift&&!marker&&e.active&&times.deadline>=activation.enabledAt){
        // Do not create an overlapping shift, even after a delayed scheduled run.
        if(shifts.some(s=>Date.parse(s.start)<times.close&&(s.end?Date.parse(s.end)>times.start:true)))return;
        shift={id:`auto-${plan.id}`,employeeId:e.id,planId:plan.id,start:new Date(times.start).toISOString(),end:null,startGps:null,endGps:null,grossRate:e.grossRate,netRate:e.netRate,autoStart:true,autoStartNote:'Směna byla odstartována automaticky – uplynul limit pro zahájení směny.',autoStartedAt:new Date(now).toISOString()};
      }
      if(!shift||shift.automationOverride)return;
      if(!marker)await tx.insert(records).values({key:markerKey,kind:'automation',payload:{shiftId:shift.id}}).onConflictDoNothing();
      // Keep the planned cutoff even if the scheduler was briefly unavailable.
      const item={...shift,planId:shift.planId??plan.id};
      if(!item.end&&now>=times.close&&Date.parse(item.start)<times.close){item.end=new Date(times.close).toISOString();item.autoEnd=true;item.autoEndNote='Směna byla ukončena automaticky hodinu po plánovaném konci.';item.autoEndedAt=new Date(now).toISOString()}
      await tx.insert(records).values({key:`shift:${item.id}`,kind:'shift',payload:item}).onConflictDoUpdate({target:records.key,set:{payload:item}});
    });
  }
}
