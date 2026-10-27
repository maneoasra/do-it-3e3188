import { chromium, firefox } from 'playwright';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
for(const [name,engine,viewport] of [['Chromium notebook',chromium,{width:1366,height:768}],['Firefox notebook',firefox,{width:1366,height:768}],['Chromium mobile',chromium,{width:375,height:812}]]){
  const browser=await engine.launch({headless:true});
  try{
    const page=await browser.newPage({viewport});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    let role=null,failLogin=true,loseSession=true,revenues=[],documentLoads=0,aiApplies=0,aiRequests=0,supportRequests=[];
    const shifts=[{id:'s1',employeeId:'martin',start:'2026-10-22T22:30:00Z',end:'2026-10-23T02:30:00Z',grossRate:185,netRate:150},{id:'s2',employeeId:'daniela',start:'2026-10-23T14:00:00Z',end:'2026-10-23T20:00:00Z',grossRate:180,netRate:145},{id:'s3',employeeId:'extra',start:'2026-10-23T16:00:00Z',end:'2026-10-23T18:00:00Z',grossRate:200,netRate:160}];
    let plans=[{id:'plan-existing',employeeId:'martin',date:'2026-11-01',from:'14:30',to:'22:00',note:'Původní směna'}],events=[{id:'event-existing',date:'2026-11-02',title:'Původní akce',note:'Pokyny'}];
    const employee={id:'martin',name:'Martin',username:'martin',email:'martin@example.test',grossRate:185,netRate:150,active:true};
    await page.route('https://barneys.test/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/api/team'){
        const q=route.request().postDataJSON();let status=200,body={ok:true};
        if(q.action==='session')body=role?{user:{id:role==='manager'?'spravce':'martin',role}}:{error:'Přihlaste se ke svému účtu.',code:'AUTH_REQUIRED'},status=role?200:401;
        else if(q.action==='auth.login'){
          if(failLogin){status=401;body={error:'Zkontrolujte e-mail a heslo.'};failLogin=false}
          else if(loseSession)loseSession=false;
          else role='employee';
        }
        else if(q.action==='auth.signup')body={message:'Zkontrolujte e-mail a potvrďte aktivaci účtu.'};
        else if(q.action==='auth.recovery')body={message:'Pokud je účet nastavený, přijde vám e-mail pro obnovení hesla.'};
        else if(q.action==='dashboard')body={me:employee,employees:[employee,{id:'daniela',name:'Daniela',username:'daniela',email:'',grossRate:180,netRate:145,active:true}],shifts:role==='manager'?shifts:[],plans,events,requests:supportRequests,revenue:revenues};
        else if(q.action==='support.submit'){assert.equal(q.start,'2026-10-01T18:15');assert.equal(q.end,'2026-10-02T00:30');supportRequests.push({id:q.id,employeeId:'martin',start:'2026-10-01T16:15:00Z',end:'2026-10-01T22:30:00Z',status:'pending'})}
        else if(q.action==='revenue.save'){if(!revenues.some(r=>r.id===q.id))revenues.push({...q,amount:Number(q.amount),employeeId:'martin',submittedBy:'Martin',submittedAt:new Date().toISOString()})}
        else if(q.action==='plan.save'){assert.equal(q.id,'plan-existing');plans=plans.map(p=>p.id===q.id?{...q}:p)}
        else if(q.action==='event.save'){assert.equal(q.id,'event-existing');events=events.map(p=>p.id===q.id?{...q}:p)}
        else if(q.action==='assistant.propose'){
          aiRequests++;if(aiRequests>1)assert.ok(q.history.length>0);
          if(q.prompt==='selhání'){status=400;body={error:'Asistent je dočasně nedostupný.'}}
          else body={id:'draft',message:'Návrh <img src=x onerror=alert(1)>',changes:[{key:'plan:preview',kind:'plan',before:null,after:{id:'preview',employeeId:'martin',date:'2026-11-04',from:'08:00',to:'18:30',note:'<script>bad</script>'}}]};
        }
        else if(q.action==='assistant.apply'){assert.equal(q.id,'draft');assert.equal(q.changes,undefined);aiApplies++}
        else if(q.action==='opening.save'){assert.equal(q.days.length,7);assert.equal(q.days[4][1],'01:00')}
        else if(q.action==='auth.logout')role=null;
        else if(q.action==='employee.save')assert.equal(q.email,'daniela@example.test');
        return route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
      }
      if(url.pathname.startsWith('/assets/'))return route.fulfill({contentType:'image/jpeg',body:await readFile(new URL('../public'+url.pathname,import.meta.url))});
      documentLoads++;await route.fulfill({contentType:'text/html',body:html});
    });
    const withinViewport=async()=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.goto('https://barneys.test/');await page.waitForFunction(()=>document.getElementById('login').hidden===false);
    await withinViewport();
    await page.getByRole('button',{name:'První přístup',exact:true}).click();
    await page.locator('#email').fill('martin@example.test');await page.locator('#password').fill(randomUUID());
    await page.locator('#loginBtn').click();await page.getByText('Zkontrolujte e-mail a potvrďte aktivaci účtu.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Přihlášení',exact:true}).click();
    await page.locator('#password').fill(randomUUID());await page.locator('#loginBtn').click();
    await page.getByText('Zkontrolujte e-mail a heslo.',{exact:true}).waitFor();
    await page.locator('#loginBtn').click();
    await page.getByText('Přihlaste se ke svému účtu.',{exact:true}).waitFor();
    assert.equal(documentLoads,1);
    await page.locator('#password').fill(randomUUID());
    await page.locator('#loginBtn').click();await page.locator('#app').waitFor({state:'visible'});
    assert.equal(documentLoads,1);
    await page.reload();await page.locator('#app').waitFor({state:'visible'});
    assert.equal(await page.locator('#who').textContent(),'Martin');
    await page.getByRole('button',{name:'Odeslat tržbu',exact:true}).click();
    await page.locator('#revenueAmount').waitFor();await withinViewport();
    await page.locator('#revenueAmount').fill('1234.50');await page.locator('#revenueNote').fill('<img src=x onerror=alert(1)>');
    await page.locator('#revenueForm button').click();
    await page.getByText('Tržba byla odeslána a je uložená v přehledu správce.',{exact:true}).waitFor();
    assert.equal(revenues.length,1);assert.equal(await page.locator('#view .item img').count(),0);
    assert.ok((await page.locator('#view').innerText()).includes('1 234,5 Kč'));
    role='manager';await page.reload();await page.locator('#app').waitFor({state:'visible'});
    assert.equal(await page.locator('[data-clock]').count(),0);
    await page.getByRole('heading',{name:'AI asistent',exact:true}).waitFor();
    await page.locator('#wageMonth').fill('2026-10');
    const wageCard=page.locator('.card').filter({has:page.getByRole('heading',{name:'Mzdy podle provozních dnů'})});
    const wageRow=wageCard.locator('tbody tr').first();
    assert.ok((await wageRow.innerText()).includes('2\u00a0220 Kč'));
    assert.ok((await wageRow.innerText()).includes('1\u00a0790 Kč'));
    assert.ok((await page.locator('#metrics').innerText()).includes('2\u00a0220 Kč'));
    assert.ok((await page.locator('#metrics').innerText()).includes('1\u00a0790 Kč'));
    await withinViewport();
    await page.getByRole('button',{name:'Rozpis na měsíc',exact:true}).click();
    assert.ok((await page.locator('#assistantPrompt').inputValue()).includes('krátký/dlouhý'));
    await page.locator('#assistantForm button').click();await page.getByRole('heading',{name:'Návrh změn (1)',exact:true}).waitFor();
    assert.equal(await page.locator('#view .assistant-conversation img').count(),0);
    assert.equal(await page.locator('.assistant-preview script').count(),0);assert.equal(aiApplies,0);
    await withinViewport();
    await page.getByRole('button',{name:'Zahodit návrh',exact:true}).click();assert.equal(await page.locator('#assistantApply').count(),0);
    await page.locator('#assistantPrompt').fill('Nyní návrh znovu');await page.locator('#assistantForm button').click();
    await page.locator('#assistantApply').click();await page.locator('#assistantStatus').getByText('Všechny potvrzené změny jsou uložené.',{exact:true}).waitFor();
    assert.equal(aiApplies,1);assert.equal(await page.locator('#assistantApply').count(),0);
    await page.locator('#assistantPrompt').fill('selhání');await page.locator('#assistantForm button').click();
    await page.locator('.assistant-conversation').getByText('Asistent je dočasně nedostupný.',{exact:true}).waitFor();assert.equal(await page.locator('#assistantApply').count(),0);
    await page.getByText('Otevírací doba a pravidla směn',{exact:true}).click();
    await page.locator('#openingForm [name="to4"]').fill('01:00');await page.locator('#openingForm button').click();
    await page.getByText('Otevírací doba je uložená. Pro změněné časy vytvořte nový návrh směn.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Tržby a analýza',exact:true}).click();await page.getByText('Zadané záznamy',{exact:true}).waitFor();
    assert.ok((await page.locator('#view').innerText()).includes('Martin'));await withinViewport();
    for(const [tab,kind,id] of [['Rozpis směn','plan','plan-existing'],['Akce','event','event-existing']]){
      await page.getByRole('button',{name:tab,exact:true}).click();
      await page.locator('[data-'+kind+'-edit="'+id+'"]').click();
      const form=page.locator('#'+kind+'Form');
      assert.equal(await form.locator('[name="id"]').inputValue(),id);
      await form.locator('[name="note"]').fill('Zrušená úprava');
      await form.getByRole('button',{name:'Zrušit úpravu',exact:true}).click();
      assert.equal((kind==='plan'?plans:events)[0].note,kind==='plan'?'Původní směna':'Pokyny');
      await page.locator('[data-'+kind+'-edit="'+id+'"]').click();
      await form.locator('[name="date"]').fill('2026-11-03');
      await form.locator('[name="note"]').fill('<b>Nové pokyny</b>');
      if(kind==='plan')await form.locator('[name="from"]').fill('15:00');
      else await form.locator('[name="title"]').fill('Upravená akce');
      await form.getByRole('button',{name:'Uložit změny',exact:true}).click();
      await page.getByText('Údaje byly uloženy.',{exact:true}).waitFor();
      assert.equal((kind==='plan'?plans:events).length,1);
      await page.locator('[data-'+kind+'-edit="'+id+'"]').click();
      assert.equal(await form.locator('[name="note"]').inputValue(),'<b>Nové pokyny</b>');
      assert.equal(await form.locator('[name="date"]').inputValue(),'2026-11-03');
      assert.equal(await page.locator('#view .item b').filter({hasText:'Nové pokyny'}).count(),0);
      await withinViewport();
    }
    await page.getByRole('button',{name:'Zaměstnanci',exact:true}).click();
    await page.locator('[data-edit="daniela"]').click();await page.locator('#employeeForm input[name="email"]').fill('daniela@example.test');
    await page.locator('#employeeForm button.primary').click();await page.getByText('Údaje byly uloženy.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Docházka',exact:true}).click();await page.getByText('Evidence odpracovaných směn',{exact:true}).waitFor();await withinViewport();
    role='employee';employee.role='Výpomoc';await page.reload();
    await page.getByRole('heading',{name:'Ruční zápis směny',exact:true}).waitFor();
    assert.equal(await page.locator('[data-clock],#revenueForm,[data-shift-note],[data-event-edit]').count(),0);
    const supportForm=page.locator('#supportForm');
    await supportForm.locator('[name="startDate"]').fill('2026-10-01');await supportForm.locator('[name="endDate"]').fill('2026-10-02');
    for(const [field,value] of Object.entries({startHour:'18',startMinute:'15',endHour:'00',endMinute:'30'}))await supportForm.locator('[name="'+field+'"]').selectOption(value);
    await supportForm.locator('button').click();await page.getByText('Směna byla odeslána ke schválení.',{exact:true}).waitFor();
    await page.locator('#wageMonth').fill('2026-10');await page.getByText('Čeká na schválení',{exact:true}).waitFor();
    assert.equal(await page.locator('#view > .card').last().getByRole('heading').innerText(),'Přehled akcí');await withinViewport();
    await page.getByRole('button',{name:'Odhlásit',exact:true}).click();await page.locator('#login').waitFor({state:'visible'});
    await page.getByRole('button',{name:'Zapomenuté heslo',exact:true}).click();await page.locator('#email').fill('martin@example.test');await page.locator('#loginBtn').click();
    await page.getByText('Pokud je účet nastavený, přijde vám e-mail pro obnovení hesla.',{exact:true}).waitFor();
    assert.deepEqual(errors,[]);console.log(name+': login, revenue, assistant preview/discard/apply/error, opening hours, daily wages, editing and layout passed');
  }finally{await browser.close()}
}
