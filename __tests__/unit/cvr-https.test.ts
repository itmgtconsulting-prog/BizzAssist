/**
 * Unit tests for BIZZ-176 — CVR_ES_BASE must use HTTPS.
 *
 * The CVR route sends HTTP Basic Auth credentials (username + password) in
 * the Authorization header. Using HTTP instead of HTTPS means those credentials
 * are sent in plaintext over the network.
 *
 * This test reads the route source directly and verifies the URL uses HTTPS.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const routeSource = readFileSync(resolve(__dirname, '../../app/api/cvr/route.ts'), 'utf-8');

describe('GET /api/cvr — BIZZ-176 HTTPS enforcement', () => {
  it('CVR_ES_BASE uses https:// not http://', () => {
    expect(routeSource).toContain('https://distribution.virk.dk');
  });

  it('does not contain the plaintext http:// endpoint', () => {
    expect(routeSource).not.toContain("'http://distribution.virk.dk");
    expect(routeSource).not.toContain('"http://distribution.virk.dk');
  });
});
