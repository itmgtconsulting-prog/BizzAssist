/**
 * Global error boundary — catches errors outside the root layout.
 * Must provide its own html/body since root layout is unavailable.
 *
 * IMPORTANT: Next.js prerenders this during build. All context-dependent
 * code (hooks, providers) must be avoided at the top level.
 */

'use client';

export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="da">
      <body style={{ backgroundColor: '#0a1020', color: '#e2e8f0', fontFamily: 'system-ui' }}>
        <div style={{ maxWidth: 480, margin: '120px auto', textAlign: 'center', padding: 24 }}>
          <h1 style={{ fontSize: 24, marginBottom: 16 }}>Noget gik galt</h1>
          <p style={{ fontSize: 14, color: '#94a3b8', marginBottom: 24 }}>
            En uventet fejl opstod. Prøv at genindlæse siden.
          </p>
          <button
            onClick={reset}
            style={{
              padding: '10px 24px',
              backgroundColor: '#3b82f6',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Prøv igen
          </button>
        </div>
      </body>
    </html>
  );
}
