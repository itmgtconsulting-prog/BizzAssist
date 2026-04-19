/**
 * Unit tests for parseAndelXml (BIZZ-530).
 *
 * Guards the e-TL AndelSummariskHentResultat XML parser. Covers:
 *   - Address fields on andelsbolig-niveau (vejnavn/husnr/etage/side/postnr)
 *   - Shared Løsøre HaeftelseSummarisk block (same as personbog/bilbog)
 *   - Type normalisation (andelspantebrev)
 *   - Multiple hæftelser in one XML
 */

import { describe, it, expect } from 'vitest';
import { parseAndelXml } from '@/app/api/tinglysning/andelsbog/route';

describe('parseAndelXml', () => {
  it('extracts address fields (vejnavn, husnr, etage, side, postnr, by)', () => {
    const xml = `
      <AndelSummariskHentResultat>
        <AndelsboligAdresse>
          <VejAdresseringsNavn>Nørrebrogade</VejAdresseringsNavn>
          <HusNummerIdentifikator>16</HusNummerIdentifikator>
          <Etage>3</Etage>
          <SideDoer>TV</SideDoer>
          <PostCodeIdentifier>2200</PostCodeIdentifier>
          <DistrictName>København N</DistrictName>
          <KommuneName>Københavns Kommune</KommuneName>
        </AndelsboligAdresse>
      </AndelSummariskHentResultat>
    `;
    const out = parseAndelXml(xml);
    expect(out.adresse.vejnavn).toBe('Nørrebrogade');
    expect(out.adresse.husnr).toBe('16');
    expect(out.adresse.etage).toBe('3');
    expect(out.adresse.side).toBe('TV');
    expect(out.adresse.postnr).toBe('2200');
    expect(out.adresse.by).toBe('København N');
    expect(out.adresse.kommune).toBe('Københavns Kommune');
    expect(out.haeftelser).toHaveLength(0);
  });

  it('extracts an andelspantebrev with creditor, hovedstol, dates', () => {
    const xml = `
      <AndelSummariskHentResultat>
        <HaeftelseSummarisk>
          <LoesoereHaeftelseTypeSummariskTekst>andelspantebrev</LoesoereHaeftelseTypeSummariskTekst>
          <KreditorInformationSamling>
            <LegalUnitName>NYKREDIT REALKREDIT A/S</LegalUnitName>
            <CVRnumberIdentifier>12719280</CVRnumberIdentifier>
          </KreditorInformationSamling>
          <DebitorInformationSamling>
            <RolleInformation>
              <LegalUnitName>TEST ANDELSFORENING</LegalUnitName>
              <CVRnumberIdentifier>15231599</CVRnumberIdentifier>
            </RolleInformation>
          </DebitorInformationSamling>
          <BeloebVaerdi>1250000</BeloebVaerdi>
          <ValutaKode>DKK</ValutaKode>
          <TinglysningsDato>2023-10-05T09:30:00Z</TinglysningsDato>
          <PrioritetNummer>1</PrioritetNummer>
          <DokumentIdentifikator>andel-doc-1</DokumentIdentifikator>
          <DokumentAliasIdentifikator>20231005-900100-01</DokumentAliasIdentifikator>
        </HaeftelseSummarisk>
      </AndelSummariskHentResultat>
    `;
    const out = parseAndelXml(xml);
    expect(out.haeftelser).toHaveLength(1);
    const h = out.haeftelser[0];
    expect(h.type).toBe('andelspantebrev');
    expect(h.kreditor).toBe('NYKREDIT REALKREDIT A/S');
    expect(h.kreditorCvr).toBe('12719280');
    expect(h.debitorer).toContain('TEST ANDELSFORENING');
    expect(h.hovedstol).toBe(1250000);
    expect(h.tinglysningsdato).toBe('2023-10-05');
    expect(h.prioritet).toBe(1);
    expect(h.dokumentId).toBe('andel-doc-1');
    expect(h.dokumentAlias).toBe('20231005-900100-01');
  });

  it('parses multiple hæftelser in one XML', () => {
    const xml = `
      <AndelSummariskHentResultat>
        <HaeftelseSummarisk>
          <LoesoereHaeftelseTypeSummariskTekst>andelspantebrev</LoesoereHaeftelseTypeSummariskTekst>
          <BeloebVaerdi>100000</BeloebVaerdi>
          <DokumentIdentifikator>a</DokumentIdentifikator>
        </HaeftelseSummarisk>
        <HaeftelseSummarisk>
          <LoesoereHaeftelseTypeSummariskTekst>pantebrev</LoesoereHaeftelseTypeSummariskTekst>
          <BeloebVaerdi>50000</BeloebVaerdi>
          <DokumentIdentifikator>b</DokumentIdentifikator>
        </HaeftelseSummarisk>
      </AndelSummariskHentResultat>
    `;
    const out = parseAndelXml(xml);
    expect(out.haeftelser).toHaveLength(2);
    expect(out.haeftelser.map((h) => h.type)).toEqual(['andelspantebrev', 'pantebrev']);
    expect(out.haeftelser.map((h) => h.hovedstol)).toEqual([100000, 50000]);
  });

  it('returns empty hæftelser + null address for unrelated XML', () => {
    const out = parseAndelXml('<AndelSummariskHentResultat></AndelSummariskHentResultat>');
    expect(out.haeftelser).toEqual([]);
    expect(out.adresse.vejnavn).toBeNull();
    expect(out.adresse.postnr).toBeNull();
  });

  it('defaults valuta to DKK and preserves unknown type strings', () => {
    const xml = `
      <AndelSummariskHentResultat>
        <HaeftelseSummarisk>
          <LoesoereHaeftelseTypeSummariskTekst>specialtype</LoesoereHaeftelseTypeSummariskTekst>
          <BeloebVaerdi>99</BeloebVaerdi>
        </HaeftelseSummarisk>
      </AndelSummariskHentResultat>
    `;
    const h = parseAndelXml(xml).haeftelser[0];
    expect(h.valuta).toBe('DKK');
    expect(h.type).toBe('specialtype');
  });
});
