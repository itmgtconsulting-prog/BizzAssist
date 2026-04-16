/**
 * Shared Zod validation helpers for API routes.
 *
 * BIZZ-210: replaces manual if-checks with schema-based validation.
 * Usage:
 *   const result = await parseBody(request, mySchema);
 *   if (!result.success) return result.response;
 *   const { field1, field2 } = result.data;
 *
 * @module
 */

import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';

// ─── Common reusable schemas ────────────────────────────────────────────────

/** Danish CVR number — 8 digits */
export const cvrSchema = z.string().regex(/^\d{8}$/, 'CVR skal være 8 cifre');

/** BFE number — positive integer as string */
export const bfeSchema = z.string().regex(/^\d+$/, 'BFE skal være et positivt heltal');

/** Search query — trimmed, min 2 chars, max 500 chars */
export const searchQuerySchema = z.string().trim().min(2).max(500);

/** Pagination limit — integer between 1 and 100, default 20 */
export const limitSchema = z.coerce.number().int().min(1).max(100).default(20);

/** Language code */
export const langSchema = z.enum(['da', 'en']).default('da');

// ─── Body parser ────────────────────────────────────────────────────────────

type ParseSuccess<T> = { success: true; data: T };
type ParseFailure = { success: false; response: NextResponse };

/**
 * Parse and validate a JSON request body against a Zod schema.
 *
 * Returns typed data on success, or a 400 NextResponse on failure.
 * Catches malformed JSON and schema validation errors.
 *
 * @param request - Incoming Next.js request
 * @param schema - Zod schema to validate against
 * @returns Parsed data or error response
 */
export async function parseBody<T extends z.ZodType>(
  request: NextRequest,
  schema: T
): Promise<ParseSuccess<z.infer<T>> | ParseFailure> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return {
      success: false,
      response: NextResponse.json({ error: 'Ugyldig JSON' }, { status: 400 }),
    };
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    // Include the first validation error path for debuggability
    const firstIssue = result.error.issues[0];
    const path = firstIssue?.path?.join('.') || '';
    const msg = path ? `Ugyldigt input: ${path}` : 'Ugyldigt input';
    return {
      success: false,
      response: NextResponse.json({ error: msg }, { status: 400 }),
    };
  }

  return { success: true, data: result.data };
}

/**
 * Parse and validate URL search params against a Zod schema.
 *
 * Converts searchParams to a plain object and validates against the schema.
 * Useful for GET routes with query parameters.
 *
 * @param request - Incoming Next.js request
 * @param schema - Zod schema to validate against
 * @returns Parsed data or error response
 */
export function parseQuery<T extends z.ZodType>(
  request: NextRequest,
  schema: T
): ParseSuccess<z.infer<T>> | ParseFailure {
  const params: Record<string, string> = {};
  request.nextUrl.searchParams.forEach((value, key) => {
    params[key] = value;
  });

  const result = schema.safeParse(params);
  if (!result.success) {
    return {
      success: false,
      response: NextResponse.json({ error: 'Ugyldige parametre' }, { status: 400 }),
    };
  }

  return { success: true, data: result.data };
}
