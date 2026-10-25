# ADR 0013: Erhvervslejemål-database (udbudte lejemål + lejeniveauer over tid)

**Status:** Foreslået (afventer juridisk godkendelse før scraping-implementering)
**Dato:** 2026-10-25
**Ticket:** BIZZ-2306

## Kontekst

Gap-analysen mod Resights (okt. 2026) viste ét stort datahul: **BizzAssist har
intet udlejnings-/lejemålsmodul**. Resights tilbyder udbudte erhvervslejemål +
lejeniveauer (asking rent) over tid. Det er efterspurgt af ejendomsinvestorer,
mæglere og långivere til at vurdere markedsleje, tomgang og liggetid.

Datagrundlaget findes offentligt på ejendomsportaler (fx lokalebasen.dk,
oline.dk, ejendomstorvet.dk, matchoffice, samt mæglernes egne annoncesider).
Idéen: ugentligt indsamle udbudte erhvervslejemål pr. område, normalisere, og
opbygge en **tidsserie** (udbudspris pr. m²/år + liggetid), som er moaten —
et øjebliksbillede kan kopieres, men en historik kan ikke.

**Vigtigt:** "offentligt tilgængeligt" er IKKE det samme som "frit at indsamle
systematisk og republicere kommercielt". Denne ADR behandler derfor **jura før
teknik** — scraping må ikke bygges før compliance-vejen er godkendt.

## Juridisk vurdering (gating)

Fire hensyn skal afklares, før data indsamles systematisk:

1. **Portalernes brugsvilkår (ToS).** Mange portaler forbyder eksplicit
   automatiseret indsamling/scraping og videredistribution. Brud kan være
   kontraktbrud og give adgangsspærring/erstatningskrav.
2. **robots.txt.** Skal respekteres som teknisk signal; ignorering svækker
   enhver "god tro"-position.
3. **EU-databasebeskyttelse (databasedirektivet, sui generis-ret).** Den der
   har foretaget en væsentlig investering i en database, har eneret mod
   systematisk udtræk/genanvendelse af væsentlige dele — selv af offentligt
   viste data. Systematisk høstning af en portals annoncebase kan krænke dette.
4. **GDPR.** Selve lejemålsdata er typisk ikke-persondata (erhverv), men
   mæglernes kontaktpersoner (navn/mail/tlf) er PII → dataminimering: gem ikke
   kontaktpersoner medmindre strengt nødvendigt og med lovligt grundlag.

**Anbefalet compliant vej (i prioriteret rækkefølge):**

- **A. Officielle feeds/API'er/dataaftaler.** Foretræk datakilder der eksplicit
  tillader genbrug (åbne feeds, partner-API, betalt dataaftale med portal/mægler).
- **B. Respektfuld, afgrænset indsamling** hvis A ikke findes: overhold
  robots.txt + ToS, lav rate-limiting og caching, undgå at belaste kilden, og
  gem kun **afledte/aggregerede** data (lejeniveauer, trends, liggetid,
  normaliserede felter) — ikke fuld-kopier af annoncetekst/billeder.
- **C. Juridisk review før kommerciel lancering.** En kort ekstern vurdering
  (ToS + sui generis) for de konkrete kilder, inden funktionen går live for
  betalende kunder.

Scraping-implementering (fase 2+) **blokeres** indtil A/B/C er afklaret.

## Fase 0 — Kildekortlægning (empirisk, 2026-10-25)

Verificeret via robots.txt + API-probing. **ToS-teksterne er client-renderede
(SPA) og IKKE verificeret** — skal læses manuelt/juridisk før man stoler på dem.

| Kilde                                                                            | robots.txt (verificeret)                                                                                | API/feed                                                                                                                        | Vurdering                                                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Lokalebasen.dk** (= **MatchOffice.dk**, samme firma — identisk robots+sitemap) | Tillader annonce-sider (blokerer kun `/api/`, `/admin/`, sessions)                                      | Nej (offentlige sider)                                                                                                          | Afgrænset indsamling teknisk mulig; ToS skal læses                       |
| **Ejendomstorvet.dk**                                                            | **Blokerer AI-crawlere eksplicit** (ClaudeBot, anthropic-ai, GPTbot, CCBot, Perplexity → `Disallow: /`) | `/api/v2` (OpenAPI). `GET /listings` er uden auth men **ustabil for anonym brug** (HTTP 500); `/queryable-data` **kræver auth** | Partner-API/dataaftale er oplagt; **anonym scraping frarådes** (AI-blok) |
| **Lokaler.dk**                                                                   | **WAF blokerer bots** ("455 Security Incident")                                                         | —                                                                                                                               | Aktiv anti-scraping → undgå                                              |
| **EDC Erhverv** (edc.dk)                                                         | Tillader alt (undt. `/umbraco`, `/swagger`)                                                             | Swagger (intern/301)                                                                                                            | Mægler-annoncer; indsamling teknisk muligt                               |
| **Oline.dk / Nybolig Erhverv**                                                   | Ingen/tom robots                                                                                        | —                                                                                                                               | Undersøg ToS nærmere                                                     |

**Juridiske begrænsninger (uafhængigt af at data er offentligt synligt):**

1. **Databasebeskyttelse** (Ophavsretslov §71 / EU-databasedirektiv) — rammer selve
   _udtrækket_ af væsentlige dele; den tungeste begrænsning.
2. **ToS/brugsbetingelser** — kan kontraktligt forbyde automatisk indsamling
   (ikke verificeret pga. SPA).
3. **robots.txt** — Ejendomstorvet blokerer eksplicit AI/Claude; Lokaler.dk har WAF.
4. **Markedsføringsloven §3/§22** (snylteri) + **GDPR** (mægler-kontakt = PII).

Aggregat-only + ingen sporbarhed fjerner _output_-/republicerings-risikoen, men
**ikke** §71-_udtræks_-risikoen.

**Konklusion Fase 0:** der er ingen generel lov der forbyder at samle offentlige
fakta, men det er **ikke automatisk tilladt** — det afhænger af hver kildes ToS +
§71 + metode. Den reneste vej er **API/dataaftale** (Ejendomstorvets `/api/v2`
kræver i praksis en partner-/dataaftale; feed-aftale med Lokalebasen/MatchOffice).
Hvor det ikke findes: respektfuld, rate-limited indsamling **kun** hvor både
robots OG ToS tillader det, aggregat-only. **Juridisk sign-off før kommerciel
lancering.** Dette afsnit er **ikke juridisk rådgivning**.

## Beslutning (forslag)

Fasedelt, så vi ikke investerer i teknik før juraen er på plads:

- **Fase 0 — Juridik & kildevalg (blokerende).** Kortlæg kilder; afklar for hver:
  tilladt via feed/API/aftale (A), eller kræver afgrænset indsamling (B) med
  robots/ToS-gennemgang. Kort ekstern juridisk vurdering. Output: godkendt
  kildeliste + indsamlingsregler.
- **Fase 1 — Datamodel + manuel/seed-import.** Opret `lejemaal_observation`
  (intern) + `lejemaal_omraade_statistik` (eksponeret). Geokod adresse → område
  (postnr/kommune) transient under ingest (genbruger adresse→område-pipelinen fra
  BIZZ-2305); adressen gemmes ikke. Seed fra en godkendt kilde for ét område.
- **Fase 2 — Ugentlig ingest-cron (kun godkendte kilder).** Per kilde/område:
  hent → parse → normalisér → upsert i `lejemaal_observation` (dedup_hash,
  first_seen/last_seen) → genberegn `lejemaal_omraade_statistik`. Rå annoncedata
  gemmes ikke. Overhold rate-limits.
- **Fase 3 — Produkt.** "Lejemål"-modul + område-analytics (median kr/m²/år,
  liggetid, udbudsmængde over tid) + AI-værktøj `hent_lejemaal`.

## Arkitektur

```
[Godkendt kilde: feed/API/afgrænset hent]
        │  (ugentlig Vercel-cron, rate-limited, robots-venlig)
        ▼
[Parser pr. kilde] → normaliseret lejemål
        │  (areal m² → bucket, leje kr/m²/år, type; adresse KUN transient)
        ▼
[Geokod → område]  (postnr/kommune; adressen gemmes ikke)
        ▼
[Upsert lejemaal_observation]  (intern — eksponeres ALDRIG)
        │  dedup på dedup_hash; opdatér last_seen; ingen kilde-id/URL/adresse
        ▼
[Genberegn lejemaal_omraade_statistik]  median/percentiler/liggetid
        │  pr. kommune/postnr/type over tid; udstilles kun hvis antal ≥ k
        ▼
[UI "Lejemål"-modul  +  AI-værktøj hent_lejemaal]  (KUN aggregater)
```

## Design-princip: KUN aggregater, ingen sporbarhed (besluttet)

Produktet viser **aldrig det enkelte lejemål**. Brugeren vælger et **område** og
får **aggregerede nøgletal** (gennemsnit/median leje kr/m²/år, antal udbud,
liggetid, omkostninger) pr. område, erhvervstype og periode. Der gemmes og vises
**ingen kilde-URL, annonce-id, annoncetekst, billeder eller mægler-kontakt** —
så der er **ingen vej tilbage til den oprindelige annonce/kilde**.

Juridisk effekt: vi re-publicerer ikke en andens database; vi udstiller afledte
fakta/statistik. Det fjerner det primære sui-generis-/ophavsrets-hensyn på
_output_-siden. (Indsamlings-/udtræks-siden styres stadig af kildernes ToS +
sui-generis — derfor Fase 0.)

## Datamodel (skitse)

```sql
-- INTERN observations-tabel (eksponeres ALDRIG via UI/API). Bruges kun til at
-- beregne aggregater + dedup/liggetid. Ingen kilde-URL/annonce-id/annoncetekst
-- → ingen sporbarhed tilbage til kilden. Rå annoncedata gemmes ikke.
create table public.lejemaal_observation (
  id             uuid primary key default gen_random_uuid(),
  postnr         integer not null,
  kommune        text,
  erhvervstype   text,                     -- kontor/lager/butik/produktion …
  areal_bucket   text,                     -- '<200','200-500','500-1000','1000+'
  leje_kr_m2_aar numeric(10,2) not null,   -- afledt nøgletal
  first_seen     date not null,
  last_seen      date not null,            -- til liggetid
  dedup_hash     text not null,            -- hash(postnr+type+areal+prisniveau)
  unique (dedup_hash)                      -- IKKE kilde-id/URL
);

-- EKSPONERET aggregat (materialiseret, opdateres ugentligt) — DET ENESTE
-- brugeren/AI-værktøjet ser.
create table public.lejemaal_omraade_statistik (
  kommune              text,
  postnr               integer,
  erhvervstype         text,
  periode              date,               -- måned/kvartal
  antal_udbud          integer,
  median_kr_m2_aar     numeric(10,2),
  p25_kr_m2_aar        numeric(10,2),
  p75_kr_m2_aar        numeric(10,2),
  median_liggetid_dage integer,
  primary key (kommune, postnr, erhvervstype, periode)
);
```

- Eksakt adresse bruges KUN transient til område-/BFE-tildeling under ingest og
  gemmes ikke i observations-tabellen (kun postnr/kommune bevares).
- **Re-identifikations-spærre:** aggregater udstilles kun når `antal_udbud >= k`
  (fx k=5) pr. gruppe, så et enkelt udbud ikke kan udledes af statistikken.
- Mægler-kontaktpersoner gemmes aldrig (GDPR-minimering).

## Konsekvenser

- **Positivt:** lukker det primære Resights-gap; tidsserien er svær at kopiere
  og bliver mere værd over tid; genbruger eksisterende BFE-pipeline.
- **Risici:** juridisk (ToS/sui generis) — derfor Fase 0-gate; datakvalitet
  (portaler er ustrukturerede) — derfor normalisering + change-detection;
  drift/vedligehold af parsere pr. kilde — hold kildeliste lille i starten.
- **Omkostning:** løbende cron + parser-vedligehold; evt. betalt dataaftale.

## Alternativer

- **Køb data** fra en dataudbyder/portal (dataaftale) frem for egen indsamling —
  laveste juridiske risiko, højere direkte omkostning.
- **Partnerskab** med en mægler/portal om feed-adgang.
- **Gør intet** på lejemål og fokusér på BizzAssists vertikale styrker
  (AI, AML/KYC, forsikring, kredit) — men efterlader Resights-gap'et åbent.
