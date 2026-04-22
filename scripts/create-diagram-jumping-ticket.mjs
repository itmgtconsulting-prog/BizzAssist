#!/usr/bin/env node
import https from 'node:https';
import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import url from 'node:url';
loadDotenv({
  path: path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', '.env.local'),
});
const HOST = process.env.JIRA_HOST || 'bizzassist.atlassian.net';
const auth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
function req(m, p, b) {
  return new Promise((res, rej) => {
    const d = b ? JSON.stringify(b) : null;
    const r = https.request(
      { hostname: HOST, path: p, method: m, headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json', Accept: 'application/json', ...(d ? { 'Content-Length': Buffer.byteLength(d) } : {}) } },
      (x) => { let y = ''; x.on('data', (c) => (y += c)); x.on('end', () => res({ status: x.statusCode, body: y })); }
    );
    r.on('error', rej);
    if (d) r.write(d);
    r.end();
  });
}
const p = (...c) => ({ type: 'paragraph', content: c });
const txt = (t, m) => (m ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
const strong = (s) => txt(s, [{ type: 'strong' }]);
const code = (s) => txt(s, [{ type: 'code' }]);
const h = (l, t) => ({ type: 'heading', attrs: { level: l }, content: [{ type: 'text', text: t }] });
const li = (...c) => ({ type: 'listItem', content: c });
const ul = (...i) => ({ type: 'bulletList', content: i });

const body = {
  fields: {
    project: { key: 'BIZZ' },
    issuetype: { name: 'Task' },
    priority: { name: 'Medium' },
    summary: 'Diagram hopper / springer — noder flytter sig uroligt under force-simulering',
    labels: ['bug', 'diagram', 'ux', 'person-page', 'virksomhed-page'],
    description: {
      type: 'doc',
      version: 1,
      content: [
        h(2, 'Problem'),
        p(
          txt('Ejerskabs-diagrammet ('),
          code('DiagramForce.tsx'),
          txt(') hopper / springer uforudsigeligt på person- og virksomhedsside — noder bevæger sig fortsat efter siden har loadet, så layoutet bliver svært at læse. Rapporteret på person-siden '),
          code('/dashboard/owners/4000115446'),
          txt(' (Jakob Juul Rasmussen).')
        ),
        h(2, 'Observeret'),
        ul(
          li(p(txt('Diagram med ~20+ noder (virksomheder + personligt ejede ejendomme) lader til aldrig at stabilisere sig.'))),
          li(p(txt('Zoom-niveau 96% — problemet ses også ved 100%.'))),
          li(p(txt('Visuelt: store distancer mellem noder, noder overlapper kanter, eksisterende edges kan krydse flere gange.')))
        ),
        h(2, 'Sandsynlig rodårsag'),
        ul(
          li(
            p(
              strong('d3-force simulation løber ikke til konvergens '),
              txt('— '),
              code('alpha'),
              txt(' decay er for langsom eller '),
              code('alphaTarget'),
              txt(' bliver aldrig 0 når nye noder tilføjes dynamisk (via Udvid-knapperne).')
            )
          ),
          li(
            p(
              strong('Høj node-tæthed '),
              txt('giver ustabil force-balance: collide + link + charge-kræfter kæmper mod hinanden. Kan kræve øget '),
              code('velocityDecay'),
              txt(' (0.6 → 0.8) eller mindre '),
              code('linkDistance'),
              txt('.')
            )
          ),
          li(
            p(
              strong('Dynamisk expand '),
              txt('("Udvid 4" / "Udvid 3"-knapper) tilføjer noder efter initial layout — hver expand restarts simulationen, hvilket får eksisterende noder til at hoppe igen.')
            )
          )
        ),
        h(2, 'Reproduktion'),
        ul(
          li(p(txt('Åbn '), code('/dashboard/owners/4000115446'), txt(' → Diagram-tab på test.bizzassist.dk.'))),
          li(p(txt('Vent 2-3 sek til initial layout er rendered.'))),
          li(p(txt('Observer: noder svinger forskudt frem og tilbage selv uden interaktion.'))),
          li(p(txt('Klik en "Udvid N"-knap → observer at eksisterende noder hopper på ny.')))
        ),
        h(2, 'Acceptance'),
        ul(
          li(p(txt('Initial layout stabiliserer inden for 2 sekunder uden visible node-jitter.'))),
          li(p(txt('"Udvid N"-knap tilføjer nye noder uden at eksisterende noder flytter sig mere end ~20px.'))),
          li(p(txt('Ved 20+ noder skal layout forblive læseligt — ingen ekstreme tætheds-clusters.'))),
          li(p(txt('Dokumentér valgte d3-force-parametre i JSDoc øverst i '), code('DiagramForce.tsx'), txt('.')))
        ),
        h(2, 'Fix-forslag'),
        ul(
          li(
            p(
              strong('Fase 1: '),
              txt('Tune force-parametre — '),
              code('velocityDecay(0.8)'),
              txt(' + '),
              code('alphaMin(0.05)'),
              txt(' + begræns '),
              code('alphaDecay(0.05)'),
              txt(' så simulationen konvergerer hurtigere.')
            )
          ),
          li(
            p(
              strong('Fase 2: '),
              txt('Ved expand — brug '),
              code('simulation.nodes([...existing, ...newNodes])'),
              txt(' med '),
              code('alpha(0.3)'),
              txt(' (ikke 1.0) + fix existing nodes via '),
              code('fx/fy'),
              txt(' i 500ms så de ikke flytter sig.')
            )
          ),
          li(
            p(
              strong('Fase 3: '),
              txt('Overvej '),
              code('dagre'),
              txt(' eller anden deterministisk layout-algoritme for hierarkiske diagrammer — force-directed er uvillig til at konvergere for 20+ noder med mixed types.')
            )
          )
        ),
        h(2, 'Relateret'),
        ul(
          li(p(code('BIZZ-660'), txt(' (On Hold): split DiagramForce.tsx i canvas/node/physics — fysik-engine er det naturlige sted at løse jitter-problemet.'))),
          li(p(code('BIZZ-686'), txt(' (FAIL): personligt ejede ejendomme vises i diagrammet men ikke i Ejendomme-tab — relateret UI-inkonsistens.')))
        ),
      ],
    },
  },
};

const r = await req('POST', '/rest/api/3/issue', body);
if (r.status !== 201) {
  console.error('fail', r.status, r.body.slice(0, 300));
  process.exit(1);
}
const key = JSON.parse(r.body).key;
console.log('✅', key, '— diagram hopper oprettet (To Do, Medium)');
