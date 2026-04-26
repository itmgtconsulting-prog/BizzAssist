# Ansøgning om adgang til e-TL testmiljøer

**Sendes til:** e-tl-011@domstol.dk

---

## Ansøgningsskema

**Virksomhed**

| Felt    | Værdi                     |
| ------- | ------------------------- |
| Navn    | Pecunia IT Consulting ApS |
| CVR-nr. | 44718502                  |

**Primær teknisk kontakt**

| Felt       | Værdi                     |
| ---------- | ------------------------- |
| Navn       | Jakob Juul Rasmussen      |
| E-mail     | itmgtconsulting@gmail.com |
| Telefonnr. | +45 24342655              |

**Snitflader**

| Felt         | Værdi |
| ------------ | ----- |
| REST API     | Ja    |
| HTTP XML API | Nej   |

**Anvendelse**

| Felt          | Værdi |
| ------------- | ----- |
| Forespørgsler | Ja    |
| Anmeldelser   | Nej   |

**IP-adresser der skal have adgang til valgte snitflader**

| Miljø              | IP-adresser                      |
| ------------------ | -------------------------------- |
| Testmiljøerne      | 65.21.2.204 (Hetzner dev-server) |
| Produktionsmiljøet | Allerede oprettet                |

**IP-adresser der skal kunne modtage asynkrone svar (callbacks)**

Ikke relevant — vi anvender kun forespørgsler (read-only).

**Mailliste — driftsstatus**

| Felt   | Værdi                     |
| ------ | ------------------------- |
| Navn   | Jakob Juul Rasmussen      |
| E-mail | itmgtconsulting@gmail.com |

**Mailliste — releases/hotfix**

| Felt   | Værdi                     |
| ------ | ------------------------- |
| Navn   | Jakob Juul Rasmussen      |
| E-mail | itmgtconsulting@gmail.com |

**Kort beskrivelse af hvordan systemadgangen forventes anvendt:**

BizzAssist er en ejendoms- og virksomhedsdata-platform (SaaS) der aggregerer offentlige data for professionelle ejendomsaktører. Vi ønsker adgang til e-TL testmiljøerne for at:

1. Teste integration mod den nye REST API (tilgængelig fra maj 2026) inden migrering fra nuværende HTTP API
2. Validere mTLS-certifikat og forespørgselsformater i et sikkert testmiljø
3. Sikre korrekt fejlhåndtering og timeout-håndtering inden produktionsbrug

Vi har allerede produktionsadgang via HTTP API med systemcertifikat (CN=BizzAssist, serial: 16D632F9...).

---

## Mail-udkast

**Til:** e-tl-011@domstol.dk
**Emne:** Ansøgning om adgang til e-TL testmiljøer — Pecunia IT Consulting ApS (CVR 44718502)

Kære Tinglysningsrettens driftsafdeling,

Vi ansøger hermed om adgang til e-TL testmiljøerne (fællestestmiljø + hotfixmiljø) for Pecunia IT Consulting ApS (CVR 44718502).

Vi har i dag aktiv produktionsadgang via HTTP API med systemcertifikat og ønsker at teste mod den kommende REST API inden migrering.

Udfyldt ansøgningsskema er vedlagt ovenfor. IP-adresse til whitelisting: 65.21.2.204.

Vi anvender udelukkende forespørgsler (read-only) — ingen anmeldelser.

Med venlig hilsen,
Jakob Juul Rasmussen
Pecunia IT Consulting ApS
itmgtconsulting@gmail.com
+45 24342655
