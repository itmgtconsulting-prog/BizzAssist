/**
 * Unit tests for parseBilXml (BIZZ-529).
 *
 * Guards the XML parser for e-TL's BilSummariskHentResultat response.
 * Shape mirrors LoesoereSummariskHentResultat (used in personbog) — same
 * HaeftelseSummarisk blocks, same namespaces. These tests cover the
 * fields actually rendered in the Tinglysning tab: type, kreditor,
 * hovedstol, dates, and the dokumentId used for PDF download.
 */

import { describe, it, expect } from 'vitest';
import { parseBilXml } from '@/app/api/tinglysning/bilbog/route';

describe('parseBilXml', () => {
  it('extracts a virksomhedspant with creditor, hovedstol and dokumentId', () => {
    const xml = `
      <LoesoereSummariskHentResultat>
        <HaeftelseSummarisk>
          <LoesoereHaeftelseTypeSummariskTekst>virksomhedspant</LoesoereHaeftelseTypeSummariskTekst>
          <KreditorInformationSamling>
            <LegalUnitName>NORDEA BANK A/S</LegalUnitName>
            <CVRnumberIdentifier>13522197</CVRnumberIdentifier>
          </KreditorInformationSamling>
          <DebitorInformationSamling>
            <RolleInformation>
              <LegalUnitName>TEST VIRKSOMHED ApS</LegalUnitName>
              <CVRnumberIdentifier>15231599</CVRnumberIdentifier>
            </RolleInformation>
          </DebitorInformationSamling>
          <BeloebVaerdi>500000</BeloebVaerdi>
          <ValutaKode>DKK</ValutaKode>
          <TinglysningsDato>2023-05-12T09:00:00Z</TinglysningsDato>
          <PrioritetNummer>1</PrioritetNummer>
          <DokumentIdentifikator>doc-uuid-1</DokumentIdentifikator>
          <DokumentAliasIdentifikator>20230512-900001-01</DokumentAliasIdentifikator>
          <HaeftelseRentePaalydendeSats>4.5</HaeftelseRentePaalydendeSats>
          <HaeftelseRenteTypeKode>Fast</HaeftelseRenteTypeKode>
        </HaeftelseSummarisk>
      </LoesoereSummariskHentResultat>
    `;

    const haeftelser = parseBilXml(xml);
    expect(haeftelser).toHaveLength(1);
    const h = haeftelser[0];
    expect(h.type).toBe('virksomhedspant');
    expect(h.kreditor).toBe('NORDEA BANK A/S');
    expect(h.kreditorCvr).toBe('13522197');
    expect(h.debitorer).toContain('TEST VIRKSOMHED ApS');
    expect(h.debitorCvr).toContain('15231599');
    expect(h.hovedstol).toBe(500000);
    expect(h.valuta).toBe('DKK');
    expect(h.tinglysningsdato).toBe('2023-05-12');
    expect(h.prioritet).toBe(1);
    expect(h.dokumentId).toBe('doc-uuid-1');
    expect(h.dokumentAlias).toBe('20230512-900001-01');
    expect(h.rente).toBe(4.5);
    expect(h.renteType).toBe('Fast');
  });

  it('normalises ejendomsforbehold type', () => {
    const xml = `
      <LoesoereSummariskHentResultat>
        <HaeftelseSummarisk>
          <LoesoereHaeftelseTypeSummariskTekst>ejendomsforbehold</LoesoereHaeftelseTypeSummariskTekst>
          <BeloebVaerdi>250000</BeloebVaerdi>
          <DokumentIdentifikator>doc-2</DokumentIdentifikator>
        </HaeftelseSummarisk>
      </LoesoereSummariskHentResultat>
    `;
    const h = parseBilXml(xml)[0];
    expect(h.type).toBe('ejendomsforbehold');
    expect(h.hovedstol).toBe(250000);
  });

  it('handles multiple haeftelser in one XML', () => {
    const xml = `
      <LoesoereSummariskHentResultat>
        <HaeftelseSummarisk>
          <LoesoereHaeftelseTypeSummariskTekst>virksomhedspant</LoesoereHaeftelseTypeSummariskTekst>
          <BeloebVaerdi>100000</BeloebVaerdi>
          <DokumentIdentifikator>a</DokumentIdentifikator>
        </HaeftelseSummarisk>
        <HaeftelseSummarisk>
          <LoesoereHaeftelseTypeSummariskTekst>ejerpantebrev</LoesoereHaeftelseTypeSummariskTekst>
          <BeloebVaerdi>200000</BeloebVaerdi>
          <DokumentIdentifikator>b</DokumentIdentifikator>
        </HaeftelseSummarisk>
      </LoesoereSummariskHentResultat>
    `;
    const rows = parseBilXml(xml);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.type)).toEqual(['virksomhedspant', 'ejerpantebrev']);
    expect(rows.map((r) => r.dokumentId)).toEqual(['a', 'b']);
  });

  it('defaults valuta to DKK when absent', () => {
    const xml = `
      <LoesoereSummariskHentResultat>
        <HaeftelseSummarisk>
          <LoesoereHaeftelseTypeSummariskTekst>virksomhedspant</LoesoereHaeftelseTypeSummariskTekst>
          <BeloebVaerdi>1000</BeloebVaerdi>
        </HaeftelseSummarisk>
      </LoesoereSummariskHentResultat>
    `;
    expect(parseBilXml(xml)[0].valuta).toBe('DKK');
  });

  it('returns empty array for XML with no HaeftelseSummarisk blocks', () => {
    expect(parseBilXml('<LoesoereSummariskHentResultat></LoesoereSummariskHentResultat>')).toEqual(
      []
    );
    expect(parseBilXml('')).toEqual([]);
  });

  it('keeps unrecognised type strings pass-through (do not silently drop)', () => {
    const xml = `
      <LoesoereSummariskHentResultat>
        <HaeftelseSummarisk>
          <LoesoereHaeftelseTypeSummariskTekst>skadesloesbrevBil</LoesoereHaeftelseTypeSummariskTekst>
          <BeloebVaerdi>99</BeloebVaerdi>
        </HaeftelseSummarisk>
      </LoesoereSummariskHentResultat>
    `;
    const h = parseBilXml(xml)[0];
    // Not a known category — preserve raw so it surfaces in UI
    expect(h.type).toBe('skadesloesbrevBil');
  });

  it('falls back to registreringsdato = tinglysningsdato when missing', () => {
    const xml = `
      <LoesoereSummariskHentResultat>
        <HaeftelseSummarisk>
          <LoesoereHaeftelseTypeSummariskTekst>virksomhedspant</LoesoereHaeftelseTypeSummariskTekst>
          <TinglysningsDato>2024-01-02T10:00:00Z</TinglysningsDato>
        </HaeftelseSummarisk>
      </LoesoereSummariskHentResultat>
    `;
    const h = parseBilXml(xml)[0];
    expect(h.tinglysningsdato).toBe('2024-01-02');
    expect(h.registreringsdato).toBe('2024-01-02');
  });
});
