/**
 * GET /api/cvr-public/person/raw?enhedsNummer=4000115446
 *
 * Diagnostisk endpoint der returnerer det rå CVR ES-svar for en deltager så
 * vi kan se hvilke felter (specielt foedselsdato) der er tilgængelige.
 * Bruges til at bygge bro mellem CVR ES-person og EJF-ejer.
 */

import { NextRequest, NextResponse } from 'next/server';
import { resolveTenantId } from '@/lib/api/auth';

export const runtime = 'nodejs';
export const maxDuration = 30;

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent';
const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';

export async function GET(req: NextRequest) {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const enhedsNr = req.nextUrl.searchParams.get('enhedsNummer');
  if (!enhedsNr || !/^\d+$/.test(enhedsNr)) {
    return NextResponse.json({ error: 'enhedsNummer required' }, { status: 400 });
  }

  if (!CVR_ES_USER || !CVR_ES_PASS) {
    return NextResponse.json({ error: 'CVR ES creds missing' }, { status: 503 });
  }

  const basic = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');

  // Prøv flere endpoints / queries for at finde foedselsdato
  const probes: Array<{ name: string; url: string; body?: unknown }> = [
    {
      name: 'deltager_by_enhedsNummer',
      url: `${CVR_ES_BASE}/deltager/_search`,
      body: {
        query: {
          bool: {
            must: [{ term: { 'Vrdeltagerperson.enhedsNummer': Number(enhedsNr) } }],
          },
        },
        size: 1,
      },
    },
    {
      name: 'deltager_full_source',
      url: `${CVR_ES_BASE}/deltager/_search`,
      body: {
        query: {
          bool: {
            must: [{ term: { 'Vrdeltagerperson.enhedsNummer': Number(enhedsNr) } }],
          },
        },
        _source: true,
        size: 1,
      },
    },
  ];

  const results: Record<string, unknown> = {};
  for (const p of probes) {
    try {
      const res = await fetch(p.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${basic}`,
        },
        body: JSON.stringify(p.body),
        signal: AbortSignal.timeout(10000),
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = `<non-json, ${text.length} chars>`;
      }
      // Strip ballast men behold source-felterne
      if (
        parsed &&
        typeof parsed === 'object' &&
        'hits' in parsed &&
        (parsed as { hits?: { hits?: unknown[] } }).hits?.hits
      ) {
        const hits = (parsed as { hits: { hits: Array<{ _source?: unknown }> } }).hits.hits;
        results[p.name] = {
          status: res.status,
          hitCount: hits.length,
          firstHitKeys:
            hits[0]?._source && typeof hits[0]._source === 'object'
              ? Object.keys(hits[0]._source as object)
              : null,
          firstHitSource: hits[0]?._source ?? null,
        };
      } else {
        results[p.name] = { status: res.status, parsed };
      }
    } catch (err) {
      results[p.name] = { error: err instanceof Error ? err.message : String(err) };
    }
  }

  return NextResponse.json(
    { enhedsNummer: enhedsNr, results },
    { status: 200, headers: { 'Cache-Control': 'no-store' } }
  );
}
