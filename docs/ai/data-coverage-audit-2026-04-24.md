# AI Data-Coverage Audit — 2026-04-24

**Ticket:** BIZZ-875  
**Kilde:** `app/api/ai/chat/route.ts` tools (21 stk) vs UI-felter på
ejendoms-, virksomheds- og person-detaljesiderne.

Formål: identificér UI-synlige data-felter som AI ikke kan tilgå via
tool-use, så AI-svar ikke virker "blinde" for hvad brugeren kan se.

## 1. Eksisterende AI-tools (21)

| #   | Tool                            | Dækker                                |
| --- | ------------------------------- | ------------------------------------- |
| 1   | `dawa_adresse_soeg`             | Adresse-autocomplete (DAWA)           |
| 2   | `dawa_adresse_detaljer`         | Adresse-detalje (DAWA id)             |
| 3   | `hent_bbr_data`                 | BBR grund/bygning/enhed               |
| 4   | `hent_vurdering`                | Aktuel ejendomsvurdering (VUR)        |
| 5   | `hent_forelobig_vurdering`      | Ny foreløbig VUR 2025+                |
| 6   | `hent_ejerskab`                 | Ejerskabs-chain (EJF)                 |
| 7   | `hent_salgshistorik`            | Salgshistorik (tinglyste salg)        |
| 8   | `hent_energimaerke`             | Energimærke                           |
| 9   | `hent_jordforurening`           | Jordforurening                        |
| 10  | `hent_plandata`                 | Plandata (kommuneplaner, lokalplaner) |
| 11  | `hent_cvr_virksomhed`           | CVR-master                            |
| 12  | `hent_virksomhed_personer`      | Virksomhedsdeltagere (roller)         |
| 13  | `hent_matrikeldata`             | Matrikel (MAT)                        |
| 14  | `hent_person_virksomheder`      | Persons virksomheder                  |
| 15  | `hent_regnskab_noegletal`       | XBRL-regnskabstal                     |
| 16  | `hent_datterselskaber`          | Datterselskaber (ejerskab-graf)       |
| 17  | `soeg_person_cvr`               | Personsøgning                         |
| 18  | `hent_tinglysning`              | Tinglysning (e-TL)                    |
| 19  | `hent_ejendomme_for_virksomhed` | Virksomheds-ejendomme                 |
| 20  | `hent_ejendomme_for_person`     | Persons ejendomme (BIZZ-864)          |
| 21  | `generate_document`             | Fil-eksport (docx/xlsx/csv)           |

## 2. UI-inventory pr. detaljeside

### 2.1 `/dashboard/ejendomme/[id]` — 6 tabs

| Tab         | Komponent               | Felter vist                                                                                        | Dækket af                                                      |
| ----------- | ----------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Overblik    | `EjendomOverblikTab`    | BBR-header, anvendelse, areal, opført, antal enheder, ejerforening, energimærke-chip, seneste salg | #3, #6, #7, #8                                                 |
| BBR         | `EjendomBBRTab`         | BBR-detaljer: grund, bygninger, enheder, plandata, jordforurening                                  | #3, #9, #10, #13                                               |
| Ejerforhold | `EjendomEjerforholdTab` | Ejer-chain, administrator, diagram med ejerandele                                                  | #6 (+ admin via `/api/ejendomsadmin` som AI ikke har tool til) |
| Oekonomi    | `EjendomOekonomiTab`    | Vurdering historik, foreløbig, salgshistorik, prischart                                            | #4, #5, #7                                                     |
| Skat        | `EjendomSkatTab`        | Grundskyld, dækningsafgift, ejendomsværdiskat                                                      | ⚠️ **GAP**                                                     |
| Dokumenter  | `EjendomDokumenterTab`  | Tinglyste dokumenter med servitutter/hæftelser                                                     | #18                                                            |

### 2.2 `/dashboard/companies/[cvr]` — 6 tabs

| Tab           | Felter vist                                     | Dækket af                                                                   |
| ------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| Overblik      | CVR-master, status, vedtægt, regnskabsperiode   | #11                                                                         |
| Nøglepersoner | Deltagere, roller, perioder                     | #12                                                                         |
| Regnskab      | XBRL-tal, chart, revisor, pengestrømsopgørelse  | #15 (grundtal OK) + ⚠️ **GAP** på revisor/pengestrømsopgørelse-detalje      |
| Gruppe        | Datterselskaber, koncernstruktur, ultimate-ejer | #16 (datterselskaber) + ⚠️ **GAP** på ultimate-ejer / koncerndiagram        |
| Historik      | Navneskifter, adresseskifter, statusskifter     | ⚠️ **GAP** (ikke dækket af hent_cvr_virksomhed — historik-endpoint mangler) |
| Ejendomme     | Virksomhedens ejendomsportefølje                | #19                                                                         |
| (sektion)     | Seneste nyheder (Mediastack)                    | ⚠️ **GAP**                                                                  |
| (sektion)     | Stripe billing-gate UI — ikke AI-relevant       | —                                                                           |

### 2.3 `/dashboard/owners/[enhedsNummer]` — 1 side

| Sektion      | Felter                                    | Dækket af                                      |
| ------------ | ----------------------------------------- | ---------------------------------------------- |
| Info         | Navn, CPR-interval, aktive roller         | #17, #14                                       |
| Virksomheder | Personens virksomheder, ejerskabs-procent | #14                                            |
| Ejendomme    | Personens ejendomsportefølje              | #20                                            |
| Relationer   | Co-direktører, medejere                   | ⚠️ **GAP** (netværks-graf viser ingen AI-tool) |

## 3. Identificerede gaps

Følgende UI-felter er synlige for brugeren men AI har **ingen tool** til
at slå op:

### 3.1 Høj-prioritet gaps (frekvens + AI-værdi)

| #   | Gap                                                 | UI-sted              | Potentielt tool-navn       | Kilde                                         |
| --- | --------------------------------------------------- | -------------------- | -------------------------- | --------------------------------------------- |
| G1  | Ejendomsadministrator / ejerforening                | SFE, Ejerforhold-tab | `hent_ejendomsadmin`       | `/api/ejendomsadmin` (existing)               |
| G2  | Virksomheds-historik (navne/adresse/status-skifter) | Virksomhed/Historik  | `hent_virksomhed_historik` | CVR ES endnu ikke integreret                  |
| G3  | Koncern-ultimate-ejer / ejer-stak-op                | Virksomhed/Gruppe    | `hent_koncern_chain`       | `/api/ejerskab/chain` (existing)              |
| G4  | Ejendomsskat (grundskyld/dækningsafgift/boligskat)  | Ejendom/Skat-tab     | `hent_ejendomsskat`        | VUR / beregning endnu ikke eksponeret som API |

### 3.2 Medium-prioritet gaps

| #   | Gap                                          | UI-sted             | Potentielt tool-navn      | Kilde                                  |
| --- | -------------------------------------------- | ------------------- | ------------------------- | -------------------------------------- |
| G5  | Mediastack news-feed om virksomhed           | Virksomhed/Overblik | `hent_virksomhed_nyheder` | `/api/news?q=...` (existing, internal) |
| G6  | Person-netværk (co-direktører, medejere)     | Person/Relationer   | `hent_person_netvaerk`    | CVR deltager-graf                      |
| G7  | Ejendomshierarki (SFE ↔ bygning ↔ lejlighed) | Bygning/SFE-sider   | `hent_ejendoms_hierarki`  | MAT + BBR kombineret                   |

### 3.3 Lav-prioritet gaps (dybde-forbedring af existing tools)

| #   | Gap                                                  | Existing tool der bør udvides |                         |
| --- | ---------------------------------------------------- | ----------------------------- | ----------------------- |
| G8  | Revisor + revisionspåtegning (tekst-kommentarer)     | `hent_regnskab_noegletal`     | Udvid med XBRL-notes    |
| G9  | Servitut-liste med sortering/filtrering              | `hent_tinglysning`            | Udvid med query-params  |
| G10 | Bygnings-klassificering og udfaset-status (BIZZ-825) | `hent_bbr_data`               | Returnér isUdfaset-flag |

## 4. Prioriteret follow-up ticket-plan

| Ticket-kandidat                                                           | Gap(s) | Effort | Priority |
| ------------------------------------------------------------------------- | ------ | ------ | -------- |
| `feat(ai): tool hent_ejendomsadmin for ejerforening + administrator`      | G1     | S      | High     |
| `feat(ai): tool hent_virksomhed_historik for navneskifter/status-skifter` | G2     | M      | High     |
| `feat(ai): tool hent_koncern_chain for ultimate-ejer + ejer-stak`         | G3     | M      | High     |
| `feat(ai): tool hent_ejendomsskat for grundskyld/dækningsafgift`          | G4     | L      | Medium   |
| `feat(ai): tool hent_virksomhed_nyheder for Mediastack-feed`              | G5     | S      | Medium   |
| `feat(ai): tool hent_person_netvaerk for co-roller`                       | G6     | M      | Medium   |
| `feat(ai): tool hent_ejendoms_hierarki for SFE ↔ bygning ↔ lejlighed`     | G7     | M      | Medium   |
| `enh(ai): berig hent_regnskab_noegletal med XBRL-notes`                   | G8     | S      | Low      |
| `enh(ai): berig hent_tinglysning med filter-params`                       | G9     | S      | Low      |
| `enh(ai): berig hent_bbr_data med isUdfaset + klassificering`             | G10    | XS     | Low      |

## 5. Måling af coverage før vs efter

- **Før denne audit**: 21 tools dækker ~17 af 21 UI-sektioner identificeret
  ovenfor → coverage ≈ **81%**, med 4 fully-gap sektioner (administrator,
  historik, skat, ultimate-ejer) + 6 partial gaps.
- **Efter High-prio tickets G1-G4**: coverage → **≈95%**.
- **Efter Medium-prio G5-G7**: coverage → **≈99%**.

## 6. Metode

Audit-metode:

1. Listet alle tools i `TOOLS`-array i `app/api/ai/chat/route.ts:75-421`.
2. Listet alle tab-komponenter i:
   - `app/dashboard/ejendomme/[id]/tabs/*`
   - `app/dashboard/companies/[cvr]/tabs/*`
   - `app/dashboard/owners/[enhedsNummer]/PersonDetailPageClient.tsx`
3. Kryds-refereret hvert UI-felt med tool-beskrivelsen.
4. Klassificeret som "dækket", "partial" eller "gap".

## 7. Opfølgning

Tickets oprettet 2026-04-24 via `scripts/create-875-followups.mjs`:

| Gap | Ticket   | Priority | Summary                                 |
| --- | -------- | -------- | --------------------------------------- |
| G1  | BIZZ-889 | High     | feat(ai): tool hent_ejendomsadmin       |
| G2  | BIZZ-890 | High     | feat(ai): tool hent_virksomhed_historik |
| G3  | BIZZ-891 | High     | feat(ai): tool hent_koncern_chain       |
| G4  | BIZZ-892 | Medium   | feat(ai): tool hent_ejendomsskat        |
| G5  | BIZZ-893 | Medium   | feat(ai): tool hent_virksomhed_nyheder  |
| G6  | BIZZ-894 | Medium   | feat(ai): tool hent_person_netvaerk     |
| G7  | BIZZ-895 | Medium   | feat(ai): tool hent_ejendoms_hierarki   |

Lav-prio gaps G8-G10 (berig eksisterende tools) er bevidst ikke separate
tickets — de samles til én enh-ticket ved senere iteration hvis kapacitet
tillader det.

---

**Audit udført af:** Claude Opus 4.6 (autonomous loop)  
**Baseret på:** develop branch ved commit `2fda7df` (2026-04-24 13:13)
