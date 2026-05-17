# JIRA Tickets — Tinglysning S2S XML API (V2 — based on working blueprint)

**Reference:** [ADR 0009](../adr/0009-s2s-xml-api-integration.md) · **Blueprint:** `app/lib/tinglysningHistoriskAdkomster.ts` (BIZZ-1494)
**Created:** 2026-05-15 · **Project:** BIZZ · **Component:** Tinglysning
**Supersedes:** `BIZZ-9XX-s2s-tickets.md` (V1 — wrong technical assumptions; SHA-256 instead of SHA-512, wrong folder structure)

---

## ⚠ READ FIRST — for the coding agent

All tickets below build on a **working reference implementation** that proves the S2S protocol works in production: `app/lib/tinglysningHistoriskAdkomster.ts` (committed in `d65cea05`, BIZZ-1494).

**Critical protocol facts (verified 2026-05-15):**

- Path format: `https://xml-api.tinglysning.dk/ElektroniskAkt/<Operation>`
- POST, `Content-Type: application/xml`
- Header `Tinglysning-Message-ID: uuid:<lowercase-uuid>` (REQUIRED, format strict)
- Signature: **RSA-SHA512** + Exclusive C14N + SHA-256 digest
- Signature MUST have `Id="Signature-<uuid>"` attribute
- Root element MUST NOT have an `Id` attribute
- `<Reference URI="">` — signs the whole document
- Goes through Hetzner-proxy `${DF_PROXY_URL}/proxy/<host>/<path>` with `X-Proxy-Secret` header
- `EjendomIdentifikator` element requires `Matrikel` (district name + identifier + matrikelnummer) — NOT just BFE number. Use REST `/ejendom/hovednoteringsnummer` then `/ejdsummarisk/{uuid}` to look up matrikel-info first.

**Stack already in place:**

- Deps in `package.json`: `node-forge` ^1.4.0, `xml-crypto` ^6.1.2, `@xmldom/xmldom`, `@types/node-forge`
- Env vars in Vercel Prod+Preview: `TINGLYSNING_CERT_B64`, `TINGLYSNING_CERT_PASSWORD`, `DF_PROXY_URL`, `DF_PROXY_SECRET`, `TINGLYSNING_BASE_URL`
- Cert registered as S2S aktør: RID `UI:DK-O:G:c12026c7-9ef1-4c03-ae26-00f4cb3be7e9`, CVR 44718502
- LRU cache helper: `@/app/lib/lruCache`
- Logger: `@/app/lib/logger`
- REST helper: `@/app/lib/tlFetch`

**Project rules (from CLAUDE.md — non-negotiable):**

- No `any` types
- All API routes: `resolveTenantId()` at top, 401 if unauthenticated, try/catch + Sentry
- Never expose raw external API errors — return `'Ekstern API fejl'`
- `AbortSignal.timeout(10000)` on external fetches (longer for XML API: 60s OK)
- Write audit log entries for every operation
- JSDoc required on every function, hook, component, API route
- Commit messages: lowercase subject, conventional commits (`feat:`, `fix:`, etc.)
- No `--no-verify` on commits

---

## BIZZ-1500 — Refactor: extract reusable `s2sClient.ts` helper

**Type:** Task · **Priority:** High · **Estimate:** 6h · **Labels:** `s2s`, `tinglysning`, `refactor`

**Why:**

Before adding 8+ more S2S operations, extract the common signing + sending logic from `tinglysningHistoriskAdkomster.ts` into a shared helper. Without this, every new operation duplicates ~150 lines of cert-loading, signature-building, and HTTP-posting code.

**File to create:** `app/lib/s2sClient.ts`

**Public API:**

```ts
/**
 * Generic S2S helper. Takes an unsigned request body, signs it with the OCES cert,
 * POSTs via the proxy with the right headers, returns the response text + status.
 *
 * Throws on cert/signing errors. Returns { status, body } even on HTTP errors —
 * the caller decides whether to treat e.g. 500 as a fault or to parse a SOAP fault.
 */
export async function callS2S(
  operation: string,
  unsignedRequestXml: string,
  options?: {
    timeoutMs?: number; // default 60000
    messageId?: string; // default `uuid:${randomUUID()}`
    service?: string; // default 'ElektroniskAkt'
  }
): Promise<{ status: number; body: string; messageId: string; durationMs: number }>;

/**
 * Loads OCES cert + private key from PKCS#12 (PFX) env var or file path.
 * Cached module-level — only parses PFX once per process.
 */
export function loadOcesCertAndKey(): { privateKeyPem: string; certBase64: string };

/**
 * Signs an unsigned XML document with XMLDSig enveloped-signature.
 * Algorithm: RSA-SHA512, canonicalization exc-c14n, digest SHA-256.
 *
 * @param unsignedXml - The XML document as a string. Root must NOT have an Id attribute.
 * @param rootElementName - Name of the root element (e.g. "EjendomHistoriskAdkomsterHent")
 *                          — used to know where to inject the signature.
 * @returns Signed XML string with <Signature> injected before the root's closing tag.
 */
export function signXmlBody(unsignedXml: string, rootElementName: string): string;
```

**Implementation guide:**

Lift these functions from `tinglysningHistoriskAdkomster.ts` verbatim:

- `loadCertPemKey()` → rename to `loadOcesCertAndKey()`, move to `s2sClient.ts`
- The signature-building inside `buildSignedRequest()` → extract to `signXmlBody()`. The matrikel-injection part stays in the per-operation file because each operation has its own body shape.
- The POST + proxy URL-rewrite + Message-ID logic → extract to `callS2S()`

Then refactor `tinglysningHistoriskAdkomster.ts` to use these helpers — it should shrink significantly.

**Acceptance criteria:**

- [ ] `app/lib/s2sClient.ts` created with the 3 exported functions above
- [ ] `tinglysningHistoriskAdkomster.ts` refactored to use the helpers — no behavior change
- [ ] All existing tests for historisk-adkomster still pass
- [ ] Unit tests for `s2sClient.ts`: cert loading (with/without env var), signing (verify signature is valid against the cert's public key), URL rewrite for proxy
- [ ] JSDoc on every exported function

**Dependencies:** None — can start immediately

**Test commands:**

```bash
npm test -- s2sClient
npm test -- tinglysningHistoriskAdkomster
```

---

## Forespørger-operationer (Phase B)

Each ticket below follows the same pattern: create `app/lib/tinglysning<Operation>.ts` using the `s2sClient.ts` helper from BIZZ-1500. Reference `tinglysningHistoriskAdkomster.ts` as the template.

---

## BIZZ-1501 — Implement `EjendomAdkomsterHent` (current owners)

**Type:** Task · **Priority:** High · **Estimate:** 4h · **Labels:** `s2s`, `tinglysning`, `forespoerger`

**Why:**

Current adkomst (active ownership) data is needed for property pages. REST `/ejdsummarisk` returns this but the XML API version provides more detail (ejerandel decimals, akt-numre, dokumentdato). Complements `tinglysningHistoriskAdkomster.ts` which only returns historical.

**Files:**

- Create: `app/lib/tinglysningAdkomster.ts`
- Create: `app/api/etl/ejendom/adkomster/route.ts`
- Reference XSD: WSDL has `EjendomAdkomsterHent` — request requires `EjendomIdentifikator` (same matrikel structure as historisk-adkomster)

**Public API:**

```ts
export interface AdkomstRow {
  /** ISO YYYY-MM-DD */
  dato: string | null;
  /** "ENDELIGTSKOEDE" etc. */
  dokumentType: string | null;
  /** Akt-nummer hvis tilgængeligt */
  aktNummer: string | null;
  /** Adkomsthavere */
  adkomsthavere: AdkomsthaverInfo[]; // import from tinglysningHistoriskAdkomster
  /** Købesum DKK hvis i AsciiTekst */
  koebesumDkk: number | null;
}

export async function fetchAktuelleAdkomsterByBfe(bfe: number): Promise<AdkomstRow[]>;
```

**Implementation:**

1. Use `lookupMatrikel(bfe)` — extract this from `tinglysningHistoriskAdkomster.ts` (move to `app/lib/tinglysningMatrikel.ts` as part of BIZZ-1500 if not done there)
2. Build request body with operation name `EjendomAdkomsterHent`
3. Call `callS2S('EjendomAdkomsterHent', unsigned, ...)` from BIZZ-1500 helper
4. Parse `<EjendomAdkomstSamling>` entries from response
5. Cache 1 hour LRU (max 150 entries)

**API route (`/api/etl/ejendom/adkomster`):**

- `GET /api/etl/ejendom/adkomster?bfe=<number>`
- `resolveTenantId()` first
- Rate limit: heavy (10/min/tenant)
- Returns `{ adkomster: AdkomstRow[] }`
- 502 on XML API failure with generic message
- Log audit entry: operation=`etl.EjendomAdkomsterHent`, bfe, status, durationMs

**Acceptance criteria:**

- [ ] `fetchAktuelleAdkomsterByBfe(bfe)` returns typed array
- [ ] Returns `[]` on error (graceful — like blueprint pattern)
- [ ] API route follows CLAUDE.md security rules
- [ ] Unit test: mock `callS2S` response with recorded fixture, verify parsing
- [ ] Integration test (`scripts/test-etl-adkomster.mjs`) hits prod for known BFE, verifies non-empty result
- [ ] CPR-masking on adkomsthavere (reuse logic from historisk-adkomster)
- [ ] Coverage: ≥ 80% lines on the new lib file

**Dependencies:** BIZZ-1500

---

## BIZZ-1502 — Implement `EjendomServitutterHent`

**Type:** Task · **Priority:** High · **Estimate:** 4h · **Labels:** `s2s`, `tinglysning`, `forespoerger`

**Files:**

- Create: `app/lib/tinglysningServitutter.ts`
- Create: `app/api/etl/ejendom/servitutter/route.ts`

**Public API:**

```ts
export interface ServitutRow {
  /** ISO YYYY-MM-DD */
  dato: string | null;
  /** Servituttype-tekst (fx "Færdselsret", "Forsynings-/afløbsledninger") */
  type: string | null;
  /** Akt-nummer */
  aktNummer: string | null;
  /** Påtaleberettigede (parsed) */
  paataleberettigede: string[];
  /** Indhold/beskrivelse fra AsciiTekst */
  beskrivelse: string | null;
  /** Rå base64-decoded tekst (debug) */
  rawText: string | null;
}

export async function fetchServitutterByBfe(bfe: number): Promise<ServitutRow[]>;
```

**Acceptance criteria:**

- [ ] Same shape as BIZZ-1501 (helper + route + tests + caching + audit)
- [ ] Test against BFE that has known servitutter (use `scripts/test-etl-servitutter.mjs`)
- [ ] Existing `/api/tinglysning/route.ts` (which returns combined data via REST) should be **extended** — not replaced — to optionally use this XML helper when query param `?xml=1` is set. This lets us A/B compare REST vs XML data quality before full migration.

**Dependencies:** BIZZ-1500

---

## BIZZ-1503 — Implement `EjendomHaeftelserHent`

**Type:** Task · **Priority:** High · **Estimate:** 4h · **Labels:** `s2s`, `tinglysning`, `forespoerger`

**Files:**

- Create: `app/lib/tinglysningHaeftelser.ts`
- Create: `app/api/etl/ejendom/haeftelser/route.ts`

**Public API:**

```ts
export interface HaeftelseRow {
  /** ISO YYYY-MM-DD */
  dato: string | null;
  /** Type: "REALKREDITPANT", "EJERPANT", "UDLAEG", etc. */
  type: string | null;
  /** Hovedstol DKK */
  hovedstolDkk: number | null;
  /** Restgaeld DKK hvis oplyst */
  restgaeldDkk: number | null;
  /** Kreditor-navn */
  kreditor: string | null;
  /** Akt-nummer */
  aktNummer: string | null;
  /** Renteoplysninger fra AsciiTekst */
  rente: string | null;
}

export async function fetchHaeftelserByBfe(bfe: number): Promise<HaeftelseRow[]>;
```

**Acceptance criteria:**

- [ ] Same pattern + tests as BIZZ-1501/1502
- [ ] Parse hovedstol, restgæld, kreditor, type from `<EjendomHaeftelse>` XML + AsciiTekst
- [ ] Audit log includes count of hæftelser returned (for monitoring)

**Dependencies:** BIZZ-1500

---

## BIZZ-1504 — Implement `EjendomSummariskHent` via XML (replace REST)

**Type:** Task · **Priority:** Medium · **Estimate:** 5h · **Labels:** `s2s`, `tinglysning`, `forespoerger`, `migration`

**Why:**

Current `/api/tinglysning/summarisk/route.ts` (BIZZ-1462) uses REST `/ejdsummarisk` which will be deprecated 2026-09-18. The XML API equivalent is `EjendomSummariskHent`. Implement XML version, keep REST as fallback for now.

**Files:**

- Create: `app/lib/tinglysningSummariskXml.ts` (new XML version)
- Modify: `app/api/tinglysning/summarisk/route.ts` (add XML-first with REST fallback)

**Behavior:**

- Add env flag `TINGLYSNING_SUMMARISK_USE_XML=true|false` (default false initially)
- When ON: try XML first, fall back to REST + log warning on XML failure
- When OFF: REST only (current behavior)
- Cache logic stays the same (BIZZ-1462's 7-day cache)

**Acceptance criteria:**

- [ ] XML helper returns same data shape as current REST endpoint (matrikel, adresse, vurdering, BFE)
- [ ] Feature flag respected
- [ ] A/B comparison logged: when XML succeeds, log data-diff vs REST (for QA before flipping default to ON)
- [ ] Integration test runs both paths, asserts ≥ 95% field-overlap
- [ ] No breaking change to consumers of `/api/tinglysning/summarisk`

**Dependencies:** BIZZ-1500

---

## BIZZ-1505 — Implement `EjendomIndskannetAktHent`

**Type:** Task · **Priority:** Medium · **Estimate:** 6h · **Labels:** `s2s`, `tinglysning`, `forespoerger`, `pdf`

**Why:**

Current `/api/tinglysning/indskannede-akter/download/route.ts` uses REST and is documented (in `docs/tinglysning/xmlapi/XMLAPI-NOTES.md`) to have failed historically with the prod cert. With S2S now registered, XML API should work.

**Files:**

- Create: `app/lib/tinglysningIndskannetAkt.ts`
- Modify: `app/api/tinglysning/indskannede-akter/download/route.ts` (use XML path)

**Public API:**

```ts
export interface IndskannetAktResultat {
  /** application/pdf etc. */
  mimeType: string;
  /** Base64-decoded binary content as Buffer */
  data: Buffer;
  /** Original filename */
  filnavn: string;
}

export async function fetchIndskannetAkt(
  dokumentFilnavn: string
): Promise<IndskannetAktResultat | null>;
```

**Request body (per XSD):**

```xml
<EjendomIndskannetAktHent xmlns="..."
    xmlns:eakt="...elektroniskakt/1/">
  <eakt:DokumentFilnavnTekst>{filnavn}</eakt:DokumentFilnavnTekst>
</EjendomIndskannetAktHent>
```

**Note:** No matrikel-lookup needed — only filename is required. Simpler than BIZZ-1501/1502/1503.

**Acceptance criteria:**

- [ ] Returns binary PDF + mimetype from base64-decoded `<IndskannetDokumentData>`
- [ ] API route streams the PDF with correct `Content-Type` + `Content-Disposition`
- [ ] 60s timeout (PDF can be large)
- [ ] Updates `docs/tinglysning/xmlapi/XMLAPI-NOTES.md` "Status" table — change from "ECONNRESET" to "Works" after testing

**Dependencies:** BIZZ-1500

---

## BIZZ-1506 — Implement `SenesteAendringTinglysningsobjektHent`

**Type:** Task · **Priority:** Medium · **Estimate:** 3h · **Labels:** `s2s`, `tinglysning`, `forespoerger`, `cache-validation`

**Why:**

Lightweight "has anything changed?" check — used for cache validation. Returns just the latest change-timestamp + change-type for an ejendom. Cheap to call (no full data transfer), so good for cron jobs that decide whether to refresh cached data.

**Files:**

- Create: `app/lib/tinglysningSenesteAendring.ts`
- Modify: existing `app/api/tinglysning/senesteaendring/route.ts` if it exists (or create)

**Public API:**

```ts
export interface SenesteAendringResultat {
  /** ISO timestamp of latest change */
  senesteAendringTid: string | null;
  /** Type of change */
  aendringType: string | null;
  /** UUID of the tinglysningsobjekt */
  objektUuid: string | null;
}

export async function fetchSenesteAendring(bfe: number): Promise<SenesteAendringResultat | null>;
```

**Acceptance criteria:**

- [ ] No caching at lib level (the whole point is to check freshness)
- [ ] Used by `/api/cron/refresh-tinglysning-cache` to decide what to refresh
- [ ] Fast: < 500ms p99 on warm S2S connection

**Dependencies:** BIZZ-1500

---

## BIZZ-1507 — Implement `AendredeTinglysningsobjekterHent`

**Type:** Task · **Priority:** Medium · **Estimate:** 4h · **Labels:** `s2s`, `tinglysning`, `forespoerger`, `cron`

**Why:**

Bulk "what changed in the last N hours/days?" — backbone for "follow property" alerts and incremental cache refresh. Similar to BIZZ-523/524 work mentioned in git log (already shipped for REST API — port to XML).

**Files:**

- Create: `app/lib/tinglysningAendringer.ts`
- Modify: `app/api/cron/pull-tinglysning-aendringer/route.ts` (use XML)

**Public API:**

```ts
export interface AendringEntry {
  bfe: number;
  objektUuid: string;
  aendringTid: string; // ISO
  aendringType: string;
}

export async function fetchAendringer(since: Date, limit?: number): Promise<AendringEntry[]>;
```

**Acceptance criteria:**

- [ ] Pagination support if XML API returns it
- [ ] Cron route runs every 4h (existing schedule), updates `tinglysning_aendring` table
- [ ] Idempotent: same window can be re-pulled without dupe inserts (upsert by objektUuid+aendringTid)

**Dependencies:** BIZZ-1500

---

## BIZZ-1508 — Implement `EjendomSoeg` (search by adresse/matrikel/ejer)

**Type:** Task · **Priority:** Medium · **Estimate:** 5h · **Labels:** `s2s`, `tinglysning`, `forespoerger`, `search`

**Files:**

- Create: `app/lib/tinglysningEjendomSoeg.ts`
- Create: `app/api/etl/ejendom/soeg/route.ts`

**Public API:**

```ts
export interface EjendomSoegInput {
  adresse?: string; // free-text address
  matrikelNr?: string;
  districtName?: string;
  ejerNavn?: string; // for owner-based search
  cprCvr?: string;
  pageSize?: number;
  pageOffset?: number;
}

export interface EjendomSoegResultat {
  bfe: number;
  objektUuid: string;
  adresse: string;
  matrikelNr: string;
}

export async function searchEjendom(input: EjendomSoegInput): Promise<{
  results: EjendomSoegResultat[];
  total: number;
}>;
```

**Acceptance criteria:**

- [ ] At minimum 1 search criterion required (input validation)
- [ ] Pagination via `Antal` + offset (XML API supports it)
- [ ] Rate limit: heavy (5/min/tenant) — search is expensive
- [ ] Cache by input hash for 1 hour
- [ ] Returns top 50 results max

**Dependencies:** BIZZ-1500

---

## BIZZ-1509 — Implement `VirksomhedSoeg` (CVR lookup via Tinglysning)

**Type:** Task · **Priority:** Low · **Estimate:** 3h · **Labels:** `s2s`, `tinglysning`, `forespoerger`, `cvr`

**Why:**

We already have CVR data from Erhvervsstyrelsen — this is Tinglysning's view of a CVR's tinglysningsobjekter (ejendomme, andelsboliger, biler). Used for "show all property owned by CVR X" features.

**Files:**

- Create: `app/lib/tinglysningVirksomhedSoeg.ts`
- Create: `app/api/etl/virksomhed/soeg/route.ts`

**Acceptance criteria:**

- [ ] Input: CVR-nummer (8 digits)
- [ ] Output: list of tinglysningsobjekter (BFE + type + andelsboligforening osv.)
- [ ] Cached 24h (CVR ownership doesn't change rapidly)

**Dependencies:** BIZZ-1500

---

## Anmelder (Phase C — high-risk, feature-flagged)

⚠ Each ticket below produces code that touches **real production legal records**. Feature flag `ENABLE_S2S_ANMELDER` must be OFF by default, ON only in Production after DBA + ARCHITECT review.

---

## BIZZ-1510 — Feature flag `ENABLE_S2S_ANMELDER` + preview-guard middleware

**Type:** Task · **Priority:** High · **Estimate:** 2h · **Labels:** `s2s`, `tinglysning`, `anmelder`, `feature-flag`, `security`

**Files:**

- Create: `app/lib/featureFlags.ts` (if not exists) or extend
- Create: `middleware.ts` rules for `/api/etl/anmeld/*` paths
- Document in: `.env.local.example`

**Implementation:**

```ts
export function isAnmelderEnabled(): boolean {
  // Hard rule: NEVER true on preview, regardless of env-var
  if (process.env.VERCEL_ENV !== 'production') return false;
  return process.env.ENABLE_S2S_ANMELDER === 'true';
}
```

**Middleware addition (`middleware.ts`):**

If request path starts with `/api/etl/anmeld/`:

- If `VERCEL_ENV !== 'production'` → respond 503 `{ error: 'Anmelder kun aktiveret i produktion' }`
- If `process.env.ENABLE_S2S_ANMELDER !== 'true'` → respond 503 `{ error: 'Anmelder ikke aktiveret' }`
- Log every blocked attempt (severity: warn)

**Acceptance criteria:**

- [ ] Function `isAnmelderEnabled()` exported and used by all anmelder routes
- [ ] Middleware blocks at edge before route code runs (defense in depth)
- [ ] Pre-commit hook in `.husky/pre-commit` warns if `ENABLE_S2S_ANMELDER=true` appears in any `.env.*` file in the repo
- [ ] Daily-status cron alerts if flag is ON on preview (paranoid double-check)
- [ ] Tests verify all 3 layers (function, middleware, cron-check) block correctly

**Dependencies:** None

---

## BIZZ-1511 — Verify incoming XML signatures from Tinglysningsretten

**Type:** Task · **Priority:** High · **Estimate:** 6h · **Labels:** `s2s`, `tinglysning`, `security`, `crypto`

**Why:**

Callback endpoints (`/api/etl/svar/*`) receive POSTs from Tinglysningsretten with signed XML. We MUST verify the signature is from Tinglysningsretten's actual OCES cert — otherwise an attacker who knows our callback URLs could forge "svar" messages.

**Files:**

- Add to: `app/lib/s2sClient.ts` — function `verifyXmlSignature(xml: string, trustedCertPem: string): boolean`
- Add: env var `TINGLYSNING_RESPONSE_TRUST_CERT` (PEM of Tinglysningsretten's signing cert — needs to be obtained from them)
- Add: `docs/tinglysning/OBTAIN-RESPONSE-CERT.md` — instructions for getting the trust anchor

**Implementation hints:**

- Use `xml-crypto`'s `SignedXml` class with `loadSignature()` + `checkSignature()`
- Use `KeyInfoProvider` that returns the trusted cert only
- Reject if any `<Reference URI="...">` is anything other than `""` (XSW attack mitigation)
- Reject if the embedded `<X509Certificate>` doesn't byte-match the trust anchor
- Log invalid signatures with severity=warn but never leak the failed XML to logs (potential PII)

**Acceptance criteria:**

- [ ] Returns `true` only when: XMLDSig is valid AND signer matches trust anchor AND no XSW indicators
- [ ] Test fixtures: valid signature, wrong signer, modified body, XSW attack payload, malformed XML
- [ ] Performance: < 100ms per verification
- [ ] Used by ALL `/api/etl/svar/*` routes — extract into shared middleware function

**Dependencies:** BIZZ-1500

---

## BIZZ-1512 — Migration: `tenant.tinglysning_anmeldelse` audit table

**Type:** Task · **Priority:** High · **Estimate:** 3h · **Labels:** `s2s`, `tinglysning`, `anmelder`, `database`, `migration`

**Files:**

- Create migration: `supabase/migrations/XXX_tinglysning_anmeldelse.sql` (use next available number)
- Create: `app/lib/anmeldelseLog.ts` — helper to write entries

**Schema:**

```sql
CREATE TABLE tenant.tinglysning_anmeldelse (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),

  bfe_nummer bigint,
  operation text NOT NULL,                   -- 'DokumentAnmeldelseSvar' etc.

  request_xml text NOT NULL,                 -- full signed XML
  request_hash text NOT NULL,                -- sha256 of signed XML
  message_id text NOT NULL UNIQUE,

  bruger_bekraeftet_kl timestamptz NOT NULL,  -- when user clicked confirm
  bruger_ip inet,                             -- audit only

  status text NOT NULL DEFAULT 'sendt',       -- sendt|modtaget|tinglyst|afvist|fejl
  tinglysning_svar_xml text,
  tinglysning_svar_kl timestamptz,

  fejlkode text,
  fejlbesked text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_anmeldelse_tenant_status ON tenant.tinglysning_anmeldelse(tenant_id, status);
CREATE INDEX idx_anmeldelse_message_id ON tenant.tinglysning_anmeldelse(message_id);
CREATE INDEX idx_anmeldelse_created ON tenant.tinglysning_anmeldelse(created_at DESC);

ALTER TABLE tenant.tinglysning_anmeldelse ENABLE ROW LEVEL SECURITY;

CREATE POLICY anmeldelse_tenant_read ON tenant.tinglysning_anmeldelse
  FOR SELECT USING (
    tenant_id IN (
      SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()
    )
  );

CREATE POLICY anmeldelse_tenant_insert ON tenant.tinglysning_anmeldelse
  FOR INSERT WITH CHECK (
    tenant_id IN (
      SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()
    )
    AND user_id = auth.uid()
  );
```

**Helper (`app/lib/anmeldelseLog.ts`):**

```ts
export async function logAnmeldelse(entry: {
  tenantId: string;
  userId: string;
  bfeNummer?: number;
  operation: string;
  requestXml: string;
  messageId: string;
  brugerIp: string | null;
  brugerBekraeftetKl: Date;
}): Promise<string>; // returns row id

export async function updateAnmeldelseSvar(
  messageId: string,
  update: {
    status: 'modtaget' | 'tinglyst' | 'afvist' | 'fejl';
    svarXml?: string;
    fejlkode?: string;
    fejlbesked?: string;
  }
): Promise<void>;
```

**Retention:**

- 10 years (juridisk krav — this is legal record, not normal log)
- NOT purged by the existing 12-month audit_log cron
- GDPR export MUST include these rows (extend existing export flow)

**Acceptance criteria:**

- [ ] Migration approved by DBA
- [ ] RLS policy tested: user from tenant A cannot read tenant B's anmeldelser
- [ ] Helper functions tested: insert + update happy path + error cases
- [ ] GDPR export extended in `app/api/settings/export/route.ts` (or wherever it lives) to include this table
- [ ] `docs/security/DATA_CLASSIFICATION.md` updated to list this as "Confidential / Legal Record" with 10-year retention

**Dependencies:** None — can run in parallel with other Phase C tickets

---

## BIZZ-1513 — Callback service: AbonnementSvar

**Type:** Task · **Priority:** High · **Estimate:** 3h · **Labels:** `s2s`, `tinglysning`, `anmelder`, `callbacks`

**Why:**

When BizzAssist subscribes to changes on a tinglysningsobjekt (via "follow property"), Tinglysningsretten POSTs change-events to this endpoint. Required by Tinglysningsretten as part of S2S minimum services.

**Files:**

- Create: `app/api/etl/svar/abonnement/route.ts`

**Behavior:**

- `POST /api/etl/svar/abonnement` accepts signed XML from Tinglysning
- Verify signature via `verifyXmlSignature()` (BIZZ-1511)
- Parse the AbonnementSvar XML — extract: objektUuid, ændringType, ændringTid, tenant-id (from `KundereferenceTekst`)
- Persist event to `tenant.foelg_ejendom_event` table (extend or create)
- Respond `200 OK` with empty body (Tinglysningsretten requires this)
- On any failure: respond `500` — Tinglysningsretten will retry per their docs

**Acceptance criteria:**

- [ ] Signature verification is FIRST — before any parsing or DB writes
- [ ] No PII in error responses or logs (per CLAUDE.md)
- [ ] Idempotent: same message-id can be POSTed twice without duplicate events (use UNIQUE constraint)
- [ ] Audit log entry per received message
- [ ] Integration test: replay a recorded prod signed payload, verify event persisted
- [ ] IP whitelist check via `middleware.ts` — only accept POST from Tinglysningsretten's egress IPs (research and document the actual range)

**Dependencies:** BIZZ-1511

---

## BIZZ-1514 — Callback service: BrugerformularSvar

**Type:** Task · **Priority:** High · **Estimate:** 3h · **Labels:** `s2s`, `tinglysning`, `anmelder`, `callbacks`

**Why:**

When a user fills out a tinglysning form via tinglysning.dk (not via our S2S anmeldelse), Tinglysningsretten POSTs the result here so we can mirror it in BizzAssist. Required minimum service.

**Files:**

- Create: `app/api/etl/svar/brugerformular/route.ts`

**Acceptance criteria:**

- Same pattern as BIZZ-1513
- Persist form data to `tenant.tinglysning_brugerformular` (new table — include in BIZZ-1512 migration or follow-up)

**Dependencies:** BIZZ-1511, BIZZ-1512

---

## BIZZ-1515 — Callback service: FejlService (Fejl)

**Type:** Task · **Priority:** High · **Estimate:** 2h · **Labels:** `s2s`, `tinglysning`, `anmelder`, `callbacks`

**Why:**

Tinglysningsretten POSTs structured fault info when one of our requests errored out asynchronously. Required for correct error handling.

**Files:**

- Create: `app/api/etl/svar/fejl/route.ts`

**Acceptance criteria:**

- Same pattern + signature verification + audit
- Updates `tenant.tinglysning_anmeldelse.status='fejl'` for the matching `message_id`
- Sends notification to the tenant-admin user who triggered the request (in-app + email via Resend)

**Dependencies:** BIZZ-1511, BIZZ-1512

---

## BIZZ-1516 — Callback service: UnderskriftmappeSvar

**Type:** Task · **Priority:** High · **Estimate:** 3h · **Labels:** `s2s`, `tinglysning`, `anmelder`, `callbacks`

**Why:**

Tinglysningsretten notifies us when a document needs (or has received) a digital signature in the user's "underskriftmappe". Required minimum service.

**Files:**

- Create: `app/api/etl/svar/underskriftmappe/route.ts`

**Acceptance criteria:**

- Same pattern + signature + audit
- Notifies the relevant user (in-app + email)
- Updates anmeldelse status accordingly

**Dependencies:** BIZZ-1511, BIZZ-1512

---

## BIZZ-1517 — `DokumentAnmeldelseSvar` for fast ejendom

**Type:** Task · **Priority:** High · **Estimate:** 10h · **Labels:** `s2s`, `tinglysning`, `anmelder`

**⚠ CRITICAL:** This is the first endpoint that creates real legal tinglysninger. Default OFF until DBA + ARCHITECT approve.

**Files:**

- Create: `app/lib/tinglysningAnmeldelse.ts`
- Create: `app/api/etl/anmeld/fast-ejendom/route.ts`

**Public API:**

```ts
export interface AnmeldelseInput {
  tenantId: string;
  userId: string;
  bfeNummer: number;
  dokumentType: 'SKOEDE' | 'EJERPANT' | 'SERVITUT' | 'PAATEGNING'; // initial scope
  dokumentIndhold: Buffer; // the PDF or XML payload
  signaturer: Array<{ cpr: string; navn: string; underskrevet: boolean }>;
  /** must match the value the user typed in confirm step */
  bekraefelseTekst: string;
}

export interface AnmeldelseResultat {
  success: boolean;
  messageId: string;
  fejlkode?: string;
  fejlbesked?: string;
}

export async function sendAnmeldelse(input: AnmeldelseInput): Promise<AnmeldelseResultat>;
```

**Implementation requirements:**

1. Check `isAnmelderEnabled()` first (BIZZ-1510) — refuse if false
2. Verify `bekraefelseTekst === 'JA OPRET TINGLYSNING'` exactly (case-sensitive)
3. Look up matrikel via existing helper
4. Build DokumentAnmeldelse XML per WSDL operation
5. Sign with `signXmlBody()` (BIZZ-1500)
6. Log to `tenant.tinglysning_anmeldelse` BEFORE sending (status='sendt', request_xml=signed)
7. POST via proxy
8. Update anmeldelse row with synchronous response (status, fejlkode if any)
9. Return `AnmeldelseResultat`
10. Async svar arrives later via `/api/etl/svar/*` callback

**API route:**

- `POST /api/etl/anmeld/fast-ejendom`
- `resolveTenantId()` + verify user has `anmelder` role (new permission)
- Rate limit: 5/hour/tenant (anmeldelser are heavy, slow, and high-risk)
- Audit log with full context
- All errors return `'Ekstern API fejl'` to client — full detail only in audit log

**Acceptance criteria:**

- [ ] All preconditions verified before signing/sending
- [ ] Audit row created BEFORE send (so we know what we tried even on crash)
- [ ] Cannot be called from preview env (BIZZ-1510 middleware)
- [ ] Cannot be called without `anmelder` role
- [ ] Cannot be called without exact confirm text
- [ ] E2E test: mock Tinglysning, verify full happy-path + failure-path
- [ ] **NO production test possible** — only integration test against test miljø IF ever set up. Document this in PR description.

**Dependencies:** BIZZ-1500, 1510, 1511, 1512

---

## BIZZ-1518 — UI: Multi-step "preview → confirm → sign → submit" flow

**Type:** Story · **Priority:** High · **Estimate:** 12h · **Labels:** `s2s`, `tinglysning`, `anmelder`, `frontend`, `ui`

**Why:**

Make it extremely hard for a user to accidentally create a real tinglysning. The user MUST go through 4 explicit steps with friction.

**Files:**

- Create: `app/dashboard/anmeldelse/[bfe]/page.tsx` (entry point)
- Create: `app/dashboard/anmeldelse/[bfe]/preview/page.tsx`
- Create: `app/dashboard/anmeldelse/[bfe]/confirm/page.tsx`
- Create: `app/dashboard/anmeldelse/[bfe]/submit/page.tsx`
- Create: `app/dashboard/anmeldelse/[bfe]/status/[id]/page.tsx`

**Steps:**

1. **Entry** — pick document type, upload PDF, fill metadata. Save draft to local state (NOT to DB yet).
2. **Preview** — show full summary: BFE + adresse, dokumenttype, gebyrer (look up from Tinglysningsretten's gebyrtabel), signaturer required. User clicks "Fortsæt".
3. **Confirm** — show LARGE warning text: "Dette opretter en juridisk gyldig tinglysning og kan ikke fortrydes uden ny anmeldelse." User must:
   - Tick a checkbox "Jeg har læst og forstået"
   - Type the exact phrase `JA OPRET TINGLYSNING` into a text input
   - Click "Indsend nu" button (disabled until both above are done)
4. **Submit** — show loading state, call `POST /api/etl/anmeld/fast-ejendom`, on success redirect to `/status/<id>`
5. **Status** — polls `/api/etl/anmeld/status/<id>` every 5s, shows "Sendt → Modtaget → Tinglyst" timeline. On callback completion (from BIZZ-1513-1516), final state is shown.

**Acceptance criteria:**

- [ ] All 4 steps obligatoriske — direct URL access to step 3/4/5 redirects back to step 1 if state missing
- [ ] WCAG AA per CLAUDE.md:
  - All steps as proper `<main>` with `<h1>` for screen readers
  - Step 3 confirm modal: `role="dialog"`, `aria-modal="true"`, focus-trap, ESC closes (with confirmation)
  - All buttons keyboard accessible
  - Skip-to-main-content link
- [ ] Dark theme per CLAUDE.md (no white backgrounds)
- [ ] Bilingual (DA + EN) — all strings in `app/lib/translations.ts`
- [ ] E2E test (Playwright): full happy path + several failure paths (back button, page reload mid-flow, wrong confirm text)
- [ ] Mobile-ready layout (per CLAUDE.md future React Native port)

**Dependencies:** BIZZ-1517

---

## BIZZ-1519 — Migrate existing tinglysning routes from REST to XML S2S

**Type:** Story · **Priority:** Medium · **Estimate:** 8h · **Labels:** `s2s`, `tinglysning`, `migration`

**Why:**

HTTP REST API udgår 2026-09-18. We have 4 months. Once Phase B (BIZZ-1501..1509) is done, migrate `/api/tinglysning/*` routes one by one to use XML S2S as primary, REST as fallback.

**Affected routes:**

- `/api/tinglysning/route.ts` — main combined endpoint
- `/api/tinglysning/aendringer/route.ts`
- `/api/tinglysning/dokument/route.ts`
- `/api/tinglysning/paategning/route.ts`
- `/api/tinglysning/praesentation/route.ts`
- `/api/tinglysning/summarisk/route.ts` (already in progress via BIZZ-1504)
- `/api/tinglysning/virksomhed/route.ts`
- `/api/tinglysning/andelsbog/route.ts` (REST → S2S not yet planned — andelsbog scope decision pending)
- `/api/tinglysning/bilbog/route.ts` (same — out of scope until decided)
- `/api/tinglysning/personbog/route.ts` (same)

**Migration pattern per route:**

1. Add env flag `TINGLYSNING_<ROUTE>_USE_XML=true|false`
2. When ON: try XML helper first, fall back to REST on error + log warning
3. Compare data shape — emit metric if XML returns different fields (data-quality check)
4. After 2 weeks of stable XML in production: flip default to ON
5. After 4 weeks: remove REST fallback

**Acceptance criteria:**

- [ ] All ejendom-related routes migrated (10 minimum — andels/bil/personbog out of scope)
- [ ] Zero downtime — feature flags allow gradual cutover
- [ ] Data-quality dashboard: count of routes where XML and REST disagree per day
- [ ] All consumers of `/api/tinglysning/*` work identically (no breaking changes)

**Dependencies:** BIZZ-1501 through BIZZ-1509 done

---

## Cross-cutting tickets

### BIZZ-1520 — Test infrastructure for S2S

**Type:** Task · **Priority:** High · **Estimate:** 4h · **Labels:** `s2s`, `tinglysning`, `tests`, `infrastructure`

**Files:**

- Create: `__tests__/fixtures/etl/` — directory for recorded XML responses
- Create: `__tests__/integration/s2s-roundtrip.test.ts` — runs against prod with safe BFE (read-only)
- Create: `scripts/record-etl-fixture.mjs` — script that records a real prod response and saves anonymized version as fixture
- Modify: `__tests__/setup.ts` — mock S2S helpers by default in unit tests

**Acceptance criteria:**

- [ ] Recorded fixtures for: EjendomAdkomsterHent, ServitutterHent, HaeftelserHent, SummariskHent, IndskannetAkt (PDF), SenesteAendring, AendredeObjekter, EjendomSoeg
- [ ] All sensitive fields (CPR, name, address) anonymized in fixtures
- [ ] Integration test runs in CI but skipped by default (env flag `RUN_S2S_INTEGRATION=true`)
- [ ] Coverage on `app/lib/tinglysning*.ts` files ≥ 80%

**Dependencies:** BIZZ-1500

---

## Total estimat

| Fase                                     | Tickets | Estimat   |
| ---------------------------------------- | ------- | --------- |
| Refactor (BIZZ-1500)                     | 1       | 6h        |
| Forespørger operations (BIZZ-1501..1509) | 9       | 38h       |
| Anmelder + callbacks (BIZZ-1510..1518)   | 9       | 44h       |
| Migration + tests (BIZZ-1519..1520)      | 2       | 12h       |
| **Total**                                | **21**  | **~100h** |

**Already done (skip — for the coding agent's reference):**

- ✅ BIZZ-1494: EjendomHistoriskAdkomsterHent (in `app/lib/tinglysningHistoriskAdkomster.ts`)
- ✅ BIZZ-1462: Cache-first for `/api/tinglysning/summarisk` REST endpoint
- ✅ BIZZ-1496: Backfill-cron proxy headers fix

---

## For the coding agent — execution order

**Start here:**

1. BIZZ-1500 (refactor — unblocks everything)
2. BIZZ-1501, 1502, 1503 in parallel (3 similar forespørger operations using same helper)
3. BIZZ-1504, 1505, 1506, 1507 (more forespørger — order doesn't matter much)
4. BIZZ-1508, 1509 (search operations)
5. BIZZ-1520 (test infrastructure — can start earlier in parallel)

**Then high-risk anmelder track (do NOT start until forespørger is stable in prod):**

6. BIZZ-1510 (feature flag — safety first)
7. BIZZ-1511, 1512 in parallel (signature verify + DB migration)
8. BIZZ-1513, 1514, 1515, 1516 (callbacks — parallel after 1511+1512)
9. BIZZ-1517 (the actual anmeldelse)
10. BIZZ-1518 (UI)

**Finally migration:**

11. BIZZ-1519 (only after all of Phase B is in prod for 2 weeks)

---

## JIRA CSV import

See `BIZZ-9XX-s2s-tickets-v2.csv` in the same folder for bulk import.
