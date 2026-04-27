# BizzAssist — GDPR behandlingsgrundlag for cached persondata

**GDPR Art. 6(1)(f) — Berettiget interesse**
Sidst opdateret: 2026-04-27

---

## 1. Formaal

BizzAssist cacher persondata fra offentlige registre (EJF ejerskab og CVR
deltager) lokalt i Supabase for at levere hurtig ejendoms- og
virksomhedsintelligens til vores kunder. Caching reducerer latens fra
2-5 sekunder (live API) til <100ms og sikrer tilgaengelighed naar
Datafordelers API'er er nede.

## 2. Behandlingsgrundlag

**GDPR Art. 6(1)(f) — Berettiget interesse.**

Behandlingen er noedvendig for at forfølge BizzAssists legitime interesse
i at levere en hurtig og paalidelig tjeneste. Persondata stammer fra
offentligt tilgaengelige registre og er allerede frit tilgaengelig via
tinglysning.dk, ois.dk og cvr.dk.

## 3. Interesseafvejning

| Faktor                            | Vurdering                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **BizzAssists interesse**         | Hurtig service-levering, reduceret API-afhængighed, forbedret oppetid                                      |
| **Den registreredes forventning** | Data er allerede offentligt tilgængelig via statslige portaler — caching ændrer ikke datakvaliteten        |
| **Datakategorier**                | Almindelig persondata: navne, fødselsdatoer, ejerandele. **Ingen følsomme data (Art. 9), ingen CPR-numre** |
| **Begrænsning**                   | Tidsbestemt cache med automatisk sletning. Ingen videresalg                                                |
| **Konsekvens for registreret**    | Minimal — data er identisk med hvad der vises på ois.dk/tinglysning.dk                                     |

## 4. Datatyper og kilder

| Cache-tabel            | Kilde                                    | Persondata                                                       | Ikke inkluderet                       |
| ---------------------- | ---------------------------------------- | ---------------------------------------------------------------- | ------------------------------------- |
| `ejf_ejerskab`         | Datafordeler EJF (Ejendoms-Fortegnelsen) | Ejer-navn, fødselsdato, ejerandel, ejer-type (person/virksomhed) | CPR-nummer, adresse                   |
| `cvr_deltager`         | Erhvervsstyrelsen CVR                    | Deltager-navn, fødselsdato (fra CVR-registrering)                | CPR-nummer                            |
| `cvr_deltagerrelation` | Erhvervsstyrelsen CVR                    | Relation til virksomhed (rolle, gyldighedsperiode)               | Ingen persondata ud over fremmednøgle |
| `cache_bbr`            | Datafordeler BBR                         | Ingen persondata — kun bygningsdata                              | N/A                                   |

## 5. Opbevaringsperioder

| Cache-tabel            | Retention                                                       | Sletningsmekanisme                                               |
| ---------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `ejf_ejerskab`         | Opdateres dagligt; historiske rækker bevares med `virkning_til` | Daglig cron (`/api/cron/ingest-ejf-bulk`) overskriver via UPSERT |
| `cvr_deltager`         | Opdateres ved ændringshændelser                                 | Pull-cron (`/api/cron/pull-cvr-aendringer`) + 12-måneders purge  |
| `cvr_deltagerrelation` | Følger `cvr_deltager` retention                                 | Samme som ovenfor                                                |
| `cache_bbr`            | 7 dage (stale threshold)                                        | Overskrevet ved næste opslag; daglig warm-cron                   |

## 6. Sletningsprocedure

### Automatisk sletning

- `/api/cron/purge-old-data` kører dagligt og sletter aktivitetsdata ældre end 12 måneder
- Cache-tabeller overskriver automatisk stale data via UPSERT

### Brugeriniteret sletning (GDPR Art. 17)

- Brugere kan anmode om sletning via `/dashboard/settings` → GDPR → "Slet mine data"
- API endpoint: `DELETE /api/gdpr/delete-my-data`
- Sletter alle bruger-specifikke data fra tenant-schema
- Cache-tabeller (`ejf_ejerskab`, `cvr_deltager` etc.) indeholder **ikke** bruger-specifikke data — de indeholder offentlige registerdata og berøres derfor ikke af bruger-sletningsanmodninger

### Registreret (dataejer) anmodning

Hvis en person registreret i EJF/CVR anmoder om sletning af deres data fra BizzAssist:

1. Kontakt: privacy@bizzassist.dk
2. Vi verificerer identitet
3. Vi sletter relevante rækker fra `ejf_ejerskab` / `cvr_deltager`
4. Data genindlæses ikke fra kilden for den pågældende person (blocklist)
5. Svar inden 30 dage (GDPR Art. 12(3))

## 7. Tekniske sikkerhedsforanstaltninger

- **Adgangskontrol**: Cache-tabeller bruger Supabase RLS — kun `authenticated` kan læse, kun `service_role` kan skrive
- **Kryptering**: Data-at-rest krypteret via Supabase (AES-256). Data-in-transit via TLS 1.3
- **Logning**: Ingen PII i application logs eller Sentry (ISO 27001 krav)
- **Tenant-isolation**: Cache-tabeller er globale (offentlige data) men adgang kræver autentificering

## 8. Databehandleraftale (DPA)

Supabase fungerer som databehandler for cached persondata. DPA er dækket af
Supabase's standard Data Processing Agreement (GDPR-compliant, EU SCCs).

Se `app/privacy/page.tsx` for den fulde liste af underdatabehandlere.

## 9. Dokumenthistorik

| Dato       | Ændring             |
| ---------- | ------------------- |
| 2026-04-27 | Oprettet (BIZZ-975) |
