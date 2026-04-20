# ADR 0004 — Evaluering af e-TL event-feed / hændelser til incremental synk

Status: Accepted (investigation complete — implementation deferred)
Date: 2026-04-20
JIRA: BIZZ-615
Related: BIZZ-480/481 (EJF handelsoplysninger), BIZZ-534 (EJF bulk-ingest), BIZZ-612/611 (prod event-ingest)

## Mål

Vurdere om Tinglysningsrettens e-TL tilbyder en event-feed / ændringsstream
der kan bruges til incremental synk af tinglysningsdata — analogt til
Datafordeler Hændelsesbesked for EJF/BBR.

## TL;DR

**e-TL _tilbyder_ et event-feed — "Valgfrit abonnement"** — men ikke et
ændringsstream eller delta-udtræk. Abonnement er pr. objekt (BFE, CVR,
personCPR, andelsboligID, m.fl.). Der findes ikke en global feed med
"alle ændringer siden timestamp X".

Konklusion for BizzAssist:

- **Brugbar til watch-list feature**: Brugeren følger specifikke
  ejendomme → vi opretter valgfrit abonnement for hver BFE i watch-
  listen og modtager push-notifikation ved ændringer (skødelæg,
  panthæftelse, udsletning m.m.). Gratis.
- **Ikke brugbar til bulk-sync** af alle danske ejendomme — der er
  ingen "giv mig alle ændringer" og man kan ikke abonnere på millioner
  af BFE'er.
- **Bulk incremental sync forbliver afhængig af** Datafordeler EJF/BBR
  Hændelsesbesked (BIZZ-534/612) kombineret med nattlig polling af
  /ejdsummarisk for specifikke BFE'er vi allerede har i vores database.

## Baggrund

I dag kalder vi e-TL "live" pr. BFE/CVR-opslag via mTLS:

- `app/api/tinglysning/route.ts` — `/ejendom/hovednoteringsnummer` → UUID
- `app/api/tinglysning/summarisk/route.ts` — `/ejdsummarisk/{uuid}` →
  summarisk akt med ejere, pant, servitutter m.m.
- `app/api/tinglysning/dokaktuel/route.ts` — `/dokaktuel/uuid/{uuid}` →
  fulde dokumenter

Ingen aggregerings-tabel findes i vores Supabase. Hver property detail
page-visning rammer e-TL direkte → 1-3 s latency og potentiel rate
limiting ved trafikspike.

Hvis e-TL havde haft et ændrings-API, kunne vi have bygget en
`tinglysning_events`-tabel og pre-materialize seneste tinglysnings-
status pr. ejendom.

## Undersøgelse

Kilde: `docs/tinglysning/system-systemmanual-v1.53.txt` (v1.53, april 2026).

### 1. Findes et event-feed?

**Ja.** System-systemmanualen beskriver i afsnit om "Abonnement":

> Den digitale tinglysning tilbyder interesserede, at de kan abonnere på
> de forretningshændelser, som sker. Der er derfor et modul, hvor man
> kan abonnere på de forretningshændelser, man er interesseret i, og
> som efterfølgende sender information om forretningshændelserne til
> abonnenten.
>
> System-systembrugere har via systemsnitfladen adgang til at
> vedligeholde abonnementer og modtage hændelser.

### 2. To abonnements-typer

**(a) Tvangsabonnement** — for anmeldere (dvs. aktører der SENDER
dokumenter ind). Automatisk notifikation ved:

- En retsanmærkning slettes
- Fastsatte tidsfrist for dokument er ved at blive overskredet
- Dokument tinglyst med frist udslettes

Ikke relevant for BizzAssist — vi er ikke anmelder, kun forespørger.

**(b) Valgfrie abonnementer** — gratis service, objekt-specifik:

> Valgfrie abonnementer er en gratis service, der giver mulighed for at
> få en orientering, når der sker hændelser på et bestemt objekt
> (ejendom, bil, andelsbolig, person etc.).
>
> Et abonnement er defineret af identifikation af det objekt, hvorpå
> man ønsker at følge tinglysningsaktivitet. Et abonnement gælder alle
> ekspeditionstyper. Det er op til modtageren at bortsortere uønskede
> hændelser.

### 3. Hvilke hændelser udløser et abonnement?

> Et abonnement udløses ved alle opdateringer af de aktuelt tinglyste
> rettigheder (ATR). Dvs. de samme hændelser som ved alm. svar på
> tinglysning:
>
> - Nyt dokument
> - Påtegning
> - Anmærkning fjernet
> - Udslettet pga. frist
> - Frist fjernet

Hver hændelse vedrører ét objekt og ét dokument.

### 4. Ikke fundet i dokumentationen

Der er IKKE dokumenteret:

- En global ændringsstream ("giv mig alle ændringer siden T")
- Et delta-udtræk / fil-eksport
- En polling-variant af abonnement (fx GET siden-timestamp)
- Bulk-subscribe til fx "alle BFE'er i en kommune" eller lignende
  område-filter

### 5. Leveringsformat

Abonnement-events leveres via **svarservices** som system-systembrugeren
skal udstille (sect. 6.2 Typer af system-systembrugere). Modtageren er
en webservice-endpoint hos abonnenten selv. Format: XML (samme skema som
alm. svar på tinglysning) — kompatibelt med vores eksisterende parser i
`app/api/tinglysning/*/route.ts`.

Udstilling af svarservices er et krav for at deltage i abonnements-
ordningen. Det indebærer at vores infrastruktur skal tilbyde et
indgående webservice-endpoint til e-TL (ikke bare udgående kald).

## Vurdering for BizzAssist

### Dækning

**Events vs. polling vs. delta-udtræk:** Kun events (push-notifikationer
per objekt). Ingen polling-variant eller delta-udtræk findes.

### Latency

Ikke dokumenteret i manualen, men almindelige svar på tinglysning leveres
typisk inden for sekunder efter tinglysning er fuldført. Pt. er tinglysning
ikke real-time i sig selv (manuel sagsbehandling kan tage dage-uger), så
event-latency er minimal ift. den samlede tinglysningsproces.

### Pris

Valgfrie abonnementer er **gratis**. Ingen trafikgebyr. Der er dog
omkostninger forbundet med:

- Drift af indgående svarservice-endpoint (Vercel/serverless har
  cold-starts der kan forsinke e-TL's callbacks)
- Vedligeholdelse af abonnements-registret hos e-TL (vi skal add/remove
  subscriptions per BFE efter behov)

### Format

XML via SOAP-lignende svarservice. Kompatibel med vores eksisterende
Tinglysning XML-parser (`app/api/tinglysning/summarisk/route.ts` m.fl.).

### Skalerbarhed

**Ikke brugbar til bulk-sync.** Med 2.8M BFE'er i Danmark er pr-objekt-
abonnement ikke praktisk for "alt". Systemmanualen nævner ikke en upper
bound på antal abonnementer per system-systembruger, men drift ville
være uhåndterbar på millionskala.

**Velegnet til watch-list** på et par hundrede eller tusinde BFE'er —
f.eks. en bruger der følger sit ejerskabsportefølje eller et firma der
overvåger pantbilleder på erhvervsejendomme.

## Beslutning

1. **Implementér IKKE et globalt tinglysning_events-synk i denne omgang.**
   Bulk incremental sync forbliver afhængig af Datafordeler EJF/BBR
   Hændelsesbesked (BIZZ-534/612) — e-TL har ikke en tilsvarende bulk-
   mekanisme.

2. **Planlæg en "Watch-list abonnement"-feature** (fremtidigt JIRA):
   - Bruger markerer ejendomme som "Følg" på ejendoms-detaljesiden
     (foelg_properties-tabel findes allerede i Supabase)
   - Background-job registrerer valgfrit e-TL-abonnement for hver
     fulgt BFE
   - Indgående webservice-endpoint `/api/tinglysning/event-callback`
     modtager XML-notifikationer
   - Events gemmes i ny `tinglysning_events`-tabel (tenant_id + bfe +
     ekspeditionstype + dok_uuid + timestamp)
   - Bruger får in-app notifikation (via Notifikationer-dropdown) ved
     nye events på fulgte ejendomme

3. **Forudsætning**: Produktions-systemadgang til e-TL skal være på
   plads (BIZZ-613 — ansøgning om produktionsmiljø). Dertil skal
   infrastrukturen understøtte udstilling af indgående webservice.

4. **Fortsæt live-lookup pattern** for aktuelle BFE-opslag på property
   detail page. Add 5-minutters Vercel-cache på `/api/tinglysning/*`
   for at reducere gentagne requests for samme BFE (ikke gjort i denne
   ADR).

## Noter / risici

- Abonnement kræver system-systembruger-adgang + svarservice-endpoint
  — større integration end eksisterende forespørgselsadgang. Kontakt
  til Tinglysningsrettens tekniske support anbefales inden
  implementering startes.
- Abonnementer er forbundet til anmelder-CVR. Hvis BizzAssists
  storkunde-ordning ikke dækker vores use case, skal vi afklare
  med CSC/Tinglysningsretten om vi kan oprette abonnementer som ren
  forespørgsel-aktør.
- Hvis valgfrie abonnementer kan bruges uden samtidig at være anmelder,
  er dette en lavthængende frugt til at få differentieret watch-list
  feature i produkt.

## Referencer

- `docs/tinglysning/system-systemmanual-v1.53.txt` — afsnit "Abonnement"
- `docs/tinglysning/http-api-beskrivelse-v1.12.txt` — HTTP API-beskrivelse
  (forespørgsels-siden)
- `docs/tinglysning/ansoegning-produktionsmiljoe.md` — BIZZ-613
  produktionsansøgning
- `app/api/tinglysning/**` — eksisterende tinglysnings-opslags-routes
