# EJF Nye Services — Research 2026-05-20

## Probe-metode

Direkte GraphQL fra Hetzner (ingen proxy) mod `graphql.datafordeler.dk/flexibleCurrent/v1/`.
OAuth token via `auth.datafordeler.dk` (SharedSecret).

## Komplet Data-Model (bekræftet)

```
EJF_Ejerskifte (har BFE!)
  ├─ bestemtFastEjendomBFENr: 100165718
  ├─ overtagelsesdato: 2019-06-24
  ├─ overdragelsesmaade: "Almindelig fri handel" ← HANDELSTYPE!
  ├─ betinget: false
  ├─ fristDato / anmeldelsesdato
  ├─ handelsoplysningerLokalId → EJF_Handelsoplysninger (pris!)
  │    ├─ samletKoebesum: 4.995.000 DKK
  │    ├─ kontantKoebesum: 4.995.000 DKK
  │    ├─ koebsaftaleDato: 2017-09-04
  │    ├─ afstaaelsesdato
  │    ├─ valutakode: DKK
  │    ├─ loesoeresum / entreprisesum / husdyrbesaetningsum
  │    └─ handelsoplysningerBeskriverEjerskifte → back-ref
  └─ id_lokalId_23_Ejerskabsskifte → EJF_Ejerskabsskifte (events)
```

## Service 1: EJF_Handelsoplysninger

**Alle felter:** id_lokalId, id_namespace, behandlingsID, kontantKoebesum, samletKoebesum, loesoeresum, entreprisesum, husdyrbesaetningsum, koebsaftaleDato, afstaaelsesdato, skoedetekst, valutakode, bygningerOmfattet, forretningshaendelse, forretningsomraade, forretningsproces, virkningFra/Til, virkningsaktoer, registreringFra/Til/aktoer, status

**BFE-kobling (BEKRÆFTET):**

- Vej 1: `Ejerskifte.handelsoplysningerLokalId` → `Handelsoplysninger.id_lokalId` ✅
- Vej 2: `Handelsoplysninger.handelsoplysningerBeskriverEjerskifte` → Ejerskifte med BFE ✅

**Sample (BFE 100165718):**

```json
{
  "samletKoebesum": 4995000,
  "kontantKoebesum": 4995000,
  "forretningshaendelse": "Endeligt skøde",
  "koebsaftaleDato": "2017-09-04",
  "valutakode": "DKK"
}
```

**Brugbarhed:** HØJ. Løser BIZZ-1682 (avg_koebesum) + BIZZ-1694 (DLR-rapport).

## Service 2: EJF_Ejerskifte ⭐

**Alle felter (fra Confluence-docs):** id_lokalId, id_namespace, behandlingsID, bestemtFastEjendomBFENr, overtagelsesdato, overdragelsesmaade, betinget, fristDato, anmeldelsesdato, anmeldelsesidentifikator, handelsoplysningerLokalId, forretningshaendelse, forretningsomraade, forretningsproces, virkningFra/Til, virkningsaktoer, registreringFra/Til/aktoer, status

**Relationer:**

- `handelsoplysningerLokalId` → Handelsoplysninger (pris) ✅
- `id_lokalId_23_Ejerskabsskifte_ejerskifteLokalId_ref` → Ejerskabsskifte (events) ✅

**Nøglefelt: `overdragelsesmaade`** — handelstype-filter:

- "Almindelig fri handel" — reelle markedshandler
- "Interessesammenfald" — koncern-interne
- "Familieoverdragelse", "Arv", "Gave", "Tvangsauktion" osv.

**Sample (BFE 100165718):**

```json
{
  "bestemtFastEjendomBFENr": 100165718,
  "overtagelsesdato": "2019-06-24",
  "overdragelsesmaade": "Almindelig fri handel",
  "betinget": false,
  "handelsoplysningerLokalId": "57d65f32-4da6-436a-b982-8fdf4e51811d"
}
```

**Brugbarhed:** KRITISK. Har BFE + handelstype + pris-kobling. Top-1 prioritet for backfill.

## Service 3: EJF_PersonVirksomhedsoplys

**Felter:** id_lokalId, navn, forretningshaendelse, virkningFra/Til, status

**Brugbarhed:** MIDDEL. Har navne men mangler CVR/BFE. Kan bruges til at berige person/virksomheds-navne.

## Service 4: EJF_Ejerskabsskifte

**Felter:** id_lokalId, forretningshaendelse, virkningFra/Til, status

**Kobling:** Via `Ejerskifte.id_lokalId_23_Ejerskabsskifte_ejerskifteLokalId_ref` ✅

**Brugbarhed:** MIDDEL. Event-stream af ændringer — useful for delta-sync og temporal validering.

## Service 5: EJF_Ejerskifte_bilagsbankRef

**Felter:** bilagsbankRef (UUID — peger på Tinglysning bilagsbank PDF)

**Kobling:** Ukendt fra GraphQL. Kommentar i Confluence: "mangler bilagsbank ref join her".

**Brugbarhed:** LAV pt. — UUID'er eksisterer men koblingen til Ejerskifte er ikke eksponeret endnu.

## Prioriteret anbefaling (OPDATERET)

| Prio | Service                      | Handling                                               |
| ---- | ---------------------------- | ------------------------------------------------------ |
| 1    | **EJF_Ejerskifte**           | Backfill STRAKS — har BFE + handelstype + pris-kobling |
| 2    | **EJF_Handelsoplysninger**   | Backfill STRAKS — kobles via handelsoplysningerLokalId |
| 3    | EJF_Ejerskabsskifte          | Backfill for delta-sync                                |
| 4    | EJF_PersonVirksomhedsoplys   | Lav prioritet                                          |
| 5    | EJF_Ejerskifte_bilagsbankRef | Parkér — mangler kobling                               |
