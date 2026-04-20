# SEO Indexing — Google Search Console + Bing Webmaster Tools

**Audience:** ops / product admins with access to the `bizzassist.dk` production domain.

**BIZZ-646:** Submitting the sitemap manually dramatically speeds up Google/Bing discovery of the public `/ejendom/[slug]/[bfe]` and `/virksomhed/[slug]/[cvr]` pages.

---

## 1. Google Search Console (GSC)

### Add the property

1. Sign in at https://search.google.com/search-console with an account that has access to the `bizzassist.dk` DNS zone or Vercel project.
2. Click **Add property** → choose **Domain property** (not URL prefix) so both `https://` and `www.` variants are covered.
3. Enter `bizzassist.dk`.

### Verify ownership

GSC accepts either a DNS TXT record or an HTML-tag method. Use DNS:

1. GSC shows a string like `google-site-verification=ABC…`.
2. Add it as a TXT record at the `bizzassist.dk` apex:
   - **Type:** TXT
   - **Name:** `@` (apex)
   - **Value:** `google-site-verification=<string from GSC>`
   - **TTL:** 3600
3. Wait for DNS propagation (usually 5–15 min). Use `dig TXT bizzassist.dk +short` to confirm.
4. Back in GSC click **Verify**.

### Submit the sitemap

1. In the left sidebar: **Sitemaps**.
2. Enter `sitemap/0.xml` (the path after `bizzassist.dk/`). Next.js paginates the sitemap — additional pages at `sitemap/1.xml`, `sitemap/2.xml`, … auto-discover via `<sitemapindex>` if present.
3. Click **Submit**.
4. Enable email alerts under **Settings → User and permissions → Email preferences** so coverage errors page you directly.

### What to expect

- Within 48 hours: GSC shows **Discovered** count. Should be > 0.
- Within 2 weeks: **Indexed** count should be ≥ 100. If still 0 → troubleshoot (see below).

---

## 2. Bing Webmaster Tools

Bing can import the property directly from GSC once GSC is verified:

1. Sign in at https://www.bing.com/webmasters with a Microsoft account.
2. Click **Import your sites from Google Search Console**.
3. Authorize access. Bing pulls the verified property + sitemap config.

If import is unavailable:

1. Click **Add a site** → enter `https://bizzassist.dk`.
2. Verify via DNS (same TXT pattern, different prefix: `msvalidate.01=…`).
3. Go to **Sitemaps** → **Submit sitemap** → `https://bizzassist.dk/sitemap/0.xml`.

---

## 3. Troubleshooting (if coverage stays at 0)

### robots.txt blocks the pages

```bash
curl -s https://bizzassist.dk/robots.txt
```

Expected: `Sitemap:` header on a single line, `Allow: /ejendom/` and `Allow: /virksomhed/` present, `Disallow: /dashboard/` etc. **No line breaks inside the Sitemap URL.**

Fix if header breaks across lines: `NEXT_PUBLIC_APP_URL` env-var on Vercel contains trailing whitespace. `getAppUrl()` and `robots.ts` both `.trim()` defensively (BIZZ-645), but fix the Vercel env too.

### Sitemap is empty

```bash
curl -s https://bizzassist.dk/sitemap/0.xml | head -20
```

Empty `<urlset></urlset>` → `public.sitemap_entries` is empty on prod. Options:

1. Wait for daily cron (2:23 UTC / 3:37 UTC / 4:51 UTC — companies / properties / vp-properties).
2. Trigger manually:
   ```bash
   curl -H "Authorization: Bearer $CRON_SECRET" -H "x-vercel-cron: 1" \
     'https://bizzassist.dk/api/cron/generate-sitemap?phase=companies'
   curl -H "Authorization: Bearer $CRON_SECRET" -H "x-vercel-cron: 1" \
     'https://bizzassist.dk/api/cron/generate-sitemap?phase=properties'
   curl -H "Authorization: Bearer $CRON_SECRET" -H "x-vercel-cron: 1" \
     'https://bizzassist.dk/api/cron/generate-sitemap?phase=vp-properties'
   ```
3. Verify row count:
   ```sql
   SELECT type, count(*) FROM public.sitemap_entries GROUP BY type;
   ```

### Individual pages return 404

```bash
curl -sI https://bizzassist.dk/ejendom/<slug>/<bfe>
```

If 404: ISR revalidation failed — check Sentry for errors on `app/(public)/ejendom/[slug]/[bfe]/page.tsx`. Often upstream Datafordeler / DAWA was down at render time.

### `sitemap_entries` table missing

Migration `037_sitemap_entries.sql` not applied on prod. Run via Supabase Management API (see BIZZ-645 for the exact payload) or via Supabase SQL editor directly.

---

## 4. Ongoing monitoring

- **Cron heartbeats:** `/dashboard/admin/cron-status` shows when `generate-sitemap-*` last ran + duration + errors. Auto-flags crons overdue > 2× interval.
- **Sentry cron-monitors:** all 3 sitemap phases have `withCronMonitor()` wrappers (BIZZ-624) — Sentry alerts on missed check-ins.
- **GSC Coverage tab:** weekly walk-through. "Excluded" and "Error" categories are the signal; aim for zero beyond temporary 5xx.

---

## 5. Credentials + access

- GSC account: `itmgtconsulting@gmail.com` (primary) — add team members via **Settings → Users and permissions** as **Full** for ops, **Restricted** for viewers.
- Bing Webmaster: same Microsoft account; add delegates via **Users**.
- Vercel project: `prj_HX46RO3u4Jhbvira8ju2hsF3xtTs`.
- CRON_SECRET: stored in Vercel env — copy from there for manual triggers. Rotate annually (cascade into `.env.local` + Vercel prod/preview).

---

## 6. Change log

| Date       | Change                                                                                                                                             | Ticket   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 2026-04-20 | Sitemap cron switched weekly → daily (23:02 / 37:03 / 51:04 UTC)                                                                                   | BIZZ-647 |
| 2026-04-20 | `getAppUrl()` + `robots.ts` trim env-var whitespace                                                                                                | BIZZ-645 |
| 2026-04-20 | JSON-LD switched from `RealEstateListing` → `Place/Residence/ApartmentComplex` based on BBR anvendelseskode; CVR/BFE as `PropertyValue` identifier | BIZZ-648 |
| 2026-04-20 | Runbook created                                                                                                                                    | BIZZ-646 |
