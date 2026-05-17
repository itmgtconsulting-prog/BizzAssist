# ETL XML Fixtures — BIZZ-1527

Anonymiserede XML responses fra Tinglysning ElektroniskAkt S2S API.

Bruges af:

- `__tests__/unit/s2sClient.test.ts` — mocks fetch og returnerer disse fixtures
- `__tests__/integration/s2s-roundtrip.test.ts` — sammenligner live-svar-shape med fixture-shape (kun når `RUN_S2S_INTEGRATION=true`)

## Anonymisering

Alle person- og virksomhedsnavne er erstattet med fiktive (Anders Andersen, ACME Holding A/S),
CVR-numre er ændret til ikke-eksisterende værdier (99999991-99999999), og adresser
er ændret til "Testvej 1, 9999 Testby". BFE 100000001 bruges som test-ID.

Hvis du tilføjer en ny fixture:

1. Kør `node scripts/record-etl-fixture.mjs <operation> <bfe>` mod test.tinglysning.dk
2. Scriptet erstatter PII automatisk via regex-replace
3. Manuel review: ingen rigtige navne/CVR'er/adresser tilbage
4. Commit fixture med beskrivende navn

## Coverage pr. operation (BIZZ-1527)

| Operation                  | Fixture                       | Status |
| -------------------------- | ----------------------------- | ------ |
| EjendomSummariskHent       | `ejendom-summarisk.xml`       | sample |
| EjendomStamoplysningerHent | `ejendom-stamoplysninger.xml` | sample |
| EjendomAdkomsterHent       | `ejendom-adkomster.xml`       | sample |
| EjendomServitutterHent     | `ejendom-servitutter.xml`     | sample |
| EjendomHaeftelserHent      | `ejendom-haeftelser.xml`      | sample |
| EjendomIndskannetAktHent   | `ejendom-indskannet-akt.xml`  | sample |
| EjendomSoeg                | `ejendom-soeg.xml`            | sample |
| VirksomhedSoeg             | `virksomhed-soeg.xml`         | sample |

`sample` = skeleton XML der matcher den dokumenterede response-struktur
(fra `docs/tinglysning/system-systemmanual-v1.53.txt` + observeret prod-flow).
Erstattes med rigtige recorded responses når `record-etl-fixture.mjs` køres
mod test-miljøet.

## SOAP Faults

`fault-validation.xml` indeholder en typisk SOAP fault fra Tinglysning når
en request fejler validering. Bruges til at teste error-paths i parser.
