#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({ path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local') });
const HOST = process.env.JIRA_HOST;
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m,p,b){return new Promise((res,rej)=>{const d=b?JSON.stringify(b):null;const r=https.request({hostname:HOST,path:p,method:m,headers:{Authorization:'Basic '+auth,'Content-Type':'application/json',Accept:'application/json',...(d?{'Content-Length':Buffer.byteLength(d)}:{})}},(x)=>{let y='';x.on('data',c=>y+=c);x.on('end',()=>res({status:x.statusCode,body:y}))});r.on('error',rej);if(d)r.write(d);r.end()});}
const p = (...c) => ({ type:'paragraph', content:c });
const txt = (t,m) => m?{type:'text',text:t,marks:m}:{type:'text',text:t};
const strong = (s) => txt(s,[{type:'strong'}]);
const code = (s) => txt(s,[{type:'code'}]);
const h = (l,t) => ({type:'heading',attrs:{level:l},content:[{type:'text',text:t}]});
const li = (...c) => ({type:'listItem',content:c});
const ul = (...i) => ({type:'bulletList',content:i});

const body = {
  type:'doc', version:1, content:[
    h(2, 'Code-level verifikation — PASSED (Variant A)'),
    p(txt('Fix implementeret — variant A valgt: søgning viser '), strong('både'), txt(' hovedejendom og ejerlejligheder i dropdown.')),
    h(3, 'Code-evidens'),
    ul(
      li(p(code('app/api/search/route.ts:172-191'), txt(' — BIZZ-608: "Behold op til 8 results (hovedejendom + lejligheder)". Subtitle skelner eksplicit: ejerlejlighed viser "Lejlighed · etage.dør · postnr by", hovedejendom/adgangsadresse viser "postnr by".'))),
      li(p(code('app/lib/dar.ts:576, 598, 705'), txt(' — BIZZ-608 queries for DAR_Adresse dækker både adgangsadresser (hovedejendom) OG adresser med etage/dør (ejerlejligheder), mapped som separate resultat-typer.'))),
    ),
    p(txt('Ejerlejligheder og hovedejendom har nu distinkte entries i søgedropdown med tydelig type-label — bruger kan vælge den rigtige fra dropdown.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-608/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('GET','/rest/api/3/issue/BIZZ-608/transitions');
const done = (JSON.parse(tr.body).transitions||[]).find(t=>/^done$/i.test(t.name));
const r = await req('POST','/rest/api/3/issue/BIZZ-608/transitions',{transition:{id:done.id}});
console.log(r.status===204?'✅ BIZZ-608 → Done':`⚠️ (${r.status})`);
