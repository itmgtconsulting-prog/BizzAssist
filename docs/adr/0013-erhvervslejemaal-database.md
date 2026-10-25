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

## Beslutning (forslag)

Fasedelt, så vi ikke investerer i teknik før juraen er på plads:

- **Fase 0 — Juridik & kildevalg (blokerende).** Kortlæg kilder; afklar for hver:
  tilladt via feed/API/aftale (A), eller kræver afgrænset indsamling (B) med
  robots/ToS-gennemgang. Kort ekstern juridisk vurdering. Output: godkendt
  kildeliste + indsamlingsregler.
- **Fase 1 — Datamodel + manuel/seed-import.** Opret `erhvervslejemaal_udbud`
  (+ `price_history`), geokodning og BFE-match (genbruger adresse→BFE-pipelinen
  fra BIZZ-2305). Seed med data fra en godkendt kilde for ét område.
- **Fase 2 — Ugentlig ingest-cron (kun godkendte kilder).** Per kilde/område:
  hent → parse → normalisér → upsert med `first_seen`/`last_seen` +
  `price_history`. Overhold rate-limits.
- **Fase 3 — Produkt.** "Lejemål"-modul + område-analytics (median kr/m²/år,
  liggetid, udbudsmængde over tid) + AI-værktøj `hent_lejemaal`.

## Arkitektur

```
[Godkendt kilde: feed/API/afgrænset hent]
        │  (ugentlig Vercel-cron, rate-limited, robots-venlig)
        ▼
[Parser pr. kilde] → normaliseret lejemål
        │  (adresse, areal m², leje kr/år + kr/m²/år, type, status)
        ▼
[Geokod → BFE-match]  (genbruger /api/ejere-paa-vej-pipelinen: DAR→MAT)
        ▼
[Upsert erhvervslejemaal_udbud]
        │  dedup på (kilde, kilde_listing_id); opdatér last_seen;
        │  ved pris-ændring: append til price_history
        ▼
[Analytics-views]  median/percentiler pr. kommune/postnr/type over tid
        ▼
[UI "Lejemål"-modul  +  AI-værktøj hent_lejemaal]
```

## Datamodel (skitse)

```sql
create table public.erhvervslejemaal_udbud (
  id               uuid primary key default gen_random_uuid(),
  kilde            text not null,                 -- fx 'portalX' (godkendt kilde)
  kilde_listing_id text not null,                 -- portalens annonce-id (dedup)
  adresse          text,
  postnr           integer,
  kommune          text,
  bfe_nummer       integer,                       -- match til BizzAssist-ejendom
  areal_m2         integer,
  erhvervstype     text,                          -- kontor/lager/butik/produktion …
  leje_kr_aar      integer,
  leje_kr_m2_aar   numeric(10,2),                 -- afledt nøgletal (moaten)
  status           text,                          -- 'udbudt' | 'udlejet' | 'trukket'
  first_seen       date not null,
  last_seen        date not null,
  price_history    jsonb not null default '[]',   -- [{dato, leje_kr_m2_aar}] tidsserie
  kilde_hash       text,                          -- change-detection
  unique (kilde, kilde_listing_id)
);
```

Vi gemmer **afledte felter + tidsserie**, ikke fulde annoncekopier (jf. jura).
Mægler-kontaktpersoner gemmes ikke (GDPR-minimering).

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
