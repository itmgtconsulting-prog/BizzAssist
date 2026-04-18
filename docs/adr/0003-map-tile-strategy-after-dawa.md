# ADR 0003 — Kort-tile og baggrundslag strategi efter DAWA-nedlukning

Status: Accepted
Date: 2026-04-18
JIRA: BIZZ-536
Related: BIZZ-535 (DAWA migration), BIZZ-537 (fetchDawa), BIZZ-539 (final cleanup)

## Kontekst

DAWA-API'et (`api.dataforsyningen.dk/adresser|adgangsadresser|autocomplete|jordstykker|...`) lukkes 2026-07-01. Vores adresse-/jordstykke-opslag er migreret til Datafordeler-DAR/MAT (se BIZZ-535).

Uafklaret før denne ADR var, om de **tile/WMS-services** der også hostes på `api.dataforsyningen.dk` (ortofoto, skærmkort, matrikelkort m.fl.) er en del af DAWA-nedlukningen.

### Kort over faktiske tile-kilder i brug

Audit udført 2026-04-18 på `develop`:

| Kilde                                                                       | Host                                                    | Anvendelse                                                            | Via proxy?              |
| --------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------- |
| **Ortofoto (luftfoto)** — `orto_foraar_webmercator`                         | `api.dataforsyningen.dk`                                | `app/dashboard/kort/KortPageClient.tsx:365` (baggrund i BBR-tilstand) | Nej, direkte fra klient |
| **Plandata WMS** (lokalplaner, kommuneplan, zonekort m.fl., 8 lag)          | `geoserver.plandata.dk/geoserver/wms`                   | KortPageClient + `PropertyMap.tsx`                                    | Ja, via `/api/wms`      |
| **Miljødata WMS** (natur, beskyttelseslinjer, jordforurening m.fl., 14 lag) | `arealeditering-dist-geo.miljoeportal.dk/geoserver/ows` | KortPageClient + PropertyMap                                          | Ja, via `/api/wms`      |
| **Mapbox basekort** — `navigation-night-v1` / `satellite-streets-v12`       | `api.mapbox.com`                                        | Baggrundsstil i KortPageClient + PropertyMap                          | N/A (kommerciel)        |

Ingen af vores kort bruger skærmkort (`topo_skaerm`), historisk ortofoto, eller standalone matrikel-WMTS — disse er rent hypotetiske i BIZZ-536's beskrivelse.

## Risikovurdering per kilde

### 1. Ortofoto (`api.dataforsyningen.dk/orto_foraar_webmercator`) — **MEDIUM risk**

- Hostet på samme domæne som DAWA, men er en **separat** tjeneste fra Styrelsen for Dataforsyning og Infrastruktur (SDFI).
- DAWA-sunset 2026-07-01 vedrører adresse-endpoints (ref. Dataforsyningens egne migrationsnotater). Frie geografiske data (ortofoto, skærmkort, matrikelkort m.fl.) distribueres under en anden aftale (Frie Geografiske Data) og er ikke annonceret nedlukket.
- **Action item (manuel):** Mail til `support@dataforsyningen.dk` for skriftlig bekræftelse på at `api.dataforsyningen.dk/orto_foraar_webmercator` fortsætter efter 2026-07-01. Ticket opdateres når svar foreligger.

### 2. Plandata WMS (`geoserver.plandata.dk`) — **LOW risk**

- Drives af Erhvervsstyrelsen via Plandata.dk. Ingen overlap med SDFI/DAWA.
- Ingen annonceret ændring. Fortsætter uændret.

### 3. Miljødata WMS (`arealeditering-dist-geo.miljoeportal.dk`) — **LOW risk**

- Drives af Miljøportalen (Miljøministeriet). Ingen overlap med SDFI/DAWA.
- Ingen annonceret ændring. Fortsætter uændret.

### 4. Mapbox (kommerciel) — **LOW risk**

- Abonnementsbaseret tredjepart. Separat kontraktuel forpligtelse.

## Beslutning

### Kort (efter 2026-07-01)

1. **Plandata + Miljødata WMS beholdes uændret** via `/api/wms` proxy. Intet migrationsarbejde nødvendigt.
2. **Ortofoto beholdes indtil videre** på `api.dataforsyningen.dk/orto_foraar_webmercator` — afventer skriftlig bekræftelse fra SDFI.
3. **Fallback-plan for ortofoto** (forberedt, ikke aktiveret): konstant `ORTOFOTO_WMS_URL` i `app/dashboard/kort/KortPageClient.tsx` udskiftes med en af nedenstående hvis SDFI-service lukker eller bliver utilgængelig.

### Godkendte fallbacks for ortofoto (prioriteret)

| #   | Fallback                                                                            | Credentials                                                                       | Vurdering                                                                                                            |
| --- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| A   | `services.datafordeler.dk/GeoDanmarkOrto/GeoDanmark_Ortofoto_ForaarsFoto/1.0.0/WMS` | Datafordeler-bruger (`DATAFORDELER_USER/_PASS` – allerede i brug for BBR/MAT/DAR) | Foretrukket. Samme data-ejer (SDFI), officiel autoriseret genvej, ingen ekstra kontrakt.                             |
| B   | Mapbox Satellite (`mapbox://styles/mapbox/satellite-v9`) som primær                 | Eksisterende `NEXT_PUBLIC_MAPBOX_TOKEN`                                           | Hurtigt at aktivere — bruges allerede i "satellite" mode. Ulempe: global leverandør, ikke dansk opdateringsfrekvens. |
| C   | Egne tile-caches (Mapbox Tilesets upload)                                           | Mapbox                                                                            | Afvist — for dyrt og operationel overhead.                                                                           |

### Ingen ændringer kodes nu

- Ortofoto-lagets URL rørers ikke før SDFI-svar foreligger, for at undgå unødig regression.
- Når SDFI-svar kommer, opdateres denne ADR med endelig beslutning (behold, migrer til Fallback A, eller migrer til Fallback B).

## Konsekvenser

- **Positivt:** Ingen kode-ændringer nødvendige før deadline. Vores 22 WMS-lag (plandata + miljø) er allerede uafhængige af DAWA.
- **Positivt:** Fallback A dokumenteret — kan aktiveres på <1 dags arbejde (swap af URL-konstant + credentials-indsættelse).
- **Risiko:** Hvis SDFI lukker ortofoto-endpointet uden forvarsel, har vi et vindue på maksimalt 1 arbejdsdag med ikke-fungerende luftfoto-baggrund i fullscreen-kortet. Acceptabelt.
- **Opfølgning:** Linje i `docs/BACKLOG.md` med manual action (mail SDFI). Denne ADR opdateres når svar foreligger.

## Implementation notes

Ingen kode-ændringer i denne commit. Følgende filer er de eneste der skal ændres hvis Fallback A/B aktiveres:

- `app/dashboard/kort/KortPageClient.tsx` — konstanten `ORTOFOTO_WMS_URL` (linje 364)
- `proxy.ts` CSP (`connect-src`) — tilføj `services.datafordeler.dk` hvis Fallback A aktiveres (allerede whitelisted)
- Ingen database-migrationer påkrævet.

## References

- DAWA sunset notice: https://dawadocs.dataforsyningen.dk (stadig gældende 2026-04-18)
- SDFI Frie Geografiske Data: https://dataforsyningen.dk/data
- Datafordeler WMS-katalog: https://datafordeler.dk/dataoversigt/geodanmark/geodanmark-ortofoto/
- BIZZ-535 (afsluttet) — DAWA API-kald migreret
- BIZZ-539 (pending) — endelig oprydning når alle fallbacks kan fjernes
