import { UXTheme } from "../../lib/theme";
import { BarChart2, Zap, RefreshCw, CheckCircle2, AlertCircle } from "lucide-react";
import { AnalysisGameStats, QualityFilterKey } from "../../components/chessboard/ResponsiveChessboard";

const TERMINATION_LABELS: Record<string, { badge: string; full: string }> = {
  MANUAL_RESIGN: { badge: "Resigned", full: "Manual Resignation" },
  TIME_FORFEIT: { badge: "Time Forfeit", full: "Time Forfeit" },
  EVAL_ADJUDICATED: { badge: "Adjudicated", full: "Evaluation Threshold" },
  CHECKMATE: { badge: "Checkmate", full: "Checkmate" },
  STALEMATE: { badge: "Stalemate", full: "Stalemate" },
  DRAW_INSUFFICIENT: { badge: "Draw", full: "Insufficient Material" },
  DRAW_REPETITION: { badge: "Draw", full: "Threefold Repetition" },
  DRAW_FIFTY: { badge: "Draw", full: "Fifty-Move Rule" },
  DRAW: { badge: "Draw", full: "Draw" },
};

interface GameStatsPanelProps {
  stats?: AnalysisGameStats;
  gameDetails?: {
    white?: string;
    black?: string;
    white_elo?: string;
    black_elo?: string;
    result?: string;
    event?: string;
    date?: string;
    eco?: string;
    opening?: string;
    termination?: string | null;
    final_eval?: string | null;
    eval_source?: string | null;
    player_acpl?: number | null;
    engine_acpl?: number | null;
  } | null;
  uxTheme: UXTheme;
  isAnalyzingFullGame?: boolean;
  analysisProgress?: { current: number; total: number } | null;
  onRunFullAnalysis?: () => void;
  /** Currently active move-quality filter (null/undefined = show all moves). */
  activeQualityFilter?: QualityFilterKey | null;
  /** Called when a Move Quality tile is clicked; null clears the filter. */
  onQualityFilterChange?: (key: QualityFilterKey | null) => void;
}

export function GameStatsPanel({
  stats,
  gameDetails,
  uxTheme,
  isAnalyzingFullGame,
  analysisProgress,
  onRunFullAnalysis,
  activeQualityFilter,
  onQualityFilterChange,
}: GameStatsPanelProps) {
  const isLight = uxTheme.mode === "light";

  const termination = stats?.termination || gameDetails?.termination;
  const rawFinalEval = (stats?.finalEval || gameDetails?.final_eval || "").trim();
  const rawEvalSource = (stats?.evalSource || gameDetails?.eval_source || "").trim();
  const cleanEvalSource =
    rawEvalSource && rawEvalSource.toUpperCase() !== "NONE" ? rawEvalSource : null;
  const finalEval =
    rawFinalEval && rawFinalEval.toUpperCase() !== "NONE"
      ? rawFinalEval
      : null;
  const playerAcpl = stats?.playerAcpl ?? gameDetails?.player_acpl;
  const engineAcpl = stats?.engineAcpl ?? gameDetails?.engine_acpl;

  const hasAnalysis =
    (stats?.hasEngineAnalysis ?? false) ||
    playerAcpl != null ||
    engineAcpl != null;

  const whiteAcpl = stats?.whiteAcpl ?? (playerAcpl != null ? playerAcpl : undefined);
  const blackAcpl = stats?.blackAcpl ?? (engineAcpl != null ? engineAcpl : undefined);
  const whiteAccuracy = stats?.whiteAccuracy ?? (whiteAcpl !== undefined ? Math.max(35, Math.min(100, Math.round(100 - whiteAcpl * 0.35))) : undefined);
  const blackAccuracy = stats?.blackAccuracy ?? (blackAcpl !== undefined ? Math.max(35, Math.min(100, Math.round(100 - blackAcpl * 0.35))) : undefined);

  const totalMoves = stats?.totalMoves ?? 0;
  const totalPlies = stats?.totalPlies ?? 0;

  const blunderCount = stats?.blunderCount ?? 0;
  const mistakeCount = stats?.mistakeCount ?? 0;
  const inaccuracyCount = stats?.inaccuracyCount ?? 0;
  const goodCount = stats?.goodCount ?? 0;
  const bestCount = stats?.bestCount ?? 0;
  const bookCount = stats?.bookCount ?? 0;
  const tacticalCount = stats?.tacticalCount ?? 0;

  const resultStr = gameDetails?.result || "*";
  const isWhiteWin = resultStr === "1-0";
  const isBlackWin = resultStr === "0-1";

  const qualityTiles: Array<{
    key: QualityFilterKey;
    label: string;
    title: string;
    count: number;
    fallback?: string | number;
    span?: string;
    valueClass?: string;
    light: string;
    dark: string;
  }> = [
    { key: "best", label: "✨ Best", title: "Best Moves", count: bestCount, light: "bg-emerald-50 border-emerald-200 text-emerald-950", dark: "bg-emerald-950/30 border-emerald-500/30 text-emerald-300" },
    { key: "good", label: "✓ Good", title: "Good Moves", count: goodCount, fallback: totalPlies, light: "bg-cyan-50 border-cyan-200 text-cyan-950", dark: "bg-cyan-950/30 border-cyan-500/30 text-cyan-300" },
    { key: "book", label: "📖 Book", title: "Theory Book Moves", count: bookCount, fallback: bookCount, light: "bg-purple-50 border-purple-200 text-purple-950", dark: "bg-purple-950/30 border-purple-500/30 text-purple-300" },
    { key: "tactical", label: "⚡ Tactic", title: "Decisive Tactical Combinations", count: tacticalCount, light: "bg-indigo-50 border-indigo-200 text-indigo-950", dark: "bg-indigo-950/30 border-indigo-500/30 text-indigo-300" },
    { key: "inaccuracy", label: "?! Inacc", title: "Inaccuracies", count: inaccuracyCount, light: "bg-yellow-50 border-yellow-200 text-yellow-950", dark: "bg-yellow-950/30 border-yellow-500/30 text-yellow-300" },
    { key: "mistake", label: "? Mistake", title: "Mistakes", count: mistakeCount, light: "bg-orange-50 border-orange-200 text-orange-950", dark: "bg-orange-950/30 border-orange-500/30 text-orange-300" },
    { key: "blunder", label: "?? Blunders", title: "Blunders", count: blunderCount, span: "col-span-2", valueClass: "text-rose-600 dark:text-rose-400", light: "bg-red-50 border-red-200 text-red-950", dark: "bg-red-950/30 border-red-500/30 text-red-300" },
  ];

  return (
    <div
      className={`rounded-3xl border p-4 shadow-2xl flex flex-col transition-colors duration-200 ${uxTheme.panel} ${uxTheme.border}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <BarChart2 className="w-4 h-4 text-emerald-400" />
          <h2
            className={`font-extrabold text-xs uppercase tracking-wider ${
              isLight ? "text-slate-900" : "text-white"
            }`}
          >
            Game Stats
          </h2>
        </div>

        <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
          {totalMoves} Moves ({totalPlies} Plies)
        </span>
      </div>

      {/* Post-Match Adjudication & Telemetry Summary Banner */}
      {(termination || finalEval) && (
        <div
          className={`p-3 rounded-2xl border mb-3 flex flex-col gap-2 font-mono text-xs ${
            isLight
              ? "bg-emerald-500/10 border-emerald-300/60 text-emerald-950"
              : "bg-emerald-950/25 border-emerald-500/30 text-emerald-200"
          }`}
        >
          <div className="flex items-center justify-between">
            <span className="font-extrabold uppercase tracking-wide flex items-center gap-1.5 text-[11px]">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              Match Adjudication
            </span>
            {termination && (
              <span className="text-[10px] font-black px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30">
                {termination ? TERMINATION_LABELS[termination]?.badge ?? termination : ""}
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px] pt-1 border-t border-emerald-500/20">
            <div>
              <span className="opacity-70 text-[10px] block">Termination</span>
              <span className="font-bold">
                {termination ? TERMINATION_LABELS[termination]?.full ?? termination : "Standard"}
              </span>
            </div>
            <div>
              <span className="opacity-70 text-[10px] block">Final Evaluation</span>
              <span className="font-bold">
                {finalEval || "—"}
                {cleanEvalSource && (
                  <span className="text-[9px] opacity-75 font-normal ml-1">({cleanEvalSource})</span>
                )}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Accuracy & ACPL Head-to-Head */}
      {hasAnalysis ? (
        <div className="grid grid-cols-2 gap-2 mb-3">
          {/* White Player Stats */}
          <div
            className={`p-2.5 rounded-2xl border flex flex-col justify-between ${
              isLight
                ? "bg-slate-100/90 border-slate-300 text-slate-900"
                : "bg-black/40 border-white/10 text-white"
            } ${isWhiteWin ? "ring-1 ring-emerald-500/50" : ""}`}
          >
            <div className="flex items-center justify-between text-[11px] font-bold mb-1">
              <span className="truncate max-w-[90px]">{gameDetails?.white || "White"}</span>
              {isWhiteWin && <span className="text-[10px] text-emerald-500 font-black">WIN</span>}
            </div>
            <div className="flex items-baseline justify-between font-mono">
              <span className="text-lg font-black text-emerald-600 dark:text-emerald-400">
                {whiteAccuracy !== undefined ? `${whiteAccuracy}%` : "—"}
              </span>
              <span className="text-[10px] text-slate-500 dark:text-slate-400 font-bold">
                {whiteAcpl !== undefined ? `${whiteAcpl} cp loss` : "—"}
              </span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-slate-700/30 mt-1 overflow-hidden">
              <div
                className="h-full bg-emerald-500 rounded-full"
                style={{ width: `${whiteAccuracy ?? 0}%` }}
              />
            </div>
          </div>

          {/* Black Player Stats */}
          <div
            className={`p-2.5 rounded-2xl border flex flex-col justify-between ${
              isLight
                ? "bg-slate-100/90 border-slate-300 text-slate-900"
                : "bg-black/40 border-white/10 text-white"
            } ${isBlackWin ? "ring-1 ring-cyan-500/50" : ""}`}
          >
            <div className="flex items-center justify-between text-[11px] font-bold mb-1">
              <span className="truncate max-w-[90px]">{gameDetails?.black || "Black"}</span>
              {isBlackWin && <span className="text-[10px] text-cyan-500 font-black">WIN</span>}
            </div>
            <div className="flex items-baseline justify-between font-mono">
              <span className="text-lg font-black text-cyan-600 dark:text-cyan-400">
                {blackAccuracy !== undefined ? `${blackAccuracy}%` : "—"}
              </span>
              <span className="text-[10px] text-slate-500 dark:text-slate-400 font-bold">
                {blackAcpl !== undefined ? `${blackAcpl} cp loss` : "—"}
              </span>
            </div>
            <div className="w-full h-1.5 rounded-full bg-slate-700/30 mt-1 overflow-hidden">
              <div
                className="h-full bg-cyan-500 rounded-full"
                style={{ width: `${blackAccuracy ?? 0}%` }}
              />
            </div>
          </div>
        </div>
      ) : (
        /* Unanalyzed Game Banner */
        <div
          className={`p-3 rounded-2xl border mb-3 flex flex-col gap-2.5 ${
            isLight
              ? "bg-amber-500/10 border-amber-300/60 text-amber-950"
              : "bg-amber-950/25 border-amber-500/30 text-amber-200"
          }`}
        >
          <div className="flex items-center justify-between text-xs font-mono">
            <div className="flex items-center gap-1.5 font-bold">
              <AlertCircle className="w-4 h-4 text-amber-500" />
              <span>Unanalyzed Game Record</span>
            </div>
            <span className="text-[10px] font-bold opacity-80 font-mono">Raw PGN</span>
          </div>

          <p className="text-[11px] leading-relaxed opacity-90">
            This match was loaded from an un-evaluated database. Run engine evaluation to calculate genuine ACPL, accuracy percentages, and blunder/tactical breakdown.
          </p>

          {onRunFullAnalysis && (
            <button
              onClick={onRunFullAnalysis}
              disabled={isAnalyzingFullGame}
              className="w-full py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-extrabold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {isAnalyzingFullGame ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>
                    Analyzing Plies {analysisProgress?.current ?? 0}/{analysisProgress?.total ?? totalPlies}...
                  </span>
                </>
              ) : (
                <>
                  <Zap className="w-3.5 h-3.5 text-amber-300" />
                  <span>⚡ Run Full Game Analysis</span>
                </>
              )}
            </button>
          )}
        </div>
      )}

      {/* Move Quality Distribution Grid */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between px-1 text-[11px] font-mono font-bold">
          <span className={isLight ? "text-slate-600" : "text-slate-400"}>
            Move Quality Breakdown
          </span>
          {hasAnalysis && (
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-extrabold">
              <CheckCircle2 className="w-3 h-3" /> Evaluated
            </span>
          )}
        </div>

        <div className="grid grid-cols-4 gap-1.5 text-center font-mono">
          {qualityTiles.map((tile) => {
            const isActive = activeQualityFilter === tile.key;
            const clickable = !!onQualityFilterChange && hasAnalysis;
            return (
              <button
                key={tile.key}
                type="button"
                disabled={!clickable}
                onClick={() => onQualityFilterChange?.(isActive ? null : tile.key)}
                aria-pressed={isActive}
                className={`p-1.5 rounded-xl border flex flex-col items-center transition-all ${tile.span ?? ""} ${
                  isLight ? tile.light : tile.dark
                } ${clickable ? "cursor-pointer hover:brightness-110 active:scale-95" : "cursor-default"} ${
                  isActive ? "ring-2 ring-offset-0 ring-emerald-400 shadow-lg scale-[1.03]" : activeQualityFilter ? "opacity-50" : ""
                }`}
                title={clickable ? `${tile.title} — click to ${isActive ? "clear filter" : "show only these moves"}` : tile.title}
              >
                <span className="text-[10px] font-bold opacity-80 flex items-center gap-0.5">{tile.label}</span>
                <span className={`text-sm font-black ${tile.valueClass ?? ""}`}>{hasAnalysis ? tile.count : tile.fallback ?? "—"}</span>
              </button>
            );
          })}
        </div>
        {activeQualityFilter && onQualityFilterChange && (
          <button
            type="button"
            onClick={() => onQualityFilterChange(null)}
            className="w-full text-[10px] font-mono font-bold py-1 rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/25 cursor-pointer"
          >
            Showing only {qualityTiles.find((t) => t.key === activeQualityFilter)?.title} — clear filter
          </button>
        )}
      </div>
    </div>
  );
}
