# Barney’s tým

Český portál pro docházku, rozpis směn, profily zaměstnanců, výpočet mezd, tržby a kalendář akcí. Původní hnědozlatý vzhled zůstal zachován. Rozhraní se přizpůsobuje mobilům a notebookům; široké tabulky lze posouvat vodorovně.

## První přihlášení

Martin a správce používají své předem nastavené e-maily. Na přihlašovací stránce zvolí **První přístup**, nastaví si vlastní heslo alespoň o 10 znacích a potvrdí e-mail. Po potvrzení se přihlásí. Odkaz **Zapomenuté heslo** umožňuje heslo obnovit. Hesla spravuje Netlify Identity; aplikace je neukládá do vlastní databáze ani do zdrojového kódu.

Netlify Identity musí mít povolenou registraci a vypnuté automatické potvrzování e-mailů. Přístup k datům přesto mají pouze ověřené e-maily nastavené v aplikaci. Nepotvrzený, neznámý nebo neaktivní účet nemá k datům přístup. Oprávnění správce aplikace se určují serverovým porovnáním předem nastaveného e-mailu, nikoli uživatelskými metadaty nebo výběrem účtu v prohlížeči.

Daniela má připravený profil bez přihlašovacího e-mailu. Správce ve **Zaměstnanci → Upravit profil** doplní a uloží její e-mail; Daniela pak použije **První přístup**. Stejný postup platí pro další zaměstnanecké profily. Prázdný e-mail ponechá profil bez možnosti přihlášení. Vypnutí aktivního účtu zablokuje přístup k aplikačním datům.

## Docházka a tržby

Martin má výchozí čistou sazbu 150 Kč/h. Existující ostatní sazby a smluvní údaje zůstaly zachované a správce je může upravit. Směny se nevytvářejí předem; časy příchodu a odchodu zaznamenává server. Skutečná ani simulovaná poloha se nesbírá.

Zaměstnanci na kartě **Odeslat tržbu** vyplní datum, částku a případně poznámku. Uložený záznam obsahuje zaměstnance a čas odeslání. Zaměstnanec vidí vlastní tržby a správce všechny záznamy včetně souhrnů. **Obnovit přehled** nebo opětovné otevření karty načte aktuální data. Opakované odeslání stejného požadavku po výpadku spojení nevytvoří duplicitní tržbu.

## AI asistent správce a denní mzdy

Na přehledu správce nahradil ovládání příchodu a odchodu AI asistent. Zaměstnanci si nadále ovládají vlastní docházku. Asistent přes Netlify AI Gateway (`gpt-5.4-mini`) hledá v evidenci, shrnuje provoz a připravuje hromadné změny plánů, skutečné docházky, akcí, tržeb a profilů. Změny přístupu ani hesel neprovádí. AI odpovědi se zobrazují jako prostý text.

Pro plánování krátkého/dlouhého týdne napište zaměstnance, období a pondělí výchozího týdne včetně toho, zda je krátký nebo dlouhý. Krátký týden znamená středu a čtvrtek, dlouhý pondělí, úterý, pátek, sobotu a neděli; další týden se obrátí. Jiný vzorec lze popsat vlastními slovy. Zpětné doplnění skutečně odpracovaných hodin musí být výslovně uvedené; budoucí docházku zapsat nelze.

Výchozí otevírací doba je pondělí až středa 08:30–18:30, čtvrtek 08:30–21:30, pátek a sobota 14:30–00:00 a neděle 14:30–21:30. Asistent odvozuje příchod 30 minut před otevřením a konec při zavření. Půlnoc je následující den; časy respektují české časové pásmo i letní čas. V rozbalovacím nastavení pod asistentem lze pro každý den změnit otevření, zavření nebo nastavit zavřeno. Změna nastavení sama nepřepisuje uložené směny. Dosavadní automatické vedení docházky zůstalo zachované: při neukončení nastane automatický odchod hodinu po plánovaném konci.

Asistent nejprve zobrazí změny s původním a novým stavem. Až tlačítko **Potvrdit a uložit** uloží celý návrh v jedné transakci. Návrh lze zahodit, platí 30 minut a obsahuje nejvýše 400 změn. Návrhy jsou uložené na serveru a potvrzení lze bezpečně opakovat po výpadku spojení. Pokud se mezitím změní evidence, je nutné vytvořit nový návrh. Překrývající směny, neplatné částky a data server odmítá; opravy zachovávají původní sazby skutečné docházky. Uložená evidence se resetem ani novým nasazením nemaže.

Přehled správce a karta **Tržby a analýza** zobrazují denní součty mezd za zvolený měsíc. Sčítají všechny ukončené směny všech osob; detail ukazuje jednotlivé zaměstnance. Noční směna patří ke dni příchodu v Česku. Probíhající směny se označují a do skutečných mezd zatím nevstupují. Plánované náklady jsou oddělené a používají aktuální sazby zaměstnanců; skutečné mzdy používají sazby uložené v docházce. Čisté mzdy zůstávají orientační.

## Uložení a přechod z dema

Statické HTML, CSS a JavaScript bez sestavování frontendu doplňují Netlify Functions, Netlify Identity a Netlify Database (Postgres) přes Drizzle ORM. Při prvním požadavku nové verze proběhne uživatelem schválené jednorázové vyčištění zaměstnaneckých a provozních záznamů a vytvoření profilů Martina a Daniely. Vyčištění i příznak dokončení jsou v jedné transakci. Další návštěvy ani nasazení existující záznamy nemažou. Již aplikované migrace zůstaly nezměněné; struktura tabulky se nemění.

## Vývoj a ověření

Po `npm install` spusťte `netlify dev --port 8889`. Samotné otevření HTML souboru neposkytuje přihlašování, API ani databázi. Veřejnou aplikaci otevírejte přes HTTPS.

`npm test` ověřuje skutečný API dispatcher s izolovanými náhradami Identity a databáze: oprávnění, jednorázové vyčištění, oddělení záznamů, zadávání a opakování tržeb, validaci, nastavení e-mailu a docházku. Testy neposílají e-maily a nezapisují do provozní databáze. `npm run test:browser` po instalaci prohlížečů (`npx playwright install chromium firefox`) ověřuje rozhraní v Chromiu a Firefoxu na notebooku a v mobilním rozložení. Používá izolované odpovědi API, neposílá skutečné e-maily. Doručení aktivačních e-mailů a skutečné přihlášení vyžadují nasazené a aktivované Netlify Identity.

Netlify publikuje `public` a nasazuje `netlify/functions`. Migrace v `netlify/database/migrations` aplikuje platforma při nasazení. Po změně schématu vytvořte novou migraci pomocí `npx drizzle-kit generate --name descriptive_name`; již aplikované migrace neupravujte.
