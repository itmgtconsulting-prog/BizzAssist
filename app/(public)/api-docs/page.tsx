/**
 * GET /api-docs — BizzAssist Enterprise REST API documentation
 *
 * Static public documentation page for the BizzAssist v1 REST API.
 * Describes authentication, available endpoints, rate limits, quotas,
 * and code examples in cURL, JavaScript, and Python.
 *
 * This is a Server Component — no client-side hydration needed.
 *
 * @module (public)/api-docs
 */

import type { Metadata } from 'next';
import Link from 'next/link';
import { Code, Key, Zap, Shield, Globe, ChevronRight } from 'lucide-react';

export const metadata: Metadata = {
  title: 'API Documentation | BizzAssist Enterprise',
  description:
    'REST API documentation for the BizzAssist Enterprise API v1. Covers authentication, endpoints, rate limits, and code examples.',
  robots: { index: true, follow: true },
};

// ─── Types ───────────────────────────────────────────────────────────────────

/** A single documentation section rendered in the sidebar nav. */
interface NavSection {
  id: string;
  label: string;
}

// ─── Data ────────────────────────────────────────────────────────────────────

/** Navigation sections in reading order. */
const NAV_SECTIONS: NavSection[] = [
  { id: 'authentication', label: 'Authentication' },
  { id: 'rate-limits', label: 'Rate Limits & Quotas' },
  { id: 'endpoints', label: 'Endpoints' },
  { id: 'errors', label: 'Error Codes' },
  { id: 'examples', label: 'Code Examples' },
];

// ─── Sub-components ──────────────────────────────────────────────────────────

/**
 * A styled code block with optional filename label.
 *
 * @param code - The code string to display
 * @param lang - Language hint for the label
 * @param filename - Optional filename shown above the block
 */
function CodeBlock({ code, lang, filename }: { code: string; lang: string; filename?: string }) {
  return (
    <div className="rounded-lg overflow-hidden border border-white/10 my-4">
      {filename && (
        <div className="flex items-center justify-between px-4 py-2 bg-white/[0.04] border-b border-white/10">
          <span className="text-white/40 text-xs font-mono">{filename}</span>
          <span className="text-white/25 text-xs">{lang}</span>
        </div>
      )}
      <pre className="p-4 overflow-x-auto bg-black/30 text-sm">
        <code className="text-emerald-300 font-mono whitespace-pre">{code}</code>
      </pre>
    </div>
  );
}

/**
 * A single endpoint documentation card.
 *
 * @param method - HTTP method (GET, POST, etc.)
 * @param path - The endpoint path pattern
 * @param description - Short description of what this endpoint does
 * @param params - Query/path parameter descriptions
 * @param scopeRequired - The API scope required to call this endpoint
 * @param responseExample - Example JSON response
 */
function EndpointCard({
  method,
  path,
  description,
  params,
  scopeRequired,
  responseExample,
}: {
  method: string;
  path: string;
  description: string;
  params?: Array<{ name: string; type: string; desc: string }>;
  scopeRequired: string;
  responseExample: string;
}) {
  const methodColors: Record<string, string> = {
    GET: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
    POST: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
    DELETE: 'bg-red-500/20 text-red-300 border-red-500/30',
  };
  const colorClass = methodColors[method] ?? 'bg-white/10 text-white/70 border-white/20';

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden my-6">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-white/10 bg-white/[0.02]">
        <span className={`text-xs font-bold px-2 py-1 rounded border font-mono ${colorClass}`}>
          {method}
        </span>
        <code className="text-white font-mono text-sm">{path}</code>
        <span className="ml-auto text-[10px] px-2 py-0.5 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20">
          {scopeRequired}
        </span>
      </div>

      <div className="p-5 space-y-4">
        <p className="text-white/60 text-sm">{description}</p>

        {params && params.length > 0 && (
          <div>
            <p className="text-white/40 text-xs uppercase tracking-wider mb-2">Parameters</p>
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="text-left text-white/30 text-xs font-normal pb-1 pr-4">Name</th>
                  <th className="text-left text-white/30 text-xs font-normal pb-1 pr-4">Type</th>
                  <th className="text-left text-white/30 text-xs font-normal pb-1">Description</th>
                </tr>
              </thead>
              <tbody>
                {params.map((p) => (
                  <tr key={p.name} className="border-t border-white/5">
                    <td className="py-1.5 pr-4">
                      <code className="text-amber-300 text-xs">{p.name}</code>
                    </td>
                    <td className="py-1.5 pr-4">
                      <span className="text-white/40 text-xs font-mono">{p.type}</span>
                    </td>
                    <td className="py-1.5">
                      <span className="text-white/50 text-xs">{p.desc}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div>
          <p className="text-white/40 text-xs uppercase tracking-wider mb-1">Example response</p>
          <pre className="rounded-lg bg-black/40 border border-white/10 p-4 text-xs font-mono text-emerald-300 overflow-x-auto whitespace-pre">
            {responseExample}
          </pre>
        </div>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

/**
 * ApiDocsPage — static documentation for the BizzAssist Enterprise REST API v1.
 * Server Component — rendered at build time, no client hydration.
 *
 * @returns The API documentation page
 */
export default function ApiDocsPage() {
  return (
    <div className="min-h-screen bg-[#0f172a] text-white">
      {/* ── Top bar ── */}
      <header className="border-b border-white/10 sticky top-0 z-30 bg-[#0f172a]/95 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center gap-4">
          <Link href="/" className="text-white font-bold text-lg">
            BizzAssist
          </Link>
          <ChevronRight className="w-4 h-4 text-white/30" />
          <span className="text-white/60 text-sm">API Documentation</span>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs px-2 py-1 rounded bg-blue-500/10 text-blue-300 border border-blue-500/20 font-mono">
              v1
            </span>
            <Link
              href="/dashboard/tokens?tab=api"
              className="text-sm text-white/50 hover:text-white transition-colors"
            >
              Manage keys
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-7xl mx-auto px-4 py-10 flex gap-10">
        {/* ── Sidebar ── */}
        <aside className="hidden lg:block w-52 shrink-0">
          <nav aria-label="Documentation sections" className="sticky top-20 space-y-1">
            {NAV_SECTIONS.map((section) => (
              <a
                key={section.id}
                href={`#${section.id}`}
                className="block px-3 py-2 rounded-lg text-sm text-white/50 hover:text-white hover:bg-white/[0.04] transition-colors"
              >
                {section.label}
              </a>
            ))}
            <div className="pt-4">
              <Link
                href="/dashboard/tokens?tab=api"
                className="block px-3 py-2 rounded-lg text-sm text-blue-400 hover:text-blue-300 hover:bg-blue-500/[0.06] transition-colors"
              >
                Get API key
              </Link>
            </div>
          </nav>
        </aside>

        {/* ── Main content ── */}
        <main className="flex-1 min-w-0 max-w-3xl space-y-16">
          {/* Hero */}
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <Globe className="w-8 h-8 text-blue-400" />
              <h1 className="text-3xl font-bold">BizzAssist REST API</h1>
            </div>
            <p className="text-white/60 text-lg leading-relaxed">
              The BizzAssist Enterprise API gives you programmatic access to Danish property,
              company, and person data. Use it to integrate real-time data into your own
              applications and workflows.
            </p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/40">Base URL:</span>
              <code className="text-sm font-mono text-emerald-300 bg-black/30 px-3 py-1 rounded border border-white/10">
                https://app.bizzassist.dk/api/v1
              </code>
            </div>
          </div>

          {/* ── Authentication ── */}
          <section id="authentication" className="space-y-4">
            <div className="flex items-center gap-3 pb-3 border-b border-white/10">
              <Key className="w-5 h-5 text-blue-400" />
              <h2 className="text-xl font-semibold">Authentication</h2>
            </div>

            <p className="text-white/60 text-sm leading-relaxed">
              All API v1 requests require a valid API key. Pass your key in the{' '}
              <code className="text-amber-300 text-xs bg-black/20 px-1.5 py-0.5 rounded">
                Authorization
              </code>{' '}
              header as a Bearer token.
            </p>

            <CodeBlock
              lang="HTTP"
              filename="Request header"
              code={`Authorization: Bearer bza_<your-api-key>`}
            />

            <div className="rounded-lg bg-amber-500/[0.06] border border-amber-500/20 p-4 text-sm text-amber-200/80 space-y-1">
              <p className="font-semibold text-amber-300">Keep your key secret</p>
              <p>
                API keys grant access to your tenant&apos;s data. Never commit them to source
                control or expose them in client-side code. Rotate compromised keys immediately from{' '}
                <Link href="/dashboard/tokens?tab=api" className="underline">
                  Dashboard › API Keys
                </Link>
                .
              </p>
            </div>

            <p className="text-white/60 text-sm">
              API keys can be scoped to limit access. Available scopes:
            </p>
            <table className="w-full text-sm border border-white/10 rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-white/[0.04]">
                  <th className="text-left px-4 py-2.5 text-white/50 text-xs font-medium">Scope</th>
                  <th className="text-left px-4 py-2.5 text-white/50 text-xs font-medium">
                    Access
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  { scope: 'read:properties', access: 'GET /api/v1/properties/{bfe}' },
                  { scope: 'read:companies', access: 'GET /api/v1/companies/{cvr}' },
                  { scope: 'read:people', access: 'GET /api/v1/people/{enhedsNummer}' },
                  { scope: 'read:ai', access: 'POST /api/v1/ai/analyze' },
                ].map((row) => (
                  <tr key={row.scope} className="border-t border-white/5">
                    <td className="px-4 py-2.5">
                      <code className="text-blue-300 text-xs">{row.scope}</code>
                    </td>
                    <td className="px-4 py-2.5 text-white/50 text-xs font-mono">{row.access}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* ── Rate Limits ── */}
          <section id="rate-limits" className="space-y-4">
            <div className="flex items-center gap-3 pb-3 border-b border-white/10">
              <Zap className="w-5 h-5 text-amber-400" />
              <h2 className="text-xl font-semibold">Rate Limits & Quotas</h2>
            </div>

            <p className="text-white/60 text-sm leading-relaxed">
              Rate limits are applied per API key using a sliding window algorithm. Exceeding the
              limit returns HTTP{' '}
              <code className="text-red-300 text-xs bg-black/20 px-1 rounded">429</code> with{' '}
              <code className="text-amber-300 text-xs bg-black/20 px-1 rounded">Retry-After</code>{' '}
              and{' '}
              <code className="text-amber-300 text-xs bg-black/20 px-1 rounded">X-RateLimit-*</code>{' '}
              headers.
            </p>

            <table className="w-full text-sm border border-white/10 rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-white/[0.04]">
                  <th className="text-left px-4 py-2.5 text-white/50 text-xs font-medium">Plan</th>
                  <th className="text-left px-4 py-2.5 text-white/50 text-xs font-medium">
                    Requests / minute
                  </th>
                  <th className="text-left px-4 py-2.5 text-white/50 text-xs font-medium">
                    Requests / day
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  { plan: 'Starter', perMin: '60', perDay: '5,000' },
                  { plan: 'Professional', perMin: '100', perDay: '25,000' },
                  { plan: 'Enterprise', perMin: '500', perDay: 'Custom' },
                ].map((row) => (
                  <tr key={row.plan} className="border-t border-white/5">
                    <td className="px-4 py-2.5 text-white/70 text-sm">{row.plan}</td>
                    <td className="px-4 py-2.5 text-white/50 text-sm">{row.perMin}</td>
                    <td className="px-4 py-2.5 text-white/50 text-sm">{row.perDay}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="text-white/40 text-xs">
              Rate limit headers are included on every response:{' '}
              <code className="text-amber-300">X-RateLimit-Limit</code>,{' '}
              <code className="text-amber-300">X-RateLimit-Remaining</code>,{' '}
              <code className="text-amber-300">X-RateLimit-Reset</code>.
            </p>
          </section>

          {/* ── Endpoints ── */}
          <section id="endpoints" className="space-y-2">
            <div className="flex items-center gap-3 pb-3 border-b border-white/10">
              <Code className="w-5 h-5 text-emerald-400" />
              <h2 className="text-xl font-semibold">Endpoints</h2>
            </div>

            <EndpointCard
              method="GET"
              path="/api/v1/properties/{bfe}"
              description="Returns property data for a single property identified by its BFE number (Bygnings- og Fællesejendommens Ejendomsnummer). Includes BBR metadata, current valuation, address, and land area."
              scopeRequired="read:properties"
              params={[
                {
                  name: 'bfe',
                  type: 'integer',
                  desc: 'BFE number — unique property identifier in the Danish property register.',
                },
              ]}
              responseExample={`{
  "bfeNummer": 12345678,
  "adresse": "Bredgade 30, 1. th., 1260 København K",
  "kommunekode": "0101",
  "ejendomsvaerdi": 4200000,
  "grundvaerdi": 1800000,
  "vurderingsaar": 2022,
  "bygninger": [
    {
      "bygningId": "abc123",
      "bbr_anvendelse": "Stuehus til landbrugsejendom",
      "bebyggetAreal": 148,
      "samletBygningsareal": 148,
      "opfoerelsesaar": 1974
    }
  ],
  "areal": 512,
  "source": "BBR/VUR — Datafordeler"
}`}
            />

            <EndpointCard
              method="GET"
              path="/api/v1/companies/{cvr}"
              description="Returns company data for a single company identified by its CVR number. Includes name, address, industry, status, registered capital, and owner information."
              scopeRequired="read:companies"
              params={[
                {
                  name: 'cvr',
                  type: 'string(8)',
                  desc: 'CVR number — 8-digit Danish company registration number.',
                },
              ]}
              responseExample={`{
  "cvr": "12345678",
  "navn": "Eksempel A/S",
  "status": "NORMAL",
  "stiftelsesdato": "2005-03-14",
  "branche": {
    "kode": "620100",
    "tekst": "Udvikling og produktion af software"
  },
  "adresse": "Nørregade 10, 1165 København K",
  "ansatte": 42,
  "source": "CVR — Erhvervsstyrelsen"
}`}
            />

            <EndpointCard
              method="GET"
              path="/api/v1/people/{enhedsNummer}"
              description="Returns person/owner data identified by their CVR enhedsNummer. Includes name, address, and associated company roles. Only available with the read:people scope."
              scopeRequired="read:people"
              params={[
                {
                  name: 'enhedsNummer',
                  type: 'integer',
                  desc: "Unique unit number (enhedsNummer) from CVR's person register.",
                },
              ]}
              responseExample={`{
  "enhedsNummer": 4000012345,
  "navn": "Anders Andersen",
  "adresse": "Examplevej 12, 2200 København N",
  "roller": [
    {
      "cvr": "12345678",
      "virksomhed": "Eksempel A/S",
      "rolle": "direktør",
      "fratraadt": false
    }
  ],
  "source": "CVR — Erhvervsstyrelsen"
}`}
            />
          </section>

          {/* ── Errors ── */}
          <section id="errors" className="space-y-4">
            <div className="flex items-center gap-3 pb-3 border-b border-white/10">
              <Shield className="w-5 h-5 text-red-400" />
              <h2 className="text-xl font-semibold">Error Codes</h2>
            </div>

            <p className="text-white/60 text-sm">
              All errors follow a consistent JSON shape:{' '}
              <code className="text-amber-300 text-xs bg-black/20 px-1.5 py-0.5 rounded">
                {'{ "error": "...", "code": "..." }'}
              </code>
            </p>

            <table className="w-full text-sm border border-white/10 rounded-lg overflow-hidden">
              <thead>
                <tr className="bg-white/[0.04]">
                  <th className="text-left px-4 py-2.5 text-white/50 text-xs font-medium">HTTP</th>
                  <th className="text-left px-4 py-2.5 text-white/50 text-xs font-medium">Code</th>
                  <th className="text-left px-4 py-2.5 text-white/50 text-xs font-medium">
                    Meaning
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  { http: '401', code: 'UNAUTHORIZED', meaning: 'Missing or invalid API key.' },
                  {
                    http: '403',
                    code: 'FORBIDDEN',
                    meaning: 'Key lacks the required scope for this endpoint.',
                  },
                  {
                    http: '404',
                    code: 'NOT_FOUND',
                    meaning: 'The requested resource does not exist.',
                  },
                  {
                    http: '422',
                    code: 'INVALID_PARAM',
                    meaning: 'A path or query parameter is malformed.',
                  },
                  {
                    http: '429',
                    code: 'RATE_LIMIT_EXCEEDED',
                    meaning: 'Rate limit exceeded. See Retry-After header.',
                  },
                  {
                    http: '500',
                    code: 'UPSTREAM_ERROR',
                    meaning: 'Upstream data source unavailable. Retry with backoff.',
                  },
                ].map((row) => (
                  <tr key={row.code} className="border-t border-white/5">
                    <td className="px-4 py-2.5">
                      <span className="text-red-300 text-sm font-mono">{row.http}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <code className="text-amber-300 text-xs">{row.code}</code>
                    </td>
                    <td className="px-4 py-2.5 text-white/50 text-xs">{row.meaning}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* ── Code Examples ── */}
          <section id="examples" className="space-y-4">
            <div className="flex items-center gap-3 pb-3 border-b border-white/10">
              <Code className="w-5 h-5 text-purple-400" />
              <h2 className="text-xl font-semibold">Code Examples</h2>
            </div>

            <h3 className="text-base font-semibold text-white/80">Fetch a property — cURL</h3>
            <CodeBlock
              lang="bash"
              filename="curl"
              code={`curl -s \\
  -H "Authorization: Bearer bza_<your-api-key>" \\
  "https://app.bizzassist.dk/api/v1/properties/12345678"`}
            />

            <h3 className="text-base font-semibold text-white/80">
              Fetch a property — JavaScript (fetch)
            </h3>
            <CodeBlock
              lang="javascript"
              filename="example.js"
              code={`const BFE = 12345678;

const res = await fetch(
  \`https://app.bizzassist.dk/api/v1/properties/\${BFE}\`,
  {
    headers: {
      Authorization: \`Bearer \${process.env.BIZZASSIST_API_KEY}\`,
    },
  }
);

if (!res.ok) {
  const err = await res.json();
  throw new Error(\`API error \${res.status}: \${err.error}\`);
}

const property = await res.json();
console.log(property.adresse); // "Bredgade 30, 1. th., 1260 København K"`}
            />

            <h3 className="text-base font-semibold text-white/80">
              Fetch a company — Python (httpx)
            </h3>
            <CodeBlock
              lang="python"
              filename="example.py"
              code={`import httpx
import os

API_KEY = os.environ["BIZZASSIST_API_KEY"]
BASE    = "https://app.bizzassist.dk/api/v1"

def get_company(cvr: str) -> dict:
    """Fetch company data by CVR number."""
    resp = httpx.get(
        f"{BASE}/companies/{cvr}",
        headers={"Authorization": f"Bearer {API_KEY}"},
        timeout=10.0,
    )
    resp.raise_for_status()
    return resp.json()

company = get_company("12345678")
print(company["navn"])  # "Eksempel A/S"`}
            />

            <h3 className="text-base font-semibold text-white/80">
              Handle rate limits — JavaScript with retry
            </h3>
            <CodeBlock
              lang="javascript"
              filename="retry.js"
              code={`async function fetchWithRetry(url, options, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);

    if (res.status !== 429) return res;

    // Parse Retry-After header (seconds)
    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "5", 10);
    console.warn(\`Rate limited. Retrying in \${retryAfter}s...\`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
  }
  throw new Error("Max retries exceeded");
}`}
            />
          </section>

          {/* CTA */}
          <div className="rounded-xl bg-blue-600/10 border border-blue-500/20 p-8 text-center space-y-4">
            <h3 className="text-lg font-semibold text-white">Ready to get started?</h3>
            <p className="text-white/50 text-sm">
              Create your first API key from the dashboard. Keys are provisioned instantly.
            </p>
            <Link
              href="/dashboard/tokens?tab=api"
              className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors"
            >
              <Key className="w-4 h-4" />
              Create API key
            </Link>
          </div>
        </main>
      </div>
    </div>
  );
}
