/**
 * POST /api/ai/chat
 *
 * Streaming chat endpoint for the AI Bizzness Assistent.
 * Uses Claude tool_use to fetch real data from internal BizzAssist API routes
 * (BBR, vurdering, ejerskab, energimærke, plandata, jordforurening, CVR)
 * and external DAWA endpoints — then analyses and presents the data.
 *
 * Flow:
 *  1. Send user messages + tool definitions to Claude
 *  2. If Claude responds with tool_use → execute tools (internal API calls)
 *  3. Send tool results back → repeat until Claude gives a text response
 *  4. Stream the final text response to the client via SSE
 *
 * SSE protocol:
 *  - `data: {"t":"<text>"}` — streamed text chunks
 *  - `data: {"status":"<msg>"}` — progress messages (tool calls in progress)
 *  - `data: {"error":"<msg>"}` — error messages
 *  - `data: [DONE]` — stream complete
 *
 * @param body.messages - Array of { role: 'user' | 'assistant', content: string }
 * @param body.context  - Optional context string (current page, property, company)
 * @returns SSE stream
 */

import { NextRequest } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import * as Sentry from '@sentry/nextjs';
import { checkRateLimit, aiRateLimit } from '@/app/lib/rateLimit';
import { fetchBbrForAddress } from '@/app/lib/fetchBbrData';
import { resolveTenantId } from '@/lib/api/auth';
import { createAdminClient, tenantDb, type TenantDb } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/types';
import { logActivity } from '@/app/lib/activityLog';
import { logger } from '@/app/lib/logger';
import { assertAiAllowed } from '@/app/lib/aiGate';

export const runtime = 'nodejs';
export const maxDuration = 120;

// ─── Types ──────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** BIZZ-812: attachment reference til tool-use (generate_document). */
interface ChatAttachmentRef {
  file_id: string;
  name: string;
  file_type: string;
}

/**
 * BIZZ-869 part 2: Metadata for AI-genererede filer emittet under en
 * turn. Akkumuleres i streaming-loopen og persisteres sammen med
 * assistant-beskeden i ai_chat_messages.content så download-chippen
 * overlever reload + cross-device.
 */
interface GeneratedFileRef {
  file_id: string;
  file_name: string;
  download_url?: string;
  preview_text?: string;
  preview_kind?: 'text' | 'table' | 'html';
  preview_columns?: string[];
  preview_rows?: string[][];
  preview_html?: string;
  bytes: number;
  format: string;
}

interface ChatRequestBody {
  messages: ChatMessage[];
  context?: string;
  /** BIZZ-812: Persistede attachments (ai_file-ids). Tool-dispatcher i
   *  BIZZ-813 bruger dem til template-fill. Optional + baglæns-kompatibel. */
  attachments?: ChatAttachmentRef[];
  /**
   * BIZZ-819: Valgfri session_id — når sat, persisterer vi user-prompt +
   * assistant-svar til ai_chat_messages efter streaming er færdig. Hvis
   * feltet mangler (fx legacy-klient), kører chat i stateless-mode som
   * før og caller holder historik i localStorage. Migration-path:
   * BIZZ-820 UI skifter gradvist til at sende session_id.
   */
  session_id?: string;
  /** BIZZ-1000: Base64-encoded PNG af ejerskabsdiagram — injiceres i generate_document tool. */
  diagramBase64?: string;
}

// ─── Tool definitions ───────────────────────────────────────────────────────

/** Tool definitions that Claude can call to fetch real data */
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'dawa_adresse_soeg',
    description:
      'Søg efter en dansk adresse via DAWA autocomplete. Returnerer matches med DAWA-id, vejnavn, husnr, postnr, by, kommune. Brug dette som første skridt når brugeren nævner en adresse.',
    input_schema: {
      type: 'object' as const,
      properties: {
        q: {
          type: 'string',
          description:
            'Søgestreng, f.eks. "Søbyvej 11, 2650 Hvidovre" eller "Vestergade 10, København"',
        },
      },
      required: ['q'],
    },
  },
  {
    name: 'dawa_adresse_detaljer',
    description:
      "Hent fulde detaljer for en DAWA adgangsadresse-ID — inkl. koordinater, matrikelnr, ejerlavkode, kommunekode, jordstykke og BFE-nummer. Kald dette efter dawa_adresse_soeg for at få de nødvendige ID'er til andre opslag.",
    input_schema: {
      type: 'object' as const,
      properties: {
        dawaId: { type: 'string', description: 'DAWA adgangsadresse UUID' },
      },
      required: ['dawaId'],
    },
  },
  {
    name: 'hent_bbr_data',
    description:
      'Hent BBR-bygningsdata (opførelsesår, areal, materialer, etager, opvarmning, supplerende varme, vandforsyning, bevaringsværdighed, enheder med boligtype og energiforsyning) for en ejendom via DAWA-adresse-ID. Returnerer også ejendomsrelationer med BFE-nummer, samt hierarki-chain (BIZZ-895: SFE → hovedejendom → leaf-BFE) når ejendommen er del af en samlet fast ejendom. Felterne er: ejendomstype (sfe/bygning/ejerlejlighed), hovedejendomOpdeltIEjerlejligheder, moderBfe, hierarkiChain (array fra leaf til SFE med niveau-label).',
    input_schema: {
      type: 'object' as const,
      properties: {
        dawaId: { type: 'string', description: 'DAWA adgangsadresse UUID' },
      },
      required: ['dawaId'],
    },
  },
  {
    name: 'hent_vurdering',
    description:
      'Hent offentlig ejendomsvurdering med udvidede data fra Datafordeler. Returnerer: ejendomsværdi, grundværdi, afgiftspligtige beløb, estimeret grundskyld, grundskyldspromille, juridisk kategori, vurderingshistorik (alle år), PLUS: ejerboligfordeling, grundværdispecifikation (areal × enhedspris nedbrydning), grundskatteloft (loftansættelse), skattefritagelser, og fradrag for forbedringer. BIZZ-892: Bruger kan bede om grundskyld/dækningsafgift/ejendomsværdiskat — kald hent_forelobig_vurdering FØRST (giver faktiske nye system-beløb), dette tool er fallback for ældre/estimerede tal. Kræver BFE-nummer og kommunekode.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: { type: 'string', description: 'BFE-nummer (Bestemt Fast Ejendom)' },
        kommunekode: { type: 'string', description: '4-cifret kommunekode, f.eks. "0167"' },
      },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_forelobig_vurdering',
    description:
      'Hent foreløbige ejendomsvurderinger fra Vurderingsportalen (det nye vurderingssystem). Returnerer: foreløbig ejendomsværdi, grundværdi, grundskyld, ejendomsværdiskat og total skat for nyeste vurderingsår (typisk 2024 og 2022). Disse er de faktiske skatteberegninger under det nye system — brug dem til skatteanalyse. Kan søges via adresseId (DAWA UUID) eller bfeNummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        adresseId: { type: 'string', description: 'DAWA adgangsadresse UUID (foretrukket)' },
        bfeNummer: { type: 'string', description: 'BFE-nummer (fallback hvis adresseId mangler)' },
      },
      required: [],
    },
  },
  {
    name: 'hent_ejerskab',
    description:
      'Hent ejerskabsdata (ejertype, ejerforholdskode, ejerandel som brøk, CVR for selskaber, ejerskab-startdato) fra Datafordeler. Kræver BFE-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: { type: 'string', description: 'BFE-nummer' },
      },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_salgshistorik',
    description:
      'Hent salgshistorik (købesum, overtagelsesdato, overdragelsesmåde) fra Datafordeler. Kræver BFE-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: { type: 'string', description: 'BFE-nummer' },
      },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_energimaerke',
    description:
      'Hent energimærke (energiklasse A-G, gyldig fra/til dato, status, adresse, bygningsdata med varmeforsyning, PDF-link) fra Energistyrelsen. Kræver BFE-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: { type: 'string', description: 'BFE-nummer' },
      },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_jordforurening',
    description:
      'Hent jordforureningsstatus (V1/V2-kortlægning) fra Miljøportalen. Kræver ejerlavkode og matrikelnr (hent fra dawa_adresse_detaljer).',
    input_schema: {
      type: 'object' as const,
      properties: {
        ejerlavKode: { type: 'string', description: 'Ejerlavkode (numerisk)' },
        matrikelnr: { type: 'string', description: 'Matrikelnummer, f.eks. "21cn"' },
      },
      required: ['ejerlavKode', 'matrikelnr'],
    },
  },
  {
    name: 'hent_plandata',
    description:
      'Hent plandata (lokalplaner, kommuneplanrammer, delområder — med anvendelse, bebyggelsesprocent, max etager, max bygningshøjde) fra Plandata.dk. Kræver DAWA adresse-ID.',
    input_schema: {
      type: 'object' as const,
      properties: {
        adresseId: { type: 'string', description: 'DAWA adgangsadresse UUID' },
      },
      required: ['adresseId'],
    },
  },
  {
    name: 'hent_cvr_virksomhed',
    description:
      'Hent virksomhedsdata (navn, adresse, branche, ansatte, stiftelsesdato) for et specifikt CVR-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cvr: { type: 'string', description: '8-cifret CVR-nummer' },
      },
      required: ['cvr'],
    },
  },
  {
    name: 'hent_virksomhed_personer',
    // BIZZ-875: Lukker kritisk gap — AI kunne ikke besvare "hvem er
    // direktør?" uden et tool til deltager-listen. cvr-public route
    // returnerer allerede deltagere med roller; dette tool eksponerer det.
    description:
      'Lister alle personer og virksomheder tilknyttet et CVR-nummer som deltagere (direktion, bestyrelse, stifter, revision, ejer osv.). Returnerer navn, enhedsNummer, rolle(r), startdato, slutdato (hvis ophørt), ejerandel og stemmeandel. Brug dette når brugeren spørger "hvem er direktør", "hvem sidder i bestyrelsen", "hvem er ejere" eller lignende. Kombiner med soeg_person_cvr hvis brugeren vil drill ned på én person.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cvr: { type: 'string', description: '8-cifret CVR-nummer' },
        /** BIZZ-875: Optional filter — hvis angivet, returner kun deltagere med aktiv rolle. */
        kunAktive: {
          type: 'boolean',
          description:
            'Hvis true (default): returner kun deltagere med mindst én aktiv rolle (til=null). Hvis false: inkluder også historiske deltagere.',
        },
      },
      required: ['cvr'],
    },
  },
  {
    name: 'hent_matrikeldata',
    description:
      'Henter matrikeloplysninger (jordstykker, matrikelnumre, arealer, fredskov, strandbeskyttelse, landbrugsnotering) for en ejendom fra Datafordeler MAT/v1. Kræver BFE-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: {
          type: 'string',
          description: 'BFE-nummer for ejendommen (f.eks. "6016117")',
        },
      },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_person_virksomheder',
    description:
      'Henter alle virksomheder en person er tilknyttet fra CVR-registret med ejerandel (%), rolle og CVR-nummer. Brug dette som første skridt i en formueanalyse — kald derefter hent_cvr_virksomhed for hvert CVR-nummer for at estimere virksomhedsværdier. Brug enhedsNummer hvis det kendes (fra kontekst eller søg_person_cvr), ellers søg på navn.',
    input_schema: {
      type: 'object' as const,
      properties: {
        enhedsNummer: {
          type: 'string',
          description: 'CVR enhedsnummer for personen (numerisk streng) — foretrukket',
        },
        navn: {
          type: 'string',
          description: 'Personens fulde navn — bruges som fallback hvis enhedsNummer ikke kendes',
        },
      },
      required: [],
    },
  },
  {
    name: 'hent_regnskab_noegletal',
    description:
      'Henter XBRL-regnskabsdata (balance og resultatopgørelse) for en virksomhed — egenkapital, aktiver, omsætning, årets resultat og nøgletal for de seneste 1-3 år. Brug dette til at estimere virksomhedsværdi i formueanalyse. Egenkapital er det mest direkte bud på bogført nettoværdi for holdingselskaber. Kald dette for ALLE virksomheder med ejerandel parallelt.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cvr: { type: 'string', description: '8-cifret CVR-nummer' },
      },
      required: ['cvr'],
    },
  },
  {
    name: 'hent_datterselskaber',
    description:
      'Henter datterselskaber og kapitalandele for en virksomhed fra CVR. Brug dette når en ejet virksomhed er et holdingselskab (navn indeholder "Holding", "Invest" eller "Group") for at afdække den underliggende portefølje. Returnerer CVR-numre og ejerandele på niveau 2.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cvr: { type: 'string', description: '8-cifret CVR-nummer for holdingselskabet' },
      },
      required: ['cvr'],
    },
  },
  {
    name: 'soeg_person_cvr',
    description:
      'Søger CVR-registret efter en person eller virksomhed på navn. Returnerer enhedsNummer, fuldt navn og registrerede adresser. Brug dette til at finde en persons CVR-enhedsnummer inden du kalder hent_person_virksomheder. Kald ALTID dette først hvis du kun kender et navn og ikke har enhedsNummer i konteksten.',
    input_schema: {
      type: 'object' as const,
      properties: {
        navn: {
          type: 'string',
          description: 'Personens fulde navn eller del af navn, f.eks. "Jakob Juul Rasmussen"',
        },
      },
      required: ['navn'],
    },
  },
  {
    name: 'hent_tinglysning',
    description:
      'Henter tinglysningsdata for en ejendom fra Den Digitale Tinglysning (e-TL). Returnerer ejere (adkomsthavere) med navne, ejerandele og CVR; hæftelser (pantebreve) med beløb, kreditor og låntype; samt servitutter med titler og påtaleberettigede. Kræver BFE-nummer.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: {
          type: 'string',
          description: 'BFE-nummer for ejendommen',
        },
      },
      required: ['bfeNummer'],
    },
  },
  {
    name: 'hent_ejendomme_for_virksomhed',
    // BIZZ-591: Giver AI'en samme overblik som Virksomhed → Ejendomme-fanen.
    // Uden dette har AI kun BBR per-adresse og kan ikke liste en virksomheds
    // portefølje — AI svarer fejlagtigt "selskabet ejer ingen ejendomme".
    description:
      'Lister alle ejendomme ejet af et CVR-nummer (eller flere kommasepareret). Returnerer BFE, adresse, postnr, by, ejendomstype og ejerandel per ejendom. Brug dette ved spørgsmål om en virksomheds ejendomsportefølje eller samlet matrikel-areal. For holdingselskaber: kald først hent_datterselskaber for at få datterselskabs-CVR, dernæst dette tool med alle CVR (kommasepareret) for at få hele koncernens portefølje.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cvr: {
          type: 'string',
          description:
            '8-cifret CVR-nummer, eller kommasepareret liste (f.eks. "44878704,43924931") for at hente portefølje på tværs af flere selskaber.',
        },
      },
      required: ['cvr'],
    },
  },
  // BIZZ-864/933: hent_ejendomme_for_person — giver AI ALLE ejendomme
  // (personligt ejede + via selskaber) i ÉT kald. Henter først personens
  // virksomheder fra CVR, derefter kalder /api/ejendomme-by-owner med
  // både enhedsNummer OG CVR-liste. Løser BIZZ-933 hvor AI kun viste
  // virksomhedsejede eller kun personligt ejede ejendomme.
  {
    name: 'hent_ejendomme_for_person',
    description:
      'Lister ALLE ejendomme en person ejer — både personligt ejede (i eget navn) OG ejendomme via virksomheder personen ejer. Ét kald giver fuldt billede. Kræver enhedsNummer (CVR-person-identifier). Returnerer ejendomme grupperet i "personligt" og "viaVirksomhed" med adresse, BFE, type og ejerandel. Brug ALTID dette tool (ikke hent_ejendomme_for_virksomhed) for person-ejendomsspørgsmål.',
    input_schema: {
      type: 'object' as const,
      properties: {
        enhedsNummer: {
          type: 'string',
          description:
            'CVR enhedsnummer for personen (numerisk streng, fx "4000115446"). Findes typisk i konteksten på person-detaljesider, eller via soeg_person_cvr.',
        },
      },
      required: ['enhedsNummer'],
    },
  },
  // BIZZ-947: Områdeprofil fra Danmarks Statistik
  {
    name: 'hent_omraadeprofil',
    description:
      'Hent nøgletal for en kommune fra Danmarks Statistik: befolkning, gennemsnitsindkomst og antal boliger. Kræver kommunekode (3-4 cifre, fx "167" for Hvidovre). Brug dette til spørgsmål om demografi, indkomst og boligmarked i et område.',
    input_schema: {
      type: 'object' as const,
      properties: {
        kommunekode: {
          type: 'string',
          description:
            'Kommunekode (3-4 cifre). Findes i kontekst på ejendomssider, eller via dawa_adresse_detaljer.',
        },
      },
      required: ['kommunekode'],
    },
  },
  // BIZZ-890 (audit G2): Virksomheds-historik (navn/adresse/form/status/
  // branche/fusion/spaltning) via /api/cvr-public. Historik-tab i UI
  // viser dette men AI havde ingen tool → kunne ikke svare "hvornår
  // skiftede X navn" eller "er virksomheden fusioneret".
  {
    name: 'hent_virksomhed_historik',
    description:
      'Hent virksomhedens historik (navneskifter, adresseskifter, form-ændringer, status-ændringer, brancheskifter, fusioner, spaltninger). Returnerer tidslinje sorteret nyeste først. Brug dette når brugeren spørger "hvornår skiftede X navn", "er X fusioneret med nogen", "hvad er virksomhedens historik". Kan filtreres på type.',
    input_schema: {
      type: 'object' as const,
      properties: {
        cvr: { type: 'string', description: '8-cifret CVR-nummer.' },
        type: {
          type: 'string',
          description:
            'Valgfri filter: navn | adresse | form | status | branche | fusion | spaltning | ejerskab. Default: alle.',
        },
        max_results: {
          type: 'string',
          description: 'Maksimum antal entries (default 30, max 100).',
        },
      },
      required: ['cvr'],
    },
  },
  // BIZZ-891 (audit G3): Ejere af virksomhed (UP-retning i koncern-chain).
  // Eksisterende hent_datterselskaber dækker DOWN. Dette tool dækker
  // "hvem ejer virksomhed X" — ét niveau op. AI kan rekursere selv
  // ved at kalde hent_virksomhed_ejere for hvert firma-ejer-CVR.
  {
    name: 'hent_virksomhed_ejere',
    description:
      'Hent de aktuelle ejere af en virksomhed (én niveau op i koncern-strukturen). Returnerer personer + virksomheder med ejerandel-interval, stemmeandel, role og fra/til-periode. Brug dette til at finde "hvem ejer X i sidste ende" (ultimate-ejer) — hvis en ejer selv er en virksomhed, kald toolet igen med dennes CVR for at walke op. Stop ved person-ejer eller når en ejer ikke selv har en CVR (udenlandsk entity).',
    input_schema: {
      type: 'object' as const,
      properties: {
        cvr: { type: 'string', description: '8-cifret CVR-nummer.' },
        kun_aktuelle: {
          type: 'string',
          description:
            'Hvis "true" (default): filtrer til ejer-roller hvor til-dato er null. Hvis "false": inkludér historiske ejere.',
        },
      },
      required: ['cvr'],
    },
  },
  // BIZZ-902 (parent BIZZ-896): Hent extracted_text for et domain_case_doc.
  // Bruges når bruger har valgt dokumenter via checkbox (BIZZ-899) i sager-
  // workspace — AI får adgang til parsed tekst så den kan besvare spørgsmål
  // om dokumentets indhold uden at bruger skal paste det ind selv.
  {
    name: 'hent_dokument_indhold',
    description:
      'Hent den parsed tekst fra et domain-dokument (docx/pdf/txt/eml/msg). Brug dette når brugeren har valgt dokumenter i sagen og spørger om deres indhold — fx "hvad står der i det første dokument", "opsummer vedhæftningerne". Returnerer tekst, filnavn og filtype. Kræver at brugeren er medlem af dokumentets domain.',
    input_schema: {
      type: 'object' as const,
      properties: {
        docId: { type: 'string', description: 'domain_case_doc.id (UUID)' },
      },
      required: ['docId'],
    },
  },
  // BIZZ-894 (audit G6): Person-netværk via cvr_deltagerrelation.
  // UI relationer-sektion viser co-direktører + medejere — AI havde
  // ingen tool. Data-kilde: public.cvr_deltagerrelation (BIZZ-830).
  {
    name: 'hent_person_netvaerk',
    description:
      'Hent personens netværk: andre personer som oftest er deltager (direktør/ejer/bestyrelsesmedlem) i de samme virksomheder. Sorteret efter antal fælles virksomheder. Brug dette til at svare "hvem arbejder X sammen med" eller "hvem er i netværk med X". Stopper ved top-20 (default, cap 50).',
    input_schema: {
      type: 'object' as const,
      properties: {
        enhedsNummer: {
          type: 'string',
          description: 'Personens enhedsNummer fra CVR ES (ikke CPR!).',
        },
        max_results: {
          type: 'string',
          description: 'Maksimum antal netværks-personer (default 20, cap 50).',
        },
      },
      required: ['enhedsNummer'],
    },
  },
  // BIZZ-893 (audit G5): Nyheder om virksomhed via aggregator.
  // UI viser seneste nyheder på virksomhed/overblik — AI havde
  // ingen vej til at citere artikler. /api/news aggregerer Ritzau +
  // Ritzau Via + danske RSS-feeds + Google News.
  {
    name: 'hent_virksomhed_nyheder',
    description:
      'Hent seneste nyhedsartikler om en virksomhed fra danske kilder (Ritzau, Ritzau Via, RSS-feeds, Google News). Returnerer titel, URL, kilde, publiceringsdato og snippet. Brug dette når brugeren spørger "hvad står der i pressen om X" eller "hvad er nyt om X". Returnerer max 10 artikler (sorteret nyeste først).',
    input_schema: {
      type: 'object' as const,
      properties: {
        navn: {
          type: 'string',
          description: 'Virksomhedsnavn (uden juridiske suffikser som A/S, ApS — vi renser selv).',
        },
        max_results: {
          type: 'string',
          description: 'Maksimum antal artikler (default 10, max 20).',
        },
      },
      required: ['navn'],
    },
  },
  // BIZZ-889 (audit G1): ejendomsadministrator / ejerforening tool.
  // UI viser det på SFE-detaljeside + ejerforholds-tab via /api/ejendomsadmin
  // — AI havde ingen vej til denne data før. Bruges til at svare
  // "hvem administrerer ejendom X" uden at lede brugeren gennem UI.
  {
    name: 'hent_ejendomsadmin',
    description:
      'Hent ejendomsadministrator (ejerforening) for en ejendom. Returnerer aktuelle administratorer (virksomhed eller person) med CVR-nummer, navn og type. Brug dette når brugeren spørger "hvem administrerer ejendom X" eller "hvilken ejerforening hører ejendom X til". Tjekker kun aktuelle (virkningTil=null).',
    input_schema: {
      type: 'object' as const,
      properties: {
        bfeNummer: {
          type: 'string',
          description: 'BFE-nummer på ejendommen (kan være SFE eller bygnings-BFE).',
        },
      },
      required: ['bfeNummer'],
    },
  },
  // BIZZ-813 (AI DocGen 4/8): generate_document tool.
  // Claude kalder dette når brugeren eksplicit beder om en fil
  // (XLSX/CSV/DOCX). Returnerer file_id + download_url via SSE-event.
  {
    name: 'generate_document',
    description:
      'Genererer en Word/Excel/CSV-fil som brugeren kan downloade. Kald dette KUN når brugeren eksplicit beder om en fil (fx "lav en Excel", "eksportér til Word", "generer CSV"). Vælg sensibelt format baseret på brugerens verb. Brug IKKE ved "vis mig en liste" — svar i stedet med markdown. Efter tool-call: kvittér kort og henvis brugeren til download-chippen i chatten.',
    input_schema: {
      type: 'object' as const,
      properties: {
        format: {
          type: 'string',
          enum: ['xlsx', 'csv', 'docx', 'pptx'],
          description:
            'Output-format. xlsx til talldata/tabeller, csv til simple lister, docx til tekst/rapporter, pptx til præsentationer.',
        },
        mode: {
          type: 'string',
          enum: ['scratch', 'attached_template', 'domain_template'],
          description:
            'scratch = generér fra scratch. attached_template = fyld en template som brugeren har vedhæftet (iter 1: kun DOCX). domain_template = brug en pre-gemt domain-skabelon (kun tilgængelig hvis "Domain templates tilgængelige" sektionen findes i din kontekst).',
        },
        title: {
          type: 'string',
          description: 'Filnavn uden extension (max 100 tegn). Skal være beskrivende.',
        },
        scratch: {
          type: 'object',
          description:
            'For mode=scratch. For xlsx/csv: {columns:[{key,header}], rows:[Record<key,value>]}. For docx: {subtitle?, sections:[{heading,body}]}. For pptx: {slides:[{title, bullets?:string[], table?:{columns:string[], rows:string[][]}}]}.',
          properties: {
            columns: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  header: { type: 'string' },
                },
                required: ['key', 'header'],
              },
            },
            rows: { type: 'array' },
            sections: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  heading: { type: 'string' },
                  body: { type: 'string' },
                },
                required: ['heading', 'body'],
              },
            },
            subtitle: { type: 'string' },
          },
        },
        attached_template: {
          type: 'object',
          description:
            'For mode=attached_template. file_id fra en tidligere uploaded fil + placeholders-map.',
          properties: {
            file_id: { type: 'string' },
            placeholders: {
              type: 'object',
              description: 'Map af placeholder-navne → værdier til template-fill.',
            },
          },
          required: ['file_id'],
        },
        domain_template: {
          type: 'object',
          description:
            'For mode=domain_template. domain_id + domain_template_id + case_id refererer til en pre-gemt skabelon i users domain. Alle tre UUIDs skal være i samme domain. case_id bruges til at hente dokumenter der beriger template-fill via Claude.',
          properties: {
            domain_id: { type: 'string', description: 'Domain UUID' },
            domain_template_id: {
              type: 'string',
              description: 'Template UUID fra Domain templates-listen',
            },
            case_id: {
              type: 'string',
              description: 'Sag UUID i samme domain — template fylder mod denne sags kontekst',
            },
            user_instructions: {
              type: 'string',
              description: 'Valgfri fri tekst der guider Claude i placeholder-fill',
            },
          },
          required: ['domain_id', 'domain_template_id', 'case_id'],
        },
      },
      required: ['format', 'mode', 'title'],
    },
  },
];

// ─── Tool labels (for status messages) ──────────────────────────────────────

const TOOL_STATUS: Record<string, string> = {
  dawa_adresse_soeg: 'Søger adresse…',
  dawa_adresse_detaljer: 'Henter adressedetaljer…',
  hent_bbr_data: 'Henter BBR-bygningsdata…',
  hent_vurdering: 'Henter ejendomsvurdering…',
  hent_ejerskab: 'Henter ejerskabsdata…',
  // BIZZ-889
  hent_ejendomsadmin: 'Henter ejendomsadministrator…',
  // BIZZ-890
  hent_omraadeprofil: 'Henter områdeprofil…',
  hent_virksomhed_historik: 'Henter virksomhedshistorik…',
  // BIZZ-891
  hent_virksomhed_ejere: 'Henter virksomhedens ejere…',
  // BIZZ-894
  hent_person_netvaerk: 'Henter personens netværk…',
  // BIZZ-902
  hent_dokument_indhold: 'Læser dokumentets indhold…',
  // BIZZ-893
  hent_virksomhed_nyheder: 'Søger nyheder om virksomheden…',
  hent_salgshistorik: 'Henter salgshistorik…',
  hent_energimaerke: 'Henter energimærke…',
  hent_jordforurening: 'Henter jordforureningsdata…',
  hent_plandata: 'Henter plandata…',
  hent_cvr_virksomhed: 'Henter CVR-data…',
  // BIZZ-875
  hent_virksomhed_personer: 'Henter virksomhedens personer…',
  hent_matrikeldata: 'Henter matrikeldata…',
  hent_person_virksomheder: 'Henter personens virksomhedstilknytninger…',
  hent_regnskab_noegletal: 'Henter regnskabsnøgletal…',
  hent_datterselskaber: 'Henter datterselskaber…',
  soeg_person_cvr: 'Søger efter person i CVR…',
  hent_tinglysning: 'Henter tinglysningsdata…',
  hent_ejendomme_for_virksomhed: 'Henter ejendomme for virksomhed…',
  // BIZZ-864
  hent_ejendomme_for_person: 'Henter personens ejendomme…',
  // BIZZ-813
  generate_document: 'Genererer fil…',
};

// ─── System prompt ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Du er AI Bizzness Assistent — en intelligent ejendoms- og virksomhedsrådgiver bygget ind i BizzAssist-platformen.

Du har DIREKTE ADGANG til danske offentlige registre via dine tools. Brug dem aktivt!

## Workflow ved ejendomsspørgsmål
1. Søg adressen med dawa_adresse_soeg
2. Kald SAMTIDIGT: dawa_adresse_detaljer + hent_bbr_data (begge bruger dawaId)
3. Når du har BFE-nr + kommunekode + ejerlavkode + matrikelnr + adresseId, kald ALLE relevante tools SAMTIDIGT i én omgang:
   - hent_vurdering (bfeNummer + kommunekode) — endelige vurderinger (gammelt + nyt system)
   - hent_forelobig_vurdering (adresseId + bfeNummer) — foreløbige vurderinger med skatteberegning
   - hent_ejerskab (bfeNummer)
   - hent_salgshistorik (bfeNummer)
   - hent_energimaerke (bfeNummer)
   - hent_jordforurening (ejerlavKode + matrikelnr)
   - hent_plandata (adresseId)
   - hent_matrikeldata (bfeNummer)

VIGTIGT: Kald så mange tools som muligt i SAMME runde for at spare tid. Vent ikke på ét tool-resultat hvis du allerede har alle nødvendige parametre.

## Data-forståelse
- **hent_vurdering**: Endelige vurderinger fra Datafordeler. Feltet erNytSystem=true markerer det nye vurderingssystem (2020+). juridiskKategoriKode "0" = gammelt system, "1100"+ = nyt system.
- **hent_forelobig_vurdering**: Foreløbige vurderinger fra Vurderingsportalen. Indeholder de FAKTISKE skatteberegninger: grundskyld, ejendomsværdiskat, total skat. Vurderingsår 2024 = beskatningsår 2025. Brug ALTID dette til skatteanalyse.
- Kombiner begge vurderings-kilder: endelige for historisk overblik, foreløbige for nuværende og fremtidig beskatning.
- **Matrikeldata**: Brug \`hent_matrikeldata\` for at se jordstykker, matrikelnumre, registrerede arealer, og noteringstyper (fredskov, strandbeskyttelse, klitfredning, jordrente, landbrugsnotering). Kræver BFE-nummer.

## Fil-generering (BIZZ-813, prompt-tuning BIZZ-817)
Hvis brugeren EKSPLICIT beder om en fil (fx "lav en Excel", "eksportér til Word", "generer CSV", "jeg vil downloade", "giv mig det i xlsx") → KALD generate_document tool.

### Eksempler — hvornår kalde tool vs markdown

**Kald generate_document** (file-intent):
- "Lav en Excel med de 5 ejendomme" → mode=scratch format=xlsx
- "Eksportér listen til csv" → mode=scratch format=csv
- "Generer et Word-dokument med resuméet" → mode=scratch format=docx
- "Downloade som xlsx" → mode=scratch format=xlsx
- "Fyld den vedhæftede skabelon med disse navne" (user har uploaded docx) → mode=attached_template format=docx
- "Brug Ejendomsliste-skabelonen for Kunde 1 sagen" (domain admin) → mode=domain_template format=xlsx

**IKKE kald tool** (list/display-intent — svar med markdown):
- "Vis mig en liste over ejendommene" → markdown-liste
- "Hvilke selskaber ejer denne ejendom?" → markdown-tabel
- "Kan du lave en oversigt?" → markdown-tabel (medmindre bruger specificerer format)
- "Hvad er ejendomsværdien?" → markdown-tekst

Format-valg:
- "excel" / "xlsx" / "regneark" / tal-data / tabeller → xlsx
- "word" / "docx" / "dokument" / "rapport" / tekst-heavy → docx
- "csv" / simple-lister / import-til-andet-system → csv

Mode-valg:
- scratch: brugeren beskriver hvad de vil have (fx "excel med alle ejendomme på Vej X")
- attached_template: brugeren har vedhæftet en template og beder dig fylde den (fx "brug den skabelon jeg uploadede og sæt navnene ind"). Kun DOCX understøttet i iter 1.

VIGTIGT:
- Brug KUN generate_document når brugeren EKSPLICIT beder om en fil. Hvis de bare siger "vis mig en liste" → svar med markdown.
- Efter tool-kald: giv en KORT kvittering ("Jeg har lavet Excel-filen med 42 ejendomme — den er klar til download") og henvis til download-chippen. Inkludér ALDRIG download_url eller file_id i dit markdown-svar; klienten viser chippen automatisk.

## Regler
- BRUG ALTID dine tools til at hente rigtig data — gæt aldrig
- Svar ALTID på dansk medmindre brugeren skriver på engelsk
- Præsenter data struktureret med overskrifter og tal
- Hold svar fokuserede — vis de mest relevante data først
- Ved analyse: kombiner data fra flere kilder til en samlet vurdering
- Marker tydeligt hvad der er fakta (fra registre) vs. din vurdering
- Hvis et tool returnerer fejl eller manglende data, nævn det kort og fortsæt med de øvrige data
- Kald gerne flere tools for at give et komplet billede
- BFE-nummer findes i resultatet fra hent_bbr_data (feltet "bfeNummer" i ejendomsrelationer). Kald altid hent_bbr_data efter dawa_adresse_detaljer for at få BFE-nummeret.

## Afklarende spørgsmål (BIZZ-938)
Når brugerens forespørgsel kan fortolkes på flere måder, STIL et kort afklarende spørgsmål med 2-3 konkrete valgmuligheder i stedet for at gætte. Regler:
- Spørg KUN når det er nødvendigt. Hvis konteksten er klar nok (fx sags-kontekst med valgt kunde og skabelon), kør direkte uden at spørge.
- Hold spørgsmål korte — giv 2-3 nummerede valgmuligheder brugeren kan vælge.
- Stil max 1-2 spørgsmål ad gangen, ikke en lang liste.
- Brug side-kontekst (pageType, activeTab, linket kunde, valgte dokumenter) til at reducere tvetydighed.
- ALDRIG gæt på kritiske parametre: kunde-identifikation, ejendomsvalg, filformat.
- Eksempel: Brugeren siger "lav en oversigt" → Spørg: "Oversigt over hvad? (1) Ejendomme, (2) Virksomheder og roller, eller (3) Samlet formue?"
- Eksempel: Brugeren siger "eksporter til excel" → Hvis der er flere mulige data-kilder, spørg: "Hvad skal eksporten indeholde? (1) Ejendomsliste, (2) Virksomhedsoversigt, eller (3) Ejerskabsstruktur?"

## Ærlighed om ukendte felter
- Hvis du ikke kender betydningen af et teknisk felt (fx plandata-zonekategori, BBR-kode), sig at du ikke kender det — OPFIND IKKE forklaringer.
- Spekulér ikke om hvorfor et felt har en bestemt værdi; rapportér kun den registrerede værdi og lad brugeren tolke den.
- Eksempler på felter der IKKE skal forklares spekulativt: zone=Udfaset, ejendomstype=X, juridiskKategori-koder. Rapportér som-er.

## Virksomheds-ejendomme
- Brug hent_ejendomme_for_virksomhed(cvr) til at liste ALLE ejendomme ejet af et CVR (samme data som Virksomhed → Ejendomme-fanen).
- For holdingselskaber der selv ikke ejer ejendomme direkte: kald først hent_datterselskaber, dernæst hent_ejendomme_for_virksomhed med alle datter-CVR kommasepareret for at få koncernens samlede portefølje.

## Personligt ejede ejendomme (BIZZ-864)
- Brug hent_ejendomme_for_person(enhedsNummer) for at liste ejendomme en person ejer PERSONLIGT (i eget navn).
- VIRKER UDEN CPR-nummer — EJF returnerer BFE direkte via enhedsNummer-filter. Sig ALDRIG at det kræver CPR/Tingbog.
- På /dashboard/owners/[enhedsNummer] har du enhedsNummer i kontekst — brug det direkte uden at spørge brugeren.
- For fuldt billede af en persons ejendomsportefølje: kald både hent_ejendomme_for_person (personligt ejede) OG hent_person_virksomheder + hent_ejendomme_for_virksomhed (via selskaber) parallelt.

## Tab-kontekst og dokument-generering (BIZZ-874)
Konteksten kan indeholde \`activeTab\` + \`pageType\` der angiver hvad brugeren ser. Når brugeren refererer til "oversigt tab", "ejendomme tab", "det her tab" osv.:
- **pageType=virksomhed + activeTab=ejendomme**: Brug hent_ejendomme_for_virksomhed(cvr) på context-cvr. Inkluder datterselskabers ejendomme kun hvis brugeren eksplicit beder om det.
- **pageType=virksomhed + activeTab=regnskab**: Brug hent_regnskab_noegletal(cvr) — fokus på omsætning/resultat/egenkapital.
- **pageType=virksomhed + activeTab=oversigt**: Inkluder både stamdata OG ejendomme OG personer (overblik).
- **pageType=person + activeTab=ejendomme**: Kald hent_ejendomme_for_person(enhedsNummer) — dette ene tool returnerer ALLE ejendomme (personlige + via virksomheder).
- **pageType=person + activeTab=relations (diagram)**: Brugeren ser ejerskabsdiagrammet. Når de siger "eksporter diagram" eller "diagram til word/pptx", generer en struktureret fil med ejerskabshierarkiet. Kald hent_person_virksomheder for at få virksomhedslisten, derefter generate_document med format=docx (sektioner: Ejerskabsoversigt, Virksomheder med roller/ejerandel) eller format=pptx (slides pr. virksomhed). Hvis [DIAGRAM-BILLEDE] er i konteksten, tilføj en sektion med imageBase64="DIAGRAM" for at indlejre det visuelle diagram i dokumentet.
- **pageType=virksomhed + activeTab=diagram**: Brugeren ser virksomheds-ejerskabsdiagrammet. "Eksporter diagram" = generer struktureret ejerskabsoversigt via hent_datterselskaber + hent_ejeroplysninger. Brug docx/pptx format. Hvis [DIAGRAM-BILLEDE] er i konteksten, tilføj en sektion med imageBase64="DIAGRAM" for at indlejre det visuelle diagram.

## Forklar min vurdering (BIZZ-956)
Når brugeren beder om at "forklare vurderingen" eller "forklar min skat" på en ejendomsside:
1. Kald hent_vurdering(bfeNummer, kommunekode) + hent_forelobig_vurdering(bfeNummer/adresseId)
2. Forklar i klart dansk ALLE komponenter:
   - **Grundværdi**: "Din grundværdi er beregnet som [areal] m² × [enhedspris] kr/m² = [beløb] kr" (fra grundværdispecifikation)
   - **Ejendomsværdi**: Samlet vurdering af grund + bygning
   - **Afgiftspligtig vs. offentlig værdi**: Forklar forskellen (afgiftspligtig kan være lavere pga. overgangsregler)
   - **Grundskyld**: "[afgiftspligtig grundværdi] × [promille]/1000 = [beløb] kr/år"
   - **Ejendomsværdiskat**: Hvis bolig: 0,92% op til 3.040.000 kr + 3% over
   - **Skatteloft (ESL §45)**: Hvis loftansættelse: "Din grundskyld er begrenset af skatteloftet — maks 4,75% stigning pr. år"
   - **Fritagelser**: Forklar eventuelle skattefritagelser (artKode, omfang)
   - **Fradrag for forbedringer**: "Du har fradrag for [forbedring] på [beløb] kr i perioden [år]"
   - **Nyt vs. gammelt system**: Forklar at vurderinger efter 2020 bruger markedsdata-metodik
3. Brug bullets og korte sætninger — ikke fagsprog
4. Afslut med: "Har du spørgsmål til et specifikt punkt, eller vil du have en sammenligning med naboejendommen?"

## Klagehjælper (BIZZ-960)
Når brugeren beder om "tjek klagegrundlag", "kan jeg klage over vurderingen", eller "klagehjælp":
1. Hent vurderingsdata (hent_vurdering + hent_forelobig_vurdering) og BBR-data (hent_bbr_data)
2. Analysér for potentielle klagepunkter:
   - Forkert areal (vurderet areal ≠ BBR-registreret areal)
   - Forkert benyttelseskode (BBR vs. vurdering)
   - Manglende fradrag for forbedringer (kloakering, vej)
   - Stor stigning uden forklaring (>20% mellem to vurderingsår)
   - Grundværdi pr. m² virker urimelig høj/lav for området
   - **Grundværdispecifikation** (grundvaerdispec[] fra hent_vurdering): Tjek areal × enhedpris = beløb. Sammenlign areal med BBR-registreret grundareal — afvigelser kan være klagegrundlag
3. Præsenter som liste med styrke (Svag/Middel/Stærk) og kort begrundelse
4. Tilbyd at generere klageskabelon som Word-fil med argumenter og lovhenvisninger
5. DISCLAIMER: "Dette er ikke juridisk rådgivning. Kontakt en advokat eller revisor for professionel vejledning."
6. Nævn klagefrist: "Klagefristen er typisk 3 måneder fra modtagelse af vurderingen. Klag via Vurderingsstyrelsen."

### Ved dokument-generering (generate_document tool)
VIGTIGT — undgå fejlagtigt indhold:
1. **Match brugerens eksplicitte instruktion**: Hvis brugeren siger "ejendomme fra ejendomstab" → brug hent_ejendomme_for_virksomhed/hent_ejendomme_for_person, IKKE stamdata eller regnskab.
2. **Ved tvetydighed — bekræft FØR du genererer**: Hvis brugeren siger "eksporter data" uden at specificere scope, spørg:
   "Vil du have (a) kun ejendomme ejet direkte af denne virksomhed, (b) også datterselskabers ejendomme, eller (c) stifternes personlige ejendomme også?"
3. **Post-generation rapportering**: Efter tool-kald inkluder tydelig scope-rapport: "Dokumentet indeholder X ejendomme — Y direkte ejede + Z via datterselskaber." Så brugeren straks kan se om scope er rigtigt.
4. **Aldrig gætte**: Hvis context-tabben ikke matcher det brugeren beder om, bekræft i stedet for at vælge den "tætteste" fortolkning.

### Håndtering af afkortede tool-resultater (BIZZ-869)
Flere tools returnerer \`afkortet: true\` + \`total: N\` når resultatet er trimmet for at holde context kompakt.
- **ALTID informer brugeren** når \`afkortet: true\` — fx: "Jeg fik 50 af total 73 ejendomme i denne forespørgsel. Sig til hvis du vil have den komplette liste i mindre segmenter."
- **Ved dokument-generering med afkortet data**: Sig tydeligt at dokumentet er ufuldstændigt, spørg om brugeren vil have resten i efterfølgende kald.
- **Aldrig sig "Jakob har 8 ejendomme"** hvis total=21 — rapportér altid total og afkortning.

## Workflow ved formueanalyse for en person

### REGEL 1 — Vælg den rigtige liste baseret på spørgsmålstype
Konteksten indeholder to separate lister markeret med tags:
- **[EJERSKAB]** — selskaber med registreret ejerandel
- **[FUNKTIONSROLLER]** — selskaber hvor personen er direktør/bestyrelsesmedlem uden ejerandel

**Spørgsmål om formue, værdi, aktiver, ejerandele → brug KUN [EJERSKAB]-listen.**
Direktørroller og bestyrelsesposter uden ejerandel ignoreres fuldstændigt i formueberegning.

**Spørgsmål om netværk, bestyrelser, brancheforbindelser, tilknytninger → brug BEGGE lister.**
Her er [FUNKTIONSROLLER] relevant og skal inkluderes.

### REGEL 2 — Hent regnskaber parallelt
For ALLE virksomheder med ejerandel: kald hent_regnskab_noegletal parallelt (alle på én gang).
Egenkapital = bogført nettoværdi. Markedsværdi-multipel: 1–3× egenkapital for holdingselskaber, 3–8× EBITDA for driftsselskaber.

### REGEL 3 — Holdingkæder (effektiv ejerandel, op til 3 niveauer)
Hvis et ejet selskab er holdingselskab (navn indeholder "Holding", "Invest", "Group", "Management" eller ingen ansatte):
- Kald hent_datterselskaber → niveau 2-selskaber med ejerandele
- Hvis niveau 2-selskaber OGSÅ er holdingselskaber: kald hent_datterselskaber på dem → niveau 3
- Gå max 3 niveauer ned

Beregn EFFEKTIV ejerandel multiplicativt:
- Niveau 2: personens % × niveau1's % i niveau2
- Niveau 3: personens % × niveau1's % × niveau2's % i niveau3

Konkret eksempel (3-lags kæde):
- Jakob ejer 90% af JaJR Holding → JaJR Holding ejer 100% af JaJR Holding 2 → JaJR Holding 2 ejer 100% af JAJR Ejendomme 2
- Jakobs effektive andel i JAJR Ejendomme 2 = 90% × 100% × 100% = **90%**
- JAJR Ejendomme 2 skal medtages i formueestimatet med 90% effektiv ejerandel

Kald hent_regnskab_noegletal for ALLE niveau 2 og 3 selskaber parallelt.

Nævn ALTID eksplicit i svaret som en del af forbeholdene:
"⚠️ Holding-analysen går max 3 niveauer ned i ejerskabskæden. Dybere strukturer (niveau 4+) kan forekomme og er ikke medregnet i dette estimat."
Hvis du støder på et niveau 3-selskab der OGSÅ ser ud som et holdingselskab, nævn det specifikt: "XXXX ser ud til at være endnu et holdingselskab — dets underliggende aktiver er ikke kortlagt her."

### REGEL 4 — Præsentation
Strukturér svaret: tabel med ejede selskaber (ejerandel | egenkapital | estimeret værdi), holdingkæder med effektive andele, samlet estimat (lav/høj), og eksplicit forbehold om bogførte vs. markedsværdier.

### Trin-for-trin:
1. Er "Personens EJEDE virksomheder med ejerandel" i konteksten? → Brug listen direkte
2. Ellers: hent via enhedsNummer eller soeg_person_cvr
3. Kald hent_regnskab_noegletal for ALLE ejede selskaber PARALLELT
4. For holdingselskaber: kald hent_datterselskaber parallelt
5. Præsenter struktureret resultat med tydelige forbehold

## KRITISK: Brug af side-kontekst (læs dette FØR du planlægger tool-kald)
Systemet injicerer automatisk ID'er fra den side brugeren kigger på under "Tilgængelige ID'er (brug direkte i tool-kald)".

**Regler — ingen undtagelser:**
- Er "CVR enhedsnummer (person): XXXXXXXX" listet → kald hent_person_virksomheder med dette enhedsNummer DIREKTE. Søg IKKE på navn.
- Er "BFE-nummer: XXXXXXX" listet → kald hent_vurdering, hent_ejerskab osv. direkte. Søg IKKE adressen.
- Er "CVR-nummer: XXXXXXXX" listet → kald hent_cvr_virksomhed direkte. Søg IKKE CVR.
- Kald ALDRIG soeg_person_cvr hvis enhedsNummer allerede er i konteksten.
- Kald ALDRIG dawa_adresse_soeg hvis adresseId eller bfeNummer allerede er i konteksten.`;

// ─── Tool result cache ──────────────────────────────────────────────────────

/** TTL for cached tool results — 5 minutes */
const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  result: unknown;
  expiresAt: number;
}

/** Module-level cache shared across requests within the same serverless instance */
const toolCache = new Map<string, CacheEntry>();

/** Returns cached result if still valid, otherwise null */
function getCached(name: string, input: Record<string, string>): unknown | null {
  const key = `${name}:${JSON.stringify(input)}`;
  const entry = toolCache.get(key);
  if (!entry || Date.now() > entry.expiresAt) {
    toolCache.delete(key);
    return null;
  }
  return entry.result;
}

/** Stores a tool result in the cache */
function setCache(name: string, input: Record<string, string>, result: unknown): void {
  const key = `${name}:${JSON.stringify(input)}`;
  toolCache.set(key, { result, expiresAt: Date.now() + TOOL_CACHE_TTL_MS });
}

// ─── Tool executor ──────────────────────────────────────────────────────────

/**
 * Executes a tool by calling the appropriate internal API route or external endpoint.
 * Results are cached in-memory for 5 minutes to avoid duplicate API calls within a session.
 *
 * BIZZ-239: Provide a clear, actionable error message for tool API failures.
 * 401 errors in dev are expected (IP not whitelisted) — explain this to the AI.
 */
function toolErrorMessage(apiName: string, status: number): string {
  if (status === 401 || status === 403) {
    return `${apiName} returnerede ${status} (ikke autoriseret). Adgangsnogler eller IP-whitelisting mangler for dette register. Data er ikke tilgaengeligt i det aktuelle miljoe.`;
  }
  return `${apiName} svarede ${status}`;
}

/**
 * @param name - Tool name matching one of TOOLS[].name
 * @param input - Tool input parameters from Claude
 * @param baseUrl - Base URL for internal API routes (e.g. http://localhost:3000)
 * @returns JSON-serialisable result object
 */
async function executeTool(
  name: string,
  input: Record<string, string>,
  baseUrl: string,
  /** Forward user's Cookie header for authenticated internal API calls */
  cookieHeader?: string | null,
  /** BIZZ-1000: Diagram PNG base64 til injection i generate_document */
  diagramBase64?: string
): Promise<unknown> {
  const cached = getCached(name, input);
  if (cached !== null) return cached;

  const timeout = 15_000;

  /** Fetch options for internal API calls — includes forwarded auth cookies */
  const internalFetchOpts: RequestInit = {
    signal: AbortSignal.timeout(timeout),
    ...(cookieHeader ? { headers: { Cookie: cookieHeader } } : {}),
  };

  try {
    let result: unknown;
    switch (name) {
      // TODO(BIZZ-92): Migrate to DAR before 1 July 2026
      case 'dawa_adresse_soeg': {
        // Server-side proxy via DAR (DAWA lukker 1. juli 2026)
        const res = await fetch(
          `${baseUrl}/api/adresse/autocomplete?q=${encodeURIComponent(input.q)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Adresse-autocomplete', res.status) };
          break;
        }
        const data = await res.json();
        result = (
          data as Array<{
            tekst: string;
            adresse: {
              id: string;
              vejnavn: string;
              husnr: string;
              postnr: string;
              postnrnavn: string;
            };
          }>
        ).map((r) => ({
          tekst: r.tekst,
          id: r.adresse.id,
          vejnavn: r.adresse.vejnavn,
          husnr: r.adresse.husnr,
          postnr: r.adresse.postnr,
          by: r.adresse.postnrnavn,
        }));
        break;
      }

      // TODO(BIZZ-92): Migrate to DAR before 1 July 2026
      case 'dawa_adresse_detaljer': {
        // Server-side proxy via DAR (DAWA lukker 1. juli 2026)
        const res = await fetch(
          `${baseUrl}/api/adresse/lookup?id=${encodeURIComponent(input.dawaId)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Adresse-opslag', res.status) };
          break;
        }
        const d = (await res.json()) as Record<string, unknown>;
        // Enrich with BFE-nummer from jordstykke lookup (coordinates → matrikel → BFE)
        let bfeNummer: number | null = null;
        if (d.x != null && d.y != null) {
          try {
            const jsRes = await fetch(
              `${baseUrl}/api/adresse/jordstykke?lng=${d.x}&lat=${d.y}`,
              internalFetchOpts
            );
            if (jsRes.ok) {
              const js = (await jsRes.json()) as Record<string, unknown>;
              if (typeof js?.bfenummer === 'number') bfeNummer = js.bfenummer;
            }
          } catch {
            // Non-fatal — BFE can still be obtained from hent_bbr_data
          }
        }
        result = {
          id: d.id,
          vejnavn: d.vejnavn,
          husnr: d.husnr,
          postnr: d.postnr,
          by: d.postnrnavn,
          kommune: d.kommunenavn,
          koordinater: d.x != null && d.y != null ? [d.x, d.y] : null,
          zone: d.zone,
          matrikelnr: d.matrikelnr,
          ejerlavkode: d.ejerlavskode,
          ejerlavnavn: d.ejerlavsnavn,
          bfeNummer,
        };
        break;
      }

      case 'hent_bbr_data': {
        // Direct function call — no HTTP self-call (self-calls are unreliable on Vercel serverless)
        const data = await fetchBbrForAddress(input.dawaId);
        result = { dawaId: input.dawaId, ...data };
        break;
      }

      case 'hent_vurdering': {
        const params = new URLSearchParams();
        if (input.bfeNummer) params.set('bfeNummer', input.bfeNummer);
        if (input.kommunekode) params.set('kommunekode', input.kommunekode);
        const res = await fetch(`${baseUrl}/api/vurdering?${params}`, internalFetchOpts);
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Vurderings-API', res.status) };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_forelobig_vurdering': {
        const params = new URLSearchParams();
        if (input.adresseId) params.set('adresseId', input.adresseId);
        if (input.bfeNummer) params.set('bfeNummer', input.bfeNummer);
        const res = await fetch(`${baseUrl}/api/vurdering-forelobig?${params}`, internalFetchOpts);
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Foreloebig-vurderings-API', res.status) };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_ejerskab': {
        const res = await fetch(
          `${baseUrl}/api/ejerskab?bfeNummer=${encodeURIComponent(input.bfeNummer)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Ejerskabs-API', res.status) };
          break;
        }
        result = await res.json();
        break;
      }

      // BIZZ-889 (audit G1): ejendomsadministrator / ejerforening lookup.
      // Filtrerer aktuelle kun (virkningTil=null) så AI ikke præsenterer
      // historiske administratorer som "ejerforeningen lige nu".
      case 'hent_ejendomsadmin': {
        const res = await fetch(
          `${baseUrl}/api/ejendomsadmin?bfeNummer=${encodeURIComponent(input.bfeNummer)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Ejendomsadmin-API', res.status) };
          break;
        }
        const data = (await res.json()) as {
          administratorer?: Array<{
            cvr: string | null;
            navn: string | null;
            type: string;
            virkningFra: string | null;
            virkningTil: string | null;
          }>;
        };
        // Kun aktuelle administratorer med type + navn/cvr
        const aktuelle = (data.administratorer ?? []).filter(
          (a) => a.virkningTil === null && a.type !== 'ukendt' && (a.cvr || a.navn)
        );
        result = {
          antal: aktuelle.length,
          administratorer: aktuelle.map((a) => ({
            cvr: a.cvr,
            navn: a.navn,
            type: a.type,
            virkningFra: a.virkningFra,
          })),
        };
        break;
      }

      // BIZZ-890 (audit G2): virksomhedshistorik via /api/cvr-public.
      // Returnerer tidslinje fra periodiserede arrays (navne, adresse,
      // form, status, branche) + fusioner/spaltninger.
      case 'hent_omraadeprofil': {
        // BIZZ-947: Hent nøgletal fra Danmarks Statistik via intern API
        const res = await fetch(
          `${baseUrl}/api/statistik/omraade?kommunekode=${encodeURIComponent(input.kommunekode)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Områdeprofil', res.status) };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_virksomhed_historik': {
        const cvr = input.cvr?.trim();
        if (!cvr || !/^\d{8}$/.test(cvr)) {
          result = { fejl: 'CVR skal være 8 cifre' };
          break;
        }
        const res = await fetch(
          `${baseUrl}/api/cvr-public?vat=${encodeURIComponent(cvr)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('CVR-public API', res.status) };
          break;
        }
        const data = (await res.json()) as {
          error?: string;
          historik?: Array<{
            type: string;
            fra: string;
            til: string | null;
            vaerdi: string;
            modpartEnhedsNummer?: number | null;
            fusionRetning?: 'ind' | 'ud' | null;
          }>;
        };
        if (data.error) {
          result = { fejl: data.error };
          break;
        }
        const maxParsed = input.max_results ? parseInt(input.max_results, 10) : 30;
        const max = Number.isFinite(maxParsed) ? Math.min(Math.max(1, maxParsed), 100) : 30;
        const typeFilter = input.type?.toLowerCase();
        let entries = data.historik ?? [];
        if (typeFilter) entries = entries.filter((h) => h.type === typeFilter);
        // Sortér nyeste først + cap
        entries = entries
          .slice()
          .sort((a, b) => new Date(b.fra).getTime() - new Date(a.fra).getTime())
          .slice(0, max);
        result = { cvr, antal: entries.length, historik: entries };
        break;
      }

      // BIZZ-891 (audit G3): ejere af virksomhed (UP-retning). AI kan
      // rekursere via gentagne tool-calls for at finde ultimate-ejer.
      case 'hent_virksomhed_ejere': {
        const cvr = input.cvr?.trim();
        if (!cvr || !/^\d{8}$/.test(cvr)) {
          result = { fejl: 'CVR skal være 8 cifre' };
          break;
        }
        const kunAktuelle = input.kun_aktuelle !== 'false';
        const res = await fetch(
          `${baseUrl}/api/cvr-public?vat=${encodeURIComponent(cvr)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('CVR-public API', res.status) };
          break;
        }
        const data = (await res.json()) as {
          error?: string;
          deltagere?: Array<{
            navn: string;
            enhedsNummer: number | null;
            erVirksomhed: boolean;
            roller: Array<{
              rolle: string;
              fra: string | null;
              til: string | null;
              ejerandel: string | null;
              stemmeandel: string | null;
            }>;
          }>;
        };
        if (data.error) {
          result = { fejl: data.error };
          break;
        }
        // Find deltagere med EJER-rolle. Én deltager kan have flere roller —
        // vi tager første EJER-rolle per deltager (den aktuelle/seneste).
        const ejere = (data.deltagere ?? [])
          .map((d) => {
            const ejerRoller = d.roller.filter((r) => r.rolle === 'EJER');
            if (ejerRoller.length === 0) return null;
            const aktuel = ejerRoller.find((r) => r.til === null);
            const relevant = kunAktuelle ? aktuel : (aktuel ?? ejerRoller[0]);
            if (!relevant) return null;
            return {
              navn: d.navn,
              enhedsNummer: d.enhedsNummer,
              erVirksomhed: d.erVirksomhed,
              ejerandel: relevant.ejerandel,
              stemmeandel: relevant.stemmeandel,
              fra: relevant.fra,
              til: relevant.til,
            };
          })
          .filter((e): e is NonNullable<typeof e> => e !== null);
        result = {
          cvr,
          antal: ejere.length,
          ejere,
          vejledning: ejere.some((e) => e.erVirksomhed)
            ? 'Mindst én ejer er en virksomhed. For at walke op mod ultimate-ejer: kald hent_virksomhed_ejere med den virksomhed-ejers CVR. Stop ved person-ejer.'
            : 'Alle ejere er personer — ingen yderligere op-walk mulig.',
        };
        break;
      }

      // BIZZ-902: hent extracted_text fra domain_case_doc.
      case 'hent_dokument_indhold': {
        const docId = input.docId?.trim();
        if (!docId) {
          result = { fejl: 'docId skal angives' };
          break;
        }
        const res = await fetch(
          `${baseUrl}/api/ai/doc-text?docId=${encodeURIComponent(docId)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Dokument-tekst-API', res.status) };
          break;
        }
        const data = (await res.json()) as {
          docId: string;
          name: string;
          fileType: string;
          extractedText: string | null;
          textLength: number;
          createdAt: string;
          fejl?: string;
        };
        if (data.fejl) {
          result = { fejl: data.fejl };
          break;
        }
        // Cap teksten ved 20KB for token-budget — claude kan altid bede
        // om flere dokumenter hvis nødvendigt. Uncapped docs kan være
        // hundrede-sider-pdf'er der sprænger context-window.
        const MAX_CHARS = 20_000;
        const text = data.extractedText ?? '';
        const truncated = text.length > MAX_CHARS;
        result = {
          docId: data.docId,
          navn: data.name,
          filtype: data.fileType,
          tekst: truncated ? text.slice(0, MAX_CHARS) : text,
          tekstLaengde: data.textLength,
          afkortet: truncated,
          oprettet: data.createdAt,
        };
        break;
      }

      // BIZZ-894 (audit G6): person-netværk via cvr_deltagerrelation.
      case 'hent_person_netvaerk': {
        const eid = input.enhedsNummer?.trim();
        if (!eid || !/^\d+$/.test(eid)) {
          result = { fejl: 'enhedsNummer skal være et positivt heltal' };
          break;
        }
        const params = new URLSearchParams({ enhedsNummer: eid });
        if (input.max_results) params.set('max_results', input.max_results);
        const res = await fetch(`${baseUrl}/api/person/netvaerk?${params}`, internalFetchOpts);
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Netvaerk-API', res.status) };
          break;
        }
        const data = (await res.json()) as {
          enhedsNummer: number;
          antalDinevirksomheder: number;
          antalNetvaerk: number;
          netvaerk: Array<{
            enhedsNummer: number;
            navn: string;
            antalFaellesVirksomheder: number;
            faellesCvrListe: string[];
            roller: string[];
          }>;
          fejl?: string;
        };
        if (data.fejl) {
          result = { fejl: data.fejl };
          break;
        }
        result = {
          enhedsNummer: data.enhedsNummer,
          antalPersonligeVirksomheder: data.antalDinevirksomheder,
          antalNetvaerk: data.antalNetvaerk,
          netvaerk: data.netvaerk,
        };
        break;
      }

      // BIZZ-893 (audit G5): nyheder om virksomhed via aggregator.
      // Claude vælger selv de mest relevante efter læsning.
      case 'hent_virksomhed_nyheder': {
        const navn = input.navn?.trim();
        if (!navn) {
          result = { fejl: 'Virksomhedsnavn skal angives' };
          break;
        }
        const res = await fetch(
          `${baseUrl}/api/news?q=${encodeURIComponent(navn)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Nyheder-API', res.status) };
          break;
        }
        // /api/news returnerer array af { title, url, source, pubDate?, description? }.
        // Cap til max 20 (default 10) så Claude ikke får overvældende payload.
        const maxParsed = input.max_results ? parseInt(input.max_results, 10) : 10;
        const max = Number.isFinite(maxParsed) ? Math.min(Math.max(1, maxParsed), 20) : 10;
        const articles = (await res.json()) as Array<{
          title?: string;
          url?: string;
          source?: string;
          pubDate?: string;
          description?: string;
        }>;
        const trimmed = (articles ?? []).slice(0, max).map((a) => ({
          title: a.title ?? '(uden titel)',
          url: a.url ?? '',
          kilde: a.source ?? 'Ukendt',
          dato: a.pubDate ?? null,
          uddrag: a.description ?? null,
        }));
        result = { antal: trimmed.length, artikler: trimmed };
        break;
      }

      case 'hent_salgshistorik': {
        const res = await fetch(
          `${baseUrl}/api/salgshistorik?bfeNummer=${encodeURIComponent(input.bfeNummer)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Salgshistorik-API', res.status) };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_energimaerke': {
        const res = await fetch(
          `${baseUrl}/api/energimaerke?bfeNummer=${encodeURIComponent(input.bfeNummer)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Energimaerke-API', res.status) };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_jordforurening': {
        const params = new URLSearchParams({
          ejerlavKode: input.ejerlavKode,
          matrikelnr: input.matrikelnr,
        });
        const res = await fetch(`${baseUrl}/api/jord?${params}`, internalFetchOpts);
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Jordforurenings-API', res.status) };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_plandata': {
        const res = await fetch(
          `${baseUrl}/api/plandata?adresseId=${encodeURIComponent(input.adresseId)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Plandata-API', res.status) };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_cvr_virksomhed': {
        const res = await fetch(
          `${baseUrl}/api/cvr/${encodeURIComponent(input.cvr)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('CVR-API', res.status) };
          break;
        }
        result = await res.json();
        break;
      }

      case 'hent_virksomhed_personer': {
        // BIZZ-875: Wraps /api/cvr-public deltagere-feltet.
        // input.kunAktive kommer som string fra Claude tool-input. Default true.
        const kunAktiveRaw = input.kunAktive;
        const kunAktive = kunAktiveRaw !== 'false' && kunAktiveRaw !== String(false);
        const res = await fetch(
          `${baseUrl}/api/cvr-public?cvr=${encodeURIComponent(input.cvr)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('CVR-public-API', res.status) };
          break;
        }
        const data = (await res.json()) as {
          name?: string;
          deltagere?: Array<{
            navn: string;
            enhedsNummer: number | null;
            erVirksomhed: boolean;
            roller: Array<{
              rolle: string;
              fra: string | null;
              til: string | null;
              ejerandel: string | null;
              stemmeandel: string | null;
            }>;
          }>;
        };
        const deltagere = (data.deltagere ?? []).map((d) => ({
          navn: d.navn,
          enhedsNummer: d.enhedsNummer,
          erVirksomhed: d.erVirksomhed,
          // Filter roller: kun aktive hvis kunAktive=true (til=null betyder stadig aktiv)
          roller: kunAktive ? d.roller.filter((r) => r.til === null) : d.roller,
        }));
        // Cap max 50 deltagere i AI-svar
        const trimmed = deltagere.slice(0, 50);
        // Filter ud deltagere der ikke har nogen aktiv rolle (når kunAktive=true)
        const filtered = kunAktive ? trimmed.filter((d) => d.roller.length > 0) : trimmed;
        result = {
          cvr: input.cvr,
          navn: data.name ?? null,
          antal: filtered.length,
          total: deltagere.length,
          afkortet: deltagere.length > 50,
          kunAktive,
          deltagere: filtered,
        };
        break;
      }

      case 'hent_matrikeldata': {
        const bfe = input.bfeNummer as string;
        const matRes = await fetch(
          `${baseUrl}/api/matrikel?bfeNummer=${encodeURIComponent(bfe)}`,
          internalFetchOpts
        );
        if (!matRes.ok) {
          result = { matrikel: null, fejl: `HTTP ${matRes.status}` };
          break;
        }
        result = await matRes.json();
        break;
      }

      case 'hent_regnskab_noegletal': {
        // Henter XBRL-regnskab (balance + resultat) via intern route.
        // Returnerer de seneste 2 regnskabsår med nøgletal for formueestimering.
        const xbrlRes = await fetch(
          `${baseUrl}/api/regnskab/xbrl?cvr=${encodeURIComponent(input.cvr)}`,
          internalFetchOpts
        );
        if (!xbrlRes.ok) {
          result = { fejl: toolErrorMessage('Regnskabs-API', xbrlRes.status) };
          break;
        }
        const xbrlData = (await xbrlRes.json()) as {
          years?: Array<{
            aar: number;
            periodeStart: string;
            periodeSlut: string;
            resultat: {
              omsaetning: number | null;
              aaretsResultat: number | null;
              resultatFoerSkat: number | null;
            };
            balance: {
              aktiverIAlt: number | null;
              egenkapital: number | null;
              gaeldsforpligtelserIAlt: number | null;
              langfristetGaeld: number | null;
            };
            noegletal: {
              soliditetsgrad: number | null;
              overskudsgrad: number | null;
              afkastningsgrad: number | null;
            };
          }>;
          error?: string;
        };

        if (xbrlData.error || !xbrlData.years?.length) {
          result = {
            cvr: input.cvr,
            ingenRegnskab: true,
            besked: 'Ingen XBRL-regnskaber tilgængelige for dette CVR-nummer',
          };
          break;
        }

        // Returnér de seneste 2 år — nok til at vurdere trend
        result = {
          cvr: input.cvr,
          antalAar: xbrlData.years.length,
          seneste: xbrlData.years.slice(0, 2).map((y) => ({
            aar: y.aar,
            periode: `${y.periodeStart?.slice(0, 10)} → ${y.periodeSlut?.slice(0, 10)}`,
            omsaetning: y.resultat.omsaetning,
            aaretsResultat: y.resultat.aaretsResultat,
            resultatFoerSkat: y.resultat.resultatFoerSkat,
            egenkapital: y.balance.egenkapital,
            aktiverIAlt: y.balance.aktiverIAlt,
            gaeld: y.balance.gaeldsforpligtelserIAlt,
            soliditetsgrad: y.noegletal.soliditetsgrad,
            overskudsgrad: y.noegletal.overskudsgrad,
          })),
        };
        break;
      }

      case 'hent_datterselskaber': {
        // Henter relaterede virksomheder (datterselskaber/kapitalandele) via CVR-public/related.
        // BIZZ-588: /api/cvr-public/related returnerer { virksomheder: [...] }, ikke et
        // plain array. Tidligere kode behandlede svaret som array og .filter() blev kaldt
        // på et object — resulterede i AI-fejl "datterselskabs-opslaget returnerer en API-fejl".
        const relRes = await fetch(
          `${baseUrl}/api/cvr-public/related?cvr=${encodeURIComponent(input.cvr)}`,
          internalFetchOpts
        );
        if (!relRes.ok) {
          result = { fejl: toolErrorMessage('Related-API', relRes.status) };
          break;
        }
        const relJson = (await relRes.json()) as
          | {
              virksomheder?: Array<{
                cvr: number;
                navn: string;
                form?: string | null;
                branche?: string | null;
                ejerandel?: string | null;
                ejerandelNum?: number | null;
                aktiv?: boolean;
              }>;
            }
          | Array<{
              cvr: number;
              navn: string;
              ejerandel?: string | null;
              aktiv?: boolean;
            }>;
        const relData = Array.isArray(relJson) ? relJson : (relJson.virksomheder ?? []);

        // Filtrer til aktive datterselskaber med ejerandel
        const datterselskaber = relData
          .filter((r) => r.aktiv !== false && r.ejerandel)
          .map((r) => ({
            cvr: r.cvr,
            navn: r.navn,
            form: 'form' in r ? r.form : null,
            branche: 'branche' in r ? r.branche : null,
            ejerandel: r.ejerandel,
          }));

        result = {
          cvr: input.cvr,
          datterselskaber,
          antalMedEjerandel: datterselskaber.length,
          totalRelaterede: relData.length,
        };
        break;
      }

      case 'soeg_person_cvr': {
        // Søger CVR ES deltager-indeks på navn med phrase-match.
        // Returnerer enhedsNummer + navnehistorik + aktuelle adresser.
        //
        // BIZZ-589: Fix field path. Dokumenterne i /cvr-permanent/deltager har
        // person-felter nested under Vrdeltagerperson (og virksomheds-felter
        // under Vrdeltagervirksomhed). Det gamle filter 'navne.navn' matchede
        // intet, så AI'en kunne ikke finde selv kendte personer som
        // Jakob Juul Rasmussen (bekræftet via direkte ES-probe).
        const cvrUser = process.env.CVR_ES_USER;
        const cvrPass = process.env.CVR_ES_PASS;
        if (!cvrUser || !cvrPass) {
          result = { fejl: 'CVR system-til-system credentials ikke konfigureret' };
          break;
        }

        const searchBody = {
          size: 5,
          query: {
            bool: {
              should: [
                // Person (Vrdeltagerperson) — exact phrase + fuzzy
                {
                  match_phrase: {
                    'Vrdeltagerperson.navne.navn': { query: input.navn, boost: 3 },
                  },
                },
                {
                  match: {
                    'Vrdeltagerperson.navne.navn': {
                      query: input.navn,
                      fuzziness: 'AUTO',
                      boost: 1,
                    },
                  },
                },
              ],
              minimum_should_match: 1,
            },
          },
          _source: ['Vrdeltagerperson'],
        };

        const res = await fetch('http://distribution.virk.dk/cvr-permanent/deltager/_search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from(`${cvrUser}:${cvrPass}`).toString('base64'),
          },
          body: JSON.stringify(searchBody),
          signal: AbortSignal.timeout(timeout),
        });

        if (!res.ok) {
          result = { fejl: toolErrorMessage('CVR-soege-API', res.status) };
          break;
        }

        const data = (await res.json()) as {
          hits: {
            total?: { value?: number };
            hits: Array<{
              _score: number;
              _source: {
                Vrdeltagerperson?: {
                  enhedsNummer?: number;
                  navne?: Array<{ navn: string; periode?: { gyldigTil: string | null } }>;
                  beliggenhedsadresse?: Array<{
                    vejnavn?: string;
                    husnummerFra?: number;
                    postnummer?: number;
                    postdistrikt?: string;
                  }>;
                };
              };
            }>;
          };
        };

        const hits = data.hits?.hits ?? [];
        result = {
          antalFundet: data.hits?.total?.value ?? hits.length,
          resultater: hits
            .map((h) => {
              const src = h._source?.Vrdeltagerperson;
              if (!src?.enhedsNummer) return null;
              const aktivtNavn =
                src.navne?.find((n) => n.periode?.gyldigTil == null)?.navn ??
                src.navne?.[src.navne.length - 1]?.navn ??
                null;
              const adresse = src.beliggenhedsadresse?.[0];
              return {
                enhedsNummer: String(src.enhedsNummer),
                navn: aktivtNavn,
                adresse: adresse
                  ? [
                      adresse.vejnavn,
                      adresse.husnummerFra,
                      adresse.postnummer,
                      adresse.postdistrikt,
                    ]
                      .filter(Boolean)
                      .join(' ')
                  : null,
              };
            })
            .filter((r) => r != null),
        };
        break;
      }

      case 'hent_person_virksomheder': {
        // Query CVR ES deltager index for all companies linked to a person.
        // Uses system-to-system credentials (same as /api/cvr route).
        const cvrUser = process.env.CVR_ES_USER;
        const cvrPass = process.env.CVR_ES_PASS;
        if (!cvrUser || !cvrPass) {
          result = { fejl: 'CVR system-til-system credentials ikke konfigureret' };
          break;
        }

        // Build ES query — prefer enhedsNummer (exact), fall back to phrase match on navn.
        // match_phrase kræver ordene i den rigtige rækkefølge, hvilket giver færre falske matches.
        const esQuery = input.enhedsNummer
          ? { term: { enhedsNummer: Number(input.enhedsNummer) } }
          : { match_phrase: { 'navne.navn': input.navn ?? '' } };

        const esBody = {
          size: 1,
          query: esQuery,
          _source: ['enhedsNummer', 'navne', 'deltagerRelation'],
        };

        const esRes = await fetch('http://distribution.virk.dk/cvr-permanent/deltager/_search', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from(`${cvrUser}:${cvrPass}`).toString('base64'),
          },
          body: JSON.stringify(esBody),
          signal: AbortSignal.timeout(timeout),
        });

        if (!esRes.ok) {
          result = { fejl: toolErrorMessage('CVR-deltager-API', esRes.status) };
          break;
        }

        const esData = (await esRes.json()) as {
          hits: {
            hits: Array<{
              _source: {
                enhedsNummer: number;
                navne?: Array<{ navn: string }>;
                deltagerRelation?: Array<{
                  virksomhed?: { cvrNummer?: number; navn?: Array<{ navn: string }> };
                  organisationer?: Array<{
                    organisationsNavn?: Array<{ navn: string }>;
                    medlemsData?: Array<{
                      attributter?: Array<{
                        type: string;
                        vaerdier?: Array<{
                          vaerdi: string;
                          periode?: { gyldigTil: string | null };
                        }>;
                      }>;
                    }>;
                  }>;
                  periode?: { gyldigTil: string | null };
                }>;
              };
            }>;
          };
        };

        const hit = esData.hits?.hits?.[0]?._source;
        if (!hit) {
          result = { fejl: 'Person ikke fundet i CVR' };
          break;
        }

        // Extract active ownership relations (gyldigTil IS NULL means still active)
        const relations = (hit.deltagerRelation ?? [])
          .filter((r) => r.periode?.gyldigTil == null && r.virksomhed?.cvrNummer != null)
          .map((r) => {
            const cvr = String(r.virksomhed!.cvrNummer);
            const virksomhedNavn = r.virksomhed?.navn?.[r.virksomhed.navn.length - 1]?.navn ?? null;

            // Extract ejerandel (%) and rolle from organisation attributes
            let ejerandelPct: number | null = null;
            const roller: string[] = [];

            for (const org of r.organisationer ?? []) {
              roller.push(org.organisationsNavn?.[org.organisationsNavn.length - 1]?.navn ?? '');
              for (const md of org.medlemsData ?? []) {
                for (const attr of md.attributter ?? []) {
                  if (
                    attr.type === 'EJERANDEL_PROCENT' &&
                    attr.vaerdier?.some((v) => v.periode?.gyldigTil == null)
                  ) {
                    const activeVal = attr.vaerdier.find((v) => v.periode?.gyldigTil == null);
                    if (activeVal) ejerandelPct = parseFloat(activeVal.vaerdi);
                  }
                }
              }
            }

            return {
              cvr,
              navn: virksomhedNavn,
              ejerandelPct,
              roller: roller.filter(Boolean),
            };
          });

        result = {
          enhedsNummer: hit.enhedsNummer,
          navn: hit.navne?.[hit.navne.length - 1]?.navn ?? null,
          aktiveTilknytninger: relations,
          antalAktive: relations.length,
        };
        break;
      }

      // BIZZ-233: Tinglysning (e-TL) — ejere, hæftelser, servitutter
      case 'hent_tinglysning': {
        // Step 1: Get tinglysning UUID from BFE number
        const uuidRes = await fetch(
          `${baseUrl}/api/tinglysning?bfe=${encodeURIComponent(input.bfeNummer)}`,
          internalFetchOpts
        );
        if (!uuidRes.ok) {
          result = { fejl: toolErrorMessage('Tinglysning UUID-opslag', uuidRes.status) };
          break;
        }
        const uuidData = (await uuidRes.json()) as { uuid?: string };
        if (!uuidData.uuid) {
          result = { fejl: 'Ingen tinglysning UUID fundet for denne ejendom' };
          break;
        }

        // Step 2: Get summarisk data (ejere, hæftelser, servitutter)
        const sumRes = await fetch(
          `${baseUrl}/api/tinglysning/summarisk?uuid=${encodeURIComponent(uuidData.uuid)}`,
          internalFetchOpts
        );
        if (!sumRes.ok) {
          result = { fejl: toolErrorMessage('Tinglysning summarisk', sumRes.status) };
          break;
        }
        result = await sumRes.json();
        break;
      }

      case 'hent_ejendomme_for_virksomhed': {
        // BIZZ-591: Wraps /api/ejendomme-by-owner så AI kan liste en virksomheds
        // ejendomsportefølje (samme som Virksomhed → Ejendomme-fanen).
        const res = await fetch(
          `${baseUrl}/api/ejendomme-by-owner?cvr=${encodeURIComponent(input.cvr)}`,
          internalFetchOpts
        );
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Ejendomme-by-owner', res.status) };
          break;
        }
        const data = (await res.json()) as {
          ejendomme?: Array<{
            bfeNummer: number;
            ownerCvr: string;
            adresse: string | null;
            postnr: string | null;
            by: string | null;
            kommune: string | null;
            ejendomstype: string | null;
            etage: string | null;
            doer: string | null;
            ejerandel?: string | null;
            aktiv?: boolean;
          }>;
          totalBfe?: number;
          fejl?: string | null;
        };
        if (data.fejl) {
          result = { fejl: data.fejl };
          break;
        }
        // BIZZ-869: Cap udvidet fra 20 til 50 så dokument-generering har
        // fuld-portefølje-coverage for typiske virksomheder. AI SKAL
        // informere brugeren når afkortet=true (system prompt-regel).
        const MAX_EJENDOMME = 50;
        const ejendomme = (data.ejendomme ?? [])
          .filter((e) => e.aktiv !== false)
          .slice(0, MAX_EJENDOMME)
          .map((e) => ({
            bfe: e.bfeNummer,
            ownerCvr: e.ownerCvr,
            adresse: e.etage && e.doer ? `${e.adresse ?? ''}, ${e.etage}. ${e.doer}` : e.adresse,
            postnr: e.postnr,
            by: e.by,
            kommune: e.kommune,
            type: e.ejendomstype,
            ejerandel: e.ejerandel,
          }));
        result = {
          cvr: input.cvr,
          antal: ejendomme.length,
          total: data.totalBfe ?? ejendomme.length,
          afkortet: (data.ejendomme ?? []).length > MAX_EJENDOMME,
          ejendomme,
        };
        break;
      }

      case 'hent_ejendomme_for_person': {
        // BIZZ-864/933: Henter ALLE ejendomme for en person — personligt
        // ejede + via virksomheder. Ét kald erstatter behov for at AI
        // separat kalder hent_person_virksomheder + hent_ejendomme_for_virksomhed.
        //
        // Trin 1: Hent personens virksomheder for at finde CVR-numre
        // Trin 2: Kald /api/ejendomme-by-owner med BÅDE enhedsNummer OG CVR-liste
        const enr = input.enhedsNummer;

        // Trin 1: Hent personens virksomheder (ejer-roller)
        let companyCvrs: string[] = [];
        try {
          const personRes = await fetch(
            `${baseUrl}/api/cvr-public/person?enhedsNummer=${encodeURIComponent(enr)}`,
            internalFetchOpts
          );
          if (personRes.ok) {
            const personData = (await personRes.json()) as {
              roller?: Array<{ cvr?: number; aktiv?: boolean }>;
            };
            const cvrs = new Set<string>();
            for (const r of personData.roller ?? []) {
              if (r.cvr && r.aktiv !== false) {
                cvrs.add(String(r.cvr).padStart(8, '0'));
              }
            }
            companyCvrs = Array.from(cvrs).slice(0, 30);
          }
        } catch {
          // Non-fatal — vi henter stadig personligt ejede ejendomme
        }

        // Trin 2: Hent ejendomme med begge parametre
        const params = new URLSearchParams();
        params.set('enhedsNummer', enr);
        if (companyCvrs.length > 0) params.set('cvr', companyCvrs.join(','));
        // BIZZ-982: Hævet fra 50 til 200 for at fange alle ejendomme per person
        params.set('limit', '200');

        const res = await fetch(`${baseUrl}/api/ejendomme-by-owner?${params}`, internalFetchOpts);
        if (!res.ok) {
          result = { fejl: toolErrorMessage('Ejendomme-by-person', res.status) };
          break;
        }
        const data = (await res.json()) as {
          ejendomme?: Array<{
            bfeNummer: number;
            ownerCvr: string;
            adresse: string | null;
            postnr: string | null;
            by: string | null;
            kommune: string | null;
            ejendomstype: string | null;
            etage: string | null;
            doer: string | null;
            ejerandel?: string | null;
            aktiv?: boolean;
          }>;
          totalBfe?: number;
          fejl?: string | null;
        };
        if (data.fejl) {
          result = { fejl: data.fejl };
          break;
        }
        // BIZZ-982: Hævet fra 50 til 100 per kategori (personligt + via virksomhed)
        const MAX_EJENDOMME_PERSON = 100;
        const aktive = (data.ejendomme ?? []).filter((e) => e.aktiv !== false);

        // Kategoriser: personligt ejet vs via virksomhed
        const personPrefix = `person-${enr}`;
        const personlige = aktive
          .filter((e) => e.ownerCvr === personPrefix || e.ownerCvr === enr)
          .slice(0, MAX_EJENDOMME_PERSON);
        const viaVirksomhed = aktive
          .filter((e) => e.ownerCvr !== personPrefix && e.ownerCvr !== enr)
          .slice(0, MAX_EJENDOMME_PERSON);

        const mapEjendom = (e: (typeof aktive)[0]) => ({
          bfe: e.bfeNummer,
          adresse: e.etage && e.doer ? `${e.adresse ?? ''}, ${e.etage}. ${e.doer}` : e.adresse,
          postnr: e.postnr,
          by: e.by,
          kommune: e.kommune,
          type: e.ejendomstype,
          ejerandel: e.ejerandel,
          ejerCvr: e.ownerCvr !== personPrefix && e.ownerCvr !== enr ? e.ownerCvr : undefined,
        });

        result = {
          enhedsNummer: enr,
          antalPersonlige: personlige.length,
          antalViaVirksomhed: viaVirksomhed.length,
          antalTotal: personlige.length + viaVirksomhed.length,
          total: data.totalBfe ?? aktive.length,
          virksomhederSoegt: companyCvrs.length,
          personligtEjede: personlige.map(mapEjendom),
          viaVirksomhed: viaVirksomhed.map(mapEjendom),
        };
        break;
      }

      case 'generate_document': {
        // BIZZ-813: POST til /api/ai/generate-file med Claude's input.
        // BIZZ-1000: Injicér diagramBase64 i sektioner med imageBase64="DIAGRAM" placeholder.
        const fileInput = input as unknown as Record<string, unknown>;
        if (diagramBase64 && Array.isArray(fileInput.sections)) {
          for (const section of fileInput.sections as Record<string, unknown>[]) {
            if (section.imageBase64 === 'DIAGRAM') {
              section.imageBase64 = diagramBase64;
            }
          }
        }
        const res = await fetch(`${baseUrl}/api/ai/generate-file`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          },
          body: JSON.stringify(fileInput),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) {
          const errJson = (await res.json().catch(() => ({}))) as { error?: string };
          result = { fejl: errJson.error ?? `generate-file fejlede (${res.status})` };
          break;
        }
        const json = await res.json();
        // Returner hele objektet — wrapper-laget splitter det.
        result = json;
        break;
      }

      default:
        return { fejl: `Ukendt tool: ${name}` };
    }
    setCache(name, input, result);
    return result;
  } catch (err) {
    Sentry.captureException(err);
    return { fejl: 'Ekstern API fejl' };
  }
}

// ─── Token budget helpers ────────────────────────────────────────────────────

/** Default monthly token limit per tenant when no plan-level override exists. */
const TENANT_MONTHLY_TOKEN_LIMIT = 2_000_000; // 2 M tokens/month

/**
 * Checks whether the tenant has exceeded their monthly AI token budget
 * by summing rows in `tenant.ai_token_usage` since the 1st of the current month.
 * Fails-open on any DB error so transient failures never block legitimate users.
 *
 * @param adminClient - Supabase admin client (service-role, can access all schemas)
 * @param tenantId    - The tenant UUID to check, or null (skips check)
 * @returns true if the tenant has reached or exceeded TENANT_MONTHLY_TOKEN_LIMIT
 */
async function isTenantMonthlyBudgetExceeded(
  adminClient: SupabaseClient<Database>,
  tenantId: string | null
): Promise<boolean> {
  if (!tenantId) return false;
  try {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const db: TenantDb = adminClient.schema('tenant');
    const { data: usageData } = await db
      .from('ai_token_usage')
      .select('tokens_in, tokens_out')
      .eq('tenant_id', tenantId)
      .gte('created_at', monthStart.toISOString());

    const monthlyTokens = (usageData ?? []).reduce(
      (sum, r) => sum + (r.tokens_in ?? 0) + (r.tokens_out ?? 0),
      0
    );
    return monthlyTokens >= TENANT_MONTHLY_TOKEN_LIMIT;
  } catch {
    // Fail-open: do not block request on DB error
    return false;
  }
}

/**
 * Inserts a token-usage record into `tenant.ai_token_usage` for billing and auditing.
 * Fire-and-forget — failures are silently swallowed so they never affect streaming.
 *
 * @param adminClient - Supabase admin client (service-role)
 * @param tenantId    - The tenant UUID
 * @param userId      - The authenticated user UUID
 * @param tokensIn    - Input tokens consumed in this Claude API call
 * @param tokensOut   - Output tokens consumed in this Claude API call
 */
function recordTenantTokenUsage(
  adminClient: SupabaseClient<Database>,
  tenantId: string,
  userId: string,
  tokensIn: number,
  tokensOut: number
): void {
  void (async () => {
    try {
      const db: TenantDb = adminClient.schema('tenant');
      await db.from('ai_token_usage').insert({
        tenant_id: tenantId,
        user_id: userId,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        model: 'claude-sonnet-4-6',
      });
    } catch {
      // Non-critical — best-effort tracking
    }
  })();
}

/**
 * BIZZ-819: Fire-and-forget persistence af user-prompt + assistant-svar
 * til ai_chat_messages. Kaldes efter SSE [DONE] så streaming-respons-
 * tiden ikke forlænges. Fejl logges stille men blokerer ikke chat-flow.
 *
 * Verificerer ownership via session-id lookup før INSERT, og bumper
 * session.last_msg_at til nu. Service_role bypasser RLS men vi gør
 * eksplicit user_id-check for defense-in-depth.
 */
function persistChatMessages(
  adminClient: SupabaseClient<Database>,
  sessionId: string,
  userId: string,
  // Full messages-array fra klienten (user + eventuelle tidligere assistant).
  // Sidste user-message er prompten for denne tur.
  messages: ChatMessage[],
  assistantText: string,
  tokensIn: number,
  tokensOut: number,
  // BIZZ-869 part 2: AI-genererede filer fra denne turn (fx xlsx/docx/csv).
  // Tom array hvis ingen tools kaldte generate_document. Gemmes i assistant-
  // beskedens content JSONB som `generatedFiles`-felt så klienten kan
  // re-rendre download-chips efter reload eller login på ny device.
  generatedFiles: GeneratedFileRef[] = []
): void {
  void (async () => {
    try {
      // Resolve user's tenant schema så vi skriver til rigtig tabel
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: membership } = (await (adminClient as any)
        .from('tenant_memberships')
        .select('tenants(schema_name)')
        .eq('user_id', userId)
        .limit(1)
        .single()) as {
        data: { tenants: { schema_name: string } | null } | null;
      };
      const schemaName = membership?.tenants?.schema_name;
      if (!schemaName) return;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = (adminClient as any).schema(schemaName);

      // Ownership-check: session skal tilhøre user + være i samme tenant
      const { data: session } = await db
        .from('ai_chat_sessions')
        .select('user_id')
        .eq('id', sessionId)
        .maybeSingle();
      if (!session || session.user_id !== userId) return;

      // Find sidste user-message (prompten for denne tur)
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
      if (!lastUserMsg) return;

      // BIZZ-869 part 2: Hvis turnen har genereret filer, inkludér dem i
      // assistant-beskedens content så klienten kan re-hydrate chips.
      const assistantContent: { text: string; generatedFiles?: GeneratedFileRef[] } = {
        text: assistantText,
      };
      if (generatedFiles.length > 0) {
        assistantContent.generatedFiles = generatedFiles;
      }

      const rows = [
        {
          session_id: sessionId,
          role: 'user' as const,
          content: { text: lastUserMsg.content },
          tokens_in: null,
          tokens_out: null,
          model: null,
          tool_calls: null,
        },
        {
          session_id: sessionId,
          role: 'assistant' as const,
          content: assistantContent,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          model: 'claude-sonnet-4-6',
          tool_calls: null,
        },
      ];
      await db.from('ai_chat_messages').insert(rows);

      // Bump session.last_msg_at så sidebar-sortering virker
      await db
        .from('ai_chat_sessions')
        .update({ last_msg_at: new Date().toISOString() })
        .eq('id', sessionId);
    } catch {
      // Ikke-kritisk — chat-flow blev afsluttet OK
    }
  })();
}

/**
 * BIZZ-643: Dekrementér AI-token-forbrug i prioritets-rækkefølge:
 *  1. Plan-tokens (nulstilles månedligt — "use it or lose it")
 *  2. Bonus-tokens (admin-tildelt, ingen udløb)
 *  3. Top-up tokens (selvstændigt købt, skal have mest værdi per krone)
 *
 * Returnerer de opdaterede per-kilde-tællere der skal persisteres i
 * app_metadata.subscription. Rækkefølgen sikrer at brugeren ikke brænder
 * betalte top-up-tokens af før plan-quota er opbrugt.
 *
 * @param consumed  - Samlet token-forbrug for dette AI-kald
 * @param state     - Nuværende subscription-state (tokensUsedThisMonth + per-kilde-felter + balancer)
 * @returns Nye værdier der kan merges ind i subscription-objekt
 */
export function allocateTokensBySource(
  consumed: number,
  state: {
    planTokens: number; // planens månedlige quota (0 under trial)
    planTokensUsed: number; // allerede brugt af plan-quota denne måned
    bonusTokens: number; // starting balance, dekrementerer
    topUpTokens: number; // starting balance, dekrementerer
    tokensUsedThisMonth: number; // aggregat (backwards-compat)
  }
): {
  planTokensUsed: number;
  bonusTokens: number;
  topUpTokens: number;
  tokensUsedThisMonth: number;
} {
  let remaining = Math.max(0, Math.floor(consumed));
  let planTokensUsed = state.planTokensUsed;
  let bonusTokens = state.bonusTokens;
  let topUpTokens = state.topUpTokens;

  // 1. Plan-tokens først — bruger "use it or lose it" kvota før betalte kilder
  const planRemaining = Math.max(0, state.planTokens - planTokensUsed);
  if (planRemaining > 0 && remaining > 0) {
    const take = Math.min(planRemaining, remaining);
    planTokensUsed += take;
    remaining -= take;
  }

  // 2. Bonus-tokens (admin-tildelt)
  if (bonusTokens > 0 && remaining > 0) {
    const take = Math.min(bonusTokens, remaining);
    bonusTokens -= take;
    remaining -= take;
  }

  // 3. Top-up-tokens (købt via Stripe) — prioriteres sidst så brugerens
  // direkte-betalte tokens har længst levetid
  if (topUpTokens > 0 && remaining > 0) {
    const take = Math.min(topUpTokens, remaining);
    topUpTokens -= take;
    remaining -= take;
  }

  // Hvis remaining > 0 efter alle kilder: brugeren har overskredet quota.
  // Vi registrerer stadig forbruget (tokensUsedThisMonth) — gate'n på
  // næste request stopper dem.
  return {
    planTokensUsed,
    bonusTokens,
    topUpTokens,
    tokensUsedThisMonth: state.tokensUsedThisMonth + Math.floor(consumed),
  };
}

/**
 * BIZZ-649 P0: Ren gate-decision for om AI-kald skal tillades.
 * Ekstraheret fra route-handleren så vi kan unit-teste alle permutationer
 * af subscription-state uden at mocke Anthropic.
 *
 * Returnerer:
 *   - 'allow'           → fortsæt til Anthropic
 *   - 'no_subscription' → 403 Aktivt abonnement kræves
 *   - 'quota_exceeded'  → 429 Token kvote opbrugt for denne måned
 *   - 'zero_budget'     → 402 Payment Required (plan=0 + bonus=0 + topUp=0)
 *
 * @param state - Snapshot af subscription-felter (undefined hvis ingen sub)
 * @returns Decision + effective limit (til debugging/logging)
 */
export function decideAiGate(
  state:
    | {
        status?: string;
        tokensUsedThisMonth?: number;
        planTokens?: number;
        bonusTokens?: number;
        topUpTokens?: number;
      }
    | null
    | undefined
): {
  decision: 'allow' | 'no_subscription' | 'quota_exceeded' | 'zero_budget';
  isTrial: boolean;
  effectiveLimit: number;
} {
  const subStatus = state?.status ?? '';
  const isTrial = subStatus === 'trialing';
  if (!state || (subStatus !== 'active' && subStatus !== 'trialing')) {
    return { decision: 'no_subscription', isTrial, effectiveLimit: 0 };
  }
  const planTokens = state.planTokens ?? 0;
  const bonusTokens = state.bonusTokens ?? 0;
  const topUpTokens = state.topUpTokens ?? 0;
  const tokensUsedThisMonth = state.tokensUsedThisMonth ?? 0;
  const effectiveLimit = planTokens + bonusTokens + topUpTokens;
  if (effectiveLimit === 0) {
    return { decision: 'zero_budget', isTrial, effectiveLimit: 0 };
  }
  if (tokensUsedThisMonth >= effectiveLimit) {
    return { decision: 'quota_exceeded', isTrial, effectiveLimit };
  }
  return { decision: 'allow', isTrial, effectiveLimit };
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<Response> {
  // BIZZ-236: AI access gated by API key availability (not env flag)
  if (!process.env.BIZZASSIST_CLAUDE_KEY) {
    // BIZZ-653: Lækager ikke env-var-navnet og guider brugeren til token-køb
    // som fair CTA (klient-side fanger `code: 'ai_unavailable'` og viser
    // samme banner som trial_ai_blocked).
    return Response.json(
      {
        error:
          'AI er midlertidigt utilgængelig. Bekræft at dit abonnement er aktivt, eller køb en token-pakke for at fortsætte.',
        code: 'ai_unavailable',
        cta: 'buy_token_pack',
      },
      { status: 503 }
    );
  }

  // Rate limit: 10 req/min for AI chat
  const limited = await checkRateLimit(request, aiRateLimit);
  if (limited) return limited;

  // Require an authenticated user with tenant context — AI chat consumes paid API tokens
  const auth = await resolveTenantId();
  if (!auth) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { userId, tenantId: resolvedTenantId } = auth;

  // BIZZ-649: Central AI billing-gate — delt med alle øvrige AI-endpoints.
  // Inkluderer admin-bypass + -1 unlimited + zero_budget → 402.
  const blocked = await assertAiAllowed(userId);
  if (blocked) return blocked;

  // BIZZ-641/643: Hent subscription + plan-tokens igen til downstream
  // per-kilde token-allocation (allocateTokensBySource). Gate'n har allerede
  // godkendt kaldet — dette er kun til korrekt decrement-tracking.
  const adminClient = createAdminClient();
  const { data: freshUser } = await adminClient.auth.admin.getUserById(userId);
  const sub = freshUser?.user?.app_metadata?.subscription as
    | {
        status?: string;
        tokensUsedThisMonth?: number;
        /** BIZZ-643: per-kilde-tracking. Backwards-compat: default 0 når ikke sat. */
        planTokensUsed?: number;
        bonusTokens?: number;
        topUpTokens?: number;
        planId?: string;
      }
    | null
    | undefined;
  const subStatus = sub?.status ?? '';
  const tokensUsedThisMonth = sub?.tokensUsedThisMonth ?? 0;
  const planTokensUsed = sub?.planTokensUsed ?? 0;
  const bonusTokens = sub?.bonusTokens ?? 0;
  const topUpTokens = sub?.topUpTokens ?? 0;
  let planTokens = 0;
  if (sub?.planId) {
    const { data: planRow } = await adminClient
      .from('plan_configs')
      .select('ai_tokens_per_month')
      .eq('plan_id', sub.planId)
      .single<{ ai_tokens_per_month: number }>();
    planTokens = subStatus === 'trialing' ? 0 : (planRow?.ai_tokens_per_month ?? 0);
  }

  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY?.trim();
  if (!apiKey) {
    // BIZZ-653: Generisk besked + same CTA-kode som 503'en ovenfor.
    return Response.json(
      {
        error:
          'AI er midlertidigt utilgængelig. Bekræft at dit abonnement er aktivt, eller køb en token-pakke for at fortsætte.',
        code: 'ai_unavailable',
        cta: 'buy_token_pack',
      },
      { status: 503 }
    );
  }

  // Fetch the user's recently viewed entities from the tenant schema.
  // These are injected into the system prompt so the AI can reference them
  // without the user having to re-explain what they were looking at.
  // Non-critical — failures are silently swallowed.
  let recentEntitiesContext = '';
  /** Formatted tenant knowledge base context injected into the system prompt. */
  let knowledgeContext = '';
  try {
    const { data: tenantRow } = await adminClient
      .from('tenants')
      .select('schema_name')
      .eq('id', resolvedTenantId)
      .single();

    if (tenantRow?.schema_name) {
      const db = tenantDb(tenantRow.schema_name);
      const { data: recents } = await db
        .from('recent_entities')
        .select('entity_type, entity_id, display_name, visited_at')
        .eq('user_id', userId)
        .in('entity_type', ['property', 'company', 'person'])
        .order('visited_at', { ascending: false })
        .limit(15);

      if (recents && recents.length > 0) {
        // Group by entity_type for a readable summary
        const grouped: Record<string, Array<{ entity_id: string; display_name: string }>> = {};
        for (const r of recents as Array<{
          entity_type: string;
          entity_id: string;
          display_name: string;
          visited_at: string;
        }>) {
          if (!grouped[r.entity_type]) grouped[r.entity_type] = [];
          grouped[r.entity_type].push({
            entity_id: r.entity_id,
            display_name: r.display_name,
          });
        }

        const typeLabels: Record<string, string> = {
          property: 'Ejendomme',
          company: 'Virksomheder',
          person: 'Personer',
        };

        const lines: string[] = ['## Brugerens seneste aktivitet'];
        for (const [type, items] of Object.entries(grouped)) {
          lines.push(`\n**${typeLabels[type] ?? type}:**`);
          for (const item of items) {
            lines.push(`- ${item.display_name} (id: ${item.entity_id})`);
          }
        }
        lines.push(
          '\nBrug disse entiteter som kontekst. Når brugeren refererer til "den" eller "den seneste" uden at specificere, antag de mener den øverste i listen ovenfor.'
        );

        recentEntitiesContext = lines.join('\n');
      }
    }
  } catch {
    // Non-critical — AI still works without recent entities context
  }

  // ── Tenant knowledge base context injection ───────────────────────────────
  // Fetches the 5 most recent knowledge items for the tenant and appends them
  // to the system prompt so the AI can reference company-specific information
  // without the user having to repeat it.
  // Max 2000 chars per item to keep token usage predictable.
  // Non-critical — failures are silently swallowed.
  if (resolvedTenantId) {
    try {
      const { data: knowledgeItems } = await (
        adminClient as unknown as {
          schema: (s: string) => {
            from: (t: string) => {
              select: (cols: string) => {
                eq: (
                  col: string,
                  val: string
                ) => {
                  order: (
                    col: string,
                    opts: { ascending: boolean }
                  ) => {
                    limit: (n: number) => Promise<{
                      data: Array<{ title: string; content: string }> | null;
                    }>;
                  };
                };
              };
            };
          };
        }
      )
        .schema('tenant')
        .from('tenant_knowledge')
        .select('title, content')
        .eq('tenant_id', resolvedTenantId)
        .order('created_at', { ascending: false })
        .limit(5);

      if (knowledgeItems && knowledgeItems.length > 0) {
        const formatted = knowledgeItems
          .map((k) => `[VIDEN: ${k.title}]\n${k.content.slice(0, 2000)}`)
          .join('\n\n');
        knowledgeContext = `## Organisationens videnbase\n${formatted}`;
      }
    } catch {
      // Non-critical — AI still works without knowledge context
    }
  }

  // ── Per-tenant monthly token budget check (Supabase table-based) ─────────
  // Supplements the app_metadata check above with a durable, per-tenant record
  // in tenant.ai_token_usage. On DB error we fail-open (let the request through)
  // to avoid false-positives caused by transient DB issues.
  // resolvedTenantId is populated by the membership lookup above.
  const tenantBudgetExceeded = await isTenantMonthlyBudgetExceeded(adminClient, resolvedTenantId);
  if (tenantBudgetExceeded) {
    return new Response(
      JSON.stringify({ error: 'Månedlig AI-kvote nået. Kontakt support for at opgradere.' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { messages, context, attachments, session_id: sessionId, diagramBase64 } = body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'Ingen beskeder' }, { status: 400 });
  }
  // BIZZ-812: attachments-array er optional. Hver entry er
  // { file_id, name, file_type } der refererer til public.ai_file.
  // Tool-dispatcher i BIZZ-813 læser denne og henter binær til
  // template-fill. I denne ticket er attachments kun pass-through
  // (landes ikke på tool-context endnu).
  void attachments;

  // ── Input validation — guard against oversized payloads ──────────────────
  /** Maximum number of messages accepted per request (prevents token amplification). */
  const MAX_MESSAGES = 50;
  /** Maximum characters allowed per message content string. */
  const MAX_CONTENT_CHARS = 10_000;

  if (messages.length > MAX_MESSAGES) {
    return Response.json({ error: `Maks ${MAX_MESSAGES} beskeder pr. anmodning` }, { status: 400 });
  }

  const oversizedMessage = messages.find(
    (m) => typeof m.content === 'string' && m.content.length > MAX_CONTENT_CHARS
  );
  if (oversizedMessage) {
    return Response.json(
      { error: `Besked overstiger maks ${MAX_CONTENT_CHARS} tegn` },
      { status: 400 }
    );
  }

  // Fire-and-forget: log this AI chat call for usage analytics.
  // promptLength is the character count of the last user message — no raw text stored.
  if (resolvedTenantId) {
    const lastMessage = messages[messages.length - 1];
    const promptLength = typeof lastMessage?.content === 'string' ? lastMessage.content.length : 0;
    logActivity(adminClient, resolvedTenantId, userId, 'ai_chat', { promptLength });
  }

  // Resolve base URL for internal API calls
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `http://localhost:3000`;

  // Build system prompt — append knowledge base, recent entities and page context if available
  let systemPrompt = SYSTEM_PROMPT;
  // Inject knowledge base first so it forms stable background knowledge
  if (knowledgeContext) {
    systemPrompt += `\n\n${knowledgeContext}`;
  }
  if (recentEntitiesContext) {
    systemPrompt += `\n\n${recentEntitiesContext}`;
  }
  if (context) {
    systemPrompt += `\n\n## Aktuel kontekst\nBrugeren kigger på: ${context}`;
  }

  // BIZZ-816: injicér user's domain-templates så AI kender deres
  // navne/id'er og kan kalde generate_document med mode='domain_template'.
  // Bruger listUserDomains (BIZZ-711) + per-domain domainScopedQuery
  // så vi respekterer BIZZ-722 mandatory-domain-filter enforcement.
  // Fejler stille — hvis user ikke er domain-member eller query fejler,
  // skipper vi sektionen og AI falder tilbage til scratch/attached_template.
  try {
    const { listUserDomains } = await import('@/app/lib/domainAuth');
    const { domainScopedQuery } = await import('@/app/lib/domainScopedQuery');
    const domains = await listUserDomains();
    if (domains.length > 0) {
      type TemplateRow = { id: string; domain_id: string; name: string; file_type: string };
      const templatesByDomain: TemplateRow[] = [];
      for (const d of domains) {
        const scoped = domainScopedQuery(d.id);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data } = (await (scoped('domain_template') as any)
          .select('id, domain_id, name, file_type')
          .limit(20)) as { data: TemplateRow[] | null };
        if (Array.isArray(data)) templatesByDomain.push(...data);
      }
      if (templatesByDomain.length > 0) {
        const domainNameById = new Map(domains.map((d) => [d.id, d.name]));
        const lines = templatesByDomain
          .slice(0, 30)
          .map((t) => {
            const dn = domainNameById.get(t.domain_id) ?? t.domain_id.slice(0, 8);
            return `[domain: ${dn}] id=${t.id} name="${t.name}" (${t.file_type.toUpperCase()})`;
          })
          .join('\n');
        systemPrompt += `\n\n## Domain templates tilgængelige\n${lines}\n\nHvis brugeren refererer til en af disse ved navn → kald generate_document med mode='domain_template' + domain_template_id (ikke navnet). Du skal også give case_id — hvis den ikke er i pageContext, bed brugeren om at vælge en sag først.`;
      }
    }
  } catch (tmplErr) {
    logger.warn('[ai/chat] domain-templates fetch failed (non-fatal):', tmplErr);
  }

  // BIZZ-940: Context compaction — begræns antal beskeder sendt til Claude
  // for at undgå at ramme context window (200K tokens). Behold altid de
  // seneste 30 beskeder. Hvis historikken er længere, inkluder en
  // opsummerings-besked i starten.
  const MAX_HISTORY_MESSAGES = 30;
  let compactedMessages = messages;
  let compactionNote = '';
  if (messages.length > MAX_HISTORY_MESSAGES) {
    const trimmed = messages.length - MAX_HISTORY_MESSAGES;
    compactedMessages = messages.slice(-MAX_HISTORY_MESSAGES);
    compactionNote = `[Samtalehistorik komprimeret: ${trimmed} ældre beskeder fjernet for at holde sig inden for context-grænsen. Kun de seneste ${MAX_HISTORY_MESSAGES} beskeder er inkluderet.]`;
    // Ensure first message is from user (Anthropic API requirement)
    if (compactedMessages[0]?.role !== 'user') {
      compactedMessages = [
        { role: 'user' as const, content: compactionNote },
        ...compactedMessages,
      ];
      compactionNote = '';
    }
  }

  const anthropicMessages: Anthropic.MessageParam[] = compactedMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  // Inject compaction note as first user message if needed
  if (compactionNote && anthropicMessages.length > 0 && anthropicMessages[0].role === 'user') {
    anthropicMessages[0] = {
      role: 'user',
      content: compactionNote + '\n\n' + String(anthropicMessages[0].content),
    };
  }

  const client = new Anthropic({ apiKey });
  const encoder = new TextEncoder();

  /** Helper: enqueue SSE event */
  const sse = (controller: ReadableStreamDefaultController, data: string) => {
    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
  };

  // BIZZ-939: SSE keepalive — sender heartbeat comment hvert 15s for at
  // forhindre idle-timeout på mobil Safari. SSE spec: linjer der starter
  // med ":" er comments og ignoreres af EventSource-klienter.
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  const startHeartbeat = (ctrl: ReadableStreamDefaultController) => {
    heartbeatInterval = setInterval(() => {
      try {
        ctrl.enqueue(encoder.encode(': heartbeat\n\n'));
      } catch {
        // Stream allerede lukket — stop heartbeat
        if (heartbeatInterval) clearInterval(heartbeatInterval);
      }
    }, 15_000);
  };
  const stopHeartbeat = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      // BIZZ-939: Start SSE heartbeat for at holde forbindelsen åben
      startHeartbeat(controller);
      try {
        const MAX_TOOL_ROUNDS = 15;
        // BIZZ-590: Soft time-budget. Vercel hard-kill ved maxDuration (120s)
        // afbryder streamen uden at nå MAX_TOOL_ROUNDS-exit branch, og brugeren
        // får 0 chars output. Når vi rammer SOFT_DEADLINE_MS giver vi Claude
        // én sidste runde UDEN tools så AI kan syntetisere det allerede
        // indsamlede data til et delvist svar inden serverless-timeout.
        //
        // Sat til 60s for at efterlade ~60s buffer til final Claude-kaldet +
        // streaming. Ved multi-tool analyser (Q12: 16 tools) bruger hver runde
        // ~5-8s, så 60s dækker typisk 8-10 runders data-indsamling — nok til
        // en meningsfuld syntese selv for komplekse cross-source queries.
        const SOFT_DEADLINE_MS = 60_000;
        const startedAt = Date.now();
        const elapsed = () => Date.now() - startedAt;
        let forceFinalSynthesis = false;
        let round = 0;

        /** Track total token usage across all Claude API calls in this request */
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        /**
         * BIZZ-869 part 2: Akkumulerer generate_document-tool-outputs
         * i turnen så vi kan gemme dem i assistant-beskedens content
         * JSONB. Uden dette mister brugeren adgang til genererede
         * filer efter reload (kun download_url SSE-event var observer-
         * bar i klient-memory).
         */
        const turnGeneratedFiles: GeneratedFileRef[] = [];

        while (round < MAX_TOOL_ROUNDS) {
          round++;

          // Ved soft-deadline: suppress tools så Claude afslutter med tekst
          // baseret på allerede hentede data (giver partial svar i stedet for
          // 0-chars timeout). Efter denne runde exit'es while-loop via
          // if (toolUseBlocks.length === 0).
          if (!forceFinalSynthesis && elapsed() > SOFT_DEADLINE_MS) {
            forceFinalSynthesis = true;
            sse(controller, JSON.stringify({ status: 'Samler data til svar…' }));
            anthropicMessages.push({
              role: 'user',
              content:
                'Tiden er ved at løbe ud — afslut nu med et struktureret svar baseret på de data du allerede har hentet. Stil gerne opfølgningsspørgsmål, men skriv et svar i stedet for at kalde flere tools.',
            });
          }

          // BIZZ-866: Anthropic prompt caching. System-prompten er stor
          // (~5-10K tokens) og genbruges på tværs af tool-runde og efterfølgende
          // requests. Marker som ephemeral (5min TTL) for 90% cache-hit og
          // 50-90% latency/cost-besparelse. Tools cached separat med samme
          // breakpoint-mønster. Cache-opbygning koster ~25% ekstra ved cache-miss
          // men amortiseres efter blot 2 requests.
          const response = await client.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 4096,
            system: [
              {
                type: 'text',
                text: systemPrompt,
                cache_control: { type: 'ephemeral' },
              },
            ],
            tools: forceFinalSynthesis
              ? undefined
              : TOOLS.map((t, idx) =>
                  idx === TOOLS.length - 1
                    ? // Cache-breakpoint på sidste tool dækker hele tool-blokken
                      { ...t, cache_control: { type: 'ephemeral' } as const }
                    : t
                ),
            messages: anthropicMessages,
          });

          // Accumulate token usage from this API call
          totalInputTokens += response.usage?.input_tokens ?? 0;
          totalOutputTokens += response.usage?.output_tokens ?? 0;

          // Check for tool_use blocks
          const toolUseBlocks = response.content.filter(
            (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
          );

          if (toolUseBlocks.length === 0) {
            // ── Final text response — stream it to client ──
            let text = response.content
              .filter((b): b is Anthropic.TextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('');

            // BIZZ-940: Detect truncated response (Claude ran out of max_tokens)
            if (response.stop_reason === 'max_tokens') {
              text +=
                '\n\n---\n*Svaret blev afbrudt fordi det overskred max-længden. Start gerne en ny samtale for at fortsætte.*';
            }

            // Stream in chunks — 200 chars reduces SSE overhead vs. perceived smoothness
            const CHUNK = 200;
            for (let i = 0; i < text.length; i += CHUNK) {
              sse(controller, JSON.stringify({ t: text.slice(i, i + CHUNK) }));
            }

            // Send token usage summary before closing stream
            const totalTokens = totalInputTokens + totalOutputTokens;
            // BIZZ-643: Beregn allocation før vi sender usage-event så vi
            // kan inkludere per-kilde-remaining i samme SSE-block.
            const allocation = allocateTokensBySource(totalTokens, {
              planTokens,
              planTokensUsed,
              bonusTokens,
              topUpTokens,
              tokensUsedThisMonth,
            });
            sse(
              controller,
              JSON.stringify({
                usage: {
                  inputTokens: totalInputTokens,
                  outputTokens: totalOutputTokens,
                  totalTokens,
                  // BIZZ-643: Per-kilde-balance så UI kan vise Plan/Bonus/Købt.
                  planRemaining: Math.max(0, planTokens - allocation.planTokensUsed),
                  bonusRemaining: allocation.bonusTokens,
                  topUpRemaining: allocation.topUpTokens,
                },
              })
            );

            sse(controller, '[DONE]');
            stopHeartbeat();
            controller.close();

            // Fire-and-forget: persist token usage so quota check works next request
            // BIZZ-643: Allocation beregnet ovenfor — genbruges her.
            adminClient.auth.admin
              .updateUserById(userId, {
                app_metadata: {
                  ...freshUser?.user?.app_metadata,
                  subscription: { ...sub, ...allocation },
                },
              })
              .catch(() => {}); // non-critical — best-effort tracking

            // Fire-and-forget: record in tenant.ai_token_usage for auditable per-tenant billing
            if (resolvedTenantId) {
              recordTenantTokenUsage(
                adminClient,
                resolvedTenantId,
                userId,
                totalInputTokens,
                totalOutputTokens
              );
            }

            // BIZZ-819: Fire-and-forget — persistér user-prompt +
            // assistant-svar til ai_chat_messages hvis klienten sendte
            // session_id. Holder chat-historik server-side så brugeren
            // kan tilgå den på tværs af devices (BIZZ-820 UI-layer).
            if (sessionId && resolvedTenantId) {
              persistChatMessages(
                adminClient,
                sessionId,
                userId,
                messages,
                text,
                totalInputTokens,
                totalOutputTokens,
                // BIZZ-869 part 2: Lad assistant-beskeden indeholde de
                // filer vi har genereret i denne turn, så download-chippen
                // kommer tilbage efter reload + cross-device.
                turnGeneratedFiles
              );
            }

            return;
          }

          // ── Execute tools ──
          // Send status to client for each tool
          for (const toolBlock of toolUseBlocks) {
            const label = TOOL_STATUS[toolBlock.name] ?? 'Henter data…';
            sse(controller, JSON.stringify({ status: label }));

            // BIZZ-817: Sentry breadcrumb per tool-call. User input
            // masked — kun tool-navn + stripped-struktur logges.
            try {
              const input = toolBlock.input as Record<string, unknown>;
              const maskedInput: Record<string, unknown> = {};
              if (typeof input.format === 'string') maskedInput.format = input.format;
              if (typeof input.mode === 'string') maskedInput.mode = input.mode;
              // Title-length kun, ikke værdi (kan indeholde PII)
              if (typeof input.title === 'string') {
                maskedInput.titleLength = input.title.length;
              }
              Sentry.addBreadcrumb({
                category: 'ai.tool_call',
                message: toolBlock.name,
                level: 'info',
                data: maskedInput,
              });
            } catch {
              // Sentry fejl-håndtering er ikke-fatal
            }
          }

          // Add assistant response (with tool_use blocks) to message history
          anthropicMessages.push({ role: 'assistant', content: response.content });

          // Execute all tools in parallel
          const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
            toolUseBlocks.map(async (toolBlock) => {
              const result = await executeTool(
                toolBlock.name,
                toolBlock.input as Record<string, string>,
                baseUrl,
                request.headers.get('cookie'),
                diagramBase64
              );

              // BIZZ-813: generate_document returnerer download_url —
              // emit SSE-event med URL så klienten kan vise chippen
              // straks, og strip URL'en fra tool_result så Claude ikke
              // inkluderer det i markdown-svaret.
              // BIZZ-817: fang generate_document tool-fejl i Sentry
              // separat fra success-path. Claude ser fortsat result som
              // tool_result og kan forsøge igen.
              if (
                toolBlock.name === 'generate_document' &&
                typeof result === 'object' &&
                result !== null &&
                'fejl' in result
              ) {
                Sentry.captureMessage('ai.generate_document.error', {
                  level: 'warning',
                  extra: {
                    error: (result as { fejl: string }).fejl,
                    mode: (toolBlock.input as { mode?: string }).mode,
                    format: (toolBlock.input as { format?: string }).format,
                  },
                });
              }
              if (
                toolBlock.name === 'generate_document' &&
                typeof result === 'object' &&
                result !== null &&
                'file_id' in result
              ) {
                const fileResult = result as {
                  file_id: string;
                  file_name: string;
                  download_url?: string;
                  preview_text?: string;
                  // BIZZ-868: 'html' tilføjet for docx preview via mammoth
                  preview_kind?: 'text' | 'table' | 'html';
                  preview_columns?: string[];
                  preview_rows?: string[][];
                  /** BIZZ-868: sanitiseret html for docx-filer */
                  preview_html?: string;
                  bytes: number;
                  format: string;
                };
                // BIZZ-817: flat token-fee per tool-call som proxy for
                // compute-omkostning. Prices: XLSX=500, DOCX=800, CSV=200.
                // Recorded som tokens_out i ai_token_usage så det tæller
                // mod user's månedlige quota og inkluderes i billing-agg.
                const FEE_BY_FORMAT: Record<string, number> = {
                  xlsx: 500,
                  docx: 800,
                  csv: 200,
                };
                const fee = FEE_BY_FORMAT[fileResult.format] ?? 500;
                totalOutputTokens += fee;
                if (resolvedTenantId) {
                  recordTenantTokenUsage(adminClient, resolvedTenantId, userId, 0, fee);
                }
                Sentry.addBreadcrumb({
                  category: 'ai.tool_success',
                  message: 'generate_document',
                  level: 'info',
                  data: {
                    format: fileResult.format,
                    bytes: fileResult.bytes,
                    fee_tokens: fee,
                  },
                });
                sse(
                  controller,
                  JSON.stringify({
                    generated_file: {
                      file_id: fileResult.file_id,
                      file_name: fileResult.file_name,
                      download_url: fileResult.download_url,
                      preview_text: fileResult.preview_text,
                      preview_kind: fileResult.preview_kind,
                      preview_columns: fileResult.preview_columns,
                      preview_rows: fileResult.preview_rows,
                      bytes: fileResult.bytes,
                      format: fileResult.format,
                    },
                  })
                );
                // BIZZ-869 part 2: Akkumulér referencen så persistChat-
                // Messages kan gemme den i assistant-beskeden.
                turnGeneratedFiles.push({
                  file_id: fileResult.file_id,
                  file_name: fileResult.file_name,
                  download_url: fileResult.download_url,
                  preview_text: fileResult.preview_text,
                  preview_kind: fileResult.preview_kind,
                  preview_columns: fileResult.preview_columns,
                  preview_rows: fileResult.preview_rows,
                  preview_html: fileResult.preview_html,
                  bytes: fileResult.bytes,
                  format: fileResult.format,
                });
                // Claude-facing result har INGEN download_url
                return {
                  type: 'tool_result' as const,
                  tool_use_id: toolBlock.id,
                  content: JSON.stringify({
                    file_id: fileResult.file_id,
                    file_name: fileResult.file_name,
                    bytes: fileResult.bytes,
                    format: fileResult.format,
                    status: 'success',
                    note: 'File generated. Give a short confirmation and tell the user to use the download chip in the chat.',
                  }),
                };
              }

              return {
                type: 'tool_result' as const,
                tool_use_id: toolBlock.id,
                content: JSON.stringify(result),
              };
            })
          );

          // Add tool results as "user" message
          anthropicMessages.push({ role: 'user', content: toolResults });
        }

        // If we exhausted tool rounds, send what we have + usage
        sse(
          controller,
          JSON.stringify({
            t: 'Jeg nåede max antal data-opslag. Her er hvad jeg fandt — stil gerne et opfølgende spørgsmål.',
          })
        );
        const totalTokens = totalInputTokens + totalOutputTokens;
        // BIZZ-643: Allocation beregnet før usage-event så per-kilde-remaining
        // kan inkluderes i samme SSE-block.
        const allocation = allocateTokensBySource(totalTokens, {
          planTokens,
          planTokensUsed,
          bonusTokens,
          topUpTokens,
          tokensUsedThisMonth,
        });
        sse(
          controller,
          JSON.stringify({
            usage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              totalTokens,
              planRemaining: Math.max(0, planTokens - allocation.planTokensUsed),
              bonusRemaining: allocation.bonusTokens,
              topUpRemaining: allocation.topUpTokens,
            },
          })
        );
        sse(controller, '[DONE]');
        stopHeartbeat();
        controller.close();

        // Fire-and-forget: persist token usage so quota check works next request
        adminClient.auth.admin
          .updateUserById(userId, {
            app_metadata: {
              ...freshUser?.user?.app_metadata,
              subscription: { ...sub, ...allocation },
            },
          })
          .catch(() => {}); // non-critical — best-effort tracking

        // Fire-and-forget: record in tenant.ai_token_usage for auditable per-tenant billing
        if (resolvedTenantId) {
          recordTenantTokenUsage(
            adminClient,
            resolvedTenantId,
            userId,
            totalInputTokens,
            totalOutputTokens
          );
        }
      } catch (err) {
        // Capture unexpected errors (not routine Claude API errors) in Sentry
        if (!(err instanceof Anthropic.APIError)) {
          Sentry.captureException(err);
        }
        // BIZZ-870: Specifik fejl-mapping til dansk brugerbesked uden at
        // afsløre rå Anthropic error-detaljer (CLAUDE.md security rule).
        let msg = 'AI-tjeneste fejl';
        if (err instanceof Anthropic.APIError) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const anthErr = err as any;
          const errorType: string = anthErr.error?.type ?? '';
          const status: number | undefined = anthErr.status;
          if (errorType === 'overloaded_error' || status === 529) {
            msg = 'AI-tjenesten er midlertidigt overbelastet. Prøv igen om et øjeblik.';
          } else if (errorType === 'rate_limit_error' || status === 429) {
            msg = 'Midlertidigt højt træk på AI-tjenesten. Prøv igen om lidt.';
          } else if (
            errorType === 'invalid_request_error' &&
            anthErr.message?.toLowerCase().includes('context')
          ) {
            msg =
              'Samtalen er for lang til at fortsætte. Start gerne en ny samtale for bedste svar.';
          } else if (status === 401 || status === 403) {
            msg =
              'AI-tjenesten er ikke konfigureret korrekt. Kontakt support hvis problemet fortsætter.';
          } else if (status && status >= 500) {
            msg = 'AI-tjenesten har midlertidige problemer. Prøv igen om lidt.';
          } else {
            msg = 'Ekstern API fejl';
          }
        }
        sse(controller, JSON.stringify({ error: msg }));
        sse(controller, '[DONE]');
        stopHeartbeat();
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
