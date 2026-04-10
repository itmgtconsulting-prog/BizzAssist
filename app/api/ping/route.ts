/**
 * Minimal ping endpoint — zero dependencies, used for production diagnostics.
 */
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ pong: true, time: Date.now() });
}
