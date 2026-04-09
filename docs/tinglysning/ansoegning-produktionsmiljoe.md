# Ansøgning om adgang til e-TL produktionsmiljø

**Til:** Tinglysningsretten – Driftsafdeling
**E-mail:** e-tl-011@domstol.dk
**Fra:** Pecunia IT Consulting ApS
**CVR:** 44718502
**Dato:** 7. april 2026

---

## 1. Formål med systemadgangen

BizzAssist er en dansk business intelligence-platform, der aggregerer og præsenterer offentligt tilgængeligt data om faste ejendomme, virksomheder og personer for professionelle brugere — herunder ejendomsmæglere, advokater, revisorer, banker og erhvervsinvestorer.

Formålet med adgang til e-TL er at give BizzAssist-brugere direkte indsigt i tingbogens offentlige oplysninger som en integreret del af ejendoms- og virksomhedsanalyserne:

- **Ejendomsvisning**: Vis tinglyste oplysninger (ejere, adkomsthavere, hæftelser, servitutter, pantebreve) direkte i ejendomsdetaljesiden for en fast ejendom identificeret ved BFE-nummer.
- **Virksomhedsvisning**: Vis registrerede hæftelser i Personbogen (virksomhedspant, løsørepant, fordringspant, ejendomsforbehold) for virksomheder identificeret ved CVR-nummer.
- **Dokumentadgang**: Hent og præsenter tinglysningsdokumenter (pantebreve, skøder, servitutter) som PDF til brugere med behov for at se det fulde dokument.

Systemet anvender **udelukkende forespørgsels-services** — der anmeldes ikke dokumenter via systemadgangen.

---

## 2. Implementerede services

BizzAssist anvender HTTP API (forespørgsel) med 2-vejs SSL (OCES systemcertifikat). Følgende services er implementeret:

### 2.1 Fast ejendom

| Service            | Endpoint                                                                       | Beskrivelse                                                                    |
| ------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Søgning            | `GET /tinglysning/ssl/ejendom/hovednoteringsnummer?hovednoteringsnummer={BFE}` | Søger ejendom med BFE-nummer, returnerer UUID og summariske oplysninger        |
| Opslag (summarisk) | `GET /tinglysning/ssl/ejdsummarisk/{uuid}`                                     | Henter fuld summarisk ejendomsdata inkl. ejere, hæftelser og servitutter (XML) |
| Dokumentopslag     | `GET /tinglysning/ssl/dokaktuel/uuid/{dokumentId}`                             | Henter enkelt dokument som XML (til PDF-konvertering)                          |

### 2.2 Personbog (virksomheder)

| Service | Endpoint                                                  | Beskrivelse                                      |
| ------- | --------------------------------------------------------- | ------------------------------------------------ |
| Søgning | `GET /tinglysning/unsecuressl/soegpersonbogcvr?cvr={CVR}` | Søger i Personbogen med CVR-nummer               |
| Opslag  | `GET /tinglysning/unsecuressl/personbog/{uuid}`           | Henter hæftelser registreret i Personbogen (XML) |

### 2.3 Snitflade

- **Snitflade:** HTTP API (forespørgsel)
- **Autentifikation:** 2-vejs SSL med OCES systemcertifikat (NemID/MitID FOCES)
- **Certifikatformat:** PFX (PKCS#12), konfigureret som base64-encodet miljøvariabel på Vercel-hosting
- **Anmeldelser:** Ikke implementeret — systemet foretager udelukkende forespørgsler

---

## 3. Gennemført testforløb

Testforløbet er gennemført mod **fællestestmiljøet** (`https://test.tinglysning.dk`) med et NETS test-certifikat (devtest4-miljø).

### 3.1 Funktionelle tests

| Scenarie                                                                        | Resultat                         |
| ------------------------------------------------------------------------------- | -------------------------------- |
| Søgning på BFE-nummer returnerer UUID og adresse                                | ✅ Testet og fungerer            |
| Opslag med UUID returnerer EjendomSummariskHentResultat XML                     | ✅ Testet og fungerer            |
| XML-parser udtrækker ejere, adkomsttype, ejerandel, overtagelsesdato og købesum | ✅ Valideret mod kendte testdata |
| XML-parser udtrækker hæftelser med type, beløb, kreditor og prioritet           | ✅ Valideret mod kendte testdata |
| XML-parser udtrækker servitutter med type og tekst                              | ✅ Testet                        |
| Personbogssøgning med CVR-nummer returnerer UUID-liste                          | ✅ Testet                        |
| Personbogsopslag returnerer LoesoereSummariskHentResultat XML                   | ✅ Testet                        |
| Parser udtrækker virksomhedspant, løsørepant og fordringspant korrekt           | ✅ Valideret                     |
| Dokumentopslag med UUID returnerer DokumentAktuelHentResultat XML               | ✅ Testet                        |
| XML-til-PDF konvertering genererer læsbar PDF med korrekte felter               | ✅ Testet                        |

### 3.2 Fejlhåndtering

BizzAssist håndterer følgende fejlsituationer eksplicit:

**HTTP-fejl fra e-TL:**

- `404 Not Found`: Returnerer `{ error: 'Ejendom ikke fundet i tingbogen' }` til klienten med HTTP 404. UI viser en informativ besked til brugeren uden at kaste en runtime-fejl.
- `500 / 502`: Logges server-side (Sentry), returneres til klient som `{ error: 'Ekstern API fejl' }` uden at eksponere interne fejldetaljer.
- Andre 4xx/5xx: Propageres med status-kode og logges.

**Netværk og timeout:**

- Alle kald har `AbortSignal.timeout(15000)` (15 sekunder). Ved timeout destrueres socket (`req.destroy()`) og der returneres en fejlbesked til klienten.
- Netværksfejl (`req.on('error', ...)`) fanges og returneres som HTTP 500 med generisk fejlbesked.

**Certifikat-fejl:**

- Hvis certifikats-miljøvariablerne ikke er sat, returneres HTTP 503 med `{ error: 'Tinglysning certifikat ikke konfigureret' }` — systemet deaktiverer sig selv pænt uden at kaste uventede fejl.
- Certifikatet loades fra base64-encodet miljøvariabel (Vercel-kompatibelt) eller filsti som fallback.

**Ugyldigt input:**

- BFE-numre valideres med regex (`/^\d+$/`) — ikke-numerisk input afvises med HTTP 400.
- CVR-numre valideres til præcis 8 cifre — andet afvises med HTTP 400.
- Dokument-UUID'er valideres med UUID-format-regex inden opslag.

**Test-miljø fallback:**

- I testmiljøet benyttes et kendt test-BFE (100165718) som fallback, når det søgte BFE ikke eksisterer i testdata. Fallback markeres eksplicit med `testFallback: true` i svaret, og UI viser en synlig advarsel. Denne fallback fjernes automatisk, når `TINGLYSNING_BASE_URL` skiftes til produktions-URL.

**Caching:**

- Svar caches i 1 time (`Cache-Control: public, s-maxage=3600, stale-while-revalidate=600`) for at reducere belastningen på e-TL. Cachen invalideres ikke ved dokument-ændringer; dette anses som acceptabelt da tingbogsdata er relativt stabilt intradag.

---

## 4. Teknisk arkitektur

- **Hosting:** Vercel (serverless, Node.js runtime)
- **Framework:** Next.js 16 App Router
- **Certifikat-opbevaring:** Base64-encodet PFX i krypteret Vercel-miljøvariabel (`NEMLOGIN_CERT_B64`)
- **IP-adresser:** Alle kald til e-TL afsendes fra en dedikeret Hetzner-proxy med statisk IP-adresse. Nedenstående IP-adresse bedes tilføjes til e-TL's IP-whitelist:

  | Miljø               | IP-adresse        | Formål                                                |
  | ------------------- | ----------------- | ----------------------------------------------------- |
  | **Test/Produktion** | `204.168.164.252` | Hetzner VPS proxy (statisk egress for Vercel-hosting) |

  Bemærk: IP-adressen `93.161.46.78` (lokal udviklingsmaskine) er allerede whitelistet til testmiljøet og benyttes under udviklingstest.

- **Systemcertifikat (produktion):** OCES3 FOCES systemcertifikat udstedt til Pecunia IT Consulting ApS, CVR 44718502, via MitID Erhverv / Nets.

---

## 5. Forudsætninger (storkunde-registrering)

Vi er bekendt med, at adgang til produktionsmiljøet kræver registrering som **storkunde hos SKAT** i henhold til § 20, stk. 3 i bekendtgørelse nr. 1634 af 29. juni 2021 om tekniske krav og forskrifter for tinglysningssystemet.

**Status:** Pecunia IT Consulting ApS er registreret til betaling af tinglysningsafgift, hvilket udgør grundlaget for storkunde-status. Der er ikke udstedt et separat certifikat i forbindelse med registreringen.

Registreringen som storkunde bekræftes ved dokumentation for registrering til betaling af tinglysningsafgift, som vedlægges som bilag.

---

## 6. Kontaktperson (teknisk)

| Felt       | Oplysning                 |
| ---------- | ------------------------- |
| Navn       | Jakob Juul Rasmussen      |
| E-mail     | support@pecuniait.com     |
| Telefon    | +45 2434 2655             |
| Virksomhed | Pecunia IT Consulting ApS |
| CVR        | 44718502                  |
| Adresse    | Søbyvej 11, 2650 Hvidovre |

---

## Bilag

1. Dokumentation for implementerede services (kode-eksempler på request/response-håndtering)
2. Dokumentation for registrering til betaling af tinglysningsafgift (bekræftelse af storkunde-status hos SKAT)

---

_Pecunia IT Consulting ApS forbeholder sig retten til at videregive tingbogsdata til egne abonnenter alene inden for rammerne af offentlighedsprincippet og persondataforordningen (GDPR). Der videregives ikke data til tredjeparter uden for platformens brugerbase._
