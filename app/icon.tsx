/**
 * BizzAssist browser-tab favicon — app/icon.tsx
 *
 * Next.js App Router picks this up automatically and serves it as
 * /icon (PNG) with the correct <link rel="icon"> tag in <head>.
 * Replaces the default Vercel triangle favicon.
 *
 * Design: navy blue rounded square + white "B" in Geist font, matching
 * the BizzAssist logo shown in the navbar and login page.
 *
 * @returns ImageResponse — 32×32 PNG favicon
 */

import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/png';

/** Generates the 32×32 BizzAssist favicon at request time. */
export default function Icon() {
  return new ImageResponse(
    <div
      style={{
        width: 32,
        height: 32,
        borderRadius: 7,
        background: '#2563eb',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <span
        style={{
          color: '#ffffff',
          fontSize: 20,
          fontWeight: 700,
          fontFamily: 'sans-serif',
          lineHeight: 1,
          marginTop: 1,
        }}
      >
        B
      </span>
    </div>,
    { ...size }
  );
}
