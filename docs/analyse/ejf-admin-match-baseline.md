# EJF-administrator match-baseline (BIZZ-1959)

> Genereret 2026-06-01 af `scripts/analyze-unmatched-ejf-admin.mjs` (sample=200, seed=1959, deterministisk).
> Datakilde: PROD-DB. Ingen UI-/schema-ændringer — ren data-eksploration.

## Universe

| Mål                                                                 | Antal      |
| ------------------------------------------------------------------- | ---------- |
| Gældende ejf_administrator uden CVR (`administrator_type='ukendt'`) | **28.986** |
| — heraf med rigtig adresse (ekskl. 'Ukendt adresse'/postnr 0000)    | 15.920     |
| Ejerforenings-navne-universe (`tmp_ejerforening_cvr`)               | 17.458     |
| Virksomheder med branchekode 683220                                 | 5.237      |

**NB:** Ticket nævnte 15.028 unmatched — det matcher dawa-delmængden på analysetidspunktet. Aktuelt totale unmatched-tal er 28.986 (vokset siden). Procenterne nedenfor er på en tilfældig stikprøve på 200 records med rigtig adresse.

## Approach-resultater (stikprøve N=200)

### A. Eksisterende vejnavn+husnr-search

| Udfald                  | Antal | Andel |
| ----------------------- | ----- | ----- |
| Entydigt match (A==1)   | 0     | 0.0%  |
| Flertydigt (A>1)        | 3     | 1.5%  |
| Intet match (A==0)      | 197   | 98.5% |
| Gns. kandidater pr. BFE | 0.04  |       |

### B. Vejnavn-only (bredere, uden husnr)

| Udfald                                   | Antal | Andel |
| ---------------------------------------- | ----- | ----- |
| Entydigt match (B==1)                    | 19    | 9.5%  |
| Flertydigt (B>1 — false-positive-risiko) | 59    | 29.5% |
| Intet match (B==0)                       | 122   | 61.0% |
| Gns. kandidater pr. BFE                  | 3.09  |       |

### C. Fuzzy similarity (embedding-PROXY via pg_trgm)

> **Ingen embedding-provider (OPENAI_API_KEY/VOYAGE_API_KEY mangler)** — kørt som deterministisk pg_trgm similarity-proxy. Tallene estimerer loftet en rigtig embedding-cosine-approach ville nå; trigram undervurderer typisk semantiske matches (forkortelser, ordstilling).

| Similarity-threshold | BFE'er m. match | — heraf entydigt højt (margin≥0.1) |
| -------------------- | --------------- | ---------------------------------- |
| sim ≥ 0.3            | 200 (100.0%)    | 21 (10.5%)                         |
| sim ≥ 0.4            | 152 (76.0%)     | 20 (10.0%)                         |
| sim ≥ 0.5            | 71 (35.5%)      | 18 (9.0%)                          |
| sim ≥ 0.6            | 33 (16.5%)      | 13 (6.5%)                          |

### D. Resights direkte lookup

**BLOKERET** — ingen Resights-credentials i miljøet (`RESIGHTS_*` mangler i `.env.local`). Kan ikke måles uden separat API-adgang. Anbefales scoped til egen spike-ticket hvis adgang skaffes.

## Segment-fordeling (hver BFE i præcis ét segment)

| Segment             | Antal | Andel | Betydning                                                                 |
| ------------------- | ----- | ----- | ------------------------------------------------------------------------- |
| RESOLVABLE_VIA_A    | 5     | 2.5%  | Vejnavn-search løser den (A==1 eller entydig vejnavn-only)                |
| RESOLVABLE_VIA_C    | 6     | 3.0%  | Fuzzy-proxy giver entydigt højt match — kandidat til embedding-fix        |
| RESOLVABLE_VIA_D    | 0     | 0.0%  | Resights (blokeret — ikke målt)                                           |
| AMBIGUOUS           | 73    | 36.5% | Flere plausible foreninger — kræver crowdsourced verifikation (BIZZ-1830) |
| WRONG_BRANCH        | 0     | 0.0%  | Forening findes men under anden branchekode end 683220                    |
| NO_CVR_EJERFORENING | 116   | 58.0% | Ingen forening nævner vejnavnet — irreducible (ingen CVR-ejerforening)    |

## 20 eksempel-cases (til manuel validering)

| BFE      | Adresse              | Vejnavn          | Husnr | Matrikel | Segment             | A   | B   | C-top                        |
| -------- | -------------------- | ---------------- | ----- | -------- | ------------------- | --- | --- | ---------------------------- |
| 2304389  | Lundevej 6B          | Lundevej         | 6B    | 3kk      | AMBIGUOUS           | 0   | 6   | 0.52 E/F Lundemosevej 2      |
| 2381580  | Fagerhøjvænge 1A     | Fagerhøjvænge    | 1A    | 8ba      | AMBIGUOUS           | 0   | 2   | 0.42 E/F Jernhøjvænge        |
| 4440395  | Virkelyst 16         | Virkelyst        | 16    | 9ab      | NO_CVR_EJERFORENING | 0   | 0   | 0.38 E/F Kirkely             |
| 2650151  | Grevenlundsvej 22A   | Grevenlundsvej   | 22A   | 13h      | RESOLVABLE_VIA_C    | 0   | 0   | 0.50 E/F Gyldenlundsvej 21   |
| 8752258  | Strandlinien 2       | Strandlinien     | 2     | 5a       | NO_CVR_EJERFORENING | 0   | 0   | 0.44 E/F Strandgården        |
| 4306967  | Palsgårdvej 9        | Palsgårdvej      | 9     | 8i       | NO_CVR_EJERFORENING | 0   | 0   | 0.35 E/F Fælledvej 9, 9A     |
| 2592734  | Bjergagervej 15      | Bjergagervej     | 15    | 10hø     | NO_CVR_EJERFORENING | 0   | 0   | 0.44 E/F Krogagervej 14      |
| 5307558  | Darupvang 15Z        | Darupvang        | 15Z   | 2fy      | NO_CVR_EJERFORENING | 0   | 0   | 0.30 E/F Solvang             |
| 2281873  | Kildegårdsvej 9      | Kildegårdsvej    | 9     | 3ai      | AMBIGUOUS           | 0   | 1   | 0.82 E/F Kildegårdsvej 4     |
| 4214493  | Brabrand Skovvej 15A | Brabrand Skovvej | 15A   | 3ø       | RESOLVABLE_VIA_A    | 0   | 1   | 0.83 E/F Brabrand Skovvej    |
| 7514678  | Nellikevej 1         | Nellikevej       | 1     | 23ao     | NO_CVR_EJERFORENING | 0   | 0   | 0.41 E/F Nybovej 1           |
| 10035830 | Åkrogs Strandvej 46  | Åkrogs Strandvej | 46    | 12bf     | NO_CVR_EJERFORENING | 0   | 0   | 0.43 E/F Strandvejen 38      |
| 2620522  | Rugårdsvej 117       | Rugårdsvej       | 117   | 7c       | AMBIGUOUS           | 0   | 9   | 0.85 E/F Rugårdsvej 11       |
| 5683104  | Røddingvej 3A        | Røddingvej       | 3A    | 322a     | NO_CVR_EJERFORENING | 0   | 0   | 0.39 E/F Tingvej 7           |
| 2014246  | Søborg Parkalle 86   | Søborg Parkalle  | 86    | 24ba     | NO_CVR_EJERFORENING | 0   | 0   | 0.38 E/F Søborg Vænge        |
| 4296701  | Præstevænget 17      | Præstevænget     | 17    | 7m       | AMBIGUOUS           | 0   | 4   | 0.72 E/F PRÆSTEVÆNGET 13-15A |
| 3117730  | Skernevej 24         | Skernevej        | 24    | 15h      | NO_CVR_EJERFORENING | 0   | 0   | 0.45 E/F Skerrisvej          |
| 5669207  | Vesterbrogade 35     | Vesterbrogade    | 35    | 233i     | AMBIGUOUS           | 0   | 25  | 0.83 E/F Vesterbrogade 36    |
| 2280972  | Kappelhøjvej 131     | Kappelhøjvej     | 131   | 12       | NO_CVR_EJERFORENING | 0   | 0   | 0.46 E/F Valhøjvej 13        |
| 5470361  | Læssøegade 140       | Læssøegade       | 140   | 7gm      | AMBIGUOUS           | 0   | 18  | 0.85 E/F Læssøegade 14       |

## Anbefaling (ROI pr. backfill-fix)

Ekstrapoleret til hele populationen (28.986 unmatched):

1. **RESOLVABLE_VIA_A (2.5% ≈ 725 records)** — højeste ROI og lavest risiko. Re-kør den eksisterende vejnavn+husnr-backfill (post BIZZ-1888/1917-fixes) på hele populationen. Disse burde have matchet og gør det nu.
2. **AMBIGUOUS (36.5%)** — kanaliser til crowdsourced verifikation (BIZZ-1830). Auto-match er for risikabelt (flere foreninger på samme vej).
3. **RESOLVABLE_VIA_C (3.0% via trigram-proxy)** — medium ROI, men kræver embedding-provider (OPENAI/VOYAGE-key). **Tallet skal IKKE auto-matches:** trigram-proxyen producerer street-navn-false-positives — fx blev "Grevenlundsvej 22A" matchet til "E/F Gyldenlundsvej 21" (anden vej, sim 0.50). Trigram måler tegn-overlap, ikke semantik, så det både over- og underestimerer en rigtig embedding-approach. Behandl C-segmentet som _kandidater til manuel/embedding-verifikation_ (BIZZ-1960), ikke som klar-til-backfill. Byg KUN hvis A+verifikation ikke er nok.
4. **WRONG_BRANCH (0.0%)** — foreninger findes men under anden branchekode. Lav ROI: udvid ejerforenings-universet (`tmp_ejerforening_cvr`) til at inkludere navne-mønster uanset branchekode, så A/B fanger dem.
5. **NO_CVR_EJERFORENING (58.0%)** — irreducible: der findes ingen CVR-registreret ejerforening for adressen. Byg IKKE flere fixes mod disse; markér dem `administrator_type='ingen_cvr_forening'` så de holdes ude af fremtidige candidate-tællinger.

**Bottom line:** Start med at re-køre Approach A på fuld population (størst yield, nul ny infrastruktur), send AMBIGUOUS til verifikation, og reservér embedding-arbejdet (C/BIZZ-1960) til resten. 58.0% er sandsynligvis uopnåelige og bør mærkes som sådan for at stoppe gentagne candidate-re-scans.
