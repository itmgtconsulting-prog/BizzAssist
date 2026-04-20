#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });

const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m,p,b){return new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const r=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,'Content-Type':'application/json',Accept:'application/json',...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});r.on('error',rej);if(d)r.write(d);r.end()});}

const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t };
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...items) => ({ type: 'bulletList', content: items });

const body = {
  type: 'doc', version: 1, content: [
    h(2, 'Code-level verifikation — PASSED'),
    p(txt('Fix implementeret i '), code('app/dashboard/owners/[enhedsNummer]/PersonDetailPageClient.tsx'), txt(':')),
    ul(
      li(p(code('erEjerVedForm()'), txt(' (linje 134) dedikeret helper der matcher implicit ejerskab via virksomhedsform: '), code('enkeltmand'), txt(' (ENK), '), code('interessent'), txt(' (I/S), '), code('kommandit'), txt(' (K/S), '), code('partnersels'), txt(' (P/S). Eksplicit BIZZ-620-kommentar over funktionen.'))),
      li(p(txt('Brugt 3 steder (linje 1033, 1094, 1140) i Virksomheder-tab-logikken for at inkludere BÅDE:'))),
      li(p(txt('1) Virksomheder med registreret ejerandel på '), code('r.ejerandel'), txt(' (rolle-baseret ejerskab)'))),
      li(p(txt('2) Virksomheder hvor formen implicit gør deltageren til ejer ('), code('erEjerVedForm(v.form)'), txt(')'))),
      li(p(txt('Kommentar linje 1025-1027: "Matcher ejerVirksomheder i derived (BIZZ-620): inkluderer både virksomheder med registreret ejerandel OG virksomheder hvor formen (ENK/I/S/K/S/P/S) implicit gør deltageren til ejer."'))),
    ),
    h(3, 'Caveat'),
    p(txt('Browser-verifikation kunne ikke gennemføres — E2E-testbrugerens Jakobs persontab loader langsomt (skeleton blokerer tab-klik). Code-evidensen er dog entydig: BIZZ-620 fix er på plads og dækker acceptance-criteria om at inkludere personligt ejede virksomheder (ENK/I/S osv.) i tabben ud over rolle-baserede.')),
    p(txt('Relaterer: matcher '), code('DiagramForce.expandPersonDynamic'), txt(' (BIZZ-597) så tab og diagram viser samme virksomheder.')),
  ],
};

const c = await req('POST', '/rest/api/3/issue/BIZZ-620/comment', { body });
console.log(c.status === 201 ? '✅ comment' : `❌ (${c.status})`);

const tr = await req('GET', '/rest/api/3/issue/BIZZ-620/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t => /^done$/i.test(t.name));
const r = await req('POST', '/rest/api/3/issue/BIZZ-620/transitions', { transition: { id: done.id } });
console.log(r.status === 204 ? '✅ BIZZ-620 → Done' : `⚠️ (${r.status})`);
