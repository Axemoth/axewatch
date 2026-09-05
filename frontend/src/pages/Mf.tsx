import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchMfDetail,
  fetchMfList,
  type MfAlloc,
  type MfScheme,
} from "../api";

function inr(n?: number | null, frac = 4) {
  return n != null && Number.isFinite(n)
    ? n.toLocaleString("en-IN", { maximumFractionDigits: frac })
    : "—";
}

const inputCls =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none placeholder:text-zinc-400 focus:border-emerald-500 dark:border-zinc-800 dark:bg-zinc-950/70 dark:placeholder:text-zinc-600 dark:focus:border-emerald-500/50";

function AllocBar({ a }: { a: MfAlloc }) {
  const parts = [
    { label: "Equity (stocks)", value: a.equity ?? 0, cls: "bg-sky-500" },
    { label: "Debt (bonds/FD-like)", value: a.debt ?? 0, cls: "bg-rose-500" },
    { label: "Cash / money market", value: a.cash ?? 0, cls: "bg-amber-500" },
    { label: "Other", value: a.other ?? 0, cls: "bg-zinc-400" },
  ];
  const total = parts.reduce((s, p) => s + (p.value || 0), 0);
  const hasDebt = (a.debt ?? 0) + (a.cash ?? 0) >= 5;
  return (
    <div className="space-y-2">
      <div className="flex h-3 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        {parts.map((p) => (
          <div key={p.label} className={p.cls} style={{ width: `${((p.value || 0) / Math.max(total, 0.01)) * 100}%` }} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1 text-[11px] sm:grid-cols-4">
        {parts.map((p) => (
          <div key={p.label} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${p.cls}`} />
            <span className="truncate text-zinc-500">{p.label}</span>
            <span className="ml-auto font-mono">{p.value != null ? `${p.value.toFixed(1)}%` : "—"}</span>
          </div>
        ))}
      </div>
      <p className={`rounded-md px-2 py-1.5 text-xs ring-1 ${hasDebt ? "bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-400" : "bg-sky-500/10 text-sky-600 ring-sky-500/20 dark:text-sky-400"}`}>
        {hasDebt
          ? `Has a debt/cash part: ${((a.debt ?? 0) + (a.cash ?? 0)).toFixed(1)}% in bonds or FD-like instruments.`
          : "Pure equity — effectively no debt or FD component."}
      </p>
    </div>
  );
}

export function FundModal({ scheme, onClose }: { scheme: MfScheme; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const q = useQuery({
    queryKey: ["mfDetail", scheme.code],
    queryFn: () => fetchMfDetail(scheme.code),
    staleTime: 3600_000,
    retry: 1,
  });
  const d = q.data?.data;
  const chg =
    d?.nav != null && d?.nav_prev != null && d.nav_prev > 0
      ? ((d.nav - d.nav_prev) / d.nav_prev) * 100
      : null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 backdrop-blur-sm" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex min-h-full items-start justify-center p-4 sm:items-center">
        <div className="animate-pop w-full max-w-xl rounded-2xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
          <div className="flex items-start justify-between gap-3 border-b border-zinc-200 p-4 dark:border-zinc-800">
            <div className="min-w-0">
              <div className="truncate text-base font-semibold">{d?.name ?? scheme.name}</div>
              <div className="text-xs text-zinc-500">
                {d?.fund_house ?? "—"} · scheme {scheme.code}
              </div>
            </div>
            <button type="button" onClick={onClose} className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800">
              ✕ Close
            </button>
          </div>
          <div className="space-y-4 p-4">
            {q.isLoading && <div className="py-6 text-center text-sm text-zinc-500">loading fund details… (first load fetches NAV + allocation)</div>}
            {q.isError && (
              <div className="rounded-lg bg-rose-500/10 p-3 text-center text-sm text-rose-400">
                could not load details for this scheme
              </div>
            )}
            {d && (
              <>
                <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
                  <span className="text-[11px] uppercase tracking-wide text-zinc-500">NAV</span>
                  <span className="font-mono text-2xl font-bold">₹{inr(d.nav)}</span>
                  {chg != null && (
                    <span className={`font-mono text-sm ${chg >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                      {chg >= 0 ? "+" : ""}{chg.toFixed(2)}% (1d)
                    </span>
                  )}
                  <span className="ml-auto text-xs text-zinc-500">as of {d.nav_date ?? "—"}</span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
                    <div className="text-[11px] uppercase tracking-wide text-zinc-500">Category</div>
                    <div className="text-sm font-medium">{d.category ?? d.alloc?.category ?? "—"}</div>
                  </div>
                  <div className="rounded-lg bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
                    <div className="text-[11px] uppercase tracking-wide text-zinc-500">Fund house</div>
                    <div className="truncate text-sm font-medium">{d.fund_house ?? "—"}</div>
                  </div>
                </div>

                {d.top_holdings && d.top_holdings.length > 0 && (
                  <div>
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
                      What it holds (top {d.top_holdings.length})
                    </div>
                    <div className="space-y-1.5">
                      {d.top_holdings.map((h) => (
                        <div key={h.name} className="flex items-center gap-2 text-xs">
                          <span className="w-36 truncate font-medium" title={h.name}>{h.name}</span>
                          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                            <div
                              className={`h-full rounded-full ${/gsec|tbill|repo|treps|commercial paper|cd |ccb/i.test(h.name) ? "bg-rose-500" : "bg-sky-500"}`}
                              style={{ width: `${Math.min(100, (h.pct / 10) * 100)}%` }}
                            />
                          </div>
                          <span className="w-12 text-right font-mono text-zinc-400">{h.pct.toFixed(2)}%</span>
                        </div>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[10px] text-zinc-500">
                      Stocks in blue, debt/money-market instruments (G-Secs, T-Bills, repos) in red.
                      As of the fund's latest monthly portfolio disclosure.
                    </p>
                  </div>
                )}

                {(!d.top_holdings || d.top_holdings.length === 0) && (
                  <p className="rounded-md bg-zinc-50 px-3 py-2 text-xs text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
                    Holdings list unavailable for this scheme variant — the asset mix below still shows
                    its equity vs debt vs cash split.
                  </p>
                )}

                {d.alloc ? (
                  <div>
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
                      Asset mix (what your money is actually in)
                    </div>
                    <AllocBar a={d.alloc} />
                  </div>
                ) : (
                  <div className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
                    Allocation breakdown unavailable right now — category: {d.category ?? "—"}
                  </div>
                )}

                <p className="text-[10px] leading-relaxed text-zinc-500">
                  NAV from mfapi.in; asset mix from moneycontrol; top holdings from 5paisa. Cached
                  for a day (portfolios are disclosed monthly, so daily fetching adds nothing).
                </p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function MfPage() {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<MfScheme | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(search.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [search]);

  const q = useQuery({
    queryKey: ["mfList", debounced, page],
    queryFn: () => fetchMfList(debounced || null, page),
    placeholderData: (prev) => prev,
  });
  const d = q.data?.data;
  const items = d?.items ?? [];

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
            All Mutual Funds
          </h2>
          <span className="tnum text-xs text-zinc-500">
            {d ? `${d.total.toLocaleString("en-IN")} schemes · 50 per page` : "loading master…"}
          </span>
        </div>
        <p className="mb-3 text-xs text-zinc-600">
          Search every scheme in India (38,000+) by name — click any fund for its NAV and asset mix
          (equity / debt / cash). Data refreshes once a day.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search schemes, e.g. parag parikh, hdfc liquid…"
            className={`${inputCls} sm:max-w-md`}
          />
          {d && (
            <div className="ml-auto flex items-center gap-2 text-xs">
              <button
                type="button"
                disabled={d.page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Prev
              </button>
              <span className="font-mono text-zinc-500">
                page {d.page} / {d.pages.toLocaleString("en-IN")}
              </span>
              <button
                type="button"
                disabled={d.page >= d.pages}
                onClick={() => setPage((p) => p + 1)}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:hover:bg-zinc-800"
              >
                Next
              </button>
            </div>
          )}
        </div>

        <div className="nice-scroll mt-3 max-h-[560px] overflow-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="tnum w-full text-left text-sm">
            <thead className="sticky top-0 bg-white dark:bg-zinc-900">
              <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
                <th className="py-2 pl-3 pr-4 font-medium">Scheme</th>
                <th className="py-2 pr-3 text-right font-medium">Code</th>
              </tr>
            </thead>
            <tbody>
              {q.isLoading && (
                <>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                      <td className="py-2 pl-3 pr-4"><div className="h-4 rounded bg-zinc-200/70 dark:bg-zinc-800/70" /></td>
                      <td className="py-2 pr-3"><div className="ml-auto h-4 w-14 rounded bg-zinc-200/70 dark:bg-zinc-800/70" /></td>
                    </tr>
                  ))}
                </>
              )}
              {!q.isLoading && items.length === 0 && (
                <tr><td colSpan={2} className="px-4 py-8 text-center text-sm text-zinc-500">No schemes matched — try fewer words, e.g. “parag parikh” instead of the full name.</td></tr>
              )}
              {items.map((s) => (
                <tr
                  key={s.code}
                  onClick={() => setSelected(s)}
                  title="Click for NAV + asset mix"
                  className="cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30"
                >
                  <td className="py-2 pl-3 pr-4">
                    <div className="truncate font-medium" title={s.name}>{s.name}</div>
                  </td>
                  <td className="py-2 pr-3 text-right font-mono text-xs text-zinc-400">{s.code}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {selected && <FundModal scheme={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
