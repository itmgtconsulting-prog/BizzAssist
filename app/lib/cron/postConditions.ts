/**
 * Per-job output-korrektheds-checks (post-conditions) — BIZZ-2239.
 *
 * Nogle jobs rapporterer success men producerer brudt output (fx sitemap-huller,
 * BIZZ-2235/2268). Heartbeats fanger "koerte den?", freshness fanger "er data
 * friske?" — men INGEN af dem fanger "er outputtet korrekt formet?". Dette modul
 * tilfoejer lette post-condition-assertions pr. job som service-scan koerer efter
 * kernescannet (BIZZ-2237), saa brudt output ogsaa bliver til en ScanIssue.
 *
 * Generisk hook: registrér en check pr. jobName i POST_CONDITIONS. Hver check er
 * billig (én-to queries) og returnerer {ok, message}. runPostConditions() koerer
 * dem alle og fanger fejl pr. check (én daarlig check vaelter ikke de andre).
 */
import { createAdminClient } from '@/lib/supabase/admin';

/** Resultat af en enkelt post-condition-check. */
export interface PostConditionResult {
  ok: boolean;
  /** Menneskelaesbar forklaring (vises i ScanIssue.context ved fejl). */
  message: string;
}

/** En post-condition-check for et job. Skal vaere billig + side-effekt-fri. */
export type PostConditionCheck = () => Promise<PostConditionResult>;

/** URL'er pr. sitemap-side (Googles haardkodede grand — matcher generate-sitemap PAGE_SIZE). */
const SITEMAP_PAGE_SIZE = 50_000;
/** Antal statiske sider der lagt oveni entry-tallet paa side 0 (matcher sitemap.xml-route). */
const SITEMAP_STATIC_COUNT = 4;

/**
 * Sitemap-kontinuitet (BIZZ-2239/2235): sitemap_xml_cache.page_id SKAL vaere
 * kontinuerte 0..N-1 uden huller, OG N SKAL vaere ceil((entries+static)/50000).
 * Huller eller forkert sidetal betyder at Googles crawler faar 404/manglende
 * URL'er (SEO-tab), selv om generate-sitemap rapporterede success.
 *
 * @returns ok=false med detaljer hvis der er huller eller sidetals-mismatch
 */
export async function checkSitemapContinuity(): Promise<PostConditionResult> {
  const admin = createAdminClient();

  const { data: pageRows, error: pErr } = await admin
    .from('sitemap_xml_cache')
    .select('page_id')
    .order('page_id', { ascending: true });
  if (pErr) return { ok: false, message: `kunne ikke laese sitemap_xml_cache: ${pErr.message}` };

  const ids = (pageRows ?? []).map((r) => (r as { page_id: number }).page_id);
  // Tom cache haandteres af sitemap.xml's fallback (estimerer sider) — ikke brudt.
  if (ids.length === 0)
    return { ok: true, message: 'sitemap-cache tom (fallback-estimering aktiv)' };

  const { count: entryCount, error: eErr } = await admin
    .from('sitemap_entries')
    .select('*', { count: 'exact', head: true });
  if (eErr) return { ok: false, message: `kunne ikke taelle sitemap_entries: ${eErr.message}` };

  const expectedN = Math.max(
    1,
    Math.ceil(((entryCount ?? 0) + SITEMAP_STATIC_COUNT) / SITEMAP_PAGE_SIZE)
  );

  // Huller: page_ids skal vaere praecis [0..expectedN-1].
  const idSet = new Set(ids);
  const missing: number[] = [];
  for (let i = 0; i < expectedN; i++) if (!idSet.has(i)) missing.push(i);
  const extra = ids.filter((id) => id < 0 || id >= expectedN);

  if (missing.length === 0 && extra.length === 0 && ids.length === expectedN) {
    return { ok: true, message: `${expectedN} sider kontinuerte 0..${expectedN - 1}` };
  }

  const parts: string[] = [
    `forventet ${expectedN} sider (0..${expectedN - 1}) for ${entryCount} entries`,
    `fandt ${ids.length} sider (max page_id ${Math.max(...ids)})`,
  ];
  if (missing.length)
    parts.push(
      `manglende page_ids: ${missing.slice(0, 10).join(',')}${missing.length > 10 ? '…' : ''}`
    );
  if (extra.length) parts.push(`overskydende page_ids: ${extra.slice(0, 10).join(',')}`);
  return { ok: false, message: parts.join(' · ') };
}

/**
 * Registret over post-conditions pr. jobName. Tilfoej flere efterhaanden som
 * jobs faar output-invarianter der kan asserteres billigt.
 */
export const POST_CONDITIONS: Record<string, PostConditionCheck> = {
  'generate-sitemap': checkSitemapContinuity,
};

/** Resultat pr. job fra runPostConditions. */
export interface PostConditionRun {
  jobName: string;
  result: PostConditionResult;
}

/**
 * Koerer alle registrerede post-conditions. Fejl i én check isoleres (returneres
 * som ok=false), saa en enkelt daarlig check ikke vaelter hele scannet.
 *
 * @returns Ét resultat pr. registreret job
 */
export async function runPostConditions(): Promise<PostConditionRun[]> {
  const out: PostConditionRun[] = [];
  for (const [jobName, check] of Object.entries(POST_CONDITIONS)) {
    try {
      out.push({ jobName, result: await check() });
    } catch (e) {
      out.push({
        jobName,
        result: {
          ok: false,
          message: `post-condition kastede: ${e instanceof Error ? e.message : String(e)}`,
        },
      });
    }
  }
  return out;
}
