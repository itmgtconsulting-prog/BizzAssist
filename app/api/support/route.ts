/**
 * POST /api/support
 *
 * Support chatbot API endpoint. Receives user questions and returns
 * helpful answers based on a built-in knowledge base covering:
 *   - Subscription plans and pricing
 *   - Feature availability
 *   - Common troubleshooting
 *   - Bug reporting (creates JIRA tickets)
 *
 * If the user describes a bug, the endpoint can optionally create
 * a JIRA issue and return the issue key.
 *
 * @param request.body.message - User's question text
 * @param request.body.lang - 'da' or 'en'
 * @param request.body.context - Optional context (current page, subscription info)
 * @param request.body.action - Optional action: 'create_ticket' to file a bug
 * @param request.body.ticketData - Ticket data if action is 'create_ticket'
 * @returns JSON with { reply, action?, ticketKey? }
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { logger } from '@/app/lib/logger';
import { parseBody } from '@/app/lib/validate';

/** Zod schema for POST /api/support request body */
const supportPostSchema = z.object({
  message: z.string().optional(),
  lang: z.enum(['da', 'en']).optional().default('da'),
  context: z.object({
    page: z.string().optional(),
    subscription: z.string().optional(),
  }).optional(),
  action: z.literal('create_ticket').optional(),
  ticketData: z.object({
    title: z.string(),
    description: z.string(),
    page: z.string().optional(),
    email: z.string().optional(),
  }).optional(),
}).passthrough();

// ─── Knowledge Base ──────────────────────────────────────────────────────────

interface KBEntry {
  keywords: string[];
  da: string;
  en: string;
}

const KNOWLEDGE_BASE: KBEntry[] = [
  {
    keywords: ['pris', 'price', 'kost', 'cost', 'abonnement', 'subscription', 'plan'],
    da: `BizzAssist tilbyder 4 planer:\n\n• **Demo** — Gratis prøveperiode med fuld adgang (kræver godkendelse). 10.000 AI-tokens.\n• **Basis** (299 kr/md) — Adgang til basisdata (ejendomme, virksomheder, ejere). Uden AI.\n• **Professionel** (799 kr/md) — Alt i Basis + AI-assistent med 50.000 tokens/md + Excel-eksport.\n• **Enterprise** (2.499 kr/md) — Ubegrænset AI, eksport og prioriteret support.\n\nKontakt os for at ændre eller opgradere dit abonnement.`,
    en: `BizzAssist offers 4 plans:\n\n• **Demo** — Free trial with full access (requires approval). 10,000 AI tokens.\n• **Basic** (299 DKK/mo) — Access to core data (properties, companies, owners). No AI.\n• **Professional** (799 DKK/mo) — Everything in Basic + AI assistant with 50,000 tokens/mo + Excel export.\n• **Enterprise** (2,499 DKK/mo) — Unlimited AI, export, and priority support.\n\nContact us to change or upgrade your subscription.`,
  },
  {
    keywords: ['token', 'ai-token', 'brugt', 'used', 'limit', 'grænse', 'kvota', 'quota'],
    da: `AI-tokens er den mængde data din AI-assistent kan behandle pr. måned.\n\n• Demo: 10.000 tokens\n• Basis: Ingen AI\n• Professionel: 50.000 tokens\n• Enterprise: Ubegrænset\n\nDu kan se dit forbrug i AI-panelet (token-bjælken). Tokens nulstilles den 1. i hver måned. Kontakt en administrator hvis du har brug for ekstra tokens.`,
    en: `AI tokens measure how much data your AI assistant can process per month.\n\n• Demo: 10,000 tokens\n• Basic: No AI\n• Professional: 50,000 tokens\n• Enterprise: Unlimited\n\nYou can see your usage in the AI panel (token bar). Tokens reset on the 1st of each month. Contact an administrator if you need extra tokens.`,
  },
  {
    keywords: ['opgradere', 'upgrade', 'skift', 'switch', 'ændr', 'change'],
    da: 'For at opgradere eller ændre dit abonnement, kontakt vores team via e-mail på support@bizzassist.dk eller kontakt din administrator.',
    en: 'To upgrade or change your subscription, contact our team via email at support@bizzassist.dk or contact your administrator.',
  },
  {
    keywords: ['ejendom', 'property', 'adresse', 'address', 'bbr', 'bygning', 'building'],
    da: 'Du kan søge efter ejendomme via søgefeltet i toppen. Indtast en adresse, vejnavn eller postnummer. Klik på et resultat for at se BBR-data, vurderinger, ejerskab, tinglysning og meget mere.',
    en: 'You can search for properties using the search bar at the top. Enter an address, street name, or postal code. Click a result to see BBR data, valuations, ownership, land registry, and more.',
  },
  {
    keywords: ['virksomhed', 'company', 'cvr', 'firma', 'business'],
    da: 'Søg efter virksomheder med CVR-nummer eller firmanavn i søgefeltet. Du kan se kontaktoplysninger, ejere, produktionsenheder og kreditoplysninger.',
    en: 'Search for companies using CVR number or company name in the search bar. You can see contact information, owners, production units, and credit information.',
  },
  {
    keywords: ['eksport', 'export', 'excel', 'download', 'xlsx'],
    da: 'Excel-eksport er tilgængelig på Professionel- og Enterprise-planer. Klik på Excel-knappen på en ejendoms- eller virksomhedsside for at downloade data som en .xlsx-fil.',
    en: 'Excel export is available on Professional and Enterprise plans. Click the Excel button on a property or company page to download data as an .xlsx file.',
  },
  {
    keywords: ['kort', 'map', 'wms', 'lag', 'layer', 'ortofoto'],
    da: 'Kortsiden viser alle danske ejendomme med WMS-lag fra Dataforsyningen. Du kan tænde/slukke for matrikelgrænser, lokalplaner, zonekort, naturområder og meget mere.',
    en: 'The map page shows all Danish properties with WMS layers from Dataforsyningen. You can toggle cadastral boundaries, local plans, zone maps, nature areas, and more.',
  },
  {
    keywords: ['følg', 'follow', 'track', 'notifikation', 'notification', 'overvåg', 'monitor'],
    da: 'Klik "Følg" på en ejendoms- eller virksomhedsside for at modtage notifikationer når data ændrer sig (BBR, vurdering, ejerskab). Se dine fulgte i klokkeikonet i topmenuen.',
    en: 'Click "Follow" on a property or company page to receive notifications when data changes (BBR, valuation, ownership). See your tracked items in the bell icon in the top menu.',
  },
  {
    keywords: ['ai', 'assistent', 'assistant', 'chat', 'spørg', 'ask', 'claude'],
    da: 'AI-assistenten sidder i sidepanelet og kan svare på spørgsmål om den ejendom, virksomhed eller person du kigger på. Den har adgang til alle BizzAssist-datakilder og kan hente data i realtid.',
    en: 'The AI assistant is in the side panel and can answer questions about the property, company, or person you are viewing. It has access to all BizzAssist data sources and can fetch data in real-time.',
  },
  {
    keywords: ['sammenlign', 'compare', 'versus', 'vs', 'side'],
    da: 'Du kan sammenligne op til 3 ejendomme side om side under "Sammenlign" i dashboardet. Søg og tilføj ejendomme for at se BBR-data, vurderinger og nøgletal i et sammenligningsskema.',
    en: 'You can compare up to 3 properties side by side under "Compare" in the dashboard. Search and add properties to see BBR data, valuations, and key figures in a comparison table.',
  },
  {
    keywords: ['sikkerhed', 'security', '2fa', 'totp', 'adgangskode', 'password', 'login'],
    da: 'Gå til Indstillinger → Sikkerhed for at aktivere 2-faktor-godkendelse (2FA/TOTP). Du kan ændre din adgangskode under Indstillinger → Profil.',
    en: 'Go to Settings → Security to enable two-factor authentication (2FA/TOTP). You can change your password under Settings → Profile.',
  },
  {
    keywords: ['kontakt', 'contact', 'support', 'hjælp', 'help', 'mail'],
    da: 'Du kan kontakte vores support via support@bizzassist.dk. For tekniske problemer kan du oprette en fejlrapport direkte herfra.',
    en: 'You can contact our support at support@bizzassist.dk. For technical issues, you can create a bug report directly from here.',
  },
  {
    keywords: ['rapport', 'report', 'pdf'],
    da: 'Du kan generere en PDF-rapport for enhver ejendom. Klik på "Rapport"-knappen i ejendomsdetaljevisningen. Rapporten indeholder vurdering, BBR, ejerskab, salgshistorik og meget mere.',
    en: 'You can generate a PDF report for any property. Click the "Report" button in the property detail view. The report includes valuation, BBR, ownership, sales history, and more.',
  },
];

/**
 * Find the best matching knowledge base entry for a user question.
 *
 * @param question - User's question text (lowercased)
 * @returns Best matching KB entry or null
 */
function findAnswer(question: string): KBEntry | null {
  const q = question.toLowerCase();
  let bestMatch: KBEntry | null = null;
  let bestScore = 0;

  for (const entry of KNOWLEDGE_BASE) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (q.includes(kw.toLowerCase())) {
        score += kw.length; // Longer keyword matches score higher
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }

  return bestScore >= 3 ? bestMatch : null;
}

/**
 * Create a JIRA ticket for a bug report from the support chat.
 *
 * @param title - Ticket title
 * @param description - Ticket description
 * @param page - Current page URL
 * @param email - Reporter email
 * @returns JIRA issue key or null on failure
 */
async function createSupportTicket(
  title: string,
  description: string,
  page?: string,
  email?: string
): Promise<string | null> {
  const host = process.env.JIRA_HOST;
  const jiraEmail = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const project = process.env.JIRA_PROJECT_KEY;

  if (!host || !jiraEmail || !token || !project) return null;

  const credentials = Buffer.from(`${jiraEmail}:${token}`).toString('base64');

  const body = {
    fields: {
      project: { key: project },
      summary: `[Support Chat] ${title}`,
      description: {
        type: 'doc',
        version: 1,
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: description }] },
          ...(page
            ? [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: `Page: `, marks: [{ type: 'strong' }] },
                    { type: 'text', text: page },
                  ],
                },
              ]
            : []),
          ...(email
            ? [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: `Reporter: `, marks: [{ type: 'strong' }] },
                    { type: 'text', text: email },
                  ],
                },
              ]
            : []),
        ],
      },
      issuetype: { name: 'Task' },
      priority: { name: 'Medium' },
      labels: ['bizzassist-app', 'support-chat'],
    },
  };

  try {
    const res = await fetch(`https://${host}/rest/api/3/issue`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    return data.key ?? null;
  } catch {
    return null;
  }
}

/**
 * Log a support question to Supabase for analytics.
 * Non-blocking — failures are silently ignored.
 *
 * @param question - User's question text
 * @param answer - Bot's reply text
 * @param matched - Whether a KB entry was matched
 * @param lang - Language code
 * @param page - Current page URL
 */
async function logSupportQuestion(
  question: string,
  answer: string,
  matched: boolean,
  lang: string,
  page?: string
): Promise<void> {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) return;

    const supabase = createClient(url, key);
    await supabase.from('support_questions').insert({
      question,
      answer,
      matched,
      lang,
      page: page ?? null,
      created_at: new Date().toISOString(),
    });
  } catch {
    // Non-critical — ignore errors
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = await parseBody(request, supportPostSchema);
    if (!parsed.success) return parsed.response;
    const { message, lang, action, ticketData } = parsed.data;

    // ── Action: Create JIRA ticket ──
    if (action === 'create_ticket' && ticketData) {
      const issueKey = await createSupportTicket(
        ticketData.title,
        ticketData.description,
        ticketData.page,
        ticketData.email
      );

      const reply = issueKey
        ? lang === 'da'
          ? `Din fejlrapport er oprettet som ${issueKey}. Vi kigger på det hurtigst muligt.`
          : `Your bug report has been created as ${issueKey}. We will look into it as soon as possible.`
        : lang === 'da'
          ? 'Fejlrapporten kunne ikke oprettes. Kontakt support@bizzassist.dk i stedet.'
          : 'The bug report could not be created. Please contact support@bizzassist.dk instead.';

      return NextResponse.json({ reply, ticketKey: issueKey });
    }

    // ── Normal question ──
    if (!message?.trim()) {
      return NextResponse.json({ error: 'Message required' }, { status: 400 });
    }

    // Check if user is reporting a bug
    const bugKeywords = ['bug', 'fejl', 'error', 'virker ikke', 'broken', 'crash', 'problem'];
    const isBugReport = bugKeywords.some((kw) => message.toLowerCase().includes(kw));

    const kbEntry = findAnswer(message);

    let reply: string;
    let suggestTicket = false;

    if (kbEntry) {
      reply = lang === 'da' ? kbEntry.da : kbEntry.en;
    } else if (isBugReport) {
      suggestTicket = true;
      reply =
        lang === 'da'
          ? 'Det lyder som om du har fundet en fejl. Vil du oprette en fejlrapport, så vi kan kigge på det? Beskriv venligst hvad der skete og hvad du forventede.'
          : 'It sounds like you found a bug. Would you like to create a bug report so we can look into it? Please describe what happened and what you expected.';
    } else {
      reply =
        lang === 'da'
          ? 'Jeg er ikke helt sikker på, hvad du mener. Prøv at spørge om:\n\n• Abonnementer og priser\n• Ejendomsdata og BBR\n• Virksomhedsopslag\n• AI-assistenten\n• Eksport og rapporter\n• Følg-funktionen\n• Kort og lag\n\nHvis du har fundet en fejl, beskriv den og jeg opretter en rapport.'
          : "I'm not sure I understand. Try asking about:\n\n• Subscriptions and pricing\n• Property data and BBR\n• Company lookup\n• AI assistant\n• Export and reports\n• Follow feature\n• Map and layers\n\nIf you found a bug, describe it and I'll create a report.";
    }

    // Log question for analytics (non-blocking)
    const context = parsed.data.context as { page?: string } | undefined;
    logSupportQuestion(message ?? '', reply, !!kbEntry, lang, context?.page).catch(() => {});

    return NextResponse.json({ reply, suggestTicket });
  } catch (err) {
    logger.error('[/api/support] Error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
