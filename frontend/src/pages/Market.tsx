import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchIndices,
  fetchLosers,
  fetchGainers,
  fetchMarketStatus,
  fetchIndexStocks,
  fetchPaperAccount,
  fetchStockNews,
  fetchStockOutlook,
  fetchStockQuote,
  fetchSignals,
  fetchFiidii,
  fetchAnnouncements,
  placePaperOrder,
  type IndexStockRow,
  type MoverRow,
} from "../api";
import { CandleChart } from "../components/CandleChart";
import { Skeleton, TableSkeleton } from "../components/ui";

function PaperBuyModal({
  symbol,
  name,
  ltp,
  plan,
  onClose,
}: {
  symbol: string;
  name?: string;
  ltp?: number | null;
  plan?: { entry?: number; stop?: number | null; target_1?: number | null; target_2?: number | null } | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [qty, setQty] = useState("1");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const parsed = parseFloat(qty);
  const cost = Number.isFinite(parsed) && parsed > 0 && ltp ? parsed * ltp : null;
  const acctQ = useQuery({ queryKey: ["paper", "account"], queryFn: fetchPaperAccount, staleTime: 60_000 });
  const equity = acctQ.data?.data.equity ?? null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const mut = useMutation({
    mutationFn: placePaperOrder,
    onSuccess: (res) => {
      const o = res.data.order;
      setMsg({
        ok: true,
        text: `Bought ${o.quantity % 1 === 0 ? o.quantity : o.quantity.toFixed(2)} ${o.symbol} @ ₹${o.price.toLocaleString("en-IN")} — see Portfolio → Paper Trading`,
      });
      qc.invalidateQueries({ queryKey: ["paper"] });
    },
    onError: (e: Error) => setMsg({ ok: false, text: e.message.replace(/^\w+: \d+: /, "") }),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="animate-pop w-full max-w-sm rounded-2xl border border-violet-300 bg-white p-4 shadow-xl dark:border-violet-500/40 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-600 ring-1 ring-violet-500/30 dark:text-violet-400">
              Paper
            </span>
            <span className="text-sm font-semibold">{name ?? symbol}</span>
          </div>
          <button type="button" onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
            ✕
          </button>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          Simulated market order · fills at live price{ltp != null ? ` ₹${ltp.toLocaleString("en-IN")}` : ""}
        </p>
        {plan && plan.stop != null && (
          <div className="mb-3 grid grid-cols-3 gap-1.5 rounded-lg bg-violet-500/5 p-2 text-center ring-1 ring-violet-500/20">
            <div>
              <div className="text-[10px] uppercase text-zinc-500">Stop</div>
              <div className="font-mono text-xs font-semibold text-rose-500">{plan.stop.toLocaleString("en-IN")}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-zinc-500">Target 1</div>
              <div className="font-mono text-xs font-semibold text-emerald-500">{plan.target_1?.toLocaleString("en-IN") ?? "—"}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-zinc-500">Target 2</div>
              <div className="font-mono text-xs font-semibold text-emerald-500">{plan.target_2?.toLocaleString("en-IN") ?? "—"}</div>
            </div>
            <p className="col-span-3 text-[10px] text-zinc-500">From the outlook trade plan — place these levels with your broker too if you mirror this for real.</p>
          </div>
        )}
        {plan && plan.stop != null && ltp != null && (
          <div className="mb-2 flex items-center justify-between text-[11px]">
            <span className="text-zinc-500">Risk sizing:</span>
            <div className="flex gap-1">
              {[1000, 2500, 5000].map((b) => {
                const rps = Math.abs(ltp - (plan.stop ?? ltp));
                const calcQ = rps > 0 ? Math.max(1, Math.floor(b / rps)) : 1;
                return (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setQty(String(calcQ))}
                    className="rounded bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-violet-600 hover:bg-violet-500/20 dark:text-violet-400"
                    title={`Risk ₹${b.toLocaleString("en-IN")} → ${calcQ} shares`}
                  >
                    ₹{b / 1000}k
                  </button>
                );
              })}
              {equity != null &&
                [0.5, 1].map((pct) => {
                  const rps = Math.abs(ltp - (plan.stop ?? ltp));
                  const calcQ = rps > 0 ? Math.max(1, Math.floor(((equity * pct) / 100 / rps) * 100) / 100) : 1;
                  return (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => setQty(String(Math.floor(calcQ) || 1))}
                      className="rounded bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-emerald-600 hover:bg-emerald-500/20 dark:text-emerald-400"
                      title={`${pct}% of paper equity (₹${Math.round(equity).toLocaleString("en-IN")}) → ${Math.floor(calcQ) || 1} shares`}
                    >
                      {pct}%
                    </button>
                  );
                })}
            </div>
          </div>
        )}
        <label className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500">Quantity</label>
        <input
          autoFocus
          value={qty}
          onChange={(e) => setQty(e.target.value.replace(/[^\d.]/g, ""))}
          placeholder="Quantity"
          inputMode="decimal"
          className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-violet-500 dark:border-zinc-700 dark:bg-zinc-950/70"
        />
        {cost != null && (
          <div className="mt-2 flex justify-between text-xs text-zinc-500">
            <span>Estimated cost</span>
            <span className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">₹{cost.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
          </div>
        )}
        {msg && (
          <p className={`mt-2 text-xs ${msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
            {msg.text}
          </p>
        )}
        <button
          type="button"
          disabled={mut.isPending}
          onClick={() => {
            const q = parseFloat(qty);
            if (!Number.isFinite(q) || q <= 0) return setMsg({ ok: false, text: "Enter a valid quantity" });
            mut.mutate({ side: "BUY", symbol: symbol.toUpperCase(), name, quantity: q });
          }}
          className="mt-3 w-full rounded-lg bg-violet-600 py-2 text-sm font-semibold text-white transition-colors hover:bg-violet-500 disabled:opacity-50"
        >
          {mut.isPending ? "Placing…" : "Buy (paper)"}
        </button>
      </div>
    </div>
  );
}

const HEADLINE = [
  "NIFTY 50",
  "NIFTY NEXT 50",
  "NIFTY BANK",
  "NIFTY IT",
  "NIFTY FINANCIAL SERVICES",
  "NIFTY MIDCAP 100",
  "NIFTY SMALLCAP 100",
  "INDIA VIX",
];

function Card({
  title,
  hint,
  meta,
  children,
}: {
  title: string;
  hint?: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="animate-fade-up rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60 dark:shadow-[0_8px_32px_-16px_rgb(0_0_0/0.6)]">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
          {title}
        </h2>
        {meta && <span className="tnum text-xs text-zinc-500">{meta}</span>}
      </div>
      {hint && <p className="mb-3 max-w-2xl text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{hint}</p>}
      {!hint && <div className="mb-3" />}
      {children}
    </section>
  );
}

function RangeBar({
  label,
  low,
  high,
  value,
}: {
  label: string;
  low?: number | null;
  high?: number | null;
  value?: number | null;
}) {
  const valid =
    low != null && high != null && Number.isFinite(low) && Number.isFinite(high) && high > low;
  const pct = valid
    ? Math.min(100, Math.max(0, (((value ?? low) - low) / (high - low)) * 100))
    : 0;
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1 flex items-baseline justify-between text-[11px] text-zinc-500">
        <span>{label}</span>
        <span className="font-mono">
          {low?.toLocaleString("en-IN", { maximumFractionDigits: 2 }) ?? "—"} ·{" "}
          {high?.toLocaleString("en-IN", { maximumFractionDigits: 2 }) ?? "—"}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-zinc-200 dark:bg-zinc-800">
        {valid && value != null && (
          <div
            className="absolute top-1/2 h-3.5 w-1.5 -translate-y-1/2 rounded-full bg-emerald-500 shadow"
            style={{ left: `calc(${pct}% - 3px)` }}
          />
        )}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-zinc-500">
        <span>L</span>
        <span>H</span>
      </div>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="font-mono text-sm">{value ?? "—"}</div>
    </div>
  );
}

function fmt(n?: number | null, frac = 2) {
  return n != null && Number.isFinite(n)
    ? n.toLocaleString("en-IN", { maximumFractionDigits: frac })
    : "—";
}

function OutlookSection({ symbol }: { symbol: string }) {
  const [expanded, setExpanded] = useState(false);
  const [takeTrade, setTakeTrade] = useState(false);
  const q = useQuery({
    queryKey: ["stockOutlook", symbol],
    queryFn: () => fetchStockOutlook(symbol),
    staleTime: 300_000,
    retry: 1,
  });
  const quoteQ = useQuery({
    queryKey: ["stockQuote", symbol],
    queryFn: () => fetchStockQuote(symbol),
    staleTime: 60_000,
  });
  const d = q.data?.data;
  if (q.isLoading)
    return (
      <div className="rounded-lg bg-zinc-50 py-3 text-center text-xs text-zinc-500 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
        building outlook — the model trains on first load, takes a few seconds…
      </div>
    );
  // silent degrade: the modal still shows quote + news without an outlook
  if (q.isError || !d) return null;

  const v = d.verdict;
  const tone =
    v.color === "bullish"
      ? { text: "text-emerald-400", bg: "bg-emerald-500", ring: "ring-emerald-500/30 bg-emerald-500/10 text-emerald-500" }
      : v.color === "bearish"
        ? { text: "text-rose-400", bg: "bg-rose-500", ring: "ring-rose-500/30 bg-rose-500/10 text-rose-400" }
        : { text: "text-amber-400", bg: "bg-amber-500", ring: "ring-amber-500/30 bg-amber-500/10 text-amber-500" };
  const markerPct = ((v.score + 100) / 200) * 100;
  const topFactors = [...(d.rule.factors ?? [])]
    .filter((f) => f.contribution !== 0)
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 6);
  const sent = d.sentiment;
  const m = d.model;
  const g = d.global_model;
  const flagCount = sent?.red_flags.length ?? 0;
  const tp = d.trade_plan;
  const sigTone =
    tp?.signal === "BUY"
      ? "bg-emerald-500/10 text-emerald-500 ring-emerald-500/30"
      : tp?.signal === "SELL"
        ? "bg-rose-500/10 text-rose-400 ring-rose-500/30"
        : "bg-amber-500/10 text-amber-500 ring-amber-500/30";

  return (
    <div className="space-y-3 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
          Outlook · next {d.horizon_days} days
        </h3>
        <div className="flex items-center gap-2">
          {flagCount > 0 && !expanded && (
            <span className="rounded-full bg-rose-500/10 px-2.5 py-1 text-[11px] font-semibold text-rose-400 ring-1 ring-rose-500/20">
              {flagCount} red flag{flagCount > 1 ? "s" : ""}
            </span>
          )}
          <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase ring-1 ${tone.ring}`}>
            {v.label} {v.score >= 0 ? "+" : ""}{v.score.toFixed(0)}
          </span>
          {tp && (
            <span className={`rounded-full px-3 py-1 text-xs font-bold uppercase ring-1 ${sigTone}`} title="Trade signal derived from the outlook score">
              {tp.no_trade ? "No trade" : tp.signal}
            </span>
          )}
          {tp && !tp.no_trade && tp.signal === "BUY" && (
            <button
              type="button"
              onClick={() => setTakeTrade(true)}
              className="rounded-lg bg-violet-600 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-violet-500"
              title={`Paper-buy with the plan: stop ₹${tp.stop?.toLocaleString("en-IN") ?? "—"}, target ₹${tp.target_1?.toLocaleString("en-IN") ?? "—"}`}
            >
              Take this trade
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((x) => !x)}
            className="rounded-lg border border-zinc-300 px-2.5 py-1 text-[11px] font-medium text-zinc-600 hover:border-emerald-500/50 hover:text-emerald-500 dark:border-zinc-700 dark:text-zinc-400"
          >
            {expanded ? "Hide details" : "Show details"}
          </button>
        </div>
      </div>

      {takeTrade && tp && (
        <PaperBuyModal
          symbol={symbol}
          ltp={quoteQ.data?.data.last_price ?? null}
          plan={{ stop: tp.stop, target_1: tp.target_1, target_2: tp.target_2, entry: tp.entry }}
          onClose={() => setTakeTrade(false)}
        />
      )}

      <div>
        <div className="relative h-2.5 rounded-full bg-gradient-to-r from-rose-500/40 via-zinc-300 to-emerald-500/40 dark:via-zinc-700">
          <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-400/50" />
          <div
            className={`absolute top-1/2 h-4 w-2 -translate-y-1/2 rounded-full ${tone.bg} shadow`}
            style={{ left: `calc(${markerPct}% - 4px)` }}
          />
        </div>
        <div className="mt-0.5 flex justify-between text-[10px] text-zinc-500">
          <span>bearish -100</span>
          <span>neutral</span>
          <span>bullish +100</span>
        </div>
      </div>

      {expanded && (
        <div className="space-y-3">
          {tp && tp.no_trade && (
            <div className="rounded-md bg-white p-3 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
                  Trade plan · no position
                </span>
                <span className="rounded-full bg-zinc-500/10 px-2.5 py-0.5 text-[11px] font-bold uppercase text-zinc-500 ring-1 ring-zinc-500/30">
                  No trade
                </span>
              </div>
              <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">{tp.reason}</p>
              <p className="mt-1.5 text-[10px] leading-relaxed text-zinc-500">{tp.note}</p>
            </div>
          )}

          {tp && !tp.no_trade && (
            <div className="rounded-md bg-white p-3 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
                  Trade plan {tp.signal !== "HOLD" ? `· ${tp.direction}` : "· sit out"}
                </span>
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase ring-1 ${sigTone}`}>
                  {tp.signal}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <div className="rounded bg-zinc-50 px-2 py-1.5 dark:bg-zinc-950/60">
                  <div className="text-[10px] uppercase text-zinc-500">Entry</div>
                  <div className="font-mono text-sm font-semibold">₹{tp.entry.toLocaleString("en-IN")}</div>
                </div>
                <div className="rounded bg-rose-500/5 px-2 py-1.5 ring-1 ring-rose-500/20">
                  <div className="text-[10px] uppercase text-rose-400">Stop-loss</div>
                  <div className="font-mono text-sm font-semibold text-rose-400">
                    {tp.stop != null ? `₹${tp.stop.toLocaleString("en-IN")}` : "—"}
                    {tp.stop_pct != null && <span className="ml-1 text-[10px] opacity-70">-{tp.stop_pct.toFixed(1)}%</span>}
                  </div>
                  {tp.stop_days != null && <div className="text-[10px] text-zinc-500">typically hit in ~{tp.stop_days}d</div>}
                </div>
                <div className="rounded bg-emerald-500/5 px-2 py-1.5 ring-1 ring-emerald-500/20">
                  <div className="text-[10px] uppercase text-emerald-400">Target 1</div>
                  <div className="font-mono text-sm font-semibold text-emerald-400">
                    {tp.target_1 != null ? `₹${tp.target_1.toLocaleString("en-IN")}` : "—"}
                    {tp.target_1_pct != null && <span className="ml-1 text-[10px] opacity-70">+{tp.target_1_pct.toFixed(1)}%</span>}
                  </div>
                  {tp.target_days != null && <div className="text-[10px] text-zinc-500">typically ~{tp.target_days}d</div>}
                </div>
                <div className="rounded bg-emerald-500/5 px-2 py-1.5 ring-1 ring-emerald-500/20">
                  <div className="text-[10px] uppercase text-emerald-400">Target 2</div>
                  <div className="font-mono text-sm font-semibold text-emerald-400">
                    {tp.target_2 != null ? `₹${tp.target_2.toLocaleString("en-IN")}` : "—"}
                    {tp.target_2_pct != null && <span className="ml-1 text-[10px] opacity-70">+{tp.target_2_pct.toFixed(1)}%</span>}
                  </div>
                  <div className="text-[10px] text-zinc-500">reward:risk {tp.reward_risk}:1 and 2.5:1</div>
                </div>
              </div>
              <p className="mt-2 text-[10px] leading-relaxed text-zinc-500">{tp.method}</p>
              <p className="mt-1 text-[10px] leading-relaxed text-amber-500">{tp.note}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {(d.rule.categories ?? []).map((c) => (
              <div key={c.name} className="rounded-md bg-white px-2 py-1.5 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
                <div className="truncate text-[10px] uppercase tracking-wide text-zinc-500">{c.name}</div>
                <div className={`font-mono text-sm font-semibold ${c.score > 5 ? "text-emerald-400" : c.score < -5 ? "text-rose-400" : "text-zinc-400"}`}>
                  {c.score > 0 ? "+" : ""}{c.score.toFixed(0)}
                </div>
              </div>
            ))}
          </div>

          {topFactors.length > 0 && (
            <ul className="space-y-1">
              {topFactors.map((f, i) => (
                <li key={i} className="flex items-center gap-2 text-xs">
                  <span className={`w-12 shrink-0 text-right font-mono ${f.contribution > 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {f.contribution > 0 ? "+" : ""}{f.contribution.toFixed(0)}
                  </span>
                  <span className="truncate font-medium">{f.label}</span>
                  <span className="truncate text-zinc-500" title={f.detail}>{f.detail}</span>
                </li>
              ))}
            </ul>
          )}

          {m && (
            <p className="text-[11px] leading-relaxed text-zinc-500">
              <span className="font-semibold text-zinc-600 dark:text-zinc-400">This stock's model: </span>
              {m.prob_up != null ? `${(m.prob_up * 100).toFixed(0)}% up-probability over ${m.horizon_days} days. ` : ""}
              {m.spread_bps != null ? `Its picks beat its pans by ${m.spread_bps > 0 ? "+" : ""}${m.spread_bps} bps per 10 days in validation. ` : ""}
              {m.long_precision != null ? `Strong-BUY calls were right ${(m.long_precision * 100).toFixed(0)}% of the time (n=${m.long_n ?? "—"}). ` : ""}
              {m.note}
            </p>
          )}

          {g && (
            <p className="text-[11px] leading-relaxed text-zinc-500">
              <span className="font-semibold text-zinc-600 dark:text-zinc-400">Global model: </span>
              {g.status === "ready" && g.n_stocks != null
                ? `trained on ${g.n_stocks} NIFTY stocks (${g.n_samples?.toLocaleString("en-IN") ?? "—"} samples) · walk-forward accuracy ${g.walk_forward_accuracy != null ? `${(g.walk_forward_accuracy * 100).toFixed(0)}%` : "—"}${g.has_edge ? " — contributing to the verdict" : " — below the trust bar, technical score only"}`
                : g.status === "failed"
                  ? `training failed — ${g.error ?? "unknown error"}`
                  : "training in the background (reads ~100 stocks' 5-year history); verdict below uses the transparent technical score"}
            </p>
          )}

          {d.model_note && (
            <p className="text-[11px] font-medium leading-relaxed text-zinc-600 dark:text-zinc-400">{d.model_note}</p>
          )}

          {sent && sent.red_flags.length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-rose-400">
                Red flags from recent news ({sent.negative_count.toFixed(0)})
              </div>
              <ul className="space-y-1">
                {sent.red_flags.map((r, i) => (
                  <li key={i} className="rounded-md bg-rose-500/5 px-2 py-1.5 text-xs ring-1 ring-rose-500/20">
                    <a href={r.link} target="_blank" rel="noopener noreferrer" className="font-medium hover:text-rose-400 hover:underline">
                      {r.title}
                    </a>
                    <span className="ml-2 rounded bg-rose-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-rose-400">{r.why}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {sent && sent.positives.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-emerald-400">
                Positive headlines ({sent.positives.length})
              </summary>
              <ul className="mt-1 space-y-1">
                {sent.positives.map((r, i) => (
                  <li key={i}>
                    <a href={r.link} target="_blank" rel="noopener noreferrer" className="hover:text-emerald-400 hover:underline">
                      {r.title}
                    </a>
                    <span className="ml-2 text-[10px] text-zinc-500">{r.why}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <p className="text-[10px] leading-relaxed text-zinc-500">{d.disclaimer}</p>
        </div>
      )}
    </div>
  );
}

function AnnouncementsSection({ symbol }: { symbol: string }) {
  const q = useQuery({
    queryKey: ["announcements", symbol],
    queryFn: () => fetchAnnouncements(symbol),
    staleTime: 300_000,
    retry: 1,
  });
  const rows = q.data?.data ?? [];
  if (q.isError || rows.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
        Corporate announcements
      </h3>
      <ul className="space-y-1">
        {rows.slice(0, 6).map((a, i) => (
          <li key={i} className="rounded-lg bg-zinc-50 px-3 py-1.5 text-xs ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
            <div className="font-medium text-zinc-700 dark:text-zinc-200">{a.headline}</div>
            <div className="mt-0.5 text-[11px] text-zinc-500">
              {a.date ?? "—"}
              {a.file && (
                <>
                  {" · "}
                  <a href={a.file} target="_blank" rel="noopener noreferrer" className="text-emerald-600 hover:underline dark:text-emerald-400">
                    filing (PDF)
                  </a>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StockDetailModal({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  const [buyOpen, setBuyOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const quoteQ = useQuery({
    queryKey: ["stockQuote", symbol],
    queryFn: () => fetchStockQuote(symbol),
    staleTime: 60_000,
  });
  const newsQ = useQuery({
    queryKey: ["stockNews", symbol],
    queryFn: () => fetchStockNews(symbol),
    staleTime: 300_000,
    retry: 1,
  });
  const outlookQ = useQuery({
    queryKey: ["stockOutlook", symbol],
    queryFn: () => fetchStockOutlook(symbol),
    staleTime: 300_000,
    retry: 1,
  });

  const q = quoteQ.data?.data;
  const up = (q?.change ?? 0) >= 0;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 backdrop-blur-sm">
      <div
        className="flex min-h-full items-start justify-center p-4 sm:items-center"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
      <div className="animate-pop w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-start justify-between gap-3 border-b border-zinc-200 p-4 dark:border-zinc-800">
          <div className="min-w-0">
            <div className="truncate text-base font-semibold">
              {q?.name ?? symbol}
            </div>
            <div className="text-xs text-zinc-500">
              NSE: {symbol}
              {q?.series ? ` · ${q.series}` : ""} · updated {q?.last_updated ?? "—"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-zinc-300 px-2.5 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
          >
            ✕ Close
          </button>
        </div>

        <div className="space-y-4 p-4">
          {quoteQ.isLoading && (
            <div className="py-6 text-center text-sm text-zinc-500">loading quote…</div>
          )}
          {quoteQ.isError && (
            <div className="rounded-lg bg-rose-500/10 p-3 text-center text-sm text-rose-400">
              could not load quote for {symbol}
            </div>
          )}
          {q && (
            <>
              <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
                <span className="font-mono text-3xl font-bold tracking-tight">
                  ₹{fmt(q.last_price)}
                </span>
                <span className={`font-mono text-base ${up ? "text-emerald-400" : "text-rose-400"}`}>
                  {up ? "▲" : "▼"} {fmt(q.change)} ({q.p_change != null ? `${up ? "+" : ""}${q.p_change.toFixed(2)}%` : "—"})
                </span>
                <button
                  type="button"
                  onClick={() => setBuyOpen(true)}
                  className="ml-auto rounded-lg bg-violet-600 px-3.5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-violet-500"
                >
                  Buy · paper
                </button>
              </div>

              <div className="flex flex-wrap gap-4">
                <RangeBar label="Day range" low={q.day_low} high={q.day_high} value={q.last_price} />
                <RangeBar label="52-week range" low={q.week_low} high={q.week_high} value={q.last_price} />
              </div>

              <CandleChart symbol={symbol} tradePlan={outlookQ.data?.data.trade_plan} />

              <OutlookSection symbol={symbol} />

              <AnnouncementsSection symbol={symbol} />

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <StatCell label="Open" value={fmt(q.open)} />
                <StatCell label="Prev Close" value={fmt(q.prev_close)} />
                <StatCell label="VWAP" value={fmt(q.vwap)} />
                <StatCell label="Volume" value={fmt(q.total_traded_volume, 0)} />
                <StatCell label="Day High" value={fmt(q.day_high)} />
                <StatCell label="Day Low" value={fmt(q.day_low)} />
                <StatCell label="52W High" value={fmt(q.week_high)} />
                <StatCell label="52W Low" value={fmt(q.week_low)} />
              </div>
            </>
          )}

          <div>
            <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
              Latest News
            </h3>
            {newsQ.isLoading && (
              <div className="py-3 text-center text-sm text-zinc-500">loading news…</div>
            )}
            {newsQ.isError && (
              <div className="py-3 text-center text-sm text-zinc-500">
                news unavailable right now
              </div>
            )}
            {newsQ.data?.data.items.length === 0 && (
              <div className="py-3 text-center text-sm text-zinc-500">
                no recent news found for {symbol}
              </div>
            )}
            <ul className="space-y-1.5">
              {(newsQ.data?.data.items ?? []).map((n, i) => (
                <li key={i} className="rounded-lg bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800/60">
                  <a
                    href={n.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm font-medium hover:text-emerald-500 hover:underline"
                  >
                    {n.title}
                  </a>
                  <div className="mt-0.5 text-[11px] text-zinc-500">
                    {[n.source, n.published].filter(Boolean).join(" · ") || "—"}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      </div>
      {buyOpen && (
        <PaperBuyModal symbol={symbol} name={q?.name ?? undefined} ltp={q?.last_price ?? null} onClose={() => setBuyOpen(false)} />
      )}
    </div>
  );
}

function IndexStocksPanel({
  index,
  onClose,
  onSelectStock,
}: {
  index: string;
  onClose: () => void;
  onSelectStock: (symbol: string) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["indexStocks", index],
    queryFn: () => fetchIndexStocks(index),
  });
  const [sortKey, setSortKey] = useState<keyof IndexStockRow>("symbol");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [filter, setFilter] = useState("");
  const [buySymbol, setBuySymbol] = useState<{ symbol: string; ltp: number | null } | null>(null);

  const stocks = useMemo(() => {
    const raw = data?.data.data ?? [];
    const filtered = raw.filter((r) => r.symbol !== index);
    const list = filtered.length ? filtered : raw.slice(1);
    const q = filter.trim().toLowerCase();
    const searched = q ? list.filter((r) => r.symbol.toLowerCase().includes(q)) : list;
    return [...searched].sort((a, b) => {
      const av = (a as unknown as Record<string, unknown>)[sortKey as string];
      const bv = (b as unknown as Record<string, unknown>)[sortKey as string];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string") {
        return sortDir === "asc" ? av.localeCompare(bv as string) : (bv as string).localeCompare(av as string);
      }
      return sortDir === "asc" ? (av as number) - (bv as number) : (bv as number) - (av as number);
    });
  }, [data, sortKey, sortDir, filter, index]);

  const toggleSort = (key: keyof IndexStockRow) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "symbol" ? "asc" : "desc");
    }
  };

  const SortHead = ({ label, k }: { label: string; k: keyof IndexStockRow }) => (
    <th
      onClick={() => toggleSort(k)}
      className="cursor-pointer select-none py-2 pr-4 text-right font-medium hover:text-zinc-200"
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortKey === k && <span className="text-[10px]">{sortDir === "asc" ? "▲" : "▼"}</span>}
      </span>
    </th>
  );

  if (isLoading) return <div className="space-y-2" aria-label="Loading constituents"><Skeleton className="h-9 w-48" /><TableSkeleton rows={8} cols={5} /></div>;
  if (error) return <div className="py-6 text-center text-sm text-rose-400">failed to load {index}</div>;
  if (!data) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by symbol…"
          className="w-40 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm outline-none placeholder:text-zinc-400 focus:border-emerald-500 dark:border-zinc-800 dark:bg-zinc-950/70 dark:placeholder:text-zinc-600 dark:focus:border-emerald-500/50"
        />
        <span className="text-xs text-zinc-600">{stocks.length} stocks</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-lg border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-100 dark:border-zinc-800 dark:hover:bg-zinc-800"
        >
          ✕ Close
        </button>
      </div>
      <div className="max-h-[420px] overflow-auto rounded-xl border border-zinc-200 nice-scroll dark:border-zinc-800">
        <table className="tnum w-full text-left text-sm">
          <thead className="sticky top-0 bg-white dark:bg-zinc-900">
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <th
                onClick={() => toggleSort("symbol")}
                className="cursor-pointer select-none py-2 pl-3 pr-4 font-medium hover:text-zinc-200"
              >
                Symbol {sortKey === "symbol" && (sortDir === "asc" ? "▲" : "▼")}
              </th>
              <SortHead label="LTP" k="lastPrice" />
              <SortHead label="Change %" k="pChange" />
              <SortHead label="Open" k="open" />
              <SortHead label="High" k="dayHigh" />
              <SortHead label="Low" k="dayLow" />
              <th className="py-2 pr-3 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {stocks.map((r) => (
              <tr
                key={r.symbol}
                onClick={() => onSelectStock(r.symbol)}
                title="Click for quote details and news"
                className="cursor-pointer border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30"
              >
                <td className="py-2 pl-3 pr-4 font-medium">{r.symbol}</td>
                <td className="py-2 pr-4 text-right font-mono">{r.lastPrice?.toLocaleString("en-IN", { maximumFractionDigits: 2 }) ?? "—"}</td>
                <td className={`py-2 pr-4 text-right font-mono ${ (r.pChange ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                  {r.pChange != null ? `${r.pChange >= 0 ? "+" : ""}${r.pChange.toFixed(2)}%` : "—"}
                </td>
                <td className="py-2 pr-4 text-right font-mono text-zinc-400">{r.open?.toLocaleString("en-IN") ?? "—"}</td>
                <td className="py-2 pr-4 text-right font-mono text-zinc-400">{r.dayHigh?.toLocaleString("en-IN") ?? "—"}</td>
                <td className="py-2 pr-4 text-right font-mono text-zinc-400">{r.dayLow?.toLocaleString("en-IN") ?? "—"}</td>
                <td className="py-2 pr-3 text-right">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setBuySymbol({ symbol: r.symbol, ltp: r.lastPrice ?? null });
                    }}
                    className="rounded-md border border-violet-400/50 px-2 py-0.5 text-[11px] font-medium text-violet-600 hover:bg-violet-500/10 dark:border-violet-500/40 dark:text-violet-400"
                    title="Quick paper buy"
                  >
                    Buy
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-zinc-600">Click a row for details · Buy places a paper trade · headers sort. Updates every minute while open.</p>
      {buySymbol && (
        <PaperBuyModal symbol={buySymbol.symbol} ltp={buySymbol.ltp} onClose={() => setBuySymbol(null)} />
      )}
    </div>
  );
}

function MoversTable({
  rows,
  onSelectStock,
}: {
  rows: MoverRow[];
  onSelectStock: (symbol: string) => void;
}) {
  const list = (rows ?? []).slice(0, 10);
  if (list.length === 0)
    return <div className="py-6 text-center text-sm text-zinc-500">No data yet.</div>;
  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
          <th className="py-2 pr-2 font-medium">#</th>
          <th className="py-2 pr-4 font-medium">Stock</th>
          <th className="py-2 pr-4 text-right font-medium">LTP</th>
          <th className="py-2 pr-4 text-right font-medium">Chg</th>
          <th className="py-2 pr-4 text-right font-medium">High</th>
          <th className="py-2 text-right font-medium">Low</th>
        </tr>
      </thead>
      <tbody className="tnum">
        {list.map((r, i) => {
          const raw = r as unknown as Record<string, unknown>;
          const meta = (r.meta as Record<string, unknown> | undefined) ?? {};
          const ltp = Number(raw.ltp ?? raw.last_price ?? raw.lastPrice ?? meta.last_price ?? 0);
          const changePct = Number(
            raw.perChange ?? raw.pChange ?? raw.percent_change ?? meta.percent_change ?? NaN,
          );
          const change = Number(raw.net_price ?? raw.change ?? meta.change ?? NaN);
          const high = Number(raw.high_price ?? raw.high ?? meta.high_price ?? NaN);
          const low = Number(raw.low_price ?? raw.low ?? meta.low_price ?? NaN);
          const symbol = String(r.symbol ?? r.identifier ?? "");
          return (
            <tr
              key={symbol || i}
              onClick={() => symbol && onSelectStock(symbol)}
              title="Click for quote details and news"
              className={`border-b border-zinc-100 last:border-0 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-800/30 ${symbol ? "cursor-pointer" : ""}`}
            >
              <td className="py-2 pr-2 font-mono text-xs text-zinc-500">{i + 1}</td>
              <td className="py-2 pr-4 font-medium">{symbol}</td>
              <td className="py-2 pr-4 text-right font-mono">
                {ltp ? ltp.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "—"}
              </td>
              <td className={`py-2 pr-4 text-right font-mono ${changePct >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                <span>
                  {Number.isFinite(changePct) ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%` : "—"}
                </span>
                <span className="ml-2 text-[11px] opacity-70">
                  ({Number.isFinite(change) ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}` : "—"})
                </span>
              </td>
              <td className="py-2 pr-4 text-right font-mono text-zinc-400">
                {Number.isFinite(high) ? high.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "—"}
              </td>
              <td className="py-2 text-right font-mono text-zinc-400">
                {Number.isFinite(low) ? low.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function MarketTickerTape({
  indices,
  fiiNet,
}: {
  indices: import("../api").IndexRow[];
  fiiNet?: string | null;
}) {
  const watch = ["NIFTY 50", "NIFTY BANK", "NIFTY IT", "INDIA VIX"];
  const list = watch
    .map((name) => indices.find((idx) => idx.index === name))
    .filter((x): x is import("../api").IndexRow => x != null);

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-xs shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
      <span className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-zinc-400">
        <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
        Market Pulse
      </span>
      <span className="text-zinc-300 dark:text-zinc-700">·</span>
      {list.map((idx) => {
        const up = (idx.percentChange ?? 0) >= 0;
        return (
          <div key={idx.index} className="tnum flex items-center gap-1.5 font-mono">
            <span className="font-medium text-zinc-600 dark:text-zinc-400">{idx.index.replace("NIFTY ", "")}:</span>
            <span className="font-semibold">{idx.last?.toLocaleString("en-IN")}</span>
            <span className={`text-[11px] ${up ? "text-emerald-500" : "text-rose-400"}`}>
              {up ? "▲" : "▼"}{Math.abs(idx.percentChange).toFixed(1)}%
            </span>
            <span className="text-zinc-300 dark:text-zinc-700">·</span>
          </div>
        );
      })}
      {fiiNet && (
        <div className="ml-auto flex items-center gap-1 text-[11px]">
          <span className="text-zinc-500">FII Net:</span>
          <span className={`font-mono font-semibold ${parseFloat(fiiNet) >= 0 ? "text-emerald-500" : "text-rose-400"}`}>
            {parseFloat(fiiNet) >= 0 ? "+" : "-"}₹{Math.abs(parseFloat(fiiNet)).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr
          </span>
        </div>
      )}
    </div>
  );
}

function MarketBreadthMeter({ indices }: { indices: import("../api").IndexRow[] }) {
  const sectoral = indices.filter((r) => r.index.startsWith("NIFTY ") && r.index !== "NIFTY 50");
  if (sectoral.length < 3) return null;
  const advances = sectoral.filter((r) => (r.percentChange ?? 0) >= 0).length;
  const declines = sectoral.length - advances;
  const advPct = Math.round((advances / sectoral.length) * 100);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
          Sector Breadth
        </span>
        <span className="font-mono text-[11px] text-zinc-500">
          <span className="font-bold text-emerald-500">{advances} Advancing</span> ·{" "}
          <span className="font-bold text-rose-400">{declines} Declining</span> ({advPct}% green)
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${advPct}%` }} />
        <div className="h-full bg-rose-500 transition-all duration-500" style={{ width: `${100 - advPct}%` }} />
      </div>
    </div>
  );
}

export function MarketPage() {
  const [selectedIndex, setSelectedIndex] = useState<string | null>(null);
  const [selectedStock, setSelectedStock] = useState<string | null>(null);
  const statusQ = useQuery({ queryKey: ["status"], queryFn: fetchMarketStatus });
  const idxQ = useQuery({ queryKey: ["indices"], queryFn: fetchIndices });
  const gainersQ = useQuery({ queryKey: ["gainers"], queryFn: fetchGainers });
  const losersQ = useQuery({ queryKey: ["losers"], queryFn: fetchLosers });
  const fiidiiQ = useQuery({ queryKey: ["fiidii"], queryFn: fetchFiidii, staleTime: 600_000 });

  const state = statusQ.data?.data.marketState?.[0];
  const allIndices = idxQ.data?.data.data ?? [];
  const rows = allIndices.filter((r) => HEADLINE.includes(r.index));
  const rawGainers = gainersQ.data?.data as unknown as Record<string, { data: MoverRow[] }> | undefined;
  const rawLosers = losersQ.data?.data as unknown as Record<string, { data: MoverRow[] }> | undefined;
  const fiiNet = fiidiiQ.data?.data.rows?.find((r) => r.category.startsWith("FII"))?.netValue;
  const gainRows =
    rawGainers?.NIFTY?.data ??
    rawGainers?.allSec?.data ??
    (() => {
      const entries = Object.entries(rawGainers ?? {}).filter(([k]) => k !== "legends");
      return (entries[0]?.[1] as { data: MoverRow[] } | undefined)?.data ?? [];
    })();
  const loseRows =
    rawLosers?.NIFTY?.data ??
    rawLosers?.allSec?.data ??
    (() => {
      const entries = Object.entries(rawLosers ?? {}).filter(([k]) => k !== "legends");
      return (entries[0]?.[1] as { data: MoverRow[] } | undefined)?.data ?? [];
    })();

  return (
    <div className="space-y-4">
      <MarketTickerTape indices={allIndices} fiiNet={fiiNet} />
      <MarketBreadthMeter indices={allIndices} />
      {state && (
        <Card
          title="Nifty 50"
          hint="Benchmark index of the National Stock Exchange"
          meta={<span>{state.tradeDate}</span>}
        >
          <div className="flex flex-wrap items-end gap-x-4 gap-y-1">
            <span className="font-mono text-4xl font-bold tracking-tight">
              {state.last.toLocaleString("en-IN")}
            </span>
            <span
              className={`font-mono text-lg ${
                state.variation >= 0 ? "text-emerald-400" : "text-rose-400"
              }`}
            >
              {state.variation >= 0 ? "+" : ""}
              {state.variation.toFixed(2)} ({state.percentChange.toFixed(2)}%)
            </span>
          </div>
        </Card>
      )}

      <Card
        title="Sector Indices"
        hint="Click an index to see its constituent stocks, sorted"
        meta={idxQ.data ? <span className="tnum">{rows.length} indices</span> : undefined}
      >
        {idxQ.isLoading || !idxQ.data ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Loading indices">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-[86px]" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {rows.map((r) => {
              const span = r.high - r.low;
              const pos = span > 0 ? Math.min(100, Math.max(0, ((r.last - r.low) / span) * 100)) : 50;
              return (
              <button
                key={r.index}
                type="button"
                onClick={() => setSelectedIndex((prev) => (prev === r.index ? null : r.index))}
                aria-pressed={selectedIndex === r.index}
                title={`${r.index}: day low ${r.low?.toLocaleString("en-IN")} · high ${r.high?.toLocaleString("en-IN")}`}
                className={`lift rounded-xl bg-zinc-50 p-3 text-left ring-1 dark:bg-zinc-950/60 ${selectedIndex === r.index ? "bg-emerald-500/10 ring-emerald-500/60" : "ring-zinc-200 hover:ring-emerald-500/40 dark:ring-zinc-800/60"}`}
              >
                <div className="truncate text-xs font-medium text-zinc-500 dark:text-zinc-400">{r.index}</div>
                <div className="tnum mt-0.5 font-mono text-base font-semibold">
                  {r.last?.toLocaleString("en-IN")}
                </div>
                <div
                  className={`tnum font-mono text-xs ${
                    r.percentChange >= 0 ? "text-emerald-500 dark:text-emerald-400" : "text-rose-500 dark:text-rose-400"
                  }`}
                >
                  {r.percentChange >= 0 ? "▲" : "▼"} {Math.abs(r.percentChange).toFixed(2)}%
                </div>
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" aria-hidden="true">
                  <div className="h-full rounded-full bg-gradient-to-r from-rose-400 via-zinc-400 to-emerald-400" style={{ width: "100%", opacity: 0.35 }} />
                </div>
                <div className="relative -mt-1 h-1" aria-hidden="true">
                  <div
                    className="absolute top-1/2 h-2 w-1 -translate-y-1/2 rounded-full bg-zinc-700 dark:bg-zinc-200"
                    style={{ left: `calc(${pos}% - 2px)` }}
                  />
                </div>
              </button>
              );
            })}
          </div>
        )}
      </Card>

      {selectedIndex && (
        <Card
          title={`${selectedIndex} — Constituents`}
          hint={`${selectedIndex} stocks sorted — click headers to re-sort`}
          meta={
            <button type="button" onClick={() => setSelectedIndex(null)} className="text-xs text-zinc-500 hover:text-zinc-300">
              ✕ Close
            </button>
          }
        >
          <IndexStocksPanel index={selectedIndex} onClose={() => setSelectedIndex(null)} onSelectStock={setSelectedStock} />
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Top Gainers" hint="Top NIFTY gainers today — click a stock for details and news">
          {gainersQ.isLoading ? <TableSkeleton rows={6} cols={4} /> : <MoversTable rows={gainRows} onSelectStock={setSelectedStock} />}
        </Card>
        <Card title="Top Losers" hint="Top NIFTY losers today — click a stock for details and news">
          {losersQ.isLoading ? <TableSkeleton rows={6} cols={4} /> : <MoversTable rows={loseRows} onSelectStock={setSelectedStock} />}
        </Card>
      </div>

      <SectorHeatmap rows={idxQ.data?.data.data ?? []} />
      <div className="grid gap-4 lg:grid-cols-2">
        <FiiDiiCard />
        <SignalTrackerCard onSelectStock={setSelectedStock} />
      </div>

      {selectedStock && (
        <StockDetailModal symbol={selectedStock} onClose={() => setSelectedStock(null)} />
      )}
    </div>
  );
}

const HEAT_SECTORS = [
  "NIFTY IT", "NIFTY BANK", "NIFTY AUTO", "NIFTY FMCG", "NIFTY PHARMA",
  "NIFTY METAL", "NIFTY REALTY", "NIFTY ENERGY", "NIFTY MEDIA",
  "NIFTY PSU BANK", "NIFTY PRIVATE BANK", "NIFTY FINANCIAL SERVICES",
  "NIFTY CONSUMER DURABLES", "NIFTY OIL & GAS", "NIFTY HEALTHCARE",
  "NIFTY MNC", "NIFTY PSE", "NIFTY COMMODITIES",
];

function heatColor(pct: number): string {
  const clamped = Math.max(-3, Math.min(3, pct));
  const alpha = 0.12 + (Math.abs(clamped) / 3) * 0.55;
  return clamped >= 0
    ? `rgba(16, 185, 129, ${alpha.toFixed(2)})`
    : `rgba(244, 63, 94, ${alpha.toFixed(2)})`;
}

function SectorHeatmap({ rows }: { rows: { index: string; percentChange: number }[] }) {
  const tiles = rows
    .filter((r) => HEAT_SECTORS.includes(r.index))
    .sort((a, b) => b.percentChange - a.percentChange);
  if (tiles.length === 0) return null;
  return (
    <Card title="Sector Heat Map" hint="Sectoral indices today — greener is stronger. From the cached all-indices snapshot.">
      <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
        {tiles.map((t) => (
          <div
            key={t.index}
            className="lift rounded-xl p-2 ring-1 ring-zinc-200/60 dark:ring-zinc-800/60"
            style={{ backgroundColor: heatColor(t.percentChange) }}
            title={`${t.index}: ${t.percentChange >= 0 ? "+" : ""}${t.percentChange.toFixed(2)}%`}
          >
            <div className="truncate text-[10px] font-semibold text-zinc-800 dark:text-zinc-100">
              {t.index.replace("NIFTY ", "")}
            </div>
            <div className="font-mono text-xs font-bold text-zinc-900 dark:text-white">
              {t.percentChange >= 0 ? "+" : ""}{t.percentChange.toFixed(2)}%
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function FiiDiiCard() {
  const q = useQuery({ queryKey: ["fiidii"], queryFn: fetchFiidii, staleTime: 600_000 });
  const rows = q.data?.data.rows ?? [];
  if (!q.data) return null;
  const fii = rows.find((r) => r.category.startsWith("FII"));
  const dii = rows.find((r) => r.category.startsWith("DII"));
  const net = (v: string) => {
    const n = parseFloat(v);
    return (
      <span className={`font-mono font-semibold ${(n) >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
        {n >= 0 ? "+" : "-"}₹{Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr
      </span>
    );
  };
  return (
    <Card title="FII / DII Activity" hint={fii?.date ? `Institutional flows in the cash market · ${fii.date}` : "Institutional flows in the cash market"}>
      {q.isLoading || rows.length === 0 ? (
        <div className="py-4 text-center text-xs text-zinc-500">no FII/DII data yet</div>
      ) : (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <th className="py-1.5 pr-4 font-medium">Institution</th>
              <th className="py-1.5 pr-4 text-right font-medium">Buy</th>
              <th className="py-1.5 pr-4 text-right font-medium">Sell</th>
              <th className="py-1.5 text-right font-medium">Net</th>
            </tr>
          </thead>
          <tbody>
            {[fii, dii].map((r) =>
              r ? (
                <tr key={r.category} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                  <td className="py-2 pr-4 font-medium">{r.category}</td>
                  <td className="py-2 pr-4 text-right font-mono text-xs">₹{parseFloat(r.buyValue).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr</td>
                  <td className="py-2 pr-4 text-right font-mono text-xs">₹{parseFloat(r.sellValue).toLocaleString("en-IN", { maximumFractionDigits: 0 })} Cr</td>
                  <td className="py-2 text-right">{net(r.netValue)}</td>
                </tr>
              ) : null
            )}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function SignalTrackerCard({ onSelectStock }: { onSelectStock: (s: string) => void }) {
  const q = useQuery({ queryKey: ["signals"], queryFn: fetchSignals, refetchInterval: 120_000 });
  const d = q.data?.data;
  return (
    <Card
      title="Signal Tracker"
      hint="Every BUY/SELL the outlook model emits is logged and scored against what the stock actually did next"
    >
      {!d ? (
        <div className="py-4 text-center text-xs text-zinc-500">loading signals…</div>
      ) : (
        <>
          <div className="tnum mb-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-5">
            <div className="rounded-lg bg-zinc-50 py-2 dark:bg-zinc-950/60">
              <div className="text-[10px] uppercase text-zinc-500">Win rate</div>
              <div className="font-mono text-base font-bold">{d.stats.win_rate_pct != null ? `${d.stats.win_rate_pct}%` : "—"}</div>
            </div>
            <div className="rounded-lg bg-zinc-50 py-2 dark:bg-zinc-950/60">
              <div className="text-[10px] uppercase text-zinc-500">Wins / Losses</div>
              <div className="font-mono text-base font-bold">
                <span className="text-emerald-500">{d.stats.wins}</span> / <span className="text-rose-500">{d.stats.losses}</span>
              </div>
            </div>
            <div className="rounded-lg bg-zinc-50 py-2 dark:bg-zinc-950/60">
              <div className="text-[10px] uppercase text-zinc-500">Total R</div>
              <div className={`font-mono text-base font-bold ${(d.stats.total_r ?? 0) >= 0 ? "text-emerald-500" : "text-rose-500"}`}>
                {d.stats.total_r != null ? `${d.stats.total_r > 0 ? "+" : ""}${d.stats.total_r}R` : "—"}
              </div>
            </div>
            <div className="rounded-lg bg-zinc-50 py-2 dark:bg-zinc-950/60">
              <div className="text-[10px] uppercase text-zinc-500">Profit Factor</div>
              <div className="font-mono text-base font-bold text-sky-500">
                {d.stats.profit_factor != null ? `${d.stats.profit_factor}x` : "—"}
              </div>
            </div>
            <div className="rounded-lg bg-zinc-50 py-2 dark:bg-zinc-950/60">
              <div className="text-[10px] uppercase text-zinc-500">Avg Win / Loss</div>
              <div className="font-mono text-xs font-semibold">
                <span className="text-emerald-500">{d.stats.avg_win_r != null ? `+${d.stats.avg_win_r}R` : "—"}</span> /{" "}
                <span className="text-rose-500">{d.stats.avg_loss_r != null ? `${d.stats.avg_loss_r}R` : "—"}</span>
              </div>
            </div>
          </div>
          {d.open.length > 0 && (
            <div className="mb-2">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">Open positions</div>
              {d.open.slice(0, 4).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelectStock(s.symbol)}
                  className="mr-1.5 mb-1 inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-xs hover:bg-zinc-200 dark:bg-zinc-800 dark:hover:bg-zinc-700"
                >
                  <span className={`font-bold ${s.signal === "BUY" ? "text-emerald-500" : "text-rose-400"}`}>{s.signal}</span>
                  <span className="font-medium">{s.symbol}</span>
                  <span className="text-zinc-500">@ ₹{s.entry.toLocaleString("en-IN")}</span>
                  <span className="text-zinc-400">→ ₹{s.target_1?.toLocaleString("en-IN") ?? "—"}</span>
                </button>
              ))}
            </div>
          )}
          {d.recent.filter((r) => r.resolved && r.outcome !== "superseded").length > 0 ? (
            <div className="max-h-44 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-white dark:bg-zinc-900">
                  <tr className="border-b border-zinc-200 text-[10px] uppercase text-zinc-500 dark:border-zinc-800">
                    <th className="py-1 pr-2 font-medium">Stock</th>
                    <th className="py-1 pr-2 font-medium">Signal</th>
                    <th className="py-1 pr-2 text-right font-medium">Entry</th>
                    <th className="py-1 pr-2 text-right font-medium">Exit</th>
                    <th className="py-1 text-right font-medium">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {d.recent
                    .filter((r) => r.resolved && r.outcome !== "superseded")
                    .slice(0, 12)
                    .map((r) => (
                      <tr key={r.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/50">
                        <td className="py-1 pr-2">
                          <button type="button" onClick={() => onSelectStock(r.symbol)} className="font-medium hover:text-emerald-500 hover:underline">
                            {r.symbol}
                          </button>
                        </td>
                        <td className={`py-1 pr-2 font-bold ${r.signal === "BUY" ? "text-emerald-500" : "text-rose-400"}`}>{r.signal}</td>
                        <td className="py-1 pr-2 text-right font-mono">{r.entry.toLocaleString("en-IN")}</td>
                        <td className="py-1 pr-2 text-right font-mono">{r.exit_price?.toLocaleString("en-IN") ?? "—"}</td>
                        <td className="py-1 text-right">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                              r.outcome === "hit_target_1" || (r.outcome === "expired" && (r.r_multiple ?? 0) > 0)
                                ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                                : r.outcome === "hit_stop" || (r.outcome === "expired" && (r.r_multiple ?? 0) <= 0)
                                  ? "bg-rose-500/10 text-rose-500"
                                  : "bg-zinc-500/10 text-zinc-500"
                            }`}
                          >
                            {r.outcome === "hit_target_1" ? "target hit" : r.outcome === "hit_stop" ? "stop hit" : r.outcome}
                            {r.r_multiple != null && ` ${r.r_multiple > 0 ? "+" : ""}${r.r_multiple.toFixed(1)}R`}
                          </span>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-[11px] text-zinc-500">
              Signals resolve automatically ~{d.recent[0]?.horizon_days ?? 10} days after they fire, using real price bars. Check back once the model has directional calls behind it.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
