# HTTP XML API — EjendomIndskannetAktHent

## Endpoint

| Miljø             | URL                                                               |
| ----------------- | ----------------------------------------------------------------- |
| Test (fællestest) | `https://test-xml-api.tinglysning.dk/etl/services/ElektroniskAkt` |
| Test (hotfix)     | `https://dss-xml-api.tinglysning.dk/etl/services/ElektroniskAkt`  |
| Produktion        | `https://xml-api.tinglysning.dk/etl/services/ElektroniskAkt`      |

## HTTP Request (ny S2S HTTP-stil, jf. s2s-dokumentation-07)

```
POST /ElektroniskAkt/EjendomIndskannetAktHent HTTP/1.1
Content-Type: application/xml
Tinglysning-Message-ID: uuid:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Transport: mTLS med OCES virksomhedscertifikat (P12/PKCS#12).

**OBS: Gamle SOAP-endpoint `/etl/services/ElektroniskAkt` er udfaset.**
Ny stil: `/<ServiceName>/<Operation>` — ingen SOAPAction, Content-Type er `application/xml`.

**Bekræftede headers (testet mod test-xml-api.tinglysning.dk 2026-04-13):**

- `Tinglysning-Message-ID` er OBLIGATORISK (400 hvis mangler)
- Format: `uuid:` + lowercase UUID (f.eks. `uuid:4cf20a2e-76de-41b5-9b31-a5c16c8babc0`)
- Forkert format → `"Det modtagne MessageID er i invalidt format: <id>. Et MessageID skal være på formen uuid:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}"`

## Request XML (EjendomIndskannetAktHent)

```xml
<EjendomIndskannetAktHent
  xmlns="http://rep.oio.dk/tinglysning.dk/service/message/elektroniskakt/1/"
  xmlns:eakt="http://rep.oio.dk/tinglysning.dk/schema/elektroniskakt/1/"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
  <eakt:DokumentFilnavnTekst>1_H-I_458</eakt:DokumentFilnavnTekst>
  <!-- ErklaeringAfgiftsfriOpslag er optional (bobestyrer/landinspektør) -->
  <ds:Signature><!-- OBLIGATORISK: XMLDSig enveloped signature med OCES cert --></ds:Signature>
</EjendomIndskannetAktHent>
```

**Vigtigt:** `ds:Signature` er OBLIGATORISK (minOccurs ikke 0 i XSD).
Signering bruger enveloped XMLDSig med RSA-SHA256 og OCES virksomhedscertifikat.

Hvad der skal signeres (xPath `/*`, transform: `enveloped-signature`):

- `EjendomIndskannetAktHent`-elementet som helhed

## Response XML (EjendomIndskannetAktHentResultat)

```xml
<EjendomIndskannetAktHentResultat ...>
  <eakt:IndskannetDokumentDataBinaer>
    <eakt:DokumentFilnavnTekst>1_H-I_458</eakt:DokumentFilnavnTekst>
    <eakt:MimetypeKodeTekst>application/pdf</eakt:MimetypeKodeTekst>
    <eakt:IndskannetDokumentData><!-- base64-encoded PDF --></eakt:IndskannetDokumentData>
  </eakt:IndskannetDokumentDataBinaer>
  <ds:Signature>...</ds:Signature>
</EjendomIndskannetAktHentResultat>
```

PDF-indhold er base64-encodet i `IndskannetDokumentData`.

## WS-Addressing (optional)

Reference-klienten sender `messageId` (UUID) og evt. `relatesTo` som HTTP-headers
eller i SOAP-header. Sandsynligvis:

```
Message-Id: <uuid>
Relates-To: <optional>
```

## Status (testet 2026-04-13)

| Cert                                          | Resultat                                                     | Konklusion                                 |
| --------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| NemLogin devtest4 (Bizzssist-Dev-NemIDv4.p12) | HTTP 500 "Intern fejl" (samme fejlkode for alle operationer) | Cert ikke autoriseret i DOMETL for XML API |
| Prod FOCES (BizzAssist (2).p12)               | ECONNRESET                                                   | Prod-cert ikke tilladt på test-miljø       |

**Hvad der mangler**: XML API-adgang kræver en FOCES test-cert registreret med Tinglysningsretten
via ansøgning om HTTP XML API-adgang. Dette er en separat ansøgningsproces fra HTTP API.

Kodeimplementationen i `app/api/tinglysning/indskannede-akter/download/route.ts` er korrekt
og klar — mangler blot godkendelse fra Tinglysningsretten + FOCES test-cert.

## Kilde

- `ElektroniskAkt.wsdl` — SOAP 1.1 binding, document/literal style
- `EjendomIndskannetAktHent.xsd` — request schema (v53.1.0.1)
- `EjendomIndskannetAktHentResultat.xsd` — response schema
- `xmlapi-reference-client-53009.zip` — Java Groovy test: `ElektroniskAktControllerSpec.groovy`
- Bekræftet af Domstolsstyrelsen (e-tl-011@domstol.dk, 2026-04-13)
