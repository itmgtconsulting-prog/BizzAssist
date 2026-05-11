/**
 * ZIP-download logik for ejendomsdokumenter.
 * Ekstraheret fra EjendomDetaljeClient.tsx for at reducere fil-stoerrelse.
 *
 * Bygger en liste over downloadbare PDF-URL'er baseret paa valgte dokument-IDs,
 * POSTer til /api/dokumenter/zip og trigger browser-download af resultatet.
 *
 * @module downloadZip
 */

import type { EjendomApiResponse } from '@/app/api/ejendom/[id]/route';
import type { PlandataItem } from '@/app/api/plandata/route';
import type { EnergimaerkeItem } from '@/app/api/energimaerke/route';
import type { DawaAdresse } from '@/app/lib/dawa';

/** Translations needed by the ZIP download handler */
interface ZipTranslations {
  noDirectPdfLinks: string;
  zipDownloaded: string;
  tryOpenInBrowser: string;
  unknownError: string;
}

/** Context required to build the document list and download the ZIP */
interface ZipDownloadContext {
  valgteDoc: Set<string>;
  bbrData: EjendomApiResponse | null;
  plandata: PlandataItem[] | null;
  energimaerker: EnergimaerkeItem[] | null;
  dawaAdresse: DawaAdresse | null;
  t: ZipTranslations;
}

/**
 * Henter de valgte dokumenter og downloader dem som ZIP.
 *
 * @param ctx - Kontekst med valgte dokumenter, ejendomsdata og oversaettelser
 * @returns Promise der resolver naar download er faerdig (eller fejlet)
 */
export async function handleDownloadZip(ctx: ZipDownloadContext): Promise<void> {
  const { valgteDoc, bbrData, plandata, energimaerker, dawaAdresse, t } = ctx;

  const rel = bbrData?.ejendomsrelationer?.[0];
  const bfeNummer = rel?.bfeNummer;
  const ejerlavKode = rel?.ejerlavKode;
  const matrikelnr = rel?.matrikelnr;

  type ZipDoc = { filename: string; url: string };
  const docs: ZipDoc[] = [];

  for (const id of valgteDoc) {
    // BBR-meddelelse
    if (id === 'std-3' && bfeNummer) {
      docs.push({
        filename: 'BBR-meddelelse.pdf',
        url: `https://bbr.dk/pls/wwwdata/get_newois_pck.show_bbr_meddelelse_pdf?i_bfe=${bfeNummer}`,
      });
    }
    // Matrikelkort (intern API)
    if (id === 'std-5' && ejerlavKode && matrikelnr) {
      docs.push({
        filename: `Matrikelkort_${matrikelnr}.pdf`,
        url: `/api/matrikelkort?ejerlavKode=${ejerlavKode}&matrikelnr=${encodeURIComponent(matrikelnr)}`,
      });
    }
    // Jordforureningsattest — via intern /api/jord/pdf proxy
    if (id === 'std-7' && ejerlavKode && matrikelnr) {
      docs.push({
        filename: `Jordforureningsattest_${matrikelnr}.pdf`,
        url: `/api/jord/pdf?elav=${ejerlavKode}&matrnr=${encodeURIComponent(matrikelnr)}`,
      });
    }
  }

  // Planer med doklink
  if (plandata) {
    for (const plan of plandata) {
      if (plan.doklink && valgteDoc.has(`pla-${plan.id}`)) {
        docs.push({
          filename: `Plan_${(plan.navn ?? plan.id ?? 'ukendt').replace(/[^a-zA-Z0-9æøåÆØÅ]/g, '_')}.pdf`,
          url: plan.doklink,
        });
      }
    }
  }

  // Energimaerkerapporter — proxy URL aabnes direkte fra cachet state
  if (energimaerker) {
    for (const m of energimaerker) {
      if (m.pdfUrl && valgteDoc.has(`energi-${m.serialId}`)) {
        docs.push({
          filename: `Energimaerke_${m.serialId}.pdf`,
          url: m.pdfUrl,
        });
      }
    }
  }

  if (docs.length === 0) {
    alert(t.noDirectPdfLinks);
    return;
  }

  const adresse = dawaAdresse?.vejnavn ?? 'ejendom';
  const res = await fetch('/api/dokumenter/zip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      docs,
      arkivNavn: `BizzAssist_${adresse.replace(/[^a-zA-Z0-9æøåÆØÅ]/g, '_')}`,
    }),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({ fejl: t.unknownError }))) as { fejl?: string };
    alert(`ZIP-download fejlede: ${err.fejl ?? res.statusText}`);
    return;
  }

  // Trigger browser-download
  const springedeOver = res.headers.get('X-Springede-Over');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download =
    res.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'dokumenter.zip';
  a.click();
  URL.revokeObjectURL(url);

  // Informer brugeren hvis nogle dokumenter ikke kunne valideres som gyldige PDF-filer
  if (springedeOver) {
    const liste = springedeOver
      .split(' | ')
      .map((s) => `• ${s}`)
      .join('\n');
    alert(`${t.zipDownloaded}\n\n${liste}\n\n${t.tryOpenInBrowser}`);
  }
}
