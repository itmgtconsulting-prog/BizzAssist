/**
 * Ejendomsrapport PDF-generator.
 * Modtager ejendomsdata som JSON og returnerer en pæn PDF med pdfkit.
 *
 * POST /api/rapport
 * Body: RapportPayload (adresse, BBR, vurdering, ejere, salg, matrikel, plandata, jord)
 * Returns: application/pdf stream
 */
import { NextRequest, NextResponse } from 'next/server';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PDFDocument = require('pdfkit');

/* ─── Payload-typer (subset af client-side interfaces) ─── */

interface RapportBygning {
  id: string;
  opfoerelsesaar?: number | null;
  bygningsareal?: number | null;
  boligareal?: number | null;
  samletAreal?: number | null;
  etager?: number | null;
  anvendelsestekst?: string | null;
  tagmateriale?: string | null;
  ydervaeggene?: string | null;
  energimaerke?: string | null;
}

interface RapportVurdering {
  aar?: number | null;
  ejendomsvaerdi?: number | null;
  grundvaerdi?: number | null;
  estimereretGrundskyld?: number | null;
  grundskyldspromille?: number | null;
}

interface RapportEjer {
  navn?: string | null;
  ejertype?: string | null;
  cvr?: string | null;
  ejerandel?: { taeller?: number; naevner?: number } | null;
}

interface RapportHandel {
  koebsaftaleDato?: string | null;
  kontantKoebesum?: number | null;
  overdragelsesmaade?: string | null;
}

interface RapportMatrikel {
  matrikelnummer?: string | null;
  registreretAreal?: number | null;
  vejareal?: number | null;
  fredskov?: boolean | null;
  strandbeskyttelse?: boolean | null;
}

interface RapportPlan {
  type?: string | null;
  navn?: string | null;
  nummer?: string | null;
  status?: string | null;
}

interface RapportJord {
  pollutionStatusCodeText?: string | null;
  locationNames?: string[] | null;
}

interface RapportPayload {
  adresse: string;
  kommune?: string | null;
  postnr?: string | null;
  by?: string | null;
  bfeNummer?: number | null;
  matrikelnr?: string | null;
  ejerlavKode?: number | null;
  bygninger?: RapportBygning[];
  vurdering?: RapportVurdering | null;
  alleVurderinger?: RapportVurdering[];
  ejere?: RapportEjer[];
  salgshistorik?: RapportHandel[];
  matrikel?: RapportMatrikel[];
  plandata?: RapportPlan[];
  jordforurening?: RapportJord[];
  jordIngenData?: boolean;
}

/** Formaterer et tal som dansk kr. */
function dkk(n: number | null | undefined): string {
  if (n == null) return '–';
  return n.toLocaleString('da-DK') + ' kr.';
}

/** Formaterer dato-streng til dansk format */
function dato(d: string | null | undefined): string {
  if (!d) return '–';
  try {
    return new Date(d).toLocaleDateString('da-DK');
  } catch {
    return d;
  }
}

/**
 * Genererer en PDF-rapport med ejendomsdata.
 *
 * @param request - NextRequest med JSON body indeholdende RapportPayload
 * @returns PDF som application/pdf stream
 */
export async function POST(request: NextRequest) {
  try {
    const payload: RapportPayload = await request.json();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc: any = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
      info: {
        Title: `Ejendomsrapport — ${payload.adresse}`,
        Author: 'BizzAssist',
        Subject: 'Ejendomsrapport',
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));

    const pdfReady = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const pageW = doc.page.width - 100; // 495 pt usable

    /** Tegner en sektions-titel med understregning */
    const sectionTitle = (title: string) => {
      doc.moveDown(0.8);
      doc.fontSize(13).font('Helvetica-Bold').fillColor('#1e3a5f').text(title);
      doc.moveDown(0.15);
      doc
        .moveTo(50, doc.y)
        .lineTo(50 + pageW, doc.y)
        .strokeColor('#cbd5e1')
        .lineWidth(0.5)
        .stroke();
      doc.moveDown(0.3);
      doc.font('Helvetica').fillColor('#1e293b');
    };

    /** Tegner en nøgle-værdi linje */
    const kvLine = (label: string, value: string) => {
      doc
        .fontSize(9)
        .font('Helvetica-Bold')
        .text(label + ':', 50, doc.y, { continued: true, width: 160 });
      doc.font('Helvetica').text('  ' + value, { width: pageW - 160 });
    };

    /** Tegner en simpel tabel med headers og rækker */
    const simpleTable = (headers: string[], rows: string[][], colWidths: number[]) => {
      const y0 = doc.y;
      // Header row
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#475569');
      let x = 50;
      headers.forEach((h, i) => {
        doc.text(h, x, y0, { width: colWidths[i] });
        x += colWidths[i];
      });
      doc.moveDown(0.3);
      doc
        .moveTo(50, doc.y)
        .lineTo(50 + pageW, doc.y)
        .strokeColor('#e2e8f0')
        .lineWidth(0.3)
        .stroke();
      doc.moveDown(0.15);

      // Data rows
      doc.font('Helvetica').fillColor('#1e293b').fontSize(8);
      for (const row of rows) {
        // Check page break
        if (doc.y > doc.page.height - 80) {
          doc.addPage();
        }
        x = 50;
        row.forEach((cell, i) => {
          doc.text(cell, x, doc.y, { width: colWidths[i] });
          x += colWidths[i];
        });
        doc.moveDown(0.15);
      }
    };

    /* ═══════════════════════════════════════════
       PDF Indhold
       ═══════════════════════════════════════════ */

    // ── Header ──
    doc.rect(0, 0, doc.page.width, 90).fill('#0f172a');
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#ffffff').text('BizzAssist', 50, 25);
    doc.fontSize(9).font('Helvetica').fillColor('#94a3b8').text('Ejendomsrapport', 50, 52);
    doc
      .fontSize(9)
      .fillColor('#64748b')
      .text(
        `Genereret ${new Date().toLocaleDateString('da-DK')} kl. ${new Date().toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })}`,
        50,
        65
      );
    doc.moveDown(1);
    doc.y = 105;

    // ── Adresse ──
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#0f172a').text(payload.adresse, 50);
    doc.moveDown(0.2);
    const subParts: string[] = [];
    if (payload.kommune) subParts.push(payload.kommune + ' Kommune');
    if (payload.bfeNummer) subParts.push('BFE ' + payload.bfeNummer);
    if (payload.matrikelnr) subParts.push('Matr. ' + payload.matrikelnr);
    if (subParts.length > 0) {
      doc.fontSize(9).font('Helvetica').fillColor('#64748b').text(subParts.join('  ·  '));
    }

    // ── Vurdering ──
    if (payload.vurdering) {
      sectionTitle('Ejendomsvurdering');
      const v = payload.vurdering;
      if (v.aar) kvLine('Vurderingsår', String(v.aar));
      kvLine('Ejendomsværdi', dkk(v.ejendomsvaerdi));
      kvLine('Grundværdi', dkk(v.grundvaerdi));
      if (v.estimereretGrundskyld) kvLine('Estimeret grundskyld', dkk(v.estimereretGrundskyld));
      if (v.grundskyldspromille) kvLine('Grundskyldspromille', v.grundskyldspromille + ' ‰');
    }

    // ── Vurderingshistorik ──
    if (payload.alleVurderinger && payload.alleVurderinger.length > 1) {
      sectionTitle('Vurderingshistorik');
      const rows = payload.alleVurderinger
        .filter((v) => v.aar)
        .sort((a, b) => (b.aar ?? 0) - (a.aar ?? 0))
        .slice(0, 10)
        .map((v) => [String(v.aar ?? '–'), dkk(v.ejendomsvaerdi), dkk(v.grundvaerdi)]);
      simpleTable(['År', 'Ejendomsværdi', 'Grundværdi'], rows, [60, 200, 200]);
    }

    // ── BBR Bygninger ──
    if (payload.bygninger && payload.bygninger.length > 0) {
      sectionTitle('BBR — Bygninger');
      payload.bygninger.forEach((byg, idx) => {
        if (idx > 0) doc.moveDown(0.3);
        doc
          .fontSize(10)
          .font('Helvetica-Bold')
          .fillColor('#1e3a5f')
          .text(`Bygning ${idx + 1}${byg.anvendelsestekst ? ' — ' + byg.anvendelsestekst : ''}`);
        doc.moveDown(0.15);
        doc.font('Helvetica').fillColor('#1e293b');
        if (byg.opfoerelsesaar) kvLine('Opførelsesår', String(byg.opfoerelsesaar));
        if (byg.bygningsareal) kvLine('Bygningsareal', byg.bygningsareal + ' m²');
        if (byg.boligareal) kvLine('Boligareal', byg.boligareal + ' m²');
        if (byg.etager) kvLine('Etager', String(byg.etager));
        if (byg.tagmateriale) kvLine('Tagmateriale', byg.tagmateriale);
        if (byg.ydervaeggene) kvLine('Ydervægge', byg.ydervaeggene);
        if (byg.energimaerke) kvLine('Energimærke', byg.energimaerke);
      });
    }

    // ── Ejerskab ──
    if (payload.ejere && payload.ejere.length > 0) {
      sectionTitle('Ejerskab');
      const rows = payload.ejere.map((e) => [
        e.navn ?? '–',
        e.ejertype === 'selskab' ? 'Selskab' : e.ejertype === 'person' ? 'Person' : '–',
        e.cvr ?? '–',
        e.ejerandel ? `${e.ejerandel.taeller}/${e.ejerandel.naevner}` : '–',
      ]);
      simpleTable(['Navn', 'Type', 'CVR', 'Andel'], rows, [180, 80, 80, 80]);
    }

    // ── Salgshistorik ──
    if (payload.salgshistorik && payload.salgshistorik.length > 0) {
      sectionTitle('Salgshistorik');
      const rows = payload.salgshistorik
        .sort((a, b) => (b.koebsaftaleDato ?? '').localeCompare(a.koebsaftaleDato ?? ''))
        .map((h) => [dato(h.koebsaftaleDato), dkk(h.kontantKoebesum), h.overdragelsesmaade ?? '–']);
      simpleTable(['Dato', 'Kontant købesum', 'Overdragelsesmåde'], rows, [100, 180, 180]);
    }

    // ── Matrikel ──
    if (payload.matrikel && payload.matrikel.length > 0) {
      sectionTitle('Matrikeldata');
      for (const js of payload.matrikel) {
        kvLine('Matrikelnr.', js.matrikelnummer ?? '–');
        if (js.registreretAreal) kvLine('Registreret areal', js.registreretAreal + ' m²');
        if (js.vejareal) kvLine('Vejareal', js.vejareal + ' m²');
        if (js.fredskov) kvLine('Fredskov', 'Ja');
        if (js.strandbeskyttelse) kvLine('Strandbeskyttelse', 'Ja');
      }
    }

    // ── Plandata ──
    if (payload.plandata && payload.plandata.length > 0) {
      sectionTitle('Plandata');
      const rows = payload.plandata.map((p) => [
        p.type ?? '–',
        p.navn ?? '–',
        p.nummer ?? '–',
        p.status ?? '–',
      ]);
      simpleTable(['Type', 'Navn', 'Nr.', 'Status'], rows, [90, 220, 80, 80]);
    }

    // ── Jordforurening ──
    sectionTitle('Jordforurening');
    if (payload.jordIngenData) {
      doc.fontSize(9).fillColor('#16a34a').text('Ingen forureningsregistreringer fundet.');
    } else if (payload.jordforurening && payload.jordforurening.length > 0) {
      for (const j of payload.jordforurening) {
        kvLine('Status', j.pollutionStatusCodeText ?? '–');
        if (j.locationNames && j.locationNames.length > 0) {
          kvLine('Lokalitet', j.locationNames.join(', '));
        }
        doc.moveDown(0.2);
      }
    } else {
      doc.fontSize(9).fillColor('#64748b').text('Jordforureningsdata ikke tilgængelig.');
    }

    // ── Footer ──
    doc.moveDown(1.5);
    doc
      .moveTo(50, doc.y)
      .lineTo(50 + pageW, doc.y)
      .strokeColor('#e2e8f0')
      .lineWidth(0.3)
      .stroke();
    doc.moveDown(0.3);
    doc
      .fontSize(7)
      .font('Helvetica')
      .fillColor('#94a3b8')
      .text(
        'Denne rapport er genereret automatisk af BizzAssist og baseret på offentligt tilgængelige data fra Datafordeler, DAWA, BBR, Vurderingsstyrelsen m.fl. Informationerne er vejledende og kan ikke erstatte professionel rådgivning.',
        50,
        doc.y,
        { width: pageW, align: 'center' }
      );

    doc.end();

    const pdfBuffer = await pdfReady;

    const filename = `BizzAssist_${payload.adresse.replace(/[^a-zA-Z0-9æøåÆØÅ ]/g, '').replace(/\s+/g, '_')}.pdf`;

    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(pdfBuffer.length),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ukendt fejl';
    return NextResponse.json({ fejl: message }, { status: 500 });
  }
}
