"""
Hardware-Aware Parallel PGN Chunking Analysis Service.

Splits a single game's positions (Ply 0 through Ply N) into contiguous mini-blocks
dispatched across isolated UCI worker subprocesses (`ThreadPoolExecutor`), preserving
Transposition Table (Hash) locality while balancing middlegame CPU load.

Honors all user-configured UCI protocol options verbatim (never forcing
UCI_LimitStrength or Ponder overrides), passes `multipv` exclusively to
`engine.analyse(..., multipv=n)`, closes every engine in `finally: engine.quit()`,
and commits the Gold-tier PGN back to SQLite in a single atomic WAL transaction.
"""

import io
import math
import os
import queue
import re
import sqlite3
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

import chess
import chess.engine
import chess.pgn

from core.features.engine.engine_service import (
    ANALYSIS_PRESETS,
    UCIEngineService,
    get_engine_service,
    get_hardware_profile,
    is_neural_gpu_engine,
    resolve_threads_option_key,
    safe_engine_configure,
)
from core.features.engine.tag_classifier import (
    classify_variation_tags,
    is_piece_sacrifice,
    is_tactical_forcing,
)
from core.persistence.database import (
    GameRepository,
    STANDARD_START_FEN,
    extract_pgn_metadata,
    set_pgn_header,
    strip_fake_zero_acpl_comments,
)


@dataclass
class PlyEvalResult:
    ply_index: int
    fen: str
    eval_str: str
    eval_cp: int          # White-POV raw cp (or mate-scaled cp)
    norm_cp: int          # White-POV clamped [-1000, +1000] for stable cp_loss
    is_mate: bool = False
    mate_in_white: Optional[int] = None
    best_move_uci: str = ""
    best_move_san: str = ""
    pv_san: str = ""
    depth: int = 0


def estimate_performance_elo(acpl: float, move_count: int = 1) -> int:
    """Kimi empirical Performance Elo curve: Elo = 3100 * exp(-0.01 * ACPL), clamped [600, 3200]."""
    if move_count <= 0:
        return 1500
    raw = 3100.0 * math.exp(-0.01 * max(0.0, float(acpl)))
    return int(max(600, min(3200, round(raw))))


def format_white_pov_eval(score_obj: Any) -> Tuple[str, int, int, bool, Optional[int]]:
    """
    Converts a python-chess PovScore into:
      (eval_str, raw_white_cp, norm_white_cp, is_mate, mate_in_white)
    Mate formatting uses `#M<n>` for White mate and `-#M<n>` for Black mate.
    `norm_white_cp` is clamped to [-1000, +1000] so `#M4 -> #M3` produces 0 cp loss.
    """
    if score_obj is None:
        return "+0.00", 0, 0, False, None

    white_pov = score_obj.white()
    if white_pov.is_mate():
        mate_val = white_pov.mate()
        if mate_val is None or mate_val == 0:
            return "#0", 0, 0, True, 0
        if mate_val > 0:
            raw_cp = 10000 - min(99, abs(mate_val)) * 100
            return f"#M{mate_val}", raw_cp, 1000, True, mate_val
        raw_cp = -10000 + min(99, abs(mate_val)) * 100
        return f"-#M{abs(mate_val)}", raw_cp, -1000, True, mate_val

    cp = white_pov.score()
    cp_int = int(cp) if cp is not None else 0
    norm_cp = max(-1000, min(1000, cp_int))
    return f"{cp_int / 100.0:+.2f}", cp_int, norm_cp, False, None


def compute_worker_plan(
    total_positions: int,
    engine_id: str,
    workers_mode: str = "auto",
    manual_workers: Optional[int] = None,
    manual_threads: Optional[int] = None,
    uci_overrides: Optional[Dict[str, Any]] = None,
    exe_path: Optional[str] = None,
    options_schema: Optional[Dict[str, Any]] = None,
    hardware: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Pure hardware-aware worker, thread, and Hash-RAM planner.
    - Auto mode: `worker_count = min(6, safe_ceiling)`, `threads_per_worker = 1`.
    - Manual mode: respects user's explicit `manual_workers` and `manual_threads`.
    - GPU/Neural engines (Lc0/Maia): capped strictly at `worker_count = 1`.
    - Hash budgeting: scales per-worker Hash when `worker_count > 1` so total
      allocation stays inside safe RAM headroom.
    """
    hw = hardware or get_hardware_profile()
    cpu_count = int(hw.get("cpu_count") or (os.cpu_count() or 4))
    safe_ceiling = max(1, int(hw.get("safe_ceiling") or max(1, cpu_count - 2)))
    available_ram_mb = int(hw.get("available_ram_mb") or 4096)
    overrides = uci_overrides or {}

    # Read user's preferred Hash & Threads from uci_overrides (case-insensitive)
    user_hash_mb = 128
    user_threads = 1
    for k, v in overrides.items():
        if k.lower() == "hash":
            try:
                user_hash_mb = max(16, int(v))
            except (TypeError, ValueError):
                pass
        elif k.lower() == "threads":
            try:
                user_threads = max(1, int(v))
            except (TypeError, ValueError):
                pass

    neural = is_neural_gpu_engine(engine_id, exe_path=exe_path, options_schema=options_schema)

    if neural:
        worker_count = 1
        threads_per_worker = max(1, int(manual_threads or user_threads or 1))
    elif (workers_mode or "auto").lower() == "manual":
        worker_count = max(1, min(32, int(manual_workers or 1)))
        threads_per_worker = max(1, min(32, int(manual_threads or user_threads or 1)))
    else:
        worker_count = max(1, min(6, safe_ceiling))
        threads_per_worker = 1

    # Never spawn more workers than positions to evaluate
    effective_positions = max(1, int(total_positions))
    worker_count = max(1, min(worker_count, effective_positions))

    # Hash RAM budget: keep aggregate Hash <= 40% of available RAM (capped at 4096 MB)
    total_hash_budget = max(64, min(4096, int(available_ram_mb * 0.40)))
    if worker_count > 1:
        per_worker_hash_mb = max(16, min(user_hash_mb, total_hash_budget // worker_count))
    else:
        per_worker_hash_mb = max(16, min(user_hash_mb, total_hash_budget))

    total_threads = worker_count * threads_per_worker
    oversubscribed = total_threads > safe_ceiling

    return {
        "cpu_count": cpu_count,
        "safe_ceiling": safe_ceiling,
        "available_ram_mb": available_ram_mb,
        "is_neural_gpu": neural,
        "worker_count": worker_count,
        "threads_per_worker": threads_per_worker,
        "total_threads": total_threads,
        "oversubscribed": oversubscribed,
        "per_worker_hash_mb": per_worker_hash_mb,
        "total_hash_mb": per_worker_hash_mb * worker_count,
    }


def build_contiguous_chunks(
    positions: List[Tuple[int, str]],
    worker_count: int,
) -> List[List[Tuple[int, str]]]:
    """
    Splits ordered `(ply_index, fen)` pairs into load-balanced contiguous mini-blocks:
      `chunk_size = max(4, math.ceil(total_plies / (worker_count * 2)))`
    Preserves Transposition Table (Hash) locality across sequential plies while
    preventing complex middlegame stragglers.
    """
    total = len(positions)
    if total == 0:
        return []
    workers = max(1, int(worker_count))
    if workers == 1 or total <= 4:
        return [list(positions)]

    chunk_size = max(4, math.ceil(total / (workers * 2)))
    return [positions[i : i + chunk_size] for i in range(0, total, chunk_size)]


def extract_game_positions(
    pgn_text: str,
    initial_fen: Optional[str] = None,
) -> Tuple[chess.pgn.Game, List[Tuple[int, str]], List[chess.Move], List[str]]:
    """
    Parses a PGN string and extracts ordered `(ply_index, fen)` pairs from
    Ply 0 (`initial_fen`) through Ply N, along with the mainline `Move` and SAN lists.
    """
    clean_pgn = strip_fake_zero_acpl_comments(pgn_text or "")
    game = chess.pgn.read_game(io.StringIO(clean_pgn))
    if game is None:
        game = chess.pgn.Game()
        if initial_fen and initial_fen != STANDARD_START_FEN:
            game.headers["SetUp"] = "1"
            game.headers["FEN"] = initial_fen

    # Honor explicit initial_fen if PGN lacks a custom FEN header
    if initial_fen and initial_fen != STANDARD_START_FEN and "FEN" not in game.headers:
        try:
            chess.Board(initial_fen)
            game.headers["SetUp"] = "1"
            game.headers["FEN"] = initial_fen
        except Exception:
            pass

    board = game.board()
    positions: List[Tuple[int, str]] = [(0, board.fen())]
    moves: List[chess.Move] = []
    sans: List[str] = []

    for idx, move in enumerate(game.mainline_moves(), start=1):
        if move not in board.legal_moves:
            break
        sans.append(board.san(move))
        moves.append(move)
        board.push(move)
        positions.append((idx, board.fen()))

    return game, positions, moves, sans


def _classify_move_quality(
    board_before: chess.Board,
    move: chess.Move,
    cp_loss: int,
    eval_after_mover_cp: int,
    best_cp_mover: int,
) -> Tuple[str, str, str, bool]:
    """
    Classifies move quality combining centipawn loss thresholds with
    tactical/sacrifice detection from `tag_classifier.py`.
    Returns `(tag, badge, badge_label, is_tactical)`.
    """
    tags = classify_variation_tags(board_before, move, cp=eval_after_mover_cp, best_cp=best_cp_mover)
    is_tactical = "tactical" in tags or is_tactical_forcing(board_before, move)

    if cp_loss <= 10:
        if "brilliant" in tags or (is_piece_sacrifice(board_before, move) and eval_after_mover_cp >= -50):
            return "brilliant", "!!", "Brilliant Move", True
        return "best", "✨", "Best Move", is_tactical
    if cp_loss <= 35:
        return "good", "✓", "Good Move", is_tactical
    if cp_loss <= 90:
        return "inaccuracy", "?!", "Inaccuracy", is_tactical
    if cp_loss <= 200:
        return "mistake", "?", "Mistake", is_tactical
    return "blunder", "??", "Blunder", is_tactical


def _strip_eval_tag_from_comment(comment: str) -> str:
    """Removes prior `[%eval ...]` tags from a move comment while preserving non-eval notes."""
    if not comment:
        return ""
    cleaned = re.sub(r'\[%eval\s+[^\]]+\]', '', comment)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    return cleaned


class GameAnalyzerService:
    """
    Coordinates hardware-aware parallel single-game analysis jobs with cancellation,
    progress polling, ordered reassembly, and single atomic Gold SQLite commits.
    """

    def __init__(self, root_dir: str, engine_service: Optional[UCIEngineService] = None):
        self.root_dir = root_dir
        self.engine_service = engine_service or get_engine_service(root_dir)
        self._jobs: Dict[str, Dict[str, Any]] = {}
        self._cancel_events: Dict[str, threading.Event] = {}
        self._active_by_game_key: Dict[str, str] = {}
        self._lock = threading.Lock()

    def _resolve_db_path(self, db_name: str) -> str:
        candidates = [
            os.path.join(self.root_dir, db_name),
            os.path.join(self.root_dir, "Resources", "IntFiles", db_name),
        ]
        for c in candidates:
            if os.path.exists(c):
                return c
        return os.path.join(self.root_dir, db_name)

    def _resolve_analysis_params(self, req: Dict[str, Any]) -> Dict[str, Any]:
        """Merges explicit job parameters with persisted `ANALYZER` role settings."""
        roles_payload = self.engine_service.get_engine_roles()
        analyzer_cfg = dict(roles_payload["roles"]["analyzer"])
        hw = roles_payload["hardware"]

        engine_id = str(req.get("engine_id") or analyzer_cfg.get("engine_id") or "stockfish").strip()
        preset = str(req.get("preset") or analyzer_cfg.get("preset") or "deep").strip().lower()

        search_mode = req.get("search_mode")
        depth = req.get("depth")
        movetime_ms = req.get("movetime_ms")

        if preset in ANALYSIS_PRESETS:
            preset_def = ANALYSIS_PRESETS[preset]
            if not search_mode:
                search_mode = preset_def["search_mode"]
            if depth is None:
                depth = preset_def["depth"]
            if "movetime_ms" not in req:
                movetime_ms = preset_def["movetime_ms"]

        search_mode = str(search_mode or analyzer_cfg.get("search_mode") or "depth").lower()
        depth = max(4, min(60, int(depth if depth is not None else (analyzer_cfg.get("depth") or 18))))
        if movetime_ms is None and search_mode == "movetime":
            movetime_ms = analyzer_cfg.get("movetime_ms") or 300
        elif movetime_ms is not None:
            movetime_ms = max(50, min(60000, int(movetime_ms)))

        multipv = max(1, min(10, int(req.get("multipv") if req.get("multipv") is not None else (analyzer_cfg.get("multipv") or 1))))
        workers_mode = str(req.get("workers_mode") or analyzer_cfg.get("workers_mode") or "auto").lower()
        manual_workers = req.get("manual_workers") if req.get("manual_workers") is not None else analyzer_cfg.get("manual_workers")
        manual_threads = req.get("manual_threads") if req.get("manual_threads") is not None else analyzer_cfg.get("manual_threads")

        # Honor user-defined UCI options verbatim for the Analyzer role
        if isinstance(req.get("uci_overrides"), dict):
            uci_overrides = dict(req["uci_overrides"])
        elif engine_id.lower() == str(analyzer_cfg.get("engine_id") or "").lower():
            uci_overrides = dict(analyzer_cfg.get("uci_overrides") or {})
        else:
            custom_cfg = self.engine_service.get_custom_engine_config(engine_id)
            uci_overrides = dict(custom_cfg.get("options") or {}) if custom_cfg else {}

        # Resolve display engine name
        avail = self.engine_service.get_available_engines()
        eng_meta = next((e for e in avail if e.get("id", "").lower() == engine_id.lower()), None)
        engine_name = (eng_meta or {}).get("name") or engine_id

        return {
            "engine_id": engine_id,
            "engine_name": engine_name,
            "preset": preset,
            "search_mode": search_mode,
            "depth": depth,
            "movetime_ms": movetime_ms,
            "multipv": multipv,
            "workers_mode": workers_mode,
            "manual_workers": manual_workers,
            "manual_threads": manual_threads,
            "uci_overrides": uci_overrides,
            "hardware": hw,
        }

    def _load_game_source(
        self,
        pgn: Optional[str],
        initial_fen: Optional[str],
        db_name: Optional[str],
        game_id: Optional[Union[int, str]],
    ) -> Tuple[str, Optional[str]]:
        """Loads PGN + initial FEN either directly from request or from SQLite."""
        if pgn and pgn.strip():
            return pgn, initial_fen
        if db_name and game_id is not None:
            db_path = self._resolve_db_path(db_name)
            repo = GameRepository(db_path)
            record = repo.get_game_by_rowid(game_id)
            if not record:
                raise ValueError(f"Game '{game_id}' not found in '{db_name}'.")
            return record.get("pgn") or "", record.get("initial_fen")
        raise ValueError("Either `pgn` or (`db_name` and `game_id`) must be provided.")

    def _build_chess_limit(self, search_mode: str, depth: int, movetime_ms: Optional[int]) -> chess.engine.Limit:
        if search_mode == "movetime":
            t_sec = max(0.05, (movetime_ms or 300) / 1000.0)
            return chess.engine.Limit(time=t_sec)
        if search_mode == "hybrid" and movetime_ms:
            t_sec = max(0.05, movetime_ms / 1000.0)
            return chess.engine.Limit(depth=depth, time=t_sec)
        # Default "depth": exact depth without premature clock abort
        return chess.engine.Limit(depth=depth)

    def _evaluate_positions_parallel(
        self,
        positions: List[Tuple[int, str]],
        exe_path: str,
        params: Dict[str, Any],
        plan: Dict[str, Any],
        cancel_event: threading.Event,
        on_ply_done: Optional[Callable[[], None]] = None,
        worker_evaluator: Optional[Callable[[List[Tuple[int, str]], Dict[str, Any], Dict[str, Any], threading.Event], List[PlyEvalResult]]] = None,
    ) -> Tuple[List[PlyEvalResult], List[str]]:
        """
        Executes contiguous mini-block slicing across `ThreadPoolExecutor(max_workers=W)`.
        Each worker thread spawns ONE persistent UCI subprocess for all its chunks,
        honors all user-defined UCI options verbatim, checks `cancel_event` between
        plies, and always quits its engine inside `finally: engine.quit()`.
        """
        worker_count = plan["worker_count"]
        chunks = build_contiguous_chunks(positions, worker_count)
        chunk_queue: "queue.Queue[List[Tuple[int, str]]]" = queue.Queue()
        for ch in chunks:
            chunk_queue.put(ch)

        results: List[PlyEvalResult] = []
        results_lock = threading.Lock()
        uci_logs: List[str] = [
            f"[ANALYZER] Engine={params['engine_name']} ({params['engine_id']}) | "
            f"Preset={params['preset']} | Mode={params['search_mode']} | Depth={params['depth']} | "
            f"Workers={worker_count} x {plan['threads_per_worker']}T | Hash={plan['per_worker_hash_mb']}MB/worker"
        ]
        logs_lock = threading.Lock()
        limit = self._build_chess_limit(params["search_mode"], params["depth"], params["movetime_ms"])

        def _default_worker(worker_idx: int) -> None:
            engine = None
            try:
                if cancel_event.is_set():
                    return

                if worker_evaluator is not None:
                    while not cancel_event.is_set():
                        try:
                            chunk = chunk_queue.get_nowait()
                        except queue.Empty:
                            break
                        chunk_out = worker_evaluator(chunk, params, plan, cancel_event)
                        with results_lock:
                            results.extend(chunk_out)
                        if on_ply_done:
                            for _ in chunk_out:
                                on_ply_done()
                    return

                engine = self.engine_service._popen_uci_clean(exe_path, timeout=10.0)
                w_logs: List[str] = []
                if worker_idx == 0:
                    w_logs.extend([
                        ">>> uci",
                        f"<<< id name {engine.id.get('name', params['engine_name'])}",
                        f"<<< id author {engine.id.get('author', 'Unknown')}",
                        "<<< uciok",
                    ])

                # Configure Maia weights if needed
                self.engine_service._configure_maia_weights(engine, params["engine_id"], exe_path, w_logs)

                # Honor ALL user-defined UCI protocol options verbatim (never force UCI_LimitStrength/Ponder)
                worker_opts = dict(params.get("uci_overrides") or {})

                # Apply planned Threads & Hash budget for parallel worker safety
                threads_key = resolve_threads_option_key(engine.options)
                if threads_key:
                    worker_opts[threads_key] = plan["threads_per_worker"]
                if "Hash" in engine.options:
                    worker_opts["Hash"] = plan["per_worker_hash_mb"]

                applied = safe_engine_configure(
                    engine,
                    worker_opts,
                    log_context=f"analyzer worker-{worker_idx} ({params['engine_id']})",
                )
                if worker_idx == 0:
                    for k, v in applied.items():
                        w_logs.append(f">>> setoption name {k} value {v}")
                    w_logs.extend([">>> isready", "<<< readyok"])

                multipv_supported = "MultiPV" in engine.options
                actual_multipv = max(1, min(int(params.get("multipv") or 1), 10)) if multipv_supported else 1

                while not cancel_event.is_set():
                    try:
                        chunk = chunk_queue.get_nowait()
                    except queue.Empty:
                        break

                    for ply_idx, fen in chunk:
                        if cancel_event.is_set():
                            break
                        board = chess.Board(fen)
                        if board.is_game_over():
                            if board.is_checkmate():
                                # Side to move is checkmated
                                if board.turn == chess.WHITE:
                                    ev = PlyEvalResult(ply_idx, fen, "-#M0", -10000, -1000, True, 0, depth=0)
                                else:
                                    ev = PlyEvalResult(ply_idx, fen, "#M0", 10000, 1000, True, 0, depth=0)
                            else:
                                ev = PlyEvalResult(ply_idx, fen, "+0.00", 0, 0, False, None, depth=0)
                        else:
                            # Pass multipv exclusively as keyword argument to engine.analyse()
                            if actual_multipv > 1:
                                raw_info = engine.analyse(board, limit, multipv=actual_multipv)
                                info = raw_info[0] if isinstance(raw_info, list) and raw_info else raw_info
                            else:
                                info = engine.analyse(board, limit)
                                if isinstance(info, list):
                                    info = info[0] if info else {}

                            score_obj = info.get("score") if isinstance(info, dict) else None
                            eval_str, raw_cp, norm_cp, is_mate, mate_w = format_white_pov_eval(score_obj)
                            pv_moves = (info.get("pv") or []) if isinstance(info, dict) else []
                            best_uci = pv_moves[0].uci() if pv_moves else ""
                            best_san = board.san(pv_moves[0]) if pv_moves and pv_moves[0] in board.legal_moves else ""

                            tmp_b = board.copy()
                            pv_san_tokens: List[str] = []
                            for m in pv_moves[:6]:
                                if m in tmp_b.legal_moves:
                                    pv_san_tokens.append(tmp_b.san(m))
                                    tmp_b.push(m)

                            ev = PlyEvalResult(
                                ply_index=ply_idx,
                                fen=fen,
                                eval_str=eval_str,
                                eval_cp=raw_cp,
                                norm_cp=norm_cp,
                                is_mate=is_mate,
                                mate_in_white=mate_w,
                                best_move_uci=best_uci,
                                best_move_san=best_san,
                                pv_san=" ".join(pv_san_tokens),
                                depth=int(info.get("depth", params["depth"])) if isinstance(info, dict) else params["depth"],
                            )

                        with results_lock:
                            results.append(ev)
                        if on_ply_done:
                            on_ply_done()

                if w_logs:
                    with logs_lock:
                        uci_logs.extend(w_logs)
            finally:
                if engine is not None:
                    try:
                        engine.quit()
                    except Exception:
                        pass

        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = [executor.submit(_default_worker, w_idx) for w_idx in range(worker_count)]
            for fut in futures:
                fut.result()

        results.sort(key=lambda r: r.ply_index)
        return results, uci_logs

    def _assemble_gold_result(
        self,
        game: chess.pgn.Game,
        positions: List[Tuple[int, str]],
        moves: List[chess.Move],
        sans: List[str],
        eval_results: List[PlyEvalResult],
        params: Dict[str, Any],
        plan: Dict[str, Any],
        uci_logs: List[str],
    ) -> Dict[str, Any]:
        """Reassembles ordered ply evals, computes ACPL/Accuracy/Elo, and builds Gold PGN."""
        eval_by_ply: Dict[int, PlyEvalResult] = {r.ply_index: r for r in eval_results}

        annotations: List[Dict[str, Any]] = []
        white_losses: List[int] = []
        black_losses: List[int] = []

        blunder_count = 0
        mistake_count = 0
        inaccuracy_count = 0
        good_count = 0
        best_count = 0
        book_count = 0
        tactical_count = 0

        # Walk mainline nodes simultaneously to annotate PGN in-place
        node: Any = game
        for idx, (move, san) in enumerate(zip(moves, sans)):
            board_before = chess.Board(positions[idx][1])
            is_white_move = board_before.turn == chess.WHITE

            ev_before = eval_by_ply.get(idx)
            ev_after = eval_by_ply.get(idx + 1)

            prev_cp = ev_before.norm_cp if ev_before else 0
            curr_cp = ev_after.norm_cp if ev_after else prev_cp
            eval_str = ev_after.eval_str if ev_after else "+0.00"
            raw_cp = ev_after.eval_cp if ev_after else curr_cp

            cp_loss = max(0, prev_cp - curr_cp) if is_white_move else max(0, curr_cp - prev_cp)
            if is_white_move:
                white_losses.append(cp_loss)
            else:
                black_losses.append(cp_loss)

            mover_after_cp = curr_cp if is_white_move else -curr_cp
            mover_best_cp = prev_cp if is_white_move else -prev_cp
            tag, badge, badge_label, is_tactical = _classify_move_quality(
                board_before, move, cp_loss, mover_after_cp, mover_best_cp
            )

            if tag in ("best", "brilliant"):
                best_count += 1
            elif tag == "good":
                good_count += 1
            elif tag == "inaccuracy":
                inaccuracy_count += 1
            elif tag == "mistake":
                mistake_count += 1
            elif tag == "blunder":
                blunder_count += 1
            if is_tactical:
                tactical_count += 1

            # Overwrite previous [%eval ...] comment on this PGN node cleanly
            next_node = node.next() if hasattr(node, "next") else None
            if next_node is not None:
                existing_note = _strip_eval_tag_from_comment(next_node.comment or "")
                next_node.comment = f"[%eval {eval_str}]" + (f" {existing_note}" if existing_note else "")
                node = next_node

            annotations.append({
                "ply": idx,
                "san": san,
                "eval": eval_str,
                "evalCp": curr_cp,
                "rawCp": raw_cp,
                "cpLoss": cp_loss,
                "tag": tag,
                "badge": badge,
                "badgeLabel": badge_label,
                "bestMoveSan": ev_before.best_move_san if ev_before else "",
                "pvSan": ev_after.pv_san if ev_after else "",
                "depth": ev_after.depth if ev_after else params["depth"],
            })

        white_acpl = int(round(sum(white_losses) / len(white_losses))) if white_losses else 0
        black_acpl = int(round(sum(black_losses) / len(black_losses))) if black_losses else 0
        white_accuracy = max(30, min(100, int(round(100 - white_acpl * 0.35))))
        black_accuracy = max(30, min(100, int(round(100 - black_acpl * 0.35))))
        white_perf_elo = estimate_performance_elo(white_acpl, len(white_losses))
        black_perf_elo = estimate_performance_elo(black_acpl, len(black_losses))

        white_name = (game.headers.get("White") or "").strip()
        black_name = (game.headers.get("Black") or "").strip()
        if "human" in black_name.lower() or "player" in black_name.lower():
            if "human" not in white_name.lower() and "player" not in white_name.lower():
                player_acpl, engine_acpl = black_acpl, white_acpl
            else:
                player_acpl, engine_acpl = white_acpl, black_acpl
        else:
            player_acpl, engine_acpl = white_acpl, black_acpl

        final_ev_obj = eval_by_ply.get(len(moves)) or eval_by_ply.get(0)
        final_eval_str = final_ev_obj.eval_str if final_ev_obj else "+0.00"
        eval_source_str = f"{params['engine_name']} (d{params['depth']}, {plan['worker_count']}w)"

        exporter = chess.pgn.StringExporter(headers=True, variations=True, comments=True)
        annotated_pgn = strip_fake_zero_acpl_comments(game.accept(exporter))
        annotated_pgn = set_pgn_header(annotated_pgn, "DataTier", "Gold")
        annotated_pgn = set_pgn_header(annotated_pgn, "EvalSource", eval_source_str)
        annotated_pgn = set_pgn_header(annotated_pgn, "PlayerACPL", str(player_acpl))
        annotated_pgn = set_pgn_header(annotated_pgn, "EngineACPL", str(engine_acpl))
        annotated_pgn = set_pgn_header(annotated_pgn, "FinalEval", final_eval_str)

        stats = {
            "hasEngineAnalysis": True,
            "whiteAcpl": white_acpl,
            "blackAcpl": black_acpl,
            "whiteAccuracy": white_accuracy,
            "blackAccuracy": black_accuracy,
            "totalPlies": len(moves),
            "totalMoves": math.ceil(len(moves) / 2),
            "blunderCount": blunder_count,
            "mistakeCount": mistake_count,
            "inaccuracyCount": inaccuracy_count,
            "goodCount": good_count,
            "bestCount": best_count,
            "bookCount": book_count,
            "tacticalCount": tactical_count,
            "termination": game.headers.get("Termination") or None,
            "finalEval": final_eval_str,
            "evalSource": eval_source_str,
            "playerAcpl": player_acpl,
            "engineAcpl": engine_acpl,
            "whitePerfElo": white_perf_elo,
            "blackPerfElo": black_perf_elo,
            "dataTier": "Gold",
        }

        uci_logs.append(
            f"[ANALYZER] Complete: {len(moves)} plies | White ACPL={white_acpl} (≈{white_perf_elo}) | "
            f"Black ACPL={black_acpl} (≈{black_perf_elo}) | FinalEval={final_eval_str} | Tier=Gold"
        )

        return {
            "pgn": annotated_pgn,
            "annotations": annotations,
            "stats": stats,
            "eval_source": eval_source_str,
            "final_eval": final_eval_str,
            "tier": "Gold",
            "worker_plan": plan,
            "uci_log": uci_logs,
        }

    def _persist_gold_pgn_atomic(
        self,
        db_name: str,
        game_id: Union[int, str],
        gold_pgn: str,
        ply_count: int,
    ) -> bool:
        """
        Single atomic SQLite WAL transaction (`BEGIN IMMEDIATE ... COMMIT`)
        updating `_DATA_`, `pgn`, and any missing standard columns without ALTER TABLE.
        """
        db_path = self._resolve_db_path(db_name)
        if not os.path.exists(db_path):
            return False

        is_sparring = os.path.basename(db_path).lower() == "sparring_games.sqlite"
        meta = extract_pgn_metadata(gold_pgn, fallback_today_date=is_sparring, is_sparring=is_sparring)

        conn = sqlite3.connect(db_path, timeout=30.0, check_same_thread=False, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode = WAL;")
            conn.execute("PRAGMA busy_timeout = 10000;")
            conn.execute("PRAGMA synchronous = NORMAL;")
            cur = conn.cursor()

            cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables = [r[0] for r in cur.fetchall()]
            tables_lower = {t.lower(): t for t in tables}
            gtable = tables_lower.get("games")
            if not gtable:
                return False

            cur.execute(f"PRAGMA table_info({gtable})")
            col_map = {r[1].lower(): r[1] for r in cur.fetchall()}

            cur.execute("BEGIN IMMEDIATE")
            try:
                target_rowid = None
                is_int = False
                int_val = 0
                try:
                    if isinstance(game_id, int) or (isinstance(game_id, str) and game_id.strip().isdigit()):
                        int_val = int(str(game_id).strip())
                        is_int = True
                except (ValueError, TypeError):
                    is_int = False

                if is_int:
                    cur.execute(f"SELECT ROWID FROM {gtable} WHERE ROWID = ?", (int_val,))
                    row = cur.fetchone()
                    if row:
                        target_rowid = row[0]

                if target_rowid is None and "game_id" in col_map:
                    gid_col = col_map["game_id"]
                    cur.execute(f"SELECT ROWID FROM {gtable} WHERE {gid_col} = ?", (str(game_id),))
                    row = cur.fetchone()
                    if row:
                        target_rowid = row[0]

                if target_rowid is None:
                    cur.execute("ROLLBACK")
                    return False

                update_pairs: List[Tuple[str, Any]] = []
                if "_data_" in col_map:
                    update_pairs.append((col_map["_data_"], gold_pgn))
                if "pgn" in col_map:
                    update_pairs.append((col_map["pgn"], gold_pgn))
                if "plycount" in col_map and ply_count > 0:
                    update_pairs.append((col_map["plycount"], ply_count))
                if "eco" in col_map and meta["ECO"] and meta["ECO"] != "-":
                    update_pairs.append((col_map["eco"], meta["ECO"]))
                if "opening" in col_map and meta["OPENING"]:
                    update_pairs.append((col_map["opening"], meta["OPENING"]))
                if "result" in col_map and meta["RESULT"] in ("1-0", "0-1", "1/2-1/2"):
                    update_pairs.append((col_map["result"], meta["RESULT"]))

                if update_pairs:
                    set_sql = ", ".join(f"{col} = ?" for col, _ in update_pairs)
                    cur.execute(
                        f"UPDATE {gtable} SET {set_sql} WHERE ROWID = ?",
                        [val for _, val in update_pairs] + [target_rowid],
                    )
                cur.execute("COMMIT")
                return True
            except Exception:
                try:
                    cur.execute("ROLLBACK")
                except Exception:
                    pass
                raise
        finally:
            conn.close()

    def analyze_game_sync(
        self,
        pgn: Optional[str] = None,
        initial_fen: Optional[str] = None,
        db_name: Optional[str] = None,
        game_id: Optional[Union[int, str]] = None,
        options: Optional[Dict[str, Any]] = None,
        cancel_event: Optional[threading.Event] = None,
        on_ply_done: Optional[Callable[[], None]] = None,
        worker_evaluator: Optional[Callable] = None,
    ) -> Dict[str, Any]:
        """Runs parallel PGN evaluation synchronously and writes Gold PGN atomically."""
        req = dict(options or {})
        params = self._resolve_analysis_params(req)
        raw_pgn, resolved_fen = self._load_game_source(pgn, initial_fen, db_name, game_id)
        game, positions, moves, sans = extract_game_positions(raw_pgn, resolved_fen)

        exe_path = self.engine_service.get_engine_path(params["engine_id"])
        if not worker_evaluator and (not exe_path or not os.path.exists(exe_path)):
            raise FileNotFoundError(f"Analyzer engine binary not found for '{params['engine_id']}'.")

        with self.engine_service._options_lock:
            cached_schema = self.engine_service._options_cache.get(params["engine_id"].lower())

        plan = compute_worker_plan(
            total_positions=len(positions),
            engine_id=params["engine_id"],
            workers_mode=params["workers_mode"],
            manual_workers=params["manual_workers"],
            manual_threads=params["manual_threads"],
            uci_overrides=params["uci_overrides"],
            exe_path=exe_path,
            options_schema=cached_schema,
            hardware=params["hardware"],
        )

        ev_cancel = cancel_event or threading.Event()
        eval_results, uci_logs = self._evaluate_positions_parallel(
            positions=positions,
            exe_path=exe_path or "",
            params=params,
            plan=plan,
            cancel_event=ev_cancel,
            on_ply_done=on_ply_done,
            worker_evaluator=worker_evaluator,
        )

        if ev_cancel.is_set():
            return {"status": "cancelled", "cancelled": True}

        assembled = self._assemble_gold_result(
            game=game,
            positions=positions,
            moves=moves,
            sans=sans,
            eval_results=eval_results,
            params=params,
            plan=plan,
            uci_logs=uci_logs,
        )

        persisted = False
        if db_name and game_id is not None and not ev_cancel.is_set():
            persisted = self._persist_gold_pgn_atomic(
                db_name=db_name,
                game_id=game_id,
                gold_pgn=assembled["pgn"],
                ply_count=len(moves),
            )

        assembled["persisted"] = persisted
        assembled["db_name"] = db_name
        assembled["game_id"] = game_id
        assembled["engine_id"] = params["engine_id"]
        assembled["engine_name"] = params["engine_name"]
        assembled["preset"] = params["preset"]
        assembled["depth"] = params["depth"]
        return assembled

    def start_job(self, req: Dict[str, Any]) -> Dict[str, Any]:
        """
        Starts an asynchronous background parallel analysis job.
        Automatically supersedes/cancels any prior active job for the same game.
        """
        db_name = req.get("db_name")
        game_id = req.get("game_id")
        pgn = req.get("pgn")
        initial_fen = req.get("initial_fen")

        params = self._resolve_analysis_params(req)
        raw_pgn, resolved_fen = self._load_game_source(pgn, initial_fen, db_name, game_id)
        game, positions, moves, sans = extract_game_positions(raw_pgn, resolved_fen)

        exe_path = self.engine_service.get_engine_path(params["engine_id"])
        if not exe_path or not os.path.exists(exe_path):
            raise FileNotFoundError(f"Analyzer engine binary not found for '{params['engine_id']}'.")

        with self.engine_service._options_lock:
            cached_schema = self.engine_service._options_cache.get(params["engine_id"].lower())

        plan = compute_worker_plan(
            total_positions=len(positions),
            engine_id=params["engine_id"],
            workers_mode=params["workers_mode"],
            manual_workers=params["manual_workers"],
            manual_threads=params["manual_threads"],
            uci_overrides=params["uci_overrides"],
            exe_path=exe_path,
            options_schema=cached_schema,
            hardware=params["hardware"],
        )

        job_id = str(uuid.uuid4())[:12]
        cancel_event = threading.Event()
        game_key = f"{db_name or 'adhoc'}::{game_id if game_id is not None else 'inline'}"

        with self._lock:
            prior_id = self._active_by_game_key.get(game_key)
            if prior_id and prior_id in self._cancel_events:
                self._cancel_events[prior_id].set()
                if prior_id in self._jobs and self._jobs[prior_id]["status"] == "running":
                    self._jobs[prior_id]["status"] = "cancelled"

            self._cancel_events[job_id] = cancel_event
            self._active_by_game_key[game_key] = job_id
            self._jobs[job_id] = {
                "job_id": job_id,
                "status": "running",
                "completed_plies": 0,
                "total_plies": len(positions),
                "move_count": len(moves),
                "worker_count": plan["worker_count"],
                "threads_per_worker": plan["threads_per_worker"],
                "engine_id": params["engine_id"],
                "engine_name": params["engine_name"],
                "preset": params["preset"],
                "depth": params["depth"],
                "is_neural_gpu": plan["is_neural_gpu"],
                "started_at": time.time(),
                "error": None,
                "result": None,
            }

        def _on_ply_done() -> None:
            with self._lock:
                job = self._jobs.get(job_id)
                if job and job["status"] == "running":
                    job["completed_plies"] = min(job["total_plies"], job["completed_plies"] + 1)

        def _coordinator() -> None:
            try:
                eval_results, uci_logs = self._evaluate_positions_parallel(
                    positions=positions,
                    exe_path=exe_path,
                    params=params,
                    plan=plan,
                    cancel_event=cancel_event,
                    on_ply_done=_on_ply_done,
                )
                if cancel_event.is_set():
                    with self._lock:
                        if job_id in self._jobs:
                            self._jobs[job_id]["status"] = "cancelled"
                    return

                assembled = self._assemble_gold_result(
                    game=game,
                    positions=positions,
                    moves=moves,
                    sans=sans,
                    eval_results=eval_results,
                    params=params,
                    plan=plan,
                    uci_logs=uci_logs,
                )

                persisted = False
                if db_name and game_id is not None and not cancel_event.is_set():
                    persisted = self._persist_gold_pgn_atomic(
                        db_name=db_name,
                        game_id=game_id,
                        gold_pgn=assembled["pgn"],
                        ply_count=len(moves),
                    )
                assembled["persisted"] = persisted
                assembled["db_name"] = db_name
                assembled["game_id"] = game_id
                assembled["engine_id"] = params["engine_id"]
                assembled["engine_name"] = params["engine_name"]
                assembled["preset"] = params["preset"]
                assembled["depth"] = params["depth"]

                with self._lock:
                    if job_id in self._jobs:
                        if cancel_event.is_set():
                            self._jobs[job_id]["status"] = "cancelled"
                        else:
                            self._jobs[job_id]["completed_plies"] = len(positions)
                            self._jobs[job_id]["status"] = "completed"
                            self._jobs[job_id]["result"] = assembled
            except Exception as exc:
                with self._lock:
                    if job_id in self._jobs:
                        self._jobs[job_id]["status"] = "error"
                        self._jobs[job_id]["error"] = str(exc)

        thread = threading.Thread(target=_coordinator, name=f"analyzer-job-{job_id}", daemon=True)
        thread.start()

        return {
            "job_id": job_id,
            "status": "running",
            "completed_plies": 0,
            "total_plies": len(positions),
            "worker_count": plan["worker_count"],
            "threads_per_worker": plan["threads_per_worker"],
            "engine_id": params["engine_id"],
            "engine_name": params["engine_name"],
            "preset": params["preset"],
            "depth": params["depth"],
            "is_neural_gpu": plan["is_neural_gpu"],
            "hardware": params["hardware"],
        }

    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job:
                return None
            return dict(job)

    def cancel_job(self, job_id: str) -> bool:
        with self._lock:
            ev = self._cancel_events.get(job_id)
            if ev is None:
                return False
            ev.set()
            if job_id in self._jobs and self._jobs[job_id]["status"] == "running":
                self._jobs[job_id]["status"] = "cancelled"
            return True


_game_analyzer_singleton: Optional[GameAnalyzerService] = None


def get_game_analyzer_service(root_dir: Optional[str] = None) -> GameAnalyzerService:
    global _game_analyzer_singleton
    if _game_analyzer_singleton is None:
        base = root_dir or os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        _game_analyzer_singleton = GameAnalyzerService(base, get_engine_service(base))
    return _game_analyzer_singleton
