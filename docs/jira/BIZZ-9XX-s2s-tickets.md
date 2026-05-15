# JIRA Tickets — Tinglysning S2S XML API Integration (Epic BIZZ-9XX)

**Reference:** [ADR 0009](../adr/0009-s2s-xml-api-integration.md) · **BACKLOG entry:** 2.4b
**Created:** 2026-05-15 · **Project:** BIZZ · **Component:** Tinglysning

---

## Epic: BIZZ-9XX — Tinglysning S2S XML API Integration

**Type:** Epic
**Priority:** High (P1)
**Labels:** `s2s`, `tinglysning`, `etl`, `xml-api`
**Components:** Tinglysning, Backend
**Estimate:** ~20 dage total (4 faser)

### Beskrivelse

Implementér Tinglysningsrettens HTTP XML API (S2S/SOAP) integration. HTTP API udgår 2026-09-18, og anmelder-funktionalitet (oprette tinglysningssager fra BizzAssist) er kun mulig via S2S XML API.

**Status pr. epic-oprettelse (2026-05-15):**

- ✅ Prod OCES erhvervscertifikat udstedt og registreret som S2S-aktør
  - CN: `BizzAssist`, NTRDK-44718502
  - RID: `UI:DK-O:G:c12026c7-9ef1-4c03-ae26-00f4cb3be7e9`
  - Gyldig: 2026-03-24 → 2029-03-23
- ✅ Hetzner-proxy (204.168.164.252) udfører mTLS — `xml-api.tinglysning.dk` whitelisted
- ✅ S2S grundlæggende/forespørger/anmelder + Storkunde alle `Ja` for CVR 44718502
- ✅ Cert-registrering verificeret end-to-end mod prod via `EjendomSummariskHent` call
- ✅ ADR 0009 mergeret + stubs i `app/lib/etl/`

**Arkitektur-beslutning:** Begge BizzAssist-miljøer (`bizzassist.dk` Production + `test.bizzassist.dk` Preview) peger på **prod Tinglysning XML API**. Test-miljøet hos Tinglysningsretten er ikke i brug.

### Definition of Done

- Alle 4 faser merged til main
- Forespørger-operationer kører i produktion fra både bizzassist.dk og test.bizzassist.dk
- Anmelder-flow feature-flagged + DBA + ARCHITECT godkendt
- Coverage ≥ 70% lines / 35% branches på `app/lib/etl/`
- ADR 0009 status opdateret til "Accepted/Implemented"

---

## Fase 1 — Forespørger MVP (P1, ~3-5 dage)

**Mål:** Kalde 2 forespørgsels-operationer end-to-end fra BizzAssist UI.

---

### BIZZ-XX1: `xmlClient.ts` — body-implementering

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 6h · **Labels:** `s2s`, `etl`

**Filer:** `app/lib/etl/xmlClient.ts`

**Beskrivelse:**

Implementér body af `callEtl()` i den eksisterende stub.

**Flow der skal implementeres:**

1. Konstruér fuld URL: `${proxyUrl}/proxy/<host-fra-xmlApiBase>/<service>/<operation>`
2. Sign request body via `xmlSigner.signXmlBody()` (afhænger af BIZZ-XX2)
3. `fetch()` med headers:
   - `X-Proxy-Secret: ${DF_PROXY_SECRET}`
   - `Content-Type: application/xml`
   - `Tinglysning-Message-ID: uuid:<random>`
4. Læs response → check Content-Type for SOAP fault
5. Parse fault via `responseParser.parseFault()` → kast `EtlFault` (BIZZ-XX4)
6. Parse success via `responseParser.parseResponse()` → returnér `EtlResult`
7. Skriv til `tenant.audit_log` (operation, durationMs, status, requestHash) — BIZZ-XX7

**Acceptance criteria:**

- [ ] `callEtl()` returnerer typed `EtlResult<T>` ved 200 OK
- [ ] Kaster `EtlFault` med korrekt `fejlkode` ved SOAP fault
- [ ] Kaster `EtlTransportError` ved netværks-/proxy-fejl
- [ ] Timeout-håndtering via `AbortSignal.timeout()` (per CLAUDE.md)
- [ ] Unit tests dækker: success, fault, timeout, manglende env-vars
- [ ] JSDoc komplet per CLAUDE.md commenting standards

**Dependencies:** BIZZ-XX2 (signer), BIZZ-XX4 (parser/errors)

---

### BIZZ-XX2: `xmlSigner.ts` — XMLDSig enveloped-signature

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 8h · **Labels:** `s2s`, `etl`, `crypto`

**Filer:** `app/lib/etl/xmlSigner.ts`

**Beskrivelse:**

Implementér `signXmlBody()` med `xml-crypto` (allerede i deps).

**Signaturkonfiguration:**

- Signature algorithm: `http://www.w3.org/2001/04/xmldsig-more#rsa-sha256`
- Canonicalization: `http://www.w3.org/2001/10/xml-exc-c14n#`
- Transform: `http://www.w3.org/2000/09/xmldsig#enveloped-signature`
- Reference URI: `""` (hele dokumentet)
- KeyInfo: indlejret `<X509Certificate>` med public cert
- Digest: SHA-256

**Cert-loading:** Læs `TINGLYSNING_CERT_B64` + `TINGLYSNING_CERT_PASSWORD`, parse PKCS#12 (Node 20+ `crypto.X509Certificate`), cache resultatet på modul-niveau.

**Acceptance criteria:**

- [ ] `loadOcesCertAndKey()` parser PFX korrekt + cacher
- [ ] `signXmlBody()` returnerer signeret XML med `<ds:Signature>` indsat i root-element
- [ ] Signatur validerer mod cert public key (lokal verification i test)
- [ ] Unit test mod ekstern XMLDSig-validator (fx `xmlsec1` via Docker)
- [ ] Performance: < 50ms pr. signering på cold path (post-cache)
- [ ] Ingen `any` types (CLAUDE.md)

**Dependencies:** Ingen — kan udvikles parallelt med BIZZ-XX1

---

### BIZZ-XX3: Request builders + types for `EjendomSummariskHent` + `EjendomStamoplysningerHent`

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 4h · **Labels:** `s2s`, `etl`, `types`

**Filer:**

- `app/lib/etl/types.ts` (ny)
- `app/lib/etl/requestBuilder.ts` (ny)
- Reference: `docs/tinglysning/xmlapi/EjendomIndskannetAktHent.xsd`, WSDL

**Beskrivelse:**

Skab typed request builders for de to MVP-operationer.

**Builder-signatur:**

```ts
buildEjendomSummariskHentRequest(input: {
  bfeNummer: number;
}): string;  // returnerer unsignet XML body
```

**Acceptance criteria:**

- [ ] TypeScript types for input + output af begge operationer
- [ ] Builder genererer XML der validerer mod XSD (test via `libxml2`/`xsd-validator`)
- [ ] Namespace-prefixer korrekt: `eakt:`, `eamsg:` per XSD
- [ ] Unit tests for happy-path + edge cases (negative BFE, manglende felter)

**Dependencies:** Ingen

---

### BIZZ-XX4: Response parser + SOAP fault håndtering

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 4h · **Labels:** `s2s`, `etl`

**Filer:**

- `app/lib/etl/responseParser.ts` (ny)
- `app/lib/etl/errors.ts` (allerede committet med fejlkode-enum)

**Beskrivelse:**

Parse SOAP responses fra prod XML API.

**To paths:**

1. **Success path:** Parse `<EjendomSummariskHentResultat>` / `<EjendomStamoplysningerResultat>` → typed objekter
2. **Fault path:** Parse `<soapenv:Fault>` → `EtlFault` med `fejlkode`, `fejlparametre`, `fejlUuid`

**Acceptance criteria:**

- [ ] `parseResponse<T>(xml, operation)` returnerer typed objekt
- [ ] `parseFault(xml)` returnerer `EtlFault`-instans med alle metadata
- [ ] Edge cases: malformeret XML, manglende felter, ukendt fejlkode
- [ ] Fejlkode-enum (`EtlFejlkode`) udvides med faktiske observerede koder
- [ ] Unit tests mod recorded fixtures (gem nogle prod-responses i `__tests__/fixtures/etl/`)

**Dependencies:** BIZZ-XX3 (types)

---

### BIZZ-XX5: API routes `/api/etl/ejendom/summarisk` + `/api/etl/ejendom/stamoplysninger`

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 3h · **Labels:** `s2s`, `etl`, `api`

**Filer:**

- `app/api/etl/ejendom/summarisk/route.ts` (ny)
- `app/api/etl/ejendom/stamoplysninger/route.ts` (ny)

**Beskrivelse:**

Public-facing API-routes der wrapper S2S-kald. Følger eksisterende `/api/tinglysning/*` mønstre.

**Krav per CLAUDE.md (API Route Security):**

- [ ] `resolveTenantId()` ved top + 401 hvis unauthenticated
- [ ] Aldrig expose raw eksterne API errors — returnér `'Ekstern API fejl'`
- [ ] Rate limiting (per-tenant via Upstash)
- [ ] Input validation (Zod-schema)
- [ ] Try/catch + Sentry capture
- [ ] JSDoc med endpoint, input, output

**Acceptance criteria:**

- [ ] `GET /api/etl/ejendom/summarisk?bfe=X` returnerer typed JSON
- [ ] Samme for stamoplysninger
- [ ] 401 ved ingen auth, 400 ved invalid input, 500 ved S2S fault (med generisk besked)
- [ ] Tests via Playwright E2E (med mocket S2S-respons)

**Dependencies:** BIZZ-XX1, XX2, XX3, XX4

---

### BIZZ-XX6: Tests — unit + integration

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 6h · **Labels:** `s2s`, `etl`, `tests`

**Beskrivelse:**

Test-coverage for Fase 1 modulerne.

**Test-strategi:**

1. Unit tests (`__tests__/unit/etl/`):
   - `xmlClient.test.ts` — mock fetch, verify URL/headers/body
   - `xmlSigner.test.ts` — signaturer mod kendt input/output
   - `requestBuilder.test.ts` — XSD-validation
   - `responseParser.test.ts` — fault + success fixtures
2. Integration test (kun lokalt — ikke i CI):
   - `scripts/test-etl-prod.mjs` der laver rigtigt kald mod prod (read-only forespørgsel) med dev-cert via proxy

**Acceptance criteria:**

- [ ] Coverage på `app/lib/etl/`: ≥ 80% lines, ≥ 60% branches
- [ ] Alle tests grønne i `npm test`
- [ ] Integration-script kører successfully mod prod fra udvikler-maskine

**Dependencies:** BIZZ-XX1, XX2, XX3, XX4

---

### BIZZ-XX7: Audit logging af alle S2S-kald

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 3h · **Labels:** `s2s`, `etl`, `audit`, `iso-27001`

**Filer:**

- `app/lib/etl/xmlClient.ts` (extend)
- Migration: `migrations/XXX_audit_log_etl.sql` hvis ny kolonne behøves

**Beskrivelse:**

Per CLAUDE.md non-negotiable: alle writes logger til `tenant.audit_log`. For S2S inkluderer det også reads (forespørgsler) jf. ISO 27001 audit-krav.

**Audit-log entry per S2S-kald:**

```
{
  tenant_id,
  user_id (nullable for cron),
  operation: 'etl.EjendomSummariskHent',
  request_hash: sha256(signed_xml),
  http_status: 200,
  duration_ms: 412,
  fejlkode: null | 'ikkeFindeS2SAktoerSSLCert' | ...,
  fejl_uuid: null | '<uuid>',
  message_id: 'uuid:<uuid>',
  timestamp
}
```

**Acceptance criteria:**

- [ ] Alle kald via `callEtl()` logger automatisk (ingen call-site skal huske det)
- [ ] Log-entries indeholder ingen PII (CLAUDE.md non-negotiable)
- [ ] Retention: 12 mdr (GDPR-grænse), purge via eksisterende cron
- [ ] Tests: verify log-entry oprettes ved både success og fault

**Dependencies:** BIZZ-XX1

---

## Fase 2 — Forespørger bredde (P2, ~5 dage)

### BIZZ-XX8: Implementér resterende Hent-operationer

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** Medium · **Estimate:** 12h · **Labels:** `s2s`, `etl`

**Operationer:**

- `EjendomAdkomsterHent`
- `EjendomServitutterHent`
- `EjendomHaeftelserHent`
- `EjendomHistoriskAdkomsterHent`
- `EjendomIndskannetAktHent`
- `SenesteAendringTinglysningsobjektHent`
- `AendredeTinglysningsobjekterHent`

Følg samme mønster som Fase 1 — builder + parser + API route per operation.

**Acceptance criteria:**

- [ ] Alle 7 operationer typed + callable
- [ ] API routes under `/api/etl/ejendom/*`
- [ ] Tests for hver operation
- [ ] Migration af eksisterende `/api/tinglysning/*` routes til at bruge S2S som primær (HTTP API som fallback indtil 2026-09-18)

**Dependencies:** Fase 1 komplet

---

### BIZZ-XX9: Søgnings-operationer

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** Medium · **Estimate:** 8h · **Labels:** `s2s`, `etl`, `search`

**Operationer:**

- `EjendomSoeg` (matr-nr, adresse, ejer)
- `VirksomhedSoeg` (CVR)
- `AndelSoeg` (andelsboliger)
- `BilSoeg` (motorkøretøjer — sandsynligvis ikke MVP, men XSD'en findes)

**Acceptance criteria:**

- [ ] Builders, parsers, API routes per operation
- [ ] Pagination-håndtering (XML API returnerer `Antal` + offsets)
- [ ] Caching mod cache_ejendom / cache_virksomhed (jf. ADR 0008)

**Dependencies:** BIZZ-XX8

---

### BIZZ-XX10: XSD-til-TypeScript types-generator

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** Medium · **Estimate:** 6h · **Labels:** `s2s`, `etl`, `tooling`

**Beskrivelse:**

Skift fra hånd-typing til generator. Indtil nu har vi skrevet types manuelt baseret på XSD-inspection — det skalerer ikke til 33+ operationer.

**Tooling-options:**

1. `xsd-to-ts` npm-pakke
2. Custom script i `scripts/gen-etl-types.mjs` der parser XSD via `fast-xml-parser` og emitter `.d.ts`
3. Java-baseret `xjc` (Apache CXF) — kører via Docker

**Acceptance criteria:**

- [ ] `npm run gen:etl-types` regenererer `app/lib/etl/types.generated.ts`
- [ ] CI-check verificerer at generated types er commit'ed (no drift)
- [ ] Documented i `app/lib/etl/README.md`

**Dependencies:** Ingen — kan starte tidligt

---

## Fase 3 — Anmelder + Callbacks (P1, ~7-10 dage)

⚠ **Høj-risk fase:** Anmelder mod prod = ægte juridiske tinglysninger.

### BIZZ-XX11: 4 obligatoriske svar-services (callbacks)

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 12h · **Labels:** `s2s`, `etl`, `callbacks`

**Filer:**

- `app/api/etl/svar/abonnement/route.ts`
- `app/api/etl/svar/brugerformular/route.ts`
- `app/api/etl/svar/fejl/route.ts`
- `app/api/etl/svar/underskriftmappe/route.ts`

**Beskrivelse:**

Tinglysningsretten POSTer svar (asynkrone hændelser) til disse endpoints. Per guide-til-systemadgang afsnit 4.2 er disse minimumskrav.

**Per endpoint:**

1. POST-handler der modtager signeret SOAP XML
2. Verificer Tinglysning-Message-ID matcher en kendt outgoing request
3. Verificer XMLDSig-signatur (BIZZ-XX12)
4. Parse + persist event til relevant tenant-tabel
5. ACK 200 OK med tom body (Tinglysning kræver det)
6. Hvis service ikke kan modtage, returner 500 → Tinglysning retry'er

**Acceptance criteria:**

- [ ] Alle 4 endpoints tilgængelige under `/api/etl/svar/*`
- [ ] Signatur-validering kører altid (BIZZ-XX12 dep)
- [ ] IP-whitelist på Hetzner-proxy til Tinglysning's egress-IPs
- [ ] Audit-log per modtaget svar

**Dependencies:** BIZZ-XX12

---

### BIZZ-XX12: Verificering af indkommende signatur fra Tinglysningsretten

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 4h · **Labels:** `s2s`, `etl`, `security`

**Filer:** `app/lib/etl/xmlSigner.ts` (`verifyXmlSignature` stub udvides)

**Beskrivelse:**

Implementér `verifyXmlSignature()` så vi kan validere at indkommende svar fra Tinglysningsretten faktisk er signeret af deres OCES system-cert.

**Trust anchor:** Tinglysningsretten's OCES system-cert public key (skal hentes fra dem eller fra OCES PKI). Lagres som env-var `TINGLYSNING_RESPONSE_TRUST_CERT`.

**Acceptance criteria:**

- [ ] `verifyXmlSignature(xml, trustedCert)` returnerer `true` kun ved gyldig + signed by trusted
- [ ] Modstandsdygtig mod XML signature wrapping attacks (test mod kendte XSW-payloads)
- [ ] Tests dækker: valid, invalid signature, wrong signer, malformed XML

**Dependencies:** Ingen — kan udvikles parallelt

---

### BIZZ-XX13: Feature flag `ENABLE_S2S_ANMELDER`

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 2h · **Labels:** `s2s`, `etl`, `feature-flag`

**Beskrivelse:**

Default OFF i alle miljøer. Kan kun tændes via:

1. Vercel env-var `ENABLE_S2S_ANMELDER=true` i Production (kræver DBA + ARCHITECT godkendelse)
2. **Aldrig** sat på Preview (test.bizzassist.dk) per ADR 0009 risk-mitigation

**Acceptance criteria:**

- [ ] Feature flag check i alle anmelder-routes (`/api/etl/anmeld/*`)
- [ ] Returnerer 503 "Anmelder ikke aktiveret" når flag er OFF
- [ ] Logging: alle ON/OFF toggles audited
- [ ] Tests verificerer at OFF blokerer alle anmelder-paths

**Dependencies:** Ingen

---

### BIZZ-XX14: AnmeldelseSvar for fast ejendom

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 10h · **Labels:** `s2s`, `etl`, `anmelder`

**Beskrivelse:**

Implementér anmeldelses-operationer for fast ejendom (skøde, pant, servitut).

**Scope:**

- `DokumentAnmeldelseSvar` (fast ejendom)
- `BrugerformularSvar` (modtag formular-data)

Ikke i scope: Andelsbog, Bilbog, Personbog (separate tickets senere)

**Acceptance criteria:**

- [ ] Builders + parsers + routes
- [ ] Multi-step UI flow (BIZZ-XX15 dep)
- [ ] Audit-log med fuld request + response + bruger-bekræftelse
- [ ] Test-suite kan **ikke** køre mod prod uden eksplicit flag

**Dependencies:** Fase 1-2 komplet, BIZZ-XX13

---

### BIZZ-XX15: UI multi-step "preview → confirm → sign → submit"

**Type:** Story · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 12h · **Labels:** `s2s`, `etl`, `frontend`, `anmelder`

**Filer:** `app/dashboard/anmeldelse/*` (ny rute-træ)

**Beskrivelse:**

Frontend-flow der gør det meget svært at oprette utilsigtede tinglysninger.

**4 trin:**

1. **Preview:** Vis hvad der vil blive sendt, inkl. ejendoms-data, dokumentinformation, gebyrer
2. **Confirm:** Bruger sætter checkbox "Jeg bekræfter at dette er korrekt og at det vil oprette en juridisk gyldig tinglysning"
3. **Sign:** Server-side XMLDSig
4. **Submit:** Send til Tinglysningsretten + vis loading-state + redirect til status-side

**Acceptance criteria:**

- [ ] Alle 4 steps obligatoriske (kan ikke skippes via URL)
- [ ] Step 2 kræver type-out af "JA, OPRET TINGLYSNING" (ikke kun checkbox)
- [ ] Status-page polls `/api/etl/anmeld/status/<id>` indtil Tinglysning'svar ankommer
- [ ] WCAG AA-compliance (CLAUDE.md): role="dialog", focus-trap, ESC-håndtering
- [ ] E2E test fra Cypress/Playwright

**Dependencies:** BIZZ-XX14

---

### BIZZ-XX16: Udvidet audit-trail med `tenant.tinglysning_anmeldelse`

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 4h · **Labels:** `s2s`, `etl`, `audit`, `database`

**Filer:**

- Migration: `migrations/XXX_tinglysning_anmeldelse.sql`
- `app/lib/etl/anmeldelseLog.ts`

**Beskrivelse:**

Anmelder kræver tungere audit end forespørgsel. Dedikeret tabel pr. tenant.

**Schema:**

```sql
CREATE TABLE tenant.tinglysning_anmeldelse (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  bfe_nummer bigint NOT NULL,
  operation text NOT NULL,
  request_xml text NOT NULL,  -- fuld signeret XML
  request_hash text NOT NULL,
  message_id text NOT NULL,
  bruger_bekraeftet_kl timestamptz NOT NULL,
  status text DEFAULT 'sendt',  -- sendt, modtaget, tinglyst, afvist
  svar_xml text,
  svar_modtaget_kl timestamptz,
  created_at timestamptz DEFAULT now()
);
```

**Acceptance criteria:**

- [ ] Migration godkendt af DBA
- [ ] RLS-policy: kun tenant-medlemmer kan læse egne anmeldelser
- [ ] Retention: anmeldelser opbevares i 10 år (juridisk krav, ikke 12 mdr som almindelige logs)
- [ ] Export inkluderet i GDPR-eksport-flow

**Dependencies:** BIZZ-XX14

---

## Fase 4 — Miljø-setup (P1, parallelt med Fase 1)

### BIZZ-XX17: Sæt `TINGLYSNING_XML_BASE_URL` i Vercel

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 30min · **Labels:** `s2s`, `etl`, `config`

**Beskrivelse:**

Vercel Project Settings → Environment Variables:

```
TINGLYSNING_XML_BASE_URL=https://xml-api.tinglysning.dk
```

Sat for **både** Production OG Preview (begge peger på prod per ADR 0009).

**Acceptance criteria:**

- [ ] Variable sat i Production
- [ ] Variable sat i Preview
- [ ] Verificer i deploy-log at det er pickup'et
- [ ] Opdater `.env.local.example` med variablen

**Dependencies:** Ingen — kan gøres med det samme

---

### BIZZ-XX18: `test.bizzassist.dk` verifikation mod prod XML API

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 1h · **Labels:** `s2s`, `etl`, `verification`

**Beskrivelse:**

Efter BIZZ-XX17 + Fase 1 deploy:

1. Trigger preview-deploy af test.bizzassist.dk
2. Hit `/api/etl/ejendom/summarisk?bfe=<reel BFE>` fra autentificeret session
3. Verificer 200 OK med data fra prod Tinglysning
4. Tjek audit-log er populated korrekt

**Acceptance criteria:**

- [ ] Live S2S-kald fra test.bizzassist.dk virker
- [ ] Response indeholder reel prod-data
- [ ] Audit-log entry oprettet med korrekt tenant_id

**Dependencies:** BIZZ-XX17, Fase 1 komplet

---

### BIZZ-XX19: Guard mod anmelder-flow fra preview

**Type:** Task · **Parent:** BIZZ-9XX · **Priority:** High · **Estimate:** 2h · **Labels:** `s2s`, `etl`, `security`

**Beskrivelse:**

Sikre at `ENABLE_S2S_ANMELDER=true` aldrig kan sættes på Preview, og at preview-deploys explicit blokerer anmelder-routes selv hvis nogen fejler i config.

**Implementation:**

- I `/api/etl/anmeld/*` middleware: hvis `VERCEL_ENV !== 'production'`, returner 503 uanset feature flag
- Pre-commit hook der blokerer commits der sætter `ENABLE_S2S_ANMELDER` i `.env.preview.example`
- Daily-status cron alerter hvis flag er ON på preview

**Acceptance criteria:**

- [ ] Forsøg på anmelder-kald fra test.bizzassist.dk returnerer 503
- [ ] Pre-commit hook tester for env-pollution
- [ ] Daily-status cron har sanity-check og alerter til support@pecuniait.com

**Dependencies:** BIZZ-XX13

---

## Total estimat

| Fase                          | Tickets             | Estimat                         |
| ----------------------------- | ------------------- | ------------------------------- |
| Fase 1 — Forespørger MVP      | 7                   | 34h                             |
| Fase 2 — Forespørger bredde   | 3                   | 26h                             |
| Fase 3 — Anmelder + callbacks | 6                   | 44h                             |
| Fase 4 — Miljø-setup          | 3                   | 4h                              |
| **Total**                     | **19 sub + 1 epic** | **~108h ≈ 13-15 udvikler-dage** |

---

## Til JIRA-administrator

Hvis I bruger JIRA CSV-import, se også `BIZZ-9XX-s2s-tickets.csv` i samme mappe.

Felt-mapping ved import:

| Markdown-felt       | JIRA-felt                        |
| ------------------- | -------------------------------- |
| `### BIZZ-XXn`      | Summary (uden ID)                |
| `**Type:**`         | Issue Type                       |
| `**Parent:**`       | Epic Link                        |
| `**Priority:**`     | Priority                         |
| `**Estimate:**`     | Original Estimate / Story Points |
| `**Labels:**`       | Labels                           |
| Beskrivelse         | Description                      |
| Acceptance criteria | Description (sektion)            |
| Dependencies        | Links → "is blocked by"          |
