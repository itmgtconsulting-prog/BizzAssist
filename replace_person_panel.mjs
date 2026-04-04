import { readFileSync, writeFileSync } from 'fs';

const filePath = 'C:\\Users\\JakobJuulRasmussenPh\\IT Management Consulting(1)\\BizzAssist\\bizzassist\\app\\dashboard\\owners\\[enhedsNummer]\\page.tsx';

const raw = readFileSync(filePath, 'utf8');
const lines = raw.split('\n');

console.log(`Total lines: ${lines.length}`);
console.log(`Line 1409 (0-indexed 1408): ${JSON.stringify(lines[1408])}`);
console.log(`Line 1719 (0-indexed 1718): ${JSON.stringify(lines[1718])}`);
console.log(`Line 1720 (0-indexed 1719): ${JSON.stringify(lines[1719])}`);

const newContent = `  /** Individuelle loading-states per søge-kategori — til progressiv visning */
  const [socialsLoading, setSocialsLoading] = useState(false);
  const [articlesLoading, setArticlesLoading] = useState(false);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenInfo, setTokenInfo] = useState<{ used: number; limit: number } | null>(null);
  const [tokensUsedThisSearch, setTokensUsedThisSearch] = useState(0);
  /** Antal synlige artikler — starter på 5, øges med 5 ved hvert "Vis flere"-klik */
  const [visibleCount, setVisibleCount] = useState(5);

  /** Mindst én søge-kategori er stadig i gang */
  const anyLoading = socialsLoading || articlesLoading || contactsLoading;

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

  /**
   * Bygger liste af virksomheder personen er aktiv tilknyttet — sendes til API som søgekontekst.
   * Inkluderer alle aktive roller (ikke kun ejerroller) da artikel-søgning profiterer af
   * alle offentlige tilknytninger (DIREKTØR, STIFTER, EJER osv.).
   * Begrænset til top 5.
   */
  const ownedCompanies = useMemo(() => {
    return personData.virksomheder
      .filter((v) => v.aktiv && v.roller.some((r) => !r.til))
      .slice(0, 5)
      .map((v) => ({ cvr: v.cvr, name: v.navn }));
  }, [personData.virksomheder]);

  /** Finder personens primære by fra ejervirksomhedernes adresser */
  const city = useMemo(() => {
    for (const v of personData.virksomheder) {
      if (v.aktiv && v.by) return v.by;
    }
    return undefined;
  }, [personData.virksomheder]);

  /**
   * Starter AI-søgning med 3 parallelle kald (socials, articles, contacts).
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
    setContactsLoading(true);
    setTokensUsedThisSearch(0);

    const payload = JSON.stringify({
      personName: personData.navn,
      companies: ownedCompanies,
      city,
    });

    // ── Sociale medier (hurtigst ~2s) ──
    const socialsPromise = fetch('/api/ai/person-search/socials', {
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
        }
        if (typeof json.confidenceThreshold === 'number') {
          onThresholdFound?.(json.confidenceThreshold);
        }
        return (json.tokensUsed as number) ?? 0;
      })
      .catch(() => 0)
      .finally(() => setSocialsLoading(false));

    // ── Artikler (~5-8s) ──
    const articlesPromise = fetch('/api/ai/person-search/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
      .then(async (res) => {
        const json = await res.json();
        if (json.error) setError(json.error);
        const fetchedArticles: PersonAIArticleResult[] = json.articles ?? [];
        setArticles(fetchedArticles);
        setVisibleCount(5);
        return (json.tokensUsed as number) ?? 0;
      })
      .catch(() => 0)
      .finally(() => setArticlesLoading(false));

    // ── Kontaktoplysninger (~3-5s) ──
    const contactsPromise = fetch('/api/ai/person-search/contacts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    })
      .then(async (res) => {
        const json = await res.json();
        const contacts = json.contacts as ContactResult[] | undefined;
        if (contacts && contacts.length > 0) {
          onContactsFound?.(contacts);
        }
        return (json.tokensUsed as number) ?? 0;
      })
      .catch(() => 0)
      .finally(() => setContactsLoading(false));

    // ── Vent på alle og rapportér samlet token-forbrug ──
    const [socialsTokens, articlesTokens, contactsTokens] = await Promise.all([
      socialsPromise,
      articlesPromise,
      contactsPromise,
    ]);
    const total = socialsTokens + articlesTokens + contactsTokens;
    if (total > 0) {
      setTokensUsedThisSearch(total);
      addTokenUsage(total);
      syncPersonTokenUsageToServer(total);
    }
  }, [
    anyLoading,
    ctxSub,
    personData,
    ownedCompanies,
    city,
    addTokenUsage,
    onSocialsFound,
    onAlternativesFound,
    onThresholdFound,
    onContactsFound,
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
            ? \`Klik for at finde op til 15 seneste nyheder om \${personData.navn}.\`
            : \`Click to find up to 15 latest news articles about \${personData.navn}.\`}
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
          {contactsLoading && (
            <div className="flex items-center gap-2 text-slate-400 text-xs">
              <Loader2 size={10} className="animate-spin text-green-400 flex-shrink-0" />
              <span>{da ? 'Søger kontaktoplysninger…' : 'Searching contacts…'}</span>
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
            ? 'Ingen danske medieartikler fundet for denne person.'
            : 'No Danish media articles found for this person.'}
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
          {articles.length > visibleCount && (
            <button
              onClick={() => setVisibleCount((v) => v + 5)}
              className="text-[10px] text-slate-500 hover:text-blue-400 transition-colors mt-1"
            >
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

const newLines = newContent.split('\n');

// Keep lines 0..1407 (inclusive), replace 1408..1718 (inclusive), keep 1719..
const before = lines.slice(0, 1408);   // indices 0–1407
const after  = lines.slice(1719);      // indices 1719..end

const result = [...before, ...newLines, ...after];

console.log(`Before slice: ${before.length} lines`);
console.log(`New content: ${newLines.length} lines`);
console.log(`After slice: ${after.length} lines`);
console.log(`Total output: ${result.length} lines`);

// Spot-check boundary
console.log(`\nOutput line 1408 (0-indexed): ${JSON.stringify(result[1408])}`);
console.log(`Output last-new line: ${JSON.stringify(result[1408 + newLines.length - 1])}`);
console.log(`Output first-after line: ${JSON.stringify(result[1408 + newLines.length])}`);

writeFileSync(filePath, result.join('\n'), 'utf8');
console.log('\nFile written successfully.');
