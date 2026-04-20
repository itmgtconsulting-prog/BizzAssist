#!/usr/bin/env node
/**
 * Opretter 4 JIRA-tickets for at få offentlige ejendoms- + virksomhedsider
 * indekseret af Google:
 *   1. Verificér prod-sitemap: kør cron manuelt + validér output
 *   2. Submit sitemap til Google Search Console + Bing Webmaster Tools
 *   3. Skift sitemap-cron fra ugentlig (søndag nat) til dagligt
 *   4. Tilføj Schema.org strukturerede data til offentlige sider
 */
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
const PROJECT = process.env.JIRA_PROJECT_KEY || 'BIZZ';

function req(m,p,b){return new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const r=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,'Content-Type':'application/json',Accept:'application/json',...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});r.on('error',rej);if(d)r.write(d);r.end()});}

const p = (...c) => ({ type:'paragraph', content:c });
const txt = (t,m) => m?{type:'text',text:t,marks:m}:{type:'text',text:t};
const strong = (s) => txt(s,[{type:'strong'}]);
const em = (s) => txt(s,[{type:'em'}]);
const code = (s) => txt(s,[{type:'code'}]);
const h = (l,t) => ({type:'heading',attrs:{level:l},content:[{type:'text',text:t}]});
const li = (...c) => ({type:'listItem',content:c});
const ul = (...i) => ({type:'bulletList',content:i});
const codeBlock = (t, lang) => ({type:'codeBlock', attrs:lang?{language:lang}:{}, content:[{type:'text',text:t}]});

// ─── Ticket 1: Verificér prod-sitemap ───────────────────────────────────────

const t1 = {
  summary: 'SEO: verificér prod-sitemap er populeret og tilgængeligt (kør cron manuelt + smoke-test)',
  priority: 'High',
  labels: ['seo', 'sitemap', 'verification', 'ops'],
  description: {
    type:'doc', version:1, content:[
      h(2, 'Baggrund'),
      p(txt('Observation 2026-04-20: offentlige '), code('/ejendom/[slug]'), txt(' + '), code('/virksomhed/[slug]'), txt('-sider kan ikke findes på Google. Kode er på plads ('), code('app/sitemap.ts'), txt(' + '), code('app/robots.ts'), txt(' + cron '), code('/api/cron/generate-sitemap'), txt('), men der er ikke verificeret at:')),
      ul(
        li(p(strong('sitemap_entries'), txt('-tabellen i prod-Supabase er populeret med danske ejendomme + virksomheder'))),
        li(p(code('https://bizzassist.dk/sitemap/0.xml'), txt(' returnerer 200 + gyldig XML med URLs'))),
        li(p(code('https://bizzassist.dk/robots.txt'), txt(' har '), code('Sitemap:'), txt('-header + '), code('Allow: /ejendom/'), txt(' i production-mode'))),
      ),
      p(txt('Cron kører kun søndag nat (2/3/4 UTC) — første kørsel kan være forsinket hvis ticket lander mid-week.')),
      h(2, 'Tasks'),
      ul(
        li(p(strong('Manuel trigger på prod (3 phases):'))),
        li(p(code('curl -H "Authorization: Bearer $CRON_SECRET" -H "x-vercel-cron: 1" https://bizzassist.dk/api/cron/generate-sitemap?phase=companies'))),
        li(p(code('curl -H "Authorization: Bearer $CRON_SECRET" -H "x-vercel-cron: 1" https://bizzassist.dk/api/cron/generate-sitemap?phase=properties'))),
        li(p(code('curl -H "Authorization: Bearer $CRON_SECRET" -H "x-vercel-cron: 1" https://bizzassist.dk/api/cron/generate-sitemap?phase=vp-properties'))),
        li(p(strong('Verificér DB:'), txt(' '), code('SELECT count(*), min(updated_at), max(updated_at) FROM public.sitemap_entries'), txt(' i prod-Supabase. Forventet: > 1 M rækker.'))),
        li(p(strong('Smoke-test:'), txt(' '), code('curl -I https://bizzassist.dk/sitemap/0.xml'), txt(' = 200. '), code('curl https://bizzassist.dk/sitemap/0.xml | head -50'), txt(' = gyldig XML-sitemap.'))),
        li(p(strong('robots.txt-check:'), txt(' '), code('curl https://bizzassist.dk/robots.txt'), txt(' skal indeholde '), code('Sitemap: https://bizzassist.dk/sitemap/0.xml'), txt(' + '), code('Allow: /ejendom/'), txt('.'))),
        li(p(strong('Env-check:'), txt(' '), code('NEXT_PUBLIC_APP_URL=https://bizzassist.dk'), txt(' + '), code('VERCEL_ENV=production'), txt(' i Vercel prod-env — ellers aktiverer '), code('robots.ts'), txt(' ikke production-mode.'))),
      ),
      h(2, 'Acceptance criteria'),
      ul(
        li(p(code('sitemap_entries.count > 1.000.000'), txt(' i prod-Supabase'))),
        li(p(code('/sitemap/0.xml'), txt(' → 200 + gyldig XML med > 50 URLs'))),
        li(p(code('/robots.txt'), txt(' har korrekt Sitemap-header'))),
        li(p(txt('Mindst 5 tilfældige '), code('/ejendom/[slug]/[bfe]'), txt('- + '), code('/virksomhed/[slug]/[cvr]'), txt('-URLs returnerer 200 med korrekte meta-tags'))),
      ),
    ],
  },
};

// ─── Ticket 2: GSC + Bing Webmaster ─────────────────────────────────────────

const t2 = {
  summary: 'SEO: submit sitemap til Google Search Console + Bing Webmaster Tools',
  priority: 'High',
  labels: ['seo', 'sitemap', 'google', 'bing'],
  description: {
    type:'doc', version:1, content:[
      h(2, 'Mål'),
      p(txt('Selvom '), code('robots.txt'), txt(' linker til sitemap, kan Google tage uger/måneder at discover et nyt site uden manuel submission. Submit speeds up discovery dramatisk og giver os indexing-telemetri.')),
      h(2, 'Tasks'),
      ul(
        li(p(strong('Google Search Console (GSC):'))),
        li(p(txt('• Opret property for '), code('bizzassist.dk'), txt(' på '), code('https://search.google.com/search-console'))),
        li(p(txt('• Verificér ejerskab — brug DNS TXT-record eller '), code('app/.well-known/'), txt('-fil (TXT er nemmest for Vercel)'))),
        li(p(txt('• Submit sitemap: '), code('https://bizzassist.dk/sitemap/0.xml'), txt(' (hvis paginated — submit også /sitemap/1.xml, /2.xml etc. når de dukker op)'))),
        li(p(txt('• Aktivér email-alerts for coverage-errors'))),
        li(p(strong('Bing Webmaster Tools:'))),
        li(p(txt('• '), code('https://www.bing.com/webmasters'), txt(' — kan importere fra GSC direkte når GSC er verificeret'))),
        li(p(strong('Dokumentér i docs/runbooks/:'))),
        li(p(code('docs/runbooks/SEO_INDEXING.md'), txt(' — hvem har adgang til GSC, hvor findes alerts, hvordan re-submitter man sitemap ved fejl'))),
      ),
      h(2, 'Follow-up monitoring'),
      p(txt('2 uger efter submission: tjek GSC "Pages"-rapporten. Forventet: ≥ 100 pages "Indexed" (selvom vi har millioner). Hvis 0 → noget er galt med crawl/indexing.')),
      h(2, 'Acceptance criteria'),
      ul(
        li(p(txt('GSC property verificeret + sitemap submitted'))),
        li(p(txt('Bing Webmaster Tools: samme'))),
        li(p(txt('Runbook i '), code('docs/runbooks/SEO_INDEXING.md'), txt(' med credentials + procedures'))),
        li(p(txt('2-ugers follow-up: bekræft at Google har crawlet mindst 10 sider'))),
      ),
    ],
  },
};

// ─── Ticket 3: Daglig cron i stedet for ugentlig ────────────────────────────

const t3 = {
  summary: 'SEO: skift sitemap-cron fra ugentlig til daglig (hurtigere opdatering af nye properties)',
  priority: 'Medium',
  labels: ['seo', 'sitemap', 'cron', 'vercel'],
  description: {
    type:'doc', version:1, content:[
      h(2, 'Problem'),
      p(txt('Nuværende cadence i '), code('vercel.json'), txt(':')),
      codeBlock(
`{ "path": "/api/cron/generate-sitemap?phase=companies",     "schedule": "0 2 * * 0" },  // søndag 02
{ "path": "/api/cron/generate-sitemap?phase=properties",    "schedule": "0 3 * * 0" },  // søndag 03
{ "path": "/api/cron/generate-sitemap?phase=vp-properties", "schedule": "0 4 * * 0" }   // søndag 04`, 'json'),
      p(txt('Ugentlig = op til 7 dages forsinkelse mellem ny ejendom/virksomhed er i vores DB og den kommer i sitemap. Google crawler heller ikke igen før sitemap viser opdatering. For et datadrevet site som BizzAssist (hvor vi tilføjer nye ejendomme/virksomheder dagligt via EJF bulk-ingest + CVR-opslag) er det alt for langsomt.')),
      h(2, 'Løsning'),
      ul(
        li(p(txt('Skift til daglig — nudge off :00-minutter for at undgå fleet-cluster:'))),
      ),
      codeBlock(
`{ "path": "/api/cron/generate-sitemap?phase=companies",     "schedule": "23 2 * * *" }
{ "path": "/api/cron/generate-sitemap?phase=properties",    "schedule": "37 3 * * *" }
{ "path": "/api/cron/generate-sitemap?phase=vp-properties", "schedule": "51 4 * * *" }`, 'json'),
      p(txt('3 separate phases kører fortsat sekventielt over 3 timer så vi ikke overbelaster Supabase i spidsen.')),
      h(2, 'Ressource-overvejelse'),
      ul(
        li(p(txt('Vercel function-runtime for sitemap-cron: ~10-60 s pr. phase afhængigt af DB-størrelse. Daglig × 3 × 60 s = 180 s/dag = 5400 s/måned. OK inden for Pro-plan.'))),
        li(p(txt('Supabase: mostly read-operations + bulk UPSERT til '), code('sitemap_entries'), txt('. Næsten no-op hvis ingen nye rækker.'))),
        li(p(txt('Ingen Datafordeler-trafik — kun intern DB.'))),
      ),
      h(2, 'Acceptance criteria'),
      ul(
        li(p(code('vercel.json'), txt(' opdateret til daglig schedule.'))),
        li(p(txt('Efter 2 dage på prod: '), code('sitemap_entries'), txt('-tabellen har '), code('max(updated_at)'), txt(' < 26 timer gammel.'))),
        li(p(txt('Ingen Sentry-alerts for stuck/fejlet cron.'))),
      ),
    ],
  },
};

// ─── Ticket 4: Schema.org structured data ──────────────────────────────────

const t4 = {
  summary: 'SEO: tilføj Schema.org structured data til /ejendom/ + /virksomhed/ offentlige sider (JSON-LD)',
  priority: 'Medium',
  labels: ['seo', 'schema-org', 'json-ld', 'structured-data'],
  description: {
    type:'doc', version:1, content:[
      h(2, 'Mål'),
      p(txt('Forbedre Google\'s forståelse + rich-results-chance ved at tilføje Schema.org JSON-LD til offentlige sider. Særligt vigtigt for '), code('/ejendom/'), txt(' (RealEstateListing / Place) og '), code('/virksomhed/'), txt(' (Organization).')),
      h(2, 'Schema-typer'),
      ul(
        li(p(strong('/ejendom/[slug]/[bfe]: '), code('schema:Place'), txt(' (ikke '), code('RealEstateListing'), txt(' da det indikerer til-salg) eller '), code('schema:Residence'), txt(' / '), code('schema:ApartmentComplex'), txt(' afhængigt af anvendelseskode.'))),
        li(p(strong('/virksomhed/[slug]/[cvr]: '), code('schema:Organization'), txt(' med '), code('identifier'), txt(' (CVR), '), code('address'), txt(', '), code('founder'), txt(', '), code('foundingDate'), txt('.'))),
      ),
      h(2, 'Eksempel — Ejendom'),
      codeBlock(
`<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Place",
  "name": "Arnold Nielsens Boulevard 62A",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "Arnold Nielsens Boulevard 62A",
    "postalCode": "2650",
    "addressLocality": "Hvidovre",
    "addressCountry": "DK"
  },
  "geo": { "@type": "GeoCoordinates", "latitude": 55.6364, "longitude": 12.4647 },
  "identifier": { "@type": "PropertyValue", "propertyID": "BFE", "value": "2091165" }
}
</script>`, 'html'),
      h(2, 'Eksempel — Virksomhed'),
      codeBlock(
`<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "JaJR Holding ApS",
  "identifier": { "@type": "PropertyValue", "propertyID": "CVR", "value": "41092807" },
  "address": { "@type": "PostalAddress", "streetAddress": "Søbyvej 11", "postalCode": "2650", "addressLocality": "Hvidovre", "addressCountry": "DK" },
  "foundingDate": "2019-12-18",
  "url": "https://bizzassist.dk/virksomhed/jajr-holding-aps/41092807"
}
</script>`, 'html'),
      h(2, 'Implementering'),
      ul(
        li(p(txt('Render JSON-LD inde i '), code('<head>'), txt(' via Next.js '), code('<Script type="application/ld+json">'), txt(' i '), code('app/(public)/ejendom/[slug]/[bfe]/page.tsx'), txt(' og '), code('app/(public)/virksomhed/[slug]/[cvr]/page.tsx'), txt('.'))),
        li(p(txt('Helper-funktion '), code('app/lib/jsonLd.ts'), txt(': '), code('buildEjendomJsonLd(ejendomData)'), txt(' + '), code('buildVirksomhedJsonLd(cvrData)'), txt('.'))),
        li(p(txt('Validér output via '), code('https://validator.schema.org'), txt(' og '), code('https://search.google.com/test/rich-results'), txt('.'))),
      ),
      h(2, 'Acceptance criteria'),
      ul(
        li(p(txt('Alle '), code('/ejendom/[slug]/[bfe]'), txt('-sider har gyldig '), code('schema:Place'), txt('-JSON-LD.'))),
        li(p(txt('Alle '), code('/virksomhed/[slug]/[cvr]'), txt('-sider har gyldig '), code('schema:Organization'), txt('-JSON-LD.'))),
        li(p(txt('Google Rich Results Test validerer 5 tilfældige sider uden fejl.'))),
        li(p(txt('Schema.org Validator validerer 5 tilfældige sider uden fejl.'))),
      ),
      h(2, 'Bonus'),
      p(txt('Hvis '), code('schema:Place'), txt(' viser sig for generisk, eksperimentér med '), code('schema:ApartmentComplex'), txt(' / '), code('schema:House'), txt(' baseret på '), code('enhedensAnvendelse'), txt('-kode. Google kan give rich snippets for disse.')),
    ],
  },
};

// ─── Kør ────────────────────────────────────────────────────────────────────

const meta = await req('GET', `/rest/api/3/issue/createmeta?projectKeys=${PROJECT}&expand=projects.issuetypes`);
const types = JSON.parse(meta.body).projects?.[0]?.issuetypes ?? [];
const issueType = types.find(t => /^task$/i.test(t.name)) ?? types.find(t => !t.subtask);

for (const tk of [t1, t2, t3, t4]) {
  const res = await req('POST', '/rest/api/3/issue', {
    fields: {
      project: { key: PROJECT },
      summary: tk.summary,
      description: tk.description,
      issuetype: { id: issueType.id },
      priority: { name: tk.priority },
      labels: tk.labels,
    },
  });
  if (res.status === 201) {
    const key = JSON.parse(res.body).key;
    console.log(`✅ ${key} [${tk.priority}]  —  ${tk.summary}`);
    console.log(`   https://${HOST}/browse/${key}`);
  } else {
    console.log(`❌ FAILED (${res.status}) "${tk.summary}":`, res.body.slice(0, 300));
  }
}
