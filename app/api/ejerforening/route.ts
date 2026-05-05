/**
 * GET /api/ejerforening?vejnavn=X&husnr=Y&postnr=Z
 *
 * BIZZ-966: Finder ejerforening (HOA) for en ejendomsadresse via CVR ES.
 * Søger efter virksomheder med branchekode 683220 (Ejerforeninger)
 * på matchende adresse.
 *
 * @param vejnavn - Vejnavn (fx "Arnold Nielsens Boulevard")
 * @param husnr - Husnummer (fx "62A")
 * @param postnr - Postnummer (fx "2650")
 * @returns Ejerforenings-data med CVR, navn, bestyrelse
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { parseQuery } from '@/app/lib/validate';
import { resolveTenantId } from '@/lib/api/auth';
import { logger } from '@/app/lib/logger';

export const runtime = 'nodejs';

const querySchema = z.object({
  vejnavn: z.string().min(2).max(200),
  husnr: z.string().max(10).optional(),
  postnr: z
    .string()
    .regex(/^\d{4}$/)
    .optional(),
});

const CVR_ES_BASE = 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search';
const CVR_ES_USER = process.env.CVR_ES_USER ?? '';
const CVR_ES_PASS = process.env.CVR_ES_PASS ?? '';

/** Ejerforenings-respons. */
export interface EjerforeningData {
  cvr: number;
  navn: string;
  adresse: string | null;
  postnr: string | null;
  by: string | null;
  stiftet: string | null;
  status: string | null;
  formand: string | null;
  bestyrelse: Array<{ navn: string; rolle: string }>;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await resolveTenantId();
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const parsed = parseQuery(req, querySchema);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ugyldige parametre' }, { status: 400 });
  }

  if (!CVR_ES_USER || !CVR_ES_PASS) {
    return NextResponse.json({ error: 'CVR ES ikke konfigureret' }, { status: 503 });
  }

  const { vejnavn, husnr, postnr } = parsed.data;

  // Søg CVR ES for ejerforeninger (branchekode 683220) på matchende adresse.
  // BIZZ-1148: Inkluder husnummer i søgningen for at undgå forkerte matches
  // fra andre husnumre på samme vej.
  const must: Record<string, unknown>[] = [
    {
      term: {
        'Vrvirksomhed.virksomhedMetadata.nyesteHovedbranche.branchekode': 683220,
      },
    },
    {
      match_phrase: {
        'Vrvirksomhed.beliggenhedsadresse.vejnavn': vejnavn,
      },
    },
  ];

  // BIZZ-1148: husnr filtreres post-query (CVR ES har husnummerFra/Til interval)

  if (postnr) {
    must.push({
      term: { 'Vrvirksomhed.beliggenhedsadresse.postnummer': parseInt(postnr, 10) },
    });
  }

  try {
    const esAuth = Buffer.from(`${CVR_ES_USER}:${CVR_ES_PASS}`).toString('base64');
    const res = await fetch(CVR_ES_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${esAuth}`,
      },
      body: JSON.stringify({
        size: 5,
        query: { bool: { must } },
        _source: [
          'Vrvirksomhed.cvrNummer',
          'Vrvirksomhed.virksomhedMetadata.nyesteNavn.navn',
          'Vrvirksomhed.virksomhedMetadata.nyesteStatus',
          'Vrvirksomhed.beliggenhedsadresse',
          'Vrvirksomhed.stiftelsesDato',
          'Vrvirksomhed.deltagerRelation',
        ],
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      logger.warn(`[ejerforening] CVR ES fejlede: ${res.status}`);
      return NextResponse.json({ foreninger: [] });
    }

    const data = await res.json();
    const hits = data.hits?.hits ?? [];

    const foreninger: EjerforeningData[] = hits
      .map((hit: { _source?: { Vrvirksomhed?: Record<string, unknown> } }) => {
        const vrk = hit._source?.Vrvirksomhed as Record<string, unknown> | undefined;
        if (!vrk) return null;

        const meta = vrk.virksomhedMetadata as Record<string, unknown> | undefined;
        const adr = Array.isArray(vrk.beliggenhedsadresse)
          ? (vrk.beliggenhedsadresse as Record<string, unknown>[])[0]
          : null;

        // Bestyrelse fra deltagerRelation
        const relationer = Array.isArray(vrk.deltagerRelation)
          ? (vrk.deltagerRelation as Record<string, unknown>[])
          : [];
        const bestyrelse: Array<{ navn: string; rolle: string }> = [];
        let formand: string | null = null;

        for (const rel of relationer) {
          const deltager = rel.deltager as Record<string, unknown> | undefined;
          if (!deltager) continue;
          const navne = Array.isArray(deltager.navne)
            ? (deltager.navne as Array<{ navn?: string }>)
            : [];
          const navn = navne[navne.length - 1]?.navn ?? null;
          if (!navn) continue;

          const orgs = Array.isArray(rel.organisationer)
            ? (rel.organisationer as Record<string, unknown>[])
            : [];
          for (const o of orgs) {
            const orgNavne = Array.isArray(o.organisationsNavn)
              ? (o.organisationsNavn as Array<{ navn?: string }>)
              : [];
            const orgNavn = orgNavne[orgNavne.length - 1]?.navn ?? '';
            if (orgNavn.toUpperCase().includes('BESTYRELSE')) {
              bestyrelse.push({ navn, rolle: 'Bestyrelsesmedlem' });
              // Tjek for formand via FUNKTION-attribut
              const medlemsData = Array.isArray(o.medlemsData)
                ? (o.medlemsData as Record<string, unknown>[])
                : [];
              for (const md of medlemsData) {
                const attrs = Array.isArray(md.attributter)
                  ? (md.attributter as Record<string, unknown>[])
                  : [];
                for (const attr of attrs) {
                  if (attr.type === 'FUNKTION') {
                    const vaerdier = Array.isArray(attr.vaerdier)
                      ? (attr.vaerdier as Array<{ vaerdi?: string }>)
                      : [];
                    const funktion = vaerdier[vaerdier.length - 1]?.vaerdi ?? '';
                    if (funktion.toUpperCase().includes('FORMAND')) {
                      formand = navn;
                      bestyrelse[bestyrelse.length - 1].rolle = 'Formand';
                    }
                  }
                }
              }
            }
          }
        }

        return {
          cvr: vrk.cvrNummer as number,
          navn: ((meta?.nyesteNavn as Record<string, unknown>)?.navn as string) ?? 'Ukendt',
          adresse: adr ? `${adr.vejnavn ?? ''} ${adr.husnummerFra ?? ''}`.trim() : null,
          postnr: adr?.postnummer ? String(adr.postnummer) : null,
          by: (adr?.postdistrikt as string) ?? null,
          stiftet: (vrk.stiftelsesDato as string) ?? null,
          status: ((meta?.nyesteStatus as Record<string, unknown>)?.status as string) ?? null,
          formand,
          bestyrelse: bestyrelse.slice(0, 10),
        };
      })
      .filter(Boolean);

    // BIZZ-1148: Filtrer på husnummer post-query for at fjerne foreninger
    // der er på samme vej men anden adresse. CVR ES har husnummerFra/Til
    // interval, så vi tjekker om ejendommens husnr falder indenfor.
    const filtered = husnr
      ? foreninger.filter((f: EjerforeningData) => {
          if (!f.adresse) return false;
          // Ekstraher husnr fra ejerforeningens adresse
          const fHusnrMatch = f.adresse.match(/(\d+)/);
          if (!fHusnrMatch) return false;
          const fHusnr = parseInt(fHusnrMatch[1], 10);
          const ejdHusnr = parseInt(husnr, 10);
          if (isNaN(fHusnr) || isNaN(ejdHusnr)) return false;
          // Accepter match indenfor ±10 husnumre (ejerforeninger dækker typisk et interval)
          return Math.abs(fHusnr - ejdHusnr) <= 10;
        })
      : foreninger;

    return NextResponse.json(
      { foreninger: filtered },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=7200' } }
    );
  } catch (err) {
    logger.warn('[ejerforening] fejl:', err instanceof Error ? err.message : err);
    return NextResponse.json({ foreninger: [] });
  }
}
