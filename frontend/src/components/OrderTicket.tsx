import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchPaperAccount,
  fetchStockOutlook,
  fetchStockQuote,
  placeLimitOrder,
  placePaperOrder,
  stockSearch,
  type TradeTier,
} from "../api";

const inputCls =
  "w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm outline-none placeholder:text-zinc-400 focus:border-violet-500 dark:border-zinc-700 dark:bg-zinc-950/70 dark:placeholder:text-zinc-600 dark:focus:border-violet-500/60";

function SymbolPicker({ symbol, onPick }: { symbol: string; onPick: (s: string) => void }) {
  const [text, setText] = useState(symbol);
  const [debounced, setDebounced] = useState(symbol);
  const [open, setOpen] = useState(false);

  useEffect(() => setText(symbol), [symbol]);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim().toUpperCase()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const q = useQuery({
    queryKey: ["stockSearch", debounced],
    queryFn: () => stockSearch(debounced),
    enabled: debounced.length >= 2,
    staleTime: 60_000,
  });
  const results = q.data?.data.results ?? [];

  return (
    <div className="relative">
      <input
        value={text}
        onChange={(e) => {
          const v = e.target.value.toUpperCase();
          setText(v);
          onPick(v);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        placeholder="SYMBOL"
        aria-label="Stock symbol"
        className={`${inputCls} font-mono font-semibold tracking-wide`}
      />
      {open && debounced.length >= 2 && results.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-xl border border-zinc-200 bg-white shadow-lg nice-scroll dark:border-zinc-800 dark:bg-zinc-900">
          {results.map((r) => (
            <button
              key={r.symbol}
              type="button"
              onMouseDown={() => {
                onPick(r.symbol);
                setOpen(false);
              }}
              className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-xs hover:bg-violet-500/10"
            >
              <span className="font-mono font-semibold">{r.symbol}</span>
              <span className="truncate text-zinc-500">{r.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function OrderTicket({
  initialSymbol = "",
  initialSide = "BUY",
  initialQty,
  tiers,
  livePrice,
  riskPerShare,
  heldQty,
  lockSymbol = false,
  onClose,
}: {
  initialSymbol?: string;
  initialSide?: "BUY" | "SELL";
  initialQty?: number;
  tiers?: TradeTier[];
  livePrice?: number | null;
  riskPerShare?: number | null;
  heldQty?: number;
  lockSymbol?: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [side, setSide] = useState<"BUY" | "SELL">(initialSide);
  const [symbol, setSymbol] = useState(initialSymbol.toUpperCase());
  const [qty, setQty] = useState(initialQty && initialQty > 0 ? String(initialQty) : "");
  const [kind, setKind] = useState<"market" | "limit">("market");
  const [limit, setLimit] = useState("");
  const [tierIdx, setTierIdx] = useState<number | null>(() => {
    if (initialQty && tiers) {
      const i = tiers.findIndex((t) => t.qty === initialQty);
      return i >= 0 ? i : null;
    }
    return null;
  });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const symValid = /^[A-Z0-9-]{1,20}$/.test(symbol.trim());
  const acctQ = useQuery({ queryKey: ["paper", "account"], queryFn: fetchPaperAccount, staleTime: 30_000 });
  const equity = acctQ.data?.data.equity ?? null;

  const needPlan = symValid && (!tiers || riskPerShare == null);
  const planQ = useQuery({
    queryKey: ["stockOutlook", symbol.trim()],
    queryFn: () => fetchStockOutlook(symbol.trim()),
    enabled: needPlan,
    staleTime: 300_000,
    retry: 1,
  });
  const needQuote = symValid && livePrice == null;
  const quoteQ = useQuery({
    queryKey: ["stockQuote", symbol.trim()],
    queryFn: () => fetchStockQuote(symbol.trim()),
    enabled: needQuote,
    staleTime: 60_000,
    retry: 1,
  });

  const rps = riskPerShare ?? planQ.data?.data.trade_plan?.risk_per_share ?? null;
  const live = livePrice ?? quoteQ.data?.data.last_price ?? planQ.data?.data.trade_plan?.entry ?? null;
  const plan = planQ.data?.data.trade_plan;

  const computedTiers: TradeTier[] = useMemo(() => {
    if (tiers && tiers.length > 0) return tiers;
    if (equity == null || rps == null || rps <= 0) return [];
    return [0.5, 1, 2].map((pct) => {
      const q = Math.floor(((equity * pct) / 100 / rps) * 100) / 100;
      const whole = Math.floor(q);
      return {
        risk_pct: pct,
        qty: side === "SELL" && heldQty != null ? Math.min(whole, Math.floor(heldQty)) : whole,
        notional: whole > 0 && live ? Math.round(whole * live * 100) / 100 : null,
        max_loss: whole > 0 ? Math.round(whole * rps * 100) / 100 : null,
      };
    });
  }, [tiers, equity, rps, live, side, heldQty]);

  const qNum = parseFloat(qty);
  const qtyOk = Number.isFinite(qNum) && qNum > 0;
  const estCost = qtyOk && live ? qNum * live : null;
  const maxLoss = qtyOk && rps ? qNum * rps : null;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["paper"] });
    qc.invalidateQueries({ queryKey: ["trade-ideas"] });
  };

  const mut = useMutation({
    mutationFn: async () => {
      const s = symbol.trim().toUpperCase();
      if (kind === "market") return placePaperOrder({ side, symbol: s, quantity: qNum });
      const lp = parseFloat(limit);
      if (!Number.isFinite(lp) || lp <= 0) throw new Error("Enter a valid limit price");
      return placeLimitOrder({ side, symbol: s, quantity: qNum, limit_price: lp });
    },
    onSuccess: (res) => {
      invalidate();
      const d = res.data as { order?: { side: string; symbol: string; quantity: number; price: number }; limit_price?: number; symbol?: string; quantity?: number; side?: string };
      if (kind === "market" && d.order) {
        const o = d.order;
        setMsg({ ok: true, text: `${o.side} ${o.quantity} ${o.symbol} @ ₹${o.price.toLocaleString("en-IN")} filled` });
      } else {
        setMsg({
          ok: true,
          text: `Limit ${side} ${qNum} ${symbol.trim().toUpperCase()} @ ₹${parseFloat(limit).toLocaleString("en-IN")} placed — fills when price crosses`,
        });
      }
      setDone(true);
    },
    onError: (e: Error) => setMsg({ ok: false, text: e.message.replace(/^\w+: \d+: /, "") }),
  });

  const submit = () => {
    if (!symValid) return setMsg({ ok: false, text: "Pick a stock symbol first" });
    if (!qtyOk) return setMsg({ ok: false, text: "Enter a valid quantity" });
    setMsg(null);
    mut.mutate();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-label="Place paper order"
    >
      <div
        className="animate-pop w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-xl sm:p-5 dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-600 ring-1 ring-violet-500/30 dark:text-violet-400">
              Paper
            </span>
            <span className="text-sm font-semibold">Place order</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close order ticket"
            className="rounded-lg px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
          >
            ✕
          </button>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl border border-zinc-200 p-0.5 dark:border-zinc-800">
          {(["BUY", "SELL"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setSide(s);
                setTierIdx(null);
              }}
              aria-pressed={side === s}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
                side === s
                  ? s === "BUY"
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "bg-rose-500/15 text-rose-600 dark:text-rose-400"
                  : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        <div className="mb-2 grid gap-2">
          {lockSymbol ? (
            <div className="flex items-center justify-between rounded-xl bg-zinc-50 px-3 py-2 ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800">
              <span className="font-mono text-sm font-bold">{symbol || "—"}</span>
              <span className="tnum font-mono text-sm">
                {live != null ? `₹${live.toLocaleString("en-IN")}` : "price…"}
              </span>
            </div>
          ) : (
            <SymbolPicker symbol={symbol} onPick={(s) => { setSymbol(s); setTierIdx(null); }} />
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Quantity
              </label>
              <input
                value={qty}
                onChange={(e) => {
                  setQty(e.target.value.replace(/[^\d.]/g, ""));
                  setTierIdx(null);
                }}
                placeholder="Qty"
                inputMode="decimal"
                className={`${inputCls} font-mono`}
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Order type
              </label>
              <div className="flex gap-1 rounded-xl border border-zinc-200 p-0.5 dark:border-zinc-800">
                {(["market", "limit"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setKind(k)}
                    aria-pressed={kind === k}
                    className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold capitalize ${
                      kind === k
                        ? "bg-violet-500/15 text-violet-600 dark:text-violet-300"
                        : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {kind === "limit" && (
            <div>
              <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Limit price ₹
              </label>
              <input
                value={limit}
                onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="Fills only past this price"
                inputMode="decimal"
                className={`${inputCls} font-mono`}
              />
            </div>
          )}
        </div>

        {computedTiers.length > 0 && rps != null && (
          <div className="mb-2 rounded-xl bg-violet-500/5 p-2.5 ring-1 ring-violet-500/20">
            <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-300">
              <span>Size by risk {rps != null ? `(₹${rps.toLocaleString("en-IN")}/share)` : ""}</span>
              {equity != null && <span className="tnum">eq ₹{Math.round(equity).toLocaleString("en-IN")}</span>}
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {computedTiers.map((t, i) => (
                <button
                  key={t.risk_pct}
                  type="button"
                  disabled={t.qty < 1}
                  onClick={() => {
                    setQty(String(t.qty));
                    setTierIdx(i);
                  }}
                  title={t.qty >= 1 ? `Risk ₹${(t.max_loss ?? 0).toLocaleString("en-IN")} to make size ${t.qty}` : "Too small for this budget"}
                  className={`rounded-lg px-2 py-1.5 text-center ring-1 transition-colors disabled:opacity-40 ${
                    tierIdx === i
                      ? "bg-violet-500/20 text-violet-700 ring-violet-500/50 dark:text-violet-200"
                      : "bg-white text-zinc-600 ring-zinc-200 hover:ring-violet-500/40 dark:bg-zinc-950/60 dark:text-zinc-300 dark:ring-zinc-800"
                  }`}
                >
                  <div className="text-[11px] font-bold">{t.risk_pct}%</div>
                  <div className="tnum font-mono text-[11px]">{t.qty >= 1 ? `${t.qty} sh` : "—"}</div>
                </button>
              ))}
            </div>
            {plan && plan.stop != null && (
              <div className="tnum mt-1.5 flex justify-between font-mono text-[10px] text-zinc-500">
                <span>stop ₹{plan.stop.toLocaleString("en-IN")}</span>
                <span className="text-emerald-500">T1 ₹{plan.target_1?.toLocaleString("en-IN") ?? "—"}</span>
                <span className="text-emerald-500">T2 ₹{plan.target_2?.toLocaleString("en-IN") ?? "—"}</span>
              </div>
            )}
          </div>
        )}

        {side === "SELL" && heldQty != null && (
          <p className="mb-2 text-[11px] text-zinc-500">
            Holding {heldQty} shares{heldQty > 0 ? " — sells reduce the position" : " — nothing to sell yet"}.
          </p>
        )}

        {(estCost != null || maxLoss != null) && (
          <div className="tnum mb-2 flex justify-between rounded-lg bg-zinc-50 px-3 py-2 text-xs ring-1 ring-zinc-200 dark:bg-zinc-950/60 dark:ring-zinc-800">
            <span className="text-zinc-500">
              Est. {kind === "limit" ? "value" : "cost"}{" "}
              <span className="font-mono font-semibold text-zinc-800 dark:text-zinc-200">
                ₹{(estCost ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}
              </span>
            </span>
            {maxLoss != null && (
              <span className="text-zinc-500">
                Max loss{" "}
                <span className="font-mono font-semibold text-rose-500">
                  -₹{maxLoss.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
                </span>
              </span>
            )}
          </div>
        )}

        {msg && (
          <p className={`mb-2 text-xs ${msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
            {msg.text}
          </p>
        )}

        {done ? (
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-xl bg-zinc-900 py-2 text-sm font-semibold text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            Done
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={mut.isPending}
            className={`w-full rounded-xl py-2 text-sm font-bold text-white transition-colors disabled:opacity-50 ${
              side === "BUY" ? "bg-emerald-600 hover:bg-emerald-500" : "bg-rose-600 hover:bg-rose-500"
            }`}
          >
            {mut.isPending ? "Placing…" : `${side} ${qtyOk ? `${qNum} ` : ""}${symbol.trim() || "…"}`}
          </button>
        )}
      </div>
    </div>
  );
}
