import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AnalysisPresetKey,
  AnalyzerRoleConfig,
  AnalyzerSearchMode,
  EngineInfo,
  WorkersMode,
  fetchEngineList,
  fetchEngineOptions,
  fetchEngineRoles,
  updateEngineRole,
} from "../../lib/api";
import { UXTheme } from "../../lib/theme";
import { UciOptionsInspector } from "../engines/UciOptionsInspector";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Cpu,
  Gauge,
  RefreshCw,
  Settings2,
  Sliders,
  Sparkles,
  X,
  Zap,
} from "lucide-react";

export const ANALYZER_STORAGE_KEY = "deepscout_analyzer_settings_v1";

export const PRESET_DEFINITIONS: Record<
  Exclude<AnalysisPresetKey, "custom">,
  { label: string; shortDesc: string; search_mode: AnalyzerSearchMode; depth: number; movetime_ms: number | null }
> = {
  quick: { label: "Quick", shortDesc: "d10 · 250ms cap", search_mode: "hybrid", depth: 10, movetime_ms: 250 },
  narrow: { label: "Narrow", shortDesc: "d14", search_mode: "depth", depth: 14, movetime_ms: null },
  deep: { label: "Deep", shortDesc: "d18", search_mode: "depth", depth: 18, movetime_ms: null },
  thorough: { label: "Thorough", shortDesc: "d22 exact", search_mode: "depth", depth: 22, movetime_ms: null },
};

interface AnalyzerQuickSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  uxTheme: UXTheme;
  /** "analysis" triggers immediate re-analysis on apply; "engine_lab" saves configuration only. */
  mode?: "analysis" | "engine_lab";
  /** Optional engine override if opened directly for a chosen engine. */
  initialEngineId?: string;
  onSaved?: (config: AnalyzerRoleConfig, triggerReanalyze: boolean) => void;
}

export function AnalyzerQuickSettingsModal({
  isOpen,
  onClose,
  uxTheme,
  mode = "analysis",
  initialEngineId,
  onSaved,
}: AnalyzerQuickSettingsModalProps) {
  const queryClient = useQueryClient();
  const isLight = uxTheme?.mode === "light" || uxTheme?.id === "clean-light";

  const { data: engines = [] } = useQuery<EngineInfo[]>({
    queryKey: ["engines"],
    queryFn: fetchEngineList,
    enabled: isOpen,
  });

  const { data: rolesData } = useQuery({
    queryKey: ["engineRoles"],
    queryFn: fetchEngineRoles,
    enabled: isOpen,
  });

  const savedAnalyzer = rolesData?.roles?.analyzer;
  const hardware = rolesData?.hardware || {
    cpu_count: 8,
    safe_ceiling: 6,
    available_ram_mb: 8192,
    default_auto_workers: 6,
  };

  // Draft state
  const [engineId, setEngineId] = useState<string>("stockfish");
  const [preset, setPreset] = useState<AnalysisPresetKey>("deep");
  const [searchMode, setSearchMode] = useState<AnalyzerSearchMode>("depth");
  const [depth, setDepth] = useState<number>(18);
  const [movetimeMs, setMovetimeMs] = useState<number>(300);
  const [multipv, setMultipv] = useState<number>(1);
  const [workersMode, setWorkersMode] = useState<WorkersMode>("auto");
  const [manualWorkers, setManualWorkers] = useState<number>(hardware.default_auto_workers);
  const [manualThreads, setManualThreads] = useState<number>(1);
  const [uciOverrides, setUciOverrides] = useState<Record<string, any>>({});
  const [showAdvancedHw, setShowAdvancedHw] = useState<boolean>(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Hydrate draft state strictly when modal opens or savedAnalyzer updates
  useEffect(() => {
    if (!isOpen) return;
    setSaveError(null);
    const targetEng = initialEngineId || savedAnalyzer?.engine_id || "stockfish";
    const sameEngine = savedAnalyzer && targetEng.toLowerCase() === savedAnalyzer.engine_id.toLowerCase();
    setEngineId(targetEng);
    setPreset((savedAnalyzer?.preset as AnalysisPresetKey) || "deep");
    setSearchMode((savedAnalyzer?.search_mode as AnalyzerSearchMode) || "depth");
    setDepth(savedAnalyzer?.depth ?? 18);
    setMovetimeMs(savedAnalyzer?.movetime_ms ?? 300);
    setMultipv(savedAnalyzer?.multipv ?? 1);
    setWorkersMode((savedAnalyzer?.workers_mode as WorkersMode) || "auto");
    setManualWorkers(savedAnalyzer?.manual_workers ?? hardware.default_auto_workers);
    setManualThreads(savedAnalyzer?.manual_threads ?? 1);
    setUciOverrides(sameEngine ? { ...(savedAnalyzer?.uci_overrides || {}) } : {});
  }, [isOpen, savedAnalyzer, initialEngineId, hardware.default_auto_workers]);

  // Probe native UCI options strictly keyed by the currently selected `engineId`
  const {
    data: probedOptions = {},
    isFetching: isLoadingOptions,
  } = useQuery({
    queryKey: ["engineOptions", engineId],
    queryFn: () => fetchEngineOptions(engineId),
    enabled: isOpen && !!engineId,
    staleTime: 60_000,
  });

  // Guard against stale options while switching engines: filter uciOverrides to keys supported by probedOptions
  const isolatedCurrentValues = useMemo(() => {
    const base: Record<string, any> = {};
    Object.entries(probedOptions).forEach(([k, meta]) => {
      if (meta?.default !== undefined) base[k] = meta.default;
    });
    Object.entries(uciOverrides).forEach(([k, v]) => {
      if (Object.keys(probedOptions).length === 0 || k in probedOptions) {
        base[k] = v;
      }
    });
    return base;
  }, [probedOptions, uciOverrides]);

  const isNeuralGpu = useMemo(() => {
    const low = (engineId || "").toLowerCase();
    if (low.includes("lc0") || low.includes("maia") || low.includes("leela")) return true;
    const keys = Object.keys(probedOptions).map((k) => k.toLowerCase());
    return keys.includes("weightsfile") || keys.includes("backend");
  }, [engineId, probedOptions]);

  const effectiveWorkers = isNeuralGpu
    ? 1
    : workersMode === "manual"
    ? Math.max(1, manualWorkers)
    : Math.min(6, hardware.safe_ceiling);
  const effectiveThreads = isNeuralGpu
    ? Math.max(1, manualThreads)
    : workersMode === "manual"
    ? Math.max(1, manualThreads)
    : 1;
  const totalCpuLoad = effectiveWorkers * effectiveThreads;
  const isCpuOversubscribed = totalCpuLoad > hardware.safe_ceiling;

  const configuredHashMb = Number(isolatedCurrentValues["Hash"] ?? uciOverrides["Hash"] ?? 128) || 128;
  const estimatedHashRamMb = effectiveWorkers * configuredHashMb;
  const safeRamBudgetMb = Math.max(512, Math.floor(hardware.available_ram_mb * 0.6));
  const isRamOversubscribed = estimatedHashRamMb > safeRamBudgetMb;

  const handleEngineSwitch = (nextId: string) => {
    setEngineId(nextId);
    // Reset UCI overrides strictly on engine change so options never transpose across engines!
    const matchesSaved = savedAnalyzer && nextId.toLowerCase() === savedAnalyzer.engine_id.toLowerCase();
    setUciOverrides(matchesSaved ? { ...(savedAnalyzer?.uci_overrides || {}) } : {});
    if (mode === "analysis") {
      setPreset("custom");
    }
  };

  const handleApplyPresetPill = (p: AnalysisPresetKey) => {
    setPreset(p);
    if (p !== "custom") {
      const def = PRESET_DEFINITIONS[p];
      setSearchMode(def.search_mode);
      setDepth(def.depth);
      if (def.movetime_ms !== null) setMovetimeMs(def.movetime_ms);
    }
  };

  const handleAutoBalance = () => {
    setWorkersMode("auto");
    setManualWorkers(Math.min(6, hardware.safe_ceiling));
    setManualThreads(1);
  };

  const saveMutation = useMutation({
    mutationFn: async (forceCustom: boolean) => {
      // Filter out any transposed keys not belonging to probedOptions (when options loaded)
      const validKeys = Object.keys(probedOptions);
      const filteredOverrides: Record<string, any> = {};
      Object.entries(uciOverrides).forEach(([k, v]) => {
        if (k.toLowerCase() === "multipv") return;
        if (validKeys.length > 0 && !(k in probedOptions)) return;
        if (probedOptions[k]?.type === "button") return;
        filteredOverrides[k] = v;
      });

      const finalPreset: AnalysisPresetKey = forceCustom ? "custom" : preset;
      const effMovetime =
        searchMode === "depth" ? null : Math.max(50, Number(movetimeMs) || 300);

      const res = await updateEngineRole("analyzer", {
        engine_id: engineId,
        uci_overrides: filteredOverrides,
        preset: finalPreset,
        search_mode: searchMode,
        depth: Math.max(4, Math.min(60, Number(depth) || 18)),
        movetime_ms: effMovetime,
        multipv: Math.max(1, Math.min(10, Number(multipv) || 1)),
        workers_mode: workersMode,
        manual_workers: Math.max(1, Math.min(32, Number(manualWorkers) || hardware.default_auto_workers)),
        manual_threads: Math.max(1, Math.min(32, Number(manualThreads) || 1)),
      });
      return res;
    },
    onSuccess: (res) => {
      const updated = res.config as AnalyzerRoleConfig;
      try {
        localStorage.setItem(ANALYZER_STORAGE_KEY, JSON.stringify(updated));
      } catch {
        /* ignore */
      }
      queryClient.invalidateQueries({ queryKey: ["engineRoles"] });
      onSaved?.(updated, mode === "analysis");
      onClose();
    },
    onError: (err: any) => {
      setSaveError(err?.message || "Failed to save Analyzer configuration");
    },
  });

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-in fade-in duration-150">
      <div
        className={`w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-3xl border shadow-2xl p-6 space-y-5 font-sans ${
          isLight
            ? "bg-white border-slate-300 text-slate-900"
            : "bg-[#14171c] border-slate-800 text-white"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b pb-3 border-white/10">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400">
              <Settings2 className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-extrabold flex items-center gap-2">
                Analyzer Engine &amp; UCI Settings
                <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
                  ANALYZER ROLE
                </span>
              </h2>
              <p className={`text-[11px] font-mono ${isLight ? "text-slate-600" : "text-slate-400"}`}>
                Isolated from Sparring — changing settings in Analysis switches preset to Custom &amp; re-analyzes.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-xl text-slate-400 hover:text-white hover:bg-white/10 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 1. Engine & Preset Selection */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className={`p-4 rounded-2xl border space-y-2 ${isLight ? "bg-slate-50 border-slate-200" : "bg-black/30 border-white/10"}`}>
            <label className="text-xs font-extrabold flex items-center gap-1.5">
              <Cpu className="w-3.5 h-3.5 text-cyan-400" />
              Active Analyzer Engine
            </label>
            <select
              value={engineId}
              onChange={(e) => handleEngineSwitch(e.target.value)}
              className={`w-full px-3 py-2 rounded-xl border text-xs font-mono font-bold outline-none cursor-pointer ${
                isLight
                  ? "bg-white border-slate-300 text-slate-900"
                  : "bg-black/60 border-white/15 text-white"
              }`}
            >
              {engines.length > 0 ? (
                engines.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.icon ? `${e.icon} ` : ""}{e.name} {e.is_custom ? "(Custom)" : ""}
                  </option>
                ))
              ) : (
                <option value={engineId}>{engineId}</option>
              )}
            </select>
            {isNeuralGpu && (
              <p className="text-[10px] font-mono text-purple-400 font-bold">
                🧠 Neural / GPU engine detected — parallel workers automatically capped at 1.
              </p>
            )}
          </div>

          <div className={`p-4 rounded-2xl border space-y-2 ${isLight ? "bg-slate-50 border-slate-200" : "bg-black/30 border-white/10"}`}>
            <label className="text-xs font-extrabold flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              Analysis Preset
            </label>
            <div className="grid grid-cols-5 gap-1.5">
              {(["quick", "narrow", "deep", "thorough", "custom"] as AnalysisPresetKey[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleApplyPresetPill(key)}
                  className={`py-1.5 px-1 rounded-xl text-[11px] font-mono font-bold capitalize border transition-all cursor-pointer ${
                    preset === key
                      ? "bg-amber-500/20 text-amber-400 border-amber-500/50 shadow-sm"
                      : isLight
                      ? "bg-white border-slate-200 text-slate-700 hover:bg-slate-100"
                      : "bg-black/40 border-white/10 text-slate-400 hover:text-white"
                  }`}
                >
                  {key}
                </button>
              ))}
            </div>
            <p className={`text-[10px] font-mono ${isLight ? "text-slate-600" : "text-slate-400"}`}>
              {preset === "custom"
                ? "Custom search & UCI protocol overrides active."
                : `${PRESET_DEFINITIONS[preset].label}: ${PRESET_DEFINITIONS[preset].shortDesc}`}
            </p>
          </div>
        </div>

        {/* 2. Search Limits & MultiPV */}
        <div className={`p-4 rounded-2xl border grid grid-cols-1 sm:grid-cols-4 gap-3 ${isLight ? "bg-slate-50 border-slate-200" : "bg-black/30 border-white/10"}`}>
          <div className="space-y-1">
            <label className="text-[11px] font-mono font-bold block">Search Mode</label>
            <select
              value={searchMode}
              onChange={(e) => {
                setSearchMode(e.target.value as AnalyzerSearchMode);
                setPreset("custom");
              }}
              className={`w-full px-2.5 py-1.5 rounded-xl border text-xs font-mono font-bold outline-none cursor-pointer ${
                isLight ? "bg-white border-slate-300 text-slate-900" : "bg-black/60 border-white/15 text-white"
              }`}
            >
              <option value="depth">Exact Depth</option>
              <option value="hybrid">Depth + Soft Cap</option>
              <option value="movetime">Movetime Only</option>
            </select>
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-mono font-bold block">Depth (Plies)</label>
            <input
              type="number"
              min={4}
              max={50}
              disabled={searchMode === "movetime"}
              value={depth}
              onChange={(e) => {
                setDepth(Math.max(4, Math.min(50, Number(e.target.value) || 14)));
                setPreset("custom");
              }}
              className={`w-full px-2.5 py-1.5 rounded-xl border text-xs font-mono font-bold outline-none disabled:opacity-40 ${
                isLight ? "bg-white border-slate-300 text-slate-900" : "bg-black/60 border-white/15 text-cyan-300"
              }`}
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-mono font-bold block">Movetime (ms/ply)</label>
            <input
              type="number"
              min={50}
              max={30000}
              step={50}
              disabled={searchMode === "depth"}
              value={movetimeMs}
              onChange={(e) => {
                setMovetimeMs(Math.max(50, Number(e.target.value) || 250));
                setPreset("custom");
              }}
              className={`w-full px-2.5 py-1.5 rounded-xl border text-xs font-mono font-bold outline-none disabled:opacity-40 ${
                isLight ? "bg-white border-slate-300 text-slate-900" : "bg-black/60 border-white/15 text-cyan-300"
              }`}
            />
          </div>

          <div className="space-y-1">
            <label className="text-[11px] font-mono font-bold block">MultiPV Lines</label>
            <input
              type="number"
              min={1}
              max={5}
              value={multipv}
              onChange={(e) => {
                setMultipv(Math.max(1, Math.min(5, Number(e.target.value) || 1)));
                setPreset("custom");
              }}
              className={`w-full px-2.5 py-1.5 rounded-xl border text-xs font-mono font-bold outline-none ${
                isLight ? "bg-white border-slate-300 text-slate-900" : "bg-black/60 border-white/15 text-cyan-300"
              }`}
            />
          </div>
        </div>

        {/* 3. Collapsible Advanced Parallelism & Hardware Drawer */}
        <div className={`rounded-2xl border overflow-hidden ${isLight ? "bg-slate-50 border-slate-200" : "bg-black/30 border-white/10"}`}>
          <button
            type="button"
            onClick={() => setShowAdvancedHw((v) => !v)}
            className="w-full px-4 py-3 flex items-center justify-between text-xs font-extrabold cursor-pointer hover:bg-white/5 transition-colors"
          >
            <div className="flex items-center gap-2">
              <Gauge className="w-4 h-4 text-emerald-400" />
              <span>Advanced Parallelism &amp; Hardware</span>
              <span
                className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${
                  isCpuOversubscribed || isRamOversubscribed
                    ? "bg-rose-500/20 text-rose-400 border-rose-500/40"
                    : "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                }`}
              >
                {workersMode === "auto" && !isNeuralGpu
                  ? `Auto (Hardware Safe) · ${effectiveWorkers}w × ${effectiveThreads}T`
                  : `Total CPU Load: ${effectiveWorkers} × ${effectiveThreads} = ${totalCpuLoad} threads`}
              </span>
            </div>
            {showAdvancedHw ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {showAdvancedHw && (
            <div className="px-4 pb-4 pt-2 border-t border-white/10 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      handleAutoBalance();
                      setPreset("custom");
                    }}
                    className={`px-3 py-1.5 rounded-xl font-bold border cursor-pointer ${
                      workersMode === "auto"
                        ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40"
                        : isLight
                        ? "bg-white border-slate-300 text-slate-700"
                        : "bg-black/40 border-white/10 text-slate-400"
                    }`}
                  >
                    Auto (Hardware Safe)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setWorkersMode("manual");
                      setPreset("custom");
                    }}
                    className={`px-3 py-1.5 rounded-xl font-bold border cursor-pointer ${
                      workersMode === "manual"
                        ? "bg-amber-500/20 text-amber-400 border-amber-500/40"
                        : isLight
                        ? "bg-white border-slate-300 text-slate-700"
                        : "bg-black/40 border-white/10 text-slate-400"
                    }`}
                  >
                    Manual Override
                  </button>
                </div>

                <div className={`text-[11px] ${isLight ? "text-slate-600" : "text-slate-400"}`}>
                  CPU: <strong>{hardware.cpu_count}</strong> logical · Safe Ceiling:{" "}
                  <strong className="text-emerald-400">{hardware.safe_ceiling}</strong> threads · Free RAM:{" "}
                  <strong>{(hardware.available_ram_mb / 1024).toFixed(1)} GB</strong>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs font-mono">
                <div className="space-y-1">
                  <label className="text-[11px] font-bold block">Workers (W)</label>
                  <input
                    type="number"
                    min={1}
                    max={isNeuralGpu ? 1 : 32}
                    disabled={workersMode === "auto" || isNeuralGpu}
                    value={effectiveWorkers}
                    onChange={(e) => {
                      setManualWorkers(Math.max(1, Math.min(32, Number(e.target.value) || 1)));
                      setWorkersMode("manual");
                      setPreset("custom");
                    }}
                    className={`w-full px-3 py-1.5 rounded-xl border font-bold outline-none disabled:opacity-50 ${
                      isLight ? "bg-white border-slate-300 text-slate-900" : "bg-black/60 border-white/15 text-white"
                    }`}
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-bold block">Threads per Worker (T)</label>
                  <input
                    type="number"
                    min={1}
                    max={32}
                    disabled={workersMode === "auto" && !isNeuralGpu}
                    value={effectiveThreads}
                    onChange={(e) => {
                      setManualThreads(Math.max(1, Math.min(32, Number(e.target.value) || 1)));
                      setWorkersMode("manual");
                      setPreset("custom");
                    }}
                    className={`w-full px-3 py-1.5 rounded-xl border font-bold outline-none disabled:opacity-50 ${
                      isLight ? "bg-white border-slate-300 text-slate-900" : "bg-black/60 border-white/15 text-white"
                    }`}
                  />
                </div>

                <div
                  className={`p-2.5 rounded-xl border flex flex-col justify-center ${
                    isCpuOversubscribed
                      ? "bg-rose-500/15 border-rose-500/40 text-rose-300"
                      : isLight
                      ? "bg-white border-slate-200 text-slate-800"
                      : "bg-black/40 border-white/10 text-slate-200"
                  }`}
                >
                  <span className="text-[10px] opacity-75">Total CPU Load</span>
                  <span className="text-sm font-black">
                    {effectiveWorkers} × {effectiveThreads} = {totalCpuLoad} threads
                  </span>
                </div>
              </div>

              {(isCpuOversubscribed || isRamOversubscribed) && (
                <div className="p-3 rounded-xl bg-rose-500/15 border border-rose-500/50 text-rose-300 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0 mt-0.5" />
                    <div className="space-y-0.5">
                      {isCpuOversubscribed && (
                        <p className="font-bold">
                          ⚠️ Oversubscription risk: {totalCpuLoad} active threads exceeds your {hardware.safe_ceiling}-thread safety ceiling. Expect UI lag and slower analysis.
                        </p>
                      )}
                      {isRamOversubscribed && (
                        <p className="font-semibold text-[11px]">
                          ⚠️ RAM budget notice: {effectiveWorkers} × {configuredHashMb} MB = {estimatedHashRamMb} MB Hash exceeds safe RAM headroom ({safeRamBudgetMb} MB). Per-worker Hash will be auto-scaled.
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleAutoBalance}
                    className="px-3 py-1.5 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-extrabold text-[11px] whitespace-nowrap cursor-pointer shadow"
                  >
                    Auto-Balance
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 4. Full Native UCI Options Inspector for Selected Analyzer Engine */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-extrabold uppercase tracking-wider flex items-center gap-1.5 text-cyan-400">
              <Sliders className="w-4 h-4" />
              Protocol UCI Options for {engines.find((e) => e.id === engineId)?.name || engineId}
            </h3>
            <span className="text-[10px] font-mono text-slate-400">
              User options are honored verbatim for this Analyzer role
            </span>
          </div>

          {isLoadingOptions ? (
            <div className={`p-6 rounded-2xl border text-center text-xs font-mono flex items-center justify-center gap-2 ${isLight ? "bg-slate-50 border-slate-200 text-slate-600" : "bg-black/30 border-white/10 text-slate-400"}`}>
              <RefreshCw className="w-4 h-4 animate-spin text-cyan-400" />
              Probing native UCI options for {engineId}...
            </div>
          ) : (
            <UciOptionsInspector
              key={engineId}
              optionsMap={probedOptions}
              currentValues={isolatedCurrentValues}
              onChange={(key, val) => {
                setUciOverrides((prev) => ({ ...prev, [key]: val }));
                if (mode === "analysis") setPreset("custom");
              }}
              isLight={isLight}
            />
          )}
        </div>

        {saveError && (
          <div className="p-3 rounded-xl bg-rose-500/20 border border-rose-500/40 text-rose-300 text-xs font-mono">
            {saveError}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 pt-3 border-t border-white/10">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate(mode === "analysis")}
            className="px-5 py-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-slate-950 font-extrabold text-xs shadow-lg flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {saveMutation.isPending ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Saving...</span>
              </>
            ) : mode === "analysis" ? (
              <>
                <Zap className="w-3.5 h-3.5" />
                <span>Apply (Custom) &amp; Re-Analyze</span>
              </>
            ) : (
              <>
                <Settings2 className="w-3.5 h-3.5" />
                <span>Save Analyzer Configuration</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
