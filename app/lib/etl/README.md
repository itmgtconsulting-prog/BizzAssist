# `app/lib/etl/` — Tinglysning S2S XML API klient

Implementerer Tinglysningsrettens HTTP XML API (S2S) integration. Bruges som alternativ til den gamle HTTP API (`tlFetch.ts`) til operationer der kræver S2S-protokol — særligt anmelder-flow.

## Arkitektur

```
BizzAssist API route (/api/etl/...)
   ↓
xmlClient.callEtl()  ─── kalder ────►  xmlSigner.signXmlBody()
   ↓                                          ↓ XMLDSig RSA-SHA256
   ↓ POST signed XML
   ↓ X-Proxy-Secret: ${DF_PROXY_SECRET}
Hetzner-proxy (204.168.164.252)
   ↓ mTLS m/ TINGLYSNING_CERT_B64
xml-api.tinglysning.dk/ElektroniskAkt/<Operation>
   ↓ SOAP response (200 OK) eller SOAP fault (400/500)
xmlClient parser respons → typed result eller EtlFault
```

## Begge miljøer peger på prod Tinglysning

Per ADR 0009: både `bizzassist.dk` (Production) og `test.bizzassist.dk` (Preview) bruger **prod XML API** (`xml-api.tinglysning.dk`) med prod-cert.

Test-miljøet hos Tinglysningsretten (test.tinglysning.dk / test-xml-api.tinglysning.dk) er **ikke** i brug — vi har ikke ansøgt om test-S2S-adgang.

**Konsekvens:** Forespørgsler fra preview rammer ægte prod-data. Anmelder-operationer skal være feature-flagged OFF på preview (`ENABLE_S2S_ANMELDER=false`) for at undgå utilsigtede juridiske tinglysninger.

## Status

| Modul               | Status                                                                | Ticket    |
| ------------------- | --------------------------------------------------------------------- | --------- |
| `errors.ts`         | ✅ Færdig (typer + EtlFault/EtlTransportError)                        | —         |
| `xmlClient.ts`      | 🟡 Stub — signaturer på plads, body kommer i BIZZ-XX1                 | BIZZ-XX1  |
| `xmlSigner.ts`      | 🟡 Stub — XMLDSig-konfiguration dokumenteret, impl. kommer i BIZZ-XX2 | BIZZ-XX2  |
| `requestBuilder.ts` | ❌ Mangler — kommer i BIZZ-XX3                                        | BIZZ-XX3  |
| `responseParser.ts` | ❌ Mangler — kommer i BIZZ-XX4                                        | BIZZ-XX4  |
| `types.ts`          | ❌ Mangler — XSD-til-TS-typer kommer i BIZZ-XX10                      | BIZZ-XX10 |

Se `docs/adr/0009-s2s-xml-api-integration.md` for fuld roadmap.

## Påkrævede env-vars

```
TINGLYSNING_CERT_B64       # Base64 PFX med cert + privat nøgle (samme som tlFetch)
TINGLYSNING_CERT_PASSWORD  # PFX password
TINGLYSNING_XML_BASE_URL   # https://xml-api.tinglysning.dk (default — begge miljøer)
DF_PROXY_URL               # Hetzner proxy URL
DF_PROXY_SECRET            # Proxy auth header
```

`validateEtlConfig()` i `xmlClient.ts` kan bruges af health-check / startup til at alerte hvis noget mangler.

## Reference

- WSDL: `docs/tinglysning/xmlapi/ElektroniskAkt.wsdl` (33 operationer)
- XSD'er: `docs/tinglysning/xmlapi/*.xsd`
- Notes: `docs/tinglysning/xmlapi/XMLAPI-NOTES.md` (URL-stil, headers, signatur)
- Manual: `docs/tinglysning/system-systemmanual-v1.53.txt` (fejlkoder)
- ADR: `docs/adr/0009-s2s-xml-api-integration.md`
