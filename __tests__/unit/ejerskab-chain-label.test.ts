/**
 * Unit tests for resolvePropertyLabel (BIZZ — ejerskab diagram root node).
 *
 * Bug seen 2026-04-18: Ejerskabsdiagram viste en tom, grøn boks for
 * selve ejendommen når klienten havde sendt en `adresse` query-param
 * med manglende felter (endte som `" ,  , , "` efter template-
 * konstruktionen). resolvePropertyLabel garanterer at node.label
 * altid er ikke-tom ved at falde tilbage til "BFE <nr>".
 */

import { describe, it, expect } from 'vitest';
import { resolvePropertyLabel } from '@/app/api/ejerskab/chain/route';

describe('resolvePropertyLabel (ejerskab chain)', () => {
  it('returns the original adresse when it carries real content', () => {
    expect(resolvePropertyLabel('Søbyvej 11, 2650 Hvidovre', 2081243)).toBe(
      'Søbyvej 11, 2650 Hvidovre'
    );
  });

  it('preserves commas inside a real address (no aggressive normalisation)', () => {
    // A full address with etage/dør keeps its commas — we only fall back
    // when the string is effectively empty.
    const full = 'Bredgade 1, 2. tv., 1260 København K';
    expect(resolvePropertyLabel(full, 100)).toBe(full);
  });

  it('falls back to `BFE <nr>` on an empty string', () => {
    expect(resolvePropertyLabel('', 2081243)).toBe('BFE 2081243');
  });

  it('falls back to `BFE <nr>` when adresse is only commas and whitespace', () => {
    // This is the exact shape the bug report produced — missing vejnavn/
    // husnr/postnr in dawaAdresse.
    expect(resolvePropertyLabel(' ,  ,  ', 2081243)).toBe('BFE 2081243');
    expect(resolvePropertyLabel(',,,', 500)).toBe('BFE 500');
    expect(resolvePropertyLabel('   ', 999)).toBe('BFE 999');
  });

  it('falls back when adresse is null/undefined-coerced (defensive)', () => {
    // TypeScript guards against null, but defensive runtime coercion means
    // a dynamic caller won't break the handler.
    expect(resolvePropertyLabel(null as unknown as string, 1)).toBe('BFE 1');
    expect(resolvePropertyLabel(undefined as unknown as string, 1)).toBe('BFE 1');
  });

  it('accepts bfe as number or string (route passes the query-param raw)', () => {
    expect(resolvePropertyLabel('', 42)).toBe('BFE 42');
    expect(resolvePropertyLabel('', '42')).toBe('BFE 42');
  });
});
