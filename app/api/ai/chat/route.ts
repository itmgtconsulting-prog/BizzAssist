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

export const runtime = 'nodejs';
export const maxDuration = 120;

// ─── Types ──────────────────────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRequestBody {
  messages: ChatMessage[];
  context?: string;
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
      'Hent BBR-bygningsdata (opførelsesår, areal, materialer, etager, opvarmning, supplerende varme, vandforsyning, bevaringsværdighed, enheder med boligtype og energiforsyning) for en ejendom via DAWA-adresse-ID. Returnerer også ejendomsrelationer med BFE-nummer.',
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
      'Hent offentlig ejendomsvurdering med udvidede data fra Datafordeler. Returnerer: ejendomsværdi, grundværdi, afgiftspligtige beløb, estimeret grundskyld, grundskyldspromille, juridisk kategori, vurderingshistorik (alle år), PLUS: ejerboligfordeling, grundværdispecifikation (areal × enhedspris nedbrydning), grundskatteloft (loftansættelse), skattefritagelser, og fradrag for forbedringer. Kræver BFE-nummer og kommunekode.',
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
];

// ─── Tool labels (for status messages) ──────────────────────────────────────

const TOOL_STATUS: Record<string, string> = {
  dawa_adresse_soeg: 'Søger adresse…',
  dawa_adresse_detaljer: 'Henter adressedetaljer…',
  hent_bbr_data: 'Henter BBR-bygningsdata…',
  hent_vurdering: 'Henter ejendomsvurdering…',
  hent_ejerskab: 'Henter ejerskabsdata…',
  hent_salgshistorik: 'Henter salgshistorik…',
  hent_energimaerke: 'Henter energimærke…',
  hent_jordforurening: 'Henter jordforureningsdata…',
  hent_plandata: 'Henter plandata…',
  hent_cvr_virksomhed: 'Henter CVR-data…',
  hent_matrikeldata: 'Henter matrikeldata…',
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

## Regler
- BRUG ALTID dine tools til at hente rigtig data — gæt aldrig
- Svar ALTID på dansk medmindre brugeren skriver på engelsk
- Præsenter data struktureret med overskrifter og tal
- Hold svar fokuserede — vis de mest relevante data først
- Ved analyse: kombiner data fra flere kilder til en samlet vurdering
- Marker tydeligt hvad der er fakta (fra registre) vs. din vurdering
- Hvis et tool returnerer fejl eller manglende data, nævn det kort og fortsæt med de øvrige data
- Kald gerne flere tools for at give et komplet billede
- BFE-nummer findes typisk i jordstykke-objektet fra dawa_adresse_detaljer (feltet "bfenummer" eller i ejendomsrelationer fra BBR)`;

// ─── Tool executor ──────────────────────────────────────────────────────────

/**
 * Executes a tool by calling the appropriate internal API route or external endpoint.
 *
 * @param name - Tool name matching one of TOOLS[].name
 * @param input - Tool input parameters from Claude
 * @param baseUrl - Base URL for internal API routes (e.g. http://localhost:3000)
 * @returns JSON-serialisable result object
 */
async function executeTool(
  name: string,
  input: Record<string, string>,
  baseUrl: string
): Promise<unknown> {
  const timeout = 15_000;

  try {
    switch (name) {
      // TODO: Migrate dawa_adresse_soeg to DAR before July 2026 — currently uses direct DAWA REST calls
      case 'dawa_adresse_soeg': {
        // Server-side proxy via DAR (DAWA lukker 1. juli 2026)
        const res = await fetch(
          `${baseUrl}/api/adresse/autocomplete?q=${encodeURIComponent(input.q)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) return { fejl: `Adresse-autocomplete svarede ${res.status}` };
        const data = await res.json();
        return (
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
      }

      // TODO: Migrate dawa_adresse_detaljer to DAR before July 2026 — currently uses direct DAWA REST calls
      case 'dawa_adresse_detaljer': {
        // Server-side proxy via DAR (DAWA lukker 1. juli 2026)
        const res = await fetch(
          `${baseUrl}/api/adresse/lookup?id=${encodeURIComponent(input.dawaId)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) return { fejl: `Adresse-opslag svarede ${res.status}` };
        const d = (await res.json()) as Record<string, unknown>;
        return {
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
        };
      }

      case 'hent_bbr_data': {
        const res = await fetch(`${baseUrl}/api/ejendom/${encodeURIComponent(input.dawaId)}`, {
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return { fejl: `Ejendom-API svarede ${res.status}` };
        return await res.json();
      }

      case 'hent_vurdering': {
        const params = new URLSearchParams();
        if (input.bfeNummer) params.set('bfeNummer', input.bfeNummer);
        if (input.kommunekode) params.set('kommunekode', input.kommunekode);
        const res = await fetch(`${baseUrl}/api/vurdering?${params}`, {
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) return { fejl: `Vurderings-API svarede ${res.status}` };
        return await res.json();
      }

      case 'hent_forelobig_vurdering': {
        const params = new URLSearchParams();
        if (input.adresseId) params.set('adresseId', input.adresseId);
        if (input.bfeNummer) params.set('bfeNummer', input.bfeNummer);
        const res = await fetch(`${baseUrl}/api/vurdering-forelobig?${params}`, {
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) return { fejl: `Foreløbig-vurdering-API svarede ${res.status}` };
        return await res.json();
      }

      case 'hent_ejerskab': {
        const res = await fetch(
          `${baseUrl}/api/ejerskab?bfeNummer=${encodeURIComponent(input.bfeNummer)}`,
          {
            signal: AbortSignal.timeout(timeout),
          }
        );
        if (!res.ok) return { fejl: `Ejerskabs-API svarede ${res.status}` };
        return await res.json();
      }

      case 'hent_salgshistorik': {
        const res = await fetch(
          `${baseUrl}/api/salgshistorik?bfeNummer=${encodeURIComponent(input.bfeNummer)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) return { fejl: `Salgshistorik-API svarede ${res.status}` };
        return await res.json();
      }

      case 'hent_energimaerke': {
        const res = await fetch(
          `${baseUrl}/api/energimaerke?bfeNummer=${encodeURIComponent(input.bfeNummer)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) return { fejl: `Energimærke-API svarede ${res.status}` };
        return await res.json();
      }

      case 'hent_jordforurening': {
        const params = new URLSearchParams({
          ejerlavKode: input.ejerlavKode,
          matrikelnr: input.matrikelnr,
        });
        const res = await fetch(`${baseUrl}/api/jord?${params}`, {
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) return { fejl: `Jord-API svarede ${res.status}` };
        return await res.json();
      }

      case 'hent_plandata': {
        const res = await fetch(
          `${baseUrl}/api/plandata?adresseId=${encodeURIComponent(input.adresseId)}`,
          { signal: AbortSignal.timeout(timeout) }
        );
        if (!res.ok) return { fejl: `Plandata-API svarede ${res.status}` };
        return await res.json();
      }

      case 'hent_cvr_virksomhed': {
        const res = await fetch(`${baseUrl}/api/cvr/${encodeURIComponent(input.cvr)}`, {
          signal: AbortSignal.timeout(timeout),
        });
        if (!res.ok) return { fejl: `CVR-API svarede ${res.status}` };
        return await res.json();
      }

      case 'hent_matrikeldata': {
        const bfe = input.bfeNummer as string;
        const matRes = await fetch(`${baseUrl}/api/matrikel?bfeNummer=${encodeURIComponent(bfe)}`, {
          signal: AbortSignal.timeout(timeout),
        });
        if (!matRes.ok) return { matrikel: null, fejl: `HTTP ${matRes.status}` };
        return await matRes.json();
      }

      default:
        return { fejl: `Ukendt tool: ${name}` };
    }
  } catch (err) {
    return { fejl: err instanceof Error ? err.message : 'Ukendt fejl ved tool-kald' };
  }
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<Response> {
  const apiKey = process.env.BIZZASSIST_CLAUDE_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'BIZZASSIST_CLAUDE_KEY ikke konfigureret. Tilføj den i .env.local' },
      { status: 500 }
    );
  }

  let body: ChatRequestBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Ugyldig JSON' }, { status: 400 });
  }

  const { messages, context } = body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'Ingen beskeder' }, { status: 400 });
  }

  // Resolve base URL for internal API calls
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `http://localhost:3000`;

  // Build system prompt — append page context if available
  let systemPrompt = SYSTEM_PROMPT;
  if (context) {
    systemPrompt += `\n\n## Aktuel kontekst\nBrugeren kigger på: ${context}`;
  }

  // Map to Anthropic format (only simple text messages from the client)
  const anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const client = new Anthropic({ apiKey });
  const encoder = new TextEncoder();

  /** Helper: enqueue SSE event */
  const sse = (controller: ReadableStreamDefaultController, data: string) => {
    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
  };

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const MAX_TOOL_ROUNDS = 15;
        let round = 0;

        /** Track total token usage across all Claude API calls in this request */
        let totalInputTokens = 0;
        let totalOutputTokens = 0;

        while (round < MAX_TOOL_ROUNDS) {
          round++;

          // Call Claude (non-streaming for tool rounds, streaming for final)
          const response = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            system: systemPrompt,
            tools: TOOLS,
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
            const text = response.content
              .filter((b): b is Anthropic.TextBlock => b.type === 'text')
              .map((b) => b.text)
              .join('');

            // Stream in small chunks for smooth UX
            const CHUNK = 12;
            for (let i = 0; i < text.length; i += CHUNK) {
              sse(controller, JSON.stringify({ t: text.slice(i, i + CHUNK) }));
            }

            // Send token usage summary before closing stream
            const totalTokens = totalInputTokens + totalOutputTokens;
            sse(
              controller,
              JSON.stringify({
                usage: {
                  inputTokens: totalInputTokens,
                  outputTokens: totalOutputTokens,
                  totalTokens,
                },
              })
            );

            sse(controller, '[DONE]');
            controller.close();
            return;
          }

          // ── Execute tools ──
          // Send status to client for each tool
          for (const toolBlock of toolUseBlocks) {
            const label = TOOL_STATUS[toolBlock.name] ?? 'Henter data…';
            sse(controller, JSON.stringify({ status: label }));
          }

          // Add assistant response (with tool_use blocks) to message history
          anthropicMessages.push({ role: 'assistant', content: response.content });

          // Execute all tools in parallel
          const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
            toolUseBlocks.map(async (toolBlock) => {
              const result = await executeTool(
                toolBlock.name,
                toolBlock.input as Record<string, string>,
                baseUrl
              );
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
        sse(
          controller,
          JSON.stringify({
            usage: {
              inputTokens: totalInputTokens,
              outputTokens: totalOutputTokens,
              totalTokens,
            },
          })
        );
        sse(controller, '[DONE]');
        controller.close();
      } catch (err) {
        const msg =
          err instanceof Anthropic.APIError
            ? `API-fejl (${err.status}): ${err.message}`
            : err instanceof Error
              ? err.message
              : 'Ukendt fejl';
        sse(controller, JSON.stringify({ error: msg }));
        sse(controller, '[DONE]');
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
