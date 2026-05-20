# EJF Nye Services — Research 2026-05-20

## Probe-metode

Direkte GraphQL fra Hetzner (ingen proxy) mod `graphql.datafordeler.dk/flexibleCurrent/v1/`.
OAuth token via `auth.datafordeler.dk` (SharedSecret).

## Service 1: EJF_Handelsoplysninger

**Felter:** id_lokalId, kontantKoebesum, samletKoebesum, loesoeresum, entreprisesum, koebsaftaleDato, forretningshaendelse, virkningFra/Til, status

**Sample:**

```json
{
  "samletKoebesum": 2970000,
  "forretningshaendelse": "Endeligt skøde",
  "koebsaftaleDato": "2016-05-04"
}
```

**KRITISK:** Ingen BFE-felt! Kan ikke filtrere pr. ejendom. Ingen relation til EJF_Ejerskifte. ID'er matcher ikke.

**Kobling:** Ukendt. Muligvis via parent-entitet i fuld EJF-model (ikke eksponeret i GraphQL Custom). Kræver Datafordeler support-henvendelse.

**Brugbarhed:** Lav uden BFE-kobling. Kan bruges til aggregeret statistik (handelstyper, prisfordelinger) men ikke pr. ejendom.

## Service 2: EJF_Ejerskifte ⭐

**Felter:** id_lokalId, **bestemtFastEjendomBFENr** ✅, overtagelsesdato, forretningshaendelse, virkningFra/Til, status

**Sample:**

```json
{
  "bestemtFastEjendomBFENr": 100165718,
  "overtagelsesdato": "2019-06-24T22:00:00.000000Z",
  "forretningshaendelse": "Endeligt skøde"
}
```

**Brugbarhed:** HØJ. Har BFE → kan bruges til:

- Verificere ejerskifter pr. ejendom (BIZZ-1677 same-owner bug)
- Komplet ejerskifte-historik med datoer
- Delta-sync via virkningFra

## Service 3: EJF_PersonVirksomhedsoplys

**Felter:** id_lokalId, navn, forretningshaendelse, virkningFra/Til, status

**Sample:**

```json
{
  "navn": "De Danske Statsbaner",
  "forretningshaendelse": "Ukendt - konverteret fra ESR"
}
```

**Brugbarhed:** MIDDEL. Har navne men mangler CVR/BFE. Kan bruges til at berige person/virksomheds-navne. Kræver kobling via anden entitet.

## Service 4: EJF_Ejerskabsskifte

**Felter:** id_lokalId, forretningshaendelse, virkningFra/Til, status

**Brugbarhed:** LAV. Event-stream af ændringer uden BFE. Kan bruges til delta-sync scheduling men ikke direkte data-berigelse.

## Service 5: EJF_Ejerskifte_bilagsbankRef

**Felter:** INGEN kendte felter fundet (id_lokalId fejler).

**Brugbarhed:** UKENDT. Kræver mere research — muligvis andre felt-navne eller kræver specifik context.

## Prioriteret anbefaling

| Prio | Service                      | Handling                                                             |
| ---- | ---------------------------- | -------------------------------------------------------------------- |
| 1    | **EJF_Ejerskifte**           | Backfill STRAKS — har BFE + dato + type. Verificerer ejerskifte-data |
| 2    | EJF_Handelsoplysninger       | Afvent BFE-kobling (spørg Datafordeler support)                      |
| 3    | EJF_PersonVirksomhedsoplys   | Lav prioritet — begrænset værdi uden CVR                             |
| 4    | EJF_Ejerskabsskifte          | Parkér — delta-sync use case                                         |
| 5    | EJF_Ejerskifte_bilagsbankRef | Parkér — ukendt schema                                               |
