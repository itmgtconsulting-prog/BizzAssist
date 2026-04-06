/**
 * POST /api/ai/person-search/contacts
 *
 * Split-endpoint til progressiv loading — søger KUN kontaktoplysninger for en dansk person.
 * Del af parallelt søge-flow: kald dette endpoint sideløbende med /socials og /articles.
 *
 * Strategi:
 * 1. Brave Search — kontaktrelevante queries (3 primære + evt. virksomheds-kryds, inkl. krak.dk/118.dk)
 * 2. Claude (Haiku — hurtigere/billigere for fokuseret ekstraktion) — udtrækker adresse, telefon, email
 * 3. Sekundær telefon-søgning hvis adresse fundet men ingen telefon
 *
 * @param body.personName   - Personens fulde navn
 * @param body.companies    - Tilknyttede virksomheder (valgfrit)
 * @param body.city         - By (valgfrit, til disambiguation)
 * @returns { contacts, tokensUsed }
 */

import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { checkRateLimit, braveRateLimit } from '@/app/lib/rateLimit';
import { withBraveCache } from '@/app/lib/searchCache';
import { createClient as createServerClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const maxDuration = 60;

// ─── Types ────────────────────────────────────────────────────────────────────

/** Et Brave Search web-resultat (råformat) */
interface BraveWebResult {
  title: string;
  url: string;
  description?: string;
  age?: string;
  meta_url?: { hostname?: string };
}

/** En kontaktoplysning fundet via AI */
interface ContactResult {
  address?: string;
  phone?: string;
  email?: string;
  source: string;
  sourceUrl: string;
  confidence: number;
  reason?: string;
}

/** Et Brave-resultat som artikel */
interface ArticleResult {
  title: string;
  url: string;
  source: string;
  description?: string;
  date?: string;
}

/** Input-format */
interface PersonInput {
  personName: string;
  companies?: Array<{ cvr: number | string; name: string; role?: string }>;
  city?: string;
}

// ─── Brave Search ─────────────────────────────────────────────────────────────

/**
 * Søger via Brave Search API — ekskluder-filter spring over (krak.dk er relevant for kontaktdata).
 *
 * @param key   - Brave Search Subscription Token
 * @param query - Søgeforespørgsel
 * @param count - Antal resultater
 */
async function searchBrave(key: string, query: string, count = 5): Promise<ArticleResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&country=dk`;
  const res = await fetch(url, {
    headers: { 'X-Subscription-Token': key, Accept: 'application/json' },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const raw: BraveWebResult[] = data.web?.results ?? [];
  const seen = new Set<string>();
  return raw
    .filter((r) => {
      if (!r.url || seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    })
    .map((r) => ({
      title: r.title?.trim() ?? '',
      url: r.url?.trim() ?? '',
      source: r.meta_url?.hostname?.replace(/^www\./, '').trim() ?? '',
      description: r.description?.trim().slice(0, 150) ?? undefined,
    }))
    .filter((r) => r.title && r.url);
}

/**
 * Rolleprioritet til sortering af virksomheder.
 *
 * @param role - Rollebetegnelse
 */
function rolePriority(role?: string): number {
  if (!role) return 99;
  const r = role.toLowerCase();
  if (r.includes('direktør') || r.includes('ceo')) return 1;
  if (r.includes('bestyrelsesformand')) return 2;
  if (r.includes('bestyrelsesmedlem')) return 3;
  return 4;
}

/**
 * Søger kontaktoplysninger for en person via Brave Search.
 * Domæne-ekskludering springes over — krak.dk/118.dk er relevante for kontaktdata.
 *
 * @param key        - Brave Search Subscription Token
 * @param personName - Personens fulde navn
 * @param city       - By (valgfrit)
 * @param companies  - Tilknyttede virksomheder (valgfrit)
 */
async function searchBravePersonContacts(
  key: string,
  personName: string,
  city?: string,
  companies?: Array<{ cvr: number | string; name: string; role?: string }>
): Promise<ArticleResult[]> {
  const queries: string[] = [
    city ? `"${personName}" ${city} adresse telefon` : `"${personName}" adresse telefon`,
    `"${personName}" site:krak.dk`,
  ];

  if (companies && companies.length > 0) {
    const topCompany = [...companies].sort(
      (a, b) => rolePriority(a.role) - rolePriority(b.role)
    )[0];
    queries.push(`"${personName}" "${topCompany.name}"`);
  } else {
    queries.push(`"${personName}" site:118.dk`);
  }

  const results = await Promise.allSettled(queries.map((q) => searchBrave(key, q, 5)));

  const all: ArticleResult[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const item of r.value) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          all.push(item);
        }
      }
    }
  }

  // personName omitted from log — PII
  return all;
}

/**
 * Sekundær telefonnummer-søgning — køres KUN hvis primær søgning fandt adresse men ikke telefon.
 *
 * @param key        - Brave Search Subscription Token
 * @param personName - Personens fulde navn
 * @param city       - By (valgfrit)
 * @param companies  - Tilknyttede virksomheder
 */
async function searchBravePersonPhone(
  key: string,
  personName: string,
  city?: string,
  companies?: Array<{ cvr: number | string; name: string }>
): Promise<ArticleResult[]> {
  const queries: string[] = [
    city ? `"${personName}" telefon ${city}` : `"${personName}" telefon`,
    `"${personName}" site:krak.dk`,
    `"${personName}" site:118.dk`,
  ];
  for (const c of (companies ?? []).slice(0, 3)) {
    queries.push(`"${c.name}" kontakt telefon`);
  }

  const results = await Promise.allSettled(queries.map((q) => searchBrave(key, q, 5)));
  const all: ArticleResult[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const item of r.value) {
        if (!seen.has(item.url)) {
          seen.add(item.url);
          all.push(item);
        }
      }
    }
  }
  return all;
}

// ─── System prompts ───────────────────────────────────────────────────────────

/**
 * System prompt til kontakt-ekstraktion.
 *
 * @returns Komplet system prompt til Claude
 */
function buildContactsSystemPrompt(): string {
  return `Du er en dansk assistent. Du udtrækker kontaktoplysninger (adresse, telefon, email) fra søgeresultater om en specifik dansk person.

For hvert søgeresultat der specifikt handler om DENNE person: udtrék adresse, telefon og/eller email.
Angiv kilde-URL og confidence (0-100) baseret på navnematch og kontekst.

Returner KUN validt JSON uden tekst før/efter:

{
  "contacts": [
    {
      "address": "Strandvejen 42, 2900 Hellerup",
      "phone": "+45 12 34 56 78",
      "email": "navn@example.dk",
      "source": "krak.dk",
      "sourceUrl": "https://krak.dk/...",
      "confidence": 85,
      "reason": "Navn og by matcher"
    }
  ]
}

Regler:
- Returner altid "contacts"-arrayet (kan være [])
- address, phone og email er alle valgfrie — inkludér kun hvad der er tilgængeligt
- source skal være domænenavnet (f.eks. "krak.dk")
- sourceUrl skal være den præcise URL fra søgeresultatet
- Opfind IKKE oplysninger — brug kun hvad søgeresultaterne faktisk viser
- Inkludér KUN resultater der specifikt matcher denne person`;
}

/**
 * Bygger system prompt til sekundær telefon-søgning.
 *
 * @returns System prompt til Claude Haiku
 */
function buildPhoneSystemPrompt(): string {
  return `Du er en dansk assistent. Find telefonnummer(e) for en specifik dansk person i disse søgeresultater.
Returner KUN validt JSON: { "phone": "+45 12 34 56 78" } eller { "phone": null } hvis intet fundet.`;
}

// ─── Response parser ──────────────────────────────────────────────────────────

/**
 * Validerer at en streng er en gyldig URL.
 *
 * @param url - URL der skal valideres
 */
function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return url.startsWith('https://') || url.startsWith('http://');
  } catch {
    return false;
  }
}

/**
 * Parser Claude's JSON-svar — udtrækker kun kontaktoplysninger.
 *
 * @param text - Rå tekstsvar fra Claude
 */
function parseContactsResponse(text: string): ContactResult[] {
  try {
    const jsonMatch =
      text.match(/```json\s*([\s\S]*?)\s*```/) ??
      text.match(/```\s*([\s\S]*?)\s*```/) ??
      text.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) return [];

    const raw = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
    const rawContacts: unknown[] = Array.isArray(raw.contacts) ? raw.contacts : [];

    return rawContacts
      .filter(
        (c): c is Record<string, unknown> =>
          typeof c === 'object' &&
          c !== null &&
          typeof (c as Record<string, unknown>).sourceUrl === 'string'
      )
      .map((c) => ({
        address: typeof c.address === 'string' ? c.address.trim() : undefined,
        phone: typeof c.phone === 'string' ? c.phone.trim() : undefined,
        email: typeof c.email === 'string' ? c.email.trim() : undefined,
        source: typeof c.source === 'string' ? c.source.trim() : 'Ukendt kilde',
        sourceUrl: String(c.sourceUrl).trim(),
        confidence:
          typeof c.confidence === 'number'
            ? Math.max(0, Math.min(100, Math.round(c.confidence)))
            : 50,
        reason: typeof c.reason === 'string' ? c.reason.trim() : undefined,
      }))
      .filter((c) => isValidUrl(c.sourceUrl) && (c.address || c.phone || c.email));
  } catch {
    return [];
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * POST /api/ai/person-search/contacts
 * Søger og udtrækker kontaktoplysninger for en person via Brave Search + Claude.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const limited = await checkRateLimit(request, braveRateLimit);
  if (limited) return limited;

  // Require an authenticated session
  const supabase = await createServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey)
    return NextResponse.json({ error: 'BIZZASSIST_CLAUDE_KEY ikke konfigureret' }, { status: 500 });

  const braveKey = process.env.BRAVE_SEARCH_API_KEY?.trim();
  if (!braveKey)
    return NextResponse.json({ error: 'BRAVE_SEARCH_API_KEY ikke konfigureret' }, { status: 500 });

  let body: PersonInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { personName, companies = [], city } = body;
  if (!personName?.trim())
    return NextResponse.json({ error: 'personName er påkrævet' }, { status: 400 });

  // ── Brave-søgning ──
  // Brave contact results cached 24h in Supabase search_cache to reduce API usage.
  let braveContactResults: ArticleResult[];
  try {
    braveContactResults = await withBraveCache(
      `ps_contacts|${personName.toLowerCase()}|${city ?? ''}`,
      () => searchBravePersonContacts(braveKey, personName, city, companies)
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Brave Search fejl';
    return NextResponse.json({ error: `Søgning fejlede: ${msg}` }, { status: 502 });
  }

  // ── Byg Claude-besked ──
  const personContext = [
    `Personens fulde navn: ${personName}`,
    city ? `By: ${city}` : null,
    companies.length > 0
      ? `Virksomheder: ${companies
          .slice(0, 3)
          .map((c) => `${c.name} (CVR ${c.cvr})`)
          .join(', ')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  const contactSummary =
    braveContactResults.length > 0
      ? braveContactResults
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Kilde: ${r.source}${r.description ? `\n   Snippet: ${r.description}` : ''}`
          )
          .join('\n\n')
      : '(Ingen kontakt-resultater fundet)';

  const userMessage = `Person:\n${personContext}\n\nSøgeresultater til kontakt-ekstraktion (${braveContactResults.length} hits):\n\n${contactSummary}\n\nUdtrék kontaktoplysninger (adresse, telefon, email) der specifikt tilhører DENNE person.`;

  // ── Kald Claude Haiku (hurtigere/billigere til fokuseret ekstraktion) ──
  const client = new Anthropic({ apiKey });
  let contacts: ContactResult[] = [];
  let totalTokens = 0;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: buildContactsSystemPrompt(),
      messages: [{ role: 'user', content: userMessage }],
    });

    totalTokens = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
    const finalText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    contacts = parseContactsResponse(finalText);
    // personName omitted from log — PII
  } catch (err) {
    console.error('[person-search/contacts] Claude fejl:', err);
    // Returner tomt resultat frem for fejl — kontakter er nice-to-have
    return NextResponse.json({ contacts: [], tokensUsed: 0, source: 'brave+claude' });
  }

  // ── Sekundær telefon-søgning hvis adresse fundet men ikke telefon ──
  const hasPhone = contacts.some((c) => c.phone);
  const hasAddress = contacts.some((c) => c.address);

  if (!hasPhone && hasAddress) {
    try {
      const extraResults = await searchBravePersonPhone(braveKey, personName, city, companies);
      if (extraResults.length > 0) {
        const existingAddress = contacts.find((c) => c.address)?.address ?? '';
        const extraSummary = extraResults
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n   URL: ${r.url}${r.description ? `\n   Snippet: ${r.description}` : ''}`
          )
          .join('\n\n');

        const phoneResponse = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 256,
          messages: [
            {
              role: 'user',
              content: `Find telefonnummer for ${personName} (bor på ${existingAddress}) i disse søgeresultater:\n\n${extraSummary}\n\nReturner KUN JSON: { "phone": "+45 XX XX XX XX" } eller { "phone": null }`,
            },
          ],
          system: buildPhoneSystemPrompt(),
        });

        totalTokens +=
          (phoneResponse.usage?.input_tokens ?? 0) + (phoneResponse.usage?.output_tokens ?? 0);
        const phoneText = phoneResponse.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');

        const phoneMatch =
          phoneText.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? phoneText.match(/(\{[\s\S]*\})/);
        if (phoneMatch) {
          const phoneJson = JSON.parse(phoneMatch[1] ?? phoneMatch[0]);
          if (typeof phoneJson.phone === 'string' && phoneJson.phone.trim()) {
            // Tilføj telefonnummer til første kontakt med adresse
            const idx = contacts.findIndex((c) => c.address);
            if (idx >= 0) {
              // Phone number and personName omitted from log — PII
              contacts[idx] = { ...contacts[idx], phone: phoneJson.phone.trim() };
            }
          }
        }
      }
    } catch {
      // Ignorer fejl i sekundær søgning
    }
  }

  return NextResponse.json({ contacts, tokensUsed: totalTokens, source: 'brave+claude' });
}
