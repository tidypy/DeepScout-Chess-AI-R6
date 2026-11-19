import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Chessboard } from "react-chessboard";
import { Chess } from "chess.js";
import {
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  RotateCcw,
  Play,
  Pause,
  ArrowUpDown,
  Copy,
  Check,
  Bot,
  Settings2,
  Bookmark,
  X,
  RefreshCw,
  Zap,
} from "lucide-react";
import {
  fetchEngineVariations,
  fetchEngineList,
  logKibitzerVariation,
  saveVariationToGamePgn,
  startParallelAnalysisJob,
  fetchParallelAnalysisJob,
  cancelParallelAnalysisJob,
  AnalysisPresetKey,
  EngineInfo,
  VariationLine,
} from "../../lib/api";
import { useClickLogger } from "../../lib/clickLogger";
import { Tooltip } from "../common/Tooltip";
import { UXTheme, BoardTheme } from "../../lib/theme";
import { customChessPieces } from "./customPieces";
import { EvalSparkline } from "../../features/analysis/EvalSparkline";
import { estimatePerformanceElo } from "../../lib/performanceElo";

export interface MoveAnnotation {
  ply: number;
  san: string;
  eval?: string;
  evalCp?: number;
  cpLoss?: number;
  tag?: "best" | "brilliant" | "tactical" | "good" | "inaccuracy" | "mistake" | "blunder" | "book";
  badge?: string;
  badgeLabel?: string;
  comment?: string;
  bestMoveSan?: string;
  pvSan?: string;
}

export interface AnalysisGameStats {
  hasEngineAnalysis: boolean;
  whiteAcpl?: number;
  blackAcpl?: number;
  whiteAccuracy?: number;
  blackAccuracy?: number;
  totalPlies: number;
  totalMoves: number;
  blunderCount: number;
  mistakeCount: number;
  inaccuracyCount: number;
  goodCount: number;
  bestCount: number;
  bookCount: number;
  tacticalCount: number;
  termination?: string;
  finalEval?: string;
  evalSource?: string;
  playerAcpl?: number;
  engineAcpl?: number;
  /** Engine-evaluated performance Elo estimate derived from ACPL (not the PGN header Elo). */
  whitePerfElo?: number;
  blackPerfElo?: number;
}

/** Move-quality filter keys used by the Game Stats tiles and the move table. */
export type QualityFilterKey = "best" | "good" | "book" | "tactical" | "inaccuracy" | "mistake" | "blunder";

/** True when an annotated move belongs to the given quality filter bucket (mirrors stats counting). */
export const moveMatchesQualityFilter = (tag: string | undefined, key: QualityFilterKey): boolean =>
  key === "best" ? tag === "best" || tag === "brilliant" : tag === key;

export interface ResponsiveChessboardProps {
  pgn?: string;
  initialFen?: string;
  gameId?: number | string;
  dbName?: string;
  boardTheme: BoardTheme;
  uxTheme: UXTheme;
  onPositionChange?: (fen: string) => void;
  onLiveEvalChange?: (info: { evalStr: string; mainLine: string }) => void;
  onUciLog?: (logs: string[], options?: Record<string, any>) => void;
  onStatsChange?: (stats: AnalysisGameStats) => void;
  onGamePersisted?: () => void;
  isAnalyzingFullGame?: boolean;
  analysisProgress?: { current: number; total: number } | null;
  onRunFullAnalysis?: () => void;
  /** When set, the move table only lists/highlights moves of this quality. */
  qualityFilter?: QualityFilterKey | null;
  onQualityFilterChange?: (key: QualityFilterKey | null) => void;
  /** Increment to start a full-game parallel evaluation from outside (e.g. "Evaluate Game" or Gear apply). */
  runAnalysisSignal?: number;
  /** Active preset key ("quick" | "narrow" | "deep" | "thorough" | "custom"). */
  analyzerPreset?: AnalysisPresetKey;
  /** Engine search depth fallback used if preset is unspecified (default 18). */
  analysisDepth?: number;
  /** Race-safe post-sparring auto-analyze token consumed once target game hydrates. */
  pendingAutoAnalyze?: { db: string; gameId: string | number; nonce: number } | null;
  onConsumeAutoAnalyze?: () => void;
  /** Reports parallel batch-evaluation progress to the parent. */
  onAnalysisStateChange?: (state: { running: boolean; progress: { current: number; total: number } | null }) => void;
}

export const getMoveBadgeStyle = (tag?: string) => {
  switch (tag) {
    case "brilliant":
      return "bg-amber-500/20 text-amber-500 dark:text-amber-300 border border-amber-500/40 shadow-sm";
    case "best":
      return "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40 font-black";
    case "good":
      return "bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 border border-cyan-500/30";
    case "book":
      return "bg-purple-500/20 text-purple-700 dark:text-purple-300 border border-purple-500/40 font-bold";
    case "inaccuracy":
      return "bg-yellow-500/25 text-yellow-800 dark:text-yellow-300 border border-yellow-500/50 font-bold";
    case "mistake":
      return "bg-orange-500/25 text-orange-800 dark:text-orange-300 border border-orange-500/50 font-black";
    case "blunder":
      return "bg-rose-500/25 text-rose-800 dark:text-rose-300 border border-rose-500/50 font-black";
    case "tactical":
      return "bg-indigo-500/25 text-indigo-700 dark:text-indigo-300 border border-indigo-500/40 font-bold";
    default:
      return "bg-slate-500/20 text-slate-700 dark:text-slate-300 border border-slate-500/30";
  }
};

function cleanPgnForChessJs(rawPgn: string): string {
  if (!rawPgn) return "";
  const lines = rawPgn.trim().split("\n");
  const headerLines: string[] = [];
  const bodyLines: string[] = [];
  let inHeader = true;

  for (const line of lines) {
    const trimmed = line.trim();
    if (inHeader) {
      if (trimmed.startsWith("[")) {
        headerLines.push(trimmed);
      } else if (trimmed === "") {
        inHeader = false;
      } else {
        inHeader = false;
        bodyLines.push(line);
      }
    } else {
      bodyLines.push(line);
    }
  }

  let body = bodyLines.join("\n");
  body = body.replace(/\[%[^\]]*\]/g, "");
  body = body.replace(/\{[^}]*\}/g, "");
  body = body.replace(/\s+/g, " ").trim();

  return [...headerLines, "", body].join("\n");
}

function parseFenStart(fen: string): { sideToMove: "w" | "b"; fullmove: number } {
  const parts = fen.trim().split(/\s+/);
  const sideToMove = parts[1] === "b" ? "b" : "w";
  const fullmove = parseInt(parts[5], 10) || 1;
  return { sideToMove, fullmove };
}

function parsePgnAnnotationsAndStats(
  rawPgn: string,
  moves: string[]
): { annotations: MoveAnnotation[]; stats: AnalysisGameStats } {
  if (!rawPgn || moves.length === 0) {
    return {
      annotations: [],
      stats: {
        hasEngineAnalysis: false,
        totalPlies: moves.length,
        totalMoves: Math.ceil(moves.length / 2),
        blunderCount: 0,
        mistakeCount: 0,
        inaccuracyCount: 0,
        goodCount: 0,
        bestCount: 0,
        bookCount: 0,
        tacticalCount: 0,
      },
    };
  }

  const annotations: MoveAnnotation[] = [];
  const lines = rawPgn.trim().split("\n");
  const bodyLines = lines.filter((l) => !l.trim().startsWith("[") || l.trim().startsWith("[%"));
  const fullBody = bodyLines.join(" ");

  let embeddedWhiteAcpl: number | undefined;
  let embeddedBlackAcpl: number | undefined;
  let embeddedWhiteAcc: number | undefined;
  let embeddedBlackAcc: number | undefined;

  let termination: string | undefined;
  let finalEval: string | undefined;
  let evalSource: string | undefined;
  let playerAcpl: number | undefined;
  let engineAcpl: number | undefined;

  const termMatch = rawPgn.match(/\[Termination\s+"([^"]+)"\]/i);
  if (termMatch) termination = termMatch[1];

  const evalMatch = rawPgn.match(/\[FinalEval\s+"([^"]+)"\]/i);
  if (evalMatch) finalEval = evalMatch[1];

  const sourceMatch = rawPgn.match(/\[EvalSource\s+"([^"]+)"\]/i);
  if (sourceMatch) evalSource = sourceMatch[1];

  const pAcplMatch = rawPgn.match(/\[PlayerACPL\s+"(\d+)"\]/i);
  if (pAcplMatch) playerAcpl = parseInt(pAcplMatch[1], 10);

  const eAcplMatch = rawPgn.match(/\[EngineACPL\s+"(\d+)"\]/i);
  if (eAcplMatch) engineAcpl = parseInt(eAcplMatch[1], 10);

  const whiteHeaderMatch = rawPgn.match(/\[White\s+"([^"]+)"\]/i);
  const isWhitePlayer = whiteHeaderMatch
    ? whiteHeaderMatch[1].toLowerCase().includes("player") ||
      whiteHeaderMatch[1].toLowerCase().includes("human") ||
      whiteHeaderMatch[1].toLowerCase().includes("user")
    : true;

  if (playerAcpl !== undefined && engineAcpl !== undefined) {
    if (isWhitePlayer) {
      if (embeddedWhiteAcpl === undefined) embeddedWhiteAcpl = playerAcpl;
      if (embeddedBlackAcpl === undefined) embeddedBlackAcpl = engineAcpl;
    } else {
      if (embeddedBlackAcpl === undefined) embeddedBlackAcpl = playerAcpl;
      if (embeddedWhiteAcpl === undefined) embeddedWhiteAcpl = engineAcpl;
    }
  }

  const acplMatch =
    rawPgn.match(/\[%acpl[^\]]*user="(\d+)"[^\]]*engine="(\d+)"/i) ||
    rawPgn.match(/\[%acpl[^\]]*white="(\d+)"[^\]]*black="(\d+)"/i);
  if (acplMatch) {
    embeddedWhiteAcpl = parseInt(acplMatch[1], 10);
    embeddedBlackAcpl = parseInt(acplMatch[2], 10);
  }

  const capsMatch = rawPgn.match(/\[%caps[^\]]*user_accuracy="(\d+)%?"[^\]]*engine_accuracy="(\d+)%?"/i);
  if (capsMatch) {
    embeddedWhiteAcc = parseInt(capsMatch[1], 10);
    embeddedBlackAcc = parseInt(capsMatch[2], 10);
  }

  const tokenRegex = /(?:(\d+)\.+)?\s*([a-hKQRBN][a-h1-8x+#=\-0-8\?!]+)(?:\s*\{([^}]*)\})?/g;
  let match: RegExpExecArray | null;

  const moveCommentMap: Array<{ san: string; comment: string }> = [];
  while ((match = tokenRegex.exec(fullBody)) !== null) {
    const rawSan = match[2];
    const comment = match[3] || "";
    if (["1-0", "0-1", "1/2-1/2", "*"].includes(rawSan)) continue;
    moveCommentMap.push({ san: rawSan, comment });
  }

  let blunderCount = 0;
  let mistakeCount = 0;
  let inaccuracyCount = 0;
  let goodCount = 0;
  let bestCount = 0;
  let bookCount = 0;
  let tacticalCount = 0;

  const whiteLosses: number[] = [];
  const blackLosses: number[] = [];
  let prevEvalCp: number | null = null;
  let hasFoundEval = false;

  for (let i = 0; i < moves.length; i++) {
    const cleanSan = moves[i];
    const foundData = moveCommentMap[i];
    const rawSan = foundData?.san || cleanSan;
    const comment = foundData?.comment || "";

    let evalStr: string | undefined;
    let evalCp: number | undefined;
    let tag: MoveAnnotation["tag"] = undefined;
    let badge = "";
    let badgeLabel = "";

    if (rawSan.includes("??")) {
      tag = "blunder";
      badge = "??";
      badgeLabel = "Blunder";
    } else if (rawSan.includes("?!")) {
      tag = "inaccuracy";
      badge = "?!";
      badgeLabel = "Inaccuracy";
    } else if (rawSan.includes("?")) {
      tag = "mistake";
      badge = "?";
      badgeLabel = "Mistake";
    } else if (rawSan.includes("!!")) {
      tag = "brilliant";
      badge = "!!";
      badgeLabel = "Brilliant";
    } else if (rawSan.includes("!")) {
      tag = "good";
      badge = "!";
      badgeLabel = "Good";
    }

    if (comment) {
      const evalM = comment.match(/\[%eval\s+([+-]?\d+\.?\d*|#[+-]?\d+)\]/i);
      if (evalM) {
        evalStr = evalM[1];
        hasFoundEval = true;
        if (!evalStr.startsWith("#")) {
          evalCp = Math.round(parseFloat(evalStr) * 100);
        }
      }

      if (comment.includes("book:") || comment.includes("[book") || comment.toLowerCase().includes("book")) {
        tag = "book";
        badge = "📖";
        badgeLabel = "Book Move";
      } else if (comment.toLowerCase().includes("blunder") || comment.includes("??")) {
        tag = "blunder";
        badge = "??";
        badgeLabel = "Blunder";
      } else if (comment.toLowerCase().includes("mistake") || comment.includes("?")) {
        tag = "mistake";
        badge = "?";
        badgeLabel = "Mistake";
      } else if (comment.toLowerCase().includes("tactic") || comment.includes("⚡")) {
        tag = "tactical";
        badge = "⚡";
        badgeLabel = "Tactical Blow";
      } else if (comment.toLowerCase().includes("best") || comment.includes("✨")) {
        tag = "best";
        badge = "✨";
        badgeLabel = "Best Move";
      }
    }

    let cpLoss = 0;
    const isWhite = i % 2 === 0;
    if (evalCp !== undefined) {
      if (prevEvalCp !== null) {
        cpLoss = isWhite ? Math.max(0, prevEvalCp - evalCp) : Math.max(0, evalCp - prevEvalCp);
        if (isWhite) whiteLosses.push(cpLoss);
        else blackLosses.push(cpLoss);

        if (!tag) {
          if (cpLoss <= 12) {
            tag = "best";
            badge = "✨";
            badgeLabel = "Best Move";
          } else if (cpLoss <= 35) {
            tag = "good";
            badge = "✓";
            badgeLabel = "Good Move";
          } else if (cpLoss <= 90) {
            tag = "inaccuracy";
            badge = "?!";
            badgeLabel = "Inaccuracy";
          } else if (cpLoss <= 200) {
            tag = "mistake";
            badge = "?";
            badgeLabel = "Mistake";
          } else {
            tag = "blunder";
            badge = "??";
            badgeLabel = "Blunder";
          }
        }
      }
      prevEvalCp = evalCp;
    }

    if (tag === "blunder") blunderCount++;
    else if (tag === "mistake") mistakeCount++;
    else if (tag === "inaccuracy") inaccuracyCount++;
    else if (tag === "best" || tag === "brilliant") bestCount++;
    else if (tag === "book") bookCount++;
    else if (tag === "tactical") tacticalCount++;
    else if (tag === "good") goodCount++;

    annotations.push({
      ply: i,
      san: cleanSan,
      eval: evalStr,
      evalCp,
      cpLoss,
      tag,
      badge,
      badgeLabel,
      comment,
    });
  }

  const hasAnalysis =
    hasFoundEval ||
    embeddedWhiteAcpl !== undefined ||
    playerAcpl !== undefined ||
    whiteLosses.length > 0;

  const calcWhiteAcpl = hasAnalysis
    ? whiteLosses.length > 0
      ? Math.round(whiteLosses.reduce((a, b) => a + b, 0) / whiteLosses.length)
      : embeddedWhiteAcpl
    : undefined;

  const calcBlackAcpl = hasAnalysis
    ? blackLosses.length > 0
      ? Math.round(blackLosses.reduce((a, b) => a + b, 0) / blackLosses.length)
      : embeddedBlackAcpl
    : undefined;

  const whiteAccuracy = hasAnalysis
    ? embeddedWhiteAcc ?? (calcWhiteAcpl !== undefined ? Math.max(35, Math.min(100, Math.round(100 - calcWhiteAcpl * 0.35))) : undefined)
    : undefined;

  const blackAccuracy = hasAnalysis
    ? embeddedBlackAcc ?? (calcBlackAcpl !== undefined ? Math.max(35, Math.min(100, Math.round(100 - calcBlackAcpl * 0.35))) : undefined)
    : undefined;

  return {
    annotations,
    stats: {
      hasEngineAnalysis: hasAnalysis,
      whiteAcpl: calcWhiteAcpl,
      blackAcpl: calcBlackAcpl,
      whiteAccuracy,
      blackAccuracy,
      totalPlies: moves.length,
      totalMoves: Math.ceil(moves.length / 2),
      blunderCount,
      mistakeCount,
      inaccuracyCount,
      goodCount,
      bestCount,
      bookCount,
      tacticalCount,
      termination,
      finalEval,
      evalSource,
      playerAcpl,
      engineAcpl,
      whitePerfElo: whiteLosses.length > 0 ? estimatePerformanceElo(calcWhiteAcpl, whiteLosses.length) : undefined,
      blackPerfElo: blackLosses.length > 0 ? estimatePerformanceElo(calcBlackAcpl, blackLosses.length) : undefined,
    },
  };
}

export function ResponsiveChessboard({
  pgn,
  initialFen,
  gameId,
  dbName,
  boardTheme,
  uxTheme,
  onPositionChange,
  onLiveEvalChange,
  onUciLog,
  onStatsChange,
  onGamePersisted,
  qualityFilter,
  onQualityFilterChange,
  runAnalysisSignal,
  analyzerPreset,
  analysisDepth,
  pendingAutoAnalyze,
  onConsumeAutoAnalyze,
  onAnalysisStateChange,
}: ResponsiveChessboardProps) {
  const { logAction } = useClickLogger();
  const rootFen = initialFen || "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
  const { sideToMove: rootSideToMove, fullmove: rootFullmove } = parseFenStart(rootFen);
  const startsWithBlack = rootSideToMove === "b";
  const [currentPosition, setCurrentPosition] = useState(rootFen);
  const [history, setHistory] = useState<string[]>([]);
  const [positions, setPositions] = useState<string[]>([]);
  const [moveAnnotations, setMoveAnnotations] = useState<MoveAnnotation[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [orientation, setOrientation] = useState<"white" | "black">("white");
  const [isPlaying, setIsPlaying] = useState(false);
  const [copiedType, setCopiedType] = useState<"fen" | "pgn" | null>(null);

  // Display toggles for Move Notation table
  const [showBadges, setShowBadges] = useState(true);
  const [showEvals, setShowEvals] = useState(true);

  // Live Parallel Full-Game Analysis State
  const [isAnalyzingFullGame, setIsAnalyzingFullGame] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState<{ current: number; total: number } | null>(null);
  const activeJobIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  const timerRef = useRef<number | null>(null);
  const lastLoadedPgnRef = useRef<string | null>(null);
  const onPositionChangeRef = useRef(onPositionChange);
  const onLiveEvalChangeRef = useRef(onLiveEvalChange);
  const onUciLogRef = useRef(onUciLog);
  const onStatsChangeRef = useRef(onStatsChange);
  const onGamePersistedRef = useRef(onGamePersisted);
  const onConsumeAutoAnalyzeRef = useRef(onConsumeAutoAnalyze);
  const logActionRef = useRef(logAction);
  const analysisDepthRef = useRef<number>(analysisDepth ?? 18);
  const analyzerPresetRef = useRef<AnalysisPresetKey>(analyzerPreset ?? "deep");
  const onAnalysisStateChangeRef = useRef(onAnalysisStateChange);
  analysisDepthRef.current = analysisDepth ?? 18;
  analyzerPresetRef.current = analyzerPreset ?? "deep";
  onAnalysisStateChangeRef.current = onAnalysisStateChange;
  const lastAnalysisSignalRef = useRef<number>(runAnalysisSignal ?? 0);

  // Full registered UCI engine list for Kibitzer engine selector
  const { data: registeredEngines = [] } = useQuery<EngineInfo[]>({
    queryKey: ["engines"],
    queryFn: fetchEngineList,
    staleTime: 60_000,
  });

  // Figurine notation toggle (♘ instead of N) for the move list and Kibitzer lines
  const [figurineNotation, setFigurineNotation] = useState<boolean>(() => {
    try { return localStorage.getItem("deepscout_figurine_notation") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("deepscout_figurine_notation", figurineNotation ? "1" : "0"); } catch { /* ignore */ }
  }, [figurineNotation]);

  // Kibitzer Multi-PV Analysis State & Settings
  const [isKibitzerOpen, setIsKibitzerOpen] = useState(false);
  const [isKibitzerThinking, setIsKibitzerThinking] = useState(false);
  const [kibitzerVariations, setKibitzerVariations] = useState<VariationLine[]>([]);
  const [isKibitzerSettingsOpen, setIsKibitzerSettingsOpen] = useState(false);
  const [kibitzerContinuous, setKibitzerContinuous] = useState(true);
  const [kibitzerDepth, setKibitzerDepth] = useState(20);
  const [kibitzerMultipv, setKibitzerMultipv] = useState(3);
  const [kibitzerSearchMode, setKibitzerSearchMode] = useState<"depth" | "time" | "both">("depth");
  const [kibitzerTimeLimitMs] = useState(1000);
  const [kibitzerThreads, setKibitzerThreads] = useState(1);
  const [kibitzerHashMb, setKibitzerHashMb] = useState(64);
  const [kibitzerEngine, setKibitzerEngine] = useState("patricia");
  const [kibitzerSavedAlert, setKibitzerSavedAlert] = useState<string | null>(null);
  const [savedVariationKeys, setSavedVariationKeys] = useState<Record<string, boolean>>({});
  const [activeKibitzerPreview, setActiveKibitzerPreview] = useState<{
    lineIdx: number;
    stepIdx: number;
    rootFen: string;
    moves: Array<{ san: string; from: string; to: string; fen: string }>;
  } | null>(null);

  const kibitzerEngineName =
    registeredEngines.find((e) => e.id.toLowerCase() === kibitzerEngine.toLowerCase())?.name ||
    (kibitzerEngine === "stockfish" ? "Stockfish 18" : kibitzerEngine === "patricia" ? "Patricia v4" : kibitzerEngine);

  const buildVariationSteps = useCallback((baseFen: string, variation: VariationLine) => {
    const steps: Array<{ san: string; from: string; to: string; fen: string }> = [];
    try {
      const board = new Chess(baseFen);
      const sanTokens = (variation.pv_san || "")
        .split(/\s+/)
        .map((t) => t.replace(/^\d+\.+/, "").trim())
        .filter((t) => t && !["1-0", "0-1", "1/2-1/2", "*"].includes(t));
      const uciTokens = (variation.pv_uci || "")
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean);

      const tokens = sanTokens.length > 0 ? sanTokens : uciTokens;
      for (let i = 0; i < tokens.length; i++) {
        let mv: any = null;
        try {
          mv = board.move(tokens[i]);
        } catch {}
        if (!mv && uciTokens[i] && uciTokens[i].length >= 4) {
          try {
            mv = board.move({
              from: uciTokens[i].slice(0, 2),
              to: uciTokens[i].slice(2, 4),
              promotion: uciTokens[i].slice(4, 5) || "q",
            });
          } catch {}
        }
        if (!mv) break;
        steps.push({ san: mv.san, from: mv.from, to: mv.to, fen: board.fen() });
      }
    } catch {}
    return steps;
  }, []);

  const enterKibitzerLine = useCallback(
    (lineIdx: number, stepIdx: number = 0) => {
      if (kibitzerVariations.length === 0) return;
      const clampedLine = Math.max(0, Math.min(kibitzerVariations.length - 1, lineIdx));
      const baseFen = activeKibitzerPreview?.rootFen || currentPosition;
      const steps = buildVariationSteps(baseFen, kibitzerVariations[clampedLine]);
      if (steps.length === 0) return;
      const clampedStep = Math.max(0, Math.min(steps.length - 1, stepIdx));
      setIsPlaying(false);
      setActiveKibitzerPreview({
        lineIdx: clampedLine,
        stepIdx: clampedStep,
        rootFen: baseFen,
        moves: steps,
      });
    },
    [kibitzerVariations, activeKibitzerPreview, currentPosition, buildVariationSteps]
  );

  const stepKibitzerMove = useCallback(
    (delta: number) => {
      if (!activeKibitzerPreview) return;
      const nextStep = activeKibitzerPreview.stepIdx + delta;
      if (nextStep < 0) {
        setActiveKibitzerPreview(null);
        return;
      }
      if (nextStep >= activeKibitzerPreview.moves.length) return;
      setActiveKibitzerPreview({
        ...activeKibitzerPreview,
        stepIdx: nextStep,
      });
    },
    [activeKibitzerPreview]
  );

  const switchKibitzerLine = useCallback(
    (delta: number) => {
      if (kibitzerVariations.length === 0) return;
      if (!activeKibitzerPreview) {
        enterKibitzerLine(delta > 0 ? 0 : kibitzerVariations.length - 1, 0);
        return;
      }
      const total = kibitzerVariations.length;
      const nextLine = (activeKibitzerPreview.lineIdx + delta + total) % total;
      enterKibitzerLine(nextLine, 0);
    },
    [kibitzerVariations.length, activeKibitzerPreview, enterKibitzerLine]
  );

  useEffect(() => {
    onPositionChangeRef.current = onPositionChange;
    onLiveEvalChangeRef.current = onLiveEvalChange;
    onUciLogRef.current = onUciLog;
    onStatsChangeRef.current = onStatsChange;
    onGamePersistedRef.current = onGamePersisted;
    onConsumeAutoAnalyzeRef.current = onConsumeAutoAnalyze;
    logActionRef.current = logAction;
  });

  // Emit live evaluation & principal variation for AskGrandmasterAction whenever ply or analysis updates
  useEffect(() => {
    if (!onLiveEvalChangeRef.current) return;
    const topKib = kibitzerVariations[0];
    const plyAnn = historyIndex >= 0 ? moveAnnotations[historyIndex] : undefined;
    let evalStr = "+0.00";
    if (topKib) {
      if (topKib.is_mate && topKib.mate_in != null) {
        evalStr = topKib.mate_in > 0 ? `#M${topKib.mate_in}` : `-#M${Math.abs(topKib.mate_in)}`;
      } else if (typeof topKib.score_cp === "number") {
        evalStr = `${topKib.score_cp >= 0 ? "+" : ""}${(topKib.score_cp / 100).toFixed(2)}`;
      }
    } else if (plyAnn?.eval) {
      evalStr = plyAnn.eval;
    }
    const mainLine = topKib?.pv_san || plyAnn?.pvSan || plyAnn?.bestMoveSan || "";
    onLiveEvalChangeRef.current({ evalStr, mainLine });
  }, [historyIndex, moveAnnotations, kibitzerVariations]);

  const handleRequestKibitzerAdvice = useCallback(
    async (
      targetFen?: string,
      overrides?: {
        engine?: string;
        depth?: number;
        multipv?: number;
        searchMode?: "depth" | "time" | "both";
        timeLimitMs?: number;
        threads?: number;
        hashMb?: number;
      }
    ) => {
      const fenToAnalyze = targetFen || currentPosition;
      const engineToUse = overrides?.engine ?? kibitzerEngine;
      const depthToUse = overrides?.depth ?? kibitzerDepth;
      const multipvToUse = overrides?.multipv ?? kibitzerMultipv;
      const modeToUse = overrides?.searchMode ?? kibitzerSearchMode;
      const timeMsToUse = overrides?.timeLimitMs ?? kibitzerTimeLimitMs;
      const threadsToUse = overrides?.threads ?? kibitzerThreads;
      const hashToUse = overrides?.hashMb ?? kibitzerHashMb;

      const effectiveTimeLimitMs = modeToUse === "depth" ? null : timeMsToUse;
      const effectiveDepth = modeToUse === "time" ? undefined : depthToUse;

      setIsKibitzerThinking(true);
      try {
        const res = await fetchEngineVariations({
          fen: fenToAnalyze,
          engine_id: engineToUse,
          depth: effectiveDepth,
          multipv: multipvToUse,
          time_limit_ms: effectiveTimeLimitMs,
          threads: threadsToUse,
          hash_mb: hashToUse,
        });

        if (res?.variations) {
          setKibitzerVariations(res.variations);
          setActiveKibitzerPreview(null);
          if (res.uci_log && onUciLogRef.current) {
            onUciLogRef.current(res.uci_log, res.uci_options);
          }
        }
      } catch (err: any) {
        console.warn("Kibitzer analysis query failed:", err);
      } finally {
        setIsKibitzerThinking(false);
      }
    },
    [
      currentPosition,
      kibitzerEngine,
      kibitzerDepth,
      kibitzerMultipv,
      kibitzerSearchMode,
      kibitzerTimeLimitMs,
      kibitzerThreads,
      kibitzerHashMb,
    ]
  );

  const stopActiveParallelJob = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (activeJobIdRef.current) {
      const oldId = activeJobIdRef.current;
      activeJobIdRef.current = null;
      cancelParallelAnalysisJob(oldId).catch(() => {});
    }
    setIsAnalyzingFullGame(false);
    setAnalysisProgress(null);
  }, []);

  // Cancel any in-flight analysis job when switching games or unmounting
  useEffect(() => {
    return () => {
      stopActiveParallelJob();
    };
  }, [gameId, dbName, stopActiveParallelJob]);

  // Hardware-Aware Parallel PGN Chunking Analysis (single atomic SQLite Gold commit on backend)
  const handleRunFullGameAnalysis = async () => {
    if (positions.length === 0) return;

    // Supersede/cancel any in-flight job so immediate re-analysis (e.g. from Gear apply) cleanly overwrites
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (activeJobIdRef.current) {
      const prevJob = activeJobIdRef.current;
      activeJobIdRef.current = null;
      cancelParallelAnalysisJob(prevJob).catch(() => {});
    }

    setIsAnalyzingFullGame(true);
    setAnalysisProgress({ current: 0, total: positions.length + 1 });

    const activePreset = analyzerPresetRef.current;
    logActionRef.current(
      "CLICK",
      "Started Parallel Full-Game Analysis",
      `Preset: ${activePreset}, Plies: ${positions.length}`
    );

    try {
      const started = await startParallelAnalysisJob({
        db_name: dbName || null,
        game_id: gameId ?? null,
        pgn: pgn || null,
        initial_fen: rootFen,
        preset: activePreset,
        ...(activePreset === "custom" ? {} : { depth: analysisDepthRef.current }),
      });

      const jobId = started.job_id;
      activeJobIdRef.current = jobId;
      setAnalysisProgress({ current: 0, total: started.total_plies || positions.length + 1 });

      onUciLogRef.current?.(
        [
          `[ANALYZER] Dispatched parallel job #${jobId}: ${started.engine_name} (${started.worker_count}w × ${started.threads_per_worker ?? 1}T, preset=${started.preset ?? activePreset}, d${started.depth ?? analysisDepthRef.current})`,
        ],
        {
          Engine: started.engine_name,
          Preset: started.preset ?? activePreset,
          Depth: started.depth ?? analysisDepthRef.current,
          Workers: started.worker_count,
          "Threads / Worker": started.threads_per_worker ?? 1,
          Status: "Running Parallel Analysis...",
        }
      );

      pollTimerRef.current = window.setInterval(async () => {
        if (activeJobIdRef.current !== jobId) {
          if (pollTimerRef.current !== null) {
            window.clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          return;
        }
        try {
          const status = await fetchParallelAnalysisJob(jobId);
          if (activeJobIdRef.current !== jobId) return;

          setAnalysisProgress({
            current: status.completed_plies ?? 0,
            total: status.total_plies || positions.length + 1,
          });

          if (status.status === "completed" && status.result) {
            if (pollTimerRef.current !== null) {
              window.clearInterval(pollTimerRef.current);
              pollTimerRef.current = null;
            }
            activeJobIdRef.current = null;

            const result = status.result;
            // Overwrite previous ply annotations and stats atomically
            setMoveAnnotations(result.annotations || []);
            if (onStatsChangeRef.current && result.stats) {
              onStatsChangeRef.current(result.stats);
            }
            if (result.uci_log && onUciLogRef.current) {
              onUciLogRef.current(result.uci_log, {
                Engine: status.engine_name,
                Preset: status.preset ?? activePreset,
                Depth: status.depth ?? analysisDepthRef.current,
                Workers: status.worker_count,
                "Threads / Worker": status.threads_per_worker ?? 1,
                Tier: result.tier || "Gold",
                Persisted: result.persisted ? "Saved to SQLite (Gold)" : "In-Memory",
              });
            }
            setIsAnalyzingFullGame(false);
            setAnalysisProgress(null);
            if (result.persisted) {
              onGamePersistedRef.current?.();
            }
            logActionRef.current(
              "API",
              `Completed Parallel Game Analysis (${status.worker_count}w)`,
              `White Acc: ${result.stats?.whiteAccuracy ?? "—"}%, Black Acc: ${result.stats?.blackAccuracy ?? "—"}%, FinalEval: ${result.final_eval}`
            );
          } else if (status.status === "cancelled" || status.status === "error") {
            if (pollTimerRef.current !== null) {
              window.clearInterval(pollTimerRef.current);
              pollTimerRef.current = null;
            }
            activeJobIdRef.current = null;
            setIsAnalyzingFullGame(false);
            setAnalysisProgress(null);
            if (status.status === "error") {
              logActionRef.current("ERROR", "Parallel Game Analysis Failed", status.error || "Unknown error");
            }
          }
        } catch (pollErr: any) {
          if (pollTimerRef.current !== null) {
            window.clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          activeJobIdRef.current = null;
          setIsAnalyzingFullGame(false);
          setAnalysisProgress(null);
          logActionRef.current("ERROR", "Analysis polling failed", String(pollErr?.message || pollErr));
        }
      }, 250);
    } catch (err: any) {
      setIsAnalyzingFullGame(false);
      setAnalysisProgress(null);
      logActionRef.current("ERROR", "Failed to start parallel game analysis", String(err?.message || err));
    }
  };

  // Race-safe Post-Sparring Auto-Analyze Handoff: fires ONLY after target game hydrates positions
  useEffect(() => {
    if (!pendingAutoAnalyze) return;
    if (positions.length === 0) return;
    const idMatches = gameId !== undefined && String(gameId) === String(pendingAutoAnalyze.gameId);
    const dbMatches = !pendingAutoAnalyze.db || !dbName || pendingAutoAnalyze.db === dbName;
    if (!idMatches || !dbMatches) return;

    // Immediately consume token to prevent duplicate runs on re-render or tab switch
    onConsumeAutoAnalyzeRef.current?.();
    void handleRunFullGameAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoAnalyze, gameId, dbName, positions.length]);

  // External trigger (Analysis panel "Evaluate Game" button or Gear Apply & Re-Analyze)
  useEffect(() => {
    if (runAnalysisSignal === undefined || runAnalysisSignal === lastAnalysisSignalRef.current) return;
    lastAnalysisSignalRef.current = runAnalysisSignal;
    void handleRunFullGameAnalysis();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runAnalysisSignal]);

  // Report batch-evaluation progress to the parent
  useEffect(() => {
    onAnalysisStateChangeRef.current?.({ running: isAnalyzingFullGame, progress: analysisProgress });
  }, [isAnalyzingFullGame, analysisProgress]);

  const handleSaveVariationToDb = async (variation: VariationLine, idx: number) => {
    const baseFen = activeKibitzerPreview?.rootFen || currentPosition;
    const key = `${baseFen}_${idx}`;
    const pvText = variation.pv_san || variation.pv_uci || "";
    const evalStr =
      variation.is_mate && variation.mate_in !== undefined && variation.mate_in !== null
        ? `#${variation.mate_in}`
        : typeof variation.score_cp === "number"
        ? `${variation.score_cp >= 0 ? "+" : ""}${(variation.score_cp / 100).toFixed(2)}`
        : undefined;

    try {
      let savedToGamePgn = false;
      // 1. Save directly as a real PGN RAV variation into the active SQLite game's PGN
      if (dbName && gameId !== undefined && pvText.trim()) {
        await saveVariationToGamePgn(gameId, {
          db_name: dbName,
          ply: historyIndex + 1,
          pv_san: pvText,
          eval_str: evalStr,
          engine_name: kibitzerEngineName,
          depth: variation.depth || kibitzerDepth,
        });
        savedToGamePgn = true;
      }

      // 2. Also log to Kibitzer_Analysis.sqlite companion history (best-effort)
      try {
        await logKibitzerVariation({
          game_id: String(gameId ?? "Analysis-Session"),
          ply: historyIndex + 1,
          fen: baseFen,
          engine: kibitzerEngineName,
          pgn_fragment: pvText,
          eval_data: {
            score_cp: variation.score_cp,
            depth: variation.depth || kibitzerDepth,
            nps: variation.nps,
          },
          trigger_source: "continuous",
          logged_by: "user_save",
          was_played: false,
        });
      } catch {}

      setSavedVariationKeys((prev) => ({ ...prev, [key]: true }));
      setKibitzerSavedAlert(
        savedToGamePgn
          ? `Saved Variation #${idx + 1} into ${dbName} PGN`
          : `Saved Variation #${idx + 1} to Kibitzer_Analysis.sqlite`
      );
      if (savedToGamePgn) {
        onGamePersistedRef.current?.();
      }
      logActionRef.current(
        "CLICK",
        `Saved Kibitzer Variation #${idx + 1} to ${savedToGamePgn ? dbName + " PGN" : "Kibitzer DB"}`,
        pvText
      );
      setTimeout(() => setKibitzerSavedAlert(null), 3500);
    } catch (err: any) {
      logActionRef.current("ERROR", "Failed to save Kibitzer variation", err.message);
    }
  };

  useEffect(() => {
    if (!pgn || pgn === lastLoadedPgnRef.current) return;
    lastLoadedPgnRef.current = pgn;

    try {
      const chess = new Chess(rootFen || undefined);
      const cleaned = cleanPgnForChessJs(pgn);
      chess.loadPgn(cleaned);
      const moves = chess.history();

      const runner = new Chess(rootFen || undefined);
      const fens: string[] = [];
      for (const m of moves) {
        runner.move(m);
        fens.push(runner.fen());
      }

      const { annotations, stats } = parsePgnAnnotationsAndStats(pgn, moves);
      setMoveAnnotations(annotations);
      if (onStatsChangeRef.current) {
        onStatsChangeRef.current(stats);
      }

      const startFen = rootFen;
      setHistory(moves);
      setPositions(fens);
      setHistoryIndex(-1);
      setCurrentPosition(startFen);

      if (onPositionChangeRef.current) onPositionChangeRef.current(startFen);
      logActionRef.current("BOARD", `Loaded Game with ${moves.length} moves`, `Start FEN: ${startFen}`);

      if (isKibitzerOpen && kibitzerContinuous) {
        handleRequestKibitzerAdvice(startFen);
      }
    } catch (e) {
      console.warn("Primary loadPgn failed, attempting token fallback...", e);
      try {
        const noHeaders = pgn.replace(/\[[^\]]*\]/g, "").replace(/\{[^}]*\}/g, "").replace(/\[%[^\]]*\]/g, "");
        const tokens = noHeaders.split(/\s+/).filter((t) => t && !t.includes(".") && !["1-0", "0-1", "1/2-1/2", "*"].includes(t));
        const runner = new Chess(rootFen || undefined);
        const moves: string[] = [];
        const fens: string[] = [];
        for (const tok of tokens) {
          try {
            const mv = runner.move(tok);
            if (mv) {
              moves.push(mv.san);
              fens.push(runner.fen());
            }
          } catch {
            break;
          }
        }
        const { annotations, stats } = parsePgnAnnotationsAndStats(pgn, moves);
        setMoveAnnotations(annotations);
        if (onStatsChangeRef.current) {
          onStatsChangeRef.current(stats);
        }

        const startFen = rootFen;
        setHistory(moves);
        setPositions(fens);
        setHistoryIndex(-1);
        setCurrentPosition(startFen);

        if (onPositionChangeRef.current) onPositionChangeRef.current(startFen);
        logActionRef.current("BOARD", `Loaded Game via fallback with ${moves.length} moves`, `Start FEN: ${startFen}`);

        if (isKibitzerOpen && kibitzerContinuous) {
          handleRequestKibitzerAdvice(startFen);
        }
      } catch (err2) {
        console.error("Failed to load PGN with fallback", err2);
        logActionRef.current("BOARD", "Error loading PGN", String(err2));
      }
    }
  }, [pgn, rootFen, isKibitzerOpen, kibitzerContinuous, handleRequestKibitzerAdvice]);

  const updateToMove = useCallback(
    (index: number) => {
      if (index < -1 || index >= history.length) return;

      const startFen = rootFen;
      let newFen: string;
      if (index === -1) {
        newFen = startFen;
      } else if (positions[index]) {
        newFen = positions[index];
      } else {
        const tempGame = new Chess(rootFen || undefined);
        for (let i = 0; i <= index; i++) {
          tempGame.move(history[i]);
        }
        newFen = tempGame.fen();
      }

      setActiveKibitzerPreview(null);
      setCurrentPosition(newFen);
      setHistoryIndex(index);
      if (onPositionChangeRef.current) onPositionChangeRef.current(newFen);
      const moveText =
        index >= 0 ? `${Math.floor(index / 2) + 1}${index % 2 === 0 ? "." : "..."} ${history[index]}` : "Start Position";
      logActionRef.current("NAV", `Navigated to Move ${index + 1}/${history.length}`, moveText);

      if (isKibitzerOpen && kibitzerContinuous) {
        handleRequestKibitzerAdvice(newFen);
      }
    },
    [history, positions, rootFen, isKibitzerOpen, kibitzerContinuous, handleRequestKibitzerAdvice]
  );

  const handlePieceDrop = useCallback(
    ({
      sourceSquare,
      targetSquare,
    }: {
      sourceSquare: string;
      targetSquare: string | null;
    }): boolean => {
      if (!targetSquare) return false;
      try {
        const currentBoard = new Chess(currentPosition);
        const move = currentBoard.move({
          from: sourceSquare,
          to: targetSquare,
          promotion: "q",
        });
        if (move) {
          const newFen = currentBoard.fen();
          setCurrentPosition(newFen);
          const newHistory = [...history.slice(0, historyIndex + 1), move.san];
          const newPositions = [...positions.slice(0, historyIndex + 1), newFen];
          setHistory(newHistory);
          setPositions(newPositions);
          setHistoryIndex(newHistory.length - 1);
          if (onPositionChangeRef.current) onPositionChangeRef.current(newFen);
          logActionRef.current("BOARD", `Played Move on Board: ${move.san}`, `New FEN: ${newFen}`);

          if (isKibitzerOpen && kibitzerContinuous) {
            handleRequestKibitzerAdvice(newFen);
          }
          return true;
        }
      } catch (err) {
        console.warn("Illegal move attempted", err);
      }
      return false;
    },
    [currentPosition, history, positions, historyIndex, isKibitzerOpen, kibitzerContinuous, handleRequestKibitzerAdvice]
  );

  const handleFirst = () => {
    setIsPlaying(false);
    updateToMove(-1);
  };

  const handlePrev = () => {
    setIsPlaying(false);
    updateToMove(historyIndex - 1);
  };

  const handleNext = () => {
    setIsPlaying(false);
    updateToMove(historyIndex + 1);
  };

  const handleLast = () => {
    setIsPlaying(false);
    updateToMove(history.length - 1);
  };

  const handleFlip = () => {
    const nextOrientation = orientation === "white" ? "black" : "white";
    setOrientation(nextOrientation);
    logActionRef.current("BOARD", `Flipped board orientation to ${nextOrientation}`);
  };

  const handleCopyFen = async () => {
    await navigator.clipboard.writeText(currentPosition);
    setCopiedType("fen");
    logActionRef.current("BOARD", "Copied FEN to clipboard", currentPosition);
    setTimeout(() => setCopiedType(null), 2000);
  };

  const handleCopyPgn = async () => {
    if (pgn) {
      await navigator.clipboard.writeText(pgn);
      setCopiedType("pgn");
      logActionRef.current("BOARD", "Copied PGN to clipboard");
      setTimeout(() => setCopiedType(null), 2000);
    }
  };

  const toggleAutoPlay = () => {
    setIsPlaying((prev) => {
      const next = !prev;
      logActionRef.current("BOARD", next ? "Started Auto-Play" : "Paused Auto-Play");
      return next;
    });
  };

  useEffect(() => {
    if (isPlaying) {
      timerRef.current = window.setInterval(() => {
        setHistoryIndex((prevIndex) => {
          if (prevIndex >= history.length - 1) {
            setIsPlaying(false);
            return prevIndex;
          }
          const nextIndex = prevIndex + 1;
          const nextFen =
            positions[nextIndex] ||
            (() => {
              const temp = new Chess(rootFen || undefined);
              for (let i = 0; i <= nextIndex; i++) temp.move(history[i]);
              return temp.fen();
            })();
          setCurrentPosition(nextFen);
          if (onPositionChangeRef.current) onPositionChangeRef.current(nextFen);
          if (isKibitzerOpen && kibitzerContinuous) {
            handleRequestKibitzerAdvice(nextFen);
          }
          return nextIndex;
        });
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isPlaying, history, positions, rootFen, isKibitzerOpen, kibitzerContinuous, handleRequestKibitzerAdvice]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
         target.tagName === "TEXTAREA" ||
         target.tagName === "SELECT" ||
         target.isContentEditable)
      ) {
        return;
      }

      const kibHasLines = isKibitzerOpen && kibitzerVariations.length > 0;

      if (e.code === "Escape" && activeKibitzerPreview) {
        e.preventDefault();
        setActiveKibitzerPreview(null);
        return;
      }

      // Fast Up/Down arrow switching across all Kibitzer lines (e.g. Lines 1..5)
      if (kibHasLines && (e.code === "ArrowDown" || e.code === "ArrowUp")) {
        e.preventDefault();
        switchKibitzerLine(e.code === "ArrowDown" ? 1 : -1);
        return;
      }

      // Left/Right arrows step through active Kibitzer variation line when previewing
      if (activeKibitzerPreview && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
        e.preventDefault();
        stepKibitzerMove(e.code === "ArrowRight" ? 1 : -1);
        return;
      }

      if (["ArrowLeft", "ArrowRight", "Home", "End", "Space", "KeyF"].includes(e.code)) {
        if (e.code === "Space") e.preventDefault();
      }
      if (e.code === "ArrowLeft") handlePrev();
      if (e.code === "ArrowRight") handleNext();
      if (e.code === "Home") handleFirst();
      if (e.code === "End") handleLast();
      if (e.code === "KeyF") handleFlip();
      if (e.code === "Space") toggleAutoPlay();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    historyIndex,
    history.length,
    orientation,
    isPlaying,
    isKibitzerOpen,
    kibitzerVariations.length,
    activeKibitzerPreview,
    switchKibitzerLine,
    stepKibitzerMove,
    handlePrev,
    handleNext,
    handleFirst,
    handleLast,
    handleFlip,
    toggleAutoPlay,
  ]);

  const movePairs: Array<{ moveNum: number; white?: string; black?: string; whiteIdx?: number; blackIdx?: number }> = [];
  let pairIdx = 0;
  let pairMoveNum = rootFullmove;
  if (startsWithBlack) {
    if (pairIdx < history.length) {
      movePairs.push({
        moveNum: pairMoveNum,
        black: history[pairIdx],
        blackIdx: pairIdx,
      });
      pairIdx++;
    }
    pairMoveNum++;
  }
  while (pairIdx < history.length) {
    movePairs.push({
      moveNum: pairMoveNum,
      white: history[pairIdx],
      black: history[pairIdx + 1],
      whiteIdx: pairIdx,
      blackIdx: pairIdx + 1 < history.length ? pairIdx + 1 : undefined,
    });
    pairIdx += 2;
    pairMoveNum++;
  }

  // Quality filter (from Game Stats tiles): keep only rows where at least one move matches.
  const visiblePairs = qualityFilter
    ? movePairs.filter((p) => {
        const w = p.whiteIdx !== undefined ? moveAnnotations[p.whiteIdx] : undefined;
        const b = p.blackIdx !== undefined ? moveAnnotations[p.blackIdx] : undefined;
        return (
          (!!w && moveMatchesQualityFilter(w.tag, qualityFilter)) ||
          (!!b && moveMatchesQualityFilter(b.tag, qualityFilter))
        );
      })
    : movePairs;
  const filteredPairCount = visiblePairs.length;

  // SAN → figurine notation (♔♕♖♗♘) for every SAN token in a string, when enabled.
  const toDisplaySan = (san: string): string => {
    if (!figurineNotation || !san) return san;
    const figs: Record<string, string> = { K: "♔", Q: "♕", R: "♖", B: "♗", N: "♘" };
    return san
      .split(/(\s+)/)
      .map((tok) => tok.replace(/^([KQRBN])(?=[a-h1-8x])/, (_m, p: string) => figs[p]))
      .join("");
  };

  const boardCustomSquareStyles: Record<string, { backgroundColor: string }> = {};
  const activePreviewMove = activeKibitzerPreview
    ? activeKibitzerPreview.moves[activeKibitzerPreview.stepIdx]
    : null;
  const displayPosition = activePreviewMove ? activePreviewMove.fen : currentPosition;

  if (activePreviewMove) {
    boardCustomSquareStyles[activePreviewMove.from] = { backgroundColor: "rgba(6, 182, 212, 0.45)" };
    boardCustomSquareStyles[activePreviewMove.to] = { backgroundColor: "rgba(6, 182, 212, 0.65)" };
  } else if (isKibitzerOpen && kibitzerVariations.length > 0) {
    const colors = [
      "rgba(16, 185, 129, 0.45)",
      "rgba(6, 182, 212, 0.40)",
      "rgba(245, 158, 11, 0.40)",
    ];
    kibitzerVariations.slice(0, 3).forEach((v, idx) => {
      if (v.pv_uci && v.pv_uci.length >= 4) {
        const fromSq = v.pv_uci.slice(0, 2);
        const toSq = v.pv_uci.slice(2, 4);
        if (!boardCustomSquareStyles[fromSq]) {
          boardCustomSquareStyles[fromSq] = { backgroundColor: colors[idx] || colors[0] };
        }
        if (!boardCustomSquareStyles[toSq]) {
          boardCustomSquareStyles[toSq] = { backgroundColor: colors[idx] || colors[0] };
        }
      }
    });
  }

  const isLightUX = uxTheme.mode === "light";

  return (
    <div className="flex flex-col lg:flex-row h-full gap-6 select-none">
      {/* Chessboard Container */}
      <div
        className={`flex-grow flex flex-col rounded-3xl shadow-2xl overflow-hidden border ${uxTheme.panel} ${uxTheme.border}`}
      >
        <div className="flex-grow p-4 md:p-6 flex items-center justify-center min-h-0 relative">
          <div className="w-[min(100%,calc(100vh-270px))] max-w-[480px] xl:max-w-[530px] aspect-square rounded-2xl overflow-hidden shadow-2xl border border-black/20 relative">
            <Chessboard
              options={{
                position: displayPosition,
                boardOrientation: orientation,
                onPieceDrop: handlePieceDrop,
                pieces: customChessPieces,
                squareStyles: Object.keys(boardCustomSquareStyles).length > 0 ? boardCustomSquareStyles : undefined,
                darkSquareStyle: { backgroundColor: boardTheme.boardDark },
                lightSquareStyle: { backgroundColor: boardTheme.boardLight },
                animationDurationInMs: 200,
              }}
            />

            {activeKibitzerPreview && activePreviewMove && (
              <div className="absolute top-2.5 inset-x-3 px-3 py-1.5 rounded-xl bg-slate-950/90 border border-cyan-400/70 text-cyan-200 text-[11px] font-mono font-bold shadow-xl backdrop-blur-sm flex items-center justify-between gap-2 z-20">
                <span className="truncate">
                  Kibitzer Line #{activeKibitzerPreview.lineIdx + 1} · {toDisplaySan(activePreviewMove.san)} ({activeKibitzerPreview.stepIdx + 1}/{activeKibitzerPreview.moves.length})
                </span>
                <button
                  type="button"
                  onClick={() => setActiveKibitzerPreview(null)}
                  className="px-2 py-0.5 rounded bg-cyan-500/20 hover:bg-cyan-500/35 text-cyan-200 border border-cyan-400/40 text-[10px] shrink-0 cursor-pointer"
                >
                  Game (Esc)
                </button>
              </div>
            )}

            {kibitzerSavedAlert && (
              <div className="absolute top-3 inset-x-4 p-2.5 rounded-xl bg-emerald-950/90 border border-emerald-500 text-emerald-200 text-xs font-mono font-bold shadow-xl backdrop-blur-sm animate-in fade-in flex items-center gap-2 z-30">
                <Check className="w-4 h-4 text-emerald-400" />
                <span>{kibitzerSavedAlert}</span>
              </div>
            )}
          </div>
        </div>

        {/* Board Control Bar */}
        <div
          className={`h-16 border-t flex items-center justify-between px-6 ${
            isLightUX ? "bg-slate-50 border-slate-200" : "bg-black/40 border-white/10"
          }`}
        >
          <div className="flex items-center gap-1.5">
            <Tooltip content="First Move" description="Jump to initial position" shortcut="Home">
              <button
                onClick={handleFirst}
                disabled={historyIndex === -1}
                className={`p-2 rounded-xl transition-colors disabled:opacity-30 cursor-pointer ${
                  isLightUX
                    ? "text-slate-600 hover:text-slate-900 hover:bg-slate-200"
                    : "text-slate-400 hover:text-white hover:bg-white/10"
                }`}
              >
                <ChevronsLeft className="w-5 h-5" />
              </button>
            </Tooltip>

            <Tooltip content="Previous Move" description="Step back one ply" shortcut="←">
              <button
                onClick={handlePrev}
                disabled={historyIndex === -1}
                className={`p-2 rounded-xl transition-colors disabled:opacity-30 cursor-pointer ${
                  isLightUX
                    ? "text-slate-600 hover:text-slate-900 hover:bg-slate-200"
                    : "text-slate-400 hover:text-white hover:bg-white/10"
                }`}
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
            </Tooltip>

            <Tooltip
              content={isPlaying ? "Pause Auto-Play" : "Play Moves"}
              description="Step through moves automatically"
              shortcut="Space"
            >
              <button
                onClick={toggleAutoPlay}
                className="p-2 text-emerald-500 hover:text-emerald-400 rounded-xl hover:bg-emerald-500/10 transition-colors cursor-pointer"
              >
                {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
              </button>
            </Tooltip>

            <Tooltip content="Next Move" description="Step forward one ply" shortcut="→">
              <button
                onClick={handleNext}
                disabled={historyIndex >= history.length - 1}
                className={`p-2 rounded-xl transition-colors disabled:opacity-30 cursor-pointer ${
                  isLightUX
                    ? "text-slate-600 hover:text-slate-900 hover:bg-slate-200"
                    : "text-slate-400 hover:text-white hover:bg-white/10"
                }`}
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </Tooltip>

            <Tooltip content="Last Move" description="Jump to final position" shortcut="End">
              <button
                onClick={handleLast}
                disabled={historyIndex >= history.length - 1}
                className={`p-2 rounded-xl transition-colors disabled:opacity-30 cursor-pointer ${
                  isLightUX
                    ? "text-slate-600 hover:text-slate-900 hover:bg-slate-200"
                    : "text-slate-400 hover:text-white hover:bg-white/10"
                }`}
              >
                <ChevronsRight className="w-5 h-5" />
              </button>
            </Tooltip>
          </div>

          {/* Kibitzer & Batch Analysis Buttons */}
          <div className="flex items-center gap-1.5">
            <Tooltip content={isKibitzerOpen ? "Hide Kibitzer Multi-PV Analysis" : "Launch Kibitzer Multi-PV Analysis"}>
              <button
                onClick={() => {
                  const next = !isKibitzerOpen;
                  setIsKibitzerOpen(next);
                  if (next) {
                    handleRequestKibitzerAdvice(currentPosition);
                  }
                  logActionRef.current("CLICK", next ? "Launched Kibitzer in Analysis" : "Closed Kibitzer");
                }}
                className={`px-3 py-1.5 rounded-xl font-mono text-xs font-bold transition-all flex items-center gap-1.5 shadow-md cursor-pointer ${
                  isKibitzerOpen
                    ? "bg-gradient-to-r from-cyan-600 to-blue-600 text-white border border-cyan-400 ring-2 ring-cyan-500/20"
                    : isLightUX
                    ? "bg-slate-200 text-slate-700 hover:bg-slate-300"
                    : "bg-slate-800 text-slate-300 hover:bg-slate-700 border border-white/10"
                }`}
              >
                <Bot className={`w-3.5 h-3.5 ${isKibitzerThinking ? "animate-spin text-cyan-300" : "text-cyan-400"}`} />
                <span>Kibitzer</span>
                {isKibitzerThinking && <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />}
              </button>
            </Tooltip>

            {isKibitzerOpen && (
              <Tooltip content="Kibitzer Engine & Search Settings">
                <button
                  onClick={() => setIsKibitzerSettingsOpen(true)}
                  className="p-1.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white border border-white/10 text-xs transition-colors cursor-pointer"
                >
                  <Settings2 className="w-3.5 h-3.5 text-cyan-400" />
                </button>
              </Tooltip>
            )}

            <div
              className={`font-mono text-xs px-3 py-1.5 rounded-xl border ${
                isLightUX
                  ? "bg-white text-slate-700 border-slate-200"
                  : "bg-black/30 text-slate-300 border-white/10"
              }`}
            >
              Ply {historyIndex + 1} / {history.length}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <Tooltip content="Flip Board Orientation" description="Switch view between White and Black" shortcut="F">
              <button
                onClick={handleFlip}
                className={`p-2 rounded-xl transition-colors cursor-pointer ${
                  isLightUX
                    ? "text-slate-600 hover:text-slate-900 hover:bg-slate-200"
                    : "text-slate-400 hover:text-white hover:bg-white/10"
                }`}
              >
                <ArrowUpDown className="w-4 h-4" />
              </button>
            </Tooltip>

            <Tooltip content="Copy FEN String" description="Copy current position FEN to clipboard">
              <button
                onClick={handleCopyFen}
                className={`p-2 rounded-xl transition-colors cursor-pointer ${
                  isLightUX
                    ? "text-slate-600 hover:text-slate-900 hover:bg-slate-200"
                    : "text-slate-400 hover:text-white hover:bg-white/10"
                }`}
              >
                {copiedType === "fen" ? (
                  <Check className="w-4 h-4 text-emerald-500" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </Tooltip>

            <Tooltip content="Reset Game Position" description="Reload game from start">
              <button
                onClick={handleFirst}
                className={`p-2 rounded-xl transition-colors cursor-pointer ${
                  isLightUX
                    ? "text-slate-600 hover:text-rose-600 hover:bg-slate-200"
                    : "text-slate-400 hover:text-rose-400 hover:bg-white/10"
                }`}
              >
                <RotateCcw className="w-4 h-4" />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Side Column: Move Notation & Kibitzer Analysis */}
      <div
        className={`w-full lg:w-80 flex-shrink-0 rounded-3xl shadow-2xl border flex flex-col overflow-hidden ${uxTheme.panel} ${uxTheme.border}`}
      >
        {/* Move Notation Header */}
        <div
          className={`px-3 py-2.5 border-b flex items-center justify-between flex-shrink-0 ${
            isLightUX ? "bg-slate-100 border-slate-300" : "bg-black/40 border-white/10"
          }`}
        >
          <div className="flex items-center gap-1">
            <span
              className={`px-3 py-1 rounded-lg text-xs font-extrabold ${
                isLightUX
                  ? "bg-emerald-600 text-white shadow-sm"
                  : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
              }`}
            >
              Move Notation
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setFigurineNotation(!figurineNotation)}
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-bold transition-all cursor-pointer ${
                  figurineNotation
                    ? "bg-amber-500/20 text-amber-600 dark:text-amber-300 border border-amber-500/40"
                    : "bg-slate-500/10 text-slate-400 border border-slate-500/20"
                }`}
                title="Show pieces as figurines (♘ ♗ ♖ ♕ ♔) instead of letters"
              >
                ♘
              </button>
              <button
                onClick={() => setShowBadges(!showBadges)}
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-bold transition-all cursor-pointer ${
                  showBadges
                    ? "bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40"
                    : "bg-slate-500/10 text-slate-400 border border-slate-500/20"
                }`}
                title="Toggle Move Quality Badges"
              >
                Badges
              </button>
              <button
                onClick={() => setShowEvals(!showEvals)}
                className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-bold transition-all cursor-pointer ${
                  showEvals
                    ? "bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 border border-cyan-500/40"
                    : "bg-slate-500/10 text-slate-400 border border-slate-500/20"
                }`}
                title="Toggle Evaluation Scores"
              >
                Eval
              </button>

              <Tooltip content="Copy entire PGN notation">
                <button
                  onClick={handleCopyPgn}
                  className={`text-xs font-mono flex items-center gap-1 transition-colors font-extrabold cursor-pointer ml-1 ${
                    isLightUX ? "text-emerald-700 hover:text-emerald-900" : "text-emerald-400 hover:text-emerald-300"
                  }`}
                >
                  {copiedType === "pgn" ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </Tooltip>
            </div>
          </div>
        </div>

        {/* Quality filter banner (set from the Game Stats tiles) */}
        {qualityFilter && (
          <div
            className={`px-3 py-1.5 border-b flex items-center justify-between text-[10px] font-mono font-bold flex-shrink-0 ${
              isLightUX ? "bg-emerald-50 border-slate-300 text-emerald-800" : "bg-emerald-950/30 border-white/10 text-emerald-300"
            }`}
          >
            <span>
              Filter: {qualityFilter} ({filteredPairCount} shown)
            </span>
            {onQualityFilterChange && (
              <button
                onClick={() => onQualityFilterChange(null)}
                className="px-1.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 hover:bg-emerald-500/30 cursor-pointer"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {/* Move Notation List — always visible, scrolls independently of the Kibitzer panel */}
          {/* Interactive Move List with Badges & Indicators */}
          <div className={`overflow-y-auto p-2 space-y-1.5 font-mono text-xs flex flex-col justify-between min-h-0 ${isKibitzerOpen ? "flex-1" : "flex-grow"}`}>
            <div>
              {/* Evaluation Sparkline Graph */}
              {moveAnnotations.length > 0 && (
                <div className="mb-2">
                  <EvalSparkline
                    annotations={moveAnnotations}
                    currentPly={historyIndex}
                    onSelectPly={(ply) => updateToMove(ply)}
                    isLight={isLightUX}
                  />
                </div>
              )}

              <div className="flex items-center gap-1.5 mb-1.5">
                <button
                  onClick={() => updateToMove(-1)}
                  className={`flex-1 text-left px-2.5 py-1.5 rounded-lg transition-colors flex items-center justify-between text-xs cursor-pointer font-bold ${
                    historyIndex === -1
                      ? "bg-emerald-500/25 text-emerald-600 dark:text-emerald-300 font-extrabold border border-emerald-500/50 shadow-sm"
                      : isLightUX
                      ? "text-slate-800 hover:bg-slate-200"
                      : "text-slate-200 hover:bg-white/10"
                  }`}
                >
                  <span>🏁 Start Position</span>
                  <span className="text-[10px] opacity-80 font-mono">Ply 0</span>
                </button>

                {positions.length > 0 && (
                  <button
                    onClick={() => updateToMove(positions.length - 1)}
                    className={`px-2 py-1.5 rounded-lg transition-colors flex items-center gap-1 text-xs cursor-pointer font-bold ${
                      historyIndex === positions.length - 1
                        ? "bg-cyan-500/25 text-cyan-600 dark:text-cyan-300 font-extrabold border border-cyan-500/50 shadow-sm"
                        : isLightUX
                        ? "text-slate-800 hover:bg-slate-200"
                        : "text-slate-200 hover:bg-white/10"
                    }`}
                    title="Jump to Terminal Position"
                  >
                    <span>Terminal</span>
                    <span className="text-[10px] opacity-80 font-mono">({positions.length})</span>
                  </button>
                )}
              </div>

              {visiblePairs.length === 0 && qualityFilter && (
                <p className="text-center text-[11px] text-slate-400 italic py-4">
                  No {qualityFilter} moves in this game.
                </p>
              )}
              {visiblePairs.map((pair) => {
                const whiteMeta = pair.whiteIdx !== undefined ? moveAnnotations[pair.whiteIdx] : undefined;
                const blackMeta = pair.blackIdx !== undefined ? moveAnnotations[pair.blackIdx] : undefined;
                const whiteDim = !!qualityFilter && !(whiteMeta && moveMatchesQualityFilter(whiteMeta.tag, qualityFilter));
                const blackDim = !!qualityFilter && !(blackMeta && moveMatchesQualityFilter(blackMeta.tag, qualityFilter));

                return (
                  <div
                    key={pair.moveNum}
                    className={`flex items-center rounded-lg px-1.5 py-1 transition-colors ${
                      isLightUX ? "hover:bg-slate-200/70" : "hover:bg-white/5"
                    }`}
                  >
                    <span className={`w-7 font-extrabold text-xs font-mono flex-shrink-0 ${isLightUX ? "text-slate-700" : "text-slate-400"}`}>
                      {pair.moveNum}.
                    </span>

                    {/* White Move Button */}
                    {pair.white !== undefined ? (
                    <button
                      onClick={() => updateToMove(pair.whiteIdx!)}
                      className={`flex-1 text-left px-2 py-1 rounded-md transition-all cursor-pointer font-mono flex items-center justify-between gap-1 min-w-0 ${whiteDim ? "opacity-30" : ""} ${
                        historyIndex === pair.whiteIdx
                          ? "bg-emerald-500/25 text-emerald-800 dark:text-emerald-300 font-extrabold border border-emerald-500/50 shadow-sm"
                          : isLightUX
                          ? "text-slate-900 hover:bg-slate-200"
                          : "text-white hover:bg-white/15"
                      }`}
                    >
                      <span className="font-bold text-xs truncate">{toDisplaySan(pair.white)}</span>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {showBadges && whiteMeta?.badge && (
                          <span
                            className={`text-[10px] px-1 py-0.2 rounded font-bold ${getMoveBadgeStyle(whiteMeta.tag)}`}
                            title={whiteMeta.badgeLabel || whiteMeta.tag}
                          >
                            {whiteMeta.badge}
                          </span>
                        )}
                        {showEvals && whiteMeta?.eval && (
                          <span className="text-[9px] px-1 py-0.2 rounded font-mono font-semibold bg-slate-500/15 text-slate-600 dark:text-slate-400">
                            {whiteMeta.eval}
                          </span>
                        )}
                      </div>
                    </button>
                    ) : (
                      <div className="flex-1 ml-1" />
                    )}

                    {/* Black Move Button */}
                    {pair.black ? (
                      <button
                        onClick={() => updateToMove(pair.blackIdx!)}
                        className={`flex-1 text-left px-2 py-1 rounded-md transition-all cursor-pointer font-mono flex items-center justify-between gap-1 min-w-0 ml-1 ${blackDim ? "opacity-30" : ""} ${
                          historyIndex === pair.blackIdx
                            ? "bg-emerald-500/25 text-emerald-800 dark:text-emerald-300 font-extrabold border border-emerald-500/50 shadow-sm"
                            : isLightUX
                            ? "text-slate-900 hover:bg-slate-200"
                            : "text-white hover:bg-white/15"
                        }`}
                      >
                        <span className="font-bold text-xs truncate">{toDisplaySan(pair.black)}</span>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {showBadges && blackMeta?.badge && (
                            <span
                              className={`text-[10px] px-1 py-0.2 rounded font-bold ${getMoveBadgeStyle(blackMeta.tag)}`}
                              title={blackMeta.badgeLabel || blackMeta.tag}
                            >
                              {blackMeta.badge}
                            </span>
                          )}
                          {showEvals && blackMeta?.eval && (
                            <span className="text-[9px] px-1 py-0.2 rounded font-mono font-semibold bg-slate-500/15 text-slate-600 dark:text-slate-400">
                              {blackMeta.eval}
                            </span>
                          )}
                        </div>
                      </button>
                    ) : (
                      <div className="flex-1 ml-1" />
                    )}
                  </div>
                );
              })}
            </div>

            {/* Quick In-Table Batch Analysis CTA */}
            {moveAnnotations.every((m) => !m.eval) && positions.length > 0 && (
              <div className="pt-3 pb-1 border-t border-white/10 mt-2">
                <button
                  onClick={handleRunFullGameAnalysis}
                  disabled={isAnalyzingFullGame}
                  className="w-full py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-extrabold text-xs rounded-xl shadow-md transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {isAnalyzingFullGame ? (
                    <>
                      <RefreshCw className="w-3 h-3 animate-spin" />
                      <span>
                        Analyzing Ply {analysisProgress?.current ?? 0}/{analysisProgress?.total ?? positions.length}...
                      </span>
                    </>
                  ) : (
                    <>
                      <Zap className="w-3 h-3 text-amber-300" />
                      <span>⚡ Run Full Game Analysis</span>
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        {/* Kibitzer Multi-PV Analysis — independent panel (no tab toggling) */}
        {isKibitzerOpen && (
          <div
            className={`flex-1 min-h-0 flex flex-col border-t-2 ${
              isLightUX ? "border-cyan-600/50" : "border-cyan-500/30"
            }`}
          >
            <div
              className={`px-3 py-2 border-b flex items-center justify-between flex-shrink-0 ${
                isLightUX ? "bg-cyan-50 border-slate-300" : "bg-cyan-950/30 border-white/10"
              }`}
            >
              <div className="flex items-center gap-1.5 text-xs font-extrabold text-cyan-500">
                <Bot className="w-3.5 h-3.5" />
                <span>Kibitzer</span>
                {isKibitzerThinking && <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-ping" />}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setFigurineNotation(!figurineNotation)}
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded font-bold transition-all cursor-pointer ${
                    figurineNotation
                      ? "bg-amber-500/20 text-amber-600 dark:text-amber-300 border border-amber-500/40"
                      : "bg-slate-500/10 text-slate-400 border border-slate-500/20"
                  }`}
                  title="Show pieces as figurines (♘ ♗ ♖ ♕ ♔) instead of letters"
                >
                  ♘ Figurine
                </button>
                <Tooltip content="Evaluate current position">
                  <button
                    onClick={() => handleRequestKibitzerAdvice(currentPosition)}
                    disabled={isKibitzerThinking}
                    className={`text-xs font-mono flex items-center gap-1 transition-colors disabled:opacity-50 cursor-pointer font-extrabold ${
                      isLightUX ? "text-cyan-700 hover:text-cyan-900" : "text-cyan-400 hover:text-cyan-300"
                    }`}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isKibitzerThinking ? "animate-spin" : ""}`} />
                    Eval
                  </button>
                </Tooltip>
                <button
                  onClick={() => {
                    setActiveKibitzerPreview(null);
                    setIsKibitzerOpen(false);
                  }}
                  className="p-0.5 rounded hover:bg-white/10 text-slate-400 hover:text-white cursor-pointer"
                  title="Close Kibitzer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2.5 font-mono text-xs">

            <div className="p-2.5 rounded-xl bg-cyan-950/40 border border-cyan-800/40 flex items-center justify-between text-[11px] gap-2">
              <div className="flex items-center gap-1.5 text-cyan-300 font-semibold truncate">
                <Bot className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                <span className="truncate">{kibitzerEngineName} (Depth {kibitzerDepth})</span>
              </div>
              <label className="flex items-center gap-1 text-[10px] text-slate-300 cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={kibitzerContinuous}
                  onChange={(e) => setKibitzerContinuous(e.target.checked)}
                  className="accent-cyan-500 cursor-pointer"
                />
                <span>Auto-Step</span>
              </label>
            </div>

            {/* Fast Variation Arrow Stepper Bar */}
            {!isKibitzerThinking && kibitzerVariations.length > 0 && (
              <div className={`px-2.5 py-1.5 rounded-xl border flex items-center justify-between gap-2 text-[10px] ${
                activeKibitzerPreview
                  ? "bg-cyan-500/15 border-cyan-400/50 text-cyan-200"
                  : "bg-black/25 border-white/10 text-slate-400"
              }`}>
                <span className="truncate font-bold">
                  {activeKibitzerPreview
                    ? `Line #${activeKibitzerPreview.lineIdx + 1}/${kibitzerVariations.length} · Move ${activeKibitzerPreview.stepIdx + 1}/${activeKibitzerPreview.moves.length}`
                    : `Step ${kibitzerVariations.length} lines: ↑/↓ line · ←/→ moves`}
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => switchKibitzerLine(-1)}
                    className="p-1 rounded bg-white/10 hover:bg-cyan-500/30 text-cyan-300 cursor-pointer"
                    title="Previous Kibitzer Line (↑)"
                  >
                    <ChevronUp className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => switchKibitzerLine(1)}
                    className="p-1 rounded bg-white/10 hover:bg-cyan-500/30 text-cyan-300 cursor-pointer"
                    title="Next Kibitzer Line (↓)"
                  >
                    <ChevronDown className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (activeKibitzerPreview) {
                        stepKibitzerMove(-1);
                      } else {
                        enterKibitzerLine(0, 0);
                      }
                    }}
                    disabled={!activeKibitzerPreview}
                    className="p-1 rounded bg-white/10 hover:bg-cyan-500/30 text-cyan-300 disabled:opacity-30 cursor-pointer"
                    title="Previous Move in Line (←)"
                  >
                    <ChevronLeft className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (activeKibitzerPreview) {
                        stepKibitzerMove(1);
                      } else {
                        enterKibitzerLine(0, 0);
                      }
                    }}
                    disabled={
                      !!activeKibitzerPreview &&
                      activeKibitzerPreview.stepIdx >= activeKibitzerPreview.moves.length - 1
                    }
                    className="p-1 rounded bg-white/10 hover:bg-cyan-500/30 text-cyan-300 disabled:opacity-30 cursor-pointer"
                    title="Next Move in Line (→)"
                  >
                    <ChevronRight className="w-3 h-3" />
                  </button>
                  {activeKibitzerPreview && (
                    <button
                      type="button"
                      onClick={() => setActiveKibitzerPreview(null)}
                      className="px-1.5 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/35 text-rose-300 font-bold cursor-pointer"
                      title="Return to main game position (Esc)"
                    >
                      Esc
                    </button>
                  )}
                </div>
              </div>
            )}

            {isKibitzerThinking ? (
              <div className="py-8 text-center space-y-2">
                <RefreshCw className="w-5 h-5 text-cyan-400 animate-spin mx-auto" />
                <p className="text-xs text-slate-400 font-mono">Computing Multi-PV variations to Depth {kibitzerDepth}...</p>
              </div>
            ) : kibitzerVariations.length === 0 ? (
              <div className="py-8 text-center space-y-3">
                <p className="text-slate-500 text-xs italic">No variations calculated for this position yet.</p>
                <button
                  onClick={() => handleRequestKibitzerAdvice(currentPosition)}
                  className="px-3 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-xs font-bold transition-all shadow cursor-pointer"
                >
                  Analyze Position
                </button>
              </div>
            ) : (
              <div className="space-y-2.5">
                {kibitzerVariations.map((v, idx) => {
                  const score = v.score_cp ?? 0;
                  const isPositive = score >= 0;
                  const scoreStr =
                    v.score_cp !== undefined && v.score_cp !== null
                      ? `${isPositive ? "+" : ""}${(score / 100).toFixed(2)}`
                      : v.is_mate && v.mate_in !== undefined && v.mate_in !== null
                      ? `#${v.mate_in}`
                      : "0.00";

                  const winProb =
                    v.win_prob !== undefined
                      ? `${(v.win_prob * 100).toFixed(1)}%`
                      : `${Math.max(1, Math.min(99, Math.round(50 + 50 * (2 / (1 + Math.exp(-0.004 * score)) - 1))))}%`;

                  const baseFen = activeKibitzerPreview?.rootFen || currentPosition;
                  const movesText = v.pv_san || v.pv_uci || "";
                  const moveTokens = movesText
                    .split(/\s+/)
                    .map((t) => t.replace(/^\d+\.+/, "").trim())
                    .filter((t) => t && !["1-0", "0-1", "1/2-1/2", "*"].includes(t));
                  const key = `${baseFen}_${idx}`;
                  const isSaved = savedVariationKeys[key];
                  const isActiveLine = activeKibitzerPreview?.lineIdx === idx;

                  return (
                    <div
                      key={idx}
                      onClick={() => {
                        if (!isActiveLine) enterKibitzerLine(idx, 0);
                      }}
                      className={`p-2.5 rounded-2xl border transition-all space-y-2 cursor-pointer ${
                        isActiveLine
                          ? "bg-cyan-950/50 border-cyan-400 ring-1 ring-cyan-400/40 shadow-md"
                          : "bg-black/40 border-white/10 hover:border-cyan-500/40"
                      }`}
                    >
                      <div className="flex items-center justify-between text-[11px] gap-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`w-5 h-5 rounded-md font-bold flex items-center justify-center text-[10px] ${
                            isActiveLine
                              ? "bg-cyan-400 text-slate-950 font-black"
                              : "bg-cyan-500/20 text-cyan-300"
                          }`}>
                            {idx + 1}
                          </span>
                          <span
                            className={`font-black px-2 py-0.5 rounded ${
                              isPositive
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/30"
                                : "bg-rose-500/20 text-rose-300 border border-rose-500/30"
                            }`}
                          >
                            {scoreStr}
                          </span>
                          <span className="text-slate-400 font-bold text-[10px]">
                            Win: <strong className="text-cyan-300">{winProb}</strong>
                          </span>
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isActiveLine) {
                                stepKibitzerMove(-1);
                              } else {
                                enterKibitzerLine(idx, 0);
                              }
                            }}
                            disabled={!isActiveLine}
                            className="p-0.5 rounded bg-white/10 hover:bg-cyan-500/25 text-cyan-300 disabled:opacity-30 cursor-pointer"
                            title="Step back in this line (←)"
                          >
                            <ChevronLeft className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isActiveLine) {
                                stepKibitzerMove(1);
                              } else {
                                enterKibitzerLine(idx, 0);
                              }
                            }}
                            disabled={
                              isActiveLine &&
                              !!activeKibitzerPreview &&
                              activeKibitzerPreview.stepIdx >= activeKibitzerPreview.moves.length - 1
                            }
                            className="p-0.5 rounded bg-white/10 hover:bg-cyan-500/25 text-cyan-300 disabled:opacity-30 cursor-pointer"
                            title="Step forward in this line (→)"
                          >
                            <ChevronRight className="w-3 h-3" />
                          </button>
                          <span className="text-[10px] text-slate-400 ml-0.5">d:{v.depth || kibitzerDepth}</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleSaveVariationToDb(v, idx);
                            }}
                            disabled={isSaved}
                            className={`px-2 py-0.5 rounded text-[10px] font-bold transition-all flex items-center gap-1 cursor-pointer ${
                              isSaved
                                ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                                : "bg-white/10 hover:bg-cyan-500/20 text-slate-300 hover:text-cyan-300 border border-white/15"
                            }`}
                            title={dbName ? `Save variation into ${dbName} PGN` : "Save variation"}
                          >
                            {isSaved ? (
                              <>
                                <Check className="w-3 h-3 text-emerald-400" />
                                <span>Saved</span>
                              </>
                            ) : (
                              <>
                                <Bookmark className="w-3 h-3" />
                                <span>Save</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-1 text-xs text-slate-200 font-mono leading-relaxed bg-black/30 p-2 rounded-xl border border-white/5">
                        {moveTokens.length > 0 ? (
                          moveTokens.map((tok, mIdx) => {
                            const isCurrentStep =
                              isActiveLine && activeKibitzerPreview?.stepIdx === mIdx;
                            return (
                              <button
                                key={mIdx}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  enterKibitzerLine(idx, mIdx);
                                }}
                                className={`px-1.5 py-0.5 rounded transition-colors cursor-pointer ${
                                  isCurrentStep
                                    ? "bg-cyan-400 text-slate-950 font-black shadow-sm"
                                    : isActiveLine &&
                                      activeKibitzerPreview &&
                                      mIdx < activeKibitzerPreview.stepIdx
                                    ? "bg-cyan-500/20 text-cyan-200"
                                    : "hover:bg-white/10 text-slate-200"
                                }`}
                                title={`Jump to move ${mIdx + 1} of Line #${idx + 1}`}
                              >
                                {toDisplaySan(tok)}
                              </button>
                            );
                          })
                        ) : (
                          <span className="text-slate-500 italic">No line returned</span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          </div>
        )}
      </div>

      {/* Kibitzer Settings Modal */}
      {isKibitzerSettingsOpen && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div
            className={`w-full max-w-md rounded-3xl border p-6 shadow-2xl space-y-4 ${uxTheme.panel} ${uxTheme.border}`}
          >
            <div className="flex items-center justify-between border-b pb-3 border-white/10">
              <div className="flex items-center gap-2 text-cyan-400 font-extrabold text-sm">
                <Settings2 className="w-4 h-4" />
                <span>Kibitzer Engine & Search Settings</span>
              </div>
              <button
                onClick={() => setIsKibitzerSettingsOpen(false)}
                className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs font-mono">
              <div className="space-y-1">
                <label className="text-slate-300 font-bold block">Engine Selection</label>
                <select
                  value={kibitzerEngine}
                  onChange={(e) => setKibitzerEngine(e.target.value)}
                  className="w-full p-2.5 rounded-xl bg-black/40 border border-white/15 text-white outline-none cursor-pointer"
                >
                  {registeredEngines.length > 0 ? (
                    registeredEngines.map((eng) => (
                      <option key={eng.id} value={eng.id}>
                        {eng.icon ? `${eng.icon} ` : ""}{eng.name} ({eng.elo})
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="patricia">Patricia v4 (Fast NNUE)</option>
                      <option value="stockfish">Stockfish 18 (Grandmaster UCI)</option>
                    </>
                  )}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-slate-300 font-bold block">Search Depth (Plies)</label>
                  <input
                    type="number"
                    min={10}
                    max={50}
                    value={kibitzerDepth}
                    onChange={(e) => setKibitzerDepth(Math.max(10, parseInt(e.target.value) || 20))}
                    className="w-full p-2.5 rounded-xl bg-black/40 border border-white/15 text-white outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-slate-300 font-bold block">Multi-PV Lines</label>
                  <select
                    value={kibitzerMultipv}
                    onChange={(e) => setKibitzerMultipv(parseInt(e.target.value) || 3)}
                    className="w-full p-2.5 rounded-xl bg-black/40 border border-white/15 text-white outline-none cursor-pointer"
                  >
                    <option value={1}>1 Line (Best Move Only)</option>
                    <option value={2}>2 Lines</option>
                    <option value={3}>3 Lines (Default)</option>
                    <option value={4}>4 Lines</option>
                    <option value={5}>5 Lines</option>
                    <option value={6}>6 Lines</option>
                    <option value={8}>8 Lines</option>
                    <option value={10}>10 Lines</option>
                    <option value={12}>12 Lines</option>
                    <option value={15}>15 Lines (Brilliant Scan)</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-slate-300 font-bold block">Search Mode Limit</label>
                <div className="grid grid-cols-3 gap-2">
                  {(["depth", "time", "both"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setKibitzerSearchMode(m)}
                      className={`p-2 rounded-xl text-center font-bold capitalize transition-colors cursor-pointer border ${
                        kibitzerSearchMode === m
                          ? "bg-cyan-500/20 text-cyan-300 border-cyan-500"
                          : "bg-white/5 text-slate-400 border-white/10 hover:bg-white/10"
                      }`}
                    >
                      {m === "depth" ? "Depth Only" : m === "time" ? "Time Limit" : "Both"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-slate-300 font-bold block">Threads</label>
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={kibitzerThreads}
                    onChange={(e) => setKibitzerThreads(Math.max(1, parseInt(e.target.value) || 1))}
                    className="w-full p-2.5 rounded-xl bg-black/40 border border-white/15 text-white outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-slate-300 font-bold block">Hash (MB)</label>
                  <input
                    type="number"
                    min={16}
                    max={2048}
                    step={16}
                    value={kibitzerHashMb}
                    onChange={(e) => setKibitzerHashMb(Math.max(16, parseInt(e.target.value) || 64))}
                    className="w-full p-2.5 rounded-xl bg-black/40 border border-white/15 text-white outline-none"
                  />
                </div>
              </div>
            </div>

            <div className="pt-2">
              <button
                onClick={() => {
                  setIsKibitzerSettingsOpen(false);
                  handleRequestKibitzerAdvice(currentPosition);
                }}
                className="w-full py-2.5 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-extrabold rounded-xl transition-all shadow-lg cursor-pointer text-xs"
              >
                Apply &amp; Re-Analyze
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
