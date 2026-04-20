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
    h(2, 'Alignment-audit + blocker fjernet'),
    p(strong('BIZZ-629 er nu Done'),txt(' (commit 6f0b397/3bfa583) som løser areal-regressionen på ejerlejligheder + erhvervsejendomme via Vurderingsportalen-fallback i enrich-endpointet. Det fjerner blockeren for person-Ejendomme-tab\'en — samme PropertyOwnerCard-komponent bruges på begge sider, så fixet gælder automatisk.')),
    h(3, 'Data-paritet (kontrolleret felt-for-felt)'),
    ul(
      li(p(txt('Adresse, postnr+by, BFE-nummer, ejendomstype, ejerandel, status ✅ samme PropertyOwnerCard'))),
      li(p(txt('Progressive enrichment (areal, vurdering, købesum, købsdato, ejer-specifik salgspris + gevinst) ✅ samme enrich-batch (BIZZ-569/634/638)'))),
      li(p(txt('Ejer-navn + link til detaljeside via dawaId ✅ samme '),code('showOwner'),txt('-prop'))),
    ),
    h(3, 'Funktionel paritet'),
    ul(
      li(p(txt('Sortering aktive/solgte (CVR-hierarki-logik) ✅ samme'))),
      li(p(txt('Klik → detaljeside (Link-wrapper) ✅ samme'))),
      li(p(txt('Progressive loading + LRU-cache ✅ samme enrich-batch'))),
      li(p(txt('Heading-tal inkluderer personligt ejede ✅ (BIZZ-640)'))),
    ),
    h(3, 'Person-specifikke tilføjelser (over virksomheds-features)'),
    ul(
      li(p(txt('"Personligt ejet"-sektion øverst med User-ikon + teal-label (BIZZ-595)'))),
      li(p(txt('Purple medejer-badge når ejerandel < 100% (tidligere BIZZ-596 iter)'))),
    ),
    p(strong('Klar til visuel browser-verifikation: '),code('/dashboard/owners/4000115446'),strong(' ↔ '),code('/dashboard/companies/<cvr>'),strong(' → Ejendomme-tab.'),txt(' Efter deploy af BIZZ-629 fixet forventes samtlige areal-tal at være korrekte på begge sider.')),
  ],
};

const c = await req('POST','/rest/api/3/issue/BIZZ-596/comment',{body});
console.log(c.status===201?'✅ comment':`❌ (${c.status})`);
const tr = await req('POST','/rest/api/3/issue/BIZZ-596/transitions',{transition:{id:'31'}});
console.log(tr.status===204?'✅ BIZZ-596 → In Review':`⚠️ (${tr.status})`);
