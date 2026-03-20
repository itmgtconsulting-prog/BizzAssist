# BizzAssist — Product Backlog

**Prioritised build roadmap**
Last updated: 2026-03-20 | Owner: Jakob Juul Rasmussen

---

## Priority Legend

| Label                | Meaning                         | Blocks     |
| -------------------- | ------------------------------- | ---------- |
| **P0 — Blocker**     | Nothing works without this      | Everything |
| **P1 — Critical**    | Core product value              | Revenue    |
| **P2 — Important**   | Differentiates from competitors | Growth     |
| **P3 — Enhancement** | Improves experience             | Retention  |
| **P4 — Future**      | Post-launch expansion           | Scale      |

## Effort Legend

`XS` < 1 day · `S` 1–2 days · `M` 3–5 days · `L` 1–2 weeks · `XL` 2–4 weeks

---

---

# PHASE 1 — FOUNDATION

## ⛔ P0 · Everything depends on this

---

### 1.1 · Supabase Project Setup

**Priority:** P0 · **Effort:** S · **Depends on:** nothing

Set up Supabase project with correct region (EU West — GDPR compliance), enable
the required extensions, and wire credentials into the app.

**Tasks:**

- [ ] Create Supabase project in EU West region (Frankfurt)
- [ ] Enable extensions: `pgvector`, `uuid-ossp`, `pg_trgm` (for fuzzy search)
- [ ] Add Supabase credentials to `.env.local` (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`)
- [ ] Install `@supabase/supabase-js` and `@supabase/ssr`
- [ ] Create `lib/supabase/client.ts` (browser client) and `lib/supabase/server.ts` (server client)
- [ ] Create `lib/supabase/admin.ts` (service role — backend only)

---

### 1.2 · Database Schema — Public (Shared)

**Priority:** P0 · **Effort:** M · **Depends on:** 1.1

Create the shared platform schema that all tenants reference.

**Tables to create:**

```sql
public.users           -- linked to Supabase auth.users
public.tenants         -- one row per company/subscription
public.tenant_memberships  -- user ↔ tenant ↔ role
public.subscriptions   -- plan, status, billing cycle
public.plans           -- free / starter / pro / enterprise
```

**Tasks:**

- [ ] Write migration `001_public_schema.sql`
- [ ] Enable RLS on all tables
- [ ] Create RLS policies (users can only see their own tenant memberships)
- [ ] Create DBA-signed-off migration checklist entry
- [ ] Test with Supabase local emulator

---

### 1.3 · Database Schema — Tenant Template

**Priority:** P0 · **Effort:** M · **Depends on:** 1.2

Schema template applied per tenant on signup. Contains all business data.

**Tables to create:**

```sql
tenant_[uuid].saved_searches
tenant_[uuid].saved_entities      -- watched companies/properties/people
tenant_[uuid].reports
tenant_[uuid].ai_conversations
tenant_[uuid].ai_messages
tenant_[uuid].ai_context          -- company-specific procedures + templates
tenant_[uuid].document_embeddings -- pgvector
tenant_[uuid].audit_log
```

**Tasks:**

- [ ] Write migration `002_tenant_schema_template.sql`
- [ ] Enable RLS on all tables
- [ ] Create `lib/db/tenant.ts` — scoped DB client factory (accepts tenant_id)
- [ ] Write tenant provisioning function (called on first login)

---

### 1.4 · Authentication — Email + Password + 2FA

**Priority:** P0 · **Effort:** M · **Depends on:** 1.1

Replace the current login UI mockup with real Supabase Auth.

**Tasks:**

- [ ] Wire login form to `supabase.auth.signInWithPassword()`
- [ ] Wire signup form to `supabase.auth.signUp()`
- [ ] Email verification flow (Supabase sends verification email)
- [ ] Enable TOTP (Time-based One-Time Password) 2FA via Supabase Auth MFA
- [ ] Build 2FA enrollment page (`/dashboard/settings/security`)
- [ ] Build 2FA challenge page (shown after password login if MFA enabled)
- [ ] Password reset flow (`/auth/reset-password`)
- [ ] Activate protected route guard in `middleware.ts` (currently commented out)
- [ ] Session refresh handling (JWT rotation)
- [ ] Logout functionality in dashboard sidebar

---

### 1.5 · Authentication — Google OAuth

**Priority:** P0 · **Effort:** S · **Depends on:** 1.4

Enable "Sign in with Google" — required for frictionless onboarding.

**Tasks:**

- [ ] Create Google OAuth app in Google Cloud Console
- [ ] Configure Google provider in Supabase Auth dashboard
- [ ] Wire "Continue with Google" button in login page to `supabase.auth.signInWithOAuth({ provider: 'google' })`
- [ ] Handle OAuth callback at `/auth/callback/route.ts`
- [ ] Auto-provision tenant on first Google login

---

### 1.6 · Authentication — LinkedIn OAuth

**Priority:** P0 · **Effort:** S · **Depends on:** 1.4

Enable "Sign in with LinkedIn" — especially relevant for B2B users.

**Tasks:**

- [ ] Create LinkedIn OAuth app at developer.linkedin.com
- [ ] Configure LinkedIn provider in Supabase Auth
- [ ] Wire "Continue with LinkedIn" button to `supabase.auth.signInWithOAuth({ provider: 'linkedin_oidc' })`
- [ ] Handle OAuth callback
- [ ] Auto-provision tenant on first LinkedIn login

---

### 1.7 · Tenant Middleware & Session Management

**Priority:** P0 · **Effort:** M · **Depends on:** 1.4, 1.5, 1.6

Resolve which tenant the logged-in user belongs to and inject into every request.

**Tasks:**

- [ ] Update `middleware.ts` to read Supabase session and extract `tenant_id`
- [ ] Redirect unauthenticated users from `/dashboard/*` to `/login`
- [ ] Redirect users with no tenant to `/onboarding`
- [ ] Create `lib/auth/session.ts` — server-side session helper
- [ ] Write `useSession()` hook for client components
- [ ] Store `tenant_id` in session context accessible to all server components

---

### 1.8 · User Onboarding Flow

**Priority:** P0 · **Effort:** M · **Depends on:** 1.4–1.7

First-time user journey after account creation.

**Tasks:**

- [ ] Create `/onboarding` page
- [ ] Step 1: Company name + CVR number
- [ ] Step 2: Plan selection (free tier available)
- [ ] Step 3: Invite team members (optional)
- [ ] Provision tenant schema in DB on completion
- [ ] Redirect to `/dashboard` on completion

---

---

# PHASE 2 — DATA INTEGRATION

## 🔴 P1 · This IS the product

---

### 2.1 · CVR API Integration — Company Data

**Priority:** P1 · **Effort:** L · **Depends on:** Phase 1

CVR (Det Centrale Virksomhedsregister) is the Danish Business Authority register.
This is the single most important data source in BizzAssist.

**Data available:**

- Company name, CVR number, legal form, status (active/dissolved)
- Address, industry code (DB07), founding date
- Board members + directors (with CPR-protected person IDs)
- Financial figures (revenue, profit, equity — annual reports)
- Ownership/shareholder structure
- Subsidiary relationships

**Tasks:**

- [ ] Register for CVR API access at datacvr.virk.dk (free for commercial use with agreement)
- [ ] Create `lib/data-sources/cvr/client.ts` — CVR Elasticsearch API wrapper
- [ ] Create `lib/data-sources/cvr/types.ts` — TypeScript types for all CVR entities
- [ ] Build `lib/data-sources/cvr/company.ts` — search + fetch company by CVR number
- [ ] Build `lib/data-sources/cvr/person.ts` — fetch persons linked to a company
- [ ] Build `lib/data-sources/cvr/financials.ts` — annual report figures
- [ ] Create API route `POST /api/data/company/search` — proxies CVR search (auth + rate limit)
- [ ] Cache results in tenant DB (`tenant.saved_entities`) to reduce API calls
- [ ] Write unit tests for all CVR client functions

**CVR API endpoint:** `http://distribution.virk.dk/cvr-permanent/virksomhed/_search`

---

### 2.2 · CVR API Integration — Person Data

**Priority:** P1 · **Effort:** M · **Depends on:** 2.1

Persons (business leaders, board members) available through CVR as public data.

**Tasks:**

- [ ] Create `lib/data-sources/cvr/person.ts`
- [ ] Search persons by name
- [ ] Fetch all company roles a person holds (current + historical)
- [ ] Build person profile data model: name, roles, company history
- [ ] API route `POST /api/data/person/search`
- [ ] Note: CPR numbers are NOT available — only names and roles

---

### 2.3 · BBR / OIS Integration — Property Data

**Priority:** P1 · **Effort:** L · **Depends on:** Phase 1

BBR (Bygnings- og Boligregistret) contains all building/property data in Denmark.
OIS (Offentlige Informationer om Fast Ejendom) is the official data distributor.

**Data available:**

- Property ID (BFE/matrikel number)
- Address, property type, usage code
- Building size (m²), floors, built year, renovation year
- Energy label (A–G)
- Number of units (residential/commercial)
- Ground area

**Tasks:**

- [ ] Register for OIS data access at ois.dk (requires agreement + subscription)
- [ ] Evaluate alternative: Danmarks Adresser API (free, public) for address lookup + basic property
- [ ] Create `lib/data-sources/ois/client.ts`
- [ ] Build property search by address and by matrikel number
- [ ] Create `lib/data-sources/ois/types.ts`
- [ ] API route `POST /api/data/property/search`
- [ ] Alternative free path: use DAR (Danmarks Adresseregister) + DAWA (open access)

**Free alternative: DAWA API** `https://api.dataforsyningen.dk/`

---

### 2.4 · Tinglysning Integration — Ownership & Mortgage Data

**Priority:** P1 · **Effort:** L · **Depends on:** 2.3

Tinglysning (the Danish Land Registry) holds all legal rights on properties.

**Data available:**

- Current owner(s) of a property
- Purchase price and purchase date
- Mortgages and liens
- Historical ownership chain

**Tasks:**

- [ ] Evaluate access: Tinglysning.dk has a public search UI; data API is via Dataforsyningen
- [ ] Register at dataforsyningen.dk for WFS/WMS API access (token-based, free tier available)
- [ ] Create `lib/data-sources/tinglysning/client.ts`
- [ ] Fetch ownership records for a given BFE number
- [ ] Fetch mortgage data
- [ ] API route `POST /api/data/property/ownership`
- [ ] Cross-reference owner (CVR number) with CVR company data

---

### 2.5 · DAWA / DAR — Address & Geocoding

**Priority:** P1 · **Effort:** S · **Depends on:** Phase 1

Danmarks Adresser (DAWA) is the authoritative Danish address register. Fully free and open.

**Tasks:**

- [ ] No registration required — public API
- [ ] Create `lib/data-sources/dawa/client.ts`
- [ ] Build address autocomplete (typeahead): `GET https://api.dataforsyningen.dk/adresser/autocomplete`
- [ ] Build address-to-coordinate lookup (for map integration)
- [ ] Build coordinate-to-address (reverse geocoding)
- [ ] Integrate autocomplete into all address input fields in the app
- [ ] Use DAWA address IDs as canonical identifier to link CVR, BBR, Tinglysning records

---

### 2.6 · Data Normalization & Entity Linking

**Priority:** P1 · **Effort:** L · **Depends on:** 2.1–2.5

Raw data from each source uses different identifiers. Entity linking ties them together.

**Linking strategy:**

- Company → Property: CVR number matches owner in Tinglysning
- Company → Person: CVR participation records
- Person → Property: owner name match in Tinglysning (probabilistic)
- Address → Property → Owner: via DAWA address ID → BBR BFE → Tinglysning

**Tasks:**

- [ ] Create `lib/data-sources/entity-linker.ts`
- [ ] Build `resolveCompany(cvrNumber)` — returns unified CompanyEntity with linked persons and properties
- [ ] Build `resolveProperty(bfeNumber)` — returns unified PropertyEntity with owners and mortgage data
- [ ] Build `resolvePerson(name, roles)` — returns unified PersonEntity with all company roles
- [ ] Store resolved entities in `tenant.saved_entities` as JSONB with source metadata
- [ ] Add `linked_entities` JSONB column to each entity for cross-references
- [ ] Write tests covering entity linking logic

---

---

# PHASE 3 — CORE PAGES & SEARCH

## 🔴 P1 · Users need to see data

---

### 3.1 · Universal Search Page

**Priority:** P1 · **Effort:** M · **Depends on:** 2.1–2.5

The `/dashboard/search` page — the primary entry point for finding data.

**Design:**

- Single search bar at top
- Live suggestions as user types (DAWA for addresses, CVR for companies/names)
- Tab filters: All / Companies / People / Properties
- Results list with entity type icon, name, key info, and link to profile

**Tasks:**

- [ ] Create `app/dashboard/search/page.tsx`
- [ ] Build `SearchResultCard` component (reusable across types)
- [ ] Implement debounced search input (300ms)
- [ ] Hit `/api/data/search?q=&type=` route
- [ ] Create aggregated search API route that queries CVR + DAWA in parallel
- [ ] Keyboard navigation (arrow keys + enter to select)
- [ ] "No results" and loading states
- [ ] Recent searches stored in `tenant.saved_searches` and shown on empty input
- [ ] Bilingual (DA/EN)

---

### 3.2 · Company Profile Page

**Priority:** P1 · **Effort:** L · **Depends on:** 2.1, 2.2, 3.1

`/dashboard/companies/[cvr]` — the core company intelligence view.

**Sections:**

1. Header: Company name, CVR, status badge (active/dissolved), industry
2. Key facts: Founded, address, legal form, employees, industry code
3. Financial summary: Revenue, profit, equity (last 3 years) + trend chart
4. Board & Management: List of directors/board members (links to person profiles)
5. Ownership: Shareholders with % stakes
6. Properties: Linked properties owned by the company
7. Network: Related companies (subsidiaries, co-investments)
8. Recent changes: CVR change log

**Tasks:**

- [ ] Create `app/dashboard/companies/[cvr]/page.tsx`
- [ ] Create `CompanyHeader`, `FinancialSummary`, `BoardList`, `PropertyLinks` components
- [ ] Fetch CVR data server-side (Next.js server component)
- [ ] Financial trend mini-chart (use lightweight chart library)
- [ ] "Save company" → adds to `tenant.saved_entities`
- [ ] "Add to watchlist" → monitors for changes
- [ ] "Analyse with AI" button → opens AI chat with company context pre-loaded
- [ ] Share / export to PDF buttons (P3)
- [ ] Bilingual

---

### 3.3 · Property Profile Page

**Priority:** P1 · **Effort:** L · **Depends on:** 2.3–2.5, 3.1

`/dashboard/properties/[bfe]` — property intelligence view.

**Sections:**

1. Header: Address, property type, status
2. Key facts: Size (m²), floors, built year, energy label, usage
3. Ownership: Current owner (link to company/person profile)
4. Transaction history: Sales with dates and prices
5. Mortgage/liens summary
6. Map view: Property location on map
7. Nearby properties (same area, similar type)

**Tasks:**

- [ ] Create `app/dashboard/properties/[bfe]/page.tsx`
- [ ] Create `PropertyHeader`, `OwnershipHistory`, `MortgageSummary` components
- [ ] Integrate map (see Phase 4 — Map)
- [ ] Fetch BBR + Tinglysning + DAWA data server-side
- [ ] Link owner CVR → Company profile
- [ ] "Analyse with AI" button

---

### 3.4 · Person Profile Page

**Priority:** P1 · **Effort:** M · **Depends on:** 2.2, 3.1

`/dashboard/people/[id]` — business person profile.

**Sections:**

1. Header: Name, current primary role
2. Company roles: All current + historical positions (board, director, owner)
3. Network: Co-directors (people who sit on the same boards)
4. Properties: Any personally owned properties (from Tinglysning)
5. Risk indicators: Dissolved companies, legal history (public records only)

**Tasks:**

- [ ] Create `app/dashboard/people/[id]/page.tsx`
- [ ] Create `PersonRoleList`, `CoDirectorNetwork` components
- [ ] Build person ID system (CVR person record ID as identifier)
- [ ] Co-director graph from CVR data
- [ ] "Analyse with AI" button

---

### 3.5 · Companies List / Browse Page

**Priority:** P1 · **Effort:** M · **Depends on:** 2.1, 3.1

`/dashboard/companies` — browse and filter Danish companies.

**Filters:**

- Industry (DB07 code)
- Company size (employees, revenue range)
- Location (region, municipality)
- Legal form
- Status (active, dissolved, under bankruptcy)
- Founded date range

**Tasks:**

- [ ] Create `app/dashboard/companies/page.tsx`
- [ ] Build `FilterSidebar` component (collapsible, mobile-friendly)
- [ ] Server-side filtered + paginated results
- [ ] Sort options (founded, revenue, alphabetical)
- [ ] Pagination or infinite scroll
- [ ] "Save search" button

---

### 3.6 · Properties List / Browse Page

**Priority:** P1 · **Effort:** M · **Depends on:** 2.3, 3.1

`/dashboard/properties` — browse and filter properties.

**Filters:**

- Property type (residential, commercial, industrial, land)
- Location (address, municipality, region)
- Size range (m²)
- Energy label
- Built year range
- Owner type (private person, company)

**Tasks:**

- [ ] Create `app/dashboard/properties/page.tsx`
- [ ] FilterSidebar component (reuse from 3.5 with different filter options)
- [ ] Paginated results list + map view toggle
- [ ] "View on map" button (opens Phase 4 map view)

---

### 3.7 · People List / Browse Page

**Priority:** P1 · **Effort:** S · **Depends on:** 2.2, 3.1

`/dashboard/people` — search and browse business persons.

**Tasks:**

- [ ] Create `app/dashboard/people/page.tsx`
- [ ] Search by name
- [ ] Filter by: current company, role type, municipality
- [ ] Paginated results

---

---

# PHASE 4 — MAP FUNCTIONALITY

## 🟠 P2 · Key differentiator

---

### 4.1 · Map Provider Setup

**Priority:** P2 · **Effort:** S · **Depends on:** 2.5 (DAWA geocoding)

Choose and integrate a map provider.

**Recommendation:** Mapbox GL JS (better Danish tile data than Google Maps, better pricing for B2B)
**Alternative:** Google Maps (more familiar, better for addresses)

**Tasks:**

- [ ] Create Mapbox account + get API token
- [ ] Install `mapbox-gl` and `react-map-gl`
- [ ] Create `components/Map/MapBase.tsx` — base map component (dark theme matching app)
- [ ] Create `components/Map/PropertyMarker.tsx` — clickable property pin
- [ ] Create `components/Map/CompanyMarker.tsx` — clickable company pin
- [ ] Store Mapbox token in `.env.local`

---

### 4.2 · Property Map View

**Priority:** P2 · **Effort:** M · **Depends on:** 4.1, 2.3, 2.5

Show properties on an interactive map.

**Tasks:**

- [ ] Add "Map View" tab to `/dashboard/properties` list page
- [ ] Plot all filtered properties as pins on map
- [ ] Clicking a pin → opens mini property card popup with link to full profile
- [ ] Color-code pins by property type
- [ ] Cluster pins at low zoom levels
- [ ] Map + list side-by-side view (split pane)
- [ ] "Draw area to search" tool (polygon selection → filters results to inside area)

---

### 4.3 · Company Map View

**Priority:** P2 · **Effort:** S · **Depends on:** 4.1, 2.1

Show company locations on map.

**Tasks:**

- [ ] Add "Map View" tab to `/dashboard/companies`
- [ ] Plot company addresses as pins
- [ ] Cluster by municipality
- [ ] Heatmap mode (density of companies by area)

---

### 4.4 · Map on Property Profile Page

**Priority:** P2 · **Effort:** S · **Depends on:** 4.1, 3.3

Embed a small map on each property profile showing its exact location.

**Tasks:**

- [ ] Integrate `MapBase` into `app/dashboard/properties/[bfe]/page.tsx`
- [ ] Show property pin + address label
- [ ] "Nearby properties" toggle — show neighbouring properties within 500m

---

---

# PHASE 5 — AI INTEGRATION

## 🟠 P2 · Core differentiator from static data providers

---

### 5.1 · Claude API Integration

**Priority:** P2 · **Effort:** M · **Depends on:** Phase 1, Phase 2

Wire up the Claude API to replace the mock AI chat.

**Tasks:**

- [ ] Add `ANTHROPIC_API_KEY` to `.env.local`
- [ ] Install `@anthropic-ai/sdk`
- [ ] Create `lib/ai/claude.ts` — Claude API client wrapper
- [ ] Create streaming API route `POST /api/ai/chat` (uses `claude-3-5-sonnet` model)
- [ ] Replace mock 1500ms delay in dashboard AI panel with real streaming response
- [ ] Show streaming tokens as they arrive (character-by-character like ChatGPT)
- [ ] Handle errors gracefully (rate limit, context limit)

---

### 5.2 · Tenant-Scoped AI Context (RAG)

**Priority:** P2 · **Effort:** L · **Depends on:** 5.1, Phase 1 DB

Give each tenant's AI chat access to their specific business context.

**Tasks:**

- [ ] Create `lib/ai/context-builder.ts` — assembles tenant-specific system prompt
- [ ] For every chat: inject tenant's saved entities, recent searches, and uploaded procedures
- [ ] Store conversation history in `tenant.ai_conversations` + `tenant.ai_messages`
- [ ] Build context window management (trim old messages when approaching limit)
- [ ] Enable "what do you know about [company]?" — fetches from CVR and injects to context

---

### 5.3 · AI Analysis Page

**Priority:** P2 · **Effort:** M · **Depends on:** 5.1, 5.2

`/dashboard/analysis` — structured AI-powered analysis workflows.

**Analysis types:**

- Competitor analysis (input: CVR number → AI summary of competitors)
- Due diligence report (input: CVR → structured risk + financials + people summary)
- Investment screening (input: criteria → AI searches and ranks matching companies)
- Property market analysis (input: area → price trends, ownership patterns)

**Tasks:**

- [ ] Create `app/dashboard/analysis/page.tsx`
- [ ] Create `AnalysisCard` component for each analysis type
- [ ] Build structured prompts for each analysis type in `lib/ai/prompts/`
- [ ] Show analysis results in formatted markdown
- [ ] Save analysis to `tenant.reports`
- [ ] Export to PDF (P3)

---

### 5.4 · Full Chat Page

**Priority:** P2 · **Effort:** M · **Depends on:** 5.1, 5.2

`/dashboard/chat` — standalone full-screen AI chat (replaces dashboard panel).

**Tasks:**

- [ ] Create `app/dashboard/chat/page.tsx`
- [ ] Full-width chat interface
- [ ] Conversation history sidebar (all previous chats from `tenant.ai_conversations`)
- [ ] "New conversation" button
- [ ] File upload (PDF, Excel) for document analysis
- [ ] Entity mention: type `@[company]` to inject CVR data into context
- [ ] Suggested prompts relevant to recently viewed entities

---

### 5.5 · AI Tenant Learning (Company-Specific Context)

**Priority:** P3 · **Effort:** L · **Depends on:** 5.2

Each tenant can upload their own procedures, templates, and preferences so the AI learns their workflow.

**Tasks:**

- [ ] Build document upload UI in `/dashboard/settings/ai`
- [ ] Parse and chunk uploaded documents (PDF, DOCX)
- [ ] Generate embeddings via `text-embedding-3-small` and store in `tenant.document_embeddings`
- [ ] Retrieve relevant chunks on each AI query (similarity search via pgvector)
- [ ] Allow tenants to write custom AI instructions ("Always format reports in our template")

---

---

# PHASE 6 — ACCOUNT MANAGEMENT & BILLING

## 🟡 P2–P3 · Required for commercial operation

---

### 6.1 · User Settings Page

**Priority:** P2 · **Effort:** M · **Depends on:** Phase 1

`/dashboard/settings` — user profile and security settings.

**Sections:**

- Profile: Name, email, avatar
- Security: Change password, 2FA setup/management
- Notifications: Email notification preferences
- Language: DA/EN preference (currently localStorage-only)

**Tasks:**

- [ ] Create `app/dashboard/settings/page.tsx`
- [ ] Profile update form → `supabase.auth.updateUser()`
- [ ] 2FA enrollment flow (TOTP QR code + backup codes)
- [ ] Password change form
- [ ] Language preference saved to user profile in DB

---

### 6.2 · Organisation Settings Page

**Priority:** P2 · **Effort:** M · **Depends on:** Phase 1

`/dashboard/settings/organisation` — tenant-level settings.

**Tasks:**

- [ ] Create `app/dashboard/settings/organisation/page.tsx`
- [ ] Edit company name, CVR number, logo
- [ ] User management: invite by email, change roles, remove members
- [ ] View current subscription / plan
- [ ] Data retention settings (AI conversation history)

---

### 6.3 · Stripe Billing Integration

**Priority:** P3 · **Effort:** L · **Depends on:** 6.2

Subscription management and payment.

**Plans to implement:**
| Plan | Price | Features |
|---|---|---|
| Free | 0 DKK | 10 searches/day, no AI, no export |
| Starter | 299 DKK/mo | 500 searches/day, AI chat, 1 user |
| Pro | 799 DKK/mo | Unlimited searches, full AI, 5 users, export |
| Enterprise | Contact | Custom limits, SLA, dedicated support |

**Tasks:**

- [ ] Create Stripe account + products/prices
- [ ] Install `stripe` npm package
- [ ] Create `app/api/billing/checkout/route.ts` — creates Stripe Checkout session
- [ ] Create `app/api/billing/webhook/route.ts` — handles Stripe events (subscription created/cancelled/updated)
- [ ] Create `/dashboard/billing` page — current plan, usage, invoices
- [ ] Enforce plan limits via `middleware.ts` (check `tenant.subscriptions` on each request)
- [ ] Usage tracking: increment search counts per tenant per day

---

---

# PHASE 7 — EMAIL & SOCIAL INTEGRATIONS

## 🟡 P3 · Growth and user workflow

---

### 7.1 · Transactional Email (Resend/SendGrid)

**Priority:** P3 · **Effort:** S · **Depends on:** Phase 1

Professional email for: verification, password reset, invitations, alerts.

**Tasks:**

- [ ] Register at Resend.com (recommended — best Next.js integration, free tier is generous)
- [ ] Install `resend` npm package
- [ ] Create `lib/email/client.ts`
- [ ] Create branded email templates (dark theme, BizzAssist logo):
  - Welcome / email verification
  - Password reset
  - Team invitation
  - Entity change alert (company/property update detected)
  - Weekly digest (summary of saved entity changes)
- [ ] Wire Supabase Auth to use custom Resend SMTP

---

### 7.2 · Gmail Integration

**Priority:** P3 · **Effort:** L · **Depends on:** 1.5 (Google OAuth)

Allow users to send outreach emails directly from BizzAssist (e.g. contact a company director).

**Tasks:**

- [ ] Extend Google OAuth scope to include `gmail.send` (requires user consent)
- [ ] Create `lib/integrations/gmail/client.ts` — Gmail API wrapper
- [ ] Create `app/api/integrations/gmail/send/route.ts`
- [ ] Build email compose UI (pre-populated with contact from person profile)
- [ ] Email templates: introduce yourself, request information, partnership inquiry
- [ ] Track sent emails in `tenant.audit_log`
- [ ] **Note:** Google requires OAuth app verification for sensitive scopes — plan 2–4 weeks for review

---

### 7.3 · LinkedIn Profile Enrichment

**Priority:** P3 · **Effort:** L · **Depends on:** 1.6 (LinkedIn OAuth)

Enrich person profiles with LinkedIn data.

**Important limitation:** LinkedIn restricts their API very tightly.

**Feasible approach:**

- Use LinkedIn Sign-In to get the authenticated user's own profile
- Allow users to manually link LinkedIn profiles to BizzAssist person entries
- Use LinkedIn's public profile data where available

**Tasks:**

- [ ] Extend LinkedIn OAuth scope to include `profile`, `email`
- [ ] On first LinkedIn login: auto-populate user's own BizzAssist person profile from LinkedIn
- [ ] Build "Link LinkedIn profile" button on person profile pages
- [ ] Store LinkedIn profile URL + public data in `tenant.saved_entities`
- [ ] **Do NOT attempt programmatic LinkedIn scraping** — violates ToS + blocks account

---

### 7.4 · Saved Entity Alerts

**Priority:** P3 · **Effort:** M · **Depends on:** 7.1, 2.1–2.4

Monitor watched entities and send alerts when changes are detected.

**Tasks:**

- [ ] Add `is_monitored` flag to `tenant.saved_entities`
- [ ] Create background job (Supabase Edge Function or Vercel Cron) to poll CVR for changes
- [ ] Detect changes: new board member, company dissolved, new annual report, address change
- [ ] Send email alert (via Resend) when change detected
- [ ] In-app notification bell in topbar (currently UI only)
- [ ] Notification preferences: immediate / daily digest / weekly digest

---

---

# PHASE 8 — ADVANCED FEATURES

## 🟢 P3–P4 · Competitive advantage post-launch

---

### 8.1 · Report Export (PDF)

**Priority:** P3 · **Effort:** M · **Depends on:** 3.2, 3.3, 5.3

Export company/property/analysis reports as branded PDF.

**Tasks:**

- [ ] Install `@react-pdf/renderer` or use Puppeteer for full-page PDF capture
- [ ] Create PDF templates for: Company Profile, Property Report, AI Analysis
- [ ] "Export PDF" button on all profile pages and analysis results
- [ ] Store exported reports in `tenant.reports` with download link
- [ ] PDF includes BizzAssist branding + generation date

---

### 8.2 · Relationship Graph Visualisation

**Priority:** P3 · **Effort:** L · **Depends on:** 2.6 (entity linking)

Interactive network graph showing connections between companies, people, and properties.

**Tasks:**

- [ ] Evaluate graph libraries: `react-force-graph`, `vis-network`, `cytoscape.js`
- [ ] Build `NetworkGraph` component
- [ ] Show: company → directors, company → subsidiaries, person → multiple board roles
- [ ] Clickable nodes → navigate to profile page
- [ ] Highlight suspicious patterns (e.g. same person controlling many companies)
- [ ] Filter by relationship type and depth

---

### 8.3 · Watchlist Dashboard Widget

**Priority:** P3 · **Effort:** S · **Depends on:** 7.4

Dedicated section on dashboard home for monitored entities with latest changes.

**Tasks:**

- [ ] Replace mock "Market Overview" section with real watchlist
- [ ] Show last change date + change description per entity
- [ ] Quick access buttons: view profile, view change, remove from watchlist

---

### 8.4 · Competitor Analysis Tool

**Priority:** P3 · **Effort:** M · **Depends on:** 5.3, 2.1

Structured competitive intelligence workflow.

**Tasks:**

- [ ] User inputs a CVR number
- [ ] System identifies competitors by: same DB07 industry, same municipality, similar revenue
- [ ] AI generates structured comparison: revenue, employees, board overlap, property holdings
- [ ] Side-by-side comparison table
- [ ] Export as PDF or Excel

---

### 8.5 · API Access for Enterprise Customers

**Priority:** P4 · **Effort:** L · **Depends on:** Phase 1–5

Allow enterprise customers to query BizzAssist data via REST API.

**Tasks:**

- [ ] Create API key management in `/dashboard/settings/api`
- [ ] Build `/api/v1/` public API routes with API key auth
- [ ] Rate limiting per API key (separate from UI rate limits)
- [ ] API documentation (Swagger/OpenAPI)
- [ ] Usage dashboard showing API call counts

---

### 8.6 · Mobile App (React Native)

**Priority:** P4 · **Effort:** XL · **Depends on:** All phases

Port the web app to iOS and Android using React Native / Expo.

**Preparation (start now):**

- All components already built mobile-first (no fixed desktop-only layouts)
- Translations system is portable
- Auth uses standard JWT — works with React Native

**Tasks:**

- [ ] Create `apps/mobile/` Expo project
- [ ] Share `lib/` code via monorepo (Turborepo)
- [ ] Port core screens: Dashboard, Search, Company Profile, Property Profile, Chat
- [ ] Native push notifications (for entity change alerts)
- [ ] Offline mode: cached recent searches and profiles
- [ ] Submit to App Store + Google Play

---

---

# SUMMARY — PRIORITISED ORDER

| #   | Epic                           | Priority | Effort | Blocker?     |
| --- | ------------------------------ | -------- | ------ | ------------ |
| 1   | Supabase setup                 | P0       | S      | Yes          |
| 2   | Database schema (public)       | P0       | M      | Yes          |
| 3   | Database schema (tenant)       | P0       | M      | Yes          |
| 4   | Auth: Email + 2FA              | P0       | M      | Yes          |
| 5   | Auth: Google OAuth             | P0       | S      | Yes          |
| 6   | Auth: LinkedIn OAuth           | P0       | S      | Yes          |
| 7   | Tenant middleware + session    | P0       | M      | Yes          |
| 8   | User onboarding flow           | P0       | M      | Yes          |
| 9   | CVR integration — companies    | P1       | L      | Core product |
| 10  | CVR integration — persons      | P1       | M      | Core product |
| 11  | DAWA address + geocoding       | P1       | S      | Core product |
| 12  | BBR / OIS property data        | P1       | L      | Core product |
| 13  | Tinglysning ownership data     | P1       | L      | Core product |
| 14  | Entity linking / normalisation | P1       | L      | Core product |
| 15  | Universal search page          | P1       | M      | Core UX      |
| 16  | Company profile page           | P1       | L      | Core UX      |
| 17  | Property profile page          | P1       | L      | Core UX      |
| 18  | Person profile page            | P1       | M      | Core UX      |
| 19  | Companies browse / filter      | P1       | M      | Core UX      |
| 20  | Properties browse / filter     | P1       | M      | Core UX      |
| 21  | People browse / filter         | P1       | S      | Core UX      |
| 22  | Map provider setup             | P2       | S      | Map          |
| 23  | Property map view              | P2       | M      | Map          |
| 24  | Company map view               | P2       | S      | Map          |
| 25  | Map on property profile        | P2       | S      | Map          |
| 26  | Claude API integration         | P2       | M      | AI           |
| 27  | Tenant-scoped AI context       | P2       | L      | AI           |
| 28  | AI analysis page               | P2       | M      | AI           |
| 29  | Full chat page                 | P2       | M      | AI           |
| 30  | User settings page             | P2       | M      | Account      |
| 31  | Organisation settings page     | P2       | M      | Account      |
| 32  | Transactional email (Resend)   | P3       | S      | Email        |
| 33  | Stripe billing                 | P3       | L      | Revenue      |
| 34  | AI tenant learning / upload    | P3       | L      | AI+          |
| 35  | Gmail integration              | P3       | L      | Workflow     |
| 36  | LinkedIn enrichment            | P3       | L      | Workflow     |
| 37  | Saved entity alerts            | P3       | M      | Alerts       |
| 38  | PDF report export              | P3       | M      | Reports      |
| 39  | Relationship graph viz         | P3       | L      | Insights     |
| 40  | Competitor analysis tool       | P3       | M      | Insights     |
| 41  | API access (enterprise)        | P4       | L      | Enterprise   |
| 42  | Mobile app (React Native)      | P4       | XL     | Mobile       |

---

## Recommended Sprint Plan

### Sprint 1 (Week 1–2): Auth & Database

Items 1–8 — Supabase, all auth methods, DB schemas, middleware, onboarding

### Sprint 2 (Week 3–4): CVR + Search

Items 9–11, 15 — CVR integration, DAWA, universal search working end-to-end

### Sprint 3 (Week 5–6): Property Data + Profiles

Items 12–14, 16–18 — BBR, Tinglysning, entity linking, all 3 profile pages

### Sprint 4 (Week 7–8): Browse + Map

Items 19–25 — List/filter pages, Mapbox integration, map views

### Sprint 5 (Week 9–10): AI

Items 26–29 — Claude API, RAG context, analysis page, full chat page

### Sprint 6 (Week 11–12): Account + Email + Billing

Items 30–33 — Settings, org management, Resend email, Stripe

### Sprint 7+ (Month 4+): Growth features

Items 34–42 — Gmail, LinkedIn, alerts, exports, graphs, API, mobile
