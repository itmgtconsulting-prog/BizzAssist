# BizzAssist — Projekt Backlog & Teknisk Hukommelse

_Sidst opdateret: 2026-03-24_

---

## Leverandøroplysninger

- **Pecunia IT ApS** · CVR: 44718502 · Søbyvej 11, 2650 Hvidovre
- Forretning: info@pecuniait.com
- Support: support@pecuniait.com

---

## IGANGVÆRENDE SPRINT

- [ ] Fjern Rapport + AI Analysér knapper fra ejendomssiden
- [ ] Byg AI chat-panel "AI Bizzness Assistent" (venstre side, under sidemenu, resizable, default åben)
- [ ] Tilføj leverandørinfo + kontaktmails til hjemmesiden/footer
- [ ] Fix BBR-kort der forsvinder på ejendomssiden

---

## BACKLOG — Dataintegration via Datafordeler

Datafordeler API base: `https://services.datafordeler.dk/`
Auth: certifikat (OCES P12) + bruger/kode eller serviceaftale

### Høj prioritet — Ejendomsdata

#### 1. Ejerfortegnelsen (EJF) — Ejerskab/Ejerskifte

**Endpoint:** `/EjendomBeliggenhedsadresse/HentEjendomme/1/rest/`

- Hvem ejer ejendommen → kobling til Person (CPR) og CVR
- `Ejerskab`: ejerforholdskode, tinglystEjerandel, faktiskEjerandel
- `Ejerskifte` + `Handelsoplysninger`: handelspris, overtagelsesdato
- `Ejendomsadministrator`: administrator (CVR-nr / Person)
- **Kobling:** BFEnummer → Person/CVR → ejers adresse (DAR)
- **Use case:** "Hvem ejer denne ejendom og hvilke andre ejendomme ejer de?"

#### 2. Ejendomsvurdering (VUR) — Ejendoms- og grundværdi

**Endpoint:** `/Ejendomsvurdering/Ejendomsvurdering/1/rest/`

- `ejendomsværdiBeløb` — offentlig ejendomsværdi
- `grundværdiBeløb` — grundværdi
- `år` — vurderingsår
- `bebyggelseProcent` — bebyggelsesgrad
- `vurderetAreal` — vurderet areal
- **Kobling:** BFEnummer
- **Use case:** Vise ejendomsværdi + grundværdi direkte på ejendomssiden

#### 3. Matrikel — Jordstykke & arealer

**Endpoint:** `/MatrikelServiceDK/MatrikelServiceDK/1/rest/`

- `registreretAreal` — registreret grundareal (m²)
- `fredskov` — fredskovspligt (bool)
- `strandbeskyttelse` — strandbeskyttelseslinje (bool)
- `klitfredning` — klitfredning (bool)
- `vandarealinkludering` — inkluderer vandareal
- `vejareal` — vejudlæg areal
- Geometri: `GM_MultiSurface` — matrikelpolygon til kort
- **Kobling:** matrikelnummer + ejerlavskode (fra BBR Ejendomsrelation)
- **Use case:** Vis jordstykke på kort, naturrestriktioner, præcist areal

#### 4. BBR — Bygninger (allerede delvist integreret)

**Endpoint:** `/BBR/BBRPublic/1/rest/`

- Mangler stadig: `byg056Varmeinstallation`, `byg057Opvarmningsmiddel`, `byg070Fredning`
- Enhedsniveau: antal værelser, toilet/bad/køkken, boligtype
- `TekniskAnlæg`: solceller, varmepumper, oliefyr, vindmøller

### Medium prioritet

#### 5. DAGI — Administrative grænser

**Endpoint:** `/DAGI/DAGIKort/1/rest/`

- Kommune, region, politikreds, retskreds, opstillingskreds, sogn
- **Use case:** "Hvilken kommune/region/politikreds ligger ejendommen i?"

#### 6. GeoDanmark — Topografi

**Endpoint:** `/GeoDanmark/GeoDanmarkWFS/1/wfs`

- Nærliggende veje, jernbaner, skove, søer, havne
- **Use case:** Nærhedssøgning og kortvisualisering

#### 7. Stednavne (SN)

**Endpoint:** `/Stednavne/Stednavne/1/rest/`

- Bebyggelsesnavne, naturområder, fortidsminder
- **Use case:** "Hvad hedder det lokale område?"

### Lav prioritet / Fremtid

#### 8. SKV — Skatteforvaltningens virksomhedsregister

- Supplerer CVR med kreditstatus, SE-nummer
- **Use case:** Udvidet virksomhedsprofil

#### 9. Fikspunkter + Højdekurver

- Terrænhøjde, geodætiske fikspunkter
- **Use case:** Eventuel 3D-visualisering

---

## BACKLOG — Ejendomsovervågning (Følg-funktion)

**Arkitektur:** Database (Supabase/PostgreSQL) + Cron-job

```
tracked_properties (property_id, user_id, created_at)
property_snapshots (property_id, data JSON, hash MD5, fetched_at)
notifications (user_id, property_id, change_summary, seen_at)
```

**Polling-frekvens:** Nat (03:00) — re-fetch BBR + CVR + Matrikel + VUR for fulgte ejendomme
**Hvad detekteres:** Areal-ændring, ny/lukket CVR-virksomhed, ejerskifte, ny vurdering, fredning
**Notifikation:** Email (Resend/SendGrid) + in-app notifikationsbjælde (allerede i UI)

---

## BACKLOG — AI Bizzness Assistent

**Arkitektur:** Fetch-on-demand + 24t cache + Claude API

```
1. Bruger stiller spørgsmål om ejendom/person/virksomhed
2. Middleware identificerer kontekst (BFE/CVR/CPR)
3. Hent data: BBR + VUR + EJF + Matrikel + CVR (fra cache < 24t, ellers live)
4. Byg context-string og send til claude-sonnet-4-6
5. Stream svar tilbage til chatpanel
```

**Gruppe-analyse:** CVR → alle P-numre/adresser → batch BBR fetch → samlet AI kontekst
**Panel:** Venstre side, under sidemenu, resizable med drag-bjælke, navn: "AI Bizzness Assistent"

---

## BACKLOG — Infrastruktur & Sikkerhed

### GitHub Secret — OCES Certifikat

- Certifikat udstedt til: BizzAssist / Pecunia IT Consulting ApS (CVR: 44718502)
- Gyldigt: 2026-03-24 → 2029-03-23
- **ALDRIG commit .p12 til Git**
- Gem som `BIZZASSIST_CERT_P12` (base64) i GitHub Actions Secrets + Vercel env vars
- `.gitignore` skal indeholde: `*.p12`, `*.pfx`, `*.key`, `*.pem`, `.env.local`

### CVR Erhvervsstyrelsen ElasticSearch

- Venter på system-til-system adgang (op til 3 uger)
- Credentials: `CVR_ES_USER` + `CVR_ES_PASS` i `.env.local`
- Endpoint: `https://distribution.virk.dk/cvr-permanent/virksomhed/_search`

### CPR Register

- Ansøgning indsendt — juridisk review anbefales inden godkendelse
- Kræver lovhjemmel (CPR-loven § 38), GDPR-behandlingsgrundlag, DPA med kunder

---

## NØGLE-ID'ER PÅ TVÆRS AF REGISTRE

| ID                                | Register                      | Kobler til                     |
| --------------------------------- | ----------------------------- | ------------------------------ |
| `BFEnummer`                       | Matrikel (BestemtFastEjendom) | VUR, EJF, BBR Ejendomsrelation |
| `matrikelnummer` + `ejerlavskode` | Matrikel (Jordstykke)         | BBR Grund, Matrikel geom       |
| `husnummerId` (DAR)               | DAR Husnummer                 | BBR Bygning, Opgang            |
| `cvrnummer`                       | CVR Virksomhed                | EJF Ejerskab, SKV              |
| `pnummer`                         | CVR Produktionsenhed          | EJF Ejendomsadministrator      |
| `adresseId` (DAWA/DAR)            | DAR Adresse                   | BBR, CVR beliggenhed           |

---

## TEKNISK ARKITEKTUR

### Datafordeler Auth

```typescript
// Med OCES certifikat (P12)
const cert = Buffer.from(process.env.BIZZASSIST_CERT_P12!, 'base64');
// + bruger/kode eller kun certifikat afhængig af serviceaftale
```

### API Endpoints (Datafordeler REST)

```
BBR:        https://services.datafordeler.dk/BBR/BBRPublic/1/rest/
DAR:        https://services.datafordeler.dk/DAR/DAR/1/rest/
Matrikel:   https://services.datafordeler.dk/MatrikelServiceDK/MatrikelServiceDK/1/rest/
DAGI:       https://services.datafordeler.dk/DAGI/DAGIKort/1/rest/
EJF:        https://services.datafordeler.dk/EjendomBeliggenhedsadresse/HentEjendomme/1/rest/
VUR:        https://services.datafordeler.dk/Ejendomsvurdering/Ejendomsvurdering/1/rest/
CVR:        https://distribution.virk.dk/cvr-permanent/virksomhed/_search (Erhvervsstyrelsen ES)
```

### Plandata WFS (bekræftet fungerende)

```
https://geoserver.plandata.dk/geoserver/wfs
```
