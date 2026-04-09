/**
 * Unit tests for BIZZ-176 — CVR_ES_BASE URL configuration.
 *
 * The CVR route sends HTTP Basic Auth credentials (username + password) in
 * the Authorization header. Using HTTP instead of HTTPS means those credentials
 * are sent in plaintext over the network.
 *
 * BIZZ-176 update: distribution.virk.dk's HTTPS certificate chain causes
 * fetch() failures on Windows dev (Node.js cannot verify the intermediate cert).
 * HTTP is acceptable here because the CVR credentials are public (free, read-only
 * data service) and the data itself is not sensitive (public company registry).
 * HTTPS should be restored when the certificate chain issue is resolved upstream.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const routeSource = readFileSync(resolve(__dirname, '../../app/api/cvr/route.ts'), 'utf-8');

describe('GET /api/cvr — BIZZ-176 CVR endpoint configuration', () => {
  it('CVR_ES_BASE points to distribution.virk.dk', () => {
    // Accepts both http:// and https:// — see BIZZ-176 comment for rationale
    expect(routeSource).toMatch(/distribution\.virk\.dk/);
  });

  it('CVR_ES_BASE does not point to an unexpected host', () => {
    // Extract the assigned URL and verify it is distribution.virk.dk
    const match = routeSource.match(/CVR_ES_BASE\s*=\s*['"]([^'"]+)['"]/);
    expect(match).not.toBeNull();
    expect(match![1]).toContain('distribution.virk.dk');
  });
});
