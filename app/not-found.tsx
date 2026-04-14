/**
 * Custom 404 page for the root layout.
 * Keeps it simple to avoid prerender issues during build.
 */

import Link from 'next/link';

export default function NotFound() {
  return (
    <div
      style={{
        maxWidth: 480,
        margin: '120px auto',
        textAlign: 'center',
        padding: 24,
        color: '#e2e8f0',
      }}
    >
      <h1 style={{ fontSize: 48, marginBottom: 8, fontWeight: 700 }}>404</h1>
      <p style={{ fontSize: 16, color: '#94a3b8', marginBottom: 24 }}>Siden blev ikke fundet.</p>
      <Link
        href="/"
        style={{
          padding: '10px 24px',
          backgroundColor: '#3b82f6',
          color: '#fff',
          borderRadius: 8,
          textDecoration: 'none',
          fontSize: 14,
        }}
      >
        Gå til forsiden
      </Link>
    </div>
  );
}
