/**
 * Unit tests for parsePaategningXml (BIZZ-522).
 *
 * Guards e-TL's DokumentRevisionssporHentResultat XML parser. Covers:
 *   - Revision extraction (nummer, dato, type)
 *   - Anmelder-info (person vs virksomhed)
 *   - Type normalisation (aflysning, delindfrielse, rettelse, paategning)
 *   - Chronological sorting (oldest first) with nummer tiebreaker
 *   - Missing-date rows sink to the end
 *   - Unknown types pass through unchanged (not silently dropped)
 */

import { describe, it, expect } from 'vitest';
import { parsePaategningXml } from '@/app/api/tinglysning/paategning/route';

describe('parsePaategningXml', () => {
  it('extracts a single paategning with number, date, type and anmelder', () => {
    const xml = `
      <DokumentRevisionssporHentResultat>
        <DokumentRevision>
          <RevisionNummer>2</RevisionNummer>
          <RegistreringsDato>2023-03-15T10:00:00Z</RegistreringsDato>
          <PaategningType>delindfrielse</PaategningType>
          <Bemaerkning>50% indfriet</Bemaerkning>
          <AnmelderInformation>
            <LegalUnitName>NORDEA BANK A/S</LegalUnitName>
            <CVRnumberIdentifier>13522197</CVRnumberIdentifier>
          </AnmelderInformation>
          <DokumentIdentifikator>rev-doc-1</DokumentIdentifikator>
          <DokumentAliasIdentifikator>20230315-900001-02</DokumentAliasIdentifikator>
        </DokumentRevision>
      </DokumentRevisionssporHentResultat>
    `;
    const out = parsePaategningXml(xml);
    expect(out).toHaveLength(1);
    const r = out[0];
    expect(r.nummer).toBe(2);
    expect(r.dato).toBe('2023-03-15');
    expect(r.type).toBe('delindfrielse');
    expect(r.beskrivelse).toBe('50% indfriet');
    expect(r.anmelderNavn).toBe('NORDEA BANK A/S');
    expect(r.anmelderCvr).toBe('13522197');
    expect(r.dokumentId).toBe('rev-doc-1');
    expect(r.dokumentAlias).toBe('20230315-900001-02');
  });

  it('sorts revisions chronologically — oldest first', () => {
    const xml = `
      <DokumentRevisionssporHentResultat>
        <DokumentRevision>
          <RevisionNummer>3</RevisionNummer>
          <RegistreringsDato>2024-01-01T09:00:00Z</RegistreringsDato>
          <PaategningType>rettelse</PaategningType>
          <DokumentIdentifikator>c</DokumentIdentifikator>
        </DokumentRevision>
        <DokumentRevision>
          <RevisionNummer>1</RevisionNummer>
          <RegistreringsDato>2020-05-12T09:00:00Z</RegistreringsDato>
          <PaategningType>paategning</PaategningType>
          <DokumentIdentifikator>a</DokumentIdentifikator>
        </DokumentRevision>
        <DokumentRevision>
          <RevisionNummer>2</RevisionNummer>
          <RegistreringsDato>2022-07-20T09:00:00Z</RegistreringsDato>
          <PaategningType>delindfrielse</PaategningType>
          <DokumentIdentifikator>b</DokumentIdentifikator>
        </DokumentRevision>
      </DokumentRevisionssporHentResultat>
    `;
    const out = parsePaategningXml(xml);
    expect(out.map((r) => r.dokumentId)).toEqual(['a', 'b', 'c']);
    expect(out.map((r) => r.nummer)).toEqual([1, 2, 3]);
  });

  it('normalises type strings to known categories', () => {
    const xml = `
      <DokumentRevisionssporHentResultat>
        <DokumentRevision>
          <RevisionNummer>1</RevisionNummer>
          <RegistreringsDato>2020-01-01T00:00:00Z</RegistreringsDato>
          <PaategningType>aflysning af dokumentet</PaategningType>
        </DokumentRevision>
        <DokumentRevision>
          <RevisionNummer>2</RevisionNummer>
          <RegistreringsDato>2020-02-01T00:00:00Z</RegistreringsDato>
          <PaategningType>Korrektion til hovedstol</PaategningType>
        </DokumentRevision>
      </DokumentRevisionssporHentResultat>
    `;
    const types = parsePaategningXml(xml).map((r) => r.type);
    expect(types).toEqual(['aflysning', 'rettelse']);
  });

  it('passes unknown type strings through (so they surface in UI)', () => {
    const xml = `
      <DokumentRevisionssporHentResultat>
        <DokumentRevision>
          <RevisionNummer>1</RevisionNummer>
          <RegistreringsDato>2020-01-01T00:00:00Z</RegistreringsDato>
          <PaategningType>specialtype-der-ikke-kendes</PaategningType>
        </DokumentRevision>
      </DokumentRevisionssporHentResultat>
    `;
    expect(parsePaategningXml(xml)[0].type).toBe('specialtype-der-ikke-kendes');
  });

  it('places revisions without date at the end of the list', () => {
    const xml = `
      <DokumentRevisionssporHentResultat>
        <DokumentRevision>
          <RevisionNummer>2</RevisionNummer>
          <PaategningType>paategning</PaategningType>
          <DokumentIdentifikator>no-date</DokumentIdentifikator>
        </DokumentRevision>
        <DokumentRevision>
          <RevisionNummer>1</RevisionNummer>
          <RegistreringsDato>2020-01-01T00:00:00Z</RegistreringsDato>
          <PaategningType>paategning</PaategningType>
          <DokumentIdentifikator>has-date</DokumentIdentifikator>
        </DokumentRevision>
      </DokumentRevisionssporHentResultat>
    `;
    const ids = parsePaategningXml(xml).map((r) => r.dokumentId);
    expect(ids).toEqual(['has-date', 'no-date']);
  });

  it('returns empty array for XML without DokumentRevision blocks', () => {
    expect(parsePaategningXml('<DokumentRevisionssporHentResultat/>')).toEqual([]);
    expect(parsePaategningXml('')).toEqual([]);
  });

  it('extracts person-anmelder when PersonName is used instead of LegalUnitName', () => {
    const xml = `
      <DokumentRevisionssporHentResultat>
        <DokumentRevision>
          <RevisionNummer>1</RevisionNummer>
          <RegistreringsDato>2021-06-15T00:00:00Z</RegistreringsDato>
          <PaategningType>paategning</PaategningType>
          <AnmelderInformation>
            <PersonName>Jens Hansen</PersonName>
          </AnmelderInformation>
        </DokumentRevision>
      </DokumentRevisionssporHentResultat>
    `;
    const r = parsePaategningXml(xml)[0];
    expect(r.anmelderNavn).toBe('Jens Hansen');
    expect(r.anmelderCvr).toBeNull();
  });
});
