import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
function payroll(){
 const source=html.slice(html.indexOf('function duration('),html.indexOf('function monthMatch('))+html.slice(html.indexOf('function shiftTime('),html.indexOf('function revenueForm('))+html.slice(html.indexOf('function planDuration('),html.indexOf('function render(){'));
 const data={employees:[{id:'martin',name:'Martin',grossRate:185,netRate:150},{id:'daniela',name:'Daniela',grossRate:180,netRate:145,active:false}],shifts:[],plans:[]};
 const context=vm.createContext({data,employee:id=>data.employees.find(e=>e.id===id)||{},Date});
 return {data,...vm.runInContext(source+';({wageDays,wageTotals,personDay,rate})',context)};
}
test('monthly wages add Martin and Daniela including inactive employee history and multiple shifts',()=>{
 const {data,wageTotals,wageDays}=payroll();
 data.shifts.push({employeeId:'martin',start:'2026-10-23T06:00:00Z',end:'2026-10-23T10:00:00Z',grossRate:185,netRate:150},{employeeId:'daniela',start:'2026-10-23T10:00:00Z',end:'2026-10-23T16:00:00Z',grossRate:180,netRate:145},{employeeId:'martin',start:'2026-10-23T17:00:00Z',end:'2026-10-23T19:00:00Z',grossRate:185,netRate:150});
 const totals=wageTotals('2026-10');
 assert.equal(totals.hours,12);assert.equal(totals.gross,2190);assert.equal(totals.net,1770);
 assert.equal(wageDays('2026-10')[0].people.length,2);
 assert.equal(wageTotals('2026-11').gross,0);
});
test('plans are estimates and attendance replaces the same employee daily plan without duplication',()=>{
 const {data,wageTotals}=payroll();
 data.plans.push({id:'p',employeeId:'daniela',date:'2026-10-23',from:'14:00',to:'20:00'});
 assert.equal(wageTotals('2026-10').gross,1080);
 data.shifts.push({employeeId:'daniela',start:'2026-10-23T12:00:00Z',end:'2026-10-23T16:00:00Z'});
 assert.equal(wageTotals('2026-10').gross,720);
});
test('running shift stops at actual planned end even when arrival is late',()=>{
 const {personDay}=payroll();
 const plan={id:'p',employeeId:'daniela',date:'2026-10-23',from:'14:00',to:'20:00'};
 const shift={employeeId:'daniela',planId:'p',start:'2026-10-23T13:00:00Z',end:null};
 const result=personDay('daniela',[shift],[plan],Date.parse('2026-10-23T19:00:00Z'));
 assert.equal(result.hours,5);assert.equal(result.gross,900);assert.equal(result.status,'open');
});
test('legacy missing rates fall back, explicit zero remains zero, Czech overnight date determines month',()=>{
 const {data,rate,wageTotals}=payroll();
 assert.equal(rate({employeeId:'martin',netRate:null},'netRate'),150);
 assert.equal(rate({employeeId:'martin',netRate:0},'netRate'),0);
 data.shifts.push({employeeId:'martin',start:'2026-10-31T23:30:00Z',end:'2026-11-01T01:30:00Z'});
 assert.equal(wageTotals('2026-10').gross,0);assert.equal(wageTotals('2026-11').gross,370);
});
test('support plans never create payroll estimates; approved attendance counts at stored rates',()=>{
 const {data,wageTotals}=payroll();data.employees[0].role='Výpomoc';
 data.plans.push({id:'support-plan',employeeId:'martin',date:'2026-10-23',from:'14:00',to:'18:00'});
 assert.equal(wageTotals('2026-10').gross,0);
 data.shifts.push({employeeId:'martin',start:'2026-10-23T12:00:00Z',end:'2026-10-23T16:00:00Z',grossRate:185,netRate:150});
 assert.equal(wageTotals('2026-10').gross,740);assert.equal(wageTotals('2026-10').net,600);
});
