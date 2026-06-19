/**
 * Unit tests for deltagerType — BIZZ-2086.
 *
 * Klassificering af CVR-deltagere som person vs. virksomhed
 * (enhedstype primært, navne-heuristik som fallback).
 */

import { describe, it, expect } from 'vitest';
import { looksLikeCompanyName, erVirksomhedsDeltager } from '@/app/lib/cvr/deltagerType';

describe('looksLikeCompanyName', () => {
  it('matcher typiske selskabsform-suffikser', () => {
    expect(looksLikeCompanyName('Selmont Holding ApS')).toBe(true);
    expect(looksLikeCompanyName('JB Kapital ApS')).toBe(true);
    expect(looksLikeCompanyName('RACEHALL HOLDING A/S')).toBe(true);
    expect(looksLikeCompanyName('Vestjysk Landbrug I/S')).toBe(true);
    expect(looksLikeCompanyName('Ejendomsselskabet K/S Nord')).toBe(true);
    expect(looksLikeCompanyName('Realdania Fonden')).toBe(true);
    expect(looksLikeCompanyName('Andelskassen AMBA')).toBe(true);
  });

  it('matcher ikke almindelige personnavne', () => {
    expect(looksLikeCompanyName('Henrik Stærmose')).toBe(false);
    expect(looksLikeCompanyName('Poul Plougmann')).toBe(false);
    expect(looksLikeCompanyName('Mette Brunsborg')).toBe(false);
    // "as"/"invest" som del af et ord må ikke matche
    expect(looksLikeCompanyName('Lasse Asmussen')).toBe(false);
  });

  it('håndterer null/undefined/tom', () => {
    expect(looksLikeCompanyName(null)).toBe(false);
    expect(looksLikeCompanyName(undefined)).toBe(false);
    expect(looksLikeCompanyName('')).toBe(false);
  });
});

describe('erVirksomhedsDeltager', () => {
  it('enhedstype har forrang over navn', () => {
    // CVR ES bruger uppercase, cvr_deltager-cachen lowercase
    expect(erVirksomhedsDeltager('VIRKSOMHED', 'Henrik Stærmose')).toBe(true);
    expect(erVirksomhedsDeltager('virksomhed', 'Henrik Stærmose')).toBe(true);
    expect(erVirksomhedsDeltager('PERSON', 'Selmont Holding ApS')).toBe(false);
    expect(erVirksomhedsDeltager('person', 'Selmont Holding ApS')).toBe(false);
    expect(erVirksomhedsDeltager('ANDEN_DELTAGER', 'Foreign Entity Ltd')).toBe(true);
  });

  it('falder tilbage til navne-heuristik når enhedstype mangler', () => {
    expect(erVirksomhedsDeltager(null, 'Selmont Holding ApS')).toBe(true);
    expect(erVirksomhedsDeltager(null, 'Henrik Stærmose')).toBe(false);
    expect(erVirksomhedsDeltager(undefined, null)).toBe(false);
  });
});
