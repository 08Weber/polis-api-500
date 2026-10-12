# Utryckning LKPG

Polisens händelser i Östergötland – Linköping, Norrköping och resten av länet – i första hand, och hela
Sverige som tillval. Direkt från
[Polisens öppna API](https://polisen.se/om-polisen/om-webbplatsen/oppna-data/api-over-polisens-handelser/).
En inofficiell hobbysida utan koppling till Polisen.

**Live:** https://08weber.github.io/polis-api-500/ (GitHub Pages från `main`)

## Funktioner

- Östergötland som start: ungefär ett halvårs händelser i länet, filtrerbart per kommun (ort)
- Hela Sverige som tillval (de 500 senaste händelserna i landet), filtrerbart per län
- Notiser vid nya händelser i Östergötland eller i en vald kommun
- Händelserna grupperade per dag, nyast först, med ort, län, tid och länk till hela notisen på polisen.se
- Sök i fritext och filtrera på händelsetyp och kategori (våld, stöld, trafik, brand, sammanfattningar, övrigt)
- Filtren hamnar i adressfältet, så att en filtrerad vy går att dela (`?ort=Linköping&kategori=trafik`,
  `?omrade=sverige&lan=Skåne+län`)
- Nyckeltal för urvalet: antal, senaste dygnet och veckan, vanligaste typ och ort med flest händelser
- Uppdateras automatiskt var femte minut och markerar nya händelser
- Kan läggas till på hemskärmen som en app
- Ljust och mörkt tema, fungerar på mobil, tangentbord (`/` hoppar till sök) och skärmläsare

Designen bygger på svenska polisbilar: marinblått, polisblått och fluorescerande gulgrönt, stora block
i en rad längs sidan (inte brittiska rutor), en egenritad polisbil med blåljus som blinkar, ett
reflexmärke som logga och Polisens blåvita avspärrningsband i sidfoten. Blåljusen blinkar lugnt (högst
ungefär en gång per sekund) och står stilla för den som valt reducerad rörelse. Polisens logotyp och
vapen används inte.

## Notiser

Klockan i sidhuvudet slår på notiser. Man kan välja hela Östergötland eller en kommun, och skicka en
testnotis. Sammanfattningar (t.ex. "Sammanfattning natt") skickas inte som notiser.

Begränsningar, eftersom sidan är statisk och saknar server:

- Notiserna kommer **medan sidan är öppen**, även i en flik i bakgrunden. När sidan är helt stängd
  kommer inga notiser. Det skulle kräva push-notiser och en server som bevakar API:et.
- På **iPhone** fungerar notiser bara när sidan är tillagd på hemskärmen (Dela → Lägg till på
  hemskärmen) och öppnad därifrån.
- Webbläsaren frågar om lov första gången. Har man nekat måste det ändras i webbläsarens inställningar.

`sw.js` är en liten service worker som behövs för notiser på Android och för att öppna rätt händelse
när man trycker på en notis. Den cachar ingenting.

## Så fungerar det

Sidan är helt statisk (HTML, CSS och JavaScript utan byggsteg). Webbläsaren hämtar direkt från
Polisens API, vilket fungerar eftersom API:et skickar `Access-Control-Allow-Origin: *`:

- Östergötland: `https://polisen.se/api/events?locationname=Östergötlands län`
- Hela Sverige (bara när man väljer det): `https://polisen.se/api/events`

```
index.html            sidan
style.css             design
js/polisen.js         tolkar API-svaret (rena funktioner, används även av tester och kontroll)
js/app.js             hämtning, områden, filter, rendering och notiser
js/tema.js            sätter ljust/mörkt tema innan sidan ritas
sw.js                 service worker för notiser
manifest.webmanifest  för att kunna lägga sidan på hemskärmen
scripts/              check-api.mjs: kontrollerar API:et, serve.mjs: lokal utvecklingsserver
test/                 enhetstester med riktiga händelser från API:et
fonts/                Barlow och Barlow Condensed
```

## Bra att veta om API:et (oktober 2026)

- Utan filter innehåller svaret de 500 senaste notiserna i hela landet, vilket motsvarar ungefär en
  vecka.
- Med `?locationname=Östergötlands län` ger API:et upp till 500 notiser för bara länet. Det räckte
  ungefär ett halvår bakåt (453 händelser).
- `location.name` är numera alltid **länet**, till exempel "Östergötlands län", och koordinaten är länets
  mittpunkt. Orten finns bara i rubriken: `"11 oktober 14.06, Trafikolycka, singel, Linköping"`.
- `datetime` är när notisen **publicerades**. Själva händelsetiden står också i rubriken och kan ligga
  flera timmar tidigare. Sidan visar och sorterar på händelsetiden.
- `datetime` har formatet `2026-10-10 7:44:49 +02:00`, ibland med ensiffrig timme. Det klarar inte
  alla webbläsare (Safari) med `new Date()`, så sidan tolkar det själv.
- API:et kan en kort stund svara `[]` (HTTP 200 med tom lista). Sidan behåller då den senaste datan och
  försöker igen.
- [Polisens regler för öppna data](https://polisen.se/om-polisen/om-webbplatsen/oppna-data/regler-for-oppna-data/)
  kräver minst 10 sekunder mellan anropen och högst 60 anrop i timmen. Annars kan API:et svara 429 eller
  blockera. Sidan håller sig under gränsen även med flera flikar öppna i samma webbläsare: högst 50 anrop
  i timmen, aldrig tätare än var tionde sekund, och den väntar 15 minuter om API:et ändå svarar 429.

## Automatisk kontroll

GitHub Actions-flödet [Kontroll](.github/workflows/kontroll.yml) kör enhetstesterna och
`scripts/check-api.mjs` vid varje push och varje måndag. Kontrollen hämtar API:et på riktigt, både för
hela Sverige och för Östergötland, och kontrollerar CORS, att alla fält som sidan använder finns och går
att tolka, och att länsfiltret bara ger händelser i länet. Om Polisen ändrar något skickar GitHub ett
mejl om att körningen misslyckades.

## Utveckla lokalt

Kräver Node.js 20 eller senare. Inga beroenden behöver installeras.

```sh
npm start           # lokal server på http://localhost:8080 (bara den egna datorn)
npm test            # enhetstester
npm run check-api   # kontrollerar Polisens API på riktigt
npm run check-api -- --lan "Östergötlands län"
```

Sidan använder JavaScript-moduler, så den måste visas via en server (`npm start`) och inte genom att
öppna `index.html` direkt som fil.

## Säkerhet

Sidan har ingen server, inga konton, ingen databas och inga hemligheter. Allt körs i besökarens
webbläsare, och det enda som sparas (i `localStorage`) är tema, notisinställning, vilka händelser som
redan notifierats, en kopia av senaste API-svaret och tidpunkterna för de senaste anropen.

- Data från API:et behandlas som opålitlig. Den sätts alltid in som text, aldrig som HTML, och länkar
  släpps bara igenom om de går till `https://polisen.se`.
- En Content Security Policy i `index.html` tillåter bara sidans egna filer och anrop till
  `https://polisen.se`. Inga inline-skript är tillåtna, och Trusted Types stoppar HTML-injektion i
  webbläsare som stöder det. GitHub Pages kan inte skicka egna headers, så policyn ligger i en
  `<meta>`-tagg. Därför saknas skydd som bara fungerar som header, till exempel `frame-ancestors`.
- Typsnitt och ikoner ligger i repot. Inga skript eller stilar laddas från andra servrar, och sidan har
  inga npm-beroenden.
- GitHub Actions har bara läsrätt, är låsta till exakta commits och uppdateras av Dependabot.

Hittar du ett säkerhetsproblem som inte bör vara offentligt: rapportera det privat under fliken
Security → Report a vulnerability. Annat går bra som ett vanligt ärende (issue).

## Licenser

- Data: [Polisens öppna data](https://polisen.se/om-polisen/om-webbplatsen/oppna-data/). Uppgifterna är
  preliminära och kan ändras.
- Typsnitt: [Barlow](https://github.com/jpt/barlow), SIL Open Font License, se `fonts/OFL.txt`.
- Ikoner: [Lucide](https://lucide.dev), ISC-licens (vissa ikoner från Feather, MIT), se `LICENSE-lucide.txt`.

Made by Mille Weber.
