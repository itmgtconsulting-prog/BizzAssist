# Data Processing Agreement (DPA) Checklist — BIZZ-72 / BIZZ-130

**Opdateret**: 2026-04-08 — baseret på faktisk research af hver leverandørs vilkår
**Owner**: Jakob Juul Rasmussen (Pecunia IT Consulting ApS)

---

## Svar på det centrale spørgsmål

**Er offentligt tilgængelige persondata stadig omfattet af GDPR Art. 28?**

Ja — men nuancen er vigtig. GDPR Art. 28 kræver en DPA når en databehandler
behandler persondata _på dine vegne_. Det gælder uanset om data er offentlig
(CVR-ejernavne, tinglysning, BBR). Datatilsynet og EDPB Guidelines 07/2020
er klare på dette punkt.

**Men:** De fleste infrastrukturleverandører har allerede inkorporeret DPA i
deres standard ToS — du har typisk _allerede_ en gyldig DPA blot ved at
acceptere deres vilkår. Det er ikke altid nødvendigt at underskrive en
separat aftale.

---

## Status pr. leverandør

### 🔴 Skal handles på (kræver aktiv handling fra Jakob)

| Leverandør   | Persondata der behandles                                                                         | Handling                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **Supabase** | Al brugerdata, activity logs, CVR/ejendomsdata med personnavne                                   | Sign DPA via dashboard → [supabase.com/legal/dpa](https://supabase.com/legal/dpa) (PandaDoc, ~10 min)         |
| **Sentry**   | Stack traces, request URLs, user UUIDs i fejllog                                                 | Accept DPA i dashboard under Legal & Compliance → [sentry.io/legal/dpa](https://sentry.io/legal/dpa) (~5 min) |
| **Mapbox**   | IP-adresser ved kortflise-requests (kortkoordinater er offentlige BBR/DAR-data, ikke bruger-GPS) | ✅ **UNDERSKREVET** — gemt i `docs/legal/signed/Mapbox_DPA_signed.pdf`                                        |

### 🟡 Verificer at det er på plads (ToS er sandsynligvis nok, men dobbelttjek)

| Leverandør       | Status                                                   | Handling                                                                                                                                                       |
| ---------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Anthropic**    | DPA inkorporeret i Commercial ToS (jan 2026)             | Anerkend/underskriv via [privacy.claude.com](https://privacy.claude.com/en/articles/7996862-how-do-i-view-and-sign-your-data-processing-addendum-dpa) (~5 min) |
| **Resend**       | DPA inkorporeret ved ToS-accept                          | Verificer det fremgår af din Resend konto under Legal                                                                                                          |
| **Upstash**      | DPA tilgængeligt, muligvis separat underskrift nødvendig | Anmod om DPA via [upstash.com/docs/common/help/compliance](https://upstash.com/docs/common/help/compliance)                                                    |
| **Brave Search** | DPA tilgængeligt (sept 2025), separat underskrift        | Underskriv via Brave API dashboard. Overvej Zero Data Retention-plan                                                                                           |
| **Vercel**       | DPA tilgængeligt (feb 2026), accepteres ved brug         | Verificer at DPA er registreret på din konto i Vercel dashboard                                                                                                |

### ✅ Ingen handling nødvendig (DPA automatisk via ToS)

| Leverandør     | Persondata                     | Begrundelse                                                                                            |
| -------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| **Stripe**     | Betalers navn, email, kort     | DPA automatisk inkorporeret i Standard Services Agreement siden 2020. Ingen separat signing nødvendig. |
| **Twilio**     | Telefonnumre, SMS-indhold      | DPA automatisk inkorporeret i ToS siden jan 2020. Ingen signing nødvendig.                             |
| **Mediastack** | Søgestrenge (ingen bruger-PII) | Østrigsk virksomhed (Wien) — direkte underlagt GDPR som EU-virksomhed. Meget lav risikoeksponering.    |

---

## Risikovurdering: hvad er faktisk på spil?

### Højeste risiko (store datamængder)

- **Supabase**: Opbevarer AL din brugerdata. Manglende DPA her er den eneste reelle juridiske eksponering.
- **Resend + Twilio**: Sender til brugerens email/telefon. Begge har auto-DPA via ToS — tjek blot at de er aktive.

### Medium risiko (IP-adresser og fejllog)

- **Vercel**: Ser alle HTTP-requests inkl. IP-adresser
- **Sentry**: Fejllog med UUIDs og request-URLs
- **Mapbox**: IP-adresser i kortflise-requests. Kortkoordinaterne er offentlige ejendomskoordinater (BBR/DAR) — ikke brugerens GPS-position. Samme eksponering som Vercel.

### Lav risiko (offentlige søgeforespørgsler)

- **Anthropic**: AI-forespørgsler kan indeholde ejendomsadresser og firmanavne — men disse er offentlige data. 7-dages log-retention, ingen brug til modeltrænig.
- **Brave Search**: Søgestrenge, 90-dages retention. Overvej Zero Data Retention.
- **Upstash**: Kun rate-limit tællere med UUID/IP og kortvarig TTL.
- **Mediastack**: Ingen bruger-PII sendes. EU-virksomhed.

---

## Svar på "Er det nødvendigt for offentlige data?"

Juridisk: **Ja**, fordi Art. 28 ser på om der behandles persondata _på dine vegne_ — ikke om data er offentlig tilgængeligt. Et CVR-registreret ejernavn (fysisk person) er stadig persondata.

Praktisk: **Risikoen er meget lav** for infrastrukturleverandører der kun ser offentlige personnavne som en del af forespørgsler. Datatilsynet prioriterer håndhævelse af manglende DPA hos leverandører der behandler _ikke-offentlig_ brugerdata (login, betalinger, kontaktoplysninger).

**Prioritér i denne rækkefølge:**

1. Supabase (gemmer det hele)
2. Sentry (aktiv fejllog-service)
3. Mapbox (koordinater er sensitive)
4. De øvrige (lav risiko, de fleste er dækket af auto-DPA)

---

_Baseret på research af aktuelle DPA-vilkår for alle leverandører — april 2026._
_Juridisk rådgivning bør indhentes for endelig compliance-vurdering._
