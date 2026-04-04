import { readFileSync, writeFileSync } from 'fs';

const filePath = "C:/Users/JakobJuulRasmussenPh/IT Management Consulting(1)/BizzAssist/bizzassist/app/dashboard/companies/[cvr]/page.tsx";

const replacement = `  /** Individuelle loading-states per søge-kategori — til progressiv visning */
  const [socialsLoading, setSocialsLoading] = useState(false);
  const [articlesLoading, setArticlesLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenInfo, setTokenInfo] = useState<{ used: number; limit: number } | null>(null);
  const [tokensUsedThisSearch, setTokensUsedThisSearch] = useState(0);
  /** Antal synlige artikler — starter på 5, øges med 5 ved hvert "Vis flere"-klik */
  const [visibleCount, setVisibleCount] = useState(5);

  /** Mindst én søge-kategori er stadig i gang */
  const anyLoading = socialsLoading || articlesLoading;

  /** Opdaterer token-info fra subscription context */
  useEffect(() => {
    if (!ctxSub) {
      setTokenInfo(null);
      return;
    }
    const plan = resolvePlan(ctxSub.planId);
    if (!plan.aiEnabled) {
      setTokenInfo(null);
      return;
    }
    const limit =
      plan.aiTokensPerMonth < 0 ? -1 : plan.aiTokensPerMonth + (ctxSub.bonusTokens ?? 0);
    setTokenInfo({ used: ctxSub.tokensUsedThisMonth, limit });
  }, [ctxSub]);

  /** Bygger liste af nøglepersoner fra deltagere-array */
  const keyPersons = useMemo(() => {
    return (companyData.deltagere ?? [])
      .filter((d) => !d.erVirksomhed && d.roller.some((r) => !r.til))
      .map((d) => d.navn)
      .slice(0, 8);
  }, [companyData.deltagere]);

  /**
   * Starter AI-søgning med 2 parallelle kald (socials + articles).
   * Hvert kald opdaterer sin egen loading-state og viser resultater progressivt.
   */
  const handleSearch = useCallback(async () => {
    if (anyLoading) return;

    if (ctxSub) {
      const plan = resolvePlan(ctxSub.planId);
      if (!isSubscriptionFunctional(ctxSub, plan)) return;
      if (!plan.aiEnabled) return;
      const limit =
        plan.aiTokensPerMonth < 0 ? -1 : plan.aiTokensPerMonth + (ctxSub.bonusTokens ?? 0);
      if (limit > 0 && ctxSub.tokensUsedThisMonth >= limit) return;
    }

    setHasSearched(true);
    setError(null);
    setArticles([]);
    setVisibleCount(5);
    setSocialsLoading(true);
    setArticlesLoading(true);
    setTokensUsedThisSearch(0);

    const payload = JSON.stringify({
      companyName: companyData.name,
      cvr: String(companyData.vat),
      industry: companyData.industrydesc,
      employees: companyData.employees,
      city: companyData.city,
      keyPersons,
    });

    // ── Sociale medier (hurtigst ~2s) ──
    const socialsPromise = fetch('/api/ai/article-search/socials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
      .then(async (res) => {
        const json = await res.json();
        type SocialMeta = { url: string; confidence: number; reason?: string };
        const socialsWithMeta = json.socialsWithMeta as Record<string, SocialMeta> | undefined;
        if (socialsWithMeta && Object.keys(socialsWithMeta).length > 0) {
          onSocialsFound?.(socialsWithMeta);
        }
        type AltMeta = { url: string; confidence: number; reason?: string };
        const altsWithMeta = json.alternativesWithMeta as Record<string, AltMeta[]> | undefined;
        if (altsWithMeta && Object.keys(altsWithMeta).length > 0) {
          onAlternativesFound?.(altsWithMeta);
          // Gem string-URL-version til Supabase (backward compat)
          const stringAlts: Record<string, string[]> = {};
          for (const [k, arr] of Object.entries(altsWithMeta)) {
            stringAlts[k] = arr.map((a) => a.url);
          }
          fetch('/api/link-alternatives', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cvr: String(companyData.vat), alternatives: stringAlts }),
          }).catch(() => { /* ignore */ });
        }
        if (typeof json.confidenceThreshold === 'number') {
          onThresholdFound?.(json.confidenceThreshold);
        }
        return (json.tokensUsed as number) ?? 0;
      })
      .catch(() => 0)
      .finally(() => setSocialsLoading(false));

    // ── Artikler (~5-8s) ──
    const articlesPromise = fetch('/api/ai/article-search/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
      .then(async (res) => {
        const json = await res.json();
        if (json.error) setError(json.error);
        const fetchedArticles: AIArticleResult[] = json.articles ?? [];
        setArticles(fetchedArticles);
        setVisibleCount(5);
        return (json.tokensUsed as number) ?? 0;
      })
      .catch(() => 0)
      .finally(() => setArticlesLoading(false));

    // ── Vent på begge og rapportér samlet token-forbrug ──
    const [socialsTokens, articlesTokens] = await Promise.all([socialsPromise, articlesPromise]);
    const total = socialsTokens + articlesTokens;
    if (total > 0) {
      setTokensUsedThisSearch(total);
      addTokenUsage(total);
      syncTokenUsageToServer(total);
    }
  }, [
    anyLoading,
    ctxSub,
    companyData,
    keyPersons,
    addTokenUsage,
    onSocialsFound,
    onAlternativesFound,
    onThresholdFound,
  ]);

  const da = lang === 'da';

  /** Locked state — ingen AI-adgang */
  if (!subActive) {
    return (
      <div className="flex flex-col items-center gap-2 py-3 text-center">
        <div className="w-8 h-8 bg-amber-500/10 rounded-lg flex items-center justify-center">
          <Lock size={14} className="text-amber-400" />
        </div>
        <p className="text-slate-500 text-xs leading-relaxed">
          {da
            ? 'AI-søgning kræver et aktivt abonnement.'
            : 'AI search requires an active subscription.'}
        </p>
      </div>
    );
  }

  /** Token-statusbar (vises over knap og resultater) */
  const tokenBar =
    tokenInfo && (tokenInfo.limit > 0 || tokenInfo.limit === -1) ? (
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[10px] text-slate-600 whitespace-nowrap">Tokens</span>
        {tokenInfo.limit === -1 ? (
          <>
            <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-purple-500 w-full" />
            </div>
            <span className="text-[10px] font-medium text-purple-400">∞</span>
          </>
        ) : (
          <>
            <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
              <div
                className={\`h-full rounded-full transition-all \${
                  tokenInfo.used / tokenInfo.limit > 0.9
                    ? 'bg-red-500'
                    : tokenInfo.used / tokenInfo.limit > 0.7
                      ? 'bg-amber-500'
                      : 'bg-blue-500'
                }\`}
                style={{ width: \`\${Math.min(100, (tokenInfo.used / tokenInfo.limit) * 100)}%\` }}
              />
            </div>
            <span
              className={\`text-[10px] font-medium whitespace-nowrap \${
                tokenInfo.used / tokenInfo.limit > 0.9
                  ? 'text-red-400'
                  : tokenInfo.used / tokenInfo.limit > 0.7
                    ? 'text-amber-400'
                    : 'text-slate-500'
              }\`}
            >
              {formatTokens(tokenInfo.used)}/{formatTokens(tokenInfo.limit)}
            </span>
          </>
        )}
      </div>
    ) : null;

  /** AI disclaimer — vises altid under token-bar */
  const aiDisclaimer = (
    <p className="text-xs text-slate-500 mb-3">
      ⚠️ Svar genereret af AI er ikke nødvendigvis korrekte. Verificér altid vigtig information.
    </p>
  );

  /** Go-state — søgning ikke startet endnu */
  if (!hasSearched) {
    return (
      <div>
        {tokenBar}
        {aiDisclaimer}
        <p className="text-slate-500 text-xs mb-3 leading-relaxed">
          {da
            ? \`Klik for at finde op til 30 seneste danske nyheder om \${companyData.name}.\`
            : \`Click to find up to 30 latest Danish news articles about \${companyData.name}.\`}
        </p>
        <button
          onClick={handleSearch}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 border border-blue-500/60 rounded-lg text-white text-xs font-medium transition-all"
        >
          <Zap size={12} />
          {da ? 'Søg med AI' : 'Search with AI'}
        </button>
      </div>
    );
  }

  /** Progressiv resultat-state — vises når søgning er startet */
  return (
    <div>
      {tokenBar}
      {aiDisclaimer}

      {/* Aktive loading-indikatorer per kategori */}
      {anyLoading && (
        <div className="space-y-1 mb-3">
          {socialsLoading && (
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <Loader2 size={10} className="animate-spin text-blue-400 flex-shrink-0" />
              <span>{da ? 'Søger sociale medier…' : 'Searching social media…'}</span>
            </div>
          )}
          {articlesLoading && (
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <Loader2 size={10} className="animate-spin text-purple-400 flex-shrink-0" />
              <span>{da ? 'Søger artikler…' : 'Searching articles…'}</span>
            </div>
          )}
        </div>
      )}

      {/* Token-forbrug (vises når alle er færdige) */}
      {!anyLoading && tokensUsedThisSearch > 0 && (
        <p className="text-[10px] text-slate-600 mb-3">
          {da
            ? \`Brugte \${formatTokens(tokensUsedThisSearch)} tokens\`
            : \`Used \${formatTokens(tokensUsedThisSearch)} tokens\`}
        </p>
      )}

      {error && <p className="text-red-400 text-xs mb-2">{error}</p>}

      {/* Artikler — fade-in når de ankommer */}
      {articlesLoading && articles.length === 0 ? null : articles.length === 0 &&
        !articlesLoading ? (
        <p className="text-slate-600 text-xs">
          {da
            ? 'Ingen danske medieartikler fundet for denne virksomhed.'
            : 'No Danish media articles found for this company.'}
        </p>
      ) : (
        <div
          className="space-y-2.5"
          style={{ animation: articles.length > 0 ? 'fadeIn 0.4s ease-in' : undefined }}
        >
          {articles.slice(0, visibleCount).map((a, i) => (
            <a
              key={i}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-start gap-2 group"
            >
              <ExternalLink
                size={10}
                className="text-slate-600 group-hover:text-blue-400 flex-shrink-0 mt-0.5"
              />
              <div className="min-w-0">
                <p className="text-slate-300 text-xs font-medium group-hover:text-blue-300 transition-colors leading-snug">
                  {a.title}
                </p>
                <p className="text-slate-600 text-[10px] mt-0.5">
                  {a.source}
                  {a.date ? \` · \${a.date}\` : ''}
                </p>
                {a.description && (
                  <p className="text-slate-600 text-[10px] mt-0.5 line-clamp-2">{a.description}</p>
                )}
              </div>
            </a>
          ))}
          {visibleCount < articles.length && (
            <button
              onClick={() => setVisibleCount((c) => Math.min(c + 5, articles.length))}
              className="mt-1 flex items-center gap-1 text-[10px] text-slate-500 hover:text-blue-400 transition-colors"
            >
              <ChevronDown size={10} />
              {da
                ? \`Vis flere (\${articles.length - visibleCount} mere)\`
                : \`Show more (\${articles.length - visibleCount} more)\`}
            </button>
          )}
        </div>
      )}

      {/* Søg igen (vises kun når alt er færdigt) */}
      {!anyLoading && (
        <button
          onClick={handleSearch}
          className="mt-3 flex items-center gap-1.5 text-[10px] text-slate-500 hover:text-blue-400 transition-colors"
        >
          <Zap size={9} />
          {da ? 'Søg igen' : 'Search again'}
        </button>
      )}
    </div>
  );
}`;

const content = readFileSync(filePath, 'utf8');
const lines = content.split('\n');

console.log(`Total lines: ${lines.length}`);
console.log(`Line 3000 (1-indexed): ${JSON.stringify(lines[2999])}`);
console.log(`Line 3301 (1-indexed): ${JSON.stringify(lines[3300])}`);

// Replace lines 2999..3300 (0-indexed, inclusive) with the replacement
const before = lines.slice(0, 2999);        // lines 0..2998 (lines 1..2999 in 1-indexed)
const after = lines.slice(3301);            // lines 3301.. (line 3302.. in 1-indexed)

const replacementLines = replacement.split('\n');

const newLines = [...before, ...replacementLines, ...after];
const newContent = newLines.join('\n');

writeFileSync(filePath, newContent, 'utf8');

// Re-read to verify
const verify = readFileSync(filePath, 'utf8').split('\n');
console.log(`\nNew total lines: ${verify.length}`);
console.log(`New line 3000 (1-indexed): ${JSON.stringify(verify[2999])}`);
console.log(`New line 3001 (1-indexed): ${JSON.stringify(verify[3000])}`);
console.log(`New line 3002 (1-indexed): ${JSON.stringify(verify[3001])}`);
console.log(`New line 3003 (1-indexed): ${JSON.stringify(verify[3002])}`);
console.log(`New line 3004 (1-indexed): ${JSON.stringify(verify[3003])}`);
console.log(`New line 3005 (1-indexed): ${JSON.stringify(verify[3004])}`);
