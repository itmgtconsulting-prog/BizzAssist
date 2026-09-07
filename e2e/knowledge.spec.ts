/**
 * E2E regression tests for the videnbase (knowledge base) — BIZZ-2276/2280.
 *
 * Locks the behaviour of the KB-series fixes so a future change to the
 * per-tenant schema-resolution path (KB.1 mig 216 / KB.2 routes / KB.3 AI read)
 * cannot silently break the feature again — the exact class of regression the
 * KB series was created to fix. The original bug was invisible because the
 * shared `tenant` schema is not exposed to PostgREST (PGRST106), so nothing
 * failed loudly.
 *
 * Coverage:
 *   1. CRUD + uploads — GET list (200), POST manual (201), upload TXT/PDF/DOCX
 *      (201 with the marker text actually extracted), DELETE (204), list clean.
 *   2. AI context — plant a neutral supplier fact with a unique marker, ask the
 *      assistant a question only answerable from the knowledge base, and assert
 *      the streamed answer contains the marker (proves per-tenant knowledge is
 *      injected into the system prompt).
 *
 * Gotchas locked in (from BIZZ-2280 review):
 *   - The /api/ai/chat SSE stream carries assistant text under the key `t`
 *     (NOT `text`); tokens must be concatenated before asserting.
 *   - Prompts must avoid words like "hemmelig/fortrolig" — they trip the chat's
 *     confidentiality guardrail and yield a false negative. A neutral,
 *     knowledge-base-typical fact (a supplier + customer number) is used instead.
 *
 * Auth: enterprise tenant_admin via the shared storageState (jjrchefen on test).
 * Requires E2E_TEST_EMAIL / E2E_TEST_PASS; skipped otherwise.
 * Target: test.bizzassist.dk (deploys from develop).
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import fs from 'fs';
import PDFDocument from 'pdfkit';
import JSZip from 'jszip';
import { AUTH_STATE_PATH } from './helpers';

/** Prefix on every title this spec creates, so leftovers can be swept safely. */
const PREFIX = 'E2E-KB';

interface KnowledgeRow {
  id: number;
  title: string;
  content: string;
  source_type: string;
}

/** Builds a real single-page PDF containing `text` (text layer, not an image). */
async function makePdf(text: string): Promise<Buffer> {
  const doc = new PDFDocument();
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));
  doc.fontSize(14).text(text, 72, 72);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

/** Builds a minimal but valid DOCX whose body paragraph contains `text`. */
async function makeDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

/** Deletes every knowledge item whose title starts with our PREFIX. */
async function sweep(request: APIRequestContext): Promise<void> {
  const res = await request.get('/api/knowledge');
  if (!res.ok()) return;
  const rows = (await res.json()) as KnowledgeRow[];
  for (const r of rows) {
    if (typeof r.title === 'string' && r.title.startsWith(PREFIX)) {
      await request.delete(`/api/knowledge?id=${r.id}`).catch(() => {});
    }
  }
}

/**
 * Reads the /api/ai/chat SSE body and concatenates the assistant text tokens.
 * The stream is a sequence of `data: {json}` lines; assistant text arrives under
 * the `t` key, status/error/other events are ignored.
 */
function assistantTextFromSse(body: string): string {
  let out = '';
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload) as { t?: string };
      if (typeof obj.t === 'string') out += obj.t;
    } catch {
      /* ignore non-JSON keepalive lines */
    }
  }
  return out;
}

test.beforeEach(async ({ request }, testInfo) => {
  const hasAuth = fs.existsSync(AUTH_STATE_PATH) && !!process.env.E2E_TEST_EMAIL;
  if (!hasAuth) {
    testInfo.skip(true, 'No E2E_TEST_EMAIL — skipping videnbase tests');
    return;
  }
  // Self-heal: remove any leftovers from a previously crashed run.
  await sweep(request);
});

test.describe('Videnbase (knowledge base) — BIZZ-2276/2280', () => {
  test('CRUD + TXT/PDF/DOCX uploads round-trip gennem per-tenant schema', async ({ request }) => {
    test.setTimeout(90_000);
    const createdIds: number[] = [];

    try {
      // (a) list responds 200 with an array (route reaches the per-tenant table)
      const list0 = await request.get('/api/knowledge');
      expect(list0.status()).toBe(200);
      expect(Array.isArray(await list0.json())).toBe(true);

      // (b) manual create → 201
      const postRes = await request.post('/api/knowledge', {
        data: { title: `${PREFIX} manuel note`, content: 'Manuelt oprettet videnbase-note.' },
      });
      expect(postRes.status()).toBe(201);
      const manual = (await postRes.json()) as KnowledgeRow;
      expect(manual.id).toBeTruthy();
      expect(manual.source_type).toBe('manual');
      createdIds.push(manual.id);

      // (c) uploads — each extractor must actually recover its marker text
      const uploads: Array<{ name: string; mime: string; buf: Buffer; marker: string }> = [
        {
          name: 'kb.txt',
          mime: 'text/plain',
          buf: Buffer.from(`${PREFIX}-TXT-7710 en tekstnote.`, 'utf-8'),
          marker: `${PREFIX}-TXT-7710`,
        },
        {
          name: 'kb.pdf',
          mime: 'application/pdf',
          buf: await makePdf(`${PREFIX}-PDF-7711 tekst i en pdf-fil med flere ord.`),
          marker: `${PREFIX}-PDF-7711`,
        },
        {
          name: 'kb.docx',
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          buf: await makeDocx(`${PREFIX}-DOCX-7712 tekst i en word-fil.`),
          marker: `${PREFIX}-DOCX-7712`,
        },
      ];

      for (const u of uploads) {
        const up = await request.post('/api/knowledge/upload', {
          multipart: { file: { name: u.name, mimeType: u.mime, buffer: u.buf } },
        });
        expect(up.status(), `${u.name} upload status`).toBe(201);
        const body = (await up.json()) as { id: number; charCount: number };
        expect(body.charCount, `${u.name} extracted chars`).toBeGreaterThan(0);
        createdIds.push(body.id);

        // The extracted marker text must survive into the stored row.
        const one = await request.get(`/api/knowledge/${body.id}`);
        expect(one.status()).toBe(200);
        const row = (await one.json()) as KnowledgeRow;
        expect(row.content, `${u.name} marker extracted`).toContain(u.marker);
      }

      // list now reflects our rows (manual + 3 uploads)
      const list1 = (await (await request.get('/api/knowledge')).json()) as KnowledgeRow[];
      const ours = list1.filter((r) => createdIds.includes(r.id));
      expect(ours.length).toBe(createdIds.length);
      expect(ours.some((r) => r.source_type === 'upload')).toBe(true);

      // (d) delete → 204
      for (const id of createdIds) {
        const del = await request.delete(`/api/knowledge?id=${id}`);
        expect(del.status()).toBe(204);
      }
      createdIds.length = 0;

      // list clean of our rows
      const list2 = (await (await request.get('/api/knowledge')).json()) as KnowledgeRow[];
      expect(list2.filter((r) => r.title.startsWith(PREFIX)).length).toBe(0);
    } finally {
      for (const id of createdIds) await request.delete(`/api/knowledge?id=${id}`).catch(() => {});
    }
  });

  test('AI-assistenten refererer plantet videnbase-viden', async ({ request }) => {
    test.setTimeout(120_000);
    const marker = 'NDC-40571';
    let plantedId: number | null = null;

    try {
      // Plant a neutral supplier fact (avoids the confidentiality guardrail).
      const post = await request.post('/api/knowledge', {
        data: {
          title: `${PREFIX} IT-leverandoer`,
          content: `Vores primaere IT-leverandoer er Nordisk Datacenter A/S. Vores kundenummer hos dem er ${marker}.`,
        },
      });
      expect(post.status()).toBe(201);
      plantedId = ((await post.json()) as KnowledgeRow).id;

      // Ask something only answerable from the planted knowledge.
      const chat = await request.post('/api/ai/chat', {
        data: {
          messages: [
            {
              role: 'user',
              content:
                'Hvad er vores kundenummer hos vores IT-leverandoer? Svar udelukkende med selve kundenummeret.',
            },
          ],
        },
        timeout: 90_000,
      });
      expect(chat.status()).toBe(200);

      const answer = assistantTextFromSse(await chat.text());
      expect(answer, 'AI answer should cite the knowledge-base marker').toContain(marker);
    } finally {
      if (plantedId) await request.delete(`/api/knowledge?id=${plantedId}`).catch(() => {});
    }
  });
});
