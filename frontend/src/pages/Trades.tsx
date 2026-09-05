import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchOutlookModel,
  fetchSignals,
  fetchTradeIdeas,
  type ModelBucket,
  type TradeIdea,
} from "../api";
import { OrderTicket } from "../components/OrderTicket";
import { EmptyState, Seg, Stat, TableSkeleton } from "../components/ui";

function inr(n?: number | null, frac = 0) {
  return n != null && Number.isFinite(n)
    ? n.toLocaleString("en-IN", { maximumFractionDigits: frac })
    : "—";
}

function IdeaCard({
  idea,
  tierPct,
  onTrade,
}: {
  idea: TradeIdea;
  tierPct: number;
  onTrade: (idea: TradeIdea) => void;
}) {
  const buy = idea.signal === "BUY";
  const tier = idea.tiers.find((t) => t.risk_pct === tierPct) ?? idea.tiers[1] ?? idea.tiers[0];
  const drifted =
    idea.drift_pct != null &&
    (buy ? idea.drift_pct > 2 : idea.drift_pct < -2);

  return (
    <div
      className={`lift rounded-2xl border bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] dark:bg-zinc-900/60 ${
        buy ? "border-emerald-500/25 dark:border-emerald-500/25" : "border-rose-500/25 dark:border-rose-500/25"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span
          className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
            buy ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/15 text-rose-600 dark:text-rose-400"
          }`}
        >
          {idea.signal}
        </span>
        <span className="font-mono text-base font-bold">{idea.symbol}</span>
        <span className={`tnum font-mono text-xs ${buy ? "text-emerald-500" : "text-rose-400"}`}>
          {idea.score != null ? `${idea.score >= 0 ? "+" : ""}${idea.score.toFixed(0)}` : "—"}
        </span>
        <span className="ml-auto text-[11px] text-zinc-500">
          {idea.age_days < 1 ? "today" : `${idea.age_days.toFixed(0)}d ago`} · {idea.horizon_days}d horizon
        </span>
      </div>

      <div className="tnum mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="font-mono text-2xl font-bold">
          {idea.live != null ? `₹${inr(idea.live, 2)}` : "price…"}
        </span>
        <span className="font-mono text-xs text-zinc-500">plan ₹{inr(idea.entry, 2)}</span>
        {idea.drift_pct != null && (
          <span className={`font-mono text-xs font-semibold ${drifted ? "text-amber-500" : "text-zinc-400"}`}>
            {idea.drift_pct >= 0 ? "+" : ""}{idea.drift_pct.toFixed(1)}%{drifted ? " — entry slipped" : ""}
          </span>
        )}
        {idea.held_qty > 0 && (
          <span className="rounded-full bg-sky-500/10 px-2 py-0.5 font-mono text-[10px] font-semibold text-sky-600 dark:text-sky-400">
            holding {idea.held_qty}
          </span>
        )}
      </div>

      <div className="tnum mb-3 grid grid-cols-4 gap-1.5 text-center">
        <div className="rounded-lg bg-rose-500/5 px-1 py-1.5 ring-1 ring-rose-500/15">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Stop</div>
          <div className="font-mono text-xs font-bold text-rose-500">
            {idea.stop != null ? `₹${inr(idea.stop, 2)}` : "—"}
          </div>
        </div>
        <div className="rounded-lg bg-emerald-500/5 px-1 py-1.5 ring-1 ring-emerald-500/15">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Target 1</div>
          <div className="font-mono text-xs font-bold text-emerald-500">
            {idea.target_1 != null ? `₹${inr(idea.target_1, 2)}` : "—"}
          </div>
        </div>
        <div className="rounded-lg bg-emerald-500/5 px-1 py-1.5 ring-1 ring-emerald-500/15">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">Target 2</div>
          <div className="font-mono text-xs font-bold text-emerald-500">
            {idea.target_2 != null ? `₹${inr(idea.target_2, 2)}` : "—"}
          </div>
        </div>
        <div className="rounded-lg bg-zinc-50 px-1 py-1.5 ring-1 ring-zinc-200/70 dark:bg-zinc-950/60 dark:ring-zinc-800">
          <div className="text-[9px] font-semibold uppercase tracking-wider text-zinc-500">R : R</div>
          <div className="font-mono text-xs font-bold">
            {idea.reward_risk != null ? `1 : ${idea.reward_risk}` : "—"}
          </div>
        </div>
      </div>

      <div className="tnum flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl bg-zinc-50 px-3 py-2 text-xs ring-1 ring-zinc-200/70 dark:bg-zinc-950/60 dark:ring-zinc-800">
        <span className="text-zinc-500">
          Risk {tier?.risk_pct ?? "—"}% →
          <span className="ml-1 font-mono font-bold text-zinc-800 dark:text-zinc-100">
            {tier && tier.qty >= 1 ? `${tier.qty} shares` : "too small"}
          </span>
        </span>
        {tier?.notional != null && (
          <span className="text-zinc-500">
            costs <span className="font-mono font-semibold">₹{inr(tier.notional)}</span>
          </span>
        )}
        {tier?.max_loss != null && (
          <span className="text-zinc-500">
            lose max <span className="font-mono font-semibold text-rose-500">₹{inr(tier.max_loss)}</span>
          </span>
        )}
        <button
          type="button"
          disabled={!idea.can_trade}
          onClick={() => onTrade(idea)}
          title={idea.block_reason ?? `${idea.signal} ${tier?.qty ?? 0} ${idea.symbol} at market`}
          className={`ml-auto rounded-xl px-5 py-2 text-sm font-bold text-white transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
            buy ? "bg-emerald-600 hover:bg-emerald-500" : "bg-rose-600 hover:bg-rose-500"
          }`}
        >
          {buy ? "Buy" : "Sell"}
        </button>
      </div>
      {!idea.can_trade && idea.block_reason && (
        <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">{idea.block_reason}</p>
      )}
    </div>
  );
}

function CalibrationTable({ buckets }: { buckets: ModelBucket[] }) {
  if (!buckets || buckets.length === 0) return null;
  const maxN = Math.max(...buckets.map((b) => b.n), 1);
  return (
    <div className="space-y-1.5">
      {buckets.map((b, i) => (
        <div key={i} className="flex items-center gap-2 text-xs">
          <span className="tnum w-24 shrink-0 font-mono text-zinc-500">
            {(b.lo * 100).toFixed(0)}–{(b.hi * 100).toFixed(0)}%
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div
              className={`h-full rounded-full ${(b.acc ?? 0) >= 0.5 ? "bg-emerald-500" : "bg-rose-500"}`}
              style={{ width: `${Math.max(4, ((b.acc ?? 0) * 100))}%` }}
            />
          </div>
          <span className="tnum w-28 shrink-0 text-right font-mono text-zinc-400">
            {b.acc != null ? `${(b.acc * 100).toFixed(0)}% right` : "—"} · n={b.n}
          </span>
          <span className="hidden w-24 shrink-0 sm:block">
            <span className="inline-block h-1.5 rounded-full bg-sky-500/60" style={{ width: `${(b.n / maxN) * 100}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function TradesPage() {
  const [tierPct, setTierPct] = useState(1);
  const [filter, setFilter] = useState<"All" | "BUY" | "SELL">("All");
  const [ticket, setTicket] = useState<TradeIdea | null>(null);

  const ideasQ = useQuery({ queryKey: ["trade-ideas"], queryFn: fetchTradeIdeas, refetchInterval: 90_000 });
  const sigQ = useQuery({ queryKey: ["signals"], queryFn: fetchSignals, refetchInterval: 120_000 });
  const modelQ = useQuery({ queryKey: ["outlook-model"], queryFn: fetchOutlookModel, staleTime: 300_000 });

  const payload = ideasQ.data?.data;
  const ideas = useMemo(() => {
    const all = payload?.ideas ?? [];
    return filter === "All" ? all : all.filter((x) => x.signal === filter);
  }, [payload, filter]);
  const stats = sigQ.data?.data.stats;
  const gm = modelQ.data?.data;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
            Trade the model
          </h2>
          <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-600 ring-1 ring-violet-500/30 dark:text-violet-400">
            Paper
          </span>
          <div className="ml-auto flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Risk per trade</span>
            <Seg options={["0.5", "1", "2"]} value={String(tierPct)} onChange={(v) => setTierPct(parseFloat(v))} label="Risk per trade" />
          </div>
        </div>
        <p className="mb-3 max-w-2xl text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          Every open model signal with a live price and a pre-sized order. Pick how much of your
          paper equity one stopped-out trade may cost — quantities update instantly.
        </p>
        <div className="tnum grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Paper equity" value={ideasQ.isLoading ? "…" : `₹${inr(payload?.equity)}`} />
          <Stat label="Cash" value={ideasQ.isLoading ? "…" : `₹${inr(payload?.cash)}`} />
          <Stat
            label="Model win rate"
            value={stats?.win_rate_pct != null ? `${stats.win_rate_pct}%` : "—"}
            sub={stats ? `${stats.wins}W / ${stats.losses}L · ${stats.resolved} resolved` : undefined}
            tone={stats && (stats.win_rate_pct ?? 0) >= 50 ? "emerald" : "zinc"}
          />
          <Stat
            label="Model total R"
            value={stats?.total_r != null ? `${stats.total_r > 0 ? "+" : ""}${stats.total_r}R` : "—"}
            sub={stats?.profit_factor != null ? `profit factor ${stats.profit_factor}x` : undefined}
            tone={stats && (stats.total_r ?? 0) >= 0 ? "emerald" : "rose"}
          />
        </div>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <h2 className="mr-1 text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
            Open ideas
          </h2>
          {(["All", "BUY", "SELL"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}
              className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                filter === f
                  ? "bg-emerald-500/15 text-emerald-600 ring-1 ring-emerald-500/30 dark:text-emerald-400"
                  : "bg-zinc-100 text-zinc-500 hover:text-zinc-800 dark:bg-zinc-800/60 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              {f}
            </button>
          ))}
          <span className="tnum ml-auto text-[11px] text-zinc-500">
            {payload ? `${ideas.length} of ${payload.count} ideas` : ""}
          </span>
        </div>

        {ideasQ.isLoading || !payload ? (
          <TableSkeleton rows={4} cols={3} />
        ) : ideasQ.isError ? (
          <EmptyState title="Could not load ideas" hint="The backend may be warming up — try again in a few seconds." />
        ) : ideas.length === 0 ? (
          <EmptyState
            title={payload.count === 0 ? "No open model signals" : `No ${filter} ideas right now`}
            hint="The daily scan logs a BUY/SELL for NIFTY 50 stocks only when the outlook score leaves the neutral band. Resolved history lives in the Signal Tracker on the Market tab."
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {ideas.map((idea) => (
              <IdeaCard key={idea.symbol} idea={idea} tierPct={tierPct} onTrade={setTicket} />
            ))}
          </div>
        )}
        <p className="mt-3 text-[10px] leading-relaxed text-zinc-500">
          Sizes assume the stop fills exactly — gaps can slip past it, and SELL only exits shares
          you hold (paper accounts cannot short). Educational, not advice.
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.15)] sm:p-5 dark:border-zinc-800 dark:bg-zinc-900/60">
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[13px] font-semibold uppercase tracking-wider text-zinc-700 dark:text-zinc-300">
            Model report card
          </h2>
          {gm?.trained_at ? (
            <span className="tnum text-xs text-zinc-500">
              trained {new Date(gm.trained_at * 1000).toLocaleDateString("en-IN")} · {gm.n_features ?? "—"} features v{gm.feature_version ?? "—"}
            </span>
          ) : null}
        </div>
        {!gm || modelQ.isLoading ? (
          <TableSkeleton rows={3} cols={3} />
        ) : gm.status === "ready" ? (
          <div className="space-y-3">
            <div className="tnum grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Stat label="Accuracy" value={gm.walk_forward_accuracy != null ? `${(gm.walk_forward_accuracy * 100).toFixed(1)}%` : "—"} title="Out-of-sample walk-forward accuracy" />
              <Stat label="AUC" value={gm.walk_forward_auc != null ? gm.walk_forward_auc.toFixed(2) : "—"} title="Rank-ordering quality" />
              <Stat
                label="Strong-BUY precision"
                value={gm.long_precision != null ? `${(gm.long_precision * 100).toFixed(0)}%` : "—"}
                sub={gm.long_n != null ? `n=${gm.long_n}` : undefined}
                title="When model probability topped 55%, how often the stock beat NIFTY"
              />
              <Stat
                label="Pick spread"
                value={gm.spread_bps != null ? `${gm.spread_bps > 0 ? "+" : ""}${gm.spread_bps} bps` : "—"}
                title="10-day excess return of model picks minus model pans"
                tone={gm.spread_bps != null && gm.spread_bps > 0 ? "emerald" : "zinc"}
              />
              <Stat
                label="Samples"
                value={gm.n_samples != null ? gm.n_samples.toLocaleString("en-IN") : "—"}
                sub={gm.n_stocks != null ? `${gm.n_stocks} stocks` : undefined}
              />
            </div>
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                Calibration — confidence vs actual win rate
              </div>
              <CalibrationTable buckets={gm.buckets ?? []} />
            </div>
            <p className="text-[10px] leading-relaxed text-zinc-500">
              Walk-forward with a 10-day embargo: the model only ever predicts bars it never
              trained on. Base rate beat-market is {gm.base_rate != null ? `${(gm.base_rate * 100).toFixed(0)}%` : "—"} —
              anything above that is genuine edge, and the verdict only listens when accuracy
              clears 54%.
            </p>
          </div>
        ) : (
          <p className="text-xs text-zinc-500">
            {gm.status === "failed"
              ? `Training failed — ${gm.error ?? "unknown error"}. Ideas above still use the transparent technical score.`
              : "Training in the background (reads ~100 stocks' 5-year history). Ideas above still use the transparent technical score."}
          </p>
        )}
      </section>

      {ticket && (
        <OrderTicket
          initialSymbol={ticket.symbol}
          initialSide={ticket.signal}
          initialQty={(ticket.tiers.find((t) => t.risk_pct === tierPct) ?? ticket.tiers[1] ?? ticket.tiers[0])?.qty || undefined}
          tiers={ticket.tiers}
          livePrice={ticket.live}
          riskPerShare={ticket.risk_per_share}
          heldQty={ticket.held_qty}
          lockSymbol
          onClose={() => setTicket(null)}
        />
      )}
    </div>
  );
}
