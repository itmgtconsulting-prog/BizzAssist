# ADR 0009: S2S XML API Integration (Tinglysning)

**Status:** Proposed
**Dato:** 2026-05-12
**Ticket:** BIZZ-9XX (epic — opret hovedticket + sub-tasks per fase nedenfor)
**Forfatter:** Jakob Juul Rasmussen

## Kontekst

BizzAssist bruger i dag Tinglysningsrettens **HTTP API** (`https://www.tinglysning.dk/tinglysning/ssl/`) til read-only forespørgsler om ejendomme. Den udgår 2026-09-18 og erstattes af ny REST API. Vi har desuden behov for **anmelder-funktionalitet** (oprette tinglysningssager fra BizzAssist), hvilket **kun** er muligt via HTTP XML API (S2S/SOAP).

### Hvad er klar pr. 2026-05-12

- ✅ Prod OCES erhvervscertifikat udstedt: `CN=BizzAssist, NTRDK-44718502`, RID `UI:DK-O:G:c12026c7-9ef1-4c03-ae26-00f4cb3be7e9`, gyldig 2026-03-24 → 2029-03-23
- ✅ Cert + privat nøgle i Vercel prod env: `TINGLYSNING_CERT_B64`, `TINGLYSNING_CERT_PASSWORD`
- ✅ Hetzner-proxy (`bizzassist-proxy`, 204.168.164.252) udfører mTLS til Tinglysning prod via `xml-api.tinglysning.dk` (whitelist verificeret)
- ✅ Organisations-niveau S2S-godkendelse for CVR 44718502: Storkunde, S2S grundlæggende/forespørger/anmelder bruger — alle `Ja`
- ✅ Cert registreret som S2S-aktør i prod via `tinglysning.dk/tmv/administration/s2sSysParam` (verificeret 2026-05-12 — `EjendomSummariskHent`-test kommer forbi cert-lookup, fejler nu kun på XML schema validation)
- ✅ XSD/WSDL-dokumentation i repo: `docs/tinglysning/xmlapi/`

### Hvad mangler

- Faktisk S2S-klient-implementation i `app/lib/`
- XMLDSig-signering af request bodies
- TypeScript-typer for hver af 33+ S2S-operationer
- Implementerede minimums-services for anmelder-flow (AbonnementSvar, BrugerformularSvar, FejlService, UnderskriftmappeSvar)
- E2E test-coverage

### Tinglysning-side er fuldt klar

Vi har **alt** vi skal bruge hos Tinglysningsretten for **både** `bizzassist.dk` (prod) og `test.bizzassist.dk` (preview):

- Prod-cert er registreret som S2S-aktør for CVR 44718502
- `xml-api.tinglysning.dk` whitelisted på Hetzner-proxyen
- Storkunde + S2S-bruger-niveauer (grundlæggende/forespørger/anmelder) alle `Ja`

**Beslutning:** Begge BizzAssist-miljøer peger på **prod Tinglysning XML API**. Vi bruger ikke test-miljøet (test.tinglysning.dk / test-xml-api.tinglysning.dk). Det udelukker behov for separat test-cert-ansøgning og test-miljø-whitelist.

## Beslutning

### Arkitektur

```
BizzAssist (Vercel)
   ↓ HTTPS + X-Proxy-Secret
Hetzner proxy (204.168.164.252)
   ↓ mTLS m/ TINGLYSNING_CERT_B64
xml-api.tinglysning.dk (prod) / test-xml-api.tinglysning.dk (test)
```

### Modul-struktur

| Modul                           | Ansvar                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `app/lib/etl/xmlClient.ts`      | Lavniveau HTTP-klient — POST request, parse SOAP response/fault, route via proxy |
| `app/lib/etl/xmlSigner.ts`      | XMLDSig enveloped-signature på request body med OCES-cert                        |
| `app/lib/etl/requestBuilder.ts` | Typed builders for hver operation (input → XML)                                  |
| `app/lib/etl/responseParser.ts` | Parse SOAP-svar til typed objekter; håndter SOAP faults                          |
| `app/lib/etl/types.ts`          | TypeScript-typer genereret fra XSD'er (`xsd-to-ts` eller hånd)                   |
| `app/lib/etl/errors.ts`         | `EtlFault`-klasse med `Fejlkode` + `Fejlparameter`-mapping                       |
| `app/api/etl/*/route.ts`        | Public API routes per operation (auth-gated via `resolveTenantId()`)             |
| `app/api/etl/svar/*/route.ts`   | Callback-endpoints for asynkrone svar (4 minimums-services)                      |

### Tekniske valg

| Valg                     | Beslutning                                              | Begrundelse                                                       |
| ------------------------ | ------------------------------------------------------- | ----------------------------------------------------------------- |
| XML-bibliotek            | `fast-xml-parser` (build + parse)                       | Allerede i deps (verificer); deterministic output for signering   |
| Signering                | `xml-crypto` (XMLDSig)                                  | De-facto standard for Node; RSA-SHA256 + enveloped-signature      |
| URL-format               | Ny S2S HTTP-stil: `/<ServiceName>/<Operation>`          | SOAP-endpoint `/etl/services/ElektroniskAkt` er udfaset jf. notes |
| Forespørgsel vs anmelder | Separate API-routes per kategori                        | Kunne fejl/audit-isolere; anmelder kræver ekstra tilladelser      |
| Callback-services        | Implementeres på `app/api/etl/svar/*` med signaturcheck | Tinglysningsretten POST'er svar — skal verificeres mod deres cert |
| Audit                    | Alle S2S-kald logges til `tenant.audit_log`             | ISO 27001 + CLAUDE.md non-negotiable                              |
| Rate limiting            | Per-tenant + globalt (Upstash)                          | Beskyt mod Tinglysning rate-limits + misbrug                      |

## Implementation roadmap

### Fase 1 — Forespørger MVP (P1, ~3-5 dage)

Mål: kunne kalde **2 forespørgsels-operationer** end-to-end fra BizzAssist UI.

- [ ] **BIZZ-XX1** — `app/lib/etl/xmlClient.ts` (POST + proxy-rewrite + Message-ID header + SOAP fault detection)
- [ ] **BIZZ-XX2** — `app/lib/etl/xmlSigner.ts` (XMLDSig enveloped-signature, RSA-SHA256, transform `enveloped-signature` på `/*`)
- [ ] **BIZZ-XX3** — `app/lib/etl/types.ts` + `requestBuilder.ts` for `EjendomSummariskHent` + `EjendomStamoplysningerHent`
- [ ] **BIZZ-XX4** — `app/lib/etl/responseParser.ts` + `errors.ts` med fault-kode enum
- [ ] **BIZZ-XX5** — `/api/etl/ejendom/summarisk` + `/api/etl/ejendom/stamoplysninger` routes (auth-gated)
- [ ] **BIZZ-XX6** — Unit tests + 1 E2E test mod test.tinglysning.dk (kræver devtest4-cert registreret først)
- [ ] **BIZZ-XX7** — Audit logging af alle S2S-kald til `tenant.audit_log`

**Definition of done:** Successful HTTP 200 fra prod `xml-api.tinglysning.dk/ElektroniskAkt/EjendomSummariskHent` med signeret request, response parsed til typed objekt, log-entry i audit_log.

### Fase 2 — Forespørger bredde (P2, ~5 dage)

- [ ] **BIZZ-XX8** — Resterende forespørgsels-operationer: `Adkomster`, `Servitutter`, `Haeftelser`, `HistoriskeAdkomster`, `IndskannetAktHent`
- [ ] **BIZZ-XX9** — `EjendomSoeg`, `VirksomhedSoeg`, `AndelSoeg`, `BilSoeg` (søgnings-operationer)
- [ ] **BIZZ-XX10** — XSD-baseret typer-generering (script i `scripts/gen-etl-types.mjs`) i stedet for hånd-typing

**Definition of done:** Alle 14 forespørgsels-operationer er typed + callable, dækket af enhetstest.

### Fase 3 — Anmelder + callbacks (P1, ~7-10 dage)

⚠️ **Høj-risk fase:** anmelder mod prod = ægte tinglysninger med juridisk effekt.

- [ ] **BIZZ-XX11** — Implementer 4 obligatoriske svar-services:
  - `app/api/etl/svar/abonnement/route.ts`
  - `app/api/etl/svar/brugerformular/route.ts`
  - `app/api/etl/svar/fejl/route.ts`
  - `app/api/etl/svar/underskriftmappe/route.ts`
- [ ] **BIZZ-XX12** — Verificering af inkoming svar (Tinglysningsretten's signatur valideret mod deres cert)
- [ ] **BIZZ-XX13** — Feature flag `ENABLE_S2S_ANMELDER` — default OFF i alle miljøer indtil DBA-godkendt
- [ ] **BIZZ-XX14** — `AnmeldelseSvar`-operationer for relevante bøger (kun fast ejendom i første runde)
- [ ] **BIZZ-XX15** — UI-flow med multi-step "preview → confirm → sign → submit" + obligatorisk co-pilot-review
- [ ] **BIZZ-XX16** — Audit-trail udvidet til `tenant.tinglysning_anmeldelse` med fuld request/response + bruger-bekræftelse

**Definition of done:** Test-anmeldelse gennemført på test.tinglysning.dk; ingen prod-deployment før manuel DBA + ARCHITECT-godkendelse i PR.

### Fase 4 — Miljø-setup (P1, parallelt med Fase 1)

Begge BizzAssist-miljøer (prod + preview) skal pege på prod Tinglysning XML API.

- [ ] **BIZZ-XX17** — Sæt `TINGLYSNING_XML_BASE_URL=https://xml-api.tinglysning.dk` i Vercel for **både** Production og Preview env
- [ ] **BIZZ-XX18** — `test.bizzassist.dk` deployment-verificering: kører mod prod XML API med prod-cert (samme cert som bizzassist.dk)
- [ ] **BIZZ-XX19** — Guard mod utilsigtet anmelder-flow fra preview: Feature flag `ENABLE_S2S_ANMELDER` skal være OFF på preview (kun forespørger-operationer tilladt fra test.bizzassist.dk)

## Non-goals (eksplicit ude af scope)

- REST API-integration (separat ADR — afventer NETS REST API stabilitet, deadline 2026-09)
- Migration af eksisterende HTTP API-kald til S2S (HTTP API virker til den udgår)
- Underskriftsprotokol (`Underskriftsprotokol: Nej` — kan tilføjes senere hvis behov)
- Anmelderordning (`Har anmelderordning: Nej` — kræver yderligere godkendelse hos Tinglysningsretten)

## Risici

| Risiko                                                                                                            | Mitigation                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Anmelder-kald mod prod kan oprette utilsigtede juridiske tinglysninger                                            | Feature flag default OFF + multi-step UI confirmation + DBA-review per release                                                                               |
| **test.bizzassist.dk rammer prod-data**: udviklere/QA kan utilsigtet trigge forespørgsler mod ægte prod-ejendomme | Forespørger-operationer er read-only → ingen permanent prod-effekt. Audit-log gør evt. misbrug sporbart. Feature flag `ENABLE_S2S_ANMELDER=false` på preview |
| **Data-spild prod → test-Supabase**: prod-tinglysningsdata caches i test-Supabase                                 | Verificer at test.bizzassist.dk peger på test-Supabase. GDPR-cache-TTL ≤ 30 dage gælder også preview                                                         |
| XMLDSig-signering forkert → alle S2S-kald fejler stille                                                           | Unit test mod XSD-eksempler + integration test fra dev før merge til develop                                                                                 |
| Prod-cert udløb 2029-03-23                                                                                        | Eksisterende `daily-status` cron monitorer expiry — alert ved 30 dage før                                                                                    |
| Tinglysningsretten ændrer XSD-version under udvikling                                                             | Pin XSD-version i types-generator + automated diff på cron + alert ved ændring                                                                               |
| Callback-endpoints kompromitteres (Tinglysning poster signerede svar til os)                                      | Signatur-validering mod deres OCES root + IP-whitelist på Hetzner-proxy                                                                                      |

## Sikkerhed (ISO 27001)

- Cert + privat nøgle: kun i Vercel encrypted env, aldrig committet (`TINGLYSNING_CERT_B64`)
- mTLS sker udelukkende på Hetzner-proxy — Vercel-runtime ser aldrig private key
- Audit log: hver S2S-operation logges med tenant_id, bruger, operation, request-hash, response-status, timestamp
- GDPR: Personhenførbare data fra tinglysningssvar (ejerinfo) gemmes kun midlertidigt (cache TTL ≤ 30 dage); export/delete-flows omfatter også cache-tabeller
- Rate limit: 100 S2S-kald/tenant/dag default, hævbart per kunde via DBA

## Referencer

- `docs/tinglysning/guide-til-systemadgang-v1.7.txt` — officiel systemadgangs-guide
- `docs/tinglysning/http-api-beskrivelse-v1.12.txt` — HTTP API beskrivelse
- `docs/tinglysning/system-systemmanual-v1.53.txt` — HTTP XML API systemmanual
- `docs/tinglysning/xmlapi/ElektroniskAkt.wsdl` — SOAP binding
- `docs/tinglysning/xmlapi/XMLAPI-NOTES.md` — implementations-noter + test-historik
- ADR 0004 (tinglysning-event-feed-evaluation) — relateret men separat
- BIZZ-887 — Hetzner-proxy whitelist patches
- Bekendtgørelse 2021-06-29 nr. 1634 — tekniske krav til tinglysningssystemet
