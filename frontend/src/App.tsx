import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MarketPage, StockDetailModal } from "./pages/Market";
import { IposPage } from "./pages/Ipos";
import { GmpPage } from "./pages/Gmp";
import { TradesPage } from "./pages/Trades";
import { AllotmentPage } from "./pages/Allotment";
import { PortfolioPage } from "./pages/Portfolio";
import { MfPage, FundModal } from "./pages/Mf";
import { ErrorBoundary } from "./ErrorBoundary";
import { CommandPalette } from "./components/CommandPalette";
import { fetchMarketStatus, resetPaperAccount, type MfScheme } from "./api";

const KIND_TO_KEYS: Record<string, string[]> = {
  market_status: ["status"],
  all_indices: ["indices"],
  gainers: ["gainers"],
  losers: ["losers"],
  gmp: ["gmp", "gmp-trends"],
  ipo_current: ["ipo-current"],
  ipo_upcoming: ["ipo-upcoming", "subhist"],
  fiidii: ["fiidii"],
};

function useSnapshotStream() {
  const qc = useQueryClient();
  const lastTs = useRef<Record<string, number>>({});
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      es = new EventSource("/api/stream");
      es.onmessage = (ev) => {
        try {
          const { kinds } = JSON.parse(ev.data) as { kinds: Record<string, number> };
          for (const [kind, ts] of Object.entries(kinds)) {
            if (lastTs.current[kind] && ts <= lastTs.current[kind]) continue;
            lastTs.current[kind] = ts;
            for (const key of KIND_TO_KEYS[kind] ?? []) {
              qc.invalidateQueries({ queryKey: [key] });
            }
          }
        } catch {
          /* malformed frame — ignore */
        }
      };
      es.onerror = () => {
        es?.close();
        if (!closed) retry = setTimeout(connect, 5000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [qc]);
}

function TabIcon({ id }: { id: TabId }) {
  const cls = "h-3.5 w-3.5 shrink-0";
  if (id === "market")
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 17l5-6 4 4 6-8" />
        <path strokeLinecap="round" d="M18 6h3v3" />
      </svg>
    );
  if (id === "ipos")
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 17L17 7M9 7h8v8" />
      </svg>
    );
  if (id === "gmp")
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 12h4l3 8 4-16 3 8h4" />
      </svg>
    );
  if (id === "portfolio")
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 8a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z" />
        <path strokeLinecap="round" d="M3 10h18" />
      </svg>
    );
  if (id === "trades")
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V8m0 0L4 11m3-3l3 3M17 8v8m0 0l3-3m-3 3l-3-3" />
      </svg>
    );
  if (id === "allotment")
    return (
      <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  return (
    <svg className={cls} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path strokeLinecap="round" d="M12 8v4l2.5 2.5" />
    </svg>
  );
}

const TABS = [
  { id: "market", label: "Market" },
  { id: "ipos", label: "IPOs & Subscription" },
  { id: "gmp", label: "GMP Trends" },
  { id: "trades", label: "Trades" },
  { id: "allotment", label: "Allotment" },
  { id: "portfolio", label: "Portfolio" },
  { id: "mf", label: "Mutual Funds" },
] as const;

type TabId = (typeof TABS)[number]["id"];
type Theme = "light" | "dark";

function getInitialTheme(): Theme {
  const saved = localStorage.getItem("axewatch-theme");
  return saved === "light" || saved === "dark" ? saved : "dark";
}

export default function App() {
  const [tab, setTab] = useState<TabId>("market");
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [globalStock, setGlobalStock] = useState<string | null>(null);
  const [globalMf, setGlobalMf] = useState<MfScheme | null>(null);

  const qc = useQueryClient();
  useSnapshotStream();
  const { data: status } = useQuery({
    queryKey: ["status"],
    queryFn: fetchMarketStatus,
    refetchInterval: 120_000,
  });
  const state = status?.data.marketState?.[0];
  const open = state?.marketStatus === "Open";
  const syncedAgo = status ? Math.max(0, Math.floor(Date.now() / 1000 - status.fetched_at)) : null;

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("axewatch-theme", theme);
  }, [theme]);

  // Global Ctrl+K shortcut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleResetPaper = async () => {
    if (window.confirm("Reset paper trading balance to ₹10,00,000 and clear all positions?")) {
      try {
        await resetPaperAccount();
        qc.invalidateQueries({ queryKey: ["paper"] });
        qc.invalidateQueries({ queryKey: ["paper-equity-history"] });
      } catch (err) {
        console.error("Failed to reset paper trading account", err);
      }
    }
  };

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <header className="sticky top-0 z-40 -mx-4 mb-4 border-b border-zinc-200/70 bg-zinc-100/80 px-4 py-2.5 backdrop-blur-md sm:-mx-6 sm:px-6 dark:border-zinc-800/70 dark:bg-zinc-950/80">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-sm transition-colors hover:bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
          >
            {theme === "dark" ? (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <circle cx="12" cy="12" r="4" />
                <path strokeLinecap="round" d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
              </svg>
            ) : (
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z" />
              </svg>
            )}
          </button>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <svg className="h-5 w-5 text-emerald-500" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2l8 8-8 12L4 10l8-8z" opacity="0.9" />
              <path d="M12 6l4.5 4.5L12 17 7.5 10.5 12 6z" fill="white" opacity="0.85" />
            </svg>
            Axe<span className="-ml-2 text-emerald-500 dark:text-emerald-400">watch</span>
          </h1>
          {state && (
            <span
              title={state.tradeDate ? `Trade date ${state.tradeDate}` : undefined}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                open
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-rose-500/10 text-rose-600 dark:text-rose-400"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${open ? "pulse-dot bg-emerald-400" : "bg-rose-400"}`} />
              {open ? "Open" : "Closed"}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Quick Search / Command Palette trigger */}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="flex items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-xs text-zinc-500 shadow-sm transition-colors hover:border-emerald-500 hover:text-zinc-800 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700 dark:hover:text-zinc-200"
            title="Global Search (Ctrl+K)"
          >
            <span className="hidden sm:inline">Search stocks, funds, IPOs…</span>
            <span className="sm:hidden">Search…</span>
            <kbd className="rounded border border-zinc-300 bg-zinc-100 px-1 py-0.5 font-mono text-[10px] text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800">
              Ctrl K
            </kbd>
          </button>

          <span className="tnum text-xs text-zinc-500 dark:text-zinc-600">
            {syncedAgo != null ? `synced ${syncedAgo < 60 ? `${syncedAgo}s` : `${Math.floor(syncedAgo / 60)}m`} ago` : "connecting…"}
          </span>
        </div>
        </div>
      </header>

      <nav aria-label="Primary" className="nice-scroll mb-4 flex gap-1 overflow-x-auto rounded-2xl border border-zinc-200 bg-white/90 p-1 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/60">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-current={tab === t.id ? "page" : undefined}
            onClick={() => setTab(t.id)}
            className={`flex min-w-fit flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
              tab === t.id
                ? "bg-emerald-500/15 text-emerald-600 ring-1 ring-emerald-500/30 dark:text-emerald-400"
                : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200"
            }`}
          >
            <TabIcon id={t.id} />
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "market" && (
        <ErrorBoundary label="Market">
          <MarketPage />
        </ErrorBoundary>
      )}
      {tab === "ipos" && (
        <ErrorBoundary label="IPOs">
          <IposPage />
        </ErrorBoundary>
      )}
      {tab === "gmp" && (
        <ErrorBoundary label="GMP">
          <GmpPage />
        </ErrorBoundary>
      )}
      {tab === "trades" && (
        <ErrorBoundary label="Trades">
          <TradesPage />
        </ErrorBoundary>
      )}
      {tab === "allotment" && (
        <ErrorBoundary label="Allotment">
          <AllotmentPage />
        </ErrorBoundary>
      )}
      {tab === "portfolio" && (
        <ErrorBoundary label="Portfolio">
          <PortfolioPage />
        </ErrorBoundary>
      )}
      {tab === "mf" && (
        <ErrorBoundary label="Mutual Funds">
          <MfPage />
        </ErrorBoundary>
      )}

      {/* Global Command Palette */}
      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onSelectStock={(sym) => setGlobalStock(sym)}
        onSelectMf={(scheme) => setGlobalMf(scheme)}
        onSelectTab={(tId) => setTab(tId)}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        onResetPaper={handleResetPaper}
      />

      {/* Global Stock Modal from palette */}
      {globalStock && (
        <StockDetailModal symbol={globalStock} onClose={() => setGlobalStock(null)} />
      )}

      {/* Global MF Modal from palette */}
      {globalMf && (
        <FundModal scheme={globalMf} onClose={() => setGlobalMf(null)} />
      )}

      <footer className="pt-4 pb-6 text-center text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-600">
        Data from NSE India (unofficial) and public GMP trackers · refreshes automatically · for research only, not investment advice
        <span className="mt-1 block">Press Ctrl K to search anything · theme, tabs and paper reset live in the palette</span>
      </footer>
    </main>
  );
}
