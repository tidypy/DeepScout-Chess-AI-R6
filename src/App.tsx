import { useEffect, useState, useRef } from "react";
import { Wing } from "./components/layout/Wing";
import { DesktopMenu } from "./components/layout/DesktopMenu";
import { ResponsiveChessboard, AnalysisGameStats, QualityFilterKey } from "./components/chessboard/ResponsiveChessboard";
import { OpeningBookPanel } from "./features/analysis/OpeningBookPanel";
import { GameStatsPanel } from "./features/analysis/GameStatsPanel";
import { DatabaseBrowserView } from "./features/database/browser/DatabaseBrowserView";
import { AIGrandmasterView } from "./features/ai_grandmaster/AIGrandmasterView";
import { EnginesView } from "./features/engines/EnginesView";
import { AskGrandmasterAction } from "./features/ai_grandmaster/AskGrandmasterAction";
import { SparView } from "./features/sparring/SparView";
import { BookBuilderView } from "./features/book_builder/BookBuilderView";
import { ThemeCustomizer } from "./components/theme/ThemeCustomizer";
import { Tooltip } from "./components/common/Tooltip";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiHttpError, fetchGame, fetchGamesList, fetchDatabases, ensureDefaultDatabase, fetchEngineRoles, updateEngineRole, AnalysisPresetKey } from "./lib/api";
import { AnalyzerQuickSettingsModal, ANALYZER_STORAGE_KEY, PRESET_DEFINITIONS } from "./features/analysis/AnalyzerQuickSettingsModal";
import {
  UXTheme,
  BoardTheme,
  CustomThemeSettings,
  loadSavedUXTheme,
  loadSavedBoardTheme,
  loadCustomSettings,
} from "./lib/theme";
import { useClickLogger } from "./lib/clickLogger";
import {
  Sparkles,
  RefreshCw,
  Terminal,
  Copy,
  Check,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Settings,
} from "lucide-react";

function parseStoredGameId(raw: string | null): number | string {
  if (!raw) return 1;
  const trimmed = raw.trim();
  if (!trimmed) return 1;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
}

function MainApp() {
  const { logAction, isLogConsoleOpen, setIsLogConsoleOpen } = useClickLogger();
  const queryClient = useQueryClient();

  // Active Workspace / Tab (persisted across reloads)
  const [activeView, setActiveView] = useState<string>(
    () => localStorage.getItem("deepscout_last_active_view") || "Analysis"
  );

  useEffect(() => {
    localStorage.setItem("deepscout_last_active_view", activeView);
  }, [activeView]);

  // DSD-51: Global cross-component navigation event listener.
  // Child components dispatch window.dispatchEvent(new CustomEvent("deepscout:navigate", { detail: "Analysis" }))
  // to trigger a tab switch without requiring prop drilling into App.tsx.
  useEffect(() => {
    const handleNavigation = (e: Event) => {
      const customEvent = e as CustomEvent<string | { view: string; db?: string; targetId?: string | number; autoAnalyze?: boolean }>;
      const detail = customEvent.detail;
      const targetView = typeof detail === "string" ? detail : detail?.view;
      if (targetView) {
        setActiveView(targetView);
        localStorage.setItem("deepscout_last_active_view", targetView);
      }
      if (targetView === "Analysis") {
        const targetId =
          (typeof detail === "object" && detail?.targetId) ||
          localStorage.getItem("deepscout_analysis_target_id");
        if (targetId) {
          const targetDb = (typeof detail === "object" && detail?.db) || "Sparring_Games.sqlite";
          const parsedTargetId = parseStoredGameId(String(targetId));
          setActiveGameDb(targetDb);
          setGameId(parsedTargetId);
          localStorage.setItem("deepscout_last_opened_db", targetDb);
          localStorage.setItem("deepscout_last_game_id", String(parsedTargetId));
          localStorage.removeItem("deepscout_analysis_target_id");
          if (typeof detail === "object" && detail?.autoAnalyze) {
            setPendingAutoAnalyze({ db: targetDb, gameId: parsedTargetId, nonce: Date.now() });
          } else {
            setPendingAutoAnalyze(null);
          }
        }
      }
    };
    const handleDbHealed = () => {
      queryClient.invalidateQueries({ queryKey: ["databases"] });
      queryClient.invalidateQueries({ queryKey: ["browserGames"] });
      queryClient.invalidateQueries({ queryKey: ["game"] });
      queryClient.invalidateQueries({ queryKey: ["fitnessAudit"] });
    };
    window.addEventListener("deepscout:navigate", handleNavigation);
    window.addEventListener("deepscout:db-healed", handleDbHealed);
    return () => {
      window.removeEventListener("deepscout:navigate", handleNavigation);
      window.removeEventListener("deepscout:db-healed", handleDbHealed);
    };
  }, [queryClient]);

  // Game Selection
  const [gameId, setGameId] = useState<number | string>(() => {
    const targetAnalysisId = localStorage.getItem("deepscout_analysis_target_id");
    if (targetAnalysisId) return parseStoredGameId(targetAnalysisId);
    const stored = localStorage.getItem("deepscout_last_game_id");
    if (!stored) return 1;
    const trimmed = stored.trim();
    return /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed;
  });
  const [activeGameDb, setActiveGameDb] = useState<string>(() => {
    if (localStorage.getItem("deepscout_analysis_target_id")) {
      return "Sparring_Games.sqlite";
    }
    return localStorage.getItem("deepscout_last_opened_db") || "Sparring_Games.sqlite";
  });
  const [currentBoardFen, setCurrentBoardFen] = useState<string>("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
  const [analysisStats, setAnalysisStats] = useState<AnalysisGameStats | undefined>(undefined);
  const [qualityFilter, setQualityFilter] = useState<QualityFilterKey | null>(null);
  const [runAnalysisSignal, setRunAnalysisSignal] = useState(0);
  const [evalDepth, setEvalDepth] = useState<number>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(ANALYZER_STORAGE_KEY) || "null");
      if (saved && typeof saved.depth === "number") return saved.depth;
    } catch {}
    return 18;
  });
  const [analyzerPreset, setAnalyzerPreset] = useState<AnalysisPresetKey>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(ANALYZER_STORAGE_KEY) || "null");
      if (saved && typeof saved.preset === "string") return saved.preset as AnalysisPresetKey;
    } catch {}
    return "deep";
  });
  const [isAnalyzerGearOpen, setIsAnalyzerGearOpen] = useState<boolean>(false);
  const [pendingAutoAnalyze, setPendingAutoAnalyze] = useState<{ db: string; gameId: string | number; nonce: number } | null>(null);
  const [liveEvalInfo, setLiveEvalInfo] = useState<{ evalStr: string; mainLine: string }>({ evalStr: "+0.00", mainLine: "" });
  const { data: engineRolesData } = useQuery({
    queryKey: ["engineRoles"],
    queryFn: fetchEngineRoles,
  });
  useEffect(() => {
    const a = engineRolesData?.roles?.analyzer;
    if (!a) return;
    setAnalyzerPreset((a.preset as AnalysisPresetKey) || "deep");
    if (typeof a.depth === "number") setEvalDepth(a.depth);
    try {
      localStorage.setItem(ANALYZER_STORAGE_KEY, JSON.stringify(a));
    } catch {}
  }, [engineRolesData]);
  const [evalState, setEvalState] = useState<{ running: boolean; progress: { current: number; total: number } | null }>({
    running: false,
    progress: null,
  });

  // Theme Management
  const [currentUXTheme, setCurrentUXTheme] = useState<UXTheme>(loadSavedUXTheme);
  const [currentBoardTheme, setCurrentBoardTheme] = useState<BoardTheme>(loadSavedBoardTheme);
  const [customSettings, setCustomSettings] = useState<CustomThemeSettings>(loadCustomSettings);
  const [isThemeModalOpen, setIsThemeModalOpen] = useState<boolean>(false);
  const [themeModalTab, setThemeModalTab] = useState<"ux" | "board" | "custom">("ux");
  const [sparTargetEngineId, setSparTargetEngineId] = useState<string | null>(null);

  // Engine UCI Log & Options State (Replaces raw SSE stream)
  const [engineUciLogs, setEngineUciLogs] = useState<string[]>([
    ">> uci",
    "<< id name Patricia 4.0",
    "<< id author Adam Kulju",
    ">> setoption name Threads value 1",
    ">> setoption name Hash value 64",
    ">> isready",
    "<< readyok",
    "[STATUS] Engine initialized & ready for position analysis",
  ]);
  const [engineUciOptions, setEngineUciOptions] = useState<Record<string, any>>({
    "Engine": "Patricia 4.0",
    "Author": "Adam Kulju",
    "Threads": 1,
    "Hash (MB)": 64,
    "Multi-PV": 3,
    "Status": "Ready",
  });
  const [uciViewTab, setUciViewTab] = useState<"stream" | "options">("stream");
  const [uciCopied, setUciCopied] = useState(false);

  // Query Available Databases
  const { data: dbList } = useQuery({
    queryKey: ["databases"],
    queryFn: fetchDatabases,
  });

  // Fetch Game Query (distinguish 404 Not Found from genuine Sidecar disconnect)
  const {
    data: gameData,
    isLoading,
    isError,
    error: gameError,
    refetch,
  } = useQuery({
    queryKey: ["game", gameId, activeGameDb],
    queryFn: () => fetchGame(gameId, activeGameDb),
    retry: (failureCount, err) => {
      if (err instanceof ApiHttpError && err.status === 404) return false;
      return failureCount < 1;
    },
  });

  const [isActiveDbEmpty, setIsActiveDbEmpty] = useState(false);
  const autoRecoverKeyRef = useRef<string>("");

  const isGameNotFound =
    isError && gameError instanceof ApiHttpError && gameError.status === 404;

  // Auto-recover seamlessly if stored/requested gameId was deleted or ROWID 1 has a gap
  useEffect(() => {
    if (!isGameNotFound) {
      setIsActiveDbEmpty(false);
      return;
    }
    const key = `${activeGameDb}::${String(gameId)}`;
    if (autoRecoverKeyRef.current === key) return;
    autoRecoverKeyRef.current = key;

    let cancelled = false;
    fetchGamesList({ page: 1, page_size: 1, db_name: activeGameDb })
      .then((res) => {
        if (cancelled) return;
        const first = res?.games?.[0];
        if (first && String(first.id) !== String(gameId)) {
          setIsActiveDbEmpty(false);
          setGameId(first.id);
          localStorage.setItem("deepscout_last_game_id", String(first.id));
          logActionRef.current(
            "SYSTEM",
            `Auto-recovered Analysis target in ${activeGameDb}: #${gameId} -> #${first.id}`
          );
        } else if (!first) {
          setIsActiveDbEmpty(true);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [isGameNotFound, activeGameDb, gameId]);

  // Keep fresh ref to logAction to prevent stale closures
  const logActionRef = useRef(logAction);
  useEffect(() => {
    logActionRef.current = logAction;
  });

  // --- Analysis DB Persistence & Self-Healing Fallback ---
  // Runs once when dbList resolves. Validates stored db against live list,
  // falls back to Sparring_Games.sqlite, and self-heals if Sparring_Games.sqlite is also absent.
  useEffect(() => {
    if (!dbList || dbList.length === 0) return; // Wait for sidecar to respond

    const targetAnalysisId = localStorage.getItem("deepscout_analysis_target_id");
    if (targetAnalysisId) {
      setActiveGameDb("Sparring_Games.sqlite");
      setGameId(parseStoredGameId(targetAnalysisId));
      localStorage.setItem("deepscout_last_opened_db", "Sparring_Games.sqlite");
      localStorage.setItem("deepscout_last_game_id", targetAnalysisId);
      localStorage.removeItem("deepscout_analysis_target_id");
      logActionRef.current("SYSTEM", `Hydrated post-match analysis target: Sparring_Games.sqlite game ${targetAnalysisId}`);
      return;
    }

    const storedDb = localStorage.getItem("deepscout_last_opened_db");
    const storedRaw = localStorage.getItem("deepscout_last_game_id");
    const normalizedRaw = storedRaw ? storedRaw.trim() : "";
    const storedGameId = parseStoredGameId(normalizedRaw);

    const inList = (name: string) => dbList.some((d) => d.name === name);

    if (storedDb && inList(storedDb)) {
      // Primary: restore last session exactly
      setActiveGameDb(storedDb);
      setGameId(storedGameId);
      logActionRef.current("SYSTEM", `Restored last session: ${storedDb} game #${storedGameId}`);
      return;
    }

    if (inList("Sparring_Games.sqlite")) {
      // Fallback 1: Sparring_Games.sqlite exists — mount it, reset game to 1
      setActiveGameDb("Sparring_Games.sqlite");
      setGameId(1);
      localStorage.setItem("deepscout_last_opened_db", "Sparring_Games.sqlite");
      localStorage.setItem("deepscout_last_game_id", "1");
      logActionRef.current("SYSTEM", "Fallback 1: mounted Sparring_Games.sqlite (last_db not found)");
      return;
    }

    // Fallback 2 (Self-Healing): neither stored db nor Sparring_Games.sqlite present
    // Call backend to create an empty Sparring_Games.sqlite, then re-invalidate dbList
    ensureDefaultDatabase()
      .then(() => {
        setActiveGameDb("Sparring_Games.sqlite");
        setGameId(1);
        localStorage.setItem("deepscout_last_opened_db", "Sparring_Games.sqlite");
        localStorage.setItem("deepscout_last_game_id", "1");
        logActionRef.current("SYSTEM", "Fallback 2: self-healed — created Sparring_Games.sqlite via backend");
        window.dispatchEvent(new CustomEvent("deepscout:db-healed"));
      })
      .catch((err) => {
        logActionRef.current("ERROR", "Self-heal failed — could not create Sparring_Games.sqlite", String(err));
      });
  }, [dbList]); // eslint-disable-line react-hooks/exhaustive-deps

  // A move-quality filter only makes sense for the game it was set on
  useEffect(() => {
    setQualityFilter(null);
  }, [gameId, activeGameDb]);

  const handleOpenTheme = (tab: "ux" | "board" | "custom") => {
    setThemeModalTab(tab);
    setIsThemeModalOpen(true);
  };

  const isLight = currentUXTheme.mode === "light";

  return (
    <div
      className={`flex h-screen w-full font-sans overflow-hidden transition-colors duration-200 ${
        customSettings.uxMode === "custom"
          ? "text-slate-100"
          : `${currentUXTheme.bg} ${currentUXTheme.text}`
      }`}
      style={
        customSettings.uxMode === "custom"
          ? { backgroundColor: customSettings.uxBg, color: customSettings.uxText }
          : undefined
      }
    >
      {/* Left Wing Navigation */}
      <Wing
        activeView={activeView}
        onSelectView={(view) => {
          setActiveView(view);
          logAction("NAV", `Selected view: ${view}`);
        }}
        onOpenThemeCustomizer={handleOpenTheme}
        onToggleDebugConsole={() => setIsLogConsoleOpen(!isLogConsoleOpen)}
        isConsoleOpen={isLogConsoleOpen}
        uxTheme={currentUXTheme}
      />

      {/* Main Content Area */}
      <div className="flex-grow flex flex-col min-w-0 h-full overflow-hidden">
        {/* Top Desktop Menu */}
        <DesktopMenu
          activeView={activeView}
          onSelectView={setActiveView}
          currentUXTheme={currentUXTheme}
          currentBoardTheme={currentBoardTheme}
          onOpenThemeCustomizer={handleOpenTheme}
        />

        {/* Workspace Content */}
        <div className="flex-grow p-4 md:p-6 overflow-hidden flex flex-col gap-4 min-h-0">
          {activeView === "Analysis" || activeView === "Play" ? (
            <div className="flex-grow flex flex-col lg:flex-row gap-6 overflow-hidden min-h-0">
              {/* Main Board View */}
              <div className="flex-grow h-full min-h-0">
                {isLoading ? (
                  <div
                    className={`h-full flex items-center justify-center rounded-3xl border animate-pulse ${
                      isLight
                        ? "bg-white border-slate-200 text-slate-500"
                        : "bg-slate-900/60 border-slate-800 text-slate-400"
                    }`}
                  >
                    <div className="flex flex-col items-center gap-3">
                      <RefreshCw className="w-8 h-8 animate-spin text-emerald-500" />
                      <span className="font-mono text-sm font-semibold">
                        Loading Game from Python Core...
                      </span>
                    </div>
                  </div>
                ) : isGameNotFound ? (
                  <div
                    className={`h-full flex items-center justify-center rounded-3xl border p-6 ${
                      isLight
                        ? "bg-amber-50 border-amber-200 text-amber-950"
                        : "bg-slate-900/80 border-amber-800/40 text-amber-200"
                    }`}
                  >
                    <div className="text-center space-y-3">
                      <div className="font-bold text-base">
                        {isActiveDbEmpty
                          ? `No Games in ${activeGameDb} Yet`
                          : `Game #${gameId} Not Found in ${activeGameDb}`}
                      </div>
                      <p className="text-xs opacity-80 max-w-sm">
                        {isActiveDbEmpty
                          ? "This database is currently empty. Play a Sparring match or switch databases from the panel on the right."
                          : "This game ID may have been purged or moved. Load the first available game in this database or pick another database."}
                      </p>
                      <div className="flex items-center justify-center gap-2">
                        {!isActiveDbEmpty && (
                          <button
                            onClick={() => {
                              autoRecoverKeyRef.current = "";
                              refetch();
                            }}
                            className="px-4 py-2 text-xs font-bold bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl transition-colors shadow-sm cursor-pointer"
                          >
                            Load First Game
                          </button>
                        )}
                        <button
                          onClick={() => setActiveView("Spar")}
                          className="px-4 py-2 text-xs font-bold bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded-xl transition-colors shadow-sm cursor-pointer"
                        >
                          Start Sparring Match
                        </button>
                      </div>
                    </div>
                  </div>
                ) : isError ? (
                  <div
                    className={`h-full flex items-center justify-center rounded-3xl border p-6 ${
                      isLight
                        ? "bg-rose-50 border-rose-200 text-rose-950"
                        : "bg-slate-900/80 border-rose-900/40 text-rose-300"
                    }`}
                  >
                    <div className="text-center space-y-3">
                      <div className="font-bold text-base">Backend Sidecar Disconnected</div>
                      <p className="text-xs opacity-80 max-w-sm">
                        Could not reach http://127.0.0.1:8000. Ensure the Python sidecar is running.
                      </p>
                      {gameError instanceof Error && gameError.message && (
                        <p className="text-[11px] font-mono opacity-70 max-w-sm mx-auto">
                          {gameError.message}
                        </p>
                      )}
                      <Tooltip content="Retry fetching game data">
                        <button
                          onClick={() => refetch()}
                          className="px-4 py-2 text-xs font-bold bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 rounded-xl transition-colors shadow-sm cursor-pointer"
                        >
                          Retry Connection
                        </button>
                      </Tooltip>
                    </div>
                  </div>
                ) : (
                    <ResponsiveChessboard
                      pgn={gameData?.pgn}
                      initialFen={gameData?.initial_fen}
                      gameId={gameId}
                      dbName={activeGameDb}
                      onLiveEvalChange={setLiveEvalInfo}
                      analyzerPreset={analyzerPreset}
                      pendingAutoAnalyze={pendingAutoAnalyze}
                      onConsumeAutoAnalyze={() => setPendingAutoAnalyze(null)}
                      onGamePersisted={() => {
                        queryClient.invalidateQueries({ queryKey: ["game", gameId, activeGameDb] });
                        queryClient.invalidateQueries({ queryKey: ["databases"] });
                        queryClient.invalidateQueries({ queryKey: ["browserGames"] });
                      }}
                      boardTheme={currentBoardTheme}
                      uxTheme={currentUXTheme}
                      onPositionChange={setCurrentBoardFen}
                      onStatsChange={setAnalysisStats}
                      qualityFilter={qualityFilter}
                      onQualityFilterChange={setQualityFilter}
                      runAnalysisSignal={runAnalysisSignal}
                      analysisDepth={evalDepth}
                      onAnalysisStateChange={setEvalState}
                      onUciLog={(logs, options) => {
                        setEngineUciLogs(logs);
                        if (options) setEngineUciOptions(options);
                      }}
                    />
                  )}
                </div>

                {/* Right Panel: AI Dossier & Engine UCI Output */}
                <div className="w-full lg:w-80 flex-shrink-0 flex flex-col gap-4 min-h-0 overflow-y-auto">
                  {/* AI Dossier Panel */}
                  <div
                    className={`rounded-3xl border p-5 shadow-2xl flex flex-col transition-colors duration-200 ${currentUXTheme.panel} ${currentUXTheme.border}`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <h2
                        className={`text-xs font-extrabold uppercase tracking-wider flex items-center gap-2 ${
                          isLight ? "text-emerald-800" : "text-emerald-300"
                        }`}
                      >
                        <Sparkles className="w-4 h-4 text-emerald-500 animate-pulse" />
                        Game Info &amp; Analysis
                      </h2>
                      {/* Database Switcher */}
                      <select
                        value={activeGameDb}
                        onChange={(e) => {
                          const selected = e.target.value;
                          setActiveGameDb(selected);
                          setGameId(1);
                          localStorage.setItem("deepscout_last_opened_db", selected);
                          localStorage.setItem("deepscout_last_game_id", "1");
                          logAction("CLICK", `Switched Analysis Database to ${selected}`);
                        }}
                        className={`text-[11px] font-mono font-extrabold rounded-lg px-2 py-0.5 border outline-none cursor-pointer ${
                          isLight ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-950" : "bg-emerald-950/40 border-emerald-500/40 text-emerald-300"
                        }`}
                      >
                        {dbList && dbList.length > 0 ? (
                          dbList.map((d) => (
                            <option key={d.name} value={d.name}>
                              {d.name}
                            </option>
                          ))
                        ) : (
                          <option value={activeGameDb}>{activeGameDb}</option>
                        )}
                      </select>
                    </div>

                    <div className="space-y-3 text-xs">
                      <div
                        className={`p-3.5 rounded-2xl border space-y-1.5 ${
                          isLight
                            ? "bg-slate-100/90 border-slate-300 text-slate-900"
                            : "bg-black/40 border-white/10 text-white"
                        }`}
                      >
                        <div className="text-xs font-extrabold flex items-center justify-between">
                          <span className={isLight ? "text-slate-800" : "text-slate-200"}>Game Details</span>
                          <div className="flex items-center gap-1.5 font-mono">
                            <button
                              onClick={() => {
                                const prevTarget =
                                  gameData?.prev_id !== undefined && gameData?.prev_id !== null
                                    ? gameData.prev_id
                                    : typeof gameId === "number"
                                    ? Math.max(1, gameId - 1)
                                    : null;
                                if (prevTarget === null) return;
                                setGameId(prevTarget);
                                localStorage.setItem("deepscout_last_game_id", String(prevTarget));
                                logAction("NAV", `Analysis Navigated to Game #${prevTarget}`);
                              }}
                              disabled={
                                gameData !== undefined
                                  ? gameData.prev_id === null || gameData.prev_id === undefined
                                  : typeof gameId === "number" && gameId <= 1
                              }
                              className="p-1 rounded-md hover:bg-slate-200 dark:hover:bg-white/10 disabled:opacity-30 cursor-pointer"
                              title="Previous Game in DB"
                            >
                              <ChevronLeft className="w-3.5 h-3.5" />
                            </button>
                            <span className="font-extrabold text-emerald-600 dark:text-emerald-400">
                              ID #{typeof gameId === "string" && gameId.length > 8 ? `${gameId.slice(0, 8)}…` : gameId}
                            </span>
                            <button
                              onClick={() => {
                                const nextTarget =
                                  gameData?.next_id !== undefined && gameData?.next_id !== null
                                    ? gameData.next_id
                                    : typeof gameId === "number"
                                    ? gameId + 1
                                    : null;
                                if (nextTarget === null) return;
                                setGameId(nextTarget);
                                localStorage.setItem("deepscout_last_game_id", String(nextTarget));
                                logAction("NAV", `Analysis Navigated to Game #${nextTarget}`);
                              }}
                              disabled={
                                gameData !== undefined &&
                                (gameData.next_id === null || gameData.next_id === undefined)
                              }
                              className="p-1 rounded-md hover:bg-slate-200 dark:hover:bg-white/10 disabled:opacity-30 cursor-pointer"
                              title="Next Game in DB"
                            >
                              <ChevronRight className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        <div className={`font-extrabold text-sm truncate ${isLight ? "text-slate-900" : "text-white"}`}>
                          {gameData?.white || "White"} vs {gameData?.black || "Black"}
                        </div>
                        <p className={`text-xs leading-relaxed font-mono font-semibold ${isLight ? "text-slate-800" : "text-slate-200"}`}>
                          {gameData?.event || "Match"} · {gameData?.eco || "ECO"} {gameData?.opening ? `(${gameData.opening})` : ""} · Result: <span className="font-extrabold text-emerald-600 dark:text-emerald-400">{gameData?.result || "*"}</span>
                        </p>
                        {gameData?.date && gameData.date !== "????.??.??" && (
                          <div className={`text-[11px] font-mono font-bold ${isLight ? "text-slate-700" : "text-slate-300"}`}>
                            Date: {gameData.date}
                          </div>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-2.5">
                        {([
                          { side: "White", header: gameData?.white_elo, perf: analysisStats?.whitePerfElo, color: "text-emerald-600 dark:text-emerald-400" },
                          { side: "Black", header: gameData?.black_elo, perf: analysisStats?.blackPerfElo, color: "text-cyan-600 dark:text-cyan-400" },
                        ] as const).map((t) => (
                          <div
                            key={t.side}
                            className={`p-3 rounded-xl border text-center ${
                              isLight
                                ? "bg-slate-100/90 border-slate-300 text-slate-900"
                                : "bg-black/40 border-white/10 text-white"
                            }`}
                            title={
                              t.perf
                                ? `Engine-evaluated performance Elo (from ACPL). PGN header Elo: ${t.header || "n/a"}`
                                : "Elo from the PGN header (declared / engine setting). Run Evaluate Game for an evaluated performance Elo."
                            }
                          >
                            <span className={`text-[11px] block font-bold ${isLight ? "text-slate-700" : "text-slate-300"}`}>
                              {t.side} Elo {t.perf ? "· Performance" : "· Header"}
                            </span>
                            <span className={`text-sm font-black font-mono ${t.color}`}>
                              {t.perf ? `≈${t.perf}` : t.header || "—"}
                            </span>
                            {t.perf && t.header && (
                              <span className={`text-[10px] block font-mono ${isLight ? "text-slate-600" : "text-slate-400"}`}>
                                header {t.header}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>

                      {/* Evaluate Game (parallel PGN chunking → ACPL, accuracy, performance Elo) */}
                      <div
                        className={`p-3 rounded-xl border space-y-2 ${
                          isLight ? "bg-amber-50 border-amber-300/70" : "bg-amber-950/20 border-amber-500/30"
                        }`}
                      >
                        <div className="flex items-center gap-1.5">
                          <select
                            value={analyzerPreset}
                            onChange={(e) => {
                              const nextPreset = e.target.value as AnalysisPresetKey;
                              setAnalyzerPreset(nextPreset);
                              const presetDef =
                                nextPreset !== "custom" ? PRESET_DEFINITIONS[nextPreset] : undefined;
                              const nextDepth = presetDef ? presetDef.depth : evalDepth;
                              if (presetDef) {
                                setEvalDepth(presetDef.depth);
                              }
                              const currentRole = engineRolesData?.roles?.analyzer;
                              const nextRolePayload = {
                                engine_id: currentRole?.engine_id || "stockfish",
                                preset: nextPreset,
                                search_mode: presetDef ? presetDef.search_mode : (currentRole?.search_mode || "depth"),
                                depth: nextDepth,
                                movetime_ms: presetDef ? presetDef.movetime_ms : (currentRole?.movetime_ms ?? null),
                              };
                              try {
                                localStorage.setItem(
                                  ANALYZER_STORAGE_KEY,
                                  JSON.stringify({ ...(currentRole || {}), ...nextRolePayload })
                                );
                              } catch {}
                              updateEngineRole("analyzer", nextRolePayload)
                                .then(() => queryClient.invalidateQueries({ queryKey: ["engineRoles"] }))
                                .catch(() => {});
                              logAction("CLICK", `Analyzer Preset -> ${nextPreset} (d${nextDepth})`);
                            }}
                            disabled={evalState.running}
                            className={`flex-1 min-w-0 text-[11px] font-mono font-bold rounded-lg px-2 py-1.5 border outline-none cursor-pointer ${
                              isLight ? "bg-white border-slate-300 text-slate-900" : "bg-black/40 border-white/15 text-white"
                            }`}
                            title="Analysis depth preset (configure engine, workers & UCI options via Settings Gear)"
                          >
                            <option value="quick">Quick (d10)</option>
                            <option value="narrow">Narrow (d14)</option>
                            <option value="deep">Deep (d18)</option>
                            <option value="thorough">Thorough (d22)</option>
                            <option value="custom">Custom (d{evalDepth})</option>
                          </select>
                          <Tooltip content="Analyzer Engine, Parallel Workers & UCI Settings">
                            <button
                              type="button"
                              onClick={() => {
                                setIsAnalyzerGearOpen(true);
                                logAction("CLICK", "Opened Analyzer Quick Settings Modal");
                              }}
                              disabled={evalState.running}
                              className={`p-1.5 rounded-lg border transition-all cursor-pointer disabled:opacity-50 ${
                                isLight
                                  ? "bg-white hover:bg-amber-100 border-slate-300 text-slate-700"
                                  : "bg-black/40 hover:bg-amber-500/20 border-white/15 text-amber-300"
                              }`}
                              aria-label="Analyzer Engine Settings"
                            >
                              <Settings className="w-3.5 h-3.5" />
                            </button>
                          </Tooltip>
                          <button
                            onClick={() => {
                              setQualityFilter(null);
                              setRunAnalysisSignal((n) => n + 1);
                              logAction("CLICK", `Evaluate Game (${analyzerPreset}, depth ${evalDepth})`);
                            }}
                            disabled={evalState.running}
                            className="flex-1 py-1.5 px-2 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-slate-950 font-extrabold text-[11px] rounded-lg shadow-md transition-all flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60 whitespace-nowrap"
                          >
                            {evalState.running ? (
                              <>
                                <RefreshCw className="w-3 h-3 animate-spin" />
                                <span>
                                  {evalState.progress?.current ?? 0}/{evalState.progress?.total ?? "…"}
                                </span>
                              </>
                            ) : (
                              <span>⚡ Evaluate Game</span>
                            )}
                          </button>
                        </div>
                        <p className={`text-[10px] leading-snug ${isLight ? "text-slate-700" : "text-slate-300"}`}>
                          Parallel engine evaluation ({engineRolesData?.roles?.analyzer?.engine_id || "stockfish"} · {engineRolesData?.roles?.analyzer?.workers_mode === "manual" ? `${engineRolesData.roles.analyzer.manual_workers}w×${engineRolesData.roles.analyzer.manual_threads}t` : "Auto Safe"}) → ACPL, move-quality tiles &amp; Gold PGN persistence.
                        </p>
                      </div>

                      <div className="pt-2">
                        <AskGrandmasterAction
                          fen={currentBoardFen}
                          evalStr={liveEvalInfo.evalStr}
                          mainLine={liveEvalInfo.mainLine}
                          contextNotes={`Game #${gameId} (${gameData?.white || "White"} vs ${gameData?.black || "Black"})`}
                          variant="banner"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Engine Output & UCI Options Debugger */}
                  <div
                    className={`rounded-3xl border p-4 shadow-2xl flex flex-col flex-grow min-h-[220px] transition-colors duration-200 ${currentUXTheme.panel} ${currentUXTheme.border}`}
                  >
                    <div className="flex items-center justify-between mb-2.5">
                      <div className="flex items-center gap-1.5">
                        <Terminal className="w-4 h-4 text-cyan-400" />
                        <h2
                          className={`font-extrabold text-xs uppercase tracking-wider ${
                            isLight ? "text-slate-900" : "text-white"
                          }`}
                        >
                          Engine UCI Output
                        </h2>
                      </div>

                      <div className="flex items-center gap-1">
                        {/* Stream vs Options toggle */}
                        <div className="flex bg-black/40 border border-white/10 rounded-lg p-0.5 text-[10px] font-bold">
                          <button
                            onClick={() => setUciViewTab("stream")}
                            className={`px-2 py-0.5 rounded cursor-pointer transition-colors ${
                              uciViewTab === "stream"
                                ? "bg-cyan-500 text-slate-950 font-extrabold shadow"
                                : "text-slate-300 hover:text-white"
                            }`}
                          >
                            Stream
                          </button>
                          <button
                            onClick={() => setUciViewTab("options")}
                            className={`px-2 py-0.5 rounded cursor-pointer transition-colors ${
                              uciViewTab === "options"
                                ? "bg-cyan-500 text-slate-950 font-extrabold shadow"
                                : "text-slate-300 hover:text-white"
                            }`}
                          >
                            Options
                          </button>
                        </div>

                        {/* Copy logs */}
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(engineUciLogs.join("\n"));
                            setUciCopied(true);
                            setTimeout(() => setUciCopied(false), 2000);
                          }}
                          className="p-1 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 transition-colors cursor-pointer"
                          title="Copy raw UCI logs"
                        >
                          {uciCopied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>

                        {/* Clear logs */}
                        <button
                          onClick={() => setEngineUciLogs([])}
                          className="p-1 rounded-lg text-slate-300 hover:text-rose-400 hover:bg-white/10 transition-colors cursor-pointer"
                          title="Clear console"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {uciViewTab === "stream" ? (
                      <div
                        className={`font-mono text-[11px] space-y-1 flex-grow overflow-y-auto max-h-56 p-3 rounded-2xl border shadow-inner ${
                          isLight
                            ? "bg-slate-950 text-slate-100 border-slate-800"
                            : "bg-black/60 text-slate-100 border-white/10"
                        }`}
                      >
                        {engineUciLogs.length === 0 ? (
                          <span className="text-slate-400 italic font-semibold">Engine idle. Calculate or step moves to see live UCI protocol output.</span>
                        ) : (
                          engineUciLogs.map((line, i) => {
                            let lineStyle = "text-slate-200";
                            if (line.startsWith(">> setoption")) lineStyle = "text-purple-300 font-semibold";
                            else if (line.startsWith(">>")) lineStyle = "text-cyan-300 font-bold";
                            else if (line.startsWith("<< id")) lineStyle = "text-blue-300 font-bold";
                            else if (line.startsWith("<< bestmove")) lineStyle = "text-amber-300 font-extrabold";
                            else if (line.startsWith("<< info")) lineStyle = "text-emerald-300 font-medium";
                            else if (line.startsWith("[ERROR]")) lineStyle = "text-rose-400 font-bold";
                            else if (line.startsWith("[STATUS]")) lineStyle = "text-cyan-400 font-semibold";

                            return (
                              <div key={i} className={`leading-relaxed font-mono ${lineStyle}`}>
                                {line}
                              </div>
                            );
                          })
                        )}
                      </div>
                    ) : (
                      <div
                        className={`font-mono text-xs space-y-1.5 flex-grow overflow-y-auto max-h-56 p-3 rounded-2xl border shadow-inner ${
                          isLight
                            ? "bg-slate-950 text-slate-100 border-slate-800"
                            : "bg-black/60 text-slate-100 border-white/10"
                        }`}
                      >
                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                          {Object.entries(engineUciOptions).map(([key, val]) => (
                            <div key={key} className="p-2 rounded-xl bg-white/5 border border-white/10 flex flex-col">
                              <span className="text-[10px] text-cyan-300 font-bold uppercase tracking-wider">{key}</span>
                              <span className="font-extrabold text-white truncate">{String(val)}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Opening Book Explorer Panel */}
                  <OpeningBookPanel
                    fen={currentBoardFen}
                    eco={gameData?.eco}
                    openingName={gameData?.opening}
                    uxTheme={currentUXTheme}
                  />

                  {/* Game Performance & Stats Panel */}
                  <GameStatsPanel
                    stats={analysisStats}
                    gameDetails={
                      gameData
                        ? {
                            white: gameData.white,
                            black: gameData.black,
                            white_elo: gameData.white_elo,
                            black_elo: gameData.black_elo,
                            result: gameData.result,
                            event: gameData.event,
                            date: gameData.date,
                            eco: gameData.eco,
                            opening: gameData.opening,
                            termination: gameData.termination,
                            final_eval: gameData.final_eval,
                            eval_source: gameData.eval_source,
                            player_acpl: gameData.player_acpl,
                            engine_acpl: gameData.engine_acpl,
                          }
                        : null
                    }
                    uxTheme={currentUXTheme}
                    activeQualityFilter={qualityFilter}
                    onQualityFilterChange={setQualityFilter}
                  />
                </div>
              </div>
          ) : activeView === "Database" ||
            activeView === "Fitness" ||
            activeView === "Dossier" ||
            activeView === "Compare" ||
            activeView === "Fashion" ||
            activeView === "Consolidator" ? (
            /* Database Hub (Shelf, Data Fitness, Dossier, Compare, Fashion Index, Consolidator) */
            <ErrorBoundary
              fallbackTitle="Database Hub Error"
              onError={(err) => logAction("ERROR", "Database Hub Error", err.message)}
            >
              <div className="flex-grow h-full min-h-0 overflow-hidden">
                <DatabaseBrowserView
                  uxTheme={currentUXTheme}
                  boardTheme={currentBoardTheme}
                  initialSubTab={
                    activeView === "Fitness"
                      ? "fitness"
                      : activeView === "Dossier"
                      ? "dossier"
                      : activeView === "Compare"
                      ? "compare"
                      : activeView === "Fashion"
                      ? "fashion"
                      : activeView === "Consolidator"
                      ? "consolidator"
                      : "shelf"
                  }
                  onLoadGame={(id, dbName) => {
                    const targetDb = dbName || activeGameDb;
                    // Persist handoff synchronously before switching tabs to prevent
                    // empty fallback loads in the Analysis workspace.
                    localStorage.setItem("deepscout_last_opened_db", targetDb);
                    localStorage.setItem("deepscout_last_game_id", String(id || 1));
                    setGameId(id);
                    if (dbName) setActiveGameDb(dbName);
                    setActiveView("Analysis");
                    logAction("NAV", `Loaded Game #${id} from ${targetDb} into Analysis Workspace`);
                  }}
                  onOpenBookBuilder={() => {
                    setActiveView("BookBuilder");
                    logAction("NAV", "Navigated to Book Builder / Opening Repertoire Factory");
                  }}
                  onOpenSparring={() => {
                    setActiveView("Spar");
                    logAction("NAV", "Navigated to Sparring Arena");
                  }}
                />
              </div>
            </ErrorBoundary>
          ) : activeView === "Spar" ? (
            /* Engine Sparring Arena & Elo Practice */
            <ErrorBoundary
              fallbackTitle="Sparring Arena Error"
              onError={(err) => logAction("ERROR", "Sparring View Error", err.message)}
            >
              <div className="flex-grow overflow-y-auto min-h-0">
                <SparView
                  uxTheme={currentUXTheme}
                  boardTheme={currentBoardTheme}
                  initialEngineId={sparTargetEngineId}
                  onConsumedInitialEngine={() => setSparTargetEngineId(null)}
                />
              </div>
            </ErrorBoundary>
          ) : activeView === "BookBuilder" ? (
            /* Polyglot Opening Book Builder & Repertoire Factory */
            <ErrorBoundary
              fallbackTitle="Book Builder Error"
              onError={(err) => logAction("ERROR", "Book Builder View Error", err.message)}
            >
              <div className="flex-grow overflow-y-auto min-h-0">
                <BookBuilderView uxTheme={currentUXTheme} />
              </div>
            </ErrorBoundary>
          ) : activeView === "AI Grandmaster" || activeView === "Generative Stats" ? (
            /* AI Grandmaster & Neural Persona Coaching (BYOK) */
            <ErrorBoundary
              fallbackTitle="AI Grandmaster Error"
              onError={(err) => logAction("ERROR", "AI Grandmaster Error", err.message)}
            >
              <div className="flex-grow overflow-y-auto min-h-0">
                <AIGrandmasterView uxTheme={currentUXTheme} />
              </div>
            </ErrorBoundary>
          ) : activeView === "Engines" || activeView === "Settings" ? (
            /* UCI Engine Management & Customization Studio */
            <ErrorBoundary
              fallbackTitle="Engine Lab Error"
              onError={(err) => logAction("ERROR", "Engine Lab View Error", err.message)}
            >
              <div className="flex-grow overflow-y-auto min-h-0">
                <EnginesView
                  uxTheme={currentUXTheme}
                  onLaunchSparring={(engineId) => {
                    try {
                      const raw = localStorage.getItem("deepscout_spar_settings_v1");
                      const prev = raw ? JSON.parse(raw) : {};
                      localStorage.setItem(
                        "deepscout_spar_settings_v1",
                        JSON.stringify({ ...prev, selectedEngine: engineId })
                      );
                    } catch {}
                    setSparTargetEngineId(engineId);
                    setActiveView("Spar");
                    logAction("NAV", `Launched Sparring with Engine: ${engineId}`);
                  }}
                />
              </div>
            </ErrorBoundary>
          ) : (
            <div className="flex-grow overflow-y-auto min-h-0">
              <EnginesView uxTheme={currentUXTheme} />
            </div>
          )}
        </div>
      </div>

      {/* Theme Customizer Modal */}
      <ThemeCustomizer
        isOpen={isThemeModalOpen}
        onClose={() => setIsThemeModalOpen(false)}
        currentUXTheme={currentUXTheme}
        currentBoardTheme={currentBoardTheme}
        customSettings={customSettings}
        onSelectUXTheme={setCurrentUXTheme}
        onSelectBoardTheme={setCurrentBoardTheme}
        onUpdateCustomSettings={setCustomSettings}
        initialTab={themeModalTab}
      />

      {/* Analyzer Quick Settings & Parallel Hardware Modal */}
      <AnalyzerQuickSettingsModal
        isOpen={isAnalyzerGearOpen}
        onClose={() => setIsAnalyzerGearOpen(false)}
        uxTheme={currentUXTheme}
        mode="analysis"
        onSaved={(updated, triggerReanalyze) => {
          setAnalyzerPreset(updated.preset);
          setEvalDepth(updated.depth);
          if (triggerReanalyze) {
            setQualityFilter(null);
            setRunAnalysisSignal((n) => n + 1);
          }
        }}
      />
    </div>
  );
}

export default function App() {
  return <MainApp />;
}
