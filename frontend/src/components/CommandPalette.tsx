import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchCurrentIpos,
  fetchUpcomingIpos,
  mfSearch,
  stockSearch,
  type MfScheme,
  type StockSuggestion,
} from "../api";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectStock: (symbol: string) => void;
  onSelectMf: (scheme: MfScheme) => void;
  onSelectTab: (tabId: "market" | "ipos" | "gmp" | "trades" | "allotment" | "portfolio" | "mf") => void;
  onToggleTheme: () => void;
  onResetPaper: () => void;
}

type PaletteItem =
  | { kind: "stock"; symbol: string; name: string }
  | { kind: "mf"; code: string; name: string }
  | { kind: "ipo"; symbol: string; name: string; status: string }
  | { kind: "nav"; tabId: "market" | "ipos" | "gmp" | "trades" | "allotment" | "portfolio" | "mf"; label: string; hint: string }
  | { kind: "action"; id: string; label: string; hint: string };

const NAV_ITEMS: { tabId: "market" | "ipos" | "gmp" | "trades" | "allotment" | "portfolio" | "mf"; label: string; hint: string }[] = [
  { tabId: "market", label: "Market Overview", hint: "NIFTY 50, gainers, losers, sector heatmap" },
  { tabId: "ipos", label: "IPOs & Subscription", hint: "Live IPO demand, QIB/HNI/Retail breakdown" },
  { tabId: "gmp", label: "GMP Trends", hint: "Grey Market Premium movements & past performance" },
  { tabId: "trades", label: "Trade Ideas", hint: "Model signals with risk-sized paper orders" },
  { tabId: "allotment", label: "IPO Allotment", hint: "Check allotment across PANs via registrars" },
  { tabId: "portfolio", label: "Portfolio & Paper Trading", hint: "Holdings valuation, P&L, simulated trading" },
  { tabId: "mf", label: "Mutual Fund Explorer", hint: "NAV tracking, top holdings, asset allocation" },
];

export function CommandPalette({
  isOpen,
  onClose,
  onSelectStock,
  onSelectMf,
  onSelectTab,
  onToggleTheme,
  onResetPaper,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced search query
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(t);
  }, [query]);

  // Stock search
  const stockQ = useQuery({
    queryKey: ["palette-stocks", debounced],
    queryFn: () => stockSearch(debounced),
    enabled: isOpen && debounced.length >= 2,
    staleTime: 60_000,
  });

  // MF search
  const mfQ = useQuery({
    queryKey: ["palette-mf", debounced],
    queryFn: () => mfSearch(debounced),
    enabled: isOpen && debounced.length >= 3,
    staleTime: 60_000,
  });

  // IPO lists
  const ipoCurrentQ = useQuery({ queryKey: ["ipo-current"], queryFn: fetchCurrentIpos, enabled: isOpen });
  const ipoUpcomingQ = useQuery({ queryKey: ["ipo-upcoming"], queryFn: fetchUpcomingIpos, enabled: isOpen });

  const allIpos = useMemo(() => {
    const curr = ipoCurrentQ.data?.data.ipos ?? [];
    const up = ipoUpcomingQ.data?.data.ipos ?? [];
    return [...curr, ...up];
  }, [ipoCurrentQ.data, ipoUpcomingQ.data]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = debounced.toLowerCase();
    const list: PaletteItem[] = [];

    // 1. Matched Navigation items
    const matchedNav = NAV_ITEMS.filter(
      (n) => !q || n.label.toLowerCase().includes(q) || n.hint.toLowerCase().includes(q)
    );
    for (const n of matchedNav) {
      list.push({ kind: "nav", tabId: n.tabId, label: n.label, hint: n.hint });
    }

    // 2. Matched Actions
    if (!q || "theme dark light mode toggle".includes(q)) {
      list.push({ kind: "action", id: "theme", label: "Toggle Theme", hint: "Switch between Dark and Light appearance" });
    }
    if (!q || "reset paper trading restart clear account".includes(q)) {
      list.push({ kind: "action", id: "reset_paper", label: "Reset Paper Trading", hint: "Clear simulated positions and restore ₹10,00,000 cash" });
    }

    // 3. Matched Stocks
    const stockResults: StockSuggestion[] = stockQ.data?.data.results ?? [];
    for (const s of stockResults.slice(0, 5)) {
      list.push({ kind: "stock", symbol: s.symbol, name: s.name });
    }

    // 4. Matched IPOs
    if (q) {
      const matchedIpos = allIpos.filter(
        (ip) =>
          (ip.name && ip.name.toLowerCase().includes(q)) ||
          (ip.symbol && ip.symbol.toLowerCase().includes(q))
      );
      for (const ip of matchedIpos.slice(0, 4)) {
        list.push({
          kind: "ipo",
          symbol: ip.symbol ?? "",
          name: ip.name ?? ip.symbol ?? "IPO",
          status: ip.status ?? (ip.total_x != null ? `${ip.total_x.toFixed(1)}x` : "Active"),
        });
      }
    }

    // 5. Matched Mutual Funds
    const mfResults = mfQ.data?.data.results ?? [];
    for (const m of mfResults.slice(0, 4)) {
      list.push({ kind: "mf", code: m.code, name: m.name });
    }

    return list;
  }, [debounced, stockQ.data, mfQ.data, allIpos]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
      setQuery("");
    }
  }, [isOpen]);

  const handleSelect = (item: PaletteItem) => {
    onClose();
    if (item.kind === "stock") {
      onSelectStock(item.symbol);
    } else if (item.kind === "mf") {
      onSelectMf({ code: item.code, name: item.name });
    } else if (item.kind === "ipo") {
      onSelectTab("ipos");
    } else if (item.kind === "nav") {
      onSelectTab(item.tabId);
    } else if (item.kind === "action") {
      if (item.id === "theme") onToggleTheme();
      else if (item.id === "reset_paper") onResetPaper();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => (i + 1) % Math.max(1, items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => (i - 1 + items.length) % Math.max(1, items.length));
    } else if (e.key === "Enter" && items[selectedIndex]) {
      e.preventDefault();
      handleSelect(items[selectedIndex]);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 pt-16 backdrop-blur-sm sm:pt-24"
      onClick={onClose}
    >
      <div
        className="animate-pop w-full max-w-xl overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl transition-all dark:border-zinc-800 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input Bar */}
        <div className="flex items-center border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <svg className="mr-3 h-4 w-4 text-zinc-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search stocks, mutual funds, IPOs, or actions…"
            className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="mr-2 text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
            >
              ✕
            </button>
          )}
          <kbd className="rounded border border-zinc-300 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500 dark:border-zinc-700">
            Esc
          </kbd>
        </div>

        {/* Results List */}
        <div className="nice-scroll max-h-96 overflow-y-auto p-2">
          {items.length === 0 ? (
            <div className="py-8 text-center text-xs text-zinc-500">
              No matching stocks, funds, or commands found
            </div>
          ) : (
            <div className="space-y-1">
              {items.map((item, idx) => {
                const active = idx === selectedIndex;
                return (
                  <button
                    key={`${item.kind}-${idx}`}
                    type="button"
                    onClick={() => handleSelect(item)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                      active
                        ? "bg-emerald-500/15 text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300"
                        : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/60"
                    }`}
                  >
                    {/* Badge */}
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-wide ${
                        item.kind === "stock"
                          ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
                          : item.kind === "mf"
                            ? "bg-violet-500/15 text-violet-600 dark:text-violet-400"
                            : item.kind === "ipo"
                              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
                              : item.kind === "nav"
                                ? "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                                : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      }`}
                    >
                      {item.kind}
                    </span>

                    {/* Content */}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-semibold">
                        {item.kind === "stock"
                          ? item.symbol
                          : item.kind === "mf"
                            ? item.name
                            : item.kind === "ipo"
                              ? item.name
                              : item.label}
                      </div>
                      <div className="truncate text-[11px] text-zinc-500">
                        {item.kind === "stock"
                          ? item.name
                          : item.kind === "mf"
                            ? `Scheme code ${item.code}`
                            : item.kind === "ipo"
                              ? `IPO · ${item.status}`
                              : item.hint}
                      </div>
                    </div>

                    {active && (
                      <span className="font-mono text-xs text-emerald-600 dark:text-emerald-400">
                        →
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer info bar */}
        <div className="flex items-center justify-between border-t border-zinc-100 bg-zinc-50 px-4 py-2 text-[10px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950/60">
          <span>Navigate with Up / Down · Press Enter to open</span>
          <span>Axewatch Command Palette</span>
        </div>
      </div>
    </div>
  );
}
