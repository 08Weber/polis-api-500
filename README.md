# Polishändelser – senaste 500 i Sverige

Visar Polisens 500 senaste händelsenotiser från hela Sverige, direkt från
[Polisens öppna API](https://polisen.se/om-polisen/om-webbplatsen/oppna-data/api-over-polisens-handelser/).
En inofficiell hobbysida utan koppling till Polisen.

**Live:** https://08weber.github.io/polis-api-500/ (GitHub Pages från `main`)

## Funktioner

- Händelserna grupperade per dag, nyast först, med ort, län, tid och länk till hela notisen på polisen.se
- Sök i fritext och filtrera på län, händelsetyp och kategori (våld, stöld, trafik, brand, sammanfattningar, övrigt)
- Filtren hamnar i adressfältet, så att en filtrerad vy går att dela (`?lan=Skåne+län&kategori=trafik`)
- Nyckeltal för urvalet: antal, senaste dygnet, vanligaste typ och mest drabbade län/ort
- Uppdateras automatiskt var femte minut och markerar nya händelser
- Sparar senaste svaret i webbläsaren, så att sidan visas direkt och klarar tillfälliga avbrott
- Ljust och mörkt tema, fungerar på mobil, tangentbord (`/` hoppar till sök) och skärmläsare

Designen bygger på svenska polisbilar: marinblått, polisblått och fluorescerande gulgrönt, stora block
i en rad längs sidan (inte brittiska rutor), en egenritad polisbil med blåljus som blinkar, ett
reflexmärke som logga och Polisens blåvita avspärrningsband i sidfoten. Blåljusen blinkar lugnt (högst
ungefär en gång per sekund) och står stilla för den som valt reducerad rörelse. Polisens logotyp och
vapen används inte.

## Så fungerar det

Sidan är helt statisk (HTML, CSS och JavaScript utan byggsteg). Webbläsaren hämtar
`https://polisen.se/api/events` direkt. Det fungerar eftersom API:et skickar
`Access-Control-Allow-Origin: *`.

```
index.html        sidan
style.css         design
js/polisen.js     tolkar API-svaret (rena funktioner, används även av tester och kontroll)
js/app.js         hämtning, filter och rendering
scripts/          check-api.mjs: kontrollerar att API:et fungerar som sidan förväntar sig
test/             enhetstester med riktiga händelser från API:et
fonts/            Barlow och Barlow Condensed
```

## Bra att veta om API:et (oktober 2026)

- Svaret innehåller de 500 senaste notiserna, vilket motsvarar ungefär en vecka.
- `location.name` är numera alltid **länet**, till exempel "Stockholms län", och koordinaten är länets
  mittpunkt. Orten finns bara i rubriken: `"10 oktober 21.35, Brand, Huddinge"`.
- `datetime` är när notisen **publicerades**. Själva händelsetiden står också i rubriken och kan ligga
  flera timmar tidigare. Sidan visar och sorterar på händelsetiden.
- `datetime` har formatet `2026-10-10 7:44:49 +02:00`, ibland med ensiffrig timme. Det klarar inte
  alla webbläsare (Safari) med `new Date()`, så sidan tolkar det själv.
- API:et kan en kort stund svara `[]` (HTTP 200 med tom lista). Sidan behåller då den senaste datan och
  försöker igen.

## Automatisk kontroll

GitHub Actions-flödet [Kontroll](.github/workflows/kontroll.yml) kör enhetstesterna och
`scripts/check-api.mjs` vid varje push och varje måndag. Kontrollen hämtar API:et på riktigt och
kontrollerar CORS, att alla fält som sidan använder finns och går att tolka, samt vilka händelsetyper
som förekommer. Om Polisen ändrar något skickar GitHub ett mejl om att körningen misslyckades.

## Utveckla lokalt

Kräver Node.js 20 eller senare. Inga beroenden behöver installeras.

```sh
npm start           # startar en lokal server på http://localhost:8080
npm test            # enhetstester
npm run check-api   # kontrollerar Polisens API på riktigt
```

Sidan använder JavaScript-moduler, så den måste visas via en server (`npm start`) och inte genom att
öppna `index.html` direkt som fil.

## Licenser

- Data: [Polisens öppna data](https://polisen.se/om-polisen/om-webbplatsen/oppna-data/). Uppgifterna är
  preliminära och kan ändras.
- Typsnitt: [Barlow](https://github.com/jpt/barlow), SIL Open Font License, se `fonts/OFL.txt`.
- Ikoner: [Lucide](https://lucide.dev), ISC-licens (vissa ikoner från Feather, MIT), se `LICENSE-lucide.txt`.

Gjord av @millew08.
