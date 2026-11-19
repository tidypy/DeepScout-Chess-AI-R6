import { useState, useRef, useCallback, useEffect } from "react";
import { Chess } from "chess.js";
import { Chessboard as BaseChessboard } from "react-chessboard";
const Chessboard = BaseChessboard as React.ComponentType<{
  boardWidth?: number;
  options?: any;
}>;
import { UXTheme, BoardTheme } from "../../lib/theme";
import { UciOptionsInspector } from "../engines/UciOptionsInspector";
import { useClickLogger } from "../../lib/clickLogger";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchEngineList,
  fetchEngineOptions,
  fetchEnginePlay,
  fetchEngineVariations,
  fetchEngineEvaluate,
  fetchDatabases,
  testUciEngine,
  browseEngineFile,
  registerCustomEngine,
  updateCustomEngine,
  removeCustomEngine,
  importPgn,
  createSparringGame,
  logKibitzerVariation,
  logTutorFlag,
  flushGameTelemetry,
  TelemetryFlushPayload,
  EngineInfo,
  fetchOpeningBooksList,
  probeOpeningBook,
  fetchBookCandidates,
  BookCandidate,
  saveRepertoireEdge,
  VariationLine,
  TutorInterruptMode,
  fetchEngineLogs,
  initEngineHandshake,
} from "../../lib/api";
import { AskGrandmasterAction } from "../ai_grandmaster/AskGrandmasterAction";
import { customChessPieces } from "../../components/chessboard/customPieces";
import { Tooltip } from "../../components/common/Tooltip";
import {
  Swords,
  RotateCcw,
  BookOpen,
  Play,
  Sliders,
  ArrowUpDown,
  Save,
  Trophy,
  Download,
  RefreshCw,
  Cpu,
  Plus,
  Trash2,
  X,
  FolderOpen,
  Gauge,
  Sparkles,
  GraduationCap,
  Lightbulb,
  BookmarkPlus,
  Zap,
  Flame,
  Shield,
  Settings,
  Layers,
  Filter,
  CheckCircle2,
  Undo2,
  Terminal,
  ChevronDown,
  ChevronUp,
  Flag,
  Brain,
  BarChart3,
} from "lucide-react";

interface SparViewProps {
  uxTheme: UXTheme;
  boardTheme: BoardTheme;
  initialEngineId?: string | null;
  onConsumedInitialEngine?: () => void;
}

export interface SparMoveRecord {
  ply: number;
  moveNumber: number;
  turn: "white" | "black";
  san: string;
  uci?: string;
  eval?: string;
  evalCp?: number;
  cpLoss?: number;
  tag?: "best" | "brilliant" | "tactical" | "good" | "inaccuracy" | "mistake" | "blunder" | "book" | "solid";
  badge?: string;
  badgeLabel?: string;
  depth?: number;
  nps?: string | number;
  time_ms?: number;
  source?: "user" | "engine" | "book";
  book_name?: string;
  weight?: number;
}

// ── Tutor evaluation types & helpers ────────────────────────────────────────
/** Loss maths clamp (±10.00): beyond this a position is simply "winning"; stops mate-distance noise. */
const TUTOR_CP_CAP = 1000;
/** A decisive advantage (+6.00) — the "winning" line for the don't-nag-while-winning setting. */
const TUTOR_WIN_CP = 600;
const firstMoveToken = (s?: string | null): string => (s || "").trim().split(/\s+/)[0] || "";
const capTutorCp = (cp: number): number => Math.max(-TUTOR_CP_CAP, Math.min(TUTOR_CP_CAP, cp));
/** Same mate -> centipawn scale used by the backend classifier. */
const mateToCp = (m: number): number => (m > 0 ? 10000 - Math.abs(m) * 100 : -10000 + Math.abs(m) * 100);

interface TutorMoveEval {
  bestVar: VariationLine;
  isPlayedBest: boolean;
  /** Mover-POV centipawns of the best line before the move / of the position after the played move. */
  bestCp: number;
  afterCp: number;
  /** Capped loss in centipawns (>= 0). */
  cpLoss: number;
  bestIsMate: boolean;
  bestMateIn: number | null;
  afterIsMate: boolean;
  afterMateIn: number | null;
}

interface TutorFlagData {
  flag_type: "user_blunder" | "engine_blunder" | "tactic" | "best_move_available" | "mistake" | "mate_alert";
  loss_cp: number;
  /** FIRST move only (SAN / UCI). The full principal variation is in best_line_san. */
  best_move_san: string;
  best_move_uci: string;
  best_line_san?: string;
  eval_score: string;
  /** Set when the mover had a forced mate available ("Mate in X available"). */
  mate_in?: number | null;
  tags: string[];
  fen_before?: string;
  played_san?: string;
  ply?: number;
}

const KIBITZER_FILTER_HELP: Record<"all" | "tactical" | "brilliant" | "solid", { title: string; description: string }> = {
  all: {
    title: "All lines",
    description: "Show every candidate line the engine returned, ranked by evaluation.",
  },
  tactical: {
    title: "Tactical",
    description: "Filters candidate lines to forcing moves: checks, captures and promotions that keep the evaluation.",
  },
  brilliant: {
    title: "Brilliant",
    description: "Filters candidate lines to piece sacrifices that maintain or improve evaluation. Raise Candidate Lines (up to 15) to widen the search.",
  },
  solid: {
    title: "Solid",
    description: "Filters candidate lines to quiet, non-forcing moves that keep the position safe.",
  },
};

const classifyMoveQuality = (
  cpLoss: number,
  isBook: boolean,
  tags: string[] = []
): { tag: "best" | "brilliant" | "tactical" | "good" | "inaccuracy" | "mistake" | "blunder" | "book"; badge: string; label: string } => {
  if (isBook) {
    return { tag: "book", badge: "📖", label: "Book" };
  }
  if (tags.includes("brilliant")) {
    return { tag: "brilliant", badge: "!!", label: "Brilliant" };
  }
  if (tags.includes("tactical")) {
    return { tag: "tactical", badge: "⚡", label: "Tactic" };
  }
  if (cpLoss <= 10) {
    return { tag: "best", badge: "✨", label: "Best" };
  }
  if (cpLoss <= 35) {
    return { tag: "good", badge: "✓", label: "Good" };
  }
  if (cpLoss <= 90) {
    return { tag: "inaccuracy", badge: "?!", label: "Inaccuracy" };
  }
  if (cpLoss <= 200) {
    return { tag: "mistake", badge: "?", label: "Mistake" };
  }
  return { tag: "blunder", badge: "??", label: "Blunder" };
};

const getMoveBadgeStyle = (tag?: string) => {
  switch (tag) {
    case "brilliant":
      return "bg-amber-500/25 text-amber-300 border border-amber-500/50 shadow-sm";
    case "best":
      return "bg-emerald-500/25 text-emerald-300 border border-emerald-500/40";
    case "good":
      return "bg-cyan-500/20 text-cyan-300 border border-cyan-500/30";
    case "book":
      return "bg-purple-500/25 text-purple-300 border border-purple-500/40";
    case "inaccuracy":
      return "bg-yellow-500/25 text-yellow-300 border border-yellow-500/40";
    case "mistake":
      return "bg-orange-500/30 text-orange-300 border border-orange-500/50";
    case "blunder":
      return "bg-red-600/30 text-red-300 border border-red-500/60 font-black";
    case "tactical":
      return "bg-indigo-500/30 text-indigo-300 border border-indigo-500/40";
    default:
      return "bg-slate-500/20 text-slate-300 border border-slate-500/30";
  }
};

const DEFAULT_ENGINES: EngineInfo[] = [
  { id: "stockfish", name: "Stockfish 18", elo: "3500+", style: "Grandmaster Dynamic & Elo Scale", icon: "🤖", supports_elo: true, min_elo: 1320, max_elo: 3190 },
  { id: "dragon", name: "Dragon by Komodo", elo: "3500+", style: "Ultra-Sharp Tactical & Active Play", icon: "🐉", supports_elo: true, min_elo: 1000, max_elo: 3500 },
  { id: "houdini", name: "Houdini 1.5a", elo: "3300", style: "Legendary Tactical King Hunter", icon: "🎩", supports_elo: false },
  { id: "rybka", name: "Rybka 2.3", elo: "3200", style: "Dynamic Sacrificial & Aggressive", icon: "🐟", supports_elo: true, min_elo: 1200, max_elo: 2400 },
  { id: "critter", name: "Critter 1.6a", elo: "3100", style: "Sharp Tactical & Counter-Attack", icon: "🦗", supports_elo: false },
  { id: "andscacs", name: "Andscacs 0.94", elo: "3100", style: "Modern Precise Tactical Defense", icon: "⚔️", supports_elo: false },
  { id: "patricia", name: "Patricia 4.0", elo: "2800", style: "Fast Alpha-Beta NNUE Tactician", icon: "⚡", supports_elo: true, min_elo: 1000, max_elo: 2800 },
  { id: "fruit", name: "Fruit 2.3.1", elo: "2850", style: "Classical Positional Calculator", icon: "🍎", supports_elo: false },
  { id: "toga", name: "Deep Toga", elo: "2800", style: "Relentless King-Side Attacker", icon: "🏛️", supports_elo: false },
  { id: "rodent", name: "Rodent II", elo: "2700", style: "Flexible Classical Club Master", icon: "🐭", supports_elo: false },
  { id: "cheng", name: "Cheng 4.41", elo: "2600", style: "Solid Balanced Endgame Specialist", icon: "🛡️", supports_elo: true, min_elo: 800, max_elo: 2600 },
  { id: "cdrill2000", name: "CDrill 2000", elo: "2000", style: "Master Practice Sparring Partner", icon: "🎖️", supports_elo: false },
  { id: "maia1900", name: "Maia 1900", elo: "1900", style: "Human Club Master Neural Network", icon: "🎯", supports_elo: false },
  { id: "ct800", name: "CT800 V1.46", elo: "1850", style: "Clean Positional Classicist", icon: "🏰", supports_elo: true, min_elo: 1000, max_elo: 2400 },
  { id: "cdrill", name: "CDrill 1800", elo: "1800", style: "Intermediate Training Partner", icon: "🏅", supports_elo: false },
  { id: "maia1500", name: "Maia 1500", elo: "1500", style: "Human-like Neural Play (Lichess 1500)", icon: "🧠", supports_elo: false },
  { id: "maia1100", name: "Maia 1100", elo: "1100", style: "Casual Enthusiast Neural Simulation", icon: "🌱", supports_elo: false },
];

const SPARRING_DB_NAME = "Sparring_Games.sqlite";
const KIBITZER_DB_NAME = "Kibitzer_Analysis.sqlite";
const TUTOR_DB_NAME = "Tutor_Games.sqlite";

const SPAR_SETTINGS_STORAGE_KEY = "deepscout_spar_settings_v1";

const loadPersistedSparSettings = (): Record<string, any> => {
  try {
    const raw = localStorage.getItem(SPAR_SETTINGS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
};

export function SparView({ uxTheme, boardTheme, initialEngineId, onConsumedInitialEngine }: SparViewProps) {
  const { logAction } = useClickLogger();
  const queryClient = useQueryClient();
  const isLight = uxTheme?.mode === "light" || uxTheme?.id === "clean-light";
  const [savedSettings] = useState<Record<string, any>>(loadPersistedSparSettings);

  // Game & Match State
  const [game, setGame] = useState(new Chess());
  const [fen, setFen] = useState(game.fen());
  const [currentGameId, setCurrentGameId] = useState<string>("");
  const [sparSessionError, setSparSessionError] = useState<string | null>(null);
  const [selectedEngine, setSelectedEngine] = useState<string>(() => initialEngineId || savedSettings.selectedEngine || "stockfish");
  const [selectedBook, setSelectedBook] = useState<string>(() => savedSettings.selectedBook ?? "GMopenings.bin");
  const [playerSideChoice, setPlayerSideChoice] = useState<"white" | "black" | "random">(() => savedSettings.playerSideChoice || savedSettings.playerSide || "white");
  const [playerSide, setPlayerSide] = useState<"white" | "black">(() => (savedSettings.playerSide === "black" ? "black" : "white"));
  // DSD-57: purely visual board perspective, independent of which colour the human plays
  const [boardOrientation, setBoardOrientation] = useState<"white" | "black">(() =>
    savedSettings.boardOrientation === "black" || savedSettings.boardOrientation === "white"
      ? savedSettings.boardOrientation
      : savedSettings.playerSide === "black" ? "black" : "white"
  );
  const [targetElo, setTargetElo] = useState<number>(() => savedSettings.targetElo ?? 1600);
  const [isGameActive, setIsGameActive] = useState(false);
  const [isEngineThinking, setIsEngineThinking] = useState(false);
  const [moveHistory, setMoveHistory] = useState<string[]>([]);
  const [moveRecords, setMoveRecords] = useState<SparMoveRecord[]>([]);
  const [showAcpl, setShowAcpl] = useState<boolean>(() => savedSettings.showAcpl ?? true);
  const [showMoveQualityBadges, setShowMoveQualityBadges] = useState<boolean>(() => savedSettings.showMoveQualityBadges ?? true);
  const [evalScore, setEvalScore] = useState("+0.00");
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [autosaveAlert, setAutosaveAlert] = useState<string | null>(null);
  const [isBookPanelOpen, setIsBookPanelOpen] = useState<boolean>(true);
  const [candidateBookDb, setCandidateBookDb] = useState<string>(() => savedSettings.candidateBookDb ?? "");
  const [isCandidateBookOpen, setIsCandidateBookOpen] = useState<boolean>(() => savedSettings.isCandidateBookOpen ?? false);

  // DSD-50: Drag-Resizable board width (persisted to localStorage, clamped 400px - 850px)
  const [boardContainerWidth, setBoardContainerWidth] = useState<number>(() => {
    const stored = localStorage.getItem("deepscout_spar_board_width");
    const parsed = stored ? parseInt(stored, 10) : 560;
    return Math.min(850, Math.max(400, isNaN(parsed) ? 560 : parsed));
  });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(0);
  const currentWidthRef = useRef(boardContainerWidth);
  currentWidthRef.current = boardContainerWidth;

  // DSD-48: Opponent engine selection panel collapse (open when game idle)
  const [isOpponentSelectionOpen, setIsOpponentSelectionOpen] = useState<boolean>(() => savedSettings.isOpponentSelectionOpen ?? true);

  // DSD-48: Legacy .bin Opening Book Theory card collapse
  const [isLegacyBookOpen, setIsLegacyBookOpen] = useState<boolean>(() => savedSettings.isLegacyBookOpen ?? false);

  // DSD-44: Non-Destructive Takeback & Staged Variation Override
  const [stagedVariation, setStagedVariation] = useState<{
    active: boolean;
    parentFen: string;
    moveUci: string;
    moveSan: string;
    source: "USER" | "KIBITZER" | "TUTOR" | "BOOK";
  } | null>(null);

  // Live UCI Terminal Drawer — 3-stream unified console (Sparring / Kibitzer / Tutor)
  const [sparringUciLog, setSparringUciLog] = useState<string[]>([]);
  const [kibitzerUciLog, setKibitzerUciLog] = useState<string[]>([]);
  const [tutorUciLog, setTutorUciLog] = useState<string[]>([]);
  const [activeUciTab, setActiveUciTab] = useState<"sparring" | "kibitzer" | "tutor">("sparring");
  const [isUciDrawerOpen, setIsUciDrawerOpen] = useState<boolean>(false);
  const terminalScrollRef = useRef<HTMLDivElement>(null);

  // Append helper — caps at 400 lines per circular buffer
  const appendSparringUciLog = (lines?: string[]) => {
    if (!lines || lines.length === 0) return;
    setSparringUciLog((prev) => [...prev, ...lines].slice(-400));
  };

  const appendKibitzerUciLog = (lines?: string[]) => {
    if (!lines || lines.length === 0) return;
    setKibitzerUciLog((prev) => [...prev, ...lines].slice(-400));
  };

  const appendTutorUciLog = (lines?: string[]) => {
    if (!lines || lines.length === 0) return;
    setTutorUciLog((prev) => [...prev, ...lines].slice(-400));
  };

  // Tabbed Right Pane: 'sparring' | 'kibitzer' | 'tutor'
  const [rightPanelTab, setRightPanelTab] = useState<"sparring" | "kibitzer" | "tutor">(() => savedSettings.rightPanelTab || "sparring");

  // Kibitzer Companion State & Advanced Settings
  const [kibitzerEngine, setKibitzerEngine] = useState<string>(() => savedSettings.kibitzerEngine || "patricia");
  const [kibitzerMode, setKibitzerMode] = useState<"on_demand" | "continuous" | "opponent_clock_bound" | "user_clock_bound">(() => savedSettings.kibitzerMode || "on_demand");
  const [kibitzerMultipv, setKibitzerMultipv] = useState<number>(() => savedSettings.kibitzerMultipv ?? 3);
  const [kibitzerDepth, setKibitzerDepth] = useState<number>(() => savedSettings.kibitzerDepth ?? 20);
  const [kibitzerSearchMode, setKibitzerSearchMode] = useState<"depth" | "time" | "both">(() => savedSettings.kibitzerSearchMode || "depth");
  const [kibitzerTimeLimitMs, setKibitzerTimeLimitMs] = useState<number>(() => savedSettings.kibitzerTimeLimitMs ?? 1000);
  const [kibitzerThreads, setKibitzerThreads] = useState<number>(() => savedSettings.kibitzerThreads ?? 1);
  const [kibitzerHashMb, setKibitzerHashMb] = useState<number>(() => savedSettings.kibitzerHashMb ?? 64);
  const [kibitzerDisplayFormat, setKibitzerDisplayFormat] = useState<"both" | "cp" | "win_prob">(() => savedSettings.kibitzerDisplayFormat || "both");
  const [kibitzerShowArrows, setKibitzerShowArrows] = useState<boolean>(() => savedSettings.kibitzerShowArrows ?? true);
  const [kibitzerAutoSave, setKibitzerAutoSave] = useState<boolean>(() => savedSettings.kibitzerAutoSave ?? false);
  const [kibitzerTagFilter, setKibitzerTagFilter] = useState<"all" | "tactical" | "brilliant" | "solid">(() => savedSettings.kibitzerTagFilter || "all");
  const [isKibitzerThinking, setIsKibitzerThinking] = useState(false);
  const [kibitzerVariations, setKibitzerVariations] = useState<VariationLine[]>([]);
  // FEN the stored variations were computed for. Arrows/lines are only shown while the board is
  // still on this position, so stale arrows never linger after a move, takeback or override.
  const [kibitzerVariationsFen, setKibitzerVariationsFen] = useState<string>("");
  const positionKey = (f: string) => (f || "").split(" ").slice(0, 4).join(" ");
  const applyKibitzerVariations = (variations: VariationLine[], analyzedFen: string) => {
    setKibitzerVariations(variations);
    setKibitzerVariationsFen(analyzedFen);
  };
  const clearKibitzerVariations = () => {
    setKibitzerVariations([]);
    setKibitzerVariationsFen("");
  };
  const [isKibitzerSettingsOpen, setIsKibitzerSettingsOpen] = useState(false);
  const [isKibitzerPanelOpen, setIsKibitzerPanelOpen] = useState(true);
  const [isMatchRecordOpen, setIsMatchRecordOpen] = useState(true);

  // Tutor Companion State & Advanced Settings
  const [tutorEngine, setTutorEngine] = useState<string>(() => savedSettings.tutorEngine || "stockfish");
  const [tutorInterruptMode, setTutorInterruptMode] = useState<TutorInterruptMode>(() => savedSettings.tutorInterruptMode || "freeze_on_flag");
  const [isTutorEnabled, setIsTutorEnabled] = useState<boolean>(() => savedSettings.isTutorEnabled ?? true);
  const [tutorBlunderThresholdCp, setTutorBlunderThresholdCp] = useState<number>(() => savedSettings.tutorBlunderThresholdCp ?? 150);
  const [tutorMistakeThresholdCp, setTutorMistakeThresholdCp] = useState<number>(() => savedSettings.tutorMistakeThresholdCp ?? 75);
  const [tutorAlertTactics, setTutorAlertTactics] = useState<boolean>(() => savedSettings.tutorAlertTactics ?? true);
  const [tutorHintDepth, setTutorHintDepth] = useState<"full" | "piece_only" | "strategic">(() => savedSettings.tutorHintDepth || "full");
  const [tutorShowArrow, setTutorShowArrow] = useState<boolean>(() => savedSettings.tutorShowArrow ?? true);
  // Stay quiet while decisively winning (+6.00 / forced mate) unless the win is actually thrown away.
  const [tutorSuppressWhenWinning, setTutorSuppressWhenWinning] = useState<boolean>(() => savedSettings.tutorSuppressWhenWinning ?? true);
  // Only evaluate the player's own moves. When off, engine moves are also evaluated (silently, for stats/logs).
  const [tutorPlayerMovesOnly, setTutorPlayerMovesOnly] = useState<boolean>(() => savedSettings.tutorPlayerMovesOnly ?? true);
  const [isTutorSettingsOpen, setIsTutorSettingsOpen] = useState(false);
  const [activeTutorFlag, setActiveTutorFlag] = useState<TutorFlagData | null>(null);

  // Custom Engine Modal State
  const [isAddEngineModalOpen, setIsAddEngineModalOpen] = useState(false);
  const [isQuickTuningOpen, setIsQuickTuningOpen] = useState(false);
  const [isQuickUciExpanded, setIsQuickUciExpanded] = useState(false);
  const [quickTuningOptions, setQuickTuningOptions] = useState<Record<string, any>>({});
  const [isSavingQuickTuning, setIsSavingQuickTuning] = useState(false);
  const [opponentThinkTimeMs, setOpponentThinkTimeMs] = useState<number>(() => savedSettings.opponentThinkTimeMs ?? 450);
  const [opponentThreads, setOpponentThreads] = useState<number>(() => savedSettings.opponentThreads ?? 1);
  const [opponentHashMb, setOpponentHashMb] = useState<number>(() => savedSettings.opponentHashMb ?? 64);
  const [newEnginePath, setNewEnginePath] = useState("");
  const [newEngineName, setNewEngineName] = useState("");
  const [newEngineElo, setNewEngineElo] = useState("2400");
  const [newEngineStyle, setNewEngineStyle] = useState("Custom Tactical Engine");
  const [newEngineIcon, setNewEngineIcon] = useState("⚔️");
  const [isBrowsingEngine, setIsBrowsingEngine] = useState(false);
  const [uciTestError, setUciTestError] = useState<string | null>(null);
  const [testedUciOptions, setTestedUciOptions] = useState<Record<string, any>>({});
  const [newEngineCustomOptions, setNewEngineCustomOptions] = useState<Record<string, any>>({});

  // DSD-51: Save Copy... popover state
  const [isSaveCopyOpen, setIsSaveCopyOpen] = useState(false);
  const [saveCopyTargetDb, setSaveCopyTargetDb] = useState<string>(SPARRING_DB_NAME);
  const [saveCopyToast, setSaveCopyToast] = useState<string | null>(null);
  // DSD-51 + Pass 2: Last captured evals for adjudication cascade (White-POV centipawns)
  const lastTutorCpRef    = useRef<number | null>(null);
  const lastKibitzerCpRef = useRef<number | null>(null);
  const lastSparringCpRef = useRef<number | null>(null);
  const currentGameIdRef  = useRef<string>(currentGameId);
  currentGameIdRef.current = currentGameId;

  const ensureGameId = (): string => {
    const existing = currentGameIdRef.current?.trim() || currentGameId?.trim();
    if (existing) return existing;
    const generated =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `spar-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    currentGameIdRef.current = generated;
    setCurrentGameId(generated);
    return generated;
  };

  // DSD-53: Auto-scroll terminal drawer on new logs or tab switch
  useEffect(() => {
    if (isUciDrawerOpen && terminalScrollRef.current) {
      terminalScrollRef.current.scrollTop = terminalScrollRef.current.scrollHeight;
    }
  }, [sparringUciLog, kibitzerUciLog, tutorUciLog, activeUciTab, isUciDrawerOpen]);

  // DSD-53: Seed existing logs on initial mount
  useEffect(() => {
    fetchEngineLogs()
      .then((logs) => {
        if (logs?.sparring?.length) appendSparringUciLog(logs.sparring);
        if (logs?.kibitzer?.length) appendKibitzerUciLog(logs.kibitzer);
        if (logs?.tutor?.length) appendTutorUciLog(logs.tutor);
      })
      .catch(() => {});
  }, []);

  // DSD-58: engine list uses placeholderData (not initialData) so saved custom_engines.json profiles always load fresh
  const { data: enginesData, isPlaceholderData: isEnginesPlaceholder } = useQuery({
    queryKey: ["engines"],
    queryFn: fetchEngineList,
    placeholderData: DEFAULT_ENGINES,
  });

  // DSD-58: consume engine handoff from the Engines Lab "Spar" button
  useEffect(() => {
    if (initialEngineId) {
      setSelectedEngine(initialEngineId);
      setRightPanelTab("sparring");
      onConsumedInitialEngine?.();
    }
  }, [initialEngineId, onConsumedInitialEngine]);

  // DSD-55: persist Sparring / Tutor / Kibitzer / orientation preferences across tab switches and restarts
  useEffect(() => {
    try {
      localStorage.setItem(
        SPAR_SETTINGS_STORAGE_KEY,
        JSON.stringify({
          selectedEngine, selectedBook, playerSideChoice, playerSide, boardOrientation, targetElo,
          showAcpl, showMoveQualityBadges, candidateBookDb, isCandidateBookOpen,
          isOpponentSelectionOpen, isLegacyBookOpen, rightPanelTab,
          kibitzerEngine, kibitzerMode, kibitzerMultipv, kibitzerDepth, kibitzerSearchMode,
          kibitzerTimeLimitMs, kibitzerThreads, kibitzerHashMb, kibitzerDisplayFormat,
          kibitzerShowArrows, kibitzerAutoSave, kibitzerTagFilter,
          tutorEngine, tutorInterruptMode, isTutorEnabled, tutorBlunderThresholdCp,
          tutorMistakeThresholdCp, tutorAlertTactics, tutorHintDepth, tutorShowArrow,
          tutorSuppressWhenWinning, tutorPlayerMovesOnly,
          opponentThinkTimeMs, opponentThreads, opponentHashMb,
        })
      );
    } catch {}
  }, [
    selectedEngine, selectedBook, playerSideChoice, playerSide, boardOrientation, targetElo,
    showAcpl, showMoveQualityBadges, candidateBookDb, isCandidateBookOpen,
    isOpponentSelectionOpen, isLegacyBookOpen, rightPanelTab,
    kibitzerEngine, kibitzerMode, kibitzerMultipv, kibitzerDepth, kibitzerSearchMode,
    kibitzerTimeLimitMs, kibitzerThreads, kibitzerHashMb, kibitzerDisplayFormat,
    kibitzerShowArrows, kibitzerAutoSave, kibitzerTagFilter,
    tutorEngine, tutorInterruptMode, isTutorEnabled, tutorBlunderThresholdCp,
    tutorMistakeThresholdCp, tutorAlertTactics, tutorHintDepth, tutorShowArrow,
    tutorSuppressWhenWinning, tutorPlayerMovesOnly,
    opponentThinkTimeMs, opponentThreads, opponentHashMb,
  ]);

  // Probe native UCI options strictly for the active sparring engine when Quick Tuning is open
  const {
    data: quickTuningAllOptions = {},
    isFetching: isLoadingQuickUciOptions,
  } = useQuery({
    queryKey: ["engineOptions", selectedEngine],
    queryFn: () => fetchEngineOptions(selectedEngine),
    enabled: isQuickTuningOpen && !!selectedEngine,
    staleTime: 60_000,
  });

  const findCaseInsensitiveKey = (obj: Record<string, any> | undefined, candidates: string[]): string | null => {
    if (!obj) return null;
    const lowerMap = new Map<string, string>();
    Object.keys(obj).forEach((k) => lowerMap.set(k.toLowerCase(), k));
    for (const c of candidates) {
      const hit = lowerMap.get(c.toLowerCase());
      if (hit) return hit;
    }
    return null;
  };

  const activeThreadsOptionKey =
    findCaseInsensitiveKey(quickTuningAllOptions as Record<string, any>, ["Threads", "Number of Threads", "Max Threads"]) ||
    findCaseInsensitiveKey(quickTuningOptions, ["Threads", "Number of Threads", "Max Threads"]) ||
    "Threads";

  // DSD-58 + Bidirectional UCI Sync: hydrate Threads / Hash / UCI_Elo / full UCI options
  // whenever the selected engine or its saved profile (from Engines tab or Quick Tuning) changes
  const lastHydratedSigRef = useRef<string>("");
  useEffect(() => {
    if (isEnginesPlaceholder || !enginesData) return;
    const eng = enginesData.find((e) => e.id === selectedEngine);
    if (!eng) return;
    const opts = eng.options || {};
    const sig = eng.id + "::" + JSON.stringify(opts);
    if (lastHydratedSigRef.current === sig) return;
    lastHydratedSigRef.current = sig;

    setQuickTuningOptions({ ...opts });

    const tKey = findCaseInsensitiveKey(opts, ["Threads", "Number of Threads", "Max Threads"]);
    if (tKey && !isNaN(Number(opts[tKey]))) {
      setOpponentThreads(Math.max(1, Math.min(16, Number(opts[tKey]))));
    }
    const hKey = findCaseInsensitiveKey(opts, ["Hash"]);
    if (hKey && !isNaN(Number(opts[hKey]))) {
      setOpponentHashMb(Math.max(16, Math.min(2048, Number(opts[hKey]))));
    }
    if (eng.supports_elo) {
      const minE = eng.min_elo || 1000;
      const maxE = eng.max_elo || 3500;
      const eloKey = findCaseInsensitiveKey(opts, ["UCI_Elo"]);
      if (eloKey && !isNaN(Number(opts[eloKey]))) {
        setTargetElo(Math.min(maxE, Math.max(minE, Number(opts[eloKey]))));
      } else {
        setTargetElo((prev) => Math.min(maxE, Math.max(minE, prev)));
      }
    }
  }, [selectedEngine, enginesData, isEnginesPlaceholder]);

  // Reset Quick Tuning draft options strictly to the active engine's saved profile whenever modal opens or engine switches
  useEffect(() => {
    if (!isQuickTuningOpen) return;
    const eng = (enginesData || DEFAULT_ENGINES).find((e) => e.id === selectedEngine);
    const saved = { ...(eng?.options || {}) };
    setQuickTuningOptions(saved);
    const tKey = findCaseInsensitiveKey(saved, ["Threads", "Number of Threads", "Max Threads"]);
    if (tKey && !isNaN(Number(saved[tKey]))) {
      setOpponentThreads(Math.max(1, Math.min(16, Number(saved[tKey]))));
    }
    const hKey = findCaseInsensitiveKey(saved, ["Hash"]);
    if (hKey && !isNaN(Number(saved[hKey]))) {
      setOpponentHashMb(Math.max(16, Math.min(2048, Number(saved[hKey]))));
    }
  }, [isQuickTuningOpen, selectedEngine, enginesData]);

  // DSD-53 / DSD-58: engine handshake on selection or profile change (backend merges the saved profile options)
  const lastHandshakeSigRef = useRef<string>("");
  useEffect(() => {
    if (!selectedEngine || isEnginesPlaceholder) return;
    const eng = (enginesData || DEFAULT_ENGINES).find((e) => e.id === selectedEngine);
    const sig = selectedEngine + "::" + JSON.stringify(eng?.options || {});
    if (lastHandshakeSigRef.current === sig) return;
    lastHandshakeSigRef.current = sig;
    initEngineHandshake({
      engine_id: selectedEngine,
      subsystem: "sparring",
      elo: eng?.supports_elo ? targetElo : undefined,
      book_name: selectedBook,
      use_book: Boolean(selectedBook && selectedBook !== "none" && selectedBook !== "engine_native"),
      custom_options: eng?.options,
    })
      .then((res) => {
        if (res?.uci_log) appendSparringUciLog(res.uci_log);
        if (res && res.success === false && res.error) {
          setSparSessionError(res.error);
        }
      })
      .catch(() => {});
  }, [selectedEngine, enginesData, isEnginesPlaceholder]);

  useEffect(() => {
    if (kibitzerEngine) {
      initEngineHandshake({ engine_id: kibitzerEngine, subsystem: "kibitzer", threads: kibitzerThreads, hash_mb: kibitzerHashMb })
        .then((res) => {
          if (res?.uci_log) appendKibitzerUciLog(res.uci_log);
        })
        .catch(() => {});
    }
  }, [kibitzerEngine]);

  useEffect(() => {
    if (tutorEngine) {
      initEngineHandshake({ engine_id: tutorEngine, subsystem: "tutor" })
        .then((res) => {
          if (res?.uci_log) appendTutorUciLog(res.uci_log);
        })
        .catch(() => {});
    }
  }, [tutorEngine]);

  // Query Opening Books List
  const { data: booksData } = useQuery({
    queryKey: ["opening_books"],
    queryFn: fetchOpeningBooksList,
  });

  // Live Position Book Probe for Sparring HUD
  const { data: bookProbeData } = useQuery({
    queryKey: ["sparringBookProbe", fen, selectedBook],
    queryFn: () => probeOpeningBook(fen, selectedBook),
    enabled: !!selectedBook && selectedBook !== "none",
  });

  // DSD-51: Database list for Save Copy... popover
  const { data: dbList } = useQuery({
    queryKey: ["databases"],
    queryFn: fetchDatabases,
  });

  // DSD-46: SQLite Candidate Book Query — fires on every FEN change when panel is open
  const { data: candidateBookData } = useQuery<BookCandidate[]>({
    queryKey: ["candidateBook", fen, candidateBookDb],
    queryFn: () => fetchBookCandidates(fen, candidateBookDb),
    enabled: isCandidateBookOpen && !!candidateBookDb,
    placeholderData: [],
  });

  const engines = enginesData || DEFAULT_ENGINES;
  const currentEngineObj = engines.find((e) => e.id === selectedEngine) || engines[0] || DEFAULT_ENGINES[0];
  const kibitzerEngineObj = engines.find((e) => e.id === kibitzerEngine) || engines[1] || DEFAULT_ENGINES[1];
  const tutorEngineObj = engines.find((e) => e.id === tutorEngine) || engines[0] || DEFAULT_ENGINES[0];

  const isCheckmate = game.isCheckmate();
  const isDraw = game.isDraw();
  const isStalemate = game.isStalemate();
  const isThreefold = game.isThreefoldRepetition();

  // DSD-50: Drag-resize board splitter handlers
  const handleSplitterMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = currentWidthRef.current;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - dragStartXRef.current;
      const newWidth = Math.min(850, Math.max(400, dragStartWidthRef.current + deltaX));
      currentWidthRef.current = newWidth;
      setBoardContainerWidth(newWidth);
    };

    const onMouseUp = () => {
      setIsDragging(false);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      localStorage.setItem("deepscout_spar_board_width", String(currentWidthRef.current));
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, []);

  const getWinnerDescription = () => {
    if (isCheckmate) {
      const winnerColor = game.turn() === "w" ? "Black" : "White";
      const isPlayerWinner =
        (winnerColor === "White" && playerSide === "white") ||
        (winnerColor === "Black" && playerSide === "black");
      return {
        title: "CHECKMATE!",
        subtitle: isPlayerWinner
          ? "Victory! You defeated " + currentEngineObj.name + " by checkmate!"
          : currentEngineObj.name + " won by checkmate.",
        isWin: isPlayerWinner,
      };
    }
    if (isStalemate) return { title: "DRAW (Stalemate)", subtitle: "The game ended in a stalemate.", isWin: false };
    if (isThreefold) return { title: "DRAW (3-Fold Repetition)", subtitle: "Position repeated 3 times.", isWin: false };
    if (isDraw) return { title: "DRAW", subtitle: "Game drawn by chess rules.", isWin: false };
    return null;
  };

  const classifyOpeningEco = (history: string[], bookName?: string): { eco: string; name: string } => {
    const line = history.slice(0, 6).join(" ").toLowerCase();
    if (line.startsWith("e4 c5") || line.startsWith("1. e4 c5")) return { eco: "B20", name: "Sicilian Defense" };
    if (line.startsWith("e4 e5") || line.startsWith("1. e4 e5")) {
      if (line.includes("bb5") || line.includes("Bb5")) return { eco: "C60", name: "Ruy Lopez" };
      if (line.includes("bc4") || line.includes("Bc4")) return { eco: "C50", name: "Italian Game" };
      return { eco: "C20", name: "Open Game" };
    }
    if (line.startsWith("e4 e6") || line.startsWith("1. e4 e6")) return { eco: "C00", name: "French Defense" };
    if (line.startsWith("e4 c6") || line.startsWith("1. e4 c6")) return { eco: "B10", name: "Caro-Kann Defense" };
    if (line.startsWith("d4 d5") || line.startsWith("1. d4 d5")) {
      if (line.includes("c4")) return { eco: "D06", name: "Queen's Gambit" };
      return { eco: "D00", name: "Queen's Pawn Game" };
    }
    if (line.startsWith("d4 nf6") || line.startsWith("1. d4 Nf6")) {
      if (line.includes("g6")) return { eco: "E60", name: "King's Indian Defense" };
      return { eco: "A45", name: "Indian Defense" };
    }
    if (line.startsWith("c4") || line.startsWith("1. c4")) return { eco: "A10", name: "English Opening" };
    if (line.startsWith("nf3") || line.startsWith("1. Nf3")) return { eco: "A04", name: "Reti Opening" };
    const fallbackBook = bookName && bookName !== "none" ? bookName.replace(/\.(bin|ctg)$/i, "") : "Standard Chess";
    return { eco: "A00", name: fallbackBook };
  };

  const gameOverInfo = getWinnerDescription();

  const generatePgn = (overrideResult?: string, overrideBoard?: Chess) => {
    const activeBoard = overrideBoard || game;
    const activeHist = activeBoard.history();
    const dateStr = new Date().toISOString().split("T")[0].replace(/-/g, ".");
    const resultStr =
      overrideResult ||
      (activeBoard.isCheckmate()
        ? activeBoard.turn() === "w"
          ? "0-1"
          : "1-0"
        : activeBoard.isDraw()
        ? "1/2-1/2"
        : "*");
    const whiteName = playerSide === "white" ? "Player (Human)" : currentEngineObj.name;
    const blackName = playerSide === "black" ? "Player (Human)" : currentEngineObj.name;
    // Engine Elo: configured limit when the engine supports Elo limiting, else its native strength.
    // The human's rating is unknown here, so no tag is emitted for them (rather than a made-up number).
    const nativeElo = parseInt(String(currentEngineObj.elo), 10);
    const engineElo: number | null = currentEngineObj.supports_elo
      ? targetElo
      : Number.isFinite(nativeElo) ? nativeElo : null;
    const whiteElo: number | null = playerSide === "white" ? null : engineElo;
    const blackElo: number | null = playerSide === "black" ? null : engineElo;

    const openingInfo = classifyOpeningEco(moveHistory, selectedBook);

    // Compute match stats
    const userMoves = moveRecords.filter((r) => r.source === "user" && typeof r.cpLoss === "number");
    const userAcpl = userMoves.length > 0
      ? Math.round(userMoves.reduce((acc, m) => acc + (m.cpLoss || 0), 0) / userMoves.length)
      : 0;
    const engineMoves = moveRecords.filter((r) => r.source === "engine" && typeof r.cpLoss === "number");
    const engineAcpl = engineMoves.length > 0
      ? Math.round(engineMoves.reduce((acc, m) => acc + (m.cpLoss || 0), 0) / engineMoves.length)
      : 0;
    const userAccuracy = Math.max(40, Math.min(100, Math.round(100 - userAcpl * 0.35)));
    const engineAccuracy = Math.max(70, Math.min(100, Math.round(100 - engineAcpl * 0.25)));

    const blunderCount = moveRecords.filter((r) => r.tag === "blunder").length;
    const mistakeCount = moveRecords.filter((r) => r.tag === "mistake").length;
    const inaccuracyCount = moveRecords.filter((r) => r.tag === "inaccuracy").length;
    const bestCount = moveRecords.filter((r) => r.tag === "best" || r.tag === "brilliant").length;

    let movesBody = "";
    if (moveRecords.length > 0 && activeHist.length <= moveRecords.length) {
      const parts: string[] = [];
      for (let i = 0; i < moveRecords.length; i++) {
        const rec = moveRecords[i];
        const moveNum = Math.floor(i / 2) + 1;
        if (i % 2 === 0) {
          parts.push(moveNum + ".");
        }
        parts.push(rec.san);

        const annotations: string[] = [];
        if (rec.eval) annotations.push("[%eval " + rec.eval + "]");
        if (rec.depth) annotations.push("[%depth " + rec.depth + "]");
        if (rec.nps) annotations.push("[%nps " + rec.nps + "]");
        if (rec.source === "book") annotations.push("[book: " + (rec.book_name || selectedBook) + "]");

        if (annotations.length > 0) {
          parts.push("{ " + annotations.join(" ") + " }");
        }
      }
      movesBody = parts.join(" ");
    } else {
      const parts: string[] = [];
      for (let i = 0; i < activeHist.length; i++) {
        if (i % 2 === 0) parts.push(Math.floor(i / 2) + 1 + ".");
        parts.push(activeHist[i]);
        const rec = moveRecords[i];
        if (rec && rec.san === activeHist[i]) {
          const annotations: string[] = [];
          if (rec.eval) annotations.push("[%eval " + rec.eval + "]");
          if (rec.depth) annotations.push("[%depth " + rec.depth + "]");
          if (rec.nps) annotations.push("[%nps " + rec.nps + "]");
          if (rec.source === "book") annotations.push("[book: " + (rec.book_name || selectedBook) + "]");
          if (annotations.length > 0) {
            parts.push("{ " + annotations.join(" ") + " }");
          }
        }
      }
      movesBody = parts.join(" ");
    }

    const hasGenuineEval =
      moveRecords.some((r) => Boolean(r.eval && r.source !== "book")) &&
      (userAcpl > 0 || engineAcpl > 0);
    const summaryComment = hasGenuineEval
      ? ` { [%acpl global="${((userAcpl + engineAcpl) / 2).toFixed(1)}" user="${userAcpl}" engine="${engineAcpl}"] [%caps user_accuracy="${userAccuracy}%" engine_accuracy="${engineAccuracy}%"] [%stats best="${bestCount}" inaccuracy="${inaccuracyCount}" mistake="${mistakeCount}" blunder="${blunderCount}"] [%provenance engine="${currentEngineObj.name}" elo="${engineElo ?? ""}" date="${new Date().toISOString()}"] [%sparring mode="UCI Sparring Arena" tutor_mode="${tutorInterruptMode}"] }`
      : "";

    const headerLines = [
      '[Event "DeepScout Engine Sparring"]',
      '[Site "DeepScout Arena"]',
      '[Date "' + dateStr + '"]',
      '[Round "-"]',
      '[White "' + whiteName + '"]',
      '[Black "' + blackName + '"]',
      '[Result "' + resultStr + '"]',
      ...(whiteElo !== null ? ['[WhiteElo "' + whiteElo + '"]'] : []),
      ...(blackElo !== null ? ['[BlackElo "' + blackElo + '"]'] : []),
      '[ECO "' + openingInfo.eco + '"]',
      '[Opening "' + openingInfo.name + '"]',
      '[GameId "' + (currentGameIdRef.current || currentGameId || "sparring-session") + '"]',
      "",
      (movesBody ? movesBody + summaryComment + " " : "") + resultStr,
    ];

    return headerLines.join("\n");
  };

  // Autosave to Sparring_Games.sqlite via atomic telemetry-flush UPSERT (>= 2 plies only)
  const autoSaveGame = async (overrideResult?: string, overrideGame?: Chess) => {
    const activeBoard = overrideGame || game;
    const plyCount = activeBoard.history().length;
    if (plyCount < 2) return;
    try {
      const gid = ensureGameId();
      const trueTerm = getTrueTermination(activeBoard);
      const termType = trueTerm ? trueTerm.type : "EVAL_ADJUDICATED";
      const payload = gatherTelemetryPayload(termType, {
        gameId: gid,
        board: activeBoard,
        overrideResult: overrideResult || trueTerm?.result || undefined,
      });
      const res = await flushGameTelemetry(payload);
      if (!res.discarded) {
        setAutosaveAlert("Autosaved to " + SPARRING_DB_NAME);
        logAction("API", "Autosaved Sparring Game to " + SPARRING_DB_NAME, `Result: ${res.result} (${res.final_eval || ""} via ${res.eval_source})`);
        queryClient.invalidateQueries({ queryKey: ["databases"] });
        queryClient.invalidateQueries({ queryKey: ["browserGames"] });
        setTimeout(() => setAutosaveAlert(null), 4000);
      }
    } catch (err: any) {
      logAction("ERROR", "Sparring autosave failed: " + err.message);
    }
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const pgnText = generatePgn();
      return importPgn(pgnText, SPARRING_DB_NAME);
    },
    onSuccess: (data) => {
      setSaveSuccessMsg("Saved game to " + SPARRING_DB_NAME + " (" + data.imported_count + " record)!");
      logAction("API", "Manually Saved Sparring Game to " + SPARRING_DB_NAME);
      queryClient.invalidateQueries({ queryKey: ["databases"] });
      queryClient.invalidateQueries({ queryKey: ["browserGames"] });
      setTimeout(() => setSaveSuccessMsg(null), 4000);
    },
  });

  const handleDownloadPgn = () => {
    const pgn = generatePgn();
    const blob = new Blob([pgn], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "Sparring_" + currentEngineObj.name + "_" + Date.now() + ".pgn";
    link.click();
    URL.revokeObjectURL(url);
    logAction("CLICK", "Exported Sparring Game PGN");
  };

  // Kibitzer Get Advise Action ("Roads Not Taken")
  const handleGetAdvise = async (
    overrideFen?: string,
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
    setIsKibitzerThinking(true);
    const targetFen = overrideFen || fen;
    const engineToUse = overrides?.engine ?? kibitzerEngine;
    const depthToUse = overrides?.depth ?? kibitzerDepth;
    const multipvToUse = overrides?.multipv ?? kibitzerMultipv;
    const modeToUse = overrides?.searchMode ?? kibitzerSearchMode;
    const timeMsToUse = overrides?.timeLimitMs ?? kibitzerTimeLimitMs;
    const threadsToUse = overrides?.threads ?? kibitzerThreads;
    const hashToUse = overrides?.hashMb ?? kibitzerHashMb;

    // In 'depth' mode, do not send time cap so the engine reaches depth 24 / 33 / 50 plies!
    const effectiveTimeLimitMs = modeToUse === "depth" ? null : timeMsToUse;
    const effectiveDepth = modeToUse === "time" ? undefined : depthToUse;

    try {
      const res = await fetchEngineVariations({
        fen: targetFen,
        engine_id: engineToUse,
        depth: effectiveDepth,
        multipv: multipvToUse,
        time_limit_ms: effectiveTimeLimitMs,
        threads: threadsToUse,
        hash_mb: hashToUse,
      });
      if (res && res.variations) {
        applyKibitzerVariations(res.variations, targetFen);
        appendKibitzerUciLog(res.uci_log);
        logAction("API", "Fetched " + res.variations.length + " variations via " + engineToUse + " (Depth: " + (effectiveDepth || depthToUse) + ")");

        if (kibitzerAutoSave && res.variations.length > 0 && currentGameId?.trim()) {
          res.variations.forEach((v) => {
            logKibitzerVariation({
              game_id: currentGameId || "sparring-session-standalone",
              ply: moveRecords.length,
              fen: targetFen,
              engine: engineToUse,
              pgn_fragment: v.pv_san,
              eval_data: { score_cp: v.score_cp, win_prob: v.win_prob, depth: v.depth, tags: v.tags },
              trigger_source: "get_advise",
              logged_by: "auto_verbose",
              was_played: false,
            }).catch(() => {});
          });
        }
      }
    } catch (err: any) {
      logAction("ERROR", "Kibitzer advice failed: " + err.message);
    } finally {
      setIsKibitzerThinking(false);
    }
  };

  // Kibitzer Save Variation to Kibitzer_Analysis.sqlite
  const handleSaveKibitzerVariation = async (variation: VariationLine) => {
    try {
      if (!currentGameId?.trim()) return; // drop write: no verified session
      await logKibitzerVariation({
        game_id: currentGameId,
        ply: moveRecords.length,
        fen: fen,
        engine: kibitzerEngineObj.name,
        pgn_fragment: variation.pv_san,
        eval_data: {
          score_cp: variation.score_cp,
          win_prob: variation.win_prob,
          depth: variation.depth,
          tags: variation.tags,
        },
        trigger_source: "get_advise",
        logged_by: "user_save",
        was_played: false,
      });
      setSaveSuccessMsg("Saved variation " + variation.pv_san + " to " + KIBITZER_DB_NAME + "!");
      logAction("API", "Saved variation " + variation.pv_san + " to " + KIBITZER_DB_NAME);
      queryClient.invalidateQueries({ queryKey: ["databases"] });
      setTimeout(() => setSaveSuccessMsg(null), 3500);
    } catch (err: any) {
      logAction("ERROR", "Failed to save Kibitzer variation: " + err.message);
    }
  };

  // ── Tutor evaluation helpers ───────────────────────────────────────────────
  // Evaluates a played move against the engine's best line from the position it was played in.
  // All numbers are from the MOVER's point of view and mate scores are normalised, so a slower mate
  // (mate-in-5 instead of mate-in-3) is never reported as a ~9700cp "blunder".
  const evaluateMoveForTutor = async (opts: {
    prevFen: string;
    newFen: string;
    moveUci: string;
    moveSan: string;
    gameOverAfter: "checkmate" | "draw" | null;
  }): Promise<TutorMoveEval | null> => {
    const moverIsWhite = opts.prevFen.split(" ")[1] === "w";
    const res = await fetchEngineVariations({
      fen: opts.prevFen,
      engine_id: tutorEngine,
      depth: 14,
      multipv: 3,
      time_limit_ms: 350,
    });
    if (res?.uci_log) appendTutorUciLog(res.uci_log);
    if (!res?.variations || res.variations.length === 0) return null;

    const variations = res.variations;
    const bestVar = variations[0];
    // NOTE: pv_san is a whole line ("Nf3 d5 d4 ..."); pv_uci is only the first move.
    const sameMove = (v: VariationLine) =>
      (!!v.pv_uci && !!opts.moveUci && v.pv_uci.startsWith(opts.moveUci)) ||
      firstMoveToken(v.pv_san) === opts.moveSan;
    const isPlayedBest = sameMove(bestVar);
    const bestCp = bestVar.score_cp ?? 0;
    const bestIsMate = !!bestVar.is_mate;
    const bestMateIn = bestVar.mate_in ?? null;
    const matchingVar = variations.find(sameMove);

    let afterCp = bestCp;
    let afterIsMate = bestIsMate;
    let afterMateIn: number | null = bestMateIn;

    if (!isPlayedBest) {
      if (matchingVar) {
        afterCp = matchingVar.score_cp ?? 0;
        afterIsMate = !!matchingVar.is_mate;
        afterMateIn = matchingVar.mate_in ?? null;
      } else if (opts.gameOverAfter) {
        // The move ended the game: mate is the best possible result, stalemate/draw is 0.
        afterCp = opts.gameOverAfter === "checkmate" ? 10000 : 0;
        afterIsMate = false;
        afterMateIn = null;
      } else {
        try {
          const evalRes = await fetchEngineEvaluate({
            fen: opts.newFen,
            engine_id: tutorEngine,
            depth: 12,
            time_limit_ms: 250,
            subsystem: "tutor",
          });
          if (evalRes?.uci_log) appendTutorUciLog(evalRes.uci_log);
          if (typeof evalRes.stm_cp === "number") {
            // Side to move after the move is the opponent: flip into the mover's point of view.
            afterCp = -evalRes.stm_cp;
            afterIsMate = !!evalRes.is_mate;
            afterMateIn = typeof evalRes.mate_in === "number" ? -evalRes.mate_in : null;
          } else if (typeof evalRes.eval_score === "string" && evalRes.eval_score.startsWith("#")) {
            // Older sidecar: only a White-POV mate string is available.
            const m = parseInt(evalRes.eval_score.slice(1), 10);
            const whiteMates = m > 0;
            const moverMates = whiteMates === moverIsWhite;
            afterIsMate = true;
            afterMateIn = Number.isNaN(m) ? null : moverMates ? Math.abs(m) : -Math.abs(m);
            afterCp = afterMateIn === null ? 0 : mateToCp(afterMateIn);
          } else {
            // Older sidecar: eval_cp is White-POV.
            afterCp = moverIsWhite ? evalRes.eval_cp || 0 : -(evalRes.eval_cp || 0);
            afterIsMate = false;
            afterMateIn = null;
          }
        } catch {
          afterCp = bestCp - 100;
          afterIsMate = false;
          afterMateIn = null;
        }
      }
    }

    // Record latest post-move Tutor evaluation in White-POV centipawns for adjudication cascade
    lastTutorCpRef.current = moverIsWhite ? Math.round(afterCp) : Math.round(-afterCp);
    const cpLoss = isPlayedBest ? 0 : Math.max(0, capTutorCp(bestCp) - capTutorCp(afterCp));
    return {
      bestVar,
      isPlayedBest,
      bestCp,
      afterCp,
      cpLoss,
      bestIsMate,
      bestMateIn,
      afterIsMate,
      afterMateIn,
    };
  };

  // Decides whether a move deserves a tutor flag, honouring the user's thresholds and the
  // "don't nag me while I'm winning" setting. Returns the flag type or null.
  const decideTutorFlag = (ev: TutorMoveEval): TutorFlagData["flag_type"] | null => {
    if (ev.isPlayedBest) return null;
    const hadMate = ev.bestIsMate && (ev.bestMateIn ?? 0) > 0;
    const keptMate = ev.afterIsMate && (ev.afterMateIn ?? 0) > 0;
    const winningBefore = hadMate || ev.bestCp >= TUTOR_WIN_CP;
    const stillWinning = keptMate || ev.afterCp >= TUTOR_WIN_CP;

    // Decisively winning before AND after (e.g. mate-in-5 instead of mate-in-3): stay quiet.
    // The tutor only speaks up if the win is actually thrown away (draw / loss / lost mate).
    if (tutorSuppressWhenWinning && winningBefore && stillWinning) return null;

    if (hadMate && !keptMate) return "mate_alert";
    if (ev.cpLoss >= tutorBlunderThresholdCp) return "user_blunder";
    if (ev.cpLoss >= tutorMistakeThresholdCp) {
      return tutorAlertTactics && ev.bestVar.tags.includes("tactical") ? "tactic" : "mistake";
    }
    return null;
  };

  const buildTutorFlag = (
    flagType: TutorFlagData["flag_type"],
    ev: TutorMoveEval,
    prevFen: string,
    playedSan: string,
    ply: number
  ): TutorFlagData => ({
    flag_type: flagType,
    loss_cp: ev.cpLoss,
    best_move_san: firstMoveToken(ev.bestVar.pv_san),
    best_line_san: ev.bestVar.pv_san,
    best_move_uci: firstMoveToken(ev.bestVar.pv_uci),
    eval_score: "" + ((ev.bestVar.score_cp || 0) / 100.0).toFixed(2),
    mate_in: ev.bestIsMate && (ev.bestMateIn ?? 0) > 0 ? ev.bestMateIn : null,
    tags: ev.bestVar.tags,
    fen_before: prevFen,
    played_san: playedSan,
    ply,
  });

  const logTutorFlagRecord = (
    flag: TutorFlagData,
    outcome: "accepted_suggestion" | "played_own_move" | "ignored_flag",
    trigger: "flag_triggered" | "continuous",
    postMoveFen: string
  ) =>
    logTutorFlag({
      game_id: currentGameId,
      ply: flag.ply || moveRecords.length,
      // `fen` keeps its historical meaning (position after the flagged move); the position the
      // suggestion applies to is stored in centipawn_data.fen_before.
      fen: postMoveFen,
      flag_type: flag.flag_type,
      engine: tutorEngineObj.name,
      centipawn_data: {
        loss_cp: flag.loss_cp,
        eval: flag.eval_score,
        played_san: flag.played_san,
        fen_before: flag.fen_before,
        mate_in: flag.mate_in ?? null,
      },
      suggested_variations: [
        { san: flag.best_move_san, uci: flag.best_move_uci, line: flag.best_line_san, tags: flag.tags },
      ],
      tutor_outcome: outcome,
      trigger_source: trigger,
    });

  // Tutor Response Handler
  const handleTutorOutcome = async (
    outcome: "accepted_suggestion" | "played_own_move" | "ignored_flag" | "takeback",
    suggestedSan?: string
  ) => {
    if (!activeTutorFlag) return;
    const flagCopy = { ...activeTutorFlag };

    // 1-based ply of the flagged (blunder) move. Everything before it is the line we rewind to.
    const flagPly =
      flagCopy.ply && flagCopy.ply > 0 ? Math.min(flagCopy.ply, moveHistory.length) : moveHistory.length;
    const historyBeforeFlag = moveHistory.slice(0, Math.max(0, flagPly - 1));

    let postMoveFen = fen;
    try {
      const g = new Chess();
      for (const h of moveHistory.slice(0, flagPly)) g.move(h);
      postMoveFen = g.fen();
    } catch {
      /* keep current fen */
    }

    const logOutcome = (o: "accepted_suggestion" | "played_own_move" | "ignored_flag") => {
      if (!currentGameId?.trim()) return; // no verified session — skip DB write
      logTutorFlagRecord(flagCopy, o, "flag_triggered", postMoveFen)
        .then(() => {
          logAction("API", "Tutor flag resolved with outcome: " + o);
          queryClient.invalidateQueries({ queryKey: ["databases"] });
        })
        .catch((err: any) => console.warn("Failed to log tutor flag outcome", err));
    };

    if (outcome === "accepted_suggestion") {
      // best_move_san/uci may be a full PV on older flags: only ever use the FIRST move.
      const uci = firstMoveToken(flagCopy.best_move_uci);
      const san = firstMoveToken(suggestedSan || flagCopy.best_move_san);
      const correctedGame = new Chess();
      let acceptedMove: ReturnType<Chess["move"]> | null = null;
      try {
        // Take back the blunder: rebuild the game up to (not including) the flagged ply
        for (const h of historyBeforeFlag) correctedGame.move(h);
        if (uci.length >= 4) {
          try {
            acceptedMove = correctedGame.move({
              from: uci.slice(0, 2),
              to: uci.slice(2, 4),
              promotion: uci.slice(4, 5) || undefined,
            });
          } catch {
            acceptedMove = null;
          }
        }
        if (!acceptedMove && san) {
          try {
            acceptedMove = correctedGame.move(san);
          } catch {
            acceptedMove = null;
          }
        }
      } catch (err: any) {
        console.error("Failed executing accepted tutor move", err);
      }

      if (!acceptedMove) {
        // Never fail silently: keep the popup open and tell the user.
        logAction("ERROR", "Tutor accept failed: could not play " + (san || uci || "(no move)"));
        setSparSessionError("The tutor's suggested move could not be applied (" + (san || uci || "no move") + ").");
        setTimeout(() => setSparSessionError(null), 5000);
        return;
      }

      const newFen = correctedGame.fen();
      const nextMoves = correctedGame.history();
      const currentPly = nextMoves.length;
      const moveNum = Math.floor((currentPly - 1) / 2) + 1;
      const turnName: "white" | "black" = currentPly % 2 === 1 ? "white" : "black";

      setGame(correctedGame);
      setFen(newFen);
      setMoveHistory(nextMoves);

      const correctedRec: SparMoveRecord = {
        ply: currentPly,
        moveNumber: moveNum,
        turn: turnName,
        san: acceptedMove.san,
        uci: acceptedMove.from + acceptedMove.to + (acceptedMove.promotion || ""),
        source: "user",
        cpLoss: 0,
        tag: "best",
        badge: "✨",
        badgeLabel: "Tutor Accepted",
        eval: flagCopy.eval_score,
      };

      setMoveRecords((prev) => [...prev.filter((r) => r.ply < currentPly), correctedRec]);
      setStagedVariation(null);
      clearKibitzerVariations();
      setActiveTutorFlag(null);
      logAction("BOARD", `Tutor accepted: ${acceptedMove.san} replaces ${flagCopy.played_san || "blunder"} (Ply ${currentPly})`);
      logOutcome("accepted_suggestion");

      if (correctedGame.isGameOver()) {
        autoSaveGame();
      } else {
        setTimeout(() => triggerEngineMove(newFen, correctedGame), 250);
      }
      return;
    }

    if (outcome === "takeback") {
      // Takeback: rewind the blunder so the user can play another move manually
      logOutcome("ignored_flag");
      try {
        const rewindGame = new Chess();
        for (const h of historyBeforeFlag) rewindGame.move(h);
        setGame(rewindGame);
        setFen(rewindGame.fen());
        setMoveHistory(historyBeforeFlag);
        setMoveRecords((prev) => prev.filter((r) => r.ply < flagPly));
        setStagedVariation(null);
        clearKibitzerVariations();
        setActiveTutorFlag(null);
        return;
      } catch (err: any) {
        console.error("Failed executing takeback", err);
      }
    } else if (outcome === "played_own_move" || outcome === "ignored_flag") {
      // Keep played move and let opponent engine respond!
      logOutcome(outcome);
      setActiveTutorFlag(null);
      if (!game.isGameOver()) {
        setTimeout(() => triggerEngineMove(fen, game), 150);
      }
      return;
    }

    setActiveTutorFlag(null);
  };

  // Trigger Opponent Engine Move using UCI
  const triggerEngineMove = async (currentFen: string, activeGameInstance?: Chess) => {
    const currentG = activeGameInstance || game;
    if (currentG.isGameOver()) return;
    setIsEngineThinking(true);
    try {
      if (kibitzerMode === "opponent_clock_bound") {
        fetchEngineVariations({
          fen: currentFen,
          engine_id: kibitzerEngine,
          depth: kibitzerDepth,
          multipv: kibitzerMultipv,
          time_limit_ms: kibitzerTimeLimitMs,
          threads: kibitzerThreads,
          hash_mb: kibitzerHashMb,
        }).then((res) => {
          if (res?.variations) applyKibitzerVariations(res.variations, currentFen);
          if (res?.uci_log) appendKibitzerUciLog(res.uci_log);
        }).catch(() => {});
      }

      const response = await fetchEnginePlay({
        fen: currentFen,
        engine_id: selectedEngine,
        elo: currentEngineObj.supports_elo ? targetElo : undefined,
        time_limit_ms: opponentThinkTimeMs || 450,
        threads: opponentThreads,
        hash_mb: opponentHashMb,
        book_name: selectedBook,
        use_book: Boolean(selectedBook && selectedBook !== "none" && selectedBook !== "engine_native"),
      });

      // Stream live UCI handshake / eval / log lines into the terminal drawer
      appendSparringUciLog(response?.telemetry?.uci_log);
      if (response?.is_fallback) {
        setSparSessionError(
          "Engine warning (" + currentEngineObj.name + "): the engine failed to answer, a fallback move was played. " + (response.error || "")
        );
      }

      if (response && (response.best_move_san || response.best_move_uci)) {
        // Reconstruct game from moveHistory to ensure continuous full history
        const nextG = new Chess();
        for (const h of currentG.history()) {
          nextG.move(h);
        }

        let moveResult = null;
        if (response.best_move_san) {
          try {
            moveResult = nextG.move(response.best_move_san);
          } catch {}
        }
        if (!moveResult && response.best_move_uci && response.best_move_uci.length >= 4) {
          try {
            moveResult = nextG.move({
              from: response.best_move_uci.slice(0, 2),
              to: response.best_move_uci.slice(2, 4),
              promotion: response.best_move_uci.slice(4, 5) || "q",
            });
          } catch {}
        }

        if (moveResult) {
          const newFen = nextG.fen();
          const nextMoves = nextG.history();
          const currentPly = nextMoves.length;
          const moveNum = Math.floor((currentPly - 1) / 2) + 1;
          const turnName: "white" | "black" = currentPly % 2 === 1 ? "white" : "black";

          setGame(nextG);
          setFen(newFen);
          setMoveHistory(nextMoves);
          if (response.eval_score) setEvalScore(response.eval_score);
          if (!response.is_book_move && typeof response.eval_cp === "number") {
            // play_move returns eval_cp in White-POV centipawns
            lastSparringCpRef.current = Math.round(response.eval_cp);
          }

          const qual = response.is_book_move
            ? { tag: "book", badge: "📖", label: "Book" }
            : { tag: "best", badge: "✨", label: "Engine" };

          const engineRec: SparMoveRecord = {
            ply: currentPly,
            moveNumber: moveNum,
            turn: turnName,
            san: moveResult.san,
            uci: moveResult.from + moveResult.to + (moveResult.promotion || ""),
            eval: response.eval_score,
            evalCp: response.eval_cp,
            cpLoss: response.is_book_move ? 0 : 5,
            tag: qual.tag as any,
            badge: qual.badge,
            badgeLabel: qual.label,
            depth: response.depth,
            nps: response.telemetry?.nps,
            time_ms: response.telemetry?.time_ms,
            source: response.is_book_move ? "book" : "engine",
            book_name: response.book_name,
            weight: response.book_weight,
          };

          setMoveRecords((prev) => [...prev, engineRec]);
          logAction("BOARD", `Engine Move: ${moveResult.san} (Ply ${currentPly})`, `Eval: ${response.eval_score || "+0.00"}`);

          // Optional: also evaluate the engine's own move (setting "Only evaluate player moves" unchecked).
          // Silent: updates the engine's real ACPL and logs engine_blunder flags, never interrupts play.
          if (isTutorEnabled && !tutorPlayerMovesOnly && !response.is_book_move) {
            const engineSan = moveResult.san;
            evaluateMoveForTutor({
              prevFen: currentFen,
              newFen,
              moveUci: engineRec.uci || "",
              moveSan: engineSan,
              gameOverAfter: nextG.isCheckmate() ? "checkmate" : nextG.isGameOver() ? "draw" : null,
            })
              .then((ev) => {
                if (!ev) return;
                const engQual = classifyMoveQuality(ev.cpLoss, false, ev.isPlayedBest ? ev.bestVar.tags : []);
                setMoveRecords((prev) =>
                  prev.map((r) =>
                    r.ply === currentPly && r.source === "engine"
                      ? { ...r, cpLoss: ev.cpLoss, tag: engQual.tag as any, badge: engQual.badge, badgeLabel: engQual.label }
                      : r
                  )
                );
                if (ev.cpLoss >= tutorBlunderThresholdCp && currentGameId?.trim()) {
                  logTutorFlagRecord(
                    buildTutorFlag("engine_blunder", ev, currentFen, engineSan, currentPly),
                    "ignored_flag",
                    "continuous",
                    newFen
                  ).catch(() => {});
                }
              })
              .catch(() => {});
          }

          if (nextG.isGameOver()) {
            autoSaveGame(undefined, nextG);
          } else if (kibitzerMode === "user_clock_bound" || kibitzerMode === "continuous") {
            const effectiveTimeLimitMs = kibitzerSearchMode === "depth" ? null : kibitzerTimeLimitMs;
            const effectiveDepth = kibitzerSearchMode === "time" ? undefined : kibitzerDepth;
            fetchEngineVariations({
              fen: newFen,
              engine_id: kibitzerEngine,
              depth: effectiveDepth,
              multipv: kibitzerMultipv,
              time_limit_ms: effectiveTimeLimitMs,
              threads: kibitzerThreads,
              hash_mb: kibitzerHashMb,
            }).then((res) => {
              if (res?.variations) applyKibitzerVariations(res.variations, newFen);
              if (res?.uci_log) appendKibitzerUciLog(res.uci_log);
            }).catch(() => {});
          }
        }
      }
    } catch (err: any) {
      logAction("ERROR", "UCI Engine move failed: " + err.message);
    } finally {
      setIsEngineThinking(false);
    }
  };

  const handleStartGame = async () => {
    // ── Stage 1: Reset all transient UI state before async work ──────────────
    const newG = new Chess();
    setGame(newG);
    setFen(newG.fen());
    setMoveHistory([]);
    setMoveRecords([]);
    setEvalScore("+0.00");
    setSaveSuccessMsg(null);
    setAutosaveAlert(null);
    setActiveTutorFlag(null);
    setSparSessionError(null);
    // NOTE: setIsGameActive(true) is intentionally deferred to Stage 3
    //       so the board is NOT interactive until game_id is verified.

    // ── Stage 2: Pre-flight UUID verification gate ────────────────────────────
    let verifiedGameId: string;
    try {
      const session = await createSparringGame({
        opponent_engine: currentEngineObj.name,
        user_time_control: "unlimited",
        tutor_interrupt_mode: tutorInterruptMode,
      });

      const rawId = session?.game?.game_id;
      if (!rawId || typeof rawId !== "string" || !rawId.trim()) {
        // game_id absent, null, or blank — abort cleanly
        setSparSessionError("Could not initialize sparring session: invalid game ID returned from server.");
        logAction("ERROR", "handleStartGame aborted — createSparringGame returned no valid game_id");
        return; // ← early return; triggerEngineMove never fires
      }

      verifiedGameId = rawId.trim();
    } catch (e: any) {
      // createSparringGame rejected — surface error and abort
      setSparSessionError("Failed to create sparring session: " + (e?.message ?? String(e)));
      logAction("ERROR", "handleStartGame aborted — createSparringGame threw: " + (e?.message ?? String(e)));
      return; // ← early return; triggerEngineMove never fires
    }

    // ── Stage 3: Commit state only after UUID is verified ────────────────────
    setCurrentGameId(verifiedGameId);
    const effectiveSide: "white" | "black" =
      playerSideChoice === "random" ? (Math.random() < 0.5 ? "white" : "black") : playerSideChoice;
    setPlayerSide(effectiveSide);
    setBoardOrientation(effectiveSide);
    setIsGameActive(true); // board becomes interactive now

    logAction(
      "CLICK",
      "Started UCI Sparring Match vs " + currentEngineObj.name,
      "Side: " + effectiveSide + ", Elo: " + targetElo + ", Engine: " + selectedEngine + ", Book: " + selectedBook
    );

    // ── Stage 4: Engine / Kibitzer calls — guarded by verified game_id ───────
    initEngineHandshake({
      engine_id: selectedEngine,
      subsystem: "sparring",
      elo: currentEngineObj.supports_elo ? targetElo : undefined,
      threads: opponentThreads,
      hash_mb: opponentHashMb,
      book_name: selectedBook,
      use_book: Boolean(selectedBook && selectedBook !== "none" && selectedBook !== "engine_native"),
      custom_options: currentEngineObj.options,
    })
      .then((res) => {
        if (res?.uci_log) appendSparringUciLog(res.uci_log);
      })
      .catch(() => {});

    if (effectiveSide === "black") {
      triggerEngineMove(newG.fen(), newG);
    } else if (kibitzerMode === "user_clock_bound" || kibitzerMode === "continuous") {
      const effectiveTimeLimitMs = kibitzerSearchMode === "depth" ? null : kibitzerTimeLimitMs;
      const effectiveDepth = kibitzerSearchMode === "time" ? undefined : kibitzerDepth;
      fetchEngineVariations({
        fen: newG.fen(),
        engine_id: kibitzerEngine,
        depth: effectiveDepth,
        multipv: kibitzerMultipv,
        time_limit_ms: effectiveTimeLimitMs,
        threads: kibitzerThreads,
        hash_mb: kibitzerHashMb,
      }).then((res) => {
        if (res?.variations) applyKibitzerVariations(res.variations, newG.fen());
        if (res?.uci_log) appendKibitzerUciLog(res.uci_log);
      }).catch(() => {});
    }
  };

  // True over-the-board termination (null while the game is still running).
  const getTrueTermination = (targetBoard?: Chess): {
    type: Exclude<TelemetryFlushPayload["termination_type"], "EVAL_ADJUDICATED" | "MANUAL_RESIGN" | "TIME_FORFEIT">;
    result: "1-0" | "0-1" | "1/2-1/2";
  } | null => {
    const b = targetBoard || game;
    if (!b.isGameOver()) return null;
    if (b.isCheckmate()) return { type: "CHECKMATE", result: b.turn() === "w" ? "0-1" : "1-0" };
    if (b.isStalemate()) return { type: "STALEMATE", result: "1/2-1/2" };
    if (b.isInsufficientMaterial()) return { type: "DRAW_INSUFFICIENT", result: "1/2-1/2" };
    if (b.isThreefoldRepetition()) return { type: "DRAW_REPETITION", result: "1/2-1/2" };
    if (b.isDraw()) return { type: "DRAW_FIFTY", result: "1/2-1/2" };
    return { type: "DRAW", result: "1/2-1/2" };
  };
  const isGameFinished = game.isGameOver();

  // ── DSD-51 + Pass 2: Telemetry Harvester (strictly White-POV cp) ────────────
  const gatherTelemetryPayload = (
    terminationType: TelemetryFlushPayload["termination_type"],
    opts?: { gameId?: string; board?: Chess; overrideResult?: string }
  ): TelemetryFlushPayload => {
    const activeBoard = opts?.board || game;
    const gid = opts?.gameId || ensureGameId();
    const userMoves = moveRecords.filter((r) => r.source === "user" && typeof r.cpLoss === "number" && Boolean(r.eval));
    const playerAcpl = userMoves.length > 0
      ? Math.round(userMoves.reduce((acc, m) => acc + (m.cpLoss || 0), 0) / userMoves.length)
      : null;
    const engineMoves = moveRecords.filter((r) => r.source === "engine" && typeof r.cpLoss === "number" && Boolean(r.eval));
    const engineAcpl = engineMoves.length > 0
      ? Math.round(engineMoves.reduce((acc, m) => acc + (m.cpLoss || 0), 0) / engineMoves.length)
      : null;

    // Kibitzer top line eval: score_cp is side-to-move POV; normalize strictly to White-POV
    let kibitzerCp: number | null = lastKibitzerCpRef.current;
    if (kibitzerVariations.length > 0 && typeof kibitzerVariations[0].score_cp === "number") {
      const raw = kibitzerVariations[0].score_cp!;
      const sideToMove = activeBoard.turn(); // "w" | "b"
      kibitzerCp = sideToMove === "w" ? Math.round(raw) : Math.round(-raw);
      lastKibitzerCpRef.current = kibitzerCp;
    }

    // Tutor eval: lastTutorCpRef is already strictly White-POV post-move centipawns
    const tutorCp: number | null = lastTutorCpRef.current;
    const trueTerm = getTrueTermination(activeBoard);
    const rawResult =
      opts?.overrideResult ||
      (terminationType !== "EVAL_ADJUDICATED" && terminationType !== "MANUAL_RESIGN"
        ? trueTerm?.result ?? null
        : null);
    const resolvedGameResult: "1-0" | "0-1" | "1/2-1/2" | null =
      rawResult === "1-0" || rawResult === "0-1" || rawResult === "1/2-1/2" ? rawResult : null;

    // Preserve mate score string when live evalScore shows a forced mate
    const mateOverride =
      typeof evalScore === "string" && (evalScore.startsWith("#") || evalScore.startsWith("-#"))
        ? evalScore
        : null;

    return {
      game_id: gid,
      pgn: generatePgn(resolvedGameResult || undefined, activeBoard),
      player_color: playerSide,
      termination_type: terminationType,
      game_result: resolvedGameResult,
      engine_id: selectedEngine,
      tutor_eval_cp: tutorCp,
      kibitzer_eval_cp: kibitzerCp,
      engine_eval_cp: lastSparringCpRef.current,
      final_eval_override: mateOverride,
      player_acpl: playerAcpl,
      engine_acpl: engineAcpl,
    };
  };

  // ── DSD-51 + Pass 2: Resign & Analyze (autoAnalyze: true) ──────────────────
  const handleResignAndAnalyze = async () => {
    if (moveHistory.length < 2) return;
    const gid = ensureGameId();
    try {
      const trueTerm = getTrueTermination();
      const termType = trueTerm ? trueTerm.type : "MANUAL_RESIGN";
      await flushGameTelemetry(gatherTelemetryPayload(termType, { gameId: gid }));
      queryClient.invalidateQueries({ queryKey: ["databases"] });
      queryClient.invalidateQueries({ queryKey: ["browserGames"] });
      localStorage.setItem("deepscout_last_opened_db", SPARRING_DB_NAME);
      localStorage.setItem("deepscout_last_game_id", gid);
      localStorage.setItem("deepscout_analysis_target_id", gid);
      logAction("CLICK", `Pass 2 ${trueTerm ? "Analyze Game (" + trueTerm.type + ")" : "Resign & Analyze"} — flushed Silver telemetry, launching parallel analysis`);
    } catch (err: any) {
      logAction("ERROR", "Telemetry flush failed (resign & analyze): " + err.message);
    }
    window.dispatchEvent(
      new CustomEvent("deepscout:navigate", {
        detail: { view: "Analysis", db: SPARRING_DB_NAME, targetId: gid, autoAnalyze: true },
      })
    );
  };

  // ── Pass 2: Resign Only (saves at Silver tier, opens Analysis WITHOUT batch eval) ──
  const handleResignOnly = async () => {
    if (moveHistory.length < 2 || isGameFinished) return;
    const gid = ensureGameId();
    try {
      await flushGameTelemetry(gatherTelemetryPayload("MANUAL_RESIGN", { gameId: gid }));
      queryClient.invalidateQueries({ queryKey: ["databases"] });
      queryClient.invalidateQueries({ queryKey: ["browserGames"] });
      localStorage.setItem("deepscout_last_opened_db", SPARRING_DB_NAME);
      localStorage.setItem("deepscout_last_game_id", gid);
      localStorage.setItem("deepscout_analysis_target_id", gid);
      logAction("CLICK", "Pass 2 Resign Only — flushed Silver telemetry, opening Analysis without auto-eval");
    } catch (err: any) {
      logAction("ERROR", "Telemetry flush failed (resign only): " + err.message);
    }
    window.dispatchEvent(
      new CustomEvent("deepscout:navigate", {
        detail: { view: "Analysis", db: SPARRING_DB_NAME, targetId: gid, autoAnalyze: false },
      })
    );
  };

  // ── DSD-51 + Pass 2: New Game (discards < 2 plies; adjudicates >= 2 plies) ─
  const handleNewGame = async () => {
    let adjudicationToast: string | null = null;
    if (isGameActive && moveHistory.length >= 2) {
      try {
        const gid = ensureGameId();
        const trueTerm = getTrueTermination();
        const res = await flushGameTelemetry(
          gatherTelemetryPayload(trueTerm ? trueTerm.type : "EVAL_ADJUDICATED", { gameId: gid })
        );
        if (!res.discarded) {
          const evalDisplay =
            res.final_eval ||
            (res.user_eval >= 0 ? `+${(res.user_eval / 100).toFixed(2)}` : `${(res.user_eval / 100).toFixed(2)}`);
          adjudicationToast = `Match Adjudicated: ${res.result} (${evalDisplay} via ${res.eval_source})`;
          queryClient.invalidateQueries({ queryKey: ["databases"] });
          queryClient.invalidateQueries({ queryKey: ["browserGames"] });
          logAction("CLICK", `Pass 2 New Game — adjudicated: ${res.result} (${evalDisplay}, source: ${res.eval_source})`);
        }
      } catch (err: any) {
        logAction("ERROR", "Telemetry flush failed (new game): " + err.message);
      }
    }
    // Reset board state
    lastTutorCpRef.current = null;
    lastKibitzerCpRef.current = null;
    lastSparringCpRef.current = null;
    const newG = new Chess();
    setGame(newG);
    setFen(newG.fen());
    setMoveHistory([]);
    setMoveRecords([]);
    setIsGameActive(false);
    setIsEngineThinking(false);
    setEvalScore("+0.00");
    setActiveTutorFlag(null);
    setStagedVariation(null);
    currentGameIdRef.current = "";
    setCurrentGameId("");
    if (adjudicationToast) {
      setSaveSuccessMsg(adjudicationToast);
      setTimeout(() => setSaveSuccessMsg(null), 5000);
    } else {
      setSaveSuccessMsg(null);
    }
    logAction("CLICK", "DSD-51 New Game — board reset");
  };

  // ── DSD-51: Save Copy to selected database ──────────────────────────────────
  const handleSaveCopy = async () => {
    if (moveHistory.length === 0) return;
    try {
      const pgnText = generatePgn();
      await importPgn(pgnText, saveCopyTargetDb);
      queryClient.invalidateQueries({ queryKey: ["databases"] });
      queryClient.invalidateQueries({ queryKey: ["browserGames"] });
      setSaveCopyToast(`✓ Saved copy to ${saveCopyTargetDb}`);
      setTimeout(() => setSaveCopyToast(null), 3500);
      logAction("API", `DSD-51 Save Copy — wrote PGN to ${saveCopyTargetDb}`);
    } catch (err: any) {
      logAction("ERROR", `DSD-51 Save Copy failed: ${err.message}`);
    }
    setIsSaveCopyOpen(false);
  };

  // DSD-44: Unified Move Override & Staged Repertoire Persistence
  const handleMoveOverride = (
    moveUci: string,
    moveSan: string,
    source: "USER" | "KIBITZER" | "TUTOR" | "BOOK"
  ) => {
    if (isEngineThinking || game.isGameOver() || activeTutorFlag) return;
    const parentFen = game.fen();
    const nextG = new Chess();
    for (const h of moveHistory) nextG.move(h);

    let moveResult = null;
    try {
      if (moveSan) moveResult = nextG.move(firstMoveToken(moveSan));
    } catch {}
    if (!moveResult && moveUci && moveUci.length >= 4) {
      try {
        moveResult = nextG.move({
          from: moveUci.slice(0, 2),
          to: moveUci.slice(2, 4),
          promotion: moveUci.slice(4, 5) || "q",
        });
      } catch {}
    }

    if (!moveResult) {
      console.warn("Could not play override move:", moveSan, moveUci);
      return;
    }

    const newFen = nextG.fen();
    const nextMoves = nextG.history();
    const currentPly = nextMoves.length;
    const moveNum = Math.floor((currentPly - 1) / 2) + 1;
    const turnName: "white" | "black" = currentPly % 2 === 1 ? "white" : "black";

    setGame(nextG);
    setFen(newFen);
    setMoveHistory(nextMoves);
    clearKibitzerVariations();
    if (!isGameActive) {
      ensureGameId();
      setIsGameActive(true);
    }

    // Set staged variation for potential repertoire persistence
    setStagedVariation({
      active: true,
      parentFen,
      moveUci: moveResult.from + moveResult.to + (moveResult.promotion || ""),
      moveSan: moveResult.san,
      source,
    });

    const overrideRec: SparMoveRecord = {
      ply: currentPly,
      moveNumber: moveNum,
      turn: turnName,
      san: moveResult.san,
      uci: moveResult.from + moveResult.to + (moveResult.promotion || ""),
      source: source === "BOOK" ? "book" : source === "USER" ? "user" : "engine",
      cpLoss: 0,
      tag: "best",
      badge: source === "BOOK" ? "📖" : source === "KIBITZER" ? "🧐" : source === "TUTOR" ? "🎓" : "✨",
      badgeLabel: `${source} Override`,
      eval: "+0.00",
    };

    setMoveRecords((prev) => [...prev, overrideRec]);
    logAction("BOARD", `Move Override (${source}): ${moveResult.san} (Ply ${currentPly})`, `Parent FEN: ${parentFen}`);

    if (nextG.isGameOver()) {
      autoSaveGame(undefined, nextG);
      return;
    }

    // If it is now the engine's turn to play, trigger opponent engine response
    const isNextTurnEngine = (nextG.turn() === "w" ? "white" : "black") !== playerSide;
    if (isNextTurnEngine) {
      setTimeout(() => triggerEngineMove(newFen, nextG), 250);
    }
  };

  const handleTakeback = () => {
    if (moveHistory.length === 0 || isEngineThinking) return;
    const priorHistory = moveHistory.slice(0, -1);
    const rewindGame = new Chess();
    for (const h of priorHistory) {
      rewindGame.move(h);
    }
    setGame(rewindGame);
    setFen(rewindGame.fen());
    setMoveHistory(priorHistory);
    setMoveRecords((prev) => prev.slice(0, -1));
    setActiveTutorFlag(null);
    setStagedVariation(null);
    clearKibitzerVariations();
    logAction("CLICK", "Takeback 1 ply", `Now at ply ${priorHistory.length}, Turn: ${rewindGame.turn() === "w" ? "White" : "Black"}`);
  };

  const handleSaveStagedRepertoire = async () => {
    if (!stagedVariation) return;
    const targetDb = candidateBookDb || "User_Repertoire.repertoire.sqlite";
    try {
      await saveRepertoireEdge({
        book_db: targetDb,
        fen: stagedVariation.parentFen,
        move_uci: stagedVariation.moveUci,
        move_san: stagedVariation.moveSan,
        source: stagedVariation.source,
        is_provocation: false,
      });
      setSaveSuccessMsg(`Saved ${stagedVariation.moveSan} to ${targetDb}`);
      setTimeout(() => setSaveSuccessMsg(null), 4000);
      queryClient.invalidateQueries({ queryKey: ["candidateBook"] });
      queryClient.invalidateQueries({ queryKey: ["sparringBookProbe"] });
      logAction("API", `Saved repertoire edge ${stagedVariation.moveSan} to ${targetDb}`);
    } catch (err: any) {
      console.error("Failed to save repertoire edge:", err);
      setSparSessionError("Failed to save repertoire edge: " + (err.message || String(err)));
      setTimeout(() => setSparSessionError(null), 5000);
    } finally {
      setStagedVariation(null);
    }
  };

  const handleFollowBookMove = (candidateMoveSan?: string, candidateMoveUci?: string) => {
    if (isEngineThinking || game.isGameOver()) return;
    const bestCandidate = candidateMoveSan || bookProbeData?.best_move_san;
    if (!bestCandidate && !candidateMoveUci) return;

    handleMoveOverride(candidateMoveUci || "", bestCandidate || "", "BOOK");
  };

  const handlePieceDrop = ({ sourceSquare, targetSquare }: { piece: any; sourceSquare: string; targetSquare: string | null }): boolean => {
    if (!targetSquare || isEngineThinking || activeTutorFlag) return false;
    try {
      const prevFen = game.fen();
      const prevHistory = [...moveHistory];
      const nextGame = new Chess();
      for (const h of prevHistory) {
        nextGame.move(h);
      }
      if (nextGame.isGameOver()) return false;

      const move = nextGame.move({
        from: sourceSquare,
        to: targetSquare,
        promotion: "q",
      });

      if (move === null) return false;

      // DSD-44: Check if user dragged a piece on the engine's turn (e.g. after takeback) -> Override!
      const isEngineTurn = (game.turn() === "w" ? "white" : "black") !== playerSide;
      if (isEngineTurn) {
        handleMoveOverride(move.from + move.to + (move.promotion || ""), move.san, "USER");
        return true;
      }

      const newFen = nextGame.fen();
      const nextMoves = nextGame.history();
      const currentPly = nextMoves.length;
      const moveNum = Math.floor((currentPly - 1) / 2) + 1;
      const turnName: "white" | "black" = currentPly % 2 === 1 ? "white" : "black";

      setGame(nextGame);
      setFen(newFen);
      setMoveHistory(nextMoves);
      if (!isGameActive) {
        ensureGameId();
        setIsGameActive(true);
      }

      const userRec: SparMoveRecord = {
        ply: currentPly,
        moveNumber: moveNum,
        turn: turnName,
        san: move.san,
        uci: move.from + move.to + (move.promotion || ""),
        source: "user",
        cpLoss: 0,
        tag: "good",
        badge: "✓",
        badgeLabel: "Played",
      };

      // Check if move is in active opening book theory
      let isBookMove = false;
      let bookWeight = 0;
      if (bookProbeData && bookProbeData.in_book && bookProbeData.candidates) {
        const cand = bookProbeData.candidates.find(
          (c) => c.san === move.san || (c.uci && userRec.uci && c.uci === userRec.uci)
        );
        if (cand) {
          isBookMove = true;
          bookWeight = cand.weight;
        }
      }

      if (isBookMove) {
        // Book moves strictly receive 0 ACPL loss (100% accuracy)
        const updatedRec: SparMoveRecord = {
          ...userRec,
          source: "book",
          cpLoss: 0,
          tag: "book",
          badge: "📖",
          badgeLabel: "Book",
          eval: "+0.00",
          book_name: selectedBook,
          weight: bookWeight,
        };
        setMoveRecords((prev) => [...prev, updatedRec]);
        logAction("BOARD", `Player Book Move: ${move.san} (Ply ${currentPly})`, `Theory: ${selectedBook} (0 ACPL Loss)`);

        if (nextGame.isGameOver()) {
          autoSaveGame(undefined, nextGame);
        } else {
          triggerEngineMove(newFen, nextGame);
        }
        return true;
      }

      setMoveRecords((prev) => [...prev, userRec]);
      logAction("BOARD", `Player Move: ${move.san} (Ply ${currentPly})`, `FEN: ${newFen}`);

      // Auto-Kibitzer: in Continuous mode, recalculate variations on every ply
      // change (including the user's own move) without requiring "Get Advise".
      if (kibitzerMode === "continuous") {
        const effectiveTimeLimitMs = kibitzerSearchMode === "depth" ? null : kibitzerTimeLimitMs;
        const effectiveDepth = kibitzerSearchMode === "time" ? undefined : kibitzerDepth;
        fetchEngineVariations({
          fen: newFen,
          engine_id: kibitzerEngine,
          depth: effectiveDepth,
          multipv: kibitzerMultipv,
          time_limit_ms: effectiveTimeLimitMs,
          threads: kibitzerThreads,
          hash_mb: kibitzerHashMb,
        }).then((res) => {
          if (res?.variations) applyKibitzerVariations(res.variations, newFen);
          if (res?.uci_log) appendKibitzerUciLog(res.uci_log);
        }).catch(() => {});
      }

      // Continue play once the (optional) tutor evaluation has finished
      const continueAfterMove = () => {
        if (nextGame.isGameOver()) {
          autoSaveGame(undefined, nextGame);
        } else {
          triggerEngineMove(newFen, nextGame);
        }
      };

      // If Tutor is enabled, evaluate the move against the previous position
      if (isTutorEnabled) {
        const gameOverAfter = nextGame.isCheckmate() ? "checkmate" : nextGame.isGameOver() ? "draw" : null;
        evaluateMoveForTutor({
          prevFen,
          newFen,
          moveUci: userRec.uci || "",
          moveSan: move.san,
          gameOverAfter,
        })
          .then((ev) => {
            if (ev) {
              const qual = classifyMoveQuality(ev.cpLoss, false, ev.isPlayedBest ? ev.bestVar.tags : []);
              const updatedRec: SparMoveRecord = {
                ...userRec,
                cpLoss: ev.cpLoss,
                tag: qual.tag as any,
                badge: qual.badge,
                badgeLabel: qual.label,
                eval: "" + ((ev.bestVar.score_cp || 0) / 100.0).toFixed(2),
              };
              setMoveRecords((prev) => prev.map((r) => (r.ply === currentPly ? updatedRec : r)));

              // Flag decision honours the user's thresholds, mate/endgame suppression and tactic rules
              const flagType = decideTutorFlag(ev);
              if (flagType) {
                const flagData = buildTutorFlag(flagType, ev, prevFen, move.san, currentPly);
                if (tutorInterruptMode === "freeze_on_flag") {
                  setActiveTutorFlag(flagData);
                  // Pause play for user feedback - do not trigger opponent engine!
                  return;
                }
                // Passive mode: log silently and keep playing
                if (currentGameId?.trim()) {
                  logTutorFlagRecord(flagData, "ignored_flag", "continuous", newFen).catch(() => {});
                }
              }
            }
            continueAfterMove();
          })
          .catch(() => continueAfterMove());
      } else {
        continueAfterMove();
      }

      return true;
    } catch {
      return false;
    }
  };

  const handleTestEnginePath = async (path: string) => {
    if (!path.trim()) return;
    setUciTestError(null);
    try {
      const testRes = await testUciEngine(path);
      if (testRes && testRes.name) {
        setNewEngineName(testRes.name);
        if (testRes.options) {
          setTestedUciOptions(testRes.options);
          const initialOpts: Record<string, any> = {};
          Object.entries(testRes.options).forEach(([k, v]: [string, any]) => {
            if (v.default !== undefined && v.default !== null) initialOpts[k] = v.default;
          });
          setNewEngineCustomOptions(initialOpts);
        }
      }
    } catch (err: any) {
      setUciTestError(err.message || "Failed to test UCI engine handshake");
      setTestedUciOptions({});
    }
  };

  const handleBrowseEngine = async () => {
    setIsBrowsingEngine(true);
    setUciTestError(null);
    try {
      const res = await browseEngineFile();
      if (res && res.success && res.path) {
        setNewEnginePath(res.path);
        await handleTestEnginePath(res.path);
      }
    } catch (err: any) {
      setUciTestError(err.message || "Failed to browse engine executable");
    } finally {
      setIsBrowsingEngine(false);
    }
  };

  const handleRegisterEngine = async () => {
    if (!newEnginePath.trim() || !newEngineName.trim()) return;
    try {
      const registered = await registerCustomEngine({
        name: newEngineName,
        path: newEnginePath,
        elo: newEngineElo,
        style: newEngineStyle,
        icon: newEngineIcon,
        options: newEngineCustomOptions,
      });
      await queryClient.invalidateQueries({ queryKey: ["engines"] });
      setSelectedEngine(registered.id);
      setIsAddEngineModalOpen(false);
      setNewEnginePath("");
      setNewEngineName("");
      setSaveSuccessMsg("Registered custom engine: " + registered.name + "!");
      logAction("API", "Registered custom UCI engine " + registered.name);
    } catch (err: any) {
      setUciTestError(err.message || "Registration failed");
    }
  };

  const handleDeleteEngine = async (engineId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await removeCustomEngine(engineId);
      await queryClient.invalidateQueries({ queryKey: ["engines"] });
      if (selectedEngine === engineId) setSelectedEngine("stockfish");
      logAction("API", "Removed custom engine " + engineId);
    } catch (err: any) {
      logAction("ERROR", "Failed to remove custom engine: " + err.message);
    }
  };

  const handleFlipOrientation = () => {
    const next = boardOrientation === "white" ? "black" : "white";
    setBoardOrientation(next);
    logAction("BOARD", "Flipped board view to " + next + " perspective");
  };

  const minElo = currentEngineObj.min_elo || 1000;
  const maxElo = currentEngineObj.max_elo || 3500;

  const getTagBadge = (tag: string) => {
    switch (tag) {
      case "best":
        return <span key={tag} className="px-1.5 py-0.5 rounded bg-emerald-500/25 text-emerald-300 font-extrabold text-[10px] border border-emerald-500/50">[✨] Best</span>;
      case "brilliant":
        return <span key={tag} className="px-1.5 py-0.5 rounded bg-amber-500/30 text-amber-200 font-extrabold text-[10px] border border-amber-400/70 flex items-center gap-0.5 shadow-sm"><Flame className="w-2.5 h-2.5" /> [!!] Brilliant</span>;
      case "tactical":
        return <span key={tag} className="px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 font-bold text-[9px] border border-purple-500/30 flex items-center gap-0.5"><Zap className="w-2.5 h-2.5" /> Tactical</span>;
      case "aggressive":
        return <span key={tag} className="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 font-bold text-[9px] border border-rose-500/30">⚔️ Attack</span>;
      case "solid":
        return <span key={tag} className="px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 font-bold text-[9px] border border-blue-500/30 flex items-center gap-0.5"><Shield className="w-2.5 h-2.5" /> Solid</span>;
      case "blunder":
        return <span key={tag} className="px-1.5 py-0.5 rounded bg-red-600/30 text-red-300 font-bold text-[9px] border border-red-500/40">⚠️ Blunder</span>;
      case "mistake":
        return <span key={tag} className="px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-300 font-bold text-[9px] border border-orange-500/30">Mistake</span>;
      case "inaccuracy":
        return <span key={tag} className="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-300 font-bold text-[9px] border border-yellow-500/30">Inaccuracy</span>;
      default:
        return <span key={tag} className="px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-300 text-[9px]">{tag}</span>;
    }
  };

  // Only treat variations as live while the board is on the position they were computed for.
  const liveKibitzerVariations =
    kibitzerVariations.length > 0 && !!kibitzerVariationsFen && positionKey(kibitzerVariationsFen) === positionKey(fen)
      ? kibitzerVariations
      : [];

  // Filter variations based on kibitzerTagFilter.
  // If the filter matches nothing (e.g. no sacrifices => no "brilliant" lines) fall back to
  // showing all lines and surface a banner, so the panel is never silently blank.
  const tagMatchedVariations = liveKibitzerVariations.filter((v) => {
    if (kibitzerTagFilter === "all") return true;
    return v.tags.includes(kibitzerTagFilter);
  });
  const kibitzerFilterFellBack =
    kibitzerTagFilter !== "all" && liveKibitzerVariations.length > 0 && tagMatchedVariations.length === 0;
  const filteredVariations = kibitzerFilterFellBack ? liveKibitzerVariations : tagMatchedVariations;

  // Calculate dynamic board square visual highlights and arrows for Tutor / Kibitzer
  const boardCustomSquareStyles: Record<string, React.CSSProperties> = {};
  const boardArrows: Array<{ startSquare: string; endSquare: string; color: string }> = [];

  if (activeTutorFlag && tutorShowArrow && activeTutorFlag.best_move_uci && activeTutorFlag.best_move_uci.length >= 4) {
    const from = activeTutorFlag.best_move_uci.slice(0, 2);
    const to = activeTutorFlag.best_move_uci.slice(2, 4);
    boardCustomSquareStyles[from] = { backgroundColor: "rgba(245, 158, 11, 0.4)", borderRadius: "20%" };
    boardCustomSquareStyles[to] = { backgroundColor: "rgba(245, 158, 11, 0.65)", borderRadius: "20%" };
    boardArrows.push({ startSquare: from, endSquare: to, color: "rgb(245, 158, 11)" });
  } else if (kibitzerShowArrows && filteredVariations.length > 0) {
    const top = filteredVariations[0];
    if (top.pv_uci && top.pv_uci.length >= 4) {
      const from = top.pv_uci.slice(0, 2);
      const to = top.pv_uci.slice(2, 4);
      boardCustomSquareStyles[from] = { backgroundColor: "rgba(6, 182, 212, 0.35)", borderRadius: "20%" };
      boardCustomSquareStyles[to] = { backgroundColor: "rgba(6, 182, 212, 0.6)", borderRadius: "20%" };
      boardArrows.push({ startSquare: from, endSquare: to, color: "rgb(6, 182, 212)" });
    }
  }

  // Get formatted hint text for Tutor based on hint depth
  const getTutorHintText = (flag: typeof activeTutorFlag) => {
    if (!flag) return "";
    if (flag.flag_type === "mate_alert") {
      const base = "Mate in " + (flag.mate_in ?? "?") + " available";
      return tutorHintDepth === "full" ? base + ": " + flag.best_move_san : base;
    }
    if (tutorHintDepth === "piece_only") {
      const firstChar = flag.best_move_san.charAt(0);
      let pieceName = "Pawn";
      if (firstChar === "N") pieceName = "Knight";
      else if (firstChar === "B") pieceName = "Bishop";
      else if (firstChar === "R") pieceName = "Rook";
      else if (firstChar === "Q") pieceName = "Queen";
      else if (firstChar === "K") pieceName = "King";
      return "Hint: Consider moving your " + pieceName;
    }
    if (tutorHintDepth === "strategic") {
      if (flag.tags.includes("tactical")) return "Hint: A decisive tactical combination exists!";
      if (flag.tags.includes("brilliant")) return "Hint: Look for an advantageous piece sacrifice!";
      return "Hint: Improve your defensive king safety & piece coordination.";
    }
    return "Suggested Move: " + flag.best_move_san;
  };

  // Calculate match-wide summary statistics (ACPL & Accuracy)
  const userMoves = moveRecords.filter((r) => r.source === "user" && typeof r.cpLoss === "number");
  const userAcpl = userMoves.length > 0
    ? Math.round(userMoves.reduce((acc, m) => acc + (m.cpLoss || 0), 0) / userMoves.length)
    : 0;
  const engineMoves = moveRecords.filter((r) => r.source === "engine" && typeof r.cpLoss === "number");
  const engineAcpl = engineMoves.length > 0
    ? Math.round(engineMoves.reduce((acc, m) => acc + (m.cpLoss || 0), 0) / engineMoves.length)
    : 0;
  const userAccuracy = Math.max(40, Math.min(100, Math.round(100 - userAcpl * 0.35)));
  const engineAccuracy = Math.max(70, Math.min(100, Math.round(100 - engineAcpl * 0.25)));

  const contextNotesStr = "Sparring vs " + currentEngineObj.name + " (" + (currentEngineObj.supports_elo ? targetElo + " Elo" : currentEngineObj.elo + " Native") + ")";

  return (
    <div className="flex flex-col gap-6 max-w-7xl mx-auto pb-12 select-none animate-in fade-in duration-200 font-sans">
      {/* Header Toolbar */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <div className="text-[11px] font-mono uppercase tracking-widest text-rose-400 font-extrabold mb-1 flex items-center gap-1.5">
            <Swords className="w-4 h-4 text-rose-400" />
            Companion Subsystem — Sparring, Kibitzer &amp; Tutor
          </div>
          <h1 className={"text-3xl font-extrabold tracking-tight " + (isLight ? "text-slate-900" : "text-white") + " flex items-center gap-3"}>
            Spar Against Engine
            <span className={"text-xs font-mono font-bold " + (isLight ? "text-slate-700" : "text-slate-300")}>
              — Multi-Engine Companion Subsystem ({SPARRING_DB_NAME}, {KIBITZER_DB_NAME}, {TUTOR_DB_NAME})
            </span>
          </h1>
        </div>

        {/* Companion Quick Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              setRightPanelTab("kibitzer");
              handleGetAdvise();
            }}
            disabled={isKibitzerThinking}
            className="px-3.5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white text-xs font-extrabold transition-all flex items-center gap-2 cursor-pointer shadow-md shadow-cyan-950/40 border border-cyan-400/40 disabled:opacity-50"
          >
            <Sparkles className={`w-4 h-4 ${isKibitzerThinking ? "animate-spin text-cyan-200" : "text-cyan-300"}`} />
            <span>{isKibitzerThinking ? "Analyzing..." : "💡 Get Advise"}</span>
          </button>

          {/* Master Tutor Power Quick Button */}
          <button
            onClick={() => {
              const nextState = !isTutorEnabled;
              setIsTutorEnabled(nextState);
              if (!nextState) {
                setActiveTutorFlag(null);
              }
              logAction("CLICK", `Toggled Tutor Engine: ${nextState ? "ON" : "OFF"}`);
            }}
            className={"px-3.5 py-2.5 rounded-xl border text-xs font-extrabold transition-all flex items-center gap-2 cursor-pointer shadow-sm " + (isTutorEnabled ? (isLight ? "bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-950 border-emerald-600/40 ring-1 ring-emerald-500/30" : "bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border-emerald-500/40 ring-1 ring-emerald-400/30") : (isLight ? "bg-slate-200 hover:bg-slate-300 text-slate-700 border-slate-300" : "bg-slate-800/80 hover:bg-slate-800 text-slate-400 border-white/10"))}
            title={isTutorEnabled ? "Tutor Active: Click to turn OFF tutor" : "Tutor Disabled: Click to turn ON tutor"}
          >
            <GraduationCap className={"w-4 h-4 " + (isTutorEnabled ? (isLight ? "text-emerald-700" : "text-emerald-400") : "text-slate-500")} />
            <span>{isTutorEnabled ? "🎓 Tutor: ON" : "🎓 Tutor: OFF"}</span>
          </button>

          <button
            onClick={() => setRightPanelTab("sparring")}
            className={"px-3.5 py-2.5 rounded-xl border text-xs font-extrabold transition-all flex items-center gap-2 cursor-pointer shadow-sm " + (isLight ? "bg-rose-500/15 hover:bg-rose-500/25 text-rose-950 border-rose-600/40" : "bg-rose-600/20 hover:bg-rose-600/30 text-rose-300 border border-rose-500/40")}
          >
            <Swords className={"w-4 h-4 " + (isLight ? "text-rose-700" : "text-rose-400")} />
            Arena Setup
          </button>
        </div>
      </div>

      {/* Main Layout: Drag-Resizable Board (left) + Right Companion Hub (right) */}
      <div className="flex items-start gap-0 w-full" style={{ userSelect: isDragging ? "none" : "auto" }}>
        {/* Left Column: Board — width controlled by boardContainerWidth */}
        <div className="flex flex-col items-center gap-3 shrink-0" style={{ width: boardContainerWidth }}>
          {/* Fixed Height Status Header Container (Clean, High-Contrast Status) */}
          <div className="w-full min-h-[46px] flex flex-col justify-center" style={{ maxWidth: boardContainerWidth }}>
            {gameOverInfo ? (
              <div className={"w-full p-3 rounded-2xl border shadow-xl flex items-center justify-between gap-2 " + (gameOverInfo.isWin ? "bg-emerald-950/90 border-emerald-500 text-emerald-100" : "bg-rose-950/90 border-rose-500 text-rose-100")}>
                <div className="flex items-center gap-2 text-xs font-bold">
                  <Trophy className="w-4 h-4 text-amber-400" />
                  <span className="font-extrabold text-sm">{gameOverInfo.title}</span>
                  <span className="text-xs opacity-90">— {gameOverInfo.subtitle}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => saveMutation.mutate()}
                    className="px-3 py-1 bg-white/20 hover:bg-white/30 text-white rounded-lg text-xs font-bold cursor-pointer"
                  >
                    Save
                  </button>
                  <button
                    onClick={handleFlipOrientation}
                    className="p-1.5 rounded-lg bg-white/20 hover:bg-white/30 text-white transition-colors cursor-pointer"
                    title="Flip Board Orientation"
                  >
                    <ArrowUpDown className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : isEngineThinking ? (
              <div className="w-full px-4 py-2.5 rounded-2xl bg-blue-950/80 border border-blue-500/50 text-blue-200 text-xs font-sans font-bold flex items-center justify-between shadow-lg animate-pulse">
                <div className="flex items-center gap-2.5">
                  <Cpu className="w-4 h-4 text-blue-400 animate-spin" />
                  <span className="text-white font-bold">{currentEngineObj.name} is calculating...</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-blue-300 font-mono font-bold bg-blue-900/60 px-2 py-0.5 rounded-lg border border-blue-500/30">
                    {currentEngineObj.supports_elo ? `${targetElo} Elo` : `${currentEngineObj.elo} Native`}
                  </span>
                  <button
                    onClick={handleFlipOrientation}
                    className="p-1.5 rounded-lg bg-blue-900/60 hover:bg-blue-800 border border-blue-500/30 text-blue-200 transition-colors cursor-pointer"
                    title="Flip Board Orientation"
                  >
                    <ArrowUpDown className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ) : (
              <div className={"w-full px-4 py-2 rounded-2xl border text-xs font-mono font-bold flex items-center justify-between shadow-md " + (isLight ? "bg-white border-slate-300 text-slate-900" : "bg-slate-900/90 border-white/15 text-white")}>
                <div className="flex items-center gap-2.5">
                  <Gauge className={"w-4 h-4 " + (isLight ? "text-emerald-600" : "text-emerald-400")} />
                  <span className={isLight ? "text-slate-900 font-extrabold" : "text-white"}>
                    Eval: <strong className={isLight ? "text-emerald-700 font-black" : "text-emerald-400 font-extrabold"}>{evalScore}</strong> (Ply {moveRecords.length})
                  </span>
                  {selectedBook === "engine_native" ? (
                    <span className={"text-[11px] px-2 py-0.5 rounded-md border font-mono font-bold " + (isLight ? "bg-cyan-100 text-cyan-950 border-cyan-300" : "text-cyan-300 bg-cyan-950/60 border-cyan-500/30")}>
                      ⚡ Engine Native
                    </span>
                  ) : selectedBook && selectedBook !== "none" ? (
                    <span className={"text-[11px] px-2 py-0.5 rounded-md border font-mono font-bold " + (isLight ? "bg-purple-100 text-purple-950 border-purple-300" : "text-purple-300 bg-purple-950/60 border-purple-500/30")}>
                      📖 {selectedBook}
                    </span>
                  ) : null}
                </div>
                <div className="flex items-center gap-2">
                  <span className={"text-xs font-black " + (isLight ? "text-cyan-800" : "text-cyan-300")}>
                    {game.turn() === "w" ? "White's Turn" : "Black's Turn"} {playerSide === (game.turn() === "w" ? "white" : "black") ? "(You)" : "(Engine)"}
                  </span>
                  <button
                    onClick={handleFlipOrientation}
                    className={"p-1.5 rounded-lg border transition-colors cursor-pointer " + (isLight ? "bg-slate-100 hover:bg-slate-200 border-slate-300 text-slate-700" : "bg-slate-800 hover:bg-slate-700 border-white/15 text-white")}
                    title="Flip Board Orientation"
                  >
                    <ArrowUpDown className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Stable Chessboard Frame with Dynamic Dimensions & Tutor In-Game Overlay */}
          <div
            className="aspect-square rounded-2xl overflow-hidden shadow-2xl border border-slate-700 relative bg-slate-900 shrink-0"
            style={{ width: boardContainerWidth, height: boardContainerWidth }}
          >
            <Chessboard
              boardWidth={boardContainerWidth}
              options={{
                position: fen,
                boardOrientation,
                onPieceDrop: handlePieceDrop,
                pieces: customChessPieces,
                squareStyles: Object.keys(boardCustomSquareStyles).length > 0 ? boardCustomSquareStyles : undefined,
                arrows: boardArrows.length > 0 ? boardArrows : undefined,
                darkSquareStyle: { backgroundColor: boardTheme?.boardDark || "#4a7c59" },
                lightSquareStyle: { backgroundColor: boardTheme?.boardLight || "#eae5c9" },
              }}
            />

            {/* Quick In-Match Opponent Engine Tuning Modal */}
      {isQuickTuningOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-200">
          <div
            className={`w-full ${
              isQuickUciExpanded ? "max-w-2xl" : "max-w-md"
            } max-h-[88vh] flex flex-col rounded-3xl border shadow-2xl p-6 space-y-4 transition-all duration-200 ${
              isLight ? "bg-white border-slate-300 text-slate-900" : "bg-[#14171c] border-slate-800 text-white"
            }`}
          >
            <div className="flex items-center justify-between border-b pb-3 border-white/10 shrink-0">
              <div className="flex items-center gap-2">
                <Sliders className="w-5 h-5 text-cyan-400" />
                <div>
                  <h3 className="text-sm font-extrabold flex items-center gap-1.5">
                    Quick Tuning: {currentEngineObj.name}
                  </h3>
                  <span className="text-[10px] font-mono text-slate-400">
                    Synced bidirectionally with Engines Lab — changes stick across both tabs
                  </span>
                </div>
              </div>
              <button
                onClick={() => setIsQuickTuningOpen(false)}
                className="p-1 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 overflow-y-auto pr-1 flex-1 min-h-0">
              {/* Thinking Time */}
              <div className={`p-3 rounded-2xl border space-y-1 ${isLight ? "bg-slate-50 border-slate-200" : "bg-black/30 border-white/5"}`}>
                <div className="flex justify-between text-xs font-mono">
                  <span className="font-bold">Thinking Time / Move:</span>
                  <span className="text-cyan-400 font-extrabold">{opponentThinkTimeMs} ms</span>
                </div>
                <input
                  type="range"
                  min="100"
                  max="3000"
                  step="50"
                  value={opponentThinkTimeMs}
                  onChange={(e) => setOpponentThinkTimeMs(Number(e.target.value))}
                  className="w-full accent-cyan-500 cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                  <span>Fast (100ms)</span>
                  <span>Normal (450ms)</span>
                  <span>Deep (3000ms)</span>
                </div>
              </div>

              {/* Strength Elo if supported */}
              {currentEngineObj.supports_elo && (
                <div className={`p-3 rounded-2xl border space-y-1 ${isLight ? "bg-slate-50 border-slate-200" : "bg-black/30 border-white/5"}`}>
                  <div className="flex justify-between text-xs font-mono">
                    <span className="font-bold">Engine Strength / Skill:</span>
                    <span className="text-emerald-500 font-extrabold">{targetElo} Elo</span>
                  </div>
                  <input
                    type="range"
                    min={minElo}
                    max={maxElo}
                    step="25"
                    value={targetElo}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setTargetElo(val);
                      setQuickTuningOptions((prev) => ({ ...prev, UCI_Elo: val }));
                    }}
                    className="w-full accent-emerald-500 cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-slate-500 font-mono">
                    <span>{minElo} Elo</span>
                    <span>{maxElo} Elo</span>
                  </div>
                </div>
              )}

              {/* CPU Threads */}
              <div className={`p-3 rounded-2xl border space-y-1 ${isLight ? "bg-slate-50 border-slate-200" : "bg-black/30 border-white/5"}`}>
                <div className="flex justify-between text-xs font-mono">
                  <span className="font-bold">
                    CPU Threads{activeThreadsOptionKey !== "Threads" ? ` (${activeThreadsOptionKey})` : ""}:
                  </span>
                  <span className="text-cyan-400 font-extrabold">{opponentThreads} Thread(s)</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="16"
                  step="1"
                  value={opponentThreads}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setOpponentThreads(val);
                    setQuickTuningOptions((prev) => ({ ...prev, [activeThreadsOptionKey]: val }));
                  }}
                  className="w-full accent-cyan-500 cursor-pointer"
                />
              </div>

              {/* Hash Memory */}
              <div className={`p-3 rounded-2xl border space-y-1 ${isLight ? "bg-slate-50 border-slate-200" : "bg-black/30 border-white/5"}`}>
                <div className="flex justify-between text-xs font-mono">
                  <span className="font-bold">Hash Table Memory:</span>
                  <span className="text-cyan-400 font-extrabold">{opponentHashMb} MB</span>
                </div>
                <input
                  type="range"
                  min="16"
                  max="512"
                  step="16"
                  value={opponentHashMb}
                  onChange={(e) => {
                    const val = Number(e.target.value);
                    setOpponentHashMb(val);
                    setQuickTuningOptions((prev) => ({ ...prev, Hash: val }));
                  }}
                  className="w-full accent-cyan-500 cursor-pointer"
                />
              </div>

              {/* Expandable All Native UCI Options Drawer */}
              <div className={`rounded-2xl border overflow-hidden ${isLight ? "bg-slate-50 border-slate-200" : "bg-black/30 border-white/10"}`}>
                <button
                  type="button"
                  onClick={() => setIsQuickUciExpanded((v) => !v)}
                  className={`w-full px-3.5 py-2.5 flex items-center justify-between text-xs font-extrabold cursor-pointer transition-colors ${
                    isLight ? "hover:bg-slate-100 text-slate-800" : "hover:bg-white/5 text-cyan-300"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <Settings className="w-3.5 h-3.5 text-cyan-500" />
                    <span>
                      {isQuickUciExpanded ? "Hide All UCI Options" : "Expand All UCI Options"}
                    </span>
                    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${isLight ? "bg-cyan-100 text-cyan-800" : "bg-cyan-500/20 text-cyan-300"}`}>
                      {isLoadingQuickUciOptions
                        ? "Probing..."
                        : `${Object.keys(quickTuningAllOptions || {}).length} options`}
                    </span>
                  </span>
                  {isQuickUciExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                </button>

                {isQuickUciExpanded && (
                  <div className={`p-3 border-t ${isLight ? "border-slate-200 bg-white" : "border-white/10 bg-black/20"}`}>
                    {isLoadingQuickUciOptions ? (
                      <div className="py-6 flex items-center justify-center gap-2 text-xs font-mono text-slate-400">
                        <RefreshCw className="w-4 h-4 animate-spin text-cyan-400" />
                        Probing native UCI options for {currentEngineObj.name}...
                      </div>
                    ) : Object.keys(quickTuningAllOptions || {}).length === 0 ? (
                      <div className="py-4 text-center text-xs font-mono text-slate-400">
                        No additional UCI protocol options detected for {currentEngineObj.name}.
                      </div>
                    ) : (
                      <UciOptionsInspector
                        key={selectedEngine}
                        optionsMap={quickTuningAllOptions as Record<string, any>}
                        currentValues={quickTuningOptions}
                        onChange={(optKey, val) => {
                          setQuickTuningOptions((prev) => ({ ...prev, [optKey]: val }));
                          const low = optKey.toLowerCase();
                          if (low === "threads" || low === "number of threads" || low === "max threads") {
                            const n = Number(val);
                            if (Number.isFinite(n) && n >= 1) setOpponentThreads(Math.min(16, Math.round(n)));
                          } else if (low === "hash") {
                            const n = Number(val);
                            if (Number.isFinite(n) && n >= 16) setOpponentHashMb(Math.min(512, Math.round(n)));
                          } else if (low === "uci_elo" && currentEngineObj.supports_elo) {
                            const n = Number(val);
                            if (Number.isFinite(n)) setTargetElo(Math.min(maxElo, Math.max(minElo, Math.round(n))));
                          }
                        }}
                        isLight={isLight}
                      />
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-t pt-3 border-white/10 shrink-0">
              <span className="text-[10px] font-mono text-slate-400">
                Persists to {currentEngineObj.name} UCI profile
              </span>
              <button
                disabled={isSavingQuickTuning}
                onClick={async () => {
                  setIsSavingQuickTuning(true);
                  try {
                    const schemaMap = (quickTuningAllOptions || {}) as Record<string, any>;
                    const validKeys = Object.keys(schemaMap);
                    const merged: Record<string, any> = {
                      ...(currentEngineObj.options || {}),
                      ...quickTuningOptions,
                      [activeThreadsOptionKey]: opponentThreads,
                      Hash: opponentHashMb,
                    };
                    if (currentEngineObj.supports_elo && ("UCI_Elo" in schemaMap || "UCI_Elo" in merged)) {
                      merged["UCI_Elo"] = targetElo;
                    }
                    // Strictly isolate to this engine's valid schema (never transpose keys or save MultiPV/button)
                    const isolated: Record<string, any> = {};
                    Object.entries(merged).forEach(([k, v]) => {
                      if (k.toLowerCase() === "multipv") return;
                      if (validKeys.length > 0 && !(k in schemaMap)) return;
                      if (schemaMap[k]?.type === "button") return;
                      isolated[k] = v;
                    });
                    await updateCustomEngine(selectedEngine, { options: isolated });
                    await queryClient.invalidateQueries({ queryKey: ["engines"] });
                    await queryClient.refetchQueries({ queryKey: ["engines"] });
                    initEngineHandshake({
                      engine_id: selectedEngine,
                      subsystem: "sparring",
                      elo: currentEngineObj.supports_elo ? targetElo : undefined,
                      threads: opponentThreads,
                      hash_mb: opponentHashMb,
                      book_name: selectedBook,
                      use_book: Boolean(selectedBook && selectedBook !== "none" && selectedBook !== "engine_native"),
                      custom_options: isolated,
                    })
                      .then((res) => {
                        if (res?.uci_log) appendSparringUciLog(res.uci_log);
                      })
                      .catch(() => {});
                    logAction("API", "Saved Quick Tuning + UCI options to engine profile " + selectedEngine);
                    setIsQuickTuningOpen(false);
                  } catch (e: any) {
                    logAction("ERROR", "Failed to save Quick Tuning: " + (e?.message ?? String(e)));
                  } finally {
                    setIsSavingQuickTuning(false);
                  }
                }}
                className="px-5 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-xl text-xs font-extrabold shadow cursor-pointer disabled:opacity-50"
              >
                {isSavingQuickTuning ? "Saving..." : "Apply & Continue Match"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* In-Game Tutor Flag Overlay */}
            {activeTutorFlag && (
              <div className="absolute inset-x-3 bottom-3 p-3.5 rounded-2xl bg-slate-950/95 border-2 border-amber-500/80 shadow-2xl backdrop-blur-md animate-in slide-in-from-bottom-3 duration-200 z-30">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 rounded-lg bg-amber-500/20 text-amber-400">
                      <GraduationCap className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="text-xs font-extrabold text-amber-300 font-mono flex items-center gap-1.5">
                        Tutor Feedback: {activeTutorFlag.flag_type === "mate_alert" ? "Mate Alert" : activeTutorFlag.flag_type === "user_blunder" ? "Blunder Detected" : activeTutorFlag.flag_type === "mistake" ? "Mistake Detected" : "Tactical Alert"}
                        {activeTutorFlag.flag_type === "mate_alert" ? (
                          <span className="text-xs text-emerald-400 font-bold">(Mate in {activeTutorFlag.mate_in ?? "?"} available)</span>
                        ) : (
                          <span className="text-xs text-rose-400 font-bold">(-{activeTutorFlag.loss_cp} cp)</span>
                        )}
                      </h4>
                      <p className="text-xs text-slate-100 font-semibold">
                        {getTutorHintText(activeTutorFlag)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {activeTutorFlag.tags.map(getTagBadge)}
                  </div>
                </div>

                <label className="flex items-center gap-1.5 text-[10px] text-slate-300 mb-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={tutorSuppressWhenWinning}
                    onChange={(e) => setTutorSuppressWhenWinning(e.target.checked)}
                    className="accent-amber-500"
                  />
                  Don't alert while I'm decisively winning (unless I throw it away or drop a mate)
                </label>

                <div className="flex items-center gap-2 pt-1 flex-wrap sm:flex-nowrap">
                  {tutorHintDepth === "full" ? (
                    <button
                      onClick={() => handleTutorOutcome("accepted_suggestion", activeTutorFlag.best_move_san)}
                      className="flex-1 py-1.5 px-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-colors cursor-pointer flex items-center justify-center gap-1 shadow-md shadow-emerald-950/40"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Accept Move ({activeTutorFlag.best_move_san})
                    </button>
                  ) : (
                    <button
                      onClick={() => handleTutorOutcome("accepted_suggestion", activeTutorFlag.best_move_san)}
                      className="flex-1 py-1.5 px-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-colors cursor-pointer flex items-center justify-center gap-1 shadow-md shadow-emerald-950/40"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Play Best Move
                    </button>
                  )}
                  <button
                    onClick={() => handleTutorOutcome("takeback")}
                    className="py-1.5 px-2.5 bg-amber-600/30 hover:bg-amber-600/50 text-amber-200 rounded-lg text-xs font-bold border border-amber-500/40 cursor-pointer flex items-center gap-1"
                    title="Takeback move to try another one on your own"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                    Retry
                  </button>
                  <button
                    onClick={() => handleTutorOutcome("played_own_move")}
                    className="py-1.5 px-2.5 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-xs font-bold border border-white/15 cursor-pointer"
                    title="Keep your played move and continue"
                  >
                    Keep Mine
                  </button>
                  <button
                    onClick={() => handleTutorOutcome("ignored_flag")}
                    className="p-1.5 text-slate-300 hover:text-white rounded-lg cursor-pointer"
                    title="Dismiss"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Action Toolbar */}
          <div className="w-full flex flex-wrap items-center gap-2 pt-1" style={{ maxWidth: boardContainerWidth }}>
            {!isGameActive ? (
              <button
                onClick={handleStartGame}
                className="w-full py-3 bg-gradient-to-r from-rose-600 to-red-600 hover:from-rose-500 hover:to-red-500 text-white text-xs font-extrabold uppercase tracking-wider rounded-xl shadow-lg shadow-rose-950/40 border border-rose-400/30 transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-95"
              >
                <Play className="w-4 h-4 fill-current" />
                Start Sparring Match
              </button>
            ) : (
              <>
                {/* 1. Resign & Analyze / Analyze Game (game over) */}
                <button
                  onClick={handleResignAndAnalyze}
                  disabled={moveHistory.length < 2}
                  className={`flex-1 min-w-[130px] py-3 px-3 active:scale-95 text-xs font-extrabold uppercase tracking-wider rounded-xl border shadow-md transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40 ${
                    isGameFinished
                      ? "bg-emerald-900/60 hover:bg-emerald-800/70 text-emerald-300 border-emerald-700/40"
                      : "bg-rose-900/60 hover:bg-rose-800/70 text-rose-300 border-rose-700/40"
                  }`}
                  title={
                    moveHistory.length < 2
                      ? "Play at least 2 plies to save & analyze"
                      : isGameFinished
                      ? "Save the finished game and launch parallel Analysis"
                      : "Resign, save at Silver tier, and immediately launch parallel Analysis"
                  }
                >
                  {isGameFinished ? <BarChart3 className="w-3.5 h-3.5" /> : <Flag className="w-3.5 h-3.5" />}
                  <span>{isGameFinished ? "Analyze Game" : "Resign & Analyze"}</span>
                </button>

                {/* 1b. Resign Only (saves at Silver tier, opens Analysis without auto-eval) */}
                {!isGameFinished && (
                  <button
                    onClick={handleResignOnly}
                    disabled={moveHistory.length < 2}
                    className="flex-1 min-w-[115px] py-3 px-3 bg-amber-950/50 hover:bg-amber-900/60 active:scale-95 text-amber-300 text-xs font-extrabold uppercase tracking-wider rounded-xl border border-amber-700/40 shadow-md transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40"
                    title={
                      moveHistory.length < 2
                        ? "Play at least 2 plies to resign & save"
                        : "Resign, save at Silver tier, and open in Analysis without launching engine evaluation"
                    }
                  >
                    <Flag className="w-3.5 h-3.5" />
                    <span>Resign Only</span>
                  </button>
                )}

                {/* 2. New Game */}
                <button
                  onClick={handleNewGame}
                  className="flex-1 min-w-[110px] py-3 px-3 bg-slate-800 hover:bg-slate-700 active:scale-95 text-white text-xs font-extrabold uppercase tracking-wider rounded-xl border border-slate-600 shadow-md transition-all flex items-center justify-center gap-1.5 cursor-pointer"
                  title={
                    moveHistory.length < 2
                      ? "Discard 0/1-ply session cleanly and start a new match"
                      : "Adjudicate result, save at Silver tier, and start a new match"
                  }
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>New Game</span>
                </button>

                {/* 3. Takeback */}
                <button
                  onClick={handleTakeback}
                  disabled={isEngineThinking || moveHistory.length === 0}
                  className="flex-1 min-w-[100px] py-3 px-3 bg-slate-800 hover:bg-slate-700 active:scale-95 text-amber-300 rounded-xl border border-white/15 text-xs font-extrabold uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40"
                  title="Takeback 1 ply to try another path or override"
                >
                  <Undo2 className="w-3.5 h-3.5 text-amber-400" />
                  <span>Takeback</span>
                </button>

                {/* 4. Save Copy... with inline popover */}
                <div className="relative flex-1 min-w-[120px]">
                  <button
                    onClick={() => setIsSaveCopyOpen((v) => !v)}
                    disabled={moveHistory.length === 0}
                    className="w-full py-3 px-3 bg-slate-800 hover:bg-slate-700 active:scale-95 text-white rounded-xl border border-white/15 text-xs font-extrabold uppercase tracking-wider transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-40"
                    title="Save a copy of this game to any database"
                  >
                    <Save className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Save Copy...</span>
                  </button>
                  {isSaveCopyOpen && (
                    <div className="absolute bottom-full mb-2 left-0 z-50 w-56 rounded-xl bg-slate-900 border border-white/15 shadow-2xl p-3 flex flex-col gap-2">
                      <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Save copy to:</p>
                      <select
                        value={saveCopyTargetDb}
                        onChange={(e) => setSaveCopyTargetDb(e.target.value)}
                        className="w-full rounded-lg bg-slate-800 border border-white/15 text-white text-xs px-2 py-1.5 cursor-pointer"
                      >
                        {(dbList || [{ name: SPARRING_DB_NAME }]).map((db: any) => (
                          <option key={db.name} value={db.name}>{db.name}</option>
                        ))}
                      </select>
                      <button
                        onClick={handleSaveCopy}
                        className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-extrabold rounded-lg cursor-pointer transition-colors"
                      >
                        Save
                      </button>
                      {saveCopyToast && (
                        <p className="text-[10px] text-emerald-400 font-bold text-center">{saveCopyToast}</p>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {sparSessionError && (
            <p className="w-full mt-1 text-xs text-red-400 font-medium" style={{ maxWidth: boardContainerWidth }} role="alert">
              ⚠ {sparSessionError}
            </p>
          )}

          {/* Live Persistence Badge */}
          <div className={"w-full flex items-center gap-2 text-[11px] font-mono pt-0.5 flex-wrap " + (isLight ? "text-slate-700" : "text-slate-400")} style={{ maxWidth: boardContainerWidth }}>
            {autosaveAlert ? (
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 font-bold animate-pulse">
                ⟳ Syncing to {SPARRING_DB_NAME}…
              </span>
            ) : saveSuccessMsg ? (
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 font-bold">
                ✓ {saveSuccessMsg}
              </span>
            ) : (
              <span className={"flex items-center gap-1.5 px-2.5 py-1 rounded-lg border " + (isLight ? "bg-slate-100 border-slate-300" : "bg-black/30 border-white/10")}>
                <span className={isLight ? "text-slate-500" : "text-slate-500"}>DB:</span>
                <strong className={isLight ? "text-slate-800" : "text-slate-300"}>{SPARRING_DB_NAME}</strong>
                <span className={isLight ? "text-slate-400" : "text-slate-600"}>·</span>
                <span className={isLight ? "text-slate-500" : "text-slate-500"}>Kibitzer: {kibitzerUciLog.length} lines</span>
                {currentGameId && (
                  <>
                    <span className={isLight ? "text-slate-400" : "text-slate-600"}>·</span>
                    <span className={isLight ? "text-slate-500" : "text-slate-500"}>Game #{currentGameId.slice(0, 8)}</span>
                  </>
                )}
              </span>
            )}
          </div>

          {/* Ask Grandmaster Integration */}
          <div className="w-full max-w-[520px]">
            <AskGrandmasterAction
              fen={fen}
              evalStr={evalScore}
              mainLine={moveHistory.slice(-3).join(" ")}
              contextNotes={contextNotesStr}
              variant="banner"
            />
          </div>

          {/* Interactive Opening Book Repertoire HUD */}
          {isBookPanelOpen && (
            <div
              className={`w-full max-w-[520px] p-4 rounded-3xl border shadow-xl transition-all space-y-3 ${
                isLight ? "bg-white border-slate-300 text-slate-900" : "bg-[#14171c] border-slate-800 text-white"
              }`}
            >
              <button
                onClick={() => setIsLegacyBookOpen(!isLegacyBookOpen)}
                className="w-full flex items-center justify-between border-b pb-2.5 border-white/10 cursor-pointer"
              >
                <div className="flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-purple-400" />
                  <span className="font-extrabold text-xs uppercase tracking-wider">Opening Book Theory</span>
                  {selectedBook === "engine_native" || selectedBook === "none" ? (
                    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-600 dark:text-cyan-300 border border-cyan-500/40">
                      Engine Native
                    </span>
                  ) : bookProbeData?.in_book ? (
                    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 border border-emerald-500/40">
                      In Book
                    </span>
                  ) : (
                    <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-600 dark:text-amber-300 border border-amber-500/40">
                      Novelty
                    </span>
                  )}
                </div>
                {isLegacyBookOpen ? <ChevronUp className="w-3.5 h-3.5 opacity-60" /> : <ChevronDown className="w-3.5 h-3.5 opacity-60" />}
              </button>

              {isLegacyBookOpen && (
                <select
                  value={selectedBook}
                  onChange={(e) => setSelectedBook(e.target.value)}
                  className={`text-[11px] font-mono font-bold rounded-lg px-2 py-1 border outline-none cursor-pointer w-full ${
                    isLight ? "bg-slate-100 border-slate-300 text-slate-900" : "bg-black/60 border-white/20 text-white"
                  }`}
                >
                  <option value="engine_native">Engine Default (Native NNUE / Internal Book)</option>
                  <option value="none">No Book (Pure Calculation)</option>
                  {booksData?.map((b) => (
                    <option key={b.filename} value={b.filename}>
                      {b.filename}
                    </option>
                  ))}
                </select>
              )}


              {isLegacyBookOpen && (
              <>{/* Theory Info & Candidate Lines */}
              {bookProbeData?.in_book && bookProbeData.candidates && bookProbeData.candidates.length > 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono text-slate-400">Candidate Book Moves ({bookProbeData.candidates.length}):</span>
                    {bookProbeData.best_move_san && (
                      <button
                        onClick={() => handleFollowBookMove(bookProbeData.best_move_san, bookProbeData.best_move_uci)}
                        disabled={isEngineThinking || game.isGameOver()}
                        className="px-2.5 py-1 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white text-[11px] font-bold rounded-lg transition-all shadow cursor-pointer disabled:opacity-40 flex items-center gap-1"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        Follow Main ({bookProbeData.best_move_san})
                      </button>
                    )}
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 font-mono text-xs">
                    {bookProbeData.candidates.map((cand, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleFollowBookMove(cand.san, cand.uci)}
                        disabled={isEngineThinking || game.isGameOver()}
                        className={`p-2 rounded-xl border flex items-center justify-between text-left transition-all cursor-pointer disabled:opacity-40 ${
                          cand.san === bookProbeData.best_move_san
                            ? isLight
                              ? "bg-purple-50 border-purple-300 text-purple-950 font-bold"
                              : "bg-purple-950/40 border-purple-500/50 text-purple-200 font-bold"
                            : isLight
                            ? "bg-slate-100 hover:bg-purple-100/60 border-slate-200 text-slate-800"
                            : "bg-black/40 hover:bg-purple-950/20 border-white/10 text-slate-200"
                        }`}
                        title={`Play ${cand.san} (Theory Weight: ${cand.weight}, 0 ACPL loss)`}
                      >
                        <div className="flex items-center gap-1.5">
                          <span className="font-extrabold text-sm">{cand.san}</span>
                          {cand.san === bookProbeData.best_move_san && (
                            <span className="text-[9px] px-1 py-0.2 bg-purple-500/30 text-purple-300 rounded font-bold uppercase">
                              Main
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="w-12 h-1.5 rounded-full bg-slate-700/40 overflow-hidden">
                            <div
                              className="h-full bg-purple-500 rounded-full"
                              style={{ width: `${cand.weight_pct}%` }}
                            />
                          </div>
                          <span className="text-[11px] font-bold opacity-90">{cand.weight_pct}%</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ) : selectedBook === "engine_native" || selectedBook === "none" ? (
                <div className="p-3 rounded-xl bg-cyan-950/20 border border-cyan-500/20 text-center text-xs text-cyan-300 font-mono">
                  Engine Native Mode Active — Polyglot opening books are bypassed. Engine uses its own internal evaluation and opening heuristics.
                </div>
              ) : (
                <div className="p-3 rounded-xl bg-black/20 border border-white/5 text-center text-xs text-slate-400 font-mono">
                  Current position is beyond opening book theory (Novelty / Endgame / Deviation).
                </div>
              )}
              </>)}
            </div>
          )}

          {/* DSD-46: SQLite Candidate Book Moves Panel */}
          <div
            className={`w-full max-w-[520px] rounded-3xl border shadow-xl transition-all ${
              isLight ? "bg-white border-slate-300 text-slate-900" : "bg-[#14171c] border-slate-800 text-white"
            }`}
          >
            {/* Collapsible header */}
            <button
              onClick={() => setIsCandidateBookOpen(!isCandidateBookOpen)}
              className={`w-full flex items-center justify-between px-4 py-3 text-xs font-extrabold uppercase tracking-wider rounded-3xl transition-colors cursor-pointer ${
                isCandidateBookOpen
                  ? isLight ? "bg-indigo-50 text-indigo-900" : "bg-indigo-950/40 text-indigo-300"
                  : isLight ? "text-slate-700 hover:bg-slate-50" : "text-slate-400 hover:bg-white/5"
              }`}
            >
              <div className="flex items-center gap-2">
                <BookOpen className="w-4 h-4 text-indigo-400" />
                <span>Candidate Book Moves (SQLite)</span>
                {candidateBookData && candidateBookData.length > 0 && (
                  <span className="text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-400 border border-indigo-500/30">
                    {candidateBookData.length}
                  </span>
                )}
              </div>
              {isCandidateBookOpen ? (
                <ChevronUp className="w-4 h-4 opacity-60" />
              ) : (
                <ChevronDown className="w-4 h-4 opacity-60" />
              )}
            </button>

            {isCandidateBookOpen && (
              <div className="px-4 pb-4 space-y-3">
                {/* Book DB selector */}
                <div className="flex items-center gap-2 pt-1">
                  <label className={`text-[11px] font-bold whitespace-nowrap ${isLight ? "text-slate-700" : "text-slate-400"}`}>
                    Book DB:
                  </label>
                  <input
                    type="text"
                    value={candidateBookDb}
                    onChange={(e) => setCandidateBookDb(e.target.value)}
                    placeholder="e.g. gm_book.sqlite"
                    className={`flex-1 text-[11px] font-mono rounded-lg px-2 py-1 border outline-none ${
                      isLight
                        ? "bg-slate-100 border-slate-300 text-slate-900 placeholder-slate-400"
                        : "bg-black/50 border-white/15 text-white placeholder-slate-500"
                    }`}
                  />
                </div>

                {/* Candidate list */}
                {!candidateBookDb ? (
                  <div className={`p-3 rounded-xl border text-center text-xs font-mono ${
                    isLight ? "bg-slate-50 border-slate-200 text-slate-500" : "bg-black/20 border-white/5 text-slate-500"
                  }`}>
                    Enter a SQLite book database filename to load candidates.
                  </div>
                ) : candidateBookData && candidateBookData.length > 0 ? (
                  <div className="space-y-1.5">
                    {/* Column headers */}
                    <div className={`grid grid-cols-4 text-[10px] font-bold uppercase tracking-wider px-2 ${
                      isLight ? "text-slate-500" : "text-slate-500"
                    }`}>
                      <span>Move</span>
                      <span className="text-center">Pop%</span>
                      <span className="text-center">Avg Elo</span>
                      <span className="text-center">ACPL</span>
                    </div>
                    {candidateBookData.map((cand, idx) => (
                      <button
                        key={idx}
                        onClick={() => handleFollowBookMove(cand.move_san ?? cand.move_uci, cand.move_uci)}
                        disabled={isEngineThinking || game.isGameOver()}
                        className={`w-full grid grid-cols-4 items-center p-2 rounded-xl border text-left text-xs transition-all cursor-pointer disabled:opacity-40 ${
                          idx === 0
                            ? isLight
                              ? "bg-indigo-50 border-indigo-300 text-indigo-950 font-bold"
                              : "bg-indigo-950/40 border-indigo-500/50 text-indigo-200 font-bold"
                            : isLight
                            ? "bg-slate-50 hover:bg-indigo-50/60 border-slate-200 text-slate-800"
                            : "bg-black/30 hover:bg-indigo-950/20 border-white/8 text-slate-200"
                        }`}
                        title={`Play ${cand.move_san ?? cand.move_uci} (weight: ${cand.weight})`}
                      >
                        <span className="font-extrabold font-mono text-sm">
                          {cand.move_san ?? cand.move_uci}
                        </span>
                        <span className={`text-center font-mono font-bold text-[11px] px-1 py-0.5 rounded-full ${
                          isLight ? "bg-indigo-100 text-indigo-700" : "bg-indigo-500/20 text-indigo-300"
                        }`}>
                          {cand.popularity_pct}%
                        </span>
                        <span className={`text-center font-mono text-[11px] ${
                          isLight ? "text-slate-600" : "text-slate-400"
                        }`}>
                          {cand.avg_elo ?? "—"}
                        </span>
                        <span className={`text-center font-mono text-[11px] ${
                          isLight ? "text-slate-600" : "text-slate-400"
                        }`}>
                          {cand.acpl != null ? cand.acpl : "—"}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className={`p-3 rounded-xl border text-center text-xs font-mono ${
                    isLight ? "bg-slate-50 border-slate-200 text-slate-500" : "bg-black/20 border-white/5 text-slate-500"
                  }`}>
                    No candidates found for this position in the selected database.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Drag Splitter Handle */}
        <div
          onMouseDown={handleSplitterMouseDown}
          className="w-5 shrink-0 relative flex flex-col items-center cursor-col-resize group select-none self-stretch z-20"
          title="Drag to resize chessboard"
        >
          {/* Subtle vertical guide line on hover */}
          <div className="absolute inset-y-0 w-[2px] bg-transparent group-hover:bg-cyan-500/30 transition-colors" />

          {/* 3-Line Grab Handle pill hovering on the outside of the board */}
          <div
            className={`absolute flex items-center justify-center rounded-full transition-all duration-150 shadow-md ${
              isDragging
                ? "bg-cyan-600 text-white border-cyan-400 scale-110 shadow-cyan-500/40 ring-2 ring-cyan-400/40"
                : isLight
                ? "bg-white text-slate-400 hover:text-cyan-600 border border-slate-300 group-hover:border-cyan-400 group-hover:text-cyan-600 group-hover:shadow-lg group-hover:scale-110"
                : "bg-slate-800 text-slate-400 hover:text-cyan-300 border border-slate-600 group-hover:border-cyan-400 group-hover:text-cyan-400 group-hover:shadow-lg group-hover:scale-110"
            } w-5 h-11 cursor-col-resize`}
            style={{
              top: `${Math.round(58 + boardContainerWidth / 2 - 22)}px`,
            }}
          >
            {/* 3 tiny grip lines */}
            <div className="flex items-center justify-center gap-[2.5px]">
              <div className="w-[1.5px] h-4 rounded-full bg-current opacity-75" />
              <div className="w-[1.5px] h-4 rounded-full bg-current opacity-75" />
              <div className="w-[1.5px] h-4 rounded-full bg-current opacity-75" />
            </div>
          </div>
        </div>

        {/* Right Column: 3-Tab Companion Control Hub */}
        <div className="flex-1 min-w-0 space-y-5">
          {/* Navigation Sub-Tabs */}
          <div className={"flex items-center gap-1.5 p-1 rounded-2xl border " + (isLight ? "bg-slate-200/90 border-slate-300 shadow-inner" : "bg-black/40 border-white/10")}>
            <button
              onClick={() => setRightPanelTab("sparring")}
              className={"flex-1 py-2.5 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center gap-1.5 cursor-pointer " + (rightPanelTab === "sparring" ? "bg-rose-600 text-white shadow-lg" : isLight ? "text-slate-800 hover:text-black hover:bg-slate-300/60 font-black" : "text-slate-200 hover:text-white")}
            >
              <Swords className="w-4 h-4" />
              Opponent Setup
            </button>
            <button
              onClick={() => setRightPanelTab("kibitzer")}
              className={"flex-1 py-2.5 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center gap-1.5 cursor-pointer " + (rightPanelTab === "kibitzer" ? "bg-cyan-600 text-white shadow-lg" : isLight ? "text-slate-800 hover:text-black hover:bg-slate-300/60 font-black" : "text-slate-200 hover:text-white")}
            >
              <Sparkles className="w-4 h-4" />
              🧐 Kibitzer
            </button>
            <button
              onClick={() => setRightPanelTab("tutor")}
              className={"flex-1 py-2.5 rounded-xl text-xs font-extrabold transition-all flex items-center justify-center gap-1.5 cursor-pointer " + (rightPanelTab === "tutor" ? "bg-emerald-600 text-white shadow-lg" : isLight ? "text-slate-800 hover:text-black hover:bg-slate-300/60 font-black" : "text-slate-200 hover:text-white")}
            >
              <GraduationCap className="w-4 h-4" />
              🎓 Tutor
            </button>
          </div>

          {/* TAB 1: SPARRING MATCH SETUP */}
          {rightPanelTab === "sparring" && (
            <div className={"p-5 rounded-3xl " + (isLight ? "bg-white border-slate-300 text-slate-900 shadow-lg" : "bg-[#14171c] border-slate-800 text-white shadow-xl") + " border space-y-4"}>
              <div className={"flex items-center justify-between border-b pb-3 " + (isLight ? "border-slate-200" : "border-white/5")}>
                <button
                  onClick={() => setIsOpponentSelectionOpen(!isOpponentSelectionOpen)}
                  className="flex items-center gap-2 cursor-pointer text-left group"
                  title={isOpponentSelectionOpen ? "Collapse engine selection" : "Expand engine selection"}
                >
                  <h2 className={"text-xs font-extrabold uppercase tracking-wider flex items-center gap-2 " + (isLight ? "text-rose-800" : "text-rose-400")}>
                    <Sliders className="w-4 h-4 text-rose-500" />
                    Opponent Engine Selection
                  </h2>
                  {!isOpponentSelectionOpen && (
                    <span className={"text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border flex items-center gap-1 " + (isLight ? "bg-rose-50 text-rose-800 border-rose-200" : "bg-rose-500/20 text-rose-300 border border-rose-500/30")}>
                      <span>{currentEngineObj.icon}</span>
                      <span>{currentEngineObj.name}</span>
                      <span className="opacity-75">({currentEngineObj.elo})</span>
                    </span>
                  )}
                </button>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setIsQuickTuningOpen(true)}
                    className="px-2.5 py-1 text-[11px] font-extrabold rounded-lg bg-slate-800 hover:bg-slate-700 text-cyan-300 border border-cyan-500/30 flex items-center gap-1 cursor-pointer"
                    title="Quickly adjust opponent engine threads, hash, thinking time and resources"
                  >
                    <Sliders className="w-3 h-3 text-cyan-400" />
                    Tuning
                  </button>
                  <button
                    onClick={() => setIsAddEngineModalOpen(true)}
                    className="px-2.5 py-1 text-[11px] font-extrabold rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-600 dark:text-rose-300 border border-rose-500/40 flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3 h-3" />
                    Add Bot
                  </button>
                  <button
                    onClick={() => setIsOpponentSelectionOpen(!isOpponentSelectionOpen)}
                    className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors cursor-pointer"
                    title={isOpponentSelectionOpen ? "Collapse engine selection" : "Expand engine selection"}
                  >
                    {isOpponentSelectionOpen ? <ChevronUp className="w-4 h-4 opacity-70" /> : <ChevronDown className="w-4 h-4 opacity-70" />}
                  </button>
                </div>
              </div>

              {/* Collapsed summary strip */}
              {!isOpponentSelectionOpen && (
                <div className={"flex items-center justify-between p-2.5 rounded-xl border text-xs " + (isLight ? "bg-slate-100 border-slate-300 text-slate-900" : "bg-black/30 border-white/10 text-slate-200")}>
                  <span className="flex items-center gap-2 font-bold">
                    <span className="text-base">{currentEngineObj.icon}</span>
                    <span>{currentEngineObj.name}</span>
                    <span className={"font-mono text-[10px] " + (isLight ? "text-slate-600" : "text-slate-400")}>{currentEngineObj.elo} Elo</span>
                    {currentEngineObj.supports_elo && (
                      <span className="text-rose-400 font-extrabold text-[10px]">@ {targetElo}</span>
                    )}
                  </span>
                  <button
                    onClick={() => setIsOpponentSelectionOpen(true)}
                    className={"px-2.5 py-1 text-[10px] font-extrabold rounded-lg cursor-pointer " + (isLight ? "bg-slate-200 hover:bg-slate-300 text-slate-800" : "bg-slate-800 hover:bg-slate-700 text-slate-300")}
                  >
                    Change
                  </button>
                </div>
              )}

              {isOpponentSelectionOpen && (<>
              {/* Engine Grid */}
              <div className="grid grid-cols-2 gap-2">
                {engines.map((eng) => (
                  <div
                    key={eng.id}
                    onClick={() => setSelectedEngine(eng.id)}
                    className={"p-2.5 rounded-xl text-left border text-xs font-sans transition-all flex items-center justify-between cursor-pointer group " + (selectedEngine === eng.id ? "bg-rose-500/20 border-rose-500 text-rose-950 dark:text-white font-extrabold ring-1 ring-rose-500 shadow-sm" : isLight ? "bg-slate-100 border-slate-300 text-slate-900 font-bold hover:bg-slate-200" : "bg-black/30 border-white/10 text-slate-300 hover:bg-white/5")}
                  >
                    <div className="flex items-center gap-2 truncate">
                      <span className="text-base">{eng.icon}</span>
                      <div className="truncate">
                        <span className="block truncate font-extrabold">{eng.name}</span>
                        <span className={"text-[10px] font-mono " + (isLight ? "text-slate-700 font-extrabold" : "text-slate-400 font-bold")}>{eng.elo}</span>
                      </div>
                    </div>
                    {eng.is_custom && (
                      <button
                        onClick={(e) => handleDeleteEngine(eng.id, e)}
                        className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-rose-400 p-1"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                ))}
              </div>

              {/* Target Elo */}
              {currentEngineObj.supports_elo ? (
                <div className="space-y-1.5 pt-1">
                  <div className="flex justify-between text-xs font-mono">
                    <span className={isLight ? "text-slate-900 font-extrabold" : "text-slate-200 font-bold"}>Strength Scale (UCI_LimitStrength):</span>
                    <span className="text-rose-600 dark:text-rose-400 font-extrabold">{targetElo} Elo</span>
                  </div>
                  <input
                    type="range"
                    min={minElo}
                    max={maxElo}
                    step="25"
                    value={targetElo}
                    onChange={(e) => setTargetElo(Number(e.target.value))}
                    className="w-full accent-rose-500 cursor-pointer"
                  />
                </div>
              ) : (
                <div className={"p-2.5 rounded-xl border text-[11px] flex items-center gap-2 " + (isLight ? "bg-slate-100 border-slate-300 text-slate-900 font-bold" : "bg-black/20 border-white/5 text-slate-200")}>
                  <span className="text-base">{currentEngineObj.icon}</span>
                  <span>Fixed rating: <strong className={isLight ? "text-slate-950 font-black" : "text-white"}>{currentEngineObj.elo}</strong> (neural/tactical default)</span>
                </div>
              )}
              </>)}

              {/* Play As (DSD-57): which colour the human plays, independent of the Flip Board view */}
              <div className="space-y-1.5 pt-1">
                <label className={"text-xs font-extrabold block " + (isLight ? "text-slate-900" : "text-slate-200")}>Play as:</label>
                <div className="grid grid-cols-3 gap-2">
                  {(["white", "black", "random"] as const).map((side) => (
                    <button
                      key={side}
                      type="button"
                      disabled={isGameActive}
                      onClick={() => {
                        setPlayerSideChoice(side);
                        if (side !== "random") {
                          setPlayerSide(side);
                          setBoardOrientation(side);
                        }
                      }}
                      className={
                        "py-2 rounded-xl text-xs font-extrabold border transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed " +
                        (playerSideChoice === side
                          ? "bg-rose-500/20 border-rose-500 ring-1 ring-rose-500 " + (isLight ? "text-rose-950" : "text-white")
                          : isLight
                          ? "bg-slate-100 border-slate-300 text-slate-900 hover:bg-slate-200"
                          : "bg-black/30 border-white/10 text-slate-300 hover:bg-white/5")
                      }
                    >
                      {side === "white" ? "♔ White" : side === "black" ? "♚ Black" : "🎲 Random"}
                    </button>
                  ))}
                </div>
              </div>

              {/* Opening Book */}
              <div className="space-y-1.5 pt-1">
                <label className={"text-xs font-extrabold block " + (isLight ? "text-slate-900" : "text-slate-200")}>Opening Theory Book (.bin):</label>
                <select
                  value={selectedBook}
                  onChange={(e) => setSelectedBook(e.target.value)}
                  className={"w-full " + (isLight ? "bg-slate-100 border-slate-300 text-slate-950 font-bold" : "bg-black/60 border-white/20 text-white font-bold") + " border rounded-xl px-3 py-2 text-xs font-mono outline-none cursor-pointer focus:border-rose-500"}
                >
                  <option value="engine_native">Engine Default (Native NNUE / Internal Book)</option>
                  <option value="GMopenings.bin">GMopenings.bin — Top Grandmaster Theory</option>
                  {booksData?.filter((b) => b.filename !== "GMopenings.bin").map((b) => (
                    <option key={b.filename} value={b.filename}>
                      {b.filename} ({b.category})
                    </option>
                  ))}
                  <option value="none">No Book (Calculate from Move 1)</option>
                </select>

              </div>
            </div>
          )}

          {/* TAB 2: KIBITZER COMPANION ("Roads Not Taken") */}
          {rightPanelTab === "kibitzer" && (
            <div className={"p-5 rounded-3xl " + (isLight ? "bg-white border-slate-300 text-slate-900 shadow-lg" : "bg-[#14171c] border-slate-800 text-white shadow-xl") + " border space-y-4"}>
              <div className={"flex items-center justify-between border-b pb-3 " + (isLight ? "border-slate-200" : "border-white/5")}>
                <button
                  onClick={() => setIsKibitzerPanelOpen(!isKibitzerPanelOpen)}
                  className="flex items-center gap-2 text-left cursor-pointer group"
                  title={isKibitzerPanelOpen ? "Collapse Kibitzer panel" : "Expand Kibitzer panel"}
                >
                  <div>
                    <h2 className={"text-xs font-extrabold uppercase tracking-wider flex items-center gap-1.5 " + (isLight ? "text-cyan-800" : "text-cyan-400")}>
                      <Sparkles className="w-4 h-4 text-cyan-500" />
                      Kibitzer Companion Engine
                    </h2>
                    <p className={"text-[11px] font-semibold " + (isLight ? "text-slate-700" : "text-slate-300")}>Roads not taken — Alternative variations analysis</p>
                  </div>
                </button>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setIsKibitzerSettingsOpen(true)}
                    className={"p-2 rounded-xl border text-xs font-bold transition-all cursor-pointer " + (isLight ? "bg-slate-100 hover:bg-slate-200 text-slate-900 border-slate-300" : "bg-slate-800 hover:bg-slate-700 text-white border-white/10")}
                    title="Kibitzer Options & Engine Hardware Settings"
                  >
                    <Settings className="w-3.5 h-3.5 text-cyan-500" />
                  </button>
                  <button
                    onClick={() => handleGetAdvise()}
                    disabled={isKibitzerThinking}
                    className="px-3 py-1.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-extrabold flex items-center gap-1.5 cursor-pointer disabled:opacity-50 shadow-md shadow-cyan-950/20"
                  >
                    {isKibitzerThinking ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Lightbulb className="w-3.5 h-3.5" />}
                    Get Advise
                  </button>
                  <button
                    onClick={() => setIsKibitzerPanelOpen(!isKibitzerPanelOpen)}
                    className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors cursor-pointer"
                    title={isKibitzerPanelOpen ? "Collapse Kibitzer panel" : "Expand Kibitzer panel"}
                  >
                    {isKibitzerPanelOpen ? <ChevronUp className="w-4 h-4 opacity-70" /> : <ChevronDown className="w-4 h-4 opacity-70" />}
                  </button>
                </div>
              </div>

              {isKibitzerPanelOpen && (
              <div className="space-y-4">
              {/* Kibitzer Engine & Mode Configuration */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="space-y-1">
                  <label className={"text-[11px] font-extrabold " + (isLight ? "text-slate-900" : "text-slate-200")}>Kibitzer Engine:</label>
                  <select
                    value={kibitzerEngine}
                    onChange={(e) => setKibitzerEngine(e.target.value)}
                    className={"w-full " + (isLight ? "bg-slate-100 border-slate-300 text-slate-950 font-bold" : "bg-black/60 border-white/20 text-white font-bold") + " border rounded-xl px-2.5 py-2 text-xs outline-none cursor-pointer"}
                  >
                    {engines.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.icon} {e.name} ({e.elo})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className={"text-[11px] font-extrabold " + (isLight ? "text-slate-900" : "text-slate-200")}>Run Mode:</label>
                  <select
                    value={kibitzerMode}
                    onChange={(e) => {
                      const newMode = e.target.value as any;
                      setKibitzerMode(newMode);
                      if (newMode === "user_clock_bound" || newMode === "continuous") {
                        const effectiveTimeLimitMs = kibitzerSearchMode === "depth" ? null : kibitzerTimeLimitMs;
                        const effectiveDepth = kibitzerSearchMode === "time" ? undefined : kibitzerDepth;
                        fetchEngineVariations({
                          fen: fen,
                          engine_id: kibitzerEngine,
                          depth: effectiveDepth,
                          multipv: kibitzerMultipv,
                          time_limit_ms: effectiveTimeLimitMs,
                          threads: kibitzerThreads,
                          hash_mb: kibitzerHashMb,
                        }).then((res) => {
                          if (res?.variations) applyKibitzerVariations(res.variations, fen);
                        }).catch(() => {});
                      }
                    }}
                    className={"w-full " + (isLight ? "bg-slate-100 border-slate-300 text-slate-950 font-bold" : "bg-black/60 border-white/20 text-white font-bold") + " border rounded-xl px-2.5 py-2 text-xs outline-none cursor-pointer"}
                  >
                    <option value="on_demand">On Demand (Manual Click)</option>
                    <option value="user_clock_bound">User Clock Bound (User's Turn)</option>
                    <option value="opponent_clock_bound">Opponent Clock Bound (Opponent's Turn)</option>
                    <option value="continuous">Continuous Background (All Moves)</option>
                  </select>
                </div>
              </div>

              {/* MultiPV Lines Slider & Quick Filters */}
              <div className="space-y-2">
                <div className={"flex justify-between text-xs font-mono " + (isLight ? "text-slate-900 font-extrabold" : "text-slate-200 font-bold")}>
                  <span>Candidate Lines (MultiPV):</span>
                  <span className="text-cyan-600 dark:text-cyan-400 font-black">{kibitzerMultipv} Lines</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="15"
                  value={kibitzerMultipv}
                  onChange={(e) => setKibitzerMultipv(Number(e.target.value))}
                  className="w-full accent-cyan-500 cursor-pointer"
                />
                {kibitzerMultipv >= 10 && (
                  <p className={"text-[10px] font-semibold " + (isLight ? "text-slate-700" : "text-slate-400")}>
                    Wide scan: more lines are slower but surface more sacrifices (Brilliant) and tactics.
                  </p>
                )}

                {/* Tag Filter Pills */}
                <div className="flex items-center gap-1.5 pt-1 text-[11px] flex-wrap">
                  <span className={"font-extrabold flex items-center gap-1 " + (isLight ? "text-slate-900" : "text-slate-200")}><Filter className="w-3 h-3" /> Filter:</span>
                  {(["all", "tactical", "brilliant", "solid"] as const).map((filterVal) => (
                    <Tooltip
                      key={filterVal}
                      content={KIBITZER_FILTER_HELP[filterVal].title}
                      description={KIBITZER_FILTER_HELP[filterVal].description}
                      delayMs={2000}
                      position="bottom"
                    >
                      <button
                        onClick={() => setKibitzerTagFilter(filterVal)}
                        className={"px-2.5 py-1 rounded-lg font-extrabold capitalize transition-colors cursor-pointer " + (kibitzerTagFilter === filterVal ? "bg-cyan-600 text-white shadow-sm" : isLight ? "bg-slate-100 border-slate-300 text-slate-800 hover:text-black" : "bg-black/40 text-slate-300 hover:text-white border border-white/10")}
                      >
                        {filterVal}
                      </button>
                    </Tooltip>
                  ))}
                </div>
              </div>

              {/* Kibitzer Variations List */}
              <div className="space-y-2 pt-1">
                <h4 className={"text-xs font-extrabold uppercase tracking-wider flex items-center justify-between " + (isLight ? "text-slate-900" : "text-slate-200")}>
                  <span>Candidate Variations ({filteredVariations.length})</span>
                  {kibitzerShowArrows && <span className="text-[10px] text-cyan-600 dark:text-cyan-300 font-extrabold">Visual Arrow: Top Line</span>}
                </h4>
                {kibitzerFilterFellBack && (
                  <div className={"p-2.5 rounded-xl border text-[11px] font-bold flex items-center justify-between gap-2 " + (isLight ? "bg-amber-50 border-amber-300 text-amber-900" : "bg-amber-950/30 border-amber-500/40 text-amber-200")}>
                    <span>
                      {kibitzerTagFilter === "brilliant"
                        ? "No sacrifice combinations found in this position. Showing top alternative lines."
                        : `No "${kibitzerTagFilter}" lines found in this position. Showing top alternative lines.`}
                    </span>
                    <button
                      onClick={() => setKibitzerTagFilter("all")}
                      className="px-2 py-1 rounded-lg bg-amber-600 hover:bg-amber-500 text-white font-extrabold whitespace-nowrap cursor-pointer"
                    >
                      Show All
                    </button>
                  </div>
                )}
                {filteredVariations.length === 0 ? (
                  <div className={"p-6 rounded-2xl border text-center text-xs font-bold " + (isLight ? "bg-slate-100 border-slate-300 text-slate-800" : "bg-black/40 border-white/10 text-slate-300")}>
                    Click &quot;Get Advise&quot; or select User Clock Bound to compute alternative paths.
                  </div>
                ) : (
                  <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
                    {filteredVariations.map((v, idx) => {
                      const scoreFormatted = v.is_mate ? "#" + v.mate_in : "" + ((v.score_cp || 0) / 100.0).toFixed(2);
                      const winProbFormatted = (v.win_prob <= 1 ? (v.win_prob * 100).toFixed(1) : v.win_prob.toFixed(1)) + "% Win";
                      return (
                        <div
                          key={idx}
                          className={"p-3.5 rounded-2xl border transition-all flex flex-col gap-2.5 font-mono text-xs shadow-md " + (isLight ? "bg-slate-100 border-slate-300 text-slate-900 hover:border-cyan-500" : "bg-black/50 border-slate-700/80 hover:border-cyan-500/50 text-white")}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="w-6 h-6 rounded-lg bg-cyan-500/20 text-cyan-700 dark:text-cyan-300 flex items-center justify-center font-black text-[11px] border border-cyan-500/40">
                                #{idx + 1}
                              </span>
                              <span className={"font-black text-sm tracking-wide " + (isLight ? "text-slate-950" : "text-white")}>{v.pv_san}</span>
                              <span className="px-2 py-0.5 rounded-lg bg-emerald-500/20 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40 font-extrabold text-xs">
                                {kibitzerDisplayFormat === "win_prob" ? winProbFormatted : kibitzerDisplayFormat === "cp" ? scoreFormatted : `${scoreFormatted} · ${winProbFormatted}`}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <button
                                onClick={() => handleMoveOverride(v.pv_uci, v.pv_san, "KIBITZER")}
                                disabled={isEngineThinking || game.isGameOver()}
                                className="px-2.5 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 active:scale-95 text-white text-xs font-bold flex items-center gap-1 cursor-pointer disabled:opacity-40 shadow-sm"
                                title="Play this variation as move override"
                              >
                                <Play className="w-3.5 h-3.5 fill-current" />
                                <span>Play</span>
                              </button>
                              <button
                                onClick={() => handleSaveKibitzerVariation(v)}
                                className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 active:scale-95 text-white text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-md shadow-cyan-950/40 border border-cyan-400/50"
                                title={"Save to " + KIBITZER_DB_NAME}
                              >
                                <BookmarkPlus className="w-3.5 h-3.5 fill-current" />
                                <span>Save Line</span>
                              </button>
                            </div>
                          </div>
                          <div className={"flex items-center gap-1.5 flex-wrap pt-1 border-t " + (isLight ? "border-slate-200" : "border-white/5")}>
                            {v.tags.map(getTagBadge)}
                            <span className="text-[10px] text-cyan-700 dark:text-cyan-300 ml-auto font-black font-mono">Depth {v.depth} plies</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>)}
            </div>
          )}

          {/* TAB 3: TUTOR COMPANION (Reinforcement Flags) */}
          {rightPanelTab === "tutor" && (
            <div className={"p-5 rounded-3xl " + (isLight ? "bg-white border-slate-300 text-slate-900 shadow-lg" : "bg-[#14171c] border-slate-800 text-white shadow-xl") + " border space-y-4"}>
              {/* Master Tutor Power Toggle Card */}
              <div className={"p-3.5 rounded-2xl border flex items-center justify-between transition-all " + (isTutorEnabled ? (isLight ? "bg-emerald-50 border-emerald-300 shadow-sm" : "bg-emerald-950/30 border-emerald-500/40") : (isLight ? "bg-slate-100 border-slate-300" : "bg-black/40 border-white/10"))}>
                <div className="flex items-center gap-2.5">
                  <div className={"p-2 rounded-xl " + (isTutorEnabled ? "bg-emerald-500/20 text-emerald-400" : "bg-slate-700/40 text-slate-400")}>
                    <GraduationCap className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className={"text-xs font-extrabold uppercase tracking-wider " + (isTutorEnabled ? (isLight ? "text-emerald-900" : "text-emerald-300") : (isLight ? "text-slate-600" : "text-slate-400"))}>
                        Tutor Reinforcement Engine
                      </h2>
                      <span className={"text-[10px] font-black uppercase px-2 py-0.5 rounded-md font-mono " + (isTutorEnabled ? "bg-emerald-500 text-white shadow-sm" : "bg-slate-600 text-slate-200")}>
                        {isTutorEnabled ? "Active" : "Disabled"}
                      </span>
                    </div>
                    <p className={"text-[11px] font-medium " + (isLight ? "text-slate-700" : "text-slate-300")}>
                      {isTutorEnabled
                        ? `Real-time blunder detection & coaching overlay (Logs to ${TUTOR_DB_NAME})`
                        : "Tutor is turned off. Play proceeds without coaching interrupts or overlays."}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setIsTutorSettingsOpen(true)}
                    className={"p-2 rounded-xl border text-xs font-bold transition-all cursor-pointer " + (isLight ? "bg-slate-100 hover:bg-slate-200 text-slate-900 border-slate-300" : "bg-slate-800 hover:bg-slate-700 text-white border-white/10")}
                    title="Tutor Options & Coaching Sensitivity Settings"
                  >
                    <Settings className="w-3.5 h-3.5 text-emerald-500" />
                  </button>
                  {/* Toggle Switch */}
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isTutorEnabled}
                      onChange={(e) => {
                        const val = e.target.checked;
                        setIsTutorEnabled(val);
                        if (!val) setActiveTutorFlag(null);
                      }}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
                  </label>
                </div>
              </div>

              {/* Tutor Engine & Interrupt Mode */}
              <div className="space-y-3 text-xs">
                <div className="space-y-1">
                  <label className={"text-[11px] font-extrabold " + (isLight ? "text-slate-900" : "text-slate-200")}>Tutor Engine:</label>
                  <select
                    value={tutorEngine}
                    onChange={(e) => setTutorEngine(e.target.value)}
                    className={"w-full " + (isLight ? "bg-slate-100 border-slate-300 text-slate-950 font-bold" : "bg-black/60 border-white/20 text-white font-bold") + " border rounded-xl px-2.5 py-2 text-xs outline-none cursor-pointer"}
                  >
                    {engines.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.icon} {e.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className={"text-[11px] font-extrabold " + (isLight ? "text-slate-900" : "text-slate-200")}>Interrupt Behavior Mode:</label>
                  <div className="grid grid-cols-2 gap-2">
                    <div
                      onClick={() => setTutorInterruptMode("passive_log")}
                      className={"p-2.5 rounded-xl border text-left cursor-pointer transition-all " + (tutorInterruptMode === "passive_log" ? isLight ? "bg-emerald-500/25 border-emerald-600 text-emerald-950 font-extrabold ring-1 ring-emerald-600 shadow-sm" : "bg-emerald-500/20 border-emerald-500 text-emerald-200 font-bold" : isLight ? "bg-slate-100 border-slate-300 text-slate-900 font-bold hover:bg-slate-200" : "bg-black/40 border-white/10 text-slate-300 hover:bg-white/5")}
                    >
                      <div className={"text-xs font-black " + (tutorInterruptMode === "passive_log" && isLight ? "text-emerald-950" : "")}>Passive Log</div>
                      <div className={"text-[10px] leading-tight " + (tutorInterruptMode === "passive_log" && isLight ? "text-emerald-900 font-bold" : isLight ? "text-slate-700 font-medium" : "text-slate-400 font-normal")}>Logs silently in background; play continues uninterrupted.</div>
                    </div>

                    <div
                      onClick={() => setTutorInterruptMode("freeze_on_flag")}
                      className={"p-2.5 rounded-xl border text-left cursor-pointer transition-all " + (tutorInterruptMode === "freeze_on_flag" ? isLight ? "bg-emerald-500/25 border-emerald-600 text-emerald-950 font-extrabold ring-1 ring-emerald-600 shadow-sm" : "bg-emerald-500/20 border-emerald-500 text-emerald-200 font-bold" : isLight ? "bg-slate-100 border-slate-300 text-slate-900 font-bold hover:bg-slate-200" : "bg-black/40 border-white/10 text-slate-300 hover:bg-white/5")}
                    >
                      <div className={"text-xs font-black " + (tutorInterruptMode === "freeze_on_flag" && isLight ? "text-emerald-950" : "")}>Freeze on Flag</div>
                      <div className={"text-[10px] leading-tight " + (tutorInterruptMode === "freeze_on_flag" && isLight ? "text-emerald-900 font-bold" : isLight ? "text-slate-700 font-medium" : "text-slate-400 font-normal")}>Pauses play on blunders/tactics with interactive overlay.</div>
                    </div>
                  </div>
                </div>

                {/* Hint Depth Mode Selector */}
                <div className="space-y-1 pt-1">
                  <label className={"text-[11px] font-extrabold " + (isLight ? "text-slate-900" : "text-slate-200")}>Coaching Guidance Depth:</label>
                  <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                    {[
                      { id: "full", label: "Full Move", desc: "e.g. 1... Nf6" },
                      { id: "piece_only", label: "Piece Only", desc: "Move Knight" },
                      { id: "strategic", label: "Theme Hint", desc: "Tactical Pin" },
                    ].map((h) => (
                      <button
                        key={h.id}
                        onClick={() => setTutorHintDepth(h.id as any)}
                        className={"p-2 rounded-xl border text-center transition-all cursor-pointer " + (tutorHintDepth === h.id ? isLight ? "bg-emerald-500/25 border-emerald-600 text-emerald-950 font-extrabold ring-1 ring-emerald-600 shadow-sm" : "bg-emerald-500/20 border-emerald-500 text-emerald-200 font-bold" : isLight ? "bg-slate-100 border-slate-300 text-slate-900 font-bold hover:bg-slate-200" : "bg-black/40 border-white/10 text-slate-300 hover:bg-white/5")}
                      >
                        <div className={"font-black text-xs " + (tutorHintDepth === h.id && isLight ? "text-emerald-950" : "")}>{h.label}</div>
                        <div className={"text-[9px] font-mono " + (tutorHintDepth === h.id && isLight ? "text-emerald-900 font-extrabold" : isLight ? "text-slate-700 font-bold" : "text-slate-400 font-medium")}>{h.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Status Note */}
              <div className={"p-3 rounded-2xl border text-[11px] leading-relaxed flex items-center justify-between " + (isLight ? "bg-slate-100 border-slate-300 text-slate-900 font-bold shadow-sm" : "bg-black/40 border-white/10 text-slate-200 font-medium")}>
                <span>Threshold: <strong className={isLight ? "text-emerald-800 font-black" : "text-emerald-400 font-black"}>-{tutorBlunderThresholdCp} cp</strong> | Arrow Visualizer: <strong className={isLight ? "text-emerald-800 font-black" : "text-emerald-400 font-black"}>{tutorShowArrow ? "On" : "Off"}</strong></span>
                <button
                  onClick={() => setIsTutorSettingsOpen(true)}
                  className={isLight ? "text-emerald-800 hover:text-emerald-950 text-[11px] font-black underline cursor-pointer" : "text-emerald-400 hover:underline text-[10px] font-bold cursor-pointer"}
                >
                  Configure Options
                </button>
              </div>
            </div>
          )}

          {/* DSD-44: Non-Blocking Floating Action Pill for Staged Variation Override */}
          {stagedVariation && (
            <div className={"p-3 rounded-2xl border shadow-xl flex items-center justify-between gap-3 animate-in fade-in slide-in-from-top-2 " + (isLight ? "bg-indigo-50 border-indigo-200 text-indigo-950" : "bg-indigo-950/80 border-indigo-500/50 text-indigo-100")}>
              <div className="flex items-center gap-2 text-xs font-bold truncate">
                <Sparkles className="w-4 h-4 text-indigo-400 shrink-0" />
                <span className="font-extrabold">{stagedVariation.moveSan}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 uppercase font-mono">
                  {stagedVariation.source} Override
                </span>
                <span className="text-xs opacity-75 hidden sm:inline">Staged variation</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={handleSaveStagedRepertoire}
                  className="px-3 py-1.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-white text-xs font-extrabold rounded-xl shadow-md transition-all flex items-center gap-1.5 cursor-pointer active:scale-95"
                  title="Save this move to your SQLite repertoire book"
                >
                  <BookmarkPlus className="w-3.5 h-3.5" />
                  <span>+ Save to Repertoire</span>
                </button>
                <button
                  onClick={() => setStagedVariation(null)}
                  className="px-2.5 py-1.5 bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white text-xs font-bold rounded-xl border border-white/10 transition-all flex items-center gap-1 cursor-pointer"
                  title="Keep move for this match only without modifying repertoire"
                >
                  <span>This Match Only</span>
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Live Move History List & Centipawn Analysis */}
          <div className={"p-5 rounded-3xl " + (isLight ? "bg-white border-slate-300 text-slate-900 shadow-lg" : "bg-[#14171c] border-slate-800 text-white shadow-xl") + " border space-y-3"}>
            <div className={"flex items-center justify-between w-full border-b pb-2.5 gap-2 flex-wrap " + (isLight ? "border-slate-200" : "border-white/5")}>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => setIsMatchRecordOpen(!isMatchRecordOpen)}
                  className="flex items-center gap-2 cursor-pointer text-left group"
                  title={isMatchRecordOpen ? "Collapse move record" : "Expand move record"}
                >
                  <h3 className={"text-xs font-extrabold uppercase tracking-wider " + (isLight ? "text-slate-900 font-black" : "text-white font-extrabold")}>
                    Match Move Record
                  </h3>
                  <span className={"font-mono text-[11px] px-2 py-0.5 rounded-md font-bold " + (isLight ? "bg-slate-200 text-slate-800" : "bg-slate-800 text-slate-300")}>
                    {moveRecords.length} plies ({Math.ceil(moveRecords.length / 2)} moves)
                  </span>
                </button>

                {/* Compact Book & PGN action buttons adjacent to ply count badge */}
                <div className="flex items-center gap-1.5 ml-1">
                  <button
                    onClick={() => setIsBookPanelOpen(!isBookPanelOpen)}
                    className={`px-2 py-1 rounded-lg border text-xs font-bold transition-all flex items-center gap-1 cursor-pointer ${
                      isBookPanelOpen
                        ? "bg-purple-600 text-white border-purple-400 shadow-sm ring-1 ring-purple-400/30"
                        : isLight
                        ? "bg-slate-100 hover:bg-slate-200 text-purple-700 border-slate-300"
                        : "bg-slate-800 hover:bg-slate-700 text-purple-300 border-white/15"
                    }`}
                    title="Toggle Interactive Opening Book Panel"
                  >
                    <BookOpen className="w-3.5 h-3.5" />
                    <span>Book</span>
                  </button>

                  <button
                    onClick={handleDownloadPgn}
                    disabled={moveHistory.length === 0}
                    className={"px-2 py-1 rounded-lg border text-xs font-bold transition-all flex items-center gap-1 cursor-pointer disabled:opacity-40 " + (
                      isLight
                        ? "bg-slate-100 hover:bg-slate-200 text-blue-700 border-slate-300"
                        : "bg-slate-800 hover:bg-slate-700 text-blue-400 border-white/15"
                    )}
                    title="Download PGN File"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>PGN</span>
                  </button>
                </div>
              </div>

              {/* Checkbox Controls & Far-Right Chevron */}
              <div className="flex items-center gap-3 text-[11px]">
                <label className="flex items-center gap-1.5 cursor-pointer select-none font-bold">
                  <input
                    type="checkbox"
                    checked={showAcpl}
                    onChange={(e) => setShowAcpl(e.target.checked)}
                    className="accent-cyan-500 cursor-pointer rounded w-3.5 h-3.5"
                  />
                  <span className={isLight ? "text-slate-800" : "text-slate-300"}>Show ACPL / Eval</span>
                </label>

                <label className="flex items-center gap-1.5 cursor-pointer select-none font-bold">
                  <input
                    type="checkbox"
                    checked={showMoveQualityBadges}
                    onChange={(e) => setShowMoveQualityBadges(e.target.checked)}
                    className="accent-amber-500 cursor-pointer rounded w-3.5 h-3.5"
                  />
                  <span className={isLight ? "text-slate-800" : "text-slate-300"}>Move Badges (!, ?, ⚡)</span>
                </label>

                <button
                  onClick={() => setIsMatchRecordOpen(!isMatchRecordOpen)}
                  className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors cursor-pointer"
                  title={isMatchRecordOpen ? "Collapse move record" : "Expand move record"}
                >
                  {isMatchRecordOpen ? <ChevronUp className="w-4 h-4 opacity-70" /> : <ChevronDown className="w-4 h-4 opacity-70" />}
                </button>
              </div>
            </div>

            {isMatchRecordOpen && (<>
            {/* Real-Time ACPL & Accuracy Dashboard Bar */}
            {moveRecords.length > 0 && showAcpl && (
              <div className={"grid grid-cols-2 gap-2 p-2 rounded-xl text-xs font-mono " + (isLight ? "bg-slate-100 border border-slate-300" : "bg-black/40 border border-white/10")}>
                <div className="flex items-center justify-between px-2">
                  <span className={isLight ? "text-slate-600 font-bold" : "text-slate-400"}>Player ACPL:</span>
                  <span className="font-extrabold text-emerald-400 font-mono">
                    {userAcpl} cp <span className="text-[10px] text-slate-400">({userAccuracy}%)</span>
                  </span>
                </div>
                <div className="flex items-center justify-between px-2 border-l border-white/10">
                  <span className={isLight ? "text-slate-600 font-bold" : "text-slate-400"}>Engine ACPL:</span>
                  <span className="font-extrabold text-cyan-400 font-mono">
                    {engineAcpl} cp <span className="text-[10px] text-slate-400">({engineAccuracy}%)</span>
                  </span>
                </div>
              </div>
            )}

            {/* Two-Column Move Sheet */}
            <div className={"h-44 overflow-y-auto font-mono text-xs p-2.5 rounded-xl border " + (isLight ? "bg-slate-100 border-slate-300 text-slate-900 shadow-inner" : "bg-black/40 border-white/10 text-white")}>
              {moveRecords.length === 0 ? (
                <div className={"italic text-center py-10 text-xs font-semibold " + (isLight ? "text-slate-600" : "text-slate-400")}>
                  Moves will appear here as the sparring match progresses.
                </div>
              ) : (
                <div className="space-y-1">
                  {/* Render pairs of moves (White & Black) */}
                  {Array.from({ length: Math.ceil(moveRecords.length / 2) }).map((_, moveIdx) => {
                    const whiteRec = moveRecords[moveIdx * 2];
                    const blackRec = moveRecords[moveIdx * 2 + 1];
                    const moveNumber = moveIdx + 1;

                    return (
                      <div key={moveNumber} className={"grid grid-cols-12 items-center gap-1.5 py-1 px-2 rounded-lg transition-colors " + (moveIdx % 2 === 0 ? (isLight ? "bg-slate-200/50" : "bg-white/5") : "bg-transparent")}>
                        <span className={"col-span-2 text-[11px] font-mono font-black " + (isLight ? "text-slate-700" : "text-slate-400")}>
                          {moveNumber}.
                        </span>

                        {/* White Move */}
                        <div className="col-span-5 flex items-center justify-between gap-1">
                          {whiteRec ? (
                            <>
                              <div className="flex items-center gap-1 overflow-hidden">
                                {showMoveQualityBadges && whiteRec.badge && (
                                  <span className={`text-[10px] font-black px-1 py-0.2 rounded font-sans ${getMoveBadgeStyle(whiteRec.tag)}`}>
                                    {whiteRec.badge}
                                  </span>
                                )}
                                <span className={"font-bold text-xs truncate " + (isLight ? "text-slate-950 font-black" : "text-white")}>
                                  {whiteRec.san}
                                </span>
                              </div>
                              {showAcpl && (
                                <span className="text-[10px] text-slate-400 font-mono font-bold">
                                  {whiteRec.eval ? whiteRec.eval : typeof whiteRec.cpLoss === "number" ? `-${whiteRec.cpLoss}cp` : ""}
                                </span>
                              )}
                            </>
                          ) : null}
                        </div>

                        {/* Black Move */}
                        <div className="col-span-5 flex items-center justify-between gap-1">
                          {blackRec ? (
                            <>
                              <div className="flex items-center gap-1 overflow-hidden">
                                {showMoveQualityBadges && blackRec.badge && (
                                  <span className={`text-[10px] font-black px-1 py-0.2 rounded font-sans ${getMoveBadgeStyle(blackRec.tag)}`}>
                                    {blackRec.badge}
                                  </span>
                                )}
                                <span className={"font-bold text-xs truncate " + (isLight ? "text-slate-950 font-black" : "text-white")}>
                                  {blackRec.san}
                                </span>
                              </div>
                              {showAcpl && (
                                <span className="text-[10px] text-slate-400 font-mono font-bold">
                                  {blackRec.eval ? blackRec.eval : typeof blackRec.cpLoss === "number" ? `-${blackRec.cpLoss}cp` : ""}
                                </span>
                              )}
                            </>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            </>)}
          </div>

          {/* ENGINE UCI OUTPUT — 3-Stream Tabbed Terminal Drawer */}
          <div className={"rounded-3xl border overflow-hidden " + (isLight ? "bg-white border-slate-300 text-slate-900 shadow-lg" : "bg-[#14171c] border-slate-800 text-white shadow-xl")}>
            {/* Collapsible header row */}
            <button
              onClick={() => setIsUciDrawerOpen(!isUciDrawerOpen)}
              className={"w-full flex items-center justify-between px-5 py-3.5 text-xs font-extrabold uppercase tracking-wider cursor-pointer " + (isLight ? "text-slate-900" : "text-white")}
            >
              <span className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-400" />
                {activeUciTab === "sparring"
                  ? "Sparring Engine UCI Output"
                  : activeUciTab === "kibitzer"
                  ? "Kibitzer UCI Output"
                  : "Tutor UCI Output"}
              </span>
              {isUciDrawerOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {/* Sub-tab selector — always visible when drawer is open */}
            {isUciDrawerOpen && (
              <div className={"flex items-center gap-1.5 px-4 pb-2 " + (isLight ? "bg-white" : "bg-[#14171c]")}>
                <button
                  onClick={() => setActiveUciTab("sparring")}
                  className={"flex items-center gap-1.5 px-3 py-1 rounded-lg text-[11px] font-extrabold cursor-pointer transition-colors " + (
                    activeUciTab === "sparring"
                      ? "bg-emerald-600 text-white shadow"
                      : isLight ? "bg-slate-100 text-slate-700 hover:bg-slate-200" : "bg-slate-800 text-slate-400 hover:text-white"
                  )}
                >
                  <Swords className="w-3.5 h-3.5" />
                  Sparring Engine
                  <span className={"font-mono px-1.5 py-0.5 rounded text-[10px] " + (activeUciTab === "sparring" ? "bg-white/20 text-white" : isLight ? "bg-slate-200 text-slate-600" : "bg-slate-700 text-slate-300")}>
                    {sparringUciLog.length}
                  </span>
                </button>
                <button
                  onClick={() => setActiveUciTab("kibitzer")}
                  className={"flex items-center gap-1.5 px-3 py-1 rounded-lg text-[11px] font-extrabold cursor-pointer transition-colors " + (
                    activeUciTab === "kibitzer"
                      ? "bg-cyan-600 text-white shadow"
                      : isLight ? "bg-slate-100 text-slate-700 hover:bg-slate-200" : "bg-slate-800 text-slate-400 hover:text-white"
                  )}
                >
                  <Brain className="w-3.5 h-3.5" />
                  Kibitzer
                  <span className={"font-mono px-1.5 py-0.5 rounded text-[10px] " + (activeUciTab === "kibitzer" ? "bg-white/20 text-white" : isLight ? "bg-slate-200 text-slate-600" : "bg-slate-700 text-slate-300")}>
                    {kibitzerUciLog.length}
                  </span>
                </button>
                <button
                  onClick={() => setActiveUciTab("tutor")}
                  className={"flex items-center gap-1.5 px-3 py-1 rounded-lg text-[11px] font-extrabold cursor-pointer transition-colors " + (
                    activeUciTab === "tutor"
                      ? "bg-amber-600 text-white shadow"
                      : isLight ? "bg-slate-100 text-slate-700 hover:bg-slate-200" : "bg-slate-800 text-slate-400 hover:text-white"
                  )}
                >
                  <GraduationCap className="w-3.5 h-3.5" />
                  Tutor
                  <span className={"font-mono px-1.5 py-0.5 rounded text-[10px] " + (activeUciTab === "tutor" ? "bg-white/20 text-white" : isLight ? "bg-slate-200 text-slate-600" : "bg-slate-700 text-slate-300")}>
                    {tutorUciLog.length}
                  </span>
                </button>
              </div>
            )}

            {/* Log content */}
            {isUciDrawerOpen && (
              <div
                ref={terminalScrollRef}
                className={"h-52 overflow-y-auto font-mono text-[11px] p-3 border-t " + (isLight ? "bg-slate-950 border-slate-800 text-slate-200" : "bg-black/80 border-white/10 text-slate-200")}
              >
                {(activeUciTab === "sparring" ? sparringUciLog : activeUciTab === "kibitzer" ? kibitzerUciLog : tutorUciLog).length === 0 ? (
                  <div className={"italic text-center py-8 text-xs " + (isLight ? "text-slate-400" : "text-slate-500")}>
                    {activeUciTab === "sparring"
                      ? "Sparring engine UCI handshake & move telemetry will stream here during the match."
                      : activeUciTab === "kibitzer"
                      ? "Kibitzer variation analysis UCI output will stream here when analysis runs."
                      : "Tutor position evaluation & tactical analysis UCI output will stream here."}
                  </div>
                ) : (
                  (activeUciTab === "sparring" ? sparringUciLog : activeUciTab === "kibitzer" ? kibitzerUciLog : tutorUciLog).map((line, idx) => {
                    let colorClass = "text-slate-300";
                    if (line.startsWith(">>>")) {
                      colorClass = "text-amber-400 font-semibold";
                    } else if (line.startsWith("<<<")) {
                      if (line.includes("bestmove")) {
                        colorClass = "text-emerald-400 font-bold";
                      } else if (line.includes("info")) {
                        colorClass = "text-cyan-300";
                      } else {
                        colorClass = "text-emerald-300";
                      }
                    } else if (line.startsWith("[DeepScout Opening]")) {
                      colorClass = "text-purple-300 font-bold bg-purple-950/40 px-1 py-0.5 rounded inline-block";
                    } else if (line.startsWith("[ERROR]")) {
                      colorClass = "text-rose-400 font-bold bg-rose-950/40 px-1 py-0.5 rounded inline-block";
                    }
                    return (
                      <div key={idx} className={`whitespace-pre-wrap break-all leading-relaxed ${colorClass}`}>
                        {line}
                      </div>
                    );
                  })
                )}
              </div>
            )}
          </div>

        </div>
      </div>

      {/* KIBITZER ADVANCED SETTINGS POPUP MODAL */}
      {isKibitzerSettingsOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-[#181b20] border border-slate-700 w-full max-w-lg rounded-3xl p-6 shadow-2xl space-y-5 text-white">
            <div className="flex items-center justify-between border-b pb-3 border-white/10">
              <div className="flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-cyan-400" />
                <h3 className="font-bold text-sm">Kibitzer Engine &amp; Display Options</h3>
              </div>
              <button onClick={() => setIsKibitzerSettingsOpen(false)} className="p-1 rounded-lg text-slate-400 hover:text-white cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              {/* Hardware Allocation */}
              <div className="p-3.5 rounded-2xl bg-black/40 border border-white/5 space-y-3">
                <h4 className="font-bold text-cyan-300 text-[11px] uppercase tracking-wider flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5" />
                  Engine Hardware &amp; Search Limit Modes
                </h4>

                {/* 3-Way Search Mode Selector */}
                <div className="space-y-1.5 pt-0.5">
                  <label className="text-[11px] font-bold text-slate-300 block">Search Limit Mode:</label>
                  <div className="grid grid-cols-3 gap-2 text-[10px]">
                    {[
                      { id: "depth", label: "Exact Depth", desc: "No time cap (24-50 plies)" },
                      { id: "time", label: "Time Bound", desc: "Clock limit cap" },
                      { id: "both", label: "Hybrid", desc: "Depth + Time" },
                    ].map((m) => (
                      <button
                        key={m.id}
                        onClick={() => setKibitzerSearchMode(m.id as any)}
                        className={"p-2 rounded-xl border text-center transition-all cursor-pointer " + (kibitzerSearchMode === m.id ? "bg-cyan-500/30 border-cyan-400 text-cyan-200 font-extrabold shadow-sm" : "bg-black/40 border-white/10 text-slate-300 hover:text-white")}
                      >
                        <div className="font-bold">{m.label}</div>
                        <div className="text-[9px] opacity-70 font-mono">{m.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                      <span>Threads:</span>
                      <span className="text-cyan-400 font-bold">{kibitzerThreads}</span>
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="8"
                      value={kibitzerThreads}
                      onChange={(e) => setKibitzerThreads(Number(e.target.value))}
                      className="w-full accent-cyan-500 cursor-pointer"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                      <span>Hash Size (MB):</span>
                      <span className="text-cyan-400 font-bold">{kibitzerHashMb} MB</span>
                    </div>
                    <input
                      type="range"
                      min="16"
                      max="512"
                      step="16"
                      value={kibitzerHashMb}
                      onChange={(e) => setKibitzerHashMb(Number(e.target.value))}
                      className="w-full accent-cyan-500 cursor-pointer"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div className="space-y-1">
                    <div className="flex justify-between items-center text-[11px] text-slate-400 font-mono">
                      <span className={kibitzerSearchMode === "time" ? "opacity-40" : ""}>Target Depth:</span>
                      <input
                        type="number"
                        min="1"
                        max="50"
                        disabled={kibitzerSearchMode === "time"}
                        value={kibitzerDepth}
                        onChange={(e) => setKibitzerDepth(Math.max(1, Math.min(50, Number(e.target.value))))}
                        className="w-14 bg-slate-900 border border-slate-700 text-cyan-400 font-bold rounded px-1 text-right text-xs disabled:opacity-40"
                      />
                    </div>
                    <input
                      type="range"
                      min="1"
                      max="50"
                      disabled={kibitzerSearchMode === "time"}
                      value={kibitzerDepth}
                      onChange={(e) => setKibitzerDepth(Number(e.target.value))}
                      className="w-full accent-cyan-500 cursor-pointer disabled:opacity-40"
                    />
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                      <span className={kibitzerSearchMode === "depth" ? "opacity-40" : ""}>Time Limit:</span>
                      <span className="text-cyan-400 font-bold">{kibitzerTimeLimitMs} ms</span>
                    </div>
                    <input
                      type="range"
                      min="100"
                      max="5000"
                      step="100"
                      disabled={kibitzerSearchMode === "depth"}
                      value={kibitzerTimeLimitMs}
                      onChange={(e) => setKibitzerTimeLimitMs(Number(e.target.value))}
                      className="w-full accent-cyan-500 cursor-pointer disabled:opacity-40"
                    />
                  </div>
                </div>
              </div>

              {/* Display & Overlay Options */}
              <div className="p-3.5 rounded-2xl bg-black/40 border border-white/5 space-y-3">
                <h4 className="font-bold text-cyan-300 text-[11px] uppercase tracking-wider flex items-center gap-1.5">
                  <Layers className="w-3.5 h-3.5" />
                  Presentation &amp; Visual Overlays
                </h4>

                <div className="space-y-2">
                  <label className="text-[11px] text-slate-400 font-semibold block">Evaluation Format:</label>
                  <div className="grid grid-cols-3 gap-2 text-[10px]">
                    {[
                      { id: "both", label: "Hybrid (+1.25 • 65%)" },
                      { id: "cp", label: "Centipawns (+1.25)" },
                      { id: "win_prob", label: "Win % (65%)" },
                    ].map((fmt) => (
                      <button
                        key={fmt.id}
                        onClick={() => setKibitzerDisplayFormat(fmt.id as any)}
                        className={"p-2 rounded-xl border text-center transition-all cursor-pointer " + (kibitzerDisplayFormat === fmt.id ? "bg-cyan-500/20 border-cyan-500 text-cyan-200 font-bold" : "bg-black/30 border-white/5 text-slate-400")}
                      >
                        {fmt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1">
                  <span className="text-slate-300 text-[11px]">Show Graphical Board Arrows for Candidate Lines:</span>
                  <input
                    type="checkbox"
                    checked={kibitzerShowArrows}
                    onChange={(e) => setKibitzerShowArrows(e.target.checked)}
                    className="accent-cyan-500 cursor-pointer"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-300 text-[11px]">Auto-Save Variations into {KIBITZER_DB_NAME}:</span>
                  <input
                    type="checkbox"
                    checked={kibitzerAutoSave}
                    onChange={(e) => setKibitzerAutoSave(e.target.checked)}
                    className="accent-cyan-500 cursor-pointer"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
              <button
                onClick={() => {
                  setIsKibitzerSettingsOpen(false);
                  handleGetAdvise(undefined, {
                    engine: kibitzerEngine,
                    depth: kibitzerDepth,
                    multipv: kibitzerMultipv,
                    searchMode: kibitzerSearchMode,
                    timeLimitMs: kibitzerTimeLimitMs,
                    threads: kibitzerThreads,
                    hashMb: kibitzerHashMb,
                  });
                }}
                className="px-5 py-2.5 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-xl text-xs font-extrabold shadow-lg transition-all cursor-pointer active:scale-95"
              >
                Apply &amp; Re-Analyze
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TUTOR ADVANCED SETTINGS POPUP MODAL */}
      {isTutorSettingsOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-[#181b20] border border-slate-700 w-full max-w-lg rounded-3xl p-6 shadow-2xl space-y-5 text-white">
            <div className="flex items-center justify-between border-b pb-3 border-white/10">
              <div className="flex items-center gap-2">
                <GraduationCap className="w-5 h-5 text-emerald-400" />
                <h3 className="font-bold text-sm">Tutor Coaching &amp; Sensitivity Options</h3>
              </div>
              <button onClick={() => setIsTutorSettingsOpen(false)} className="p-1 rounded-lg text-slate-400 hover:text-white cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4 text-xs">
              {/* Master Toggle */}
              <div className="p-3.5 rounded-2xl bg-emerald-950/30 border border-emerald-500/30 flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold text-emerald-300">Tutor Reinforcement System</div>
                  <div className="text-[11px] text-slate-300">Enable real-time blunder detection and overlay interrupts</div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isTutorEnabled}
                    onChange={(e) => {
                      const val = e.target.checked;
                      setIsTutorEnabled(val);
                      if (!val) setActiveTutorFlag(null);
                    }}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600"></div>
                </label>
              </div>

              {/* Sensitivities */}
              <div className="p-3.5 rounded-2xl bg-black/40 border border-white/5 space-y-3">
                <h4 className="font-bold text-emerald-300 text-[11px] uppercase tracking-wider">
                  Detection Sensitivities
                </h4>

                <div className="space-y-1">
                  <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                    <span>Blunder Alert Threshold:</span>
                    <span className="text-emerald-400 font-bold">-{tutorBlunderThresholdCp} cp</span>
                  </div>
                  <input
                    type="range"
                    min="100"
                    max="350"
                    step="25"
                    value={tutorBlunderThresholdCp}
                    onChange={(e) => setTutorBlunderThresholdCp(Number(e.target.value))}
                    className="w-full accent-emerald-500 cursor-pointer"
                  />
                  <div className="flex justify-between text-[9px] text-slate-500 font-mono">
                    <span>Strict (-100 cp)</span>
                    <span>Standard (-150 cp)</span>
                    <span>Forgiving (-350 cp)</span>
                  </div>
                </div>

                <div className="space-y-1 pt-1">
                  <div className="flex justify-between text-[11px] text-slate-400 font-mono">
                    <span>Mistake Warning Threshold:</span>
                    <span className="text-emerald-400 font-bold">-{tutorMistakeThresholdCp} cp</span>
                  </div>
                  <input
                    type="range"
                    min="50"
                    max="150"
                    step="25"
                    value={tutorMistakeThresholdCp}
                    onChange={(e) => setTutorMistakeThresholdCp(Number(e.target.value))}
                    className="w-full accent-emerald-500 cursor-pointer"
                  />
                </div>
              </div>

              {/* Coaching & Overlay Modes */}
              <div className="p-3.5 rounded-2xl bg-black/40 border border-white/5 space-y-3">
                <h4 className="font-bold text-emerald-300 text-[11px] uppercase tracking-wider">
                  Coaching Hints &amp; Visuals
                </h4>

                <div className="flex items-center justify-between">
                  <span className="text-slate-300 text-[11px]">Alert on Missed Tactical Shots / Sacrifices:</span>
                  <input
                    type="checkbox"
                    checked={tutorAlertTactics}
                    onChange={(e) => setTutorAlertTactics(e.target.checked)}
                    className="accent-emerald-500 cursor-pointer"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-300 text-[11px]">Only evaluate player moves:</span>
                  <input
                    type="checkbox"
                    checked={tutorPlayerMovesOnly}
                    onChange={(e) => setTutorPlayerMovesOnly(e.target.checked)}
                    className="accent-emerald-500 cursor-pointer"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-300 text-[11px]">Suppress alerts while decisively winning (mate / +6.00):</span>
                  <input
                    type="checkbox"
                    checked={tutorSuppressWhenWinning}
                    onChange={(e) => setTutorSuppressWhenWinning(e.target.checked)}
                    className="accent-emerald-500 cursor-pointer"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-slate-300 text-[11px]">Show Graphical Arrow on Suggested Move:</span>
                  <input
                    type="checkbox"
                    checked={tutorShowArrow}
                    onChange={(e) => setTutorShowArrow(e.target.checked)}
                    className="accent-emerald-500 cursor-pointer"
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
              <button
                onClick={() => setIsTutorSettingsOpen(false)}
                className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl text-xs font-bold shadow-lg transition-all cursor-pointer"
              >
                Apply &amp; Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add UCI Engine Modal */}
      {isAddEngineModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50 animate-in fade-in">
          <div className="bg-[#181b20] border border-slate-700 w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-3xl p-6 shadow-2xl space-y-5 text-white">
            <div className="flex items-center justify-between border-b pb-3 border-white/10">
              <div className="flex items-center gap-2">
                <Cpu className="w-5 h-5 text-rose-500" />
                <div>
                  <h3 className="font-bold text-sm">Register Custom UCI Engine</h3>
                  <span className="text-[10px] font-mono text-slate-400">
                    Inspect all options printed by engine &amp; configure profile parameters
                  </span>
                </div>
              </div>
              <button onClick={() => setIsAddEngineModalOpen(false)} className="p-1 rounded-lg text-slate-400 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div>
                <label className="text-[11px] font-semibold text-slate-300 block mb-1">Engine Binary Path (.exe):</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="C:\Engines\my_engine.exe"
                    value={newEnginePath}
                    onChange={(e) => setNewEnginePath(e.target.value)}
                    className="flex-1 px-3 py-2 bg-black/40 border border-white/10 rounded-xl text-xs font-mono text-white outline-none focus:border-rose-500"
                  />
                  <button
                    onClick={handleBrowseEngine}
                    disabled={isBrowsingEngine}
                    className="px-3.5 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer border border-white/10"
                  >
                    <FolderOpen className="w-3.5 h-3.5 text-cyan-400" />
                    Browse
                  </button>
                  <button
                    onClick={() => handleTestEnginePath(newEnginePath)}
                    disabled={isBrowsingEngine || !newEnginePath.trim()}
                    className="px-3.5 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold flex items-center gap-1.5 cursor-pointer shadow-md disabled:opacity-50"
                  >
                    <Zap className="w-3.5 h-3.5" />
                    Test UCI
                  </button>
                </div>
              </div>

              <div>
                <label className="text-[11px] font-semibold text-slate-300 block mb-1">Display Name:</label>
                <input
                  type="text"
                  placeholder="Engine Name"
                  value={newEngineName}
                  onChange={(e) => setNewEngineName(e.target.value)}
                  className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-xl text-xs text-white outline-none focus:border-rose-500"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[11px] font-semibold text-slate-300 block mb-1">Elo Rating:</label>
                  <input
                    type="text"
                    value={newEngineElo}
                    onChange={(e) => setNewEngineElo(e.target.value)}
                    className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-xl text-xs text-white outline-none focus:border-rose-500"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-slate-300 block mb-1">Icon:</label>
                  <input
                    type="text"
                    value={newEngineIcon}
                    onChange={(e) => setNewEngineIcon(e.target.value)}
                    className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-xl text-xs text-white outline-none focus:border-rose-500 text-center"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-slate-300 block mb-1">Style:</label>
                  <input
                    type="text"
                    value={newEngineStyle}
                    onChange={(e) => setNewEngineStyle(e.target.value)}
                    className="w-full px-3 py-2 bg-black/40 border border-white/10 rounded-xl text-xs text-white outline-none focus:border-rose-500"
                  />
                </div>
              </div>

              {uciTestError && (
                <div className="p-2.5 rounded-xl bg-rose-500/20 border border-rose-500/30 text-rose-300 text-xs font-mono">
                  {uciTestError}
                </div>
              )}

              {/* Native UCI Protocol Options Printed by Engine */}
              {testedUciOptions && Object.keys(testedUciOptions).length > 0 && (
                <div className="space-y-2 pt-2 border-t border-white/10">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-extrabold flex items-center gap-1.5 text-cyan-400">
                      <Sliders className="w-4 h-4 text-cyan-400" />
                      All UCI Protocol Options ({Object.keys(testedUciOptions).length} detected):
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">
                      Adjust parameters below — settings will stick to this bot
                    </span>
                  </div>

                  <UciOptionsInspector
                    optionsMap={testedUciOptions}
                    currentValues={newEngineCustomOptions}
                    onChange={(key, val) =>
                      setNewEngineCustomOptions((prev) => ({ ...prev, [key]: val }))
                    }
                    isLight={false}
                  />
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/10">
              <button
                onClick={() => setIsAddEngineModalOpen(false)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                onClick={handleRegisterEngine}
                disabled={!newEnginePath.trim() || !newEngineName.trim()}
                className="px-5 py-2 bg-rose-600 hover:bg-rose-500 text-white rounded-xl text-xs font-bold shadow-lg transition-all cursor-pointer disabled:opacity-50"
              >
                Save Engine
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
