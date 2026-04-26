# Admin Layout Alignment Analysis

**Ticket:** BIZZ-741
**Scope:** `/dashboard/admin/*` tabs under super-admin
**Date:** 2026-04-23

## Reference design

`Brugere` + `Fakturering` are the canonical reference. Every admin tab should
eventually converge on this skeleton:

```
 ┌──────────────────────────────────────────────────────────┐
 │ Header (title + subtitle + optional back-arrow)          │
 ├──────────────────────────────────────────────────────────┤
 │ AdminNavTabs (shared, BIZZ-737)                          │
 ├──────────────────────────────────────────────────────────┤
 │ Stats card row — 2-4 cards, icon + big number            │
 │   bg-slate-900/50 border border-slate-700/40 rounded-xl  │
 ├──────────────────────────────────────────────────────────┤
 │ Search input + filter pills (status, plan, date range)   │
 ├──────────────────────────────────────────────────────────┤
 │ Data table with action buttons + badges                  │
 │   bg-slate-800/40 border border-slate-700/40 rounded-xl  │
 └──────────────────────────────────────────────────────────┘
```

## Per-tab assessment

| Tab                | Match        | Effort | Top 3 gaps                                          |
| ------------------ | ------------ | ------ | --------------------------------------------------- |
| Users              | ✅ reference | S      | —                                                   |
| Billing            | ✅ reference | S      | —                                                   |
| Plans              | ❌ differs   | L      | no cards; no search; no table                       |
| Analytics          | ⚠️ partial   | M      | no filter pills; no table; date hardcoded           |
| AI-Media-Agents    | ❌ differs   | L      | no cards; no search; no table (settings form)       |
| Security           | ❌ differs   | L      | no cards; no search; no table (settings form)       |
| Service-Manager    | ❌ differs   | L      | no cards; no search; custom collapsible sections    |
| Service-Management | ❌ differs   | M      | no stats cards; no search; service-status grid only |
| Cron-Status        | ⚠️ partial   | M      | stats inline (not card-styled); no filter pills     |
| Domains            | ⚠️ partial   | M      | no stats cards; no search; minimal filters          |

## Per-tab notes

### Users — reference (~734 lines)

Header + 3 stats cards + search + plan filter + sections (pending, all users,
no-subscription). No work needed.

### Billing — reference (~486 lines)

Header + 4 KPI cards (MRR, active, pending, churned) + filter pills + data
table with action buttons. No work needed.

### Plans (~1630 lines) — complex form builder

Inline form grid (2-4 cols) + collapsible edit rows + validation tooltips.
No stats, no search, no table. Requires extraction of plans into a table
view with an "Edit" action that opens the existing form in a drawer or
modal.

### Analytics (~367 lines)

Stats row is present (total, matched, unmatched, match-rate) plus charts and
top-lists. Needs an explicit filter bar (date range, language, status) and
a searchable row-based view for the "Unmatched queries" and "Top pages"
sections (currently just bullet lists).

### AI-Media-Agents (~886 lines) — settings form

4 sections with toggles/sliders/domain allowlists. Pure settings UI with
no data overview. Aligning means either (a) wrapping current settings in
stat-card style boxes and accepting that this tab is intrinsically config-
heavy, or (b) adding an "AI usage" / "Last training run" stats row at the
top. Option (b) is closer to the reference but needs new metric endpoints.

### Security (~391 lines) — settings form

3 sliders (idle/absolute/refresh token timeouts) + info boxes. Same shape
as AI-Media-Agents. Fastest alignment: add an audit-style KPI row ("failed
logins last 24h", "active sessions", "2FA coverage %"). Sliders can stay
inside stat-card wrappers.

### Service-Manager (~1322 lines) — deployment + issue dashboard

Tabs for deployments / scans / fixes + Vercel deployment list + collapsible
issue cards + AI fix proposals with diff viewer. Structurally it's not a
"list with a filter" — alignment is shallow: add a KPI row at the very top
(deployments/week, critical scans open, fixes pending review) and move the
tabbed sub-navigation inside to match the rest of the admin design.

### Service-Management (~737 lines) — infrastructure grid

Hardcoded list of 10+ services with per-card status badges. Keep the grid,
but add a KPI card row ("Operational 10/11 · Degraded 1 · Down 0") and a
search input above the grid.

### Cron-Status (~350 lines)

Summary stats are rendered inline as "10/15 OK · 2 errors · 1 overdue".
Cheapest alignment of any tab: lift those numbers into 3 stat cards and
add a status-filter pill strip above the table.

### Domains (~253 lines) — BIZZ-701 new feature

Table + create button + action buttons, but no KPI cards or search. Add a
stat-card row (Active / Suspended / Archived / Total) and a search-by-name
input; the table structure is already aligned.

## Recommended rollout

1. **Quick wins (M effort, highest consistency-per-line ratio)** — Cron-Status,
   Domains, Analytics, Service-Management. Mostly additive work, no
   structural change.
2. **Medium effort wrappers (L, but bounded)** — Security and AI-Media-Agents
   wrapped in stat-card style boxes to visually unify. Adds new metric
   endpoints.
3. **Large refactor (L)** — Plans (extract to table + drawer-edit) and
   Service-Manager (re-organise tabbed sub-nav + add KPI row). Consider
   splitting Plans into a sub-epic.

## Effort summary

| Effort                  | Tabs                                                |
| ----------------------- | --------------------------------------------------- |
| S (aligned)             | Users, Billing                                      |
| M (add cards + filter)  | Analytics, Service-Management, Cron-Status, Domains |
| L (structural refactor) | Plans, AI-Media-Agents, Security, Service-Manager   |

## Next steps

This analysis feeds directly into `BIZZ-739` (implementation). Recommended:
create one child ticket per L-effort tab under BIZZ-739, and roll the four
M-effort tabs into the BIZZ-739 parent — they share the same pattern
(add KPI row + add search/filter) and can ship as a single PR.

**Shared building blocks already exist:**

- `AdminNavTabs` component (`app/dashboard/admin/AdminNavTabs.tsx`)
- Card class pattern (`bg-slate-900/50 border border-slate-700/40 rounded-xl p-4`)
- Table class pattern (`bg-slate-800/40 border border-slate-700/40 rounded-xl`)

No new shared component is strictly required for the M-effort tabs — the
pattern can be inlined until 3+ tabs converge and a `<StatsCardRow>` +
`<AdminFilterBar>` extraction becomes worthwhile.
