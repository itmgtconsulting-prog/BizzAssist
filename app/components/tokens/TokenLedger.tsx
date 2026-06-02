/**
 * BIZZ-1770: Token transaktionshistorik (ledger).
 *
 * Viser debit/credit transaktioner i en tabel med dato, type,
 * beskrivelse, tokens og running balance. Paginated.
 *
 * @module app/components/tokens/TokenLedger
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight } from 'lucide-react';

interface LedgerTransaction {
  id: number;
  txn_type: 'debit' | 'credit';
  amount_tokens: number;
  action: string;
  description: string | null;
  model: string | null;
  balance_after: number;
  created_at: string;
}

interface Props {
  lang: 'da' | 'en';
}

/**
 * Token-ledger med paginated transaktionshistorik.
 */
export default function TokenLedger({ lang }: Props) {
  const da = lang === 'da';
  const [transactions, setTransactions] = useState<LedgerTransaction[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const limit = 20;

  const fetchPage = useCallback(
    async (off: number) => {
      setLoading(true);
      try {
        const res = await fetch(`/api/tokens/ledger?offset=${off}&limit=${limit}`);
        if (res.ok) {
          const data = await res.json();
          setTransactions(data.transactions ?? []);
          setTotal(data.total ?? 0);
        }
      } catch {
        /* non-fatal */
      }
      setLoading(false);
    },
    [limit]
  );

  useEffect(() => {
    fetchPage(offset);
  }, [offset, fetchPage]);

  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(da ? 'da-DK' : 'en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return iso;
    }
  };

  const fmtTokens = (n: number) => n.toLocaleString(da ? 'da-DK' : 'en-GB');

  const actionLabels: Record<string, string> = {
    'ai-chat': da ? 'AI Chat' : 'AI Chat',
    'forklar-vurdering': da ? 'Forklar vurdering' : 'Explain valuation',
    'akt-ekstraktion': da ? 'Akt-ekstraktion' : 'Deed extraction',
    'subscription-renewal': da ? 'Abonnement fornyet' : 'Subscription renewed',
    'token-purchase': da ? 'Token-køb' : 'Token purchase',
    'admin-grant': da ? 'Admin-tilskrivning' : 'Admin grant',
    'vurdering.generate-ai': da ? 'Vurderingsrapport AI' : 'Valuation report AI',
  };

  return (
    <div className="bg-slate-800/40 border border-slate-700/40 rounded-xl p-4">
      <h3 className="text-white font-semibold text-sm mb-3">
        {da ? 'Transaktionshistorik' : 'Transaction History'}
      </h3>

      {loading && transactions.length === 0 ? (
        <div className="text-slate-400 text-xs py-8 text-center">
          {da ? 'Henter transaktioner…' : 'Loading transactions…'}
        </div>
      ) : transactions.length === 0 ? (
        <div className="text-slate-400 text-xs py-8 text-center">
          {da ? 'Ingen transaktioner endnu.' : 'No transactions yet.'}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400 border-b border-slate-700/40">
                  <th className="text-left py-1.5 px-2 font-medium">{da ? 'Dato' : 'Date'}</th>
                  <th className="text-left py-1.5 px-2 font-medium">{da ? 'Type' : 'Type'}</th>
                  <th className="text-left py-1.5 px-2 font-medium">
                    {da ? 'Beskrivelse' : 'Description'}
                  </th>
                  <th className="text-right py-1.5 px-2 font-medium">Tokens</th>
                  <th className="text-right py-1.5 px-2 font-medium">{da ? 'Saldo' : 'Balance'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/20">
                {transactions.map((txn) => (
                  <tr key={txn.id} className="hover:bg-slate-700/20">
                    <td className="py-1.5 px-2 text-slate-400 whitespace-nowrap">
                      {fmtDate(txn.created_at)}
                    </td>
                    <td className="py-1.5 px-2">
                      {txn.txn_type === 'credit' ? (
                        <span className="inline-flex items-center gap-1 text-emerald-400">
                          <ArrowDownLeft size={10} />
                          {da ? 'Kredit' : 'Credit'}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-rose-400">
                          <ArrowUpRight size={10} />
                          {da ? 'Debit' : 'Debit'}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 px-2 text-slate-300 max-w-[200px] truncate">
                      {txn.description ?? actionLabels[txn.action] ?? txn.action}
                      {txn.model && (
                        <span className="ml-1 text-slate-400 text-[10px]">({txn.model})</span>
                      )}
                    </td>
                    <td
                      className={`py-1.5 px-2 text-right font-mono ${txn.txn_type === 'credit' ? 'text-emerald-400' : 'text-rose-400'}`}
                    >
                      {txn.txn_type === 'credit' ? '+' : '-'}
                      {fmtTokens(txn.amount_tokens)}
                    </td>
                    <td className="py-1.5 px-2 text-right font-mono text-slate-300">
                      {fmtTokens(txn.balance_after)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {total > limit && (
            <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-700/30">
              <span className="text-[10px] text-slate-400">
                {offset + 1}–{Math.min(offset + limit, total)} {da ? 'af' : 'of'} {total}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                  disabled={offset === 0}
                  className="p-1 rounded hover:bg-slate-700 disabled:opacity-30 text-slate-400"
                  aria-label={da ? 'Forrige side' : 'Previous page'}
                >
                  <ChevronLeft size={14} />
                </button>
                <button
                  onClick={() => setOffset(offset + limit)}
                  disabled={offset + limit >= total}
                  className="p-1 rounded hover:bg-slate-700 disabled:opacity-30 text-slate-400"
                  aria-label={da ? 'Næste side' : 'Next page'}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
