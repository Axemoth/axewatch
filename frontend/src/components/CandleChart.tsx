import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchCandles, type CandleBar, type TradePlan } from "../api";

const RANGES = ["6mo", "1y", "3y", "5y"] as const;

export function CandleChart({
  symbol,
  tradePlan,
}: {
  symbol: string;
  tradePlan?: TradePlan | null;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]>("1y");
  const [showMa20, setShowMa20] = useState(true);
  const [showMa50, setShowMa50] = useState(false);
  const [showMa200, setShowMa200] = useState(false);
  const [showVolume, setShowVolume] = useState(true);

  const q = useQuery({
    queryKey: ["candles", symbol, range],
    queryFn: () => fetchCandles(symbol, range),
    staleTime: 300_000,
  });
  const bars = q.data?.data.bars ?? [];

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-300">
            Price History
          </h3>
          <div className="flex items-center gap-1 text-[10px]">
            <button
              type="button"
              onClick={() => setShowMa20((x) => !x)}
              className={`rounded px-1.5 py-0.5 font-medium transition-colors ${
                showMa20
                  ? "bg-amber-500/20 text-amber-600 ring-1 ring-amber-500/40 dark:text-amber-400"
                  : "bg-zinc-100 text-zinc-400 hover:text-zinc-600 dark:bg-zinc-800 dark:hover:text-zinc-300"
              }`}
            >
              SMA 20
            </button>
            <button
              type="button"
              onClick={() => setShowMa50((x) => !x)}
              className={`rounded px-1.5 py-0.5 font-medium transition-colors ${
                showMa50
                  ? "bg-sky-500/20 text-sky-600 ring-1 ring-sky-500/40 dark:text-sky-400"
                  : "bg-zinc-100 text-zinc-400 hover:text-zinc-600 dark:bg-zinc-800 dark:hover:text-zinc-300"
              }`}
            >
              SMA 50
            </button>
            <button
              type="button"
              onClick={() => setShowMa200((x) => !x)}
              className={`rounded px-1.5 py-0.5 font-medium transition-colors ${
                showMa200
                  ? "bg-violet-500/20 text-violet-600 ring-1 ring-violet-500/40 dark:text-violet-400"
                  : "bg-zinc-100 text-zinc-400 hover:text-zinc-600 dark:bg-zinc-800 dark:hover:text-zinc-300"
              }`}
            >
              SMA 200
            </button>
            <button
              type="button"
              onClick={() => setShowVolume((x) => !x)}
              className={`rounded px-1.5 py-0.5 font-medium transition-colors ${
                showVolume
                  ? "bg-emerald-500/20 text-emerald-600 ring-1 ring-emerald-500/40 dark:text-emerald-400"
                  : "bg-zinc-100 text-zinc-400 hover:text-zinc-600 dark:bg-zinc-800 dark:hover:text-zinc-300"
              }`}
            >
              Vol
            </button>
          </div>
        </div>

        <div className="flex gap-1 rounded-lg border border-zinc-200 p-0.5 dark:border-zinc-800">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                range === r
                  ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                  : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {q.isLoading ? (
        <div className="py-8 text-center text-xs text-zinc-500">loading candles…</div>
      ) : bars.length < 2 ? (
        <div className="py-6 text-center text-xs text-zinc-500">no history available</div>
      ) : (
        <CandleSvg
          bars={bars}
          showMa20={showMa20}
          showMa50={showMa50}
          showMa200={showMa200}
          showVolume={showVolume}
          tradePlan={tradePlan}
        />
      )}
    </div>
  );
}

function CandleSvg({
  bars,
  showMa20,
  showMa50,
  showMa200,
  showVolume,
  tradePlan,
}: {
  bars: CandleBar[];
  showMa20: boolean;
  showMa50: boolean;
  showMa200: boolean;
  showVolume: boolean;
  tradePlan?: TradePlan | null;
}) {
  const [hover, setHover] = useState<{ x: number; bar: CandleBar; ma20?: number; ma50?: number; ma200?: number } | null>(null);

  const W = 640;
  const H = showVolume ? 290 : 230;
  const PAD_L = 8;
  const PAD_R = 52;
  const PAD_T = 10;
  const PRICE_H = showVolume ? 190 : 200;
  const VOL_T = 210;
  const VOL_H = 60;
  const PAD_B = 18;

  const view = useMemo(() => {
    const step = Math.max(1, Math.floor(bars.length / 130));
    const shown = bars.filter((_, i) => i % step === 0 || i === bars.length - 1);

    // Compute moving averages over all bars, then map to shown
    const calcMa = (n: number) => {
      const out: (number | null)[] = [];
      let sum = 0;
      for (let i = 0; i < bars.length; i++) {
        sum += bars[i].c;
        if (i >= n) sum -= bars[i - n].c;
        out.push(i >= n - 1 ? sum / n : null);
      }
      return shown.map((b) => {
        const origIdx = bars.findIndex((x) => x.t === b.t);
        return origIdx >= 0 ? out[origIdx] : null;
      });
    };

    const ma20Series = calcMa(20);
    const ma50Series = calcMa(50);
    const ma200Series = calcMa(200);

    let lo = Math.min(...shown.map((b) => b.l));
    let hi = Math.max(...shown.map((b) => b.h));

    // Expand bounds if trade plan levels exist within reasonable range (<= 15% outside)
    if (tradePlan && !tradePlan.no_trade) {
      const levels = [tradePlan.entry, tradePlan.stop, tradePlan.target_1, tradePlan.target_2].filter(
        (x): x is number => x != null && Number.isFinite(x)
      );
      for (const lev of levels) {
        if (lev < lo && lev > lo * 0.85) lo = lev;
        if (lev > hi && lev < hi * 1.15) hi = lev;
      }
    }

    const pad = (hi - lo) * 0.05 || 1;
    const yPrice = (p: number) => PAD_T + ((hi + pad - p) / (hi - lo + 2 * pad)) * (PRICE_H - PAD_T);

    const maxVol = Math.max(...shown.map((b) => b.v), 1);
    const yVol = (v: number) => VOL_T + VOL_H - (v / maxVol) * VOL_H;

    const bw = (W - PAD_L - PAD_R) / shown.length;
    const xCoord = (i: number) => PAD_L + i * bw + bw / 2;

    return {
      shown,
      lo,
      hi,
      pad,
      bw,
      maxVol,
      yPrice,
      yVol,
      xCoord,
      ma20Series,
      ma50Series,
      ma200Series,
    };
  }, [bars, tradePlan, showVolume]);

  const fmtD = (t: number) =>
    new Date(t * 1000).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
  const fmtM = (t: number) =>
    new Date(t * 1000).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => ({
    y: PAD_T + f * (PRICE_H - PAD_T),
    price: view.hi + (view.lo - view.hi) * f + (view.hi - view.lo) * 0.05 * (1 - 2 * f),
  }));

  const buildMaPath = (series: (number | null)[]) => {
    let d = "";
    series.forEach((val, i) => {
      if (val != null) {
        const x = view.xCoord(i);
        const y = view.yPrice(val);
        d += d ? ` L ${x.toFixed(1)} ${y.toFixed(1)}` : `M ${x.toFixed(1)} ${y.toFixed(1)}`;
      }
    });
    return d;
  };

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full select-none"
        onMouseLeave={() => setHover(null)}
      >
        {/* Horizontal grid lines */}
        {gridLines.map((g, i) => (
          <g key={i}>
            <line x1={PAD_L} x2={W - PAD_R} y1={g.y} y2={g.y} stroke="#8883" strokeDasharray="2 4" strokeWidth="0.5" />
            <text x={W - PAD_R + 4} y={g.y + 3} fontSize="9" fill="#888" className="font-mono">
              {g.price.toFixed(0)}
            </text>
          </g>
        ))}

        {/* Volume Separator */}
        {showVolume && (
          <line x1={PAD_L} x2={W - PAD_R} y1={VOL_T - 4} y2={VOL_T - 4} stroke="#8884" strokeWidth="0.5" />
        )}

        {/* Trade Plan Price Lines (if present) */}
        {tradePlan && !tradePlan.no_trade && (
          <g>
            {tradePlan.entry && (
              <>
                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={view.yPrice(tradePlan.entry)}
                  y2={view.yPrice(tradePlan.entry)}
                  stroke="#38bdf8"
                  strokeWidth="1"
                />
                <text x={W - PAD_R + 4} y={view.yPrice(tradePlan.entry) + 3} fontSize="8" fill="#38bdf8" className="font-mono font-semibold">
                  E {tradePlan.entry.toFixed(0)}
                </text>
              </>
            )}
            {tradePlan.stop && (
              <>
                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={view.yPrice(tradePlan.stop)}
                  y2={view.yPrice(tradePlan.stop)}
                  stroke="#fb7185"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
                <text x={W - PAD_R + 4} y={view.yPrice(tradePlan.stop) + 3} fontSize="8" fill="#fb7185" className="font-mono font-semibold">
                  SL {tradePlan.stop.toFixed(0)}
                </text>
              </>
            )}
            {tradePlan.target_1 && (
              <>
                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={view.yPrice(tradePlan.target_1)}
                  y2={view.yPrice(tradePlan.target_1)}
                  stroke="#34d399"
                  strokeDasharray="3 3"
                  strokeWidth="1"
                />
                <text x={W - PAD_R + 4} y={view.yPrice(tradePlan.target_1) + 3} fontSize="8" fill="#34d399" className="font-mono font-semibold">
                  T1 {tradePlan.target_1.toFixed(0)}
                </text>
              </>
            )}
            {tradePlan.target_2 && (
              <>
                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={view.yPrice(tradePlan.target_2)}
                  y2={view.yPrice(tradePlan.target_2)}
                  stroke="#34d399"
                  strokeDasharray="2 4"
                  strokeWidth="0.8"
                />
                <text x={W - PAD_R + 4} y={view.yPrice(tradePlan.target_2) + 3} fontSize="8" fill="#34d399" className="font-mono font-semibold">
                  T2 {tradePlan.target_2.toFixed(0)}
                </text>
              </>
            )}
          </g>
        )}

        {/* Candles and Volume Bars */}
        {view.shown.map((b, i) => {
          const up = b.c >= b.o;
          const color = up ? "#34d399" : "#fb7185";
          const bodyTop = view.yPrice(Math.max(b.o, b.c));
          const bodyH = Math.max(1, Math.abs(view.yPrice(b.o) - view.yPrice(b.c)));
          const x = view.xCoord(i);

          return (
            <g key={i}>
              {/* Wick */}
              <line x1={x} x2={x} y1={view.yPrice(b.h)} y2={view.yPrice(b.l)} stroke={color} strokeWidth="0.8" />
              {/* Body */}
              <rect
                x={x - Math.max(1, view.bw * 0.32)}
                y={bodyTop}
                width={Math.max(1.5, view.bw * 0.64)}
                height={bodyH}
                fill={color}
                opacity="0.9"
              />

              {/* Volume Bar */}
              {showVolume && (
                <rect
                  x={x - Math.max(0.8, view.bw * 0.28)}
                  y={view.yVol(b.v)}
                  width={Math.max(1.2, view.bw * 0.56)}
                  height={Math.max(1, VOL_T + VOL_H - view.yVol(b.v))}
                  fill={color}
                  opacity="0.5"
                />
              )}

              {/* Hitbox */}
              <rect
                x={x - view.bw / 2}
                y={PAD_T}
                width={view.bw}
                height={H - PAD_B}
                fill="transparent"
                onMouseEnter={() =>
                  setHover({
                    x,
                    bar: b,
                    ma20: view.ma20Series[i] ?? undefined,
                    ma50: view.ma50Series[i] ?? undefined,
                    ma200: view.ma200Series[i] ?? undefined,
                  })
                }
              />
            </g>
          );
        })}

        {/* Moving Average Paths */}
        {showMa20 && <path d={buildMaPath(view.ma20Series)} fill="none" stroke="#f59e0b" strokeWidth="1.2" opacity="0.85" />}
        {showMa50 && <path d={buildMaPath(view.ma50Series)} fill="none" stroke="#0284c7" strokeWidth="1.2" opacity="0.85" />}
        {showMa200 && <path d={buildMaPath(view.ma200Series)} fill="none" stroke="#8b5cf6" strokeWidth="1.2" opacity="0.85" />}

        {/* Bottom Time Axis Labels */}
        {view.shown.length > 1 &&
          [0, Math.floor(view.shown.length / 3), Math.floor((view.shown.length * 2) / 3), view.shown.length - 1].map((i) => (
            <text key={i} x={view.xCoord(i)} y={H - 4} fontSize="9" fill="#888" textAnchor="middle">
              {fmtM(view.shown[i].t)}
            </text>
          ))}

        {/* Crosshair vertical line */}
        {hover && (
          <line x1={hover.x} x2={hover.x} y1={PAD_T} y2={H - PAD_B} stroke="#888" strokeWidth="0.6" strokeDasharray="2 2" />
        )}
      </svg>

      {/* Floating coordinates badge on hover */}
      {hover && (
        <div className="pointer-events-none absolute left-2 top-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-zinc-900/95 px-2.5 py-1 font-mono text-[10px] text-zinc-200 shadow-md ring-1 ring-zinc-700">
          <span className="font-semibold text-zinc-400">{fmtD(hover.bar.t)}</span>
          <span>O {hover.bar.o.toFixed(1)}</span>
          <span>H {hover.bar.h.toFixed(1)}</span>
          <span>L {hover.bar.l.toFixed(1)}</span>
          <span>
            C{" "}
            <span className={hover.bar.c >= hover.bar.o ? "font-bold text-emerald-400" : "font-bold text-rose-400"}>
              {hover.bar.c.toFixed(1)}
            </span>
          </span>
          {hover.bar.v > 0 && <span className="text-zinc-400">Vol {(hover.bar.v / 1000).toFixed(0)}k</span>}
          {showMa20 && hover.ma20 != null && <span className="text-amber-400">MA20 {hover.ma20.toFixed(1)}</span>}
          {showMa50 && hover.ma50 != null && <span className="text-sky-400">MA50 {hover.ma50.toFixed(1)}</span>}
          {showMa200 && hover.ma200 != null && <span className="text-violet-400">MA200 {hover.ma200.toFixed(1)}</span>}
        </div>
      )}
    </div>
  );
}
