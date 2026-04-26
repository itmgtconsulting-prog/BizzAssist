#!/usr/bin/env node
/**
 * Opretter 7 tickets for Domain-case feature-pakken og markerer dem alle
 * som "In Progress" så de reserveres til den igangværende session.
 *
 * BIZZ-802..808 — customer link, edit case, upload from workspace,
 * selected_doc_ids in generate, AI chat upload, generation preview panel.
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';

loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const PROJECT = process.env.JIRA_PROJECT_KEY || 'BIZZ';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = https.request(
      {
        hostname: HOST,
        path: p,
        method,
        headers: {
          Authorization: 'Basic ' + auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => (m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, s) => ({ type: 'heading', attrs: { level: l }, content: [txt(s)] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...items) => ({ type: 'bulletList', content: items });

const TICKETS = [
  {
    summary: 'Domain: valgfri kundelink på sag (CVR eller person fra DB)',
    labels: ['domain', 'domain-case', 'customer-link'],
    desc: {
      type: 'doc', version: 1,
      content: [
        h(2, 'Mål'),
        p(txt('Når brugeren opretter (eller redigerer) en sag skal de kunne søge en eksisterende kunde i BizzAssist-databasen — CVR-virksomhed eller person — og tilknytte den til sagen. Ikke obligatorisk.')),
        h(2, 'Leverance'),
        ul(
          li(p(txt('Migration 070: tilføj '), code('client_kind'), txt(', '), code('client_cvr'), txt(', '), code('client_person_id'), txt(', '), code('client_name'), txt(' på '), code('domain_case'), txt('.'))),
          li(p(txt('Ny '), code('CustomerSearchPicker'), txt(' komponent som søger via '), code('/api/search'), txt(' og filtrerer til kun company/person.'))),
          li(p(txt('Wire pickeren ind i '), code('NewCaseClient'), txt(' + '), code('CaseDetailClient'), txt('.'))),
          li(p(txt('POST/PATCH API validerer at client_kind matcher den korrekte ID-kolonne.'))),
          li(p(txt('Workspace case-detail visning viser den tilknyttede kunde som clickable badge.'))),
        ),
        h(2, 'Acceptance'),
        ul(
          li(p(txt('Opret-sag modal har søgefelt "Kunde (valgfri)" — skriver "JaJR" → dropdown med 2-5 CVR-hits, klik → linket.'))),
          li(p(txt('Sag kan oprettes uden kunde (backwards compat).'))),
          li(p(txt('Rediger-sag kan skifte/fjerne kunde. Audit log fanger ændringen.'))),
        ),
      ],
    },
  },
  {
    summary: 'Domain: rediger sagsdata inline i workspace-panel',
    labels: ['domain', 'domain-case', 'edit-case'],
    desc: {
      type: 'doc', version: 1,
      content: [
        h(2, 'Mål'),
        p(txt('Bruger skal kunne redigere sagens metadata (navn, klient-ref, noter, status, tags, kunde) direkte i workspace venstre-bund panelet — ikke kun på den fuldskærms detail-side.')),
        h(2, 'Leverance'),
        ul(
          li(p(txt('Blyant-ikon i workspace case-header → skifter sektionen til inline edit-mode.'))),
          li(p(txt('Alle felter PATCH\'es via eksisterende '), code('/api/domain/[id]/cases/[caseId]'), txt(' endpoint.'))),
          li(p(txt('Bevar CustomerSearchPicker til kunde-redigering.'))),
          li(p(txt('Optimistic UI-update i cases-listen når "Gem" klikkes.'))),
        ),
        h(2, 'Acceptance'),
        ul(
          li(p(txt('Ændringer i sagsnavn opdaterer både venstre-top listen og header uden reload.'))),
          li(p(txt('Validering: sagsnavn 1-200 tegn, status open|closed|archived.'))),
        ),
      ],
    },
  },
  {
    summary: 'Domain: upload dokumenter til sag fra workspace',
    labels: ['domain', 'domain-case', 'doc-upload'],
    desc: {
      type: 'doc', version: 1,
      content: [
        h(2, 'Mål'),
        p(txt('Bruger skal kunne uploade dokumenter til sagen direkte fra workspace venstre-bund panelet (drag-drop + file input).')),
        h(2, 'Leverance'),
        ul(
          li(p(txt('Drag-drop zone + "Upload"-knap i workspace case-detail sektionen.'))),
          li(p(txt('Genbrug '), code('/api/domain/[id]/cases/[caseId]/docs POST'), txt(' — ingen API-ændringer nødvendige.'))),
          li(p(txt('Multipart upload, progress bar, refresh dok-listen + auto-select den uploadede fil som AI-context.'))),
          li(p(txt('Understøt de samme filtyper som eksisterende case-doc upload (docx/pdf/txt/eml/msg + de nye fra BIZZ-788).'))),
        ),
        h(2, 'Acceptance'),
        ul(
          li(p(txt('Drag-drop en .pdf → upload succesfuldt, dukker op i dok-listen, checkbox er automatisk valgt.'))),
          li(p(txt('Fejl-håndtering: for stor fil (>50MB) viser venlig besked.'))),
        ),
      ],
    },
  },
  {
    summary: 'Domain: generate-API respekterer selected_doc_ids fra bruger',
    labels: ['domain', 'domain-generate', 'ai'],
    desc: {
      type: 'doc', version: 1,
      content: [
        h(2, 'Mål'),
        p(txt('Workspace AI-chat sender '), code('selected_doc_ids'), txt(' i generate-request, men '), code('/api/domain/[id]/case/[caseId]/generate'), txt(' ignorerer det og bruger ALLE sag-dokumenter. Fix: respekter valget hvis givet.')),
        h(2, 'Leverance'),
        ul(
          li(p(txt('POST-handler parser '), code('selected_doc_ids'), txt(' (uuid[] max 50).'))),
          li(p(txt('Videresend til '), code('buildGenerationContext({ caseId, selectedDocIds })'), txt('.'))),
          li(p(txt('I '), code('domainPromptBuilder.ts'), txt(' filtrer '), code('domain_case_doc'), txt(' query på selectedDocIds hvis ikke-null og ikke-tom.'))),
          li(p(txt('Hvis selectedDocIds tom array/null → brug alle docs (eksisterende adfærd).'))),
          li(p(txt('Audit log metadata inkluderer '), code('selected_doc_ids'), txt(' for sporbarhed.'))),
        ),
        h(2, 'Acceptance'),
        ul(
          li(p(txt('POST med '), code('selected_doc_ids: [uuid1, uuid2]'), txt(' → generation_context.case_docs indeholder KUN de 2 docs.'))),
          li(p(txt('POST uden selected_doc_ids → uændret adfærd.'))),
        ),
      ],
    },
  },
  {
    summary: 'Domain: AI-chat upload-knap — auto-attach til sag + auto-vælg',
    labels: ['domain', 'domain-case', 'ai', 'doc-upload'],
    desc: {
      type: 'doc', version: 1,
      content: [
        h(2, 'Mål'),
        p(txt('Bruger skal kunne uploade dokumenter direkte fra AI-chat input\'en (højre-top panel). Filen gemmes på sagen + auto-valgt som kontekst.')),
        h(2, 'Leverance'),
        ul(
          li(p(txt('Paperclip-ikon i AI-chat input-baren → åbner filvælger (eller drag-drop ind i chat-flow).'))),
          li(p(txt('Upload kalder '), code('/api/domain/[id]/cases/[caseId]/docs POST'), txt(' → når ok, tilføj dokument-id til '), code('selectedDocIds'), txt('.'))),
          li(p(txt('Vis preview-chip i chat (ikon + filnavn + fjern-kryds) over input-feltet.'))),
          li(p(txt('Understøt multiple filer i én upload.'))),
        ),
        h(2, 'Acceptance'),
        ul(
          li(p(txt('Drag en .pdf ind i AI-chat-området → upload sker, chip vises, næste AI-prompt har filen som kontekst.'))),
          li(p(txt('Filen dukker også op i venstre case-doc listen.'))),
        ),
      ],
    },
  },
  {
    summary: 'Domain: generation preview panel + iterate-feedback + download/attach',
    labels: ['domain', 'domain-generate', 'ai', 'preview-panel'],
    desc: {
      type: 'doc', version: 1,
      content: [
        h(2, 'Mål'),
        p(txt('Når AI\'en har genereret et dokument skal der åbne et 3. side-panel (til højre for AI+skabeloner) eller popup der viser det genererede dokument. Bruger kan give feedback → AI genererer ny version. Når godkendt: download + tilknyt sagen.')),
        h(2, 'Leverance'),
        ul(
          li(p(txt('Ny komponent '), code('DomainGenerationPreview'), txt(' — fixed 3. panel til højre.'))),
          li(p(txt('Poll '), code('/api/domain/[id]/generation/[genId]'), txt(' indtil status=completed (eksisterende endpoint).'))),
          li(p(txt('Render genereret .docx som tekst-preview (mammoth → HTML) eller som iframe (signed URL til .docx/.pdf).'))),
          li(p(txt('Feedback-input: "Hvad skal rettes?" → POST til ny '), code('/api/domain/[id]/case/[caseId]/generate/iterate'), txt(' med '), code('parent_generation_id'), txt(' + '), code('feedback'), txt('. Serveren føjer feedback + forrige output til context og kalder Claude igen.'))),
          li(p(txt('"Godkend & download" → 302 til signed URL, samtidig kopieres output som '), code('domain_case_doc'), txt(' så det er permanent bundet til sagen.'))),
          li(p(txt('"Afvis / start forfra" → slet generation (soft) og ryd panelet.'))),
        ),
        h(2, 'Acceptance'),
        ul(
          li(p(txt('Send prompt → preview-panel åbner, viser loader, så genereret tekst.'))),
          li(p(txt('Skriv feedback "Fjern afsnit 3" → Send → ny version erstatter preview.'))),
          li(p(txt('Klik "Godkend" → .docx downloades + dukker op i sagens dokumenter.'))),
        ),
      ],
    },
  },
];

async function getInProgressTransitionId(issueKey) {
  const r = await req('GET', `/rest/api/3/issue/${issueKey}/transitions`);
  if (r.status !== 200) return null;
  const { transitions } = JSON.parse(r.body);
  const hit = transitions.find((t) =>
    /in progress|igang|in-progress/i.test(t.name) || /in progress/i.test(t.to?.name ?? '')
  );
  return hit?.id ?? null;
}

async function transition(issueKey, transId) {
  return req('POST', `/rest/api/3/issue/${issueKey}/transitions`, {
    transition: { id: transId },
  });
}

const created = [];
for (const t of TICKETS) {
  const body = {
    fields: {
      project: { key: PROJECT },
      summary: t.summary,
      description: t.desc,
      issuetype: { name: 'Task' },
      labels: t.labels,
    },
  };
  const r = await req('POST', '/rest/api/3/issue', body);
  if (r.status !== 201 && r.status !== 200) {
    console.error(`✗ ${t.summary}: ${r.status} ${r.body.slice(0, 200)}`);
    continue;
  }
  const { key } = JSON.parse(r.body);
  console.log(`✓ Created ${key}: ${t.summary}`);
  created.push(key);
}

// Transition all to In Progress
for (const key of created) {
  const id = await getInProgressTransitionId(key);
  if (!id) {
    console.error(`✗ ${key}: no "In Progress" transition found`);
    continue;
  }
  const r = await transition(key, id);
  if (r.status === 204 || r.status === 200) {
    console.log(`→ ${key} transitioned to In Progress`);
  } else {
    console.error(`✗ ${key}: transition ${r.status} ${r.body.slice(0, 200)}`);
  }
}

console.log(`\nDone. Created ${created.length} tickets.`);
