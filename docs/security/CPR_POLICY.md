# CPR-numre Policy (BIZZ-1703)

**Status:** Aktiv | **Godkendt:** 2026-05-19 | **Gælder:** Alle datakilder og features

## Regel

1. **Aldrig hent** CPR-numre fra eksterne kilder
2. **Aldrig udstil** CPR-numre i UI, API-responses, eksporter (DOCX/PDF), logs eller Sentry
3. **Aldrig persistér** CPR i vores DB (ingen cpr-kolonner, ingen CPR i tekst-felter)

## Per-datasource enforcement

### EJF (Datafordeler GraphQL)

- Brug **Begræ nset-varianter** konsekvent (EJFCustom_EjerskabBegraenset osv.)
- Person-id via `enhedsNummer`, aldrig CPR
- Whitelist felter eksplicit i queries — aldrig `*`-lignende mønstre

### Tinglysning bilagsbank (PDF-akter)

- AI-extraction: explicit prompt "UDELAD ALTID CPR-numre — sæt cpr: null"
- Output-redaction via `redactCpr()` som sikkerhedsnet
- PDF-cache: redact CPR FØR persistens

### AI-prompts

- Alle Claude-kald der processerer dokumenter har CPR-redaction instruktion
- Output-validation: `redactCpr()` på al AI-output
- Retry ved CPR-leak: logges til Sentry

### Database

- Ingen `cpr`-kolonner i nye tabeller
- Månedlig audit: `scripts/audit-pii-in-db.mjs`

### Logging / Sentry

- `redactPiiFromSentryEvent()` som beforeSend pre-processor
- `maskAllText: true` + `blockAllMedia: true` i Sentry config

### Frontend

- Ingen CPR-felter i UI
- Eksport (DOCX/PDF): `redactCpr()` før generering
- Søgning: afvis CPR-pattern input (422)

## Tekniske enforcement-mekanismer

| Mekanisme                    | Fil                                        | Status             |
| ---------------------------- | ------------------------------------------ | ------------------ |
| `redactCpr()`                | `app/lib/piiRedact.ts`                     | ✅ Implementeret   |
| `respectAddressProtection()` | `app/lib/piiRedact.ts`                     | ✅ Implementeret   |
| `truncateHistory()`          | `app/lib/piiRedact.ts`                     | ✅ Implementeret   |
| `redactPiiFromSentryEvent()` | `app/lib/piiRedact.ts`                     | ✅ Implementeret   |
| Kode-audit script            | `scripts/audit-pii-leak.mjs`               | ✅ Implementeret   |
| Unit tests                   | `__tests__/unit/piiRedact.test.ts`         | ✅ 14 tests        |
| AI Chat CPR-instruktion      | `app/api/ai/chat/route.ts`                 | ✅ I system prompt |
| Extract-akt CPR-redaction    | `app/api/tinglysning/extract-akt/route.ts` | ✅ Prompt + output |
| DB-audit cron                | `scripts/audit-pii-in-db.mjs`              | ❌ TODO            |
| Pre-commit hook              | `.husky/pre-commit`                        | ❌ TODO            |
| ESLint rule                  | `.eslintrc`                                | ❌ TODO            |

## Acceptance criteria for nye features

Alle nye features der håndterer persondata SKAL:

1. Bruge `Begraenset`-varianter af EJF-queries
2. Kalde `redactCpr()` på output der kan indeholde fritekst
3. Have explicit CPR-redaction instruktion i AI-prompts
4. Dokumentere CPR-håndtering i JIRA-ticket
