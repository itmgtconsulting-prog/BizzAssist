# Tester-instruktion: Forsikrings-modul MVP

**Hej tester** 👋 — denne guide fortæller dig **præcist** hvad du skal gøre,
trin for trin. Hvert trin har:

- **Hvad du skal gøre** (én konkret handling)
- **Hvad du skal se** (forventet resultat)
- **Hvad du gør hvis det fejler** (next step)

Tag screenshots undervejs hvis noget afviger fra forventet. Hele testen tager
**ca. 20 minutter** når miljøet er klar.

---

## Før du starter

Du skal have:

- [ ] En **konto** på BizzAssist med adgang til tenant'en (jjrchefen@gmail.com eller anden test-bruger)
- [ ] **URL** til miljøet du tester (én af):
  - Dev: https://dev.bizzassist.dk eller localhost:3000 hvis du kører lokalt
  - Test: https://test.bizzassist.dk
  - Vercel preview: link fra PR-siden i GitHub
- [ ] **Police-filer** til upload — modulet accepterer:
  - **PDF** (`.pdf`) — anbefalet primær type
  - **Word** (`.docx`)
  - **Excel** (`.xlsx`, `.xls`) — fx police-lister
  - **PowerPoint** (`.pptx`)
  - **Billeder** (`.png`, `.jpg`, `.gif`, `.webp`) — scannede policer / foto via Claude vision
  - **Tekstfiler** (`.txt`, `.md`, `.csv`, `.tsv`, `.json`, `.xml`, `.yaml`, `.html`, `.rtf`)
  - **Email** (`.eml`) — forwarded police-emails

  Hvis du IKKE har dine egne, brug Belvedere PDF-test-sættet:
  - `Police 50143392.pdf` (Stengade 7 — restaurant)
  - `Police 50143465.pdf` (Gefionsvej 47A — erhvervsudlejning)
  - `Police 50143511.pdf` (Klostermosevej 123 — værksted)
  - `Police 50143554 .pdf` (Bramstræde 5 — hotel)
  - `Police 67500725 .pdf` (Gefionsvej 45A — restaurant)
  - `TOP Police 9417319074.pdf` (Stjernegade 17 — beboelse)

- [ ] **Browser**: Chrome, Edge eller Firefox (seneste version)

Hvis migration 108 IKKE er deployet til miljøet endnu, vil upload af ikke-PDF
filer fejle med "ugyldig MIME-type". Migration 107 + 108 skal være kørt. Tjek selv via Supabase Studio:
Spørg DevOps om status før du fortsætter. Du kan tjekke selv via Supabase Studio
(SQL editor):

```sql
SELECT COUNT(*) FROM information_schema.tables
WHERE table_name = 'forsikring_policies'
  AND table_schema LIKE 'tenant_%';
```

Returnerer den `0` skal migrationen deployes først — STOP og kontakt DevOps.
Returnerer den et tal `> 0` er du klar til at teste.

---

## Trin 1 — Login og find Forsikring

### 1.1 Log ind

**Gør:** Åbn URL'en i browser, klik "Log ind", indtast email + password.

**Se:** Du lander på dashboard-siden. Sidebar på venstre side viser
navigations-links.

**Fejler det?** Tjek at du bruger en gyldig test-bruger. Kontakt admin hvis du
har glemt password.

### 1.2 Find Forsikring — to mulige adgangsveje

**Gør:** Modulet er tilgængeligt **to steder** (begge fører til samme side):

**A) Top-level sidebar:** Find "Forsikring" i venstre sidebar med et
**blåt skjold-ikon** (ShieldCheck). Placeret mellem "AI Chat" og "Tokens".

**B) Under Analyse-menuen:** Klik "Analyse" → "Forsikrings-gap" (også med
skjold-ikon, requiredPlan: professionel).

**Se:** Klik én af dem. Begge fører til `/dashboard/forsikring`.

**Fejler det?**

- ❌ **"Forsikring" findes ikke i sidebar OG ikke under Analyse**: Du er logget
  ind i et miljø uden den nye kode. Bekræft URL'en. Kontakt DevOps om deploy.
- 🟡 **Kun under Analyse, ikke i top-level**: OK — feature-flag har skjult
  top-level på det miljø. Brug Analyse-vejen.
- ❌ **Gamle modul under `/dashboard/analyse/forsikring`**: Hvis det renderer
  en anden side end den nye, er develop-merge ikke landet. Rapportér.

### 1.3 Naviger til Forsikring

**Gør:** Klik på "Forsikring".

**Se:** Du lander på `/dashboard/forsikring`. Siden viser:

- **Header:** "Forsikringer" + undertitel "Upload bygnings-policer og find dækningsgaps automatisk"
- **4 KPI-tiles:** Policer / Kritiske / Advarsler / Info — alle viser tallet **0** hvis det er din første gang
- **Upload-zone:** En stiplet kasse med teksten "Upload PDF" og "Træk en PDF herhen, eller klik for at vælge fil (max 20 MB)"
- **Empty state:** "Ingen policer endnu" + ikon af bygning

**Fejler det?**

- 🔴 **"Noget gik galt" / 500-fejl**: Migration 107 er ikke deployet. Stop her, kontakt DevOps.
- 🟡 **Side renderer, men sidebar mangler**: Du er muligvis ikke logget ind. Refresh.

---

## Trin 2 — Upload din første police

### 2.1 Vælg en police-PDF

**Gør:** Klik på upload-zonen ELLER træk en PDF-fil herhen.

> 💡 Hvis du bruger Belvedere test-sættet, **start med `Police 50143392.pdf` (Stengade 7)** — den har flest forventede gaps og er den nemmeste at verificere.

**Se:** Et upload-job vises lige under upload-zonen med fil-navnet og status:

- Status går igennem: **"Uploader…"** (~1-3 sek) → **"Analyserer police med AI…"** (~10-30 sek)
- Slutter med grøn ✓

**Fejler det?**

- 🔴 **"Filen er for stor"**: PDF'en er over 20 MB. Brug en mindre fil.
- 🔴 **"Ugyldig filtype"**: Du har valgt en filtype der ikke er understøttet
  (fx `.exe` eller `.zip`). Brug en af de listede typer (PDF/Word/Excel/billeder/tekst).
- 🔴 **"Upload fejlede"**: Tjek browser console (F12 → Console). Rapportér exact fejlmeddelelse.
- 🔴 **Hænger på "Analyserer..." > 60 sek**: AI-parsing timeout. Tjek igen om 1 minut; hvis stadig fejl, rapportér.
- 🟡 **Status hopper direkte til ✗ "Parse fejlede"**: PDF kunne ikke parses. Sandsynligvis dårlig PDF (scanned/encrypted). Prøv en anden police.

### 2.2 Verificér policen er i tabellen

**Gør:** Når status er ✓, scroll ned. Du skal se en tabel.

**Se:** En ny række i tabellen med:

| Kolonne          | Forventet indhold (for Stengade 7)                                              |
| ---------------- | ------------------------------------------------------------------------------- |
| Police           | `50143392` (klikbart link)                                                      |
| Selskab          | `Alm. Brand Forsikring A/S`                                                     |
| Forsikringstager | `Belvedere Ejendomme A/S`                                                       |
| Forsikringssted  | `Stengade 7, 3000 Helsingør`                                                    |
| Årlig præmie     | `5.716 kr`                                                                      |
| Udløber          | `31. mar. 2028`                                                                 |
| Gaps             | Rødt og gult badge med tal (forventet: **1 rød, 4 gule, 1 grå** for Stengade 7) |

**Fejler det?**

- 🟡 **Tabel viser policen men værdier er forkerte/tomme**: AI-parser har misset
  felter. Tjek detail-siden (trin 3) — hvis kun visse felter er forkerte er
  det acceptabelt for MVP, men rapportér hvilke.
- 🔴 **Tabel viser ingen ny række**: Refresh siden. Hvis stadig ikke der,
  rapportér med screenshot af KPI-tiles (de skal vise tallet for policer er steget).

### 2.3 Verificér KPI-tiles er opdateret

**Gør:** Kig på de 4 tiles i toppen af siden.

**Se:** "Policer" tile viser nu **1** (eller flere hvis du har uploaded flere).
Gap-tile (Kritiske/Advarsler/Info) viser også tal større end 0 hvis policen
havde gaps.

---

## Trin 3 — Verificér gap-detection (det vigtigste!)

### 3.1 Åbn detail-side

**Gør:** Klik på police-nummeret i tabellen (det blå tal `50143392`).

**Se:** Du lander på detail-siden. Den viser fra top til bund:

1. **"Tilbage til oversigt"** link øverst
2. **Stort police-nummer + selskab + forsikringstager**
3. **"Slet police"** knap til højre (rød)
4. **4 metadata-kort** i grid:
   - Forsikringssted (adresse + matrikel + virksomhedsart)
   - Metadata (areal, opført, etager, form)
   - Årlig præmie (med selvrisiko)
   - Udløber (med hovedforfald)
5. **"Dækninger" sektion** med liste over forsikrede ting (grønne flueben)
   og ikke-forsikrede ting (gråt X med gennemstreget tekst)
6. **"Detekterede gaps" sektion** med liste over fund

### 3.2 Verificér dækningslisten (Stengade 7 eksempel)

**Se:** Dækninger sektionen for Stengade 7 skal vise (cirka):

- ✅ Brand inkl. el-skade (grøn ✓)
- ✅ Bygningskasko (grøn ✓)
- ✅ Udvidet rørskade (grøn ✓)
- ✅ Hus- og grundejeransvar (grøn ✓)
- ❌ Glas (grå X, gennemstreget)
- ❌ Sanitet (grå X, gennemstreget)
- ❌ Insekt og svamp (grå X, gennemstreget)
- ❌ Restværdi (grå X, gennemstreget)
- ❌ Stikledning (grå X, gennemstreget)
- ❌ Jordskade (grå X, gennemstreget)

> ⚠️ AI-parseren kan udelade nogle af de ikke-dækkede ting fra listen — det er OK
> så længe **gaps-sektionen** under fanger dem.

**Fejler det?**

- 🟡 **Listen er kort (3-4 items)**: AI-parser har kun extraheret aktive
  dækninger, ikke de eksplicit ekskluderede. Gap-engine bør stadig fange dem
  som "manglende" — fortsæt til 3.3.
- 🔴 **Listen er helt tom**: Parse-fejl. Rapportér med screenshot.

### 3.3 ⚠️ Verificér detekterede gaps (kerne-test for MVP)

**Se:** Sektionen "Detekterede gaps" for Stengade 7 skal vise **mindst** disse
gaps (rækkefølge er ikke kritisk):

| Severity              | Title (forventet)                                              |
| --------------------- | -------------------------------------------------------------- |
| 🔴 **Kritisk** (rød)  | **Manglende dækning: Insekt og svamp** (bygningen er fra 1900) |
| 🟡 **Advarsel** (gul) | **Manglende dækning: Glas**                                    |
| 🟡 **Advarsel** (gul) | **Manglende dækning: Restværdi**                               |
| 🟡 **Advarsel** (gul) | **Manglende dækning: Stikledning**                             |
| ⚪ **Info** (grå)     | **Manglende dækning: Sanitet**                                 |

Hver gap har:

- **Title** (linjen ovenfor)
- **Beskrivelse** (forklarer hvorfor det er en risiko)
- **Anbefaling** (blå tekst nederst — hvad brugeren bør gøre)
- **Severity-badge** til højre (rødt/gult/gråt label)

**Fejler det?**

- 🔴 **Sektionen er tom** ("Ingen gaps fundet — policen er solid 👍"): Dette
  er den **vigtigste fejl**. Det betyder gap-engine ikke kører. Rapportér med
  detail-side screenshot. **Dette er BIZZ-1352 acceptance-kriterium**.
- 🟡 **Færre gaps end forventet** (fx 3 i stedet for 5): AI-parser har
  fejlagtigt markeret nogle ting som dækket. Acceptabelt for MVP men rapportér.
- 🟡 **Severity er forkert** (fx "Insekt/svamp" er gul i stedet for rød):
  Bygnings-årstal er ikke korrekt parsed (skal være ≤ 1976 for at trigge
  critical). Rapportér.

### 3.4 Forventede gaps for hver test-PDF

Hvis du tester flere policer, brug denne tabel som facit:

| PDF                                           | Forventede critical gaps          | Forventede warning gaps                             |
| --------------------------------------------- | --------------------------------- | --------------------------------------------------- |
| `Police 50143392.pdf` (Stengade 7, 1900)      | **Insekt/svamp**                  | Glas, sanitet, restværdi, stikledning               |
| `Police 50143465.pdf` (Gefionsvej 47A, 1965)  | **Insekt/svamp** (>50 år)         | Glas, sanitet, restværdi, stikledning               |
| `Police 50143511.pdf` (Klostermosevej, 1972)  | (kan være warning, ikke critical) | Glas, sanitet, restværdi, stikledning, insekt/svamp |
| `Police 50143554 .pdf` (Bramstræde 5, 1890)   | **Insekt/svamp**                  | Glas, sanitet, stikledning (har restværdi)          |
| `Police 67500725 .pdf` (Gefionsvej 45A, 1964) | **Insekt/svamp**                  | Glas, sanitet, restværdi (har stikledning)          |
| `TOP Police 9417319074.pdf` (Stjernegade 17)  | **Aftale udløbet** (1.1.2026)     | (ingen — TOP-policen har det meste dækket)          |

---

## Trin 4 — Test sletning + sprog-skift

### 4.1 Slet en police

**Gør:** Stadig på detail-siden, klik den røde "Slet police" knap øverst til
højre. Bekræft pop-up'en.

**Se:** Du sendes tilbage til oversigtssiden. Policen er væk fra tabellen.
KPI-tiles er opdateret (tal er gået ned med 1).

**Fejler det?** Hvis policen stadig vises i tabellen efter refresh, rapportér.

### 4.2 Skift sprog DA → EN

**Gør:** Find sprog-skifteren (typisk øverst til højre i hovedmenuen) og skift
til "EN".

**Se:** Hele siden skifter til engelsk:

- Sidebar: "Forsikring" → "Insurance"
- Header: "Forsikringer" → "Insurance"
- KPI-labels: "Policer" → "Policies", "Kritiske" → "Critical", osv.
- Upload-zone: "Upload PDF" → samme tekst (kommandoer beholdes)
- Empty state: "Ingen policer endnu" → "No policies yet"

**Fejler det?** Hvis nogen tekster forbliver danske mens andre skifter til
engelsk, rapportér hvilke felter.

### 4.3 Skift tilbage til DA

**Gør:** Klik DA i sprog-skifteren.

**Se:** Alt er dansk igen.

---

## Trin 5 — Test alternative filtyper (anbefalet)

PDF er den primære og bedst-testede filtype. De andre filtyper bruger samme
Claude-parser bagved. Test mindst ét par yderligere typer for at bekræfte at
multi-type upload virker.

### 5.1 Test Word/Excel-dokument

**Gør:** Hvis du har en police i Word eller Excel-format, upload den. Hvis
ikke, lav en hurtig DOCX eller XLSX med samme tekst som en af Belvedere
PDF'erne (kopiér tekst, paste, gem).

**Se:** Upload + parse virker præcis som PDF. Police vises i tabel med samme
felter.

**Fejler det?** Rapportér med fil-eksempel hvis muligt.

### 5.2 Test billede (Claude vision)

**Gør:** Tag et **screenshot** eller foto af en police-side (eller scan via
mobilkamera). Gem som PNG eller JPG. Upload.

**Se:**

- Upload-job: "Uploader…" → "Analyserer police med AI…" (kan tage 20-40 sek for
  billeder — vision er langsommere end tekst)
- Slutter med ✓
- Police vises med uddrag fra billedet

**Fejler det?**

- 🟡 **Parser udvinder kun delvise felter**: Billedkvalitet er afgørende for
  OCR. Test med højere opløsning.
- 🔴 **"Vision-output passer ikke til schema"**: Claude kunne ikke læse
  billedet. Rapportér med screenshot.

### 5.3 Upload flere policer hurtigt (stress)

**Gør:** Træk **flere** filer (3-6 stk.) til upload-zonen på én gang. Du kan
blande filtyper (fx 2 PDF + 1 XLSX + 1 billede).

**Se:** Hver fil får sit eget upload-job med separate status-indikatorer.
Filerne uploader parallelt men parses sekventielt (én ad gangen).

**Fejler det?**

- 🟡 **Nogle filer fejler på parse mens andre passerer**: Race condition mulig.
  Rapportér hvilke filer fejlede.
- 🔴 **Browser crasher / siden hænger**: Memory issue. Rapportér browser + OS.

### 5.2 Tjek browser console

**Gør:** Tryk F12 → Console.

**Se:** **Ingen** røde error-meddelelser. Gule warnings er OK.

**Fejler det?** Tag screenshot af røde fejl. Vedhæft til BIZZ-1352.

### 5.3 Tjek network tab

**Gør:** F12 → Network tab. Reload siden.

**Se:** `GET /api/forsikring` returnerer **200 OK**.

**Fejler det?**

- 🔴 **401 Unauthorized**: Du er logget ud. Login igen.
- 🔴 **500 Server Error**: API fejl. Klik på request, kig på Response, vedhæft til ticket.

---

## Afslutning — rapportér resultat

Når du er færdig, opdatér BIZZ-1352 ticketet med:

### ✅ Hvis alt passerede

- Sæt status til **Done**
- Tilføj kommentar: _"Manuel E2E test bestået på [miljø] [dato]. Testede [antal] policer. Alle forventede gaps detekteret."_
- Vedhæft 2-3 screenshots:
  - Oversigtsside med uploaded policer
  - Én detail-side med gaps
  - Browser console (skal være ren)

### ❌ Hvis noget fejlede

- **Sæt IKKE** ticketet til Done
- Tilføj kommentar med:
  - Hvilket trin fejlede (fx "Trin 3.3 — gap-detection")
  - Hvad du så vs. forventet
  - Browser console screenshot
  - Network response hvis API-fejl
- Tildel ticketet til udvikleren der byggede modulet

### Hvor finder jeg modulet?

- **Mit MVP:** `/dashboard/forsikring/` ← **brug dette**
- **Det gamle modul (slettet):** Hed `/dashboard/analyse/forsikring/` — skal være væk
- **Hvis det gamle modul findes**: rapportér som "old module not removed" → BIZZ-1352 comment

---

## Hurtig reference: hvad tester du egentlig?

I et sætning: **Modulet skal kunne uploade en forsikrings-PDF, parse den med
AI til strukturerede data, og automatisk fortælle dig hvilke dækninger der
mangler — fx insekt/svamp, glas, restværdi.**

Hvis det virker for én PDF og du ser de forventede gaps, har du verificeret
hele MVP-flowet end-to-end.

🙌 Tak for testen!
