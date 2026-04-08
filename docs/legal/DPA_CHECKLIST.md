# Data Processing Agreement (DPA) Checklist — BIZZ-72 / BIZZ-130

**Status**: Pending signatures (Jakob action required)
**Deadline**: Before launch / GDPR compliance required
**Owner**: Jakob Juul Rasmussen (Pecunia IT Consulting ApS)

---

## Hvad er en DPA?

En Data Processing Agreement (DPA) / Databehandleraftale er en juridisk bindende aftale
mellem dig (den dataansvarlige) og leverandøren (databehandleren), som kræves efter GDPR
artikel 28, når en leverandør behandler persondata på dine vegne.

---

## Sub-processors (Databehandlere) — Sign status

| Leverandør                | Formål                  | DPA tilgængeligt        | Status                  | Link                                                              |
| ------------------------- | ----------------------- | ----------------------- | ----------------------- | ----------------------------------------------------------------- |
| **Supabase**              | Database, Auth, Storage | ✅ Online DPA           | ⬜ Ikke underskrevet    | [Sign DPA](https://supabase.com/docs/guides/platform/gdpr)        |
| **Vercel**                | Hosting, CI/CD          | ✅ Online DPA           | ⬜ Ikke underskrevet    | [Sign DPA](https://vercel.com/legal/dpa)                          |
| **Anthropic (Claude)**    | AI chat features        | ✅ Available on request | ⬜ Ikke underskrevet    | [Contact](https://privacy.anthropic.com/)                         |
| **Stripe**                | Betalinger              | ✅ Inkluderet i ToS     | ✅ Automatisk via ToS   | [View](https://stripe.com/en-dk/legal/dpa)                        |
| **Sentry**                | Error monitoring        | ✅ Online DPA           | ⬜ Ikke underskrevet    | [Sign DPA](https://sentry.io/legal/dpa/)                          |
| **Upstash (Redis)**       | Rate limiting           | ✅ Online DPA           | ⬜ Ikke underskrevet    | [Sign DPA](https://upstash.com/trust/dpa.pdf)                     |
| **Resend**                | Transaktionel email     | ✅ Online DPA           | ⬜ Ikke underskrevet    | [Sign DPA](https://resend.com/legal/dpa)                          |
| **Twilio**                | SMS notifikationer      | ✅ Online DPA           | ⬜ Ikke underskrevet    | [Sign DPA](https://www.twilio.com/legal/data-protection-addendum) |
| **Mapbox**                | Kortvisning             | ✅ Online DPA           | ⬜ Ikke underskrevet    | [Sign DPA](https://www.mapbox.com/legal/dpa)                      |
| **Datafordeler** (SDFE)   | BBR, MAT, DAR, VUR data | Dansk myndighed         | N/A — offentlig API     | -                                                                 |
| **CVR Erhvervsstyrelsen** | CVR data                | Dansk myndighed         | N/A — system-til-system | -                                                                 |
| **Brave Search**          | Web søgning (AI tools)  | ⬜ Kontakt nødvendigt   | ⬜ Ikke underskrevet    | [Contact](https://brave.com/privacy/browser/#brave-search)        |
| **Mediastack**            | Nyhedsartikler          | ⬜ Kontakt nødvendigt   | ⬜ Ikke underskrevet    | [Privacy](https://mediastack.com/privacy)                         |

---

## Action Items (Jakob skal gøre dette)

### 1. Supabase DPA (KRITISK — opbevarer al brugerdata)

```
1. Log ind på Supabase dashboard: https://supabase.com/dashboard
2. Gå til Organization Settings → Legal
3. Klik "Sign DPA"
4. Udfyld firmanavn: Pecunia IT Consulting ApS
5. CVR: [dit CVR-nummer]
6. Download underskrevet DPA og gem i /docs/legal/signed/
```

### 2. Vercel DPA

```
1. Gå til: https://vercel.com/legal/dpa
2. Klik "Request DPA" eller sign online
3. Brug email: jakob@pecunia-it.dk
4. Firma: Pecunia IT Consulting ApS
```

### 3. Anthropic DPA

```
1. Send email til: privacy@anthropic.com
2. Emne: "DPA Request — BizzAssist / Pecunia IT Consulting ApS"
3. Inkludér: CVR-nummer, firmanavn, kontaktperson, EU-lokation (Danmark)
4. Angiv brug: "AI-assisted business intelligence platform, processing company/property data"
```

### 4. Sentry DPA

```
1. Gå til: https://sentry.io/legal/dpa/
2. Udfyld formularen
3. Organization: Pecunia IT Consulting ApS
```

### 5. Resterende DPAs

- Upstash: Self-service på https://upstash.com/trust/dpa.pdf — download, underskriv, send retur
- Resend: Online sign på https://resend.com/legal/dpa
- Twilio: Online sign på https://www.twilio.com/legal/data-protection-addendum
- Mapbox: Online sign på https://www.mapbox.com/legal/dpa

---

## Privacy Policy opdatering

Alle underskrevne DPAs skal afspejles i `/app/(public)/privacy/page.tsx` under "Vores underleverandører".
Filen er allerede opdateret med sub-processor-listen — verificér at den matcher de faktiske DPAs.

---

## Template: Databehandleraftale (for evt. egne kunder)

Brug nedenstående template hvis BizzAssist-kunder kræver DPA med Pecunia IT Consulting:

### DATABEHANDLERAFTALE

**Dataansvarlig**: [Kundens firmanavn], [CVR-nr], [adresse]
**Databehandler**: Pecunia IT Consulting ApS, [CVR-nr], [adresse]

#### 1. Formål

Databehandleren behandler personoplysninger på den dataansvarliges vegne i forbindelse med
levering af BizzAssist-platformen, herunder:

- Opbevaring af brugerkontooplysninger
- Behandling af søgeaktivitetsdata
- Visning af offentligt tilgængeligt ejendoms- og virksomhedsdata

#### 2. Behandlingens art og formål

- **Kategorier af personoplysninger**: E-mailadresse, navn, IP-adresse (logformat), søgehistorik
- **Kategorier af registrerede**: Den dataansvarliges medarbejdere (brugere af platformen)
- **Behandlingens formål**: At levere BizzAssist SaaS-platformen som beskrevet i abonnementsaftalen
- **Behandlingens varighed**: Abonnementsperiodens varighed + 30 dages sletningsfrist efter opsigelse

#### 3. Den dataansvarliges instruktioner

Databehandleren behandler udelukkende personoplysninger efter dokumenteret instruks fra den
dataansvarlige og i overensstemmelse med GDPR.

#### 4. Sikkerhedsforanstaltninger (Artikel 32)

Databehandleren har implementeret:

- Kryptering af data i hvile (AES-256) og under transport (TLS 1.3)
- Adgangskontrol med MFA og rollebaserede tilladelser
- Adskillelse af kundedata (tenant isolation via Supabase RLS)
- Regelmæssige sikkerhedsvurderinger (ugentlig DAST, afhængighedsaudit)
- Logning af alle dataadgange i audit_log
- Incidentrespons-procedure (se docs/security/INCIDENT_RESPONSE.md)

#### 5. Underdatabehandlere

Se liste på https://app.bizzassist.dk/privacy — afsnit "Vores underleverandører"

#### 6. Ret til indsigt og sletning

Databehandleren bistår den dataansvarlige med opfyldelse af registreredes rettigheder
(indsigt, berigtigelse, sletning, dataportabilitet) inden 72 timer efter anmodning.

#### 7. Sletning ved ophør

Ved aftalens ophør slettes alle personoplysninger senest 30 dage efter abonnementets udløb,
medmindre lovgivning kræver opbevaring i længere tid.

#### 8. Underskrifter

Dataansvarlig: **********\_\_********** Dato: ****\_\_****
Databehandler: **********\_\_********** Dato: ****\_\_****

---

_Sidst opdateret: 2026-04-07 (BIZZ-72, BIZZ-130)_
