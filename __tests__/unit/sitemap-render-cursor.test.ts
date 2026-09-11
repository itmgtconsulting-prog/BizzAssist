/**
 * BIZZ-2268: Unit-tests for deterministisk sitemap-render-cursor.
 *
 * page_id blev tidligere genberegnet fra count(entries < cursor)/PAGE_SIZE pr.
 * budget-begraenset koersel → drev naar entries blev tilfoejet/purged → huller +
 * omnummerering (66 sider men max page_id 95). Cursoren er nu komposit
 * "<pageId>|<uuid>" saa page_id genoptages monotont. Disse tests laaser parsingen.
 */
import { describe, it, expect } from 'vitest';
import { parseRenderCursor } from '@/app/api/cron/generate-sitemap/route';

const UUID = 'a1b2c3d4-e5f6-7788-99aa-bbccddeeff00';

describe('BIZZ-2268 parseRenderCursor', () => {
  it('null/0 → fresh (start fra page 0)', () => {
    expect(parseRenderCursor(null)).toEqual({ kind: 'fresh' });
    expect(parseRenderCursor('0')).toEqual({ kind: 'fresh' });
  });

  it('komposit "<pageId>|<uuid>" → genoptag page_id direkte', () => {
    expect(parseRenderCursor(`42|${UUID}`)).toEqual({
      kind: 'composite',
      pageId: 42,
      afterId: UUID,
    });
    expect(parseRenderCursor(`0|${UUID}`)).toEqual({ kind: 'composite', pageId: 0, afterId: UUID });
  });

  it('legacy bare-UUID → engangs-genberegning', () => {
    expect(parseRenderCursor(UUID)).toEqual({ kind: 'legacy', afterId: UUID });
  });

  it('korrupt komposit (ugyldig pageId eller uuid) → invalid', () => {
    expect(parseRenderCursor('abc|' + UUID).kind).toBe('invalid');
    expect(parseRenderCursor('5|not-a-uuid').kind).toBe('invalid');
    expect(parseRenderCursor('-1|' + UUID).kind).toBe('invalid');
  });

  it('vilkaarlig junk → invalid (restart forfra, ingen infinite-loop)', () => {
    const r = parseRenderCursor('40');
    expect(r.kind).toBe('invalid');
  });

  it('composite bevarer monotont page_id (regression mod huller)', () => {
    // Simulér genoptagelse: hver koersel gemmer "<naeste pageId>|<uuid>" og
    // laeser den tilbage — page_id skal aldrig hoppe tilbage/springe.
    let saved = '0';
    const pages: number[] = [];
    for (let run = 0; run < 5; run++) {
      const p = parseRenderCursor(saved);
      const startPage = p.kind === 'composite' ? p.pageId : 0;
      // render 3 sider pr. koersel
      for (let i = 0; i < 3; i++) pages.push(startPage + i);
      saved = `${startPage + 3}|${UUID}`;
    }
    // 0..14 kontinuert uden huller/dubletter
    expect(pages).toEqual(Array.from({ length: 15 }, (_, i) => i));
  });
});
