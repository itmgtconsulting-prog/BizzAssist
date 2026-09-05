# ADR-0011: Per-bruger tenant + domæne-federation for forsikrings-analyser

## Status

**Accepted / Implementeret** (2026-09-05, epic BIZZ-2192). Bygger videre på
[ADR-0005](0005-domain-feature.md).

Implementerings-noter (BIZZ-2192):

- **Read-federation** (2192.1–2192.3b): `app/lib/domainFederation.ts#getDomainLinkedTenants(userId)`
  returnerer egen tenant ∪ nuværende co-domæne-medlemmers tenants, beregnet på
  query-tid (ingen cache → øjeblikkelig revocation). Alle forsikrings-læsestier
  (analyser-liste, `[id]`, geo, eksport, sager, documents/for-customer) læser via
  denne helper. Live-verificeret + beskyttet af `e2e/forsikring-federation-leak.spec.ts`
  (2192.6): co-domæne ser hinandens data; ikke-federeret analyse → 404.
- **Skrivning** (2192.4): `resolveTenantId` vælger nu deterministisk brugerens
  ældste (personlige) tenant.
- **Ingen delt-tenant-migration nødvendig** (2192.7): verificeret at hver tenant
  i test+prod allerede har præcis 1 medlem (den tidligere delte `tenant_jakob_test`
  blev migreret 2026-06-01). Den planlagte irreversible split blev derfor ikke kørt.
- **Bibliotek** (2192.5): `public.forsikring_standard_doc` deles allerede korrekt
  pr. domæne via `visibility='domain'` + `added_by_domain` + RLS (BIZZ-1907) med
  revocation via `domain_member`. Den fysiske per-tenant-flytning blev vurderet
  som valgfri uniformitet uden funktionel/sikkerheds-gevinst og ikke udført
  (undgår unødig data-migrations-risiko).

Nettoresultat: delings-enheden er domænet, data forbliver personligt ejet, og
deling er revocable — som besluttet. Isolationen for cross-tenant LÆSNING er nu
app-gated (federations-helper) frem for fysisk umulig; hver læsesti går gennem
den ene testede federations-grænse og er dækket af læk-regressionstesten.

## Context

Forsikrings-gab-modulet gemmer analyser, dokumenter og sager i **per-tenant
PostgreSQL-schemaer** (`tenant_<x>.forsikring_analyser/-documents/-sager`),
scopet på `tenant_id` + fysisk schema-isolation. Biblioteket
(`forsikring_standard_doc`) ligger derimod centralt i `public` og deles pr.
**domæne** via `visibility='domain'` + `domain_member` (med automatisk
tilbagekald i migration 179 når et medlem fjernes).

Review 2026-06-23 afdækkede et mismatch: biblioteket deles pr. domæne, men
analyser deles kun pr. **tenant**. Domæne-medlemmer kan ligge i forskellige
tenants (det gør de i test) → to brugere i samme domæne ser hinandens
biblioteksdokumenter, men **ikke** hinandens analyser.

Produktejer har valgt en model hvor delings-enheden er domænet, men hvor data
forbliver personligt ejet og deling er revocable.

## Decision

**Per-bruger tenant + domæne som dynamisk, revocable læse-federation.**

1. **Hver bruger har sin egen tenant (1:1)** hvor egne analyser og dokumenter
   gemmes. Skrivning rører altid kun brugerens egen tenant — ejerskab er
   entydigt.
2. **Domæne = dynamisk læse-federation.** Ved læsning ser en bruger
   `egen tenant ∪ alle nuværende co-domæne-medlemmers tenants`. Federations-
   mængden beregnes på **query-tid** (ikke cachet), så ændringer i medlemskab
   slår igennem øjeblikkeligt.
3. **Revocation er gratis.** Data flyttes aldrig; fjernes `domain_member`-rækken
   skrumper federationen, og data er personlige igen. Ingen kopiering/sletning.
4. **Biblioteket flyttes også per-tenant** (besluttet 2026-06-23, ændrer tidligere
   anbefaling). Bruger-/domæne-uploadede biblioteksdokumenter gemmes i ejerens
   egen tenant (`tenant_<x>.forsikring_standard_doc` + junction) og deles via
   **samme** domæne-federation som analyser → fuldt uniform model, og det
   manuelle revoke (migration 179) erstattes af federationens query-tids-check.
   **Undtagelse:** `visibility='curated'` (det globale, BizzAssist-vedligeholdte
   standardbibliotek) ejes ikke af nogen bruger og forbliver en central,
   read-only katalog i `public` — det er reference-data, ikke brugerdata.

## Options Considered

### Option A (VALGT): Per-bruger tenant + domæne-federation

**Pro:** Personligt ejerskab; deling = eksplicit domæne-medlemskab; revocation
falder ud gratis; konsistent med biblioteks-mønsteret (allerede bevist);
`resolveTenantId` bliver entydig (egen tenant) → fjerner "vælg vilkårlig
tenant"-svagheden.

**Con:** Cross-schema UNION-læsning (N medlems-tenants); hver læsesti skal gå
gennem federations-helperen ellers lækker/under-deler den; 1:1-provisionering +
split af eksisterende delte tenants; per-schema migration-fan-out.

### Option B: Flyt analyser til `public` + `domain_id`-RLS

**Pro:** Én tabel, RLS håndhæver deling i DB. **Con:** Mister den fysiske
schema-isolation (stærkeste isolationsgaranti); stor data-migration; cross-org
PII i samme tabel kræver vandtæt RLS — højere blast radius.

### Option C: Status quo (tenant-deling)

**Pro:** Stærkest isolation, ingen ændring. **Con:** Domænet bliver kosmetisk
for analyser; bryder produktets samarbejds-løfte.

## Consequences

- **Isolation:** Skrivning + ikke-domæne-brugere bevarer fysisk schema-isolation.
  Cross-tenant **læsning** gates nu af app-logik (live co-membership-check) i
  stedet for at være fysisk umuligt — kræver regressionstest pr. læsesti.
- **Performance:** Liste/aggregat-queries fan-outer over N medlems-schemaer.
  Bundet af domæne-størrelse.
- **GDPR:** Domæne-medlemskab dokumenteres som delings-samtykke; unlink =
  tilbagekaldelse. Skal tilføjes data-klassifikation + privacy-dokumentation.
- **Migration:** Eksisterende delte tenants (fx `tenant_jakob_test`) skal
  splittes til per-bruger tenants.

## Implementation (epic BIZZ-2192)

1. `getDomainLinkedTenants(userId)` — federations-helper (egen + co-medlemmer),
   query-tid.
2. Cross-schema UNION på alle analyse/dokument-læsestier (liste, `[id]`, geo,
   eksport, junction). `[id]` verificerer ejer-tenant + live co-membership.
3. 1:1 tenant-provisionering ved signup; `resolveTenantId` → egen tenant.
4. Migration: split eksisterende delte tenants.
5. **Flyt biblioteket per-tenant:** opret `forsikring_standard_doc` + junction i
   tenant-schema-templaten; migrér eksisterende public bruger-/domæne-docs til
   ejernes tenants; behold `curated` centralt i `public`. Omskriv
   `/api/forsikring/standard-docs` (GET/POST/DELETE/PATCH) til per-tenant +
   federation (i stedet for public + RLS). Dette subsumerer BIZZ-2191 (den
   svage junction-RLS forsvinder når junction bliver schema-isoleret).
6. Regressionstests: cross-domæne læk-test + unlink → personlig-igen-test, for
   både analyser OG bibliotek.
