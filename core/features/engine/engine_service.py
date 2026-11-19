import os
import sys
import re
import copy
import json
import platform
import subprocess
import threading
import logging
from typing import Optional, Dict, Any, List
from collections import deque
import chess
import chess.engine
import chess.polyglot
from core.features.openings.opening_book_service import OpeningBookService

logger = logging.getLogger("deepscout.engine")

VALID_ENGINE_ROLES = ("analyzer", "sparring", "kibitzer", "tutor")

ANALYSIS_PRESETS: Dict[str, Dict[str, Any]] = {
    "quick": {"label": "Quick", "search_mode": "hybrid", "depth": 10, "movetime_ms": 250},
    "narrow": {"label": "Narrow", "search_mode": "depth", "depth": 14, "movetime_ms": None},
    "deep": {"label": "Deep", "search_mode": "depth", "depth": 18, "movetime_ms": None},
    "thorough": {"label": "Thorough", "search_mode": "depth", "depth": 22, "movetime_ms": None},
}


def get_hardware_profile() -> Dict[str, Any]:
    """Computes runtime CPU ceiling and available RAM for hardware-aware parallelism."""
    cpu_count = os.cpu_count() or 4
    safe_ceiling = max(1, cpu_count - 2)
    available_ram_mb = 4096
    try:
        import psutil
        available_ram_mb = int(psutil.virtual_memory().available // (1024 * 1024))
    except Exception:
        pass
    return {
        "cpu_count": cpu_count,
        "safe_ceiling": safe_ceiling,
        "available_ram_mb": available_ram_mb,
        "default_auto_workers": min(6, safe_ceiling),
    }


def is_neural_gpu_engine(
    engine_id: str,
    exe_path: Optional[str] = None,
    options_schema: Optional[Dict[str, Any]] = None,
) -> bool:
    """Detects neural/GPU engines (Lc0 / Maia) that must be capped at 1 worker process."""
    low_id = (engine_id or "").lower()
    low_exe = os.path.basename(exe_path or "").lower()
    if any(tok in low_id or tok in low_exe for tok in ("lc0", "maia", "leela")):
        return True
    if options_schema and isinstance(options_schema, dict):
        opt_keys_lower = {str(k).lower() for k in options_schema.keys()}
        if "weightsfile" in opt_keys_lower or "backend" in opt_keys_lower:
            return True
    return False


THREAD_OPTION_ALIASES = ("threads", "number of threads", "max threads")


def resolve_threads_option_key(supported_options: Optional[Dict[str, Any]]) -> Optional[str]:
    """Returns the canonical UCI thread-count option key for an engine (e.g. 'Threads' or Deep Toga's 'Number of Threads')."""
    if not supported_options:
        return None
    lower_map = {str(k).lower(): str(k) for k in supported_options.keys()}
    for alias in THREAD_OPTION_ALIASES:
        if alias in lower_map:
            return lower_map[alias]
    return None


def _extract_opt_meta(opt: Any) -> Dict[str, Any]:
    """Normalizes either a python-chess Option object or a probed option dict."""
    if isinstance(opt, dict):
        return {
            "name": opt.get("name", ""),
            "type": str(opt.get("type", "")).lower(),
            "default": opt.get("default"),
            "min": opt.get("min"),
            "max": opt.get("max"),
            "var": opt.get("var") or [],
        }
    return {
        "name": getattr(opt, "name", ""),
        "type": str(getattr(opt, "type", "")).lower(),
        "default": getattr(opt, "default", None),
        "min": getattr(opt, "min", None),
        "max": getattr(opt, "max", None),
        "var": list(getattr(opt, "var", []) or []),
    }


def sanitize_uci_options(
    options: Optional[Dict[str, Any]],
    supported_options: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Sanitizes UCI options before passing to python-chess engine.configure().
    - Always strips 'MultiPV' (case-insensitive) since python-chess manages MultiPV
      exclusively via engine.analyse(..., multipv=n).
    - Strips None, '<empty>', and button-type options.
    - When `supported_options` (engine.options or probed schema) is supplied,
      strictly drops any key not supported by THAT specific engine (preventing
      option transposition/lockups across engines) and coerces values to schema bounds.
    """
    if not options or not isinstance(options, dict):
        return {}

    supported_map: Optional[Dict[str, Any]] = None
    if supported_options is not None:
        supported_map = {}
        try:
            for sk, sval in supported_options.items():
                supported_map[str(sk).lower()] = (str(sk), _extract_opt_meta(sval))
        except Exception:
            supported_map = None

    cleaned: Dict[str, Any] = {}
    for raw_k, raw_v in options.items():
        k = str(raw_k)
        if k.lower() == "multipv" or raw_v is None or raw_v == "<empty>":
            continue

        if supported_map is not None:
            entry = supported_map.get(k.lower())
            if entry is None and k.lower() in THREAD_OPTION_ALIASES:
                # Map generic "Threads" to engine-specific alias (e.g. Deep Toga's "Number of Threads")
                for alias in THREAD_OPTION_ALIASES:
                    if alias in supported_map:
                        # Skip alias mapping if caller already supplied the exact canonical key
                        alias_canon = supported_map[alias][0]
                        if alias_canon not in options and alias_canon.lower() not in {str(ok).lower() for ok in options.keys()}:
                            entry = supported_map[alias]
                        break
            if entry is None:
                # Reject transposed key belonging to a different engine
                continue
            canonical_key, meta = entry
            opt_type = meta["type"]
            if opt_type == "button":
                continue
            if opt_type == "spin":
                try:
                    num = int(round(float(raw_v)))
                except (TypeError, ValueError):
                    continue
                if meta["min"] is not None:
                    num = max(int(meta["min"]), num)
                if meta["max"] is not None:
                    num = min(int(meta["max"]), num)
                cleaned[canonical_key] = num
            elif opt_type == "check":
                if isinstance(raw_v, bool):
                    cleaned[canonical_key] = raw_v
                elif isinstance(raw_v, str):
                    cleaned[canonical_key] = raw_v.strip().lower() in ("true", "1", "yes", "on")
                else:
                    cleaned[canonical_key] = bool(raw_v)
            elif opt_type == "combo":
                sval = str(raw_v)
                allowed = [str(v) for v in (meta["var"] or [])]
                if allowed and sval not in allowed:
                    match = next((a for a in allowed if a.lower() == sval.lower()), None)
                    if match is None:
                        continue
                    sval = match
                cleaned[canonical_key] = sval
            else:
                # string or untyped option
                sval = str(raw_v)
                if sval == "<empty>":
                    continue
                cleaned[canonical_key] = sval
        else:
            cleaned[k] = raw_v

    return cleaned


def safe_engine_configure(
    engine: Any,
    options: Dict[str, Any],
    log_context: str = "engine",
) -> Dict[str, Any]:
    """
    Safely configures a python-chess engine by validating options strictly against
    `engine.options` (stripping MultiPV, button options, and transposed keys from
    other engines). Falls back to per-option configuration if batch apply fails.
    """
    supported = getattr(engine, "options", None)
    sanitized = sanitize_uci_options(options, supported_options=supported)
    if not sanitized:
        return {}
    try:
        engine.configure(sanitized)
        return sanitized
    except Exception as e:
        logger.warning("Batch UCI configure failed for %s: %s — retrying per option", log_context, e)
        applied: Dict[str, Any] = {}
        for k, v in sanitized.items():
            try:
                engine.configure({k: v})
                applied[k] = v
            except Exception as single_err:
                logger.warning("Skipped unsupported/failing UCI option %s=%r for %s: %s", k, v, log_context, single_err)
        return applied

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

DEFAULT_BUILTIN_ENGINES = [
    {
        "id": "stockfish",
        "name": "Stockfish 18",
        "elo": "3500+",
        "style": "Grandmaster Dynamic & Elo Scale",
        "icon": "🤖",
        "is_custom": False,
        "supports_elo": True,
        "min_elo": 1320,
        "max_elo": 3190,
    },
    {
        "id": "dragon",
        "name": "Dragon by Komodo",
        "elo": "3500+",
        "style": "Ultra-Sharp Tactical & Active Piece Play",
        "icon": "🐉",
        "is_custom": False,
        "supports_elo": True,
        "min_elo": 1000,
        "max_elo": 3500,
    },
    {
        "id": "houdini",
        "name": "Houdini 1.5a",
        "elo": "3300",
        "style": "Legendary Tactical Attacker & King Hunter",
        "icon": "🎩",
        "is_custom": False,
        "supports_elo": False,
    },
    {
        "id": "rybka",
        "name": "Rybka 2.3",
        "elo": "3200",
        "style": "Dynamic Sacrificial & Aggressive Play",
        "icon": "🐟",
        "is_custom": False,
        "supports_elo": True,
        "min_elo": 1200,
        "max_elo": 2400,
    },
    {
        "id": "critter",
        "name": "Critter 1.6a",
        "elo": "3100",
        "style": "Sharp Tactical & Counter-Attacking",
        "icon": "🦗",
        "is_custom": False,
        "supports_elo": False,
    },
    {
        "id": "andscacs",
        "name": "Andscacs 0.94",
        "elo": "3100",
        "style": "Modern Precise Tactical Defense",
        "icon": "⚔️",
        "is_custom": False,
        "supports_elo": False,
    },
    {
        "id": "patricia",
        "name": "Patricia 4.0",
        "elo": "2800",
        "style": "Fast Alpha-Beta NNUE Tactician",
        "icon": "⚡",
        "is_custom": False,
        "supports_elo": True,
        "min_elo": 1000,
        "max_elo": 2800,
    },
    {
        "id": "fruit",
        "name": "Fruit 2.3.1",
        "elo": "2850",
        "style": "Classical Pure Positional Calculator",
        "icon": "🍎",
        "is_custom": False,
        "supports_elo": False,
    },
    {
        "id": "toga",
        "name": "Deep Toga",
        "elo": "2800",
        "style": "Relentless King-Side Attacker",
        "icon": "🏛️",
        "is_custom": False,
        "supports_elo": False,
    },
    {
        "id": "rodent",
        "name": "Rodent II",
        "elo": "2700",
        "style": "Flexible Classical Club Master",
        "icon": "🐭",
        "is_custom": False,
        "supports_elo": False,
    },
    {
        "id": "cheng",
        "name": "Cheng 4.41",
        "elo": "2600",
        "style": "Solid Balanced Endgame Specialist",
        "icon": "🛡️",
        "is_custom": False,
        "supports_elo": True,
        "min_elo": 800,
        "max_elo": 2600,
    },
    {
        "id": "cdrill2000",
        "name": "CDrill 2000",
        "elo": "2000",
        "style": "Master Practice Sparring Partner",
        "icon": "🎖️",
        "is_custom": False,
        "supports_elo": False,
    },
    {
        "id": "maia1900",
        "name": "Maia 1900",
        "elo": "1900",
        "style": "Human Club Master Neural Network",
        "icon": "🎯",
        "is_custom": False,
        "supports_elo": False,
    },
    {
        "id": "ct800",
        "name": "CT800 V1.46",
        "elo": "1850",
        "style": "Clean Positional Classicist",
        "icon": "🏰",
        "is_custom": False,
        "supports_elo": True,
        "min_elo": 1000,
        "max_elo": 2400,
    },
    {
        "id": "cdrill",
        "name": "CDrill 1800",
        "elo": "1800",
        "style": "Intermediate Training Partner",
        "icon": "🏅",
        "is_custom": False,
        "supports_elo": False,
    },
    {
        "id": "maia1500",
        "name": "Maia 1500",
        "elo": "1500",
        "style": "Human-like Neural Play (Lichess 1500)",
        "icon": "🧠",
        "is_custom": False,
        "supports_elo": False,
    },
    {
        "id": "maia1100",
        "name": "Maia 1100",
        "elo": "1100",
        "style": "Casual Enthusiast Neural Simulation",
        "icon": "🌱",
        "is_custom": False,
        "supports_elo": False,
    },
]

class UCIEngineService:
    """
    Standard Modern UCI Engine Service.
    Supports Stockfish 18, built-in engines, custom user-registered UCI engines,
    and Polyglot (.bin) Opening Book obedience.
    """

    _shared_logs: Dict[str, deque] = {
        "sparring": deque(maxlen=400),
        "kibitzer": deque(maxlen=400),
        "tutor": deque(maxlen=400),
    }

    def log_uci(self, subsystem: str, line: str) -> None:
        """Appends a single line to the specified subsystem ring buffer."""
        if subsystem not in self._shared_logs:
            self._shared_logs[subsystem] = deque(maxlen=400)
        self._shared_logs[subsystem].append(line)

    def log_uci_batch(self, subsystem: str, lines: List[str]) -> None:
        """Appends multiple lines to the specified subsystem ring buffer."""
        if subsystem not in self._shared_logs:
            self._shared_logs[subsystem] = deque(maxlen=400)
        for line in lines:
            self._shared_logs[subsystem].append(line)

    def get_uci_logs(self, subsystem: Optional[str] = None) -> Dict[str, List[str]]:
        """Retrieves circular log buffers as list of lines."""
        if subsystem and subsystem in self._shared_logs:
            return {subsystem: list(self._shared_logs[subsystem])}
        return {k: list(v) for k, v in self._shared_logs.items()}

    def _popen_uci_clean(self, exe_path: str, timeout: float = 8.0) -> Any:
        """Spawns a UCI engine in its own binary directory without console window flashes."""
        abs_exe = os.path.abspath(exe_path)
        exe_dir = os.path.dirname(abs_exe)
        popen_kwargs: Dict[str, Any] = {"timeout": timeout}
        if os.path.isdir(exe_dir):
            popen_kwargs["cwd"] = exe_dir
        if sys.platform == "win32":
            popen_kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
        return chess.engine.SimpleEngine.popen_uci(abs_exe, **popen_kwargs)

    def _configure_maia_weights(
        self,
        engine: Any,
        engine_id: str,
        exe_path: str,
        uci_log: Optional[List[str]] = None,
    ) -> Optional[str]:
        """Configures absolute Maia neural network WeightsFile when running maia* profiles."""
        if "maia" not in (engine_id or "").lower():
            return None
        maia_dir = os.path.dirname(os.path.abspath(exe_path))
        rating = "1500"
        if "1100" in engine_id:
            rating = "1100"
        elif "1900" in engine_id:
            rating = "1900"
        elif "2200" in engine_id:
            rating = "2200"
        weights_path = os.path.join(maia_dir, f"maia-{rating}.pb.gz")
        if os.path.exists(weights_path) and "WeightsFile" in engine.options:
            try:
                engine.configure({"WeightsFile": weights_path})
                if uci_log is not None:
                    uci_log.append(f">>> setoption name WeightsFile value {weights_path}")
                return weights_path
            except Exception as me:
                logger.warning("Could not set Maia WeightsFile: %s", me)
        return None

    def log_engine_handshake(
        self,
        subsystem: str = "sparring",
        engine_id: str = "stockfish",
        elo: Optional[int] = None,
        threads: Optional[int] = None,
        hash_mb: Optional[int] = None,
        book_name: Optional[str] = None,
        use_book: bool = True,
        custom_options: Optional[Dict[str, Any]] = None,
    ) -> List[str]:
        """
        Verifies executable presence and emits standard UCI handshake sequence,
        merging saved custom profile options from UserData/custom_engines.json.
        """
        exe_path = self.get_engine_path(engine_id)
        if not exe_path or not os.path.exists(exe_path):
            err_lines = [f"[ERROR] Engine executable not found for '{engine_id}'"]
            self.log_uci_batch(subsystem, err_lines)
            return err_lines

        custom_cfg = self.get_custom_engine_config(engine_id)
        engine_info = next((e for e in DEFAULT_BUILTIN_ENGINES if e["id"] == engine_id), None)
        engine_name = (custom_cfg or {}).get("name") or (engine_info["name"] if engine_info else engine_id)
        engine_author = (custom_cfg or {}).get("author") or "DeepScout UCI Host"

        merged_opts: Dict[str, Any] = {}
        if custom_cfg and isinstance(custom_cfg.get("options"), dict):
            merged_opts.update(custom_cfg["options"])
        if custom_options and isinstance(custom_options, dict):
            merged_opts.update(custom_options)

        handshake_lines: List[str] = [
            ">>> uci",
            f"<<< id name {engine_name}",
            f"<<< id author {engine_author}",
            "<<< uciok",
        ]

        eff_threads = threads if threads is not None else merged_opts.pop("Threads", None)
        eff_hash = hash_mb if hash_mb is not None else merged_opts.pop("Hash", None)
        merged_opts.pop("Threads", None)
        merged_opts.pop("Hash", None)

        if eff_threads:
            handshake_lines.append(f">>> setoption name Threads value {eff_threads}")
        if eff_hash:
            handshake_lines.append(f">>> setoption name Hash value {eff_hash}")
        if elo is not None:
            handshake_lines.append(">>> setoption name UCI_LimitStrength value true")
            handshake_lines.append(f">>> setoption name UCI_Elo value {elo}")
        if merged_opts:
            sanitized = sanitize_uci_options(merged_opts)
            for k, v in sanitized.items():
                handshake_lines.append(f">>> setoption name {k} value {v}")

        handshake_lines.append(">>> isready")
        handshake_lines.append("<<< readyok")

        is_native_book = not use_book or not book_name or book_name.lower() in ("none", "engine_native")
        if is_native_book:
            handshake_lines.append("[DeepScout Opening] Native Engine Mode (Polyglot bypassed)")
        else:
            handshake_lines.append(f"[DeepScout Opening] Polyglot Active: {book_name}")

        self.log_uci_batch(subsystem, handshake_lines)
        return handshake_lines

    def __init__(self, root_dir: str = ROOT_DIR):
        self.root_dir = root_dir
        self._engine_paths: Dict[str, str] = {}
        self._custom_engines_file = os.path.join(self.root_dir, "UserData", "custom_engines.json")
        self._roles_file = os.path.join(self.root_dir, "UserData", "engine_roles.json")
        self._options_cache: Dict[str, Dict[str, Any]] = {}
        self._options_lock = threading.Lock()
        self._roles_lock = threading.Lock()
        self.book_service = OpeningBookService(self.root_dir)
        self._discover_engines()
        self._load_custom_engines()

    def _discover_engines(self):
        """Scans engine directories for native executables."""
        is_windows = platform.system() == "Windows"
        os_subpath = "win32" if is_windows else "linux"
        candidates_bases = [
            os.path.join(self.root_dir, "engines", os_subpath, "Engines"),
            os.path.join(self.root_dir, "engines", "Engines"),
            os.path.join(self.root_dir, "engines"),
        ]
        engines_base = next((b for b in candidates_bases if os.path.exists(b)), candidates_bases[0])

        def find_exe(subfolder: str, names: List[str]) -> Optional[str]:
            folder = os.path.join(engines_base, subfolder)
            if not os.path.exists(folder):
                return None
            for name in names:
                fn = f"{name}.exe" if is_windows else name
                full_p = os.path.join(folder, fn)
                if os.path.exists(full_p):
                    return full_p
            return None

        # 1. Stockfish
        sf_p = find_exe("stockfish", ["Stockfish-18-x86-64-avx2", "Stockfish-18-64", "Stockfish-18-x86-64", "stockfish-18-64"])
        if sf_p:
            self._engine_paths["stockfish"] = sf_p

        # 2. Dragon / Komodo
        dragon_p = find_exe("komodo", ["dragon-64bit-avx2", "komodo-13.02-64bit"])
        if dragon_p:
            self._engine_paths["dragon"] = dragon_p
            self._engine_paths["komodo"] = dragon_p

        # 3. Houdini
        houdini_p = find_exe("houdini", ["Houdini_15a_w32"])
        if houdini_p:
            self._engine_paths["houdini"] = houdini_p

        # 4. Rybka
        rybka_p = find_exe("rybka", ["Rybka v2.3.2a.w32", "Rybka"])
        if rybka_p:
            self._engine_paths["rybka"] = rybka_p

        # 5. Critter
        critter_p = find_exe("critter", ["Critter_1.6a_32bit", "Critter"])
        if critter_p:
            self._engine_paths["critter"] = critter_p

        # 6. Andscacs
        andscacs_p = find_exe("andscacs", ["andscacs_32_no_popcnt", "andscacs"])
        if andscacs_p:
            self._engine_paths["andscacs"] = andscacs_p

        # 7. Patricia
        patricia_p = find_exe("patricia", ["patricia_4_v2", "patricia"])
        if patricia_p:
            self._engine_paths["patricia"] = patricia_p

        # 8. Fruit
        fruit_p = find_exe("fruit", ["Fruit-2-3-1", "Fruit"])
        if fruit_p:
            self._engine_paths["fruit"] = fruit_p

        # 9. Deep Toga
        toga_p = find_exe("toga", ["DeepToga1.9.6nps", "DeepToga"])
        if toga_p:
            self._engine_paths["toga"] = toga_p

        # 10. Rodent II
        rodent_p = find_exe("rodentII", ["rodentII_x32", "rodentII"])
        if rodent_p:
            self._engine_paths["rodent"] = rodent_p

        # 11. Cheng
        cheng_p = find_exe("cheng", ["cheng4_x64", "cheng4"])
        if cheng_p:
            self._engine_paths["cheng"] = cheng_p

        # 12. CDrill 2000
        cdrill2000_p = find_exe("cdrill2000", ["cdrill_2000"])
        if cdrill2000_p:
            self._engine_paths["cdrill2000"] = cdrill2000_p

        # 13. CT800
        ct800_p = find_exe("ct800", ["CT800_V1.46_x64", "CT800_V1.46", "ct800"])
        if ct800_p:
            self._engine_paths["ct800"] = ct800_p

        # 14. CDrill 1800
        cdrill_p = find_exe("cdrill", ["CDrill_1800_Build_4", "CDrill_1800"])
        if cdrill_p:
            self._engine_paths["cdrill"] = cdrill_p

        # 15. Maia (via lc0)
        maia_dir = os.path.join(engines_base, "maia")
        if os.path.exists(maia_dir):
            lc0_p = os.path.join(maia_dir, "lc0.exe" if is_windows else "lc0")
            if os.path.exists(lc0_p):
                self._engine_paths["maia1100"] = lc0_p
                self._engine_paths["maia1500"] = lc0_p
                self._engine_paths["maia1900"] = lc0_p
                self._engine_paths["maia2200"] = lc0_p

    def _load_custom_engines(self) -> List[Dict[str, Any]]:
        if not os.path.exists(self._custom_engines_file):
            return []
        try:
            with open(self._custom_engines_file, "r", encoding="utf-8") as f:
                custom_list = json.load(f)
                for eng in custom_list:
                    if "id" in eng and "path" in eng and os.path.exists(eng["path"]):
                        self._engine_paths[eng["id"].lower()] = eng["path"]
                return custom_list
        except Exception as e:
            logger.warning("Could not read custom engines file: %s", e)
            return []

    def _save_custom_engines(self, engines: List[Dict[str, Any]]):
        os.makedirs(os.path.dirname(self._custom_engines_file), exist_ok=True)
        with open(self._custom_engines_file, "w", encoding="utf-8") as f:
            json.dump(engines, f, indent=2)

    def get_available_engines(self) -> List[Dict[str, Any]]:
        """Returns all built-in and user-added custom engines, merging user custom options."""
        custom_engines = self._load_custom_engines()
        custom_by_id = {ce["id"].lower(): ce for ce in custom_engines if "id" in ce}
        
        result_engines = []
        for be in DEFAULT_BUILTIN_ENGINES:
            be_id = be["id"].lower()
            if be_id in custom_by_id:
                # Merge custom user overrides
                merged = dict(be)
                custom_item = custom_by_id[be_id]
                merged["options"] = custom_item.get("options", {})
                if custom_item.get("name"): merged["name"] = custom_item["name"]
                if custom_item.get("elo"): merged["elo"] = custom_item["elo"]
                if custom_item.get("style"): merged["style"] = custom_item["style"]
                if custom_item.get("icon"): merged["icon"] = custom_item["icon"]
                merged["is_custom"] = True
                result_engines.append(merged)
            else:
                result_engines.append(dict(be))

        for ce in custom_engines:
            if ce.get("id", "").lower() not in [b["id"].lower() for b in DEFAULT_BUILTIN_ENGINES]:
                ce_copy = dict(ce)
                ce_copy["is_custom"] = True
                result_engines.append(ce_copy)
        return result_engines

    def browse_engine_executable(self) -> Optional[str]:
        """Opens native OS open-file dialog to select a UCI engine binary."""
        if sys.platform == "win32":
            try:
                import ctypes
                from ctypes import wintypes

                class OPENFILENAMEW(ctypes.Structure):
                    _fields_ = [
                        ('lStructSize', wintypes.DWORD),
                        ('hwndOwner', wintypes.HWND),
                        ('hInstance', wintypes.HINSTANCE),
                        ('lpstrFilter', wintypes.LPCWSTR),
                        ('lpstrCustomFilter', wintypes.LPWSTR),
                        ('nMaxCustFilter', wintypes.DWORD),
                        ('nFilterIndex', wintypes.DWORD),
                        ('lpstrFile', wintypes.LPWSTR),
                        ('nMaxFile', wintypes.DWORD),
                        ('lpstrFileTitle', wintypes.LPWSTR),
                        ('nMaxFileTitle', wintypes.DWORD),
                        ('lpstrInitialDir', wintypes.LPCWSTR),
                        ('lpstrTitle', wintypes.LPCWSTR),
                        ('Flags', wintypes.DWORD),
                        ('nFileOffset', wintypes.WORD),
                        ('nFileExtension', wintypes.WORD),
                        ('lpstrDefExt', wintypes.LPCWSTR),
                        ('lCustData', wintypes.LPARAM),
                        ('lpfnHook', wintypes.LPVOID),
                        ('lpTemplateName', wintypes.LPCWSTR),
                        ('pvReserved', wintypes.LPVOID),
                        ('dwReserved', wintypes.DWORD),
                        ('FlagsEx', wintypes.DWORD)
                    ]

                ofn = OPENFILENAMEW()
                ofn.lStructSize = ctypes.sizeof(OPENFILENAMEW)
                buffer = ctypes.create_unicode_buffer(2048)
                ofn.lpstrFile = ctypes.cast(buffer, wintypes.LPWSTR)
                ofn.nMaxFile = 2048
                ofn.lpstrFilter = "Executable Files (*.exe)\0*.exe\0All Files (*.*)\0*.*\0\0"
                ofn.nFilterIndex = 1
                ofn.lpstrTitle = "Select UCI Engine Executable (.exe)"
                
                OFN_FILEMUSTEXIST = 0x00001000
                OFN_PATHMUSTEXIST = 0x00000800
                OFN_EXPLORER = 0x00080000
                OFN_DONTADDTORECENT = 0x02000000
                ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_EXPLORER | OFN_DONTADDTORECENT

                comdlg32 = ctypes.windll.comdlg32
                if comdlg32.GetOpenFileNameW(ctypes.byref(ofn)):
                    res_path = buffer.value
                    if res_path and os.path.isfile(res_path):
                        return res_path
            except Exception as e:
                logger.error("Native Windows browse dialog failed: %s", e)
        return None

    def test_uci_engine(self, executable_path: str) -> Dict[str, Any]:
        """Validates standard UCI handshake and parses all supported UCI options and defaults."""
        clean_path = os.path.expanduser(executable_path.strip().strip('"').strip("'"))
        if not os.path.exists(clean_path):
            return {
                "success": False,
                "error": f"Executable not found at path: {clean_path}",
            }
        if os.path.isdir(clean_path):
            return {
                "success": False,
                "error": f"The selected path is a folder/directory, not an executable file: {clean_path}. Please select a .exe binary.",
            }

        engine = None
        try:
            engine = self._popen_uci_clean(clean_path, timeout=8)
            engine_name = engine.id.get("name", os.path.basename(clean_path))
            engine_author = engine.id.get("author", "Unknown Author")
            
            options_dict: Dict[str, Any] = {}
            for opt_key, opt in engine.options.items():
                options_dict[opt_key] = {
                    "name": opt.name,
                    "type": opt.type,  # 'check', 'spin', 'combo', 'button', 'string'
                    "default": opt.default,
                    "min": getattr(opt, "min", None),
                    "max": getattr(opt, "max", None),
                    "var": list(getattr(opt, "var", [])) if getattr(opt, "var", None) else [],
                    "current": opt.default,
                }

            supports_elo = (
                "UCI_LimitStrength" in engine.options
                or "UCI_Elo" in engine.options
                or "Skill" in engine.options
                or "Skill Level" in engine.options
                or "Skill_Level" in engine.options
            )
            supports_threads = "Threads" in engine.options
            supports_hash = "Hash" in engine.options
            supports_syzygy = "SyzygyPath" in engine.options
            supports_multipv = "MultiPV" in engine.options
            supports_nnue = "EvalFile" in engine.options or "Use NNUE" in engine.options

            return {
                "success": True,
                "name": engine_name,
                "author": engine_author,
                "path": clean_path,
                "supports_elo": supports_elo,
                "supports_threads": supports_threads,
                "supports_hash": supports_hash,
                "supports_syzygy": supports_syzygy,
                "supports_multipv": supports_multipv,
                "supports_nnue": supports_nnue,
                "options": options_dict,
            }
        except Exception as e:
            return {
                "success": False,
                "error": f"UCI Handshake failed: {str(e)}. Ensure this is a valid standard UCI executable.",
            }
        finally:
            if engine is not None:
                try:
                    engine.quit()
                except Exception:
                    pass

    def register_custom_engine(
        self,
        name: str,
        path: str,
        elo: str = "2400",
        style: str = "Custom UCI Engine",
        icon: str = "⚔️",
        options: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Registers and persists a custom UCI engine with its customized UCI options."""
        test_res = self.test_uci_engine(path)
        if not test_res.get("success"):
            raise ValueError(test_res.get("error", "Engine test failed"))

        clean_path = test_res["path"]
        slug = re.sub(r"[^a-z0-9_]+", "_", (name or "engine").lower().strip()).strip("_") or "engine"
        engine_id = f"custom_{slug}_{int(os.path.getsize(clean_path)) % 10000}"

        # Deduplicate strictly by profile id so multiple named profiles / clones
        # sharing the same .exe binary path never delete each other.
        custom_list = self._load_custom_engines()
        custom_list = [e for e in custom_list if e.get("id") != engine_id]

        probed_opts = test_res.get("options", {}) or {}
        clean_opts = sanitize_uci_options(options or {}, supported_options=probed_opts if probed_opts else None)
        new_entry = {
            "id": engine_id,
            "name": name.strip() or test_res.get("name", "Custom Engine"),
            "path": clean_path,
            "elo": elo.strip() or "2400",
            "style": style.strip() or "Custom UCI Tactical Engine",
            "icon": icon or "⚔️",
            "author": test_res.get("author", ""),
            "supports_elo": test_res.get("supports_elo", False),
            "supports_threads": test_res.get("supports_threads", False),
            "supports_hash": test_res.get("supports_hash", False),
            "supports_syzygy": test_res.get("supports_syzygy", False),
            "options": clean_opts,
            "all_options": probed_opts,
            "is_custom": True,
        }
        custom_list.append(new_entry)
        self._save_custom_engines(custom_list)
        self._engine_paths[engine_id.lower()] = clean_path
        if probed_opts:
            with self._options_lock:
                self._options_cache[engine_id.lower()] = copy.deepcopy(probed_opts)
        return new_entry

    def update_custom_engine(self, engine_id: str, update_data: Dict[str, Any]) -> Dict[str, Any]:
        """Updates metadata and customized UCI options for an existing custom engine profile."""
        custom_list = self._load_custom_engines()
        found_idx = -1
        for idx, eng in enumerate(custom_list):
            if eng.get("id", "").lower() == engine_id.lower():
                found_idx = idx
                break

        def _validate_opts(raw_opts: Dict[str, Any], existing_schema: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
            schema = existing_schema
            if not schema:
                with self._options_lock:
                    schema = self._options_cache.get(engine_id.lower())
            if not schema and self.get_engine_path(engine_id):
                schema = self.probe_uci_options(engine_id)
            return sanitize_uci_options(raw_opts, supported_options=schema if schema else None)

        if found_idx == -1:
            # Check if this is a built-in engine being customized
            builtin_eng = next((e for e in DEFAULT_BUILTIN_ENGINES if e["id"].lower() == engine_id.lower()), None)
            if builtin_eng:
                exe_path = self.get_engine_path(engine_id)
                validated_opts = (
                    _validate_opts(update_data["options"])
                    if isinstance(update_data.get("options"), dict)
                    else {}
                )
                new_entry = {
                    "id": builtin_eng["id"],
                    "name": update_data.get("name", builtin_eng["name"]),
                    "path": exe_path or "",
                    "elo": update_data.get("elo", builtin_eng["elo"]),
                    "style": update_data.get("style", builtin_eng["style"]),
                    "icon": update_data.get("icon", builtin_eng.get("icon", "⚔️")),
                    "supports_elo": builtin_eng.get("supports_elo", False),
                    "options": validated_opts,
                    "is_custom": True,
                }
                custom_list.append(new_entry)
                self._save_custom_engines(custom_list)
                return new_entry
            raise ValueError(f"Engine with id '{engine_id}' not found.")

        current = dict(custom_list[found_idx])
        if "name" in update_data and update_data["name"]:
            current["name"] = str(update_data["name"]).strip()
        if "elo" in update_data and update_data["elo"]:
            current["elo"] = str(update_data["elo"]).strip()
        if "style" in update_data and update_data["style"]:
            current["style"] = str(update_data["style"]).strip()
        if "icon" in update_data and update_data["icon"]:
            current["icon"] = str(update_data["icon"]).strip()
        if "options" in update_data and isinstance(update_data["options"], dict):
            current["options"] = _validate_opts(
                update_data["options"],
                existing_schema=current.get("all_options") if isinstance(current.get("all_options"), dict) else None,
            )

        custom_list[found_idx] = current
        self._save_custom_engines(custom_list)
        return current

    def clone_engine(self, source_id: str, new_name: str, options_override: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """Duplicates an existing built-in or custom engine into a new customizable profile."""
        src_path = self.get_engine_path(source_id)
        if not src_path or not os.path.exists(src_path):
            raise ValueError(f"Source engine '{source_id}' binary not found on disk.")

        # Find base config
        base_eng = next((e for e in self.get_available_engines() if e["id"].lower() == source_id.lower()), None)
        base_icon = base_eng.get("icon", "⚔️") if base_eng else "⚔️"
        base_elo = base_eng.get("elo", "2400") if base_eng else "2400"
        base_style = base_eng.get("style", "Custom Cloned Engine") if base_eng else "Custom Cloned Engine"
        base_options = dict(base_eng.get("options", {})) if base_eng else {}
        if options_override:
            base_options.update(options_override)

        clean_name = new_name.strip() or f"{source_id.capitalize()} (Custom Profile)"
        return self.register_custom_engine(
            name=clean_name,
            path=src_path,
            elo=str(base_elo),
            style=f"Custom Profile: {clean_name}",
            icon=base_icon,
            options=base_options,
        )

    def remove_custom_engine(self, engine_id: str) -> Dict[str, Any]:
        """Removes a registered custom engine."""
        custom_list = self._load_custom_engines()
        filtered = [e for e in custom_list if e.get("id") != engine_id]
        self._save_custom_engines(filtered)
        if engine_id.lower() in self._engine_paths:
            del self._engine_paths[engine_id.lower()]
        with self._options_lock:
            self._options_cache.pop(engine_id.lower(), None)
        return {"success": True, "removed_id": engine_id}

    def get_custom_engine_config(self, engine_id: str) -> Optional[Dict[str, Any]]:
        custom_list = self._load_custom_engines()
        for eng in custom_list:
            if eng.get("id", "").lower() == engine_id.lower():
                return eng
        return None

    def get_engine_path(self, engine_id: str = "stockfish") -> Optional[str]:
        engine_id_clean = (engine_id or "stockfish").lower()
        if engine_id_clean in self._engine_paths and os.path.exists(self._engine_paths[engine_id_clean]):
            return self._engine_paths[engine_id_clean]
        # Reload custom engines in case a profile was newly added
        self._load_custom_engines()
        if engine_id_clean in self._engine_paths and os.path.exists(self._engine_paths[engine_id_clean]):
            return self._engine_paths[engine_id_clean]
        return None

    def probe_uci_options(self, engine_id: str, force_refresh: bool = False) -> Dict[str, Any]:
        """
        Probes and caches native UCI protocol options strictly keyed by `engine_id`.
        Always runs with strict timeout + `try ... finally: engine.quit()` and returns
        a deep copy so option schemas can never transpose or leak across engines.
        """
        cache_key = (engine_id or "stockfish").strip().lower()
        if not force_refresh:
            with self._options_lock:
                cached = self._options_cache.get(cache_key)
                if cached is not None:
                    return copy.deepcopy(cached)

        exe_path = self.get_engine_path(engine_id)
        if not exe_path or not os.path.exists(exe_path):
            return {}

        res = self.test_uci_engine(exe_path)
        options = res.get("options", {}) if res.get("success") else {}
        if options:
            with self._options_lock:
                self._options_cache[cache_key] = copy.deepcopy(options)
        return copy.deepcopy(options)

    def get_engine_options(self, engine_id: str, force_refresh: bool = False) -> Dict[str, Any]:
        """Retrieves all native UCI options strictly isolated for `engine_id`."""
        return self.probe_uci_options(engine_id, force_refresh=force_refresh)

    # -------------------------------------------------------------------------
    # Role Slot Persistence (UserData/engine_roles.json)
    # -------------------------------------------------------------------------

    def _default_engine_roles(self) -> Dict[str, Any]:
        hw = get_hardware_profile()
        return {
            "analyzer": {
                "engine_id": "stockfish",
                "uci_overrides": {},
                "preset": "deep",
                "search_mode": "depth",
                "depth": 18,
                "movetime_ms": None,
                "multipv": 1,
                "workers_mode": "auto",
                "manual_workers": hw["default_auto_workers"],
                "manual_threads": 1,
            },
            "sparring": {
                "engine_id": "stockfish",
                "uci_overrides": {},
            },
            "kibitzer": {
                "engine_id": "patricia",
                "uci_overrides": {},
            },
            "tutor": {
                "engine_id": "stockfish",
                "uci_overrides": {},
            },
        }

    def _load_engine_roles(self) -> Dict[str, Any]:
        defaults = self._default_engine_roles()
        with self._roles_lock:
            if not os.path.exists(self._roles_file):
                return defaults
            try:
                with open(self._roles_file, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                if not isinstance(raw, dict):
                    return defaults
                merged = copy.deepcopy(defaults)
                for role in VALID_ENGINE_ROLES:
                    if isinstance(raw.get(role), dict):
                        merged[role].update(raw[role])
                return merged
            except Exception as e:
                logger.warning("Failed reading engine_roles.json: %s", e)
                return defaults

    def _save_engine_roles(self, roles: Dict[str, Any]) -> None:
        os.makedirs(os.path.dirname(self._roles_file), exist_ok=True)
        tmp_path = self._roles_file + ".tmp"
        with self._roles_lock:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(roles, f, indent=2)
            os.replace(tmp_path, self._roles_file)

    def get_engine_roles(self) -> Dict[str, Any]:
        """Returns all role slot configurations plus live hardware sizing telemetry."""
        roles = self._load_engine_roles()
        hw = get_hardware_profile()
        analyzer_id = roles["analyzer"].get("engine_id", "stockfish")
        analyzer_path = self.get_engine_path(analyzer_id)
        with self._options_lock:
            analyzer_schema = self._options_cache.get(analyzer_id.lower())
        roles["analyzer"]["is_neural_gpu"] = is_neural_gpu_engine(
            analyzer_id, exe_path=analyzer_path, options_schema=analyzer_schema
        )
        return {
            "roles": roles,
            "hardware": hw,
            "presets": ANALYSIS_PRESETS,
        }

    def update_engine_role(self, role: str, update_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validates and persists role binding + isolated user-defined UCI options
        to `UserData/engine_roles.json`. Preserves all valid user UCI options verbatim
        without silently overriding UCI_LimitStrength or Ponder.
        """
        role_key = (role or "").strip().lower()
        if role_key not in VALID_ENGINE_ROLES:
            raise ValueError(f"Unknown engine role '{role}'. Must be one of {VALID_ENGINE_ROLES}.")

        roles = self._load_engine_roles()
        current = dict(roles[role_key])
        prev_engine_id = str(current.get("engine_id") or "").lower()

        new_engine_id = str(update_data.get("engine_id") or current.get("engine_id") or "stockfish").strip()
        engine_changed = new_engine_id.lower() != prev_engine_id
        current["engine_id"] = new_engine_id

        # If engine changed and caller did not explicitly supply new uci_overrides,
        # clear stale options from the previous engine to guarantee zero transposition.
        if "uci_overrides" in update_data and isinstance(update_data["uci_overrides"], dict):
            raw_overrides = dict(update_data["uci_overrides"])
        elif engine_changed:
            raw_overrides = {}
        else:
            raw_overrides = dict(current.get("uci_overrides") or {})

        # Validate overrides strictly against the target engine's supported options when available
        supported_schema = None
        if raw_overrides:
            with self._options_lock:
                supported_schema = self._options_cache.get(new_engine_id.lower())
            if supported_schema is None:
                custom_cfg = self.get_custom_engine_config(new_engine_id)
                if custom_cfg and isinstance(custom_cfg.get("all_options"), dict) and custom_cfg["all_options"]:
                    supported_schema = custom_cfg["all_options"]
            if supported_schema is None and self.get_engine_path(new_engine_id):
                probed = self.probe_uci_options(new_engine_id)
                if probed:
                    supported_schema = probed
            current["uci_overrides"] = sanitize_uci_options(raw_overrides, supported_options=supported_schema)
        else:
            current["uci_overrides"] = {}

        if role_key == "analyzer":
            if "preset" in update_data and update_data["preset"] in ("quick", "narrow", "deep", "thorough", "custom"):
                current["preset"] = update_data["preset"]
            if "search_mode" in update_data and update_data["search_mode"] in ("depth", "movetime", "hybrid"):
                current["search_mode"] = update_data["search_mode"]
            if "depth" in update_data and update_data["depth"] is not None:
                current["depth"] = max(4, min(60, int(update_data["depth"])))
            if "movetime_ms" in update_data:
                mt = update_data["movetime_ms"]
                current["movetime_ms"] = max(50, min(60000, int(mt))) if mt is not None else None
            if "multipv" in update_data and update_data["multipv"] is not None:
                current["multipv"] = max(1, min(10, int(update_data["multipv"])))
            if "workers_mode" in update_data and update_data["workers_mode"] in ("auto", "manual"):
                current["workers_mode"] = update_data["workers_mode"]
            if "manual_workers" in update_data and update_data["manual_workers"] is not None:
                current["manual_workers"] = max(1, min(32, int(update_data["manual_workers"])))
            if "manual_threads" in update_data and update_data["manual_threads"] is not None:
                current["manual_threads"] = max(1, min(32, int(update_data["manual_threads"])))

        roles[role_key] = current
        self._save_engine_roles(roles)

        hw = get_hardware_profile()
        result_role = copy.deepcopy(current)
        if role_key == "analyzer":
            result_role["is_neural_gpu"] = is_neural_gpu_engine(
                new_engine_id,
                exe_path=self.get_engine_path(new_engine_id),
                options_schema=supported_schema,
            )
        return {
            "success": True,
            "role": role_key,
            "config": result_role,
            "roles": self._load_engine_roles(),
            "hardware": hw,
            "presets": ANALYSIS_PRESETS,
        }

    def play_move(
        self,
        fen: str,
        engine_id: str = "stockfish",
        elo: Optional[int] = None,
        time_limit_sec: float = 0.4,
        depth: Optional[int] = None,
        threads: Optional[int] = None,
        hash_mb: Optional[int] = None,
        book_name: Optional[str] = None,
        use_book: bool = True,
    ) -> Dict[str, Any]:
        """
        Executes standard modern UCI 'play' / 'go' commands to return the best engine move.
        First probes the active Polyglot opening book; if in book, plays book move instantly.
        """
        board = chess.Board(fen)
        if board.is_game_over():
            return {
                "success": False,
                "error": "Game is already over in this position.",
                "is_game_over": True,
            }

        # 1. Probe Polyglot Opening Book
        is_native_book = not use_book or not book_name or book_name.lower() in ("none", "engine_native")
        if is_native_book:
            self.log_uci("sparring", "[DeepScout Opening] Native Engine Mode (Polyglot bypassed)")
        elif self.book_service:
            book_probe = self.book_service.probe_book(board, book_name=book_name)
            if book_probe is not None:
                candidates = book_probe.get("candidates", [])
                uci_log = [
                    f"[DeepScout Opening] Polyglot Active: {book_probe['book_name']}",
                    f"[POLYGLOT] Probing active opening book: '{book_probe['book_name']}'",
                    f"[POLYGLOT] [OK] Position found in theory with {len(candidates)} candidate variation(s).",
                    f"[POLYGLOT] Selected weighted move: {book_probe['best_move_san']} ({book_probe['best_move_uci']}) [Weight: {book_probe['weight']}]",
                ]
                self.log_uci_batch("sparring", uci_log)
                telemetry = {
                    "source": "opening_book",
                    "engine_name": engine_id,
                    "book_name": book_probe["book_name"],
                    "is_book_move": True,
                    "weight": book_probe["weight"],
                    "candidates": candidates,
                    "active_options": {"Polyglot Book": book_probe["book_name"], "Status": "In Opening Book"},
                    "nps": "Instant (Book Lookup)",
                    "nodes": len(candidates),
                    "depth": 1,
                    "seldepth": 1,
                    "time_ms": 2,
                    "hashfull": 0,
                    "tbhits": 0,
                    "score": "+0.00",
                    "uci_log": uci_log,
                }
                return {
                    "success": True,
                    "engine": engine_id,
                    "best_move_uci": book_probe["best_move_uci"],
                    "best_move_san": book_probe["best_move_san"],
                    "from_square": book_probe["from_square"],
                    "to_square": book_probe["to_square"],
                    "eval_score": "+0.00",
                    "eval_cp": 0,
                    "depth": 1,
                    "pv_san": [book_probe["best_move_san"]],
                    "pv_uci": [book_probe["best_move_uci"]],
                    "is_book_move": True,
                    "book_name": book_probe["book_name"],
                    "book_weight": book_probe["weight"],
                    "book_candidates": candidates,
                    "telemetry": telemetry,
                }
            else:
                self.log_uci("sparring", f"[DeepScout Opening] Polyglot Active: {book_name} (out of book theory)")

        exe_path = self.get_engine_path(engine_id)
        if not exe_path or not os.path.exists(exe_path):
            import random
            legal_moves = list(board.legal_moves)
            chosen = random.choice(legal_moves)
            san_move = board.san(chosen)
            err_msg = f"Engine executable not found for '{engine_id}'. Played fallback move."
            fallback_log = [f"[ERROR] {err_msg}"]
            self.log_uci_batch("sparring", fallback_log)
            return {
                "success": True,
                "engine": engine_id,
                "best_move_uci": chosen.uci(),
                "best_move_san": san_move,
                "from_square": chess.square_name(chosen.from_square),
                "to_square": chess.square_name(chosen.to_square),
                "eval_score": "+0.00",
                "eval_cp": 0,
                "depth": 1,
                "pv_san": [san_move],
                "pv_uci": [chosen.uci()],
                "is_fallback": True,
                "error": err_msg,
                "telemetry": {
                    "source": "random_fallback",
                    "engine_name": "Fallback Engine",
                    "is_book_move": False,
                    "uci_log": fallback_log,
                },
            }

        engine = None
        try:
            engine = self._popen_uci_clean(exe_path, timeout=10)
            engine_name = engine.id.get("name", engine_id)
            engine_author = engine.id.get("author", "Unknown Author")
            applied_options: Dict[str, Any] = {}
            uci_log: List[str] = [
                ">>> uci",
                f"<<< id name {engine_name}",
                f"<<< id author {engine_author}",
                "<<< uciok",
            ]
            
            # Special configuration for Maia Neural Network models
            w_applied = self._configure_maia_weights(engine, engine_id, exe_path, uci_log)
            if w_applied:
                applied_options["WeightsFile"] = w_applied

            # Apply configured custom UCI options if available
            custom_cfg = self.get_custom_engine_config(engine_id)
            if custom_cfg and "options" in custom_cfg and isinstance(custom_cfg["options"], dict):
                config_to_apply = {}
                for k, v in custom_cfg["options"].items():
                    if k in engine.options and v is not None and v != "<empty>":
                        opt_meta = engine.options.get(k)
                        if opt_meta and getattr(opt_meta, "type", "") == "button":
                            continue
                        if k.lower() == "multipv":
                            continue
                        config_to_apply[k] = v
                if config_to_apply:
                    applied = safe_engine_configure(engine, config_to_apply, f"custom options for {engine_id}")
                    for k, v in applied.items():
                        applied_options[k] = v
                        uci_log.append(f">>> setoption name {k} value {v}")

            # Apply explicit Quick Tuning overrides (Threads / Number of Threads / Hash) if supplied
            runtime_overrides: Dict[str, Any] = {}
            threads_key = resolve_threads_option_key(engine.options)
            if threads is not None and threads_key:
                t_opt = engine.options[threads_key]
                t_min = getattr(t_opt, "min", 1) or 1
                t_max = getattr(t_opt, "max", 32) or 32
                runtime_overrides[threads_key] = max(t_min, min(t_max, int(threads)))
            if hash_mb is not None and "Hash" in engine.options:
                h_opt = engine.options["Hash"]
                h_min = getattr(h_opt, "min", 1) or 1
                h_max = getattr(h_opt, "max", 4096) or 4096
                runtime_overrides["Hash"] = max(h_min, min(h_max, int(hash_mb)))
            if runtime_overrides:
                applied_rt = safe_engine_configure(engine, runtime_overrides, f"runtime tuning for {engine_id}")
                for k, v in applied_rt.items():
                    applied_options[k] = v
                    uci_log.append(f">>> setoption name {k} value {v}")

            # Universal Elo / Skill strength limit configuration
            if elo is not None:
                target_elo = int(elo)
                min_e = 800
                max_e = 3190
                if "UCI_Elo" in engine.options:
                    min_e = getattr(engine.options["UCI_Elo"], "min", 800) or 800
                    max_e = getattr(engine.options["UCI_Elo"], "max", 3190) or 3190
                scaled_elo = max(min_e, min(max_e, target_elo))
                try:
                    safe_engine_configure(engine, {"UCI_LimitStrength": True}, "UCI_LimitStrength")
                    applied_options["UCI_LimitStrength"] = True
                    uci_log.append(">>> setoption name UCI_LimitStrength value true")
                except Exception as elo_err:
                    logger.warning("Failed to configure UCI_LimitStrength: %s", elo_err)
                try:
                    safe_engine_configure(engine, {"UCI_Elo": scaled_elo}, "UCI_Elo")
                    applied_options["UCI_Elo"] = scaled_elo
                    uci_log.append(f">>> setoption name UCI_Elo value {scaled_elo}")
                except Exception as elo_err:
                    logger.warning("Failed to configure UCI_Elo: %s", elo_err)

                # 2. Komodo / Dragon "Skill" option (0..25)
                if "Skill" in engine.options:
                    try:
                        max_s = getattr(engine.options["Skill"], "max", 25) or 25
                        min_s = getattr(engine.options["Skill"], "min", 0) or 0
                        skill_val = max(min_s, min(max_s, int(round((target_elo - 1000) / 2500.0 * (max_s - min_s) + min_s))))
                        safe_engine_configure(engine, {"Skill": skill_val}, "Skill")
                        applied_options["Skill"] = skill_val
                        uci_log.append(f">>> setoption name Skill value {skill_val} (mapped from {target_elo} Elo)")
                    except Exception as skill_err:
                        logger.warning("Failed to configure Skill option: %s", skill_err)

                # 3. Stockfish / Patricia "Skill Level" / "Skill_Level" (0..20)
                for skill_key in ["Skill Level", "Skill_Level"]:
                    if skill_key in engine.options and "UCI_LimitStrength" not in engine.options:
                        try:
                            max_sl = getattr(engine.options[skill_key], "max", 20) or 20
                            min_sl = getattr(engine.options[skill_key], "min", 0) or 0
                            skill_lvl = max(min_sl, min(max_sl, int(round((target_elo - 1000) / 2200.0 * (max_sl - min_sl) + min_sl))))
                            safe_engine_configure(engine, {skill_key: skill_lvl}, skill_key)
                            applied_options[skill_key] = skill_lvl
                            uci_log.append(f">>> setoption name {skill_key} value {skill_lvl} (mapped from {target_elo} Elo)")
                        except Exception as sl_err:
                            logger.warning("Failed to configure %s: %s", skill_key, sl_err)

            uci_log.append(">>> isready")
            uci_log.append("<<< readyok")
            if is_native_book:
                uci_log.append("[DeepScout Opening] Native Engine Mode (Polyglot bypassed)")
            else:
                uci_log.append(f"[DeepScout Opening] Polyglot Active: {book_name}")
            uci_log.append(f">>> position fen {fen}")
            uci_log.append(f">>> go movetime {int(time_limit_sec * 1000)}")

            effective_time = max(0.15, time_limit_sec)
            limit = chess.engine.Limit(time=effective_time, depth=depth)
            
            play_result = engine.play(board, limit)
            best_move = play_result.move

            if best_move is None:
                raise ValueError("Engine returned no move")

            san_move = board.san(best_move)
            
            # Quick evaluation & PV
            eval_score = "+0.00"
            eval_cp = 0
            pv_san = [san_move]
            pv_uci = [best_move.uci()]
            info_depth = depth or 12
            info_data: Dict[str, Any] = {}

            try:
                info = engine.analyse(board, chess.engine.Limit(time=min(0.15, effective_time)), info=chess.engine.INFO_ALL)
                info_data = info
                info_depth = info.get("depth", info_depth)
                score_obj = info.get("score")
                if score_obj is not None:
                    pov_score = score_obj.white()
                    if pov_score.is_mate():
                        mate_moves = pov_score.mate()
                        eval_score = f"#{mate_moves}" if mate_moves else "#0"
                    else:
                        cp_val = pov_score.score()
                        eval_cp = cp_val if cp_val is not None else 0
                        eval_score = f"{eval_cp / 100.0:+.2f}"

                if "pv" in info and info["pv"]:
                    pv_uci = [m.uci() for m in info["pv"][:5]]
                    temp_board = board.copy()
                    pv_san_list = []
                    for m in info["pv"][:5]:
                        if m in temp_board.legal_moves:
                            pv_san_list.append(temp_board.san(m))
                            temp_board.push(m)
                    if pv_san_list:
                        pv_san = pv_san_list
            except Exception as e:
                logger.warning("Secondary analysis failed: %s", e)

            engine.quit()
            engine = None

            nps_val = info_data.get("nps", 0)
            nodes_val = info_data.get("nodes", 0)
            seldepth_val = info_data.get("seldepth", info_depth)
            time_ms_val = round((info_data.get("time") or effective_time) * 1000, 1)
            hashfull_val = info_data.get("hashfull", 0)
            tbhits_val = info_data.get("tbhits", 0)

            uci_log.append(f"<<< info depth {info_depth} seldepth {seldepth_val} score cp {eval_cp} nodes {nodes_val} nps {nps_val} time {int(time_ms_val)} hashfull {hashfull_val} pv {' '.join(pv_uci)}")
            uci_log.append(f"<<< bestmove {best_move.uci()}")
            self.log_uci_batch("sparring", uci_log)

            telemetry = {
                "source": "uci_engine",
                "engine_name": engine_name,
                "engine_author": engine_author,
                "engine_id": engine_id,
                "is_book_move": False,
                "active_options": applied_options,
                "nps": nps_val,
                "nodes": nodes_val,
                "depth": info_depth,
                "seldepth": seldepth_val,
                "time_ms": time_ms_val,
                "hashfull": hashfull_val,
                "tbhits": tbhits_val,
                "score": eval_score,
                "pv_san": pv_san,
                "pv_uci": pv_uci,
                "uci_log": uci_log,
            }

            return {
                "success": True,
                "engine": engine_id,
                "best_move_uci": best_move.uci(),
                "best_move_san": san_move,
                "from_square": chess.square_name(best_move.from_square),
                "to_square": chess.square_name(best_move.to_square),
                "eval_score": eval_score,
                "eval_cp": eval_cp,
                "depth": info_depth,
                "pv_san": pv_san,
                "pv_uci": pv_uci,
                "telemetry": telemetry,
            }
        except Exception as err:
            logger.error("UCI Engine error: %s", err)
            err_line = f"[ERROR] Engine '{engine_id}' failed during move search: {err}"
            self.log_uci("sparring", err_line)
            legal_moves = list(board.legal_moves)
            if not legal_moves:
                return {"success": False, "error": "No legal moves available."}
            chosen = legal_moves[0]
            return {
                "success": True,
                "engine": engine_id,
                "best_move_uci": chosen.uci(),
                "best_move_san": board.san(chosen),
                "from_square": chess.square_name(chosen.from_square),
                "to_square": chess.square_name(chosen.to_square),
                "eval_score": "+0.00",
                "eval_cp": 0,
                "depth": 1,
                "pv_san": [board.san(chosen)],
                "pv_uci": [chosen.uci()],
                "is_fallback": True,
                "error": str(err),
                "telemetry": {
                    "source": "error_fallback",
                    "engine_name": engine_id,
                    "is_book_move": False,
                    "uci_log": [err_line],
                },
            }
        finally:
            if engine is not None:
                try:
                    engine.quit()
                except Exception:
                    pass

    def evaluate_position(
        self,
        fen: str,
        depth: int = 14,
        time_limit_sec: float = 0.3,
        engine_id: str = "stockfish",
        subsystem: str = "tutor",
    ) -> Dict[str, Any]:
        """Performs non-blocking position evaluation and principal variation extraction."""
        board = chess.Board(fen)
        exe_path = self.get_engine_path(engine_id)
        if not exe_path or not os.path.exists(exe_path):
            return {
                "success": False,
                "eval_score": "+0.00",
                "eval_cp": 0,
                "best_move_san": "",
                "best_move_uci": "",
                "main_line": "",
                "depth": 0,
                "uci_log": ["[WARN] Engine executable not found for evaluation."],
            }

        engine = None
        try:
            engine = self._popen_uci_clean(exe_path, timeout=8)
            engine_name = engine.id.get("name", engine_id)
            engine_author = engine.id.get("author", "Unknown Author")
            uci_log: List[str] = [
                ">>> uci",
                f"<<< id name {engine_name}",
                f"<<< id author {engine_author}",
                "<<< uciok",
            ]

            self._configure_maia_weights(engine, engine_id, exe_path, uci_log)
            
            # Apply configured custom UCI options if available
            custom_cfg = self.get_custom_engine_config(engine_id)
            if custom_cfg and "options" in custom_cfg and isinstance(custom_cfg["options"], dict):
                config_to_apply = {}
                for k, v in custom_cfg["options"].items():
                    if k in engine.options and v is not None and v != "<empty>":
                        opt_meta = engine.options.get(k)
                        if opt_meta and getattr(opt_meta, "type", "") == "button":
                            continue
                        if k.lower() == "multipv":
                            continue
                        config_to_apply[k] = v
                if config_to_apply:
                    applied = safe_engine_configure(engine, config_to_apply, f"eval options for {engine_id}")
                    for k, v in applied.items():
                        uci_log.append(f">>> setoption name {k} value {v}")

            uci_log.append(">>> isready")
            uci_log.append("<<< readyok")
            uci_log.append(f">>> position fen {fen}")
            uci_log.append(f">>> go depth {depth}")

            info = engine.analyse(board, chess.engine.Limit(time=time_limit_sec, depth=depth))
            # Some engines (e.g. Rodent II) report a score but no PV; ask for a plain best move instead.
            fallback_move = None
            if not info.get("pv"):
                try:
                    fallback_move = engine.play(board, chess.engine.Limit(time=min(time_limit_sec, 0.5))).move
                except Exception as fb_err:
                    logger.warning("Best-move fallback failed for %s: %s", engine_id, fb_err)
            engine.quit()
            engine = None

            score_obj = info.get("score")
            eval_score = "+0.00"
            eval_cp = 0
            # Side-to-move POV (additive fields; eval_cp above stays White-POV for existing consumers).
            stm_cp = 0
            is_mate = False
            mate_in_stm = None
            if score_obj:
                pov_score = score_obj.white()
                if pov_score.is_mate():
                    mate_val = pov_score.mate()
                    eval_score = f"#{mate_val}" if mate_val else "#0"
                else:
                    cp_val = pov_score.score()
                    eval_cp = cp_val if cp_val is not None else 0
                    eval_score = f"{eval_cp / 100.0:+.2f}"

                stm_pov = score_obj.pov(board.turn)
                if stm_pov.is_mate():
                    is_mate = True
                    mate_in_stm = stm_pov.mate()
                    if mate_in_stm is not None and mate_in_stm != 0:
                        stm_cp = (10000 - abs(mate_in_stm) * 100) if mate_in_stm > 0 else (-10000 + abs(mate_in_stm) * 100)
                    else:
                        # Mate delivered/received on the board right now (mate in 0 => side to move is mated)
                        stm_cp = -10000
                else:
                    stm_val = stm_pov.score()
                    stm_cp = stm_val if stm_val is not None else 0

            pv_moves = info.get("pv", [])
            if not pv_moves and fallback_move is not None:
                pv_moves = [fallback_move]
            best_move_uci = pv_moves[0].uci() if pv_moves else ""
            best_move_san = board.san(pv_moves[0]) if pv_moves and pv_moves[0] in board.legal_moves else ""

            temp_board = board.copy()
            main_line_tokens = []
            for m in pv_moves[:6]:
                if m in temp_board.legal_moves:
                    main_line_tokens.append(temp_board.san(m))
                    temp_board.push(m)

            uci_log.append(f"<<< info depth {info.get('depth', depth)} score cp {eval_cp} pv {' '.join(main_line_tokens[:3])}")
            if best_move_uci:
                uci_log.append(f"<<< bestmove {best_move_uci}")

            self.log_uci_batch(subsystem, uci_log)

            return {
                "success": True,
                "eval_score": eval_score,
                "eval_cp": eval_cp,
                "stm_cp": stm_cp,
                "is_mate": is_mate,
                "mate_in": mate_in_stm,
                "best_move_san": best_move_san,
                "best_move_uci": best_move_uci,
                "main_line": " ".join(main_line_tokens),
                "depth": info.get("depth", depth),
                "uci_log": uci_log,
            }
        except Exception as err:
            logger.error("Evaluation failed: %s", err)
            return {
                "success": False,
                "eval_score": "+0.00",
                "eval_cp": 0,
                "best_move_san": "",
                "best_move_uci": "",
                "main_line": "",
                "depth": 0,
                "error": str(err),
            }
        finally:
            if engine is not None:
                try:
                    engine.quit()
                except Exception:
                    pass

    def request_variations(
        self,
        fen: str,
        engine_id: str = "patricia",
        depth: int = 14,
        multipv: int = 3,
        time_limit_sec: Optional[float] = None,
        threads: int = 1,
        hash_mb: int = 64,
        subsystem: str = "kibitzer",
    ) -> Dict[str, Any]:
        """
        Extracts multi-PV candidate lines and applies Section 6 Tag Classifier.
        """
        from core.features.engine.tag_classifier import classify_multipv
        board = chess.Board(fen)
        if board.is_game_over():
            return {
                "variations": [],
                "uci_log": [],
                "uci_options": {},
            }

        exe_path = self.get_engine_path(engine_id)
        if not exe_path or not os.path.exists(exe_path):
            return {
                "variations": [],
                "uci_log": [f"[ERROR] Engine executable not found: {exe_path}"],
                "uci_options": {},
            }

        uci_log: List[str] = []
        uci_options: Dict[str, Any] = {}

        engine = None
        try:
            engine = self._popen_uci_clean(exe_path, timeout=8)
            engine_name = engine.id.get("name", engine_id)
            engine_author = engine.id.get("author", "Unknown Author")
            
            uci_log.append(">>> uci")
            uci_log.append(f"<<< id name {engine_name}")
            uci_log.append(f"<<< id author {engine_author}")
            uci_log.append("<<< uciok")

            w_applied = self._configure_maia_weights(engine, engine_id, exe_path, uci_log)
            if w_applied:
                uci_options["WeightsFile"] = w_applied

            # Apply custom options from profile first
            custom_cfg = self.get_custom_engine_config(engine_id)
            if custom_cfg and "options" in custom_cfg and isinstance(custom_cfg["options"], dict):
                config_to_apply = {}
                for k, v in custom_cfg["options"].items():
                    if k in engine.options and v is not None and v != "<empty>":
                        opt_meta = engine.options.get(k)
                        if opt_meta and getattr(opt_meta, "type", "") == "button":
                            continue
                        if k.lower() == "multipv":
                            continue
                        config_to_apply[k] = v
                if config_to_apply:
                    applied = safe_engine_configure(engine, config_to_apply, f"variations custom config for {engine_id}")
                    uci_options.update(applied)

            uci_opts = {}
            if "Threads" in engine.options:
                th_val = max(1, min(32, threads))
                uci_opts["Threads"] = th_val
                uci_log.append(f">>> setoption name Threads value {th_val}")
            if "Hash" in engine.options:
                h_val = max(16, min(4096, hash_mb))
                uci_opts["Hash"] = h_val
                uci_log.append(f">>> setoption name Hash value {h_val}")
            
            if uci_opts:
                applied = safe_engine_configure(engine, uci_opts, f"threads/hash for {engine_id}")
                uci_options.update(applied)

            multipv_supported = "MultiPV" in engine.options
            actual_multipv = max(1, min(multipv, 15)) if multipv_supported else 1

            if multipv_supported and actual_multipv > 1:
                # In python-chess, MultiPV is automatically managed as an argument
                # to engine.analyse(..., multipv=n). Calling engine.configure({"MultiPV": ...})
                # raises ValueError ("cannot set MultiPV which is automatically managed").
                uci_options["MultiPV"] = actual_multipv
                uci_log.append(f">>> setoption name MultiPV value {actual_multipv}")

            uci_log.append(">>> isready")
            uci_log.append("<<< readyok")
            uci_log.append(f">>> position fen {fen}")
            uci_log.append(f">>> go depth {depth}")

            limit = chess.engine.Limit(time=time_limit_sec, depth=depth)
            analysis_results = engine.analyse(board, limit, multipv=actual_multipv)
            engine.quit()
            engine = None

            if isinstance(analysis_results, dict):
                analysis_results = [analysis_results]

            raw_lines: List[Dict[str, Any]] = []
            for item in analysis_results:
                score_obj = item.get("score")
                score_cp = None
                is_mate = False
                mate_in = None
                if score_obj:
                    pov_score = score_obj.white() if board.turn == chess.WHITE else score_obj.black()
                    if pov_score.is_mate():
                        is_mate = True
                        mate_in = pov_score.mate()
                    else:
                        score_cp = pov_score.score()

                pv_moves = item.get("pv", [])
                pv_uci_list = [m.uci() for m in pv_moves[:8]]
                
                temp_board = board.copy()
                pv_san_list = []
                for m in pv_moves[:8]:
                    if m in temp_board.legal_moves:
                        pv_san_list.append(temp_board.san(m))
                        temp_board.push(m)

                line_depth = item.get("depth", depth)
                nps_val = item.get("nps")

                uci_log.append(f"<<< info depth {line_depth} score cp {score_cp} pv {' '.join(pv_uci_list)}")

                raw_lines.append({
                    "pv_san": " ".join(pv_san_list),
                    "pv_uci": " ".join(pv_uci_list),
                    "score": score_obj,
                    "score_cp": score_cp,
                    "is_mate": is_mate,
                    "mate_in": mate_in,
                    "pv": pv_moves,
                    "depth": line_depth,
                    "nps": nps_val,
                })

            classified = classify_multipv(board, raw_lines)
            self.log_uci_batch(subsystem, uci_log)
            return {
                "variations": classified,
                "uci_log": uci_log,
                "uci_options": uci_options,
            }
        except Exception as err:
            logger.error("request_variations failed: %s", err)
            err_log = [f"[ERROR] Engine request_variations failed: {str(err)}"]
            self.log_uci_batch(subsystem, err_log)
            return {
                "variations": [],
                "uci_log": err_log,
                "uci_options": {},
            }
        finally:
            if engine is not None:
                try:
                    engine.quit()
                except Exception:
                    pass


_engine_service_singleton: Optional[UCIEngineService] = None


def get_engine_service(root_dir: Optional[str] = None) -> UCIEngineService:
    """Returns singleton UCIEngineService instance for shared lifecycle and log access."""
    global _engine_service_singleton
    if _engine_service_singleton is None:
        _engine_service_singleton = UCIEngineService(root_dir=root_dir)
    return _engine_service_singleton

