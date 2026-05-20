# AI Chat Integration Test — Manuel testplan

Log ind på **test.bizzassist.dk** og åbn AI Chat panelet. Kør hvert spørgsmål og verificer resultatet.

## Test-data
- **Ejendom:** Vigerslevvej 146, 1. th, 2500 Valby (BFE 167448)
- **Virksomhed:** JaJR Holding ApS (CVR 41092807)
- **Person:** Jakob Juul Rasmussen

---

## Test 1 — BBR data (Oversigt/BBR tab)
**Spørgsmål:** Hvad er byggeåret og boligarealet for Vigerslevvej 146, 1. th, 2500 Valby?
**Forventet:** Byggeår ~1940, boligareal i m²
**Tool:** `hent_bbr_data`
**Status:** [ ] PASS / [ ] FAIL

## Test 2 — Vurdering (Økonomi tab)
**Spørgsmål:** Hvad er den seneste ejendomsvurdering og grundværdi for Vigerslevvej 146, 1. th, 2500 Valby?
**Forventet:** Ejendomsværdi + grundværdi i DKK (2020 eller 2024)
**Tool:** `hent_vurdering`
**Status:** [ ] PASS / [ ] FAIL

## Test 3 — Ejerskab (Ejerskab tab)
**Spørgsmål:** Hvem ejer Vigerslevvej 146, 1. th, og hvornår overtog de?
**Forventet:** Jakob Juul Rasmussen, 100%, 21. marts 2005
**Tool:** `hent_ejerskab`
**Status:** [ ] PASS / [ ] FAIL

## Test 4 — Tinglysning (Tinglysning tab)
**Spørgsmål:** Er der hæftelser eller servitutter tinglyst på Vigerslevvej 146, 1. th, 2500 Valby?
**Forventet:** Pantebreve og/eller servitutter fra tinglysningsretten
**Tool:** `hent_tinglysning`
**Status:** [ ] PASS / [ ] FAIL

## Test 5 — Energimærke (Dokumenter tab)
**Spørgsmål:** Hvad er energimærket for Vigerslevvej 146, 1. th, 2500 Valby?
**Forventet:** Energiklasse (A-G) + gyldighedsperiode
**Tool:** `hent_energimaerke`
**Status:** [ ] PASS / [ ] FAIL

## Test 6 — Jordforurening (Dokumenter tab)
**Spørgsmål:** Er der jordforurening registreret på Vigerslevvej 146, 2500 Valby?
**Forventet:** V1/V2 kortlægningsstatus eller "ikke kortlagt"
**Tool:** `hent_jordforurening`
**Status:** [ ] PASS / [ ] FAIL

## Test 7 — Plandata (Dokumenter tab)
**Spørgsmål:** Hvilken lokalplan gælder for Vigerslevvej 146, 2500 Valby?
**Forventet:** Lokalplan navn/nummer + eventuelt bebyggelsesprocent
**Tool:** `hent_plandata`
**Status:** [ ] PASS / [ ] FAIL

## Test 8 — Matrikel (BBR tab)
**Spørgsmål:** Hvad er matrikelnummeret og grundarealet for Vigerslevvej 146, 2500 Valby?
**Forventet:** Matrikelnr, ejerlav, areal i m²
**Tool:** `hent_matrikeldata`
**Status:** [ ] PASS / [ ] FAIL

## Test 9 — CVR virksomhed (Virksomhed tab)
**Spørgsmål:** Hvad laver JaJR Holding ApS (CVR 41092807), og hvornår blev virksomheden stiftet?
**Forventet:** Branche, stiftelsesdato, adresse
**Tool:** `hent_cvr_virksomhed`
**Status:** [ ] PASS / [ ] FAIL

## Test 10 — Regnskab (Regnskab tab)
**Spørgsmål:** Hvad er egenkapitalen for JaJR Holding ApS (CVR 41092807) i det seneste regnskab?
**Forventet:** Egenkapital i DKK fra seneste XBRL
**Tool:** `hent_regnskab_noegletal`
**Status:** [ ] PASS / [ ] FAIL

## Test 11 — Nøglepersoner (Nøglepersoner tab)
**Spørgsmål:** Hvem er direktør for JaJR Holding ApS (CVR 41092807)?
**Forventet:** Jakob Juul Rasmussen + eventuelle bestyrelsesmedlemmer
**Tool:** `hent_virksomhed_personer`
**Status:** [ ] PASS / [ ] FAIL

## Test 12 — Ejendomme for virksomhed (Ejendomme tab)
**Spørgsmål:** Hvilke ejendomme ejer JaJR Holding ApS (CVR 41092807)? Giv mig de første 5.
**Forventet:** Liste med BFE-numre og adresser
**Tool:** `hent_ejendomme_for_virksomhed`
**Status:** [ ] PASS / [ ] FAIL

## Test 13 — Person roller (Person tab)
**Spørgsmål:** Hvilke virksomheder er Jakob Juul Rasmussen tilknyttet? Søg med enhedsnummer 4004514945.
**Forventet:** JaJR Holding ApS + andre virksomheder med roller
**Tool:** `hent_person_virksomheder`
**Status:** [ ] PASS / [ ] FAIL

## Test 14 — SKAT/foreløbig vurdering (SKAT tab)
**Spørgsmål:** Hvad er den forventede årlige ejendomsskat for Vigerslevvej 146, 1. th, 2500 Valby under det nye vurderingssystem?
**Forventet:** Grundskyld + ejendomsværdiskat i DKK
**Tool:** `hent_forelobig_vurdering`
**Status:** [ ] PASS / [ ] FAIL

## Test 15 — Områdeprofil (Økonomi tab)
**Spørgsmål:** Hvad er befolkningstallet og den gennemsnitlige indkomst i området omkring Vigerslevvej 146, 2500 Valby?
**Forventet:** Befolkningstal + gennemsnitsindkomst
**Tool:** `hent_omraadeprofil`
**Status:** [ ] PASS / [ ] FAIL

---

## Bonustest — Filupload + Template-fill
1. Upload en DOCX-fil med `{{virksomhedsnavn}}`, `{{cvr}}`, `{{egenkapital}}` som placeholders
2. Skriv: "Udfyld dette dokument med data for JaJR Holding ApS"
3. **Forventet:** Download af udfyldt DOCX med korrekte værdier
**Status:** [ ] PASS / [ ] FAIL

---

## Resultater
- Passed: ___ / 15
- Failed: ___ / 15
- Bemærkninger:
