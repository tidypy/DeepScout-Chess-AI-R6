"""
Pass 2 Verification Suite:
- UCI option schema isolation (no transposed keys across engines, MultiPV/button stripping,
  strict per-engine_id deep-copy cache, guaranteed engine.quit() in finally)
- engine_roles.json persistence (ANALYZER role slot honoring user-defined UCI options
  verbatim without forcing UCI_LimitStrength=False or Ponder=False; reset on engine switch)
- Hardware-aware parallel worker planning (safe_ceiling = max(1, cpu - 2), Auto vs Manual,
  oversubscription detection, GPU/Neural 1-worker guardrail, RAM-aware Hash budgeting)
- Contiguous mini-block PGN chunking & ordered 0..N reassembly across parallel workers
- Mate normalization (#M4 -> #M3 = 0 cp loss), Kimi Performance Elo curve, single atomic
  Gold SQLite WAL commit (string game_id UUID and int ROWID), and clean cancellation cleanup
- TIME_FORFEIT / MANUAL_RESIGN [Result] vs [FinalEval] separation + terminal-FEN fallback
- FastAPI sync `def` threadpool offloading check on all new Pass 2 routes
"""

import inspect
import json
import math
import os
import shutil
import sqlite3
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import chess
import chess.engine

from core.features.analysis.game_analyzer_service import (
    GameAnalyzerService,
    PlyEvalResult,
    build_contiguous_chunks,
    compute_worker_plan,
    estimate_performance_elo,
    extract_game_positions,
    format_white_pov_eval,
)
from core.features.database.mass_analysis_service import MassAnalysisService
from core.features.engine import companion_router, router as engine_router
from core.features.database import router as fitness_router
from core.features.engine.engine_service import (
    UCIEngineService,
    is_neural_gpu_engine,
    safe_engine_configure,
    sanitize_uci_options,
)
from core.persistence.companion_repositories import SparringGamesRepository
from core.persistence.database import GameRepository, has_genuine_gold_eval


SAMPLE_8PLY_PGN = """[Event "DeepScout Engine Sparring"]
[Site "DeepScout Arena"]
[Date "2026.11.18"]
[Round "-"]
[White "Player (Human)"]
[Black "Stockfish 18"]
[Result "*"]
[ECO "C50"]
[Opening "Italian Game"]

1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 *
"""


class FakeUciOption:
    def __init__(self, name, opt_type, default=None, min_val=None, max_val=None, var=None):
        self.name = name
        self.type = opt_type
        self.default = default
        self.min = min_val
        self.max = max_val
        self.var = var or []


class FakeSimpleEngine:
    """In-memory mock of chess.engine.SimpleEngine tracking configure/analyse/quit calls."""

    def __init__(self, name="Stockfish 18", options=None, analyse_delay=0.0, score_fn=None):
        self.id = {"name": name, "author": "DeepScout Test"}
        self.options = options or {
            "Threads": FakeUciOption("Threads", "spin", 1, 1, 64),
            "Hash": FakeUciOption("Hash", "spin", 16, 1, 4096),
            "MultiPV": FakeUciOption("MultiPV", "spin", 1, 1, 10),
            "UCI_LimitStrength": FakeUciOption("UCI_LimitStrength", "check", False),
            "UCI_Elo": FakeUciOption("UCI_Elo", "spin", 1320, 1320, 3190),
            "Ponder": FakeUciOption("Ponder", "check", False),
            "Clear Hash": FakeUciOption("Clear Hash", "button"),
            "Skill Level": FakeUciOption("Skill Level", "spin", 20, 0, 20),
        }
        self.configured_calls = []
        self.analyse_calls = []
        self.quit_called = False
        self.analyse_delay = analyse_delay
        self.score_fn = score_fn

    def configure(self, opts):
        for k in opts:
            if k.lower() == "multipv":
                raise chess.engine.EngineError("MultiPV must never be passed to engine.configure()")
            if k not in self.options:
                raise chess.engine.EngineError(f"Unknown transposed UCI option: {k}")
        self.configured_calls.append(dict(opts))

    def analyse(self, board, limit, multipv=1):
        if self.analyse_delay > 0:
            time.sleep(self.analyse_delay)
        self.analyse_calls.append({"fen": board.fen(), "limit": limit, "multipv": multipv})
        legal = list(board.legal_moves)
        pv = [legal[0]] if legal else []
        if self.score_fn:
            pov_score = self.score_fn(board)
        else:
            pov_score = chess.engine.PovScore(chess.engine.Cp(25), chess.WHITE)
        entry = {"score": pov_score, "pv": pv, "depth": getattr(limit, "depth", 14) or 14}
        return [entry] if multipv > 1 else entry

    def quit(self):
        self.quit_called = True


class TestUciOptionIsolation(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.svc = UCIEngineService(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_sanitize_drops_multipv_buttons_and_transposed_keys(self):
        stockfish_schema = {
            "Threads": {"name": "Threads", "type": "spin", "default": 1, "min": 1, "max": 16},
            "Hash": {"name": "Hash", "type": "spin", "default": 16, "min": 1, "max": 2048},
            "MultiPV": {"name": "MultiPV", "type": "spin", "default": 1, "min": 1, "max": 10},
            "Clear Hash": {"name": "Clear Hash", "type": "button", "default": None},
            "Ponder": {"name": "Ponder", "type": "check", "default": False},
            "EvalStyle": {"name": "EvalStyle", "type": "combo", "default": "Normal", "var": ["Normal", "Aggressive"]},
        }
        # Mix valid Stockfish options with transposed Patricia/Lc0 keys, MultiPV, button, and out-of-range spin
        dirty_opts = {
            "Threads": 999,                 # should clamp to 16
            "Hash": 256,
            "MultiPV": 3,                   # MUST be stripped
            "Clear Hash": True,             # button MUST be stripped
            "Ponder": "true",               # coerced to True
            "EvalStyle": "aggressive",      # matched case-insensitively to "Aggressive"
            "Aggressiveness": 150,          # transposed Patricia key -> MUST be dropped
            "WeightsFile": "maia.pb.gz",    # transposed Lc0 key -> MUST be dropped
            "SyzygyPath": "<empty>",        # sentinel -> MUST be dropped
        }
        cleaned = sanitize_uci_options(dirty_opts, supported_options=stockfish_schema)
        self.assertEqual(cleaned["Threads"], 16)
        self.assertEqual(cleaned["Hash"], 256)
        self.assertIs(cleaned["Ponder"], True)
        self.assertEqual(cleaned["EvalStyle"], "Aggressive")
        self.assertNotIn("MultiPV", cleaned)
        self.assertNotIn("Clear Hash", cleaned)
        self.assertNotIn("Aggressiveness", cleaned)
        self.assertNotIn("WeightsFile", cleaned)
        self.assertNotIn("SyzygyPath", cleaned)

    def test_probe_uci_options_isolated_per_engine_id_and_quits_in_finally(self):
        sf_bin = os.path.join(self.test_dir, "sf.exe")
        pat_bin = os.path.join(self.test_dir, "patricia.exe")
        with open(sf_bin, "wb") as f:
            f.write(b"fake")
        with open(pat_bin, "wb") as f:
            f.write(b"fake")

        sf_engine = FakeSimpleEngine(
            name="Stockfish 18",
            options={
                "Hash": FakeUciOption("Hash", "spin", 16, 1, 2048),
                "EvalFile": FakeUciOption("EvalFile", "string", "nn-sf.nnue"),
            },
        )
        pat_engine = FakeSimpleEngine(
            name="Patricia 4.0",
            options={
                "Hash": FakeUciOption("Hash", "spin", 64, 1, 1024),
                "Aggressiveness": FakeUciOption("Aggressiveness", "spin", 100, 0, 200),
            },
        )

        def fake_path(eid):
            return sf_bin if eid == "stockfish" else pat_bin

        def fake_popen(exe_path, timeout=10.0):
            return sf_engine if exe_path == sf_bin else pat_engine

        with patch.object(self.svc, "get_engine_path", side_effect=fake_path), \
             patch.object(self.svc, "_popen_uci_clean", side_effect=fake_popen):
            sf_opts = self.svc.probe_uci_options("stockfish")
            pat_opts = self.svc.probe_uci_options("patricia")

        self.assertTrue(sf_engine.quit_called)
        self.assertTrue(pat_engine.quit_called)
        self.assertIn("EvalFile", sf_opts)
        self.assertNotIn("Aggressiveness", sf_opts)
        self.assertIn("Aggressiveness", pat_opts)
        self.assertNotIn("EvalFile", pat_opts)

        # Mutating returned dict must NOT pollute deep-copied cache
        sf_opts["EvalFile"]["default"] = "MUTATED"
        sf_opts_again = self.svc.probe_uci_options("stockfish")
        self.assertEqual(sf_opts_again["EvalFile"]["default"], "nn-sf.nnue")

    def test_safe_engine_configure_never_passes_multipv_or_transposed_keys(self):
        fake = FakeSimpleEngine()
        applied = safe_engine_configure(
            fake,
            {
                "Hash": 128,
                "MultiPV": 5,
                "UCI_LimitStrength": True,
                "Ponder": True,
                "NonExistentEngineOption": 42,
            },
        )
        self.assertEqual(applied["Hash"], 128)
        self.assertIs(applied["UCI_LimitStrength"], True)
        self.assertIs(applied["Ponder"], True)
        self.assertNotIn("MultiPV", applied)
        self.assertNotIn("NonExistentEngineOption", applied)
        self.assertEqual(len(fake.configured_calls), 1)
        self.assertNotIn("MultiPV", fake.configured_calls[0])


class TestEngineRolesPersistence(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.svc = UCIEngineService(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_analyzer_role_persists_user_uci_options_verbatim_and_resets_on_engine_switch(self):
        initial = self.svc.get_engine_roles()
        self.assertEqual(initial["roles"]["analyzer"]["engine_id"], "stockfish")
        self.assertEqual(initial["roles"]["analyzer"]["preset"], "deep")
        self.assertEqual(initial["roles"]["analyzer"]["workers_mode"], "auto")

        # Persist user-defined UCI options including UCI_LimitStrength=True & Ponder=True
        updated = self.svc.update_engine_role(
            "analyzer",
            {
                "engine_id": "stockfish",
                "preset": "thorough",
                "search_mode": "depth",
                "depth": 22,
                "multipv": 3,
                "workers_mode": "manual",
                "manual_workers": 4,
                "manual_threads": 2,
                "uci_overrides": {
                    "UCI_LimitStrength": True,
                    "UCI_Elo": 1850,
                    "Ponder": True,
                    "Hash": 256,
                    "MultiPV": 4,  # Must be stripped from uci_overrides
                },
            },
        )
        cfg = updated["config"]
        self.assertEqual(cfg["preset"], "thorough")
        self.assertEqual(cfg["depth"], 22)
        self.assertEqual(cfg["multipv"], 3)
        self.assertEqual(cfg["workers_mode"], "manual")
        self.assertEqual(cfg["manual_workers"], 4)
        self.assertEqual(cfg["manual_threads"], 2)
        # User-defined UCI options MUST be preserved verbatim!
        self.assertIs(cfg["uci_overrides"]["UCI_LimitStrength"], True)
        self.assertEqual(cfg["uci_overrides"]["UCI_Elo"], 1850)
        self.assertIs(cfg["uci_overrides"]["Ponder"], True)
        self.assertEqual(cfg["uci_overrides"]["Hash"], 256)
        self.assertNotIn("MultiPV", cfg["uci_overrides"])

        # Verify persisted to disk in UserData/engine_roles.json
        roles_file = os.path.join(self.test_dir, "UserData", "engine_roles.json")
        self.assertTrue(os.path.exists(roles_file))
        reloaded = UCIEngineService(self.test_dir).get_engine_roles()
        self.assertIs(reloaded["roles"]["analyzer"]["uci_overrides"]["Ponder"], True)
        self.assertIs(reloaded["roles"]["analyzer"]["uci_overrides"]["UCI_LimitStrength"], True)

        # Switching engine_id without supplying new uci_overrides resets stale overrides
        switched = self.svc.update_engine_role("analyzer", {"engine_id": "patricia"})
        self.assertEqual(switched["config"]["engine_id"], "patricia")
        self.assertEqual(switched["config"]["uci_overrides"], {})


class TestContiguousChunkingAndHardwarePlan(unittest.TestCase):
    def test_contiguous_mini_blocks_order_and_sizing(self):
        positions = [(i, f"fen-{i}") for i in range(41)]
        chunks = build_contiguous_chunks(positions, worker_count=4)
        # chunk_size = max(4, ceil(41 / (4 * 2))) = max(4, 6) = 6
        self.assertEqual(len(chunks[0]), 6)
        # Every chunk must be strictly contiguous and flattening must equal original order
        flattened = [item for ch in chunks for item in ch]
        self.assertEqual(flattened, positions)
        for ch in chunks:
            indices = [p[0] for p in ch]
            self.assertEqual(indices, list(range(indices[0], indices[0] + len(indices))))

    def test_safe_ceiling_auto_manual_oversubscription_and_neural_guardrail(self):
        # 16-core host -> safe_ceiling = 14 -> Auto = min(6, 14) = 6 workers x 1T
        plan_auto_16 = compute_worker_plan(
            total_positions=60,
            engine_id="stockfish",
            workers_mode="auto",
            uci_overrides={"Hash": 512},
            hardware={"cpu_count": 16, "safe_ceiling": 14, "available_ram_mb": 8192},
        )
        self.assertEqual(plan_auto_16["worker_count"], 6)
        self.assertEqual(plan_auto_16["threads_per_worker"], 1)
        self.assertFalse(plan_auto_16["oversubscribed"])
        self.assertFalse(plan_auto_16["is_neural_gpu"])
        # Total Hash <= 40% of 8192 MB (3276 MB)
        self.assertLessEqual(plan_auto_16["total_hash_mb"], int(8192 * 0.40))

        # 4-core host -> safe_ceiling = 2 -> Auto = 2 workers x 1T
        plan_auto_4 = compute_worker_plan(
            total_positions=40,
            engine_id="stockfish",
            workers_mode="auto",
            hardware={"cpu_count": 4, "safe_ceiling": 2, "available_ram_mb": 4096},
        )
        self.assertEqual(plan_auto_4["worker_count"], 2)
        self.assertEqual(plan_auto_4["threads_per_worker"], 1)
        self.assertFalse(plan_auto_4["oversubscribed"])

        # Manual override exceeding safe_ceiling flags oversubscribed=True while honoring user config
        plan_manual = compute_worker_plan(
            total_positions=40,
            engine_id="stockfish",
            workers_mode="manual",
            manual_workers=4,
            manual_threads=4,
            hardware={"cpu_count": 8, "safe_ceiling": 6, "available_ram_mb": 4096},
        )
        self.assertEqual(plan_manual["worker_count"], 4)
        self.assertEqual(plan_manual["threads_per_worker"], 4)
        self.assertEqual(plan_manual["total_threads"], 16)
        self.assertTrue(plan_manual["oversubscribed"])

        # Neural/GPU engines (lc0, maia, or WeightsFile/Backend option) strictly capped at 1 worker
        for eid, schema in [
            ("lc0", None),
            ("maia1500", None),
            ("custom_nn", {"WeightsFile": {"type": "string"}, "Backend": {"type": "combo"}}),
        ]:
            self.assertTrue(is_neural_gpu_engine(eid, options_schema=schema))
            plan_nn = compute_worker_plan(
                total_positions=50,
                engine_id=eid,
                workers_mode="manual",
                manual_workers=6,
                manual_threads=2,
                options_schema=schema,
                hardware={"cpu_count": 16, "safe_ceiling": 14, "available_ram_mb": 8192},
            )
            self.assertEqual(plan_nn["worker_count"], 1, f"{eid} must be capped at 1 worker")
            self.assertTrue(plan_nn["is_neural_gpu"])


class TestParallelAnalysisAndAtomicGoldCommit(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.engine_svc = UCIEngineService(self.test_dir)
        self.analyzer = GameAnalyzerService(self.test_dir, self.engine_svc)
        self.sparring_db = os.path.join(self.test_dir, "Sparring_Games.sqlite")
        self.sparring_repo = SparringGamesRepository(self.sparring_db)
        self.fake_bin = os.path.join(self.test_dir, "stockfish_fake.exe")
        with open(self.fake_bin, "wb") as f:
            f.write(b"fake")

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_mate_normalization_and_kimi_elo_curve(self):
        # #M4 -> #M3 must normalize to equal +1000 norm_cp => 0 cp loss
        s_m4, _, norm_m4, is_m4, m4_val = format_white_pov_eval(chess.engine.PovScore(chess.engine.Mate(4), chess.WHITE))
        s_m3, _, norm_m3, is_m3, m3_val = format_white_pov_eval(chess.engine.PovScore(chess.engine.Mate(3), chess.WHITE))
        self.assertEqual(s_m4, "#M4")
        self.assertEqual(s_m3, "#M3")
        self.assertTrue(is_m4 and is_m3)
        self.assertEqual(m4_val, 4)
        self.assertEqual(m3_val, 3)
        self.assertEqual(max(0, norm_m4 - norm_m3), 0)

        # Black mate formatted as -#M2
        s_bm2, _, norm_bm2, _, _ = format_white_pov_eval(chess.engine.PovScore(chess.engine.Mate(-2), chess.WHITE))
        self.assertEqual(s_bm2, "-#M2")
        self.assertEqual(norm_bm2, -1000)

        # Kimi curve: Elo = 3100 * exp(-0.01 * ACPL)
        self.assertEqual(estimate_performance_elo(0, 10), 3100)
        self.assertEqual(estimate_performance_elo(50, 10), int(round(3100.0 * math.exp(-0.5))))
        self.assertEqual(estimate_performance_elo(500, 10), 600)  # clamped at floor

    def test_parallel_workers_honor_user_uci_options_reassemble_order_and_commit_gold_atomically(self):
        # Persist Silver sparring game with UUID game_id
        gid = "aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee"
        self.sparring_repo.upsert_game(
            game_id=gid,
            pgn=SAMPLE_8PLY_PGN,
            opponent_engine="Stockfish 18",
            result="*",
        )

        # Configure analyzer role with explicit user-defined UCI_LimitStrength=True and Ponder=True
        self.engine_svc.update_engine_role(
            "analyzer",
            {
                "engine_id": "stockfish",
                "preset": "narrow",
                "search_mode": "depth",
                "depth": 14,
                "multipv": 3,
                "workers_mode": "manual",
                "manual_workers": 2,
                "manual_threads": 1,
                "uci_overrides": {
                    "UCI_LimitStrength": True,
                    "UCI_Elo": 1900,
                    "Ponder": True,
                    "Hash": 128,
                },
            },
        )

        spawned_engines = []

        def fake_popen(exe_path, timeout=10.0):
            # Vary delay slightly to exercise out-of-order thread completion
            eng = FakeSimpleEngine(
                name="Stockfish 18",
                analyse_delay=0.005,
                score_fn=lambda b: chess.engine.PovScore(chess.engine.Cp(20 + b.fullmove_number * 5), chess.WHITE),
            )
            spawned_engines.append(eng)
            return eng

        with patch.object(self.engine_svc, "get_engine_path", return_value=self.fake_bin), \
             patch.object(self.engine_svc, "_popen_uci_clean", side_effect=fake_popen):
            result = self.analyzer.analyze_game_sync(
                db_name="Sparring_Games.sqlite",
                game_id=gid,
            )

        # Every spawned worker MUST have honored user UCI options verbatim, never configured MultiPV,
        # passed multipv=3 to analyse(), and closed cleanly via quit()
        self.assertGreaterEqual(len(spawned_engines), 1)
        for eng in spawned_engines:
            self.assertTrue(eng.quit_called, "Worker UCI engine must be closed in finally: engine.quit()")
            self.assertEqual(len(eng.configured_calls), 1)
            cfg = eng.configured_calls[0]
            self.assertIs(cfg.get("UCI_LimitStrength"), True)
            self.assertEqual(cfg.get("UCI_Elo"), 1900)
            self.assertIs(cfg.get("Ponder"), True)
            self.assertNotIn("MultiPV", cfg)
            for ac in eng.analyse_calls:
                self.assertEqual(ac["multipv"], 3)

        # Ordered 0..7 move annotations (8 plies)
        self.assertEqual(len(result["annotations"]), 8)
        self.assertEqual([a["ply"] for a in result["annotations"]], list(range(8)))
        self.assertEqual(result["tier"], "Gold")
        self.assertTrue(result["persisted"])
        self.assertIn('[DataTier "Gold"]', result["pgn"])
        self.assertIn('[EvalSource "Stockfish 18 (d14, 2w)"]', result["pgn"])
        self.assertTrue(has_genuine_gold_eval(result["pgn"]))

        # Verify BOTH `_DATA_` and `pgn` columns were atomically updated in SQLite!
        conn = sqlite3.connect(self.sparring_db)
        try:
            row = conn.execute(
                "SELECT _DATA_, pgn, PLYCOUNT FROM Games WHERE game_id = ?", (gid,)
            ).fetchone()
        finally:
            conn.close()
        self.assertIsNotNone(row)
        self.assertIn('[DataTier "Gold"]', row[0])
        self.assertIn('[%eval ', row[0])
        self.assertEqual(row[0], row[1])
        self.assertEqual(row[2], 8)

    def test_cancellation_stops_workers_quits_engines_and_does_not_write_partial_sqlite(self):
        gid = "bbbb2222-cccc-4ddd-8eee-ffffffffffff"
        self.sparring_repo.upsert_game(
            game_id=gid,
            pgn=SAMPLE_8PLY_PGN,
            opponent_engine="Stockfish 18",
            result="*",
        )

        cancel_ev = threading.Event()
        spawned_engines = []

        def score_and_cancel(board):
            # Cancel after the very first ply is evaluated
            cancel_ev.set()
            return chess.engine.PovScore(chess.engine.Cp(10), chess.WHITE)

        def fake_popen(exe_path, timeout=10.0):
            eng = FakeSimpleEngine(name="Stockfish 18", score_fn=score_and_cancel)
            spawned_engines.append(eng)
            return eng

        with patch.object(self.engine_svc, "get_engine_path", return_value=self.fake_bin), \
             patch.object(self.engine_svc, "_popen_uci_clean", side_effect=fake_popen):
            res = self.analyzer.analyze_game_sync(
                db_name="Sparring_Games.sqlite",
                game_id=gid,
                options={"workers_mode": "manual", "manual_workers": 2, "manual_threads": 1},
                cancel_event=cancel_ev,
            )

        self.assertEqual(res.get("status"), "cancelled")
        self.assertTrue(res.get("cancelled"))
        for eng in spawned_engines:
            self.assertTrue(eng.quit_called, "Cancelled worker engine must still call quit()")

        # Original SQLite row must remain untouched (no partial Gold PGN written!)
        conn = sqlite3.connect(self.sparring_db)
        try:
            row = conn.execute("SELECT _DATA_ FROM Games WHERE game_id = ?", (gid,)).fetchone()
        finally:
            conn.close()
        self.assertNotIn('[DataTier "Gold"]', row[0] or "")

    def test_mass_analysis_single_game_delegates_to_parallel_analyzer_for_int_rowid(self):
        std_db = os.path.join(self.test_dir, "Tournament.sqlite")
        conn = sqlite3.connect(std_db)
        try:
            conn.execute(
                "CREATE TABLE Games (WHITE TEXT, BLACK TEXT, RESULT TEXT, ECO TEXT, OPENING TEXT, PLYCOUNT INTEGER, _DATA_ TEXT)"
            )
            conn.execute(
                "INSERT INTO Games (WHITE, BLACK, RESULT, ECO, OPENING, PLYCOUNT, _DATA_) VALUES (?, ?, ?, ?, ?, ?, ?)",
                ("Player (Human)", "Stockfish 18", "*", "C50", "Italian Game", 8, SAMPLE_8PLY_PGN),
            )
            conn.commit()
        finally:
            conn.close()

        mass_svc = MassAnalysisService(self.test_dir)
        with patch.object(self.engine_svc, "get_engine_path", return_value=self.fake_bin), \
             patch.object(self.engine_svc, "_popen_uci_clean", side_effect=lambda p, timeout=10.0: FakeSimpleEngine()), \
             patch("core.features.analysis.game_analyzer_service.get_game_analyzer_service", return_value=self.analyzer):
            out = mass_svc.analyze_single_game("Tournament.sqlite", 1, depth=12)

        self.assertTrue(out["success"])
        self.assertEqual(out["tier"], "Gold")
        self.assertTrue(out["persisted"])
        repo = GameRepository(std_db)
        loaded = repo.get_game_by_rowid(1)
        self.assertIn('[DataTier "Gold"]', loaded["pgn"])


class TestTimeForfeitAndFinalEvalAdjudication(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.test_dir, "Sparring_Games.sqlite")
        self.sparring_repo = SparringGamesRepository(self.db_path)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_time_forfeit_separates_result_from_winning_final_eval(self):
        orig_repo = companion_router.companion_mgr.sparring_repo
        companion_router.companion_mgr.sparring_repo = self.sparring_repo
        try:
            gid = "cccc3333-dddd-4eee-8fff-000000000001"
            res = companion_router.telemetry_flush(
                companion_router.TelemetryFlushRequest(
                    game_id=gid,
                    pgn=SAMPLE_8PLY_PGN,
                    player_color="white",
                    termination_type="TIME_FORFEIT",
                    game_result="0-1",        # White flagged on clock
                    engine_eval_cp=500,       # White was +5.00 winning on board!
                )
            )
            self.assertFalse(res["discarded"])
            self.assertEqual(res["result"], "0-1")
            self.assertEqual(res["final_eval"], "+5.00")
            self.assertEqual(res["eval_source"], "SPARRING")
            self.assertEqual(res["data_tier"], "Silver")

            conn = sqlite3.connect(self.db_path)
            try:
                row = conn.execute("SELECT RESULT, _DATA_, pgn FROM Games WHERE game_id = ?", (gid,)).fetchone()
            finally:
                conn.close()
            self.assertEqual(row[0], "0-1")
            self.assertIn('[Result "0-1"]', row[1])
            self.assertIn('[Termination "TIME_FORFEIT"]', row[1])
            self.assertIn('[FinalEval "+5.00"]', row[1])
            self.assertIn('[DataTier "Silver"]', row[1])
        finally:
            companion_router.companion_mgr.sparring_repo = orig_repo

    def test_missing_live_eval_runs_terminal_fen_fallback_never_none(self):
        orig_repo = companion_router.companion_mgr.sparring_repo
        companion_router.companion_mgr.sparring_repo = self.sparring_repo
        try:
            gid = "dddd4444-eeee-4fff-8000-111111111111"
            fake_eval_res = {
                "success": True,
                "eval_cp": 215,
                "eval_score": "+2.15",
            }
            with patch.object(companion_router.companion_engine_service, "evaluate_position", return_value=fake_eval_res), \
                 patch.object(
                     companion_router.companion_engine_service,
                     "get_available_engines",
                     return_value=[{"id": "stockfish", "name": "Stockfish 18"}],
                 ):
                res = companion_router.telemetry_flush(
                    companion_router.TelemetryFlushRequest(
                        game_id=gid,
                        pgn=SAMPLE_8PLY_PGN,
                        player_color="white",
                        termination_type="MANUAL_RESIGN",
                        engine_id="stockfish",
                        tutor_eval_cp=None,
                        kibitzer_eval_cp=None,
                        engine_eval_cp=None,
                    )
                )
            self.assertFalse(res["discarded"])
            self.assertEqual(res["result"], "0-1")
            self.assertEqual(res["final_eval"], "+2.15")
            self.assertNotEqual(res["eval_source"], "NONE")
            self.assertEqual(res["eval_source"], "Stockfish 18")
        finally:
            companion_router.companion_mgr.sparring_repo = orig_repo


class TestPass2FastApiRoutesSyncDef(unittest.TestCase):
    def test_new_pass2_routes_are_sync_def(self):
        from core.api import main as api_main
        sync_handlers = [
            engine_router.get_engine_roles,
            engine_router.update_engine_role,
            engine_router.start_analysis_job,
            engine_router.get_analysis_job_status,
            engine_router.cancel_analysis_job,
            fitness_router.repair_sparring_database,
            companion_router.telemetry_flush,
            api_main.save_game_variation,
        ]
        for fn in sync_handlers:
            self.assertFalse(
                inspect.iscoroutinefunction(fn),
                f"Blocking SQLite/UCI route '{fn.__name__}' must be sync `def`, not `async def`",
            )


class TestPass2PolishRegressions(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_toga_number_of_threads_alias_mapping(self):
        toga_schema = {
            "Hash": {"name": "Hash", "type": "spin", "default": 32, "min": 16, "max": 4096},
            "Number of Threads": {"name": "Number of Threads", "type": "spin", "default": 1, "min": 1, "max": 16},
            "Ponder": {"name": "Ponder", "type": "check", "default": False},
        }
        cleaned = sanitize_uci_options({"Threads": 2, "Hash": 160, "Ponder": True}, supported_options=toga_schema)
        self.assertEqual(cleaned.get("Number of Threads"), 2)
        self.assertEqual(cleaned.get("Hash"), 160)
        self.assertIs(cleaned.get("Ponder"), True)
        self.assertNotIn("Threads", cleaned)

    def test_prev_next_rowid_skips_deleted_gaps_and_append_variation_to_pgn(self):
        db_path = os.path.join(self.test_dir, "Sparring_Games.sqlite")
        sparring_repo = SparringGamesRepository(db_path)
        sparring_repo.upsert_game(game_id="g1", pgn=SAMPLE_8PLY_PGN, opponent_engine="Stockfish 18", result="*")
        sparring_repo.upsert_game(game_id="g2", pgn=SAMPLE_8PLY_PGN, opponent_engine="Stockfish 18", result="*")
        sparring_repo.upsert_game(game_id="g3", pgn=SAMPLE_8PLY_PGN, opponent_engine="Stockfish 18", result="*")

        # Delete middle row (ROWID 2) to create a ROWID gap (1 -> 3)
        conn = sqlite3.connect(db_path)
        try:
            conn.execute("DELETE FROM Games WHERE game_id = 'g2'")
            conn.commit()
        finally:
            conn.close()

        repo = GameRepository(db_path)
        rec1 = repo.get_game_by_rowid(1)
        self.assertIsNotNone(rec1)
        self.assertIsNone(rec1["prev_id"])
        self.assertEqual(rec1["next_id"], 3)

        rec3 = repo.get_game_by_rowid(3)
        self.assertIsNotNone(rec3)
        self.assertEqual(rec3["prev_id"], 1)
        self.assertIsNone(rec3["next_id"])

        # Append a Kibitzer variation at ply 4 (after 2...Nc6) and verify persisted to BOTH _DATA_ and pgn
        saved = repo.append_variation_to_pgn(
            game_id="g1",
            ply=4,
            pv_san="Bb5 a6 Ba4",
            eval_str="+0.25",
            engine_name="Patricia v4",
            depth=20,
        )
        self.assertTrue(saved["success"])
        self.assertEqual(saved["moves_saved"], 3)
        self.assertFalse(saved["already_existed"])
        self.assertIn("( 3. Bb5", saved["pgn"])
        self.assertIn("Kibitzer: Patricia v4 d20", saved["pgn"])

        # Re-saving identical variation is idempotent
        saved_again = repo.append_variation_to_pgn(
            game_id="g1",
            ply=4,
            pv_san="Bb5 a6 Ba4",
            eval_str="+0.25",
            engine_name="Patricia v4",
            depth=20,
        )
        self.assertTrue(saved_again["already_existed"])

        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute("SELECT _DATA_, pgn FROM Games WHERE game_id = 'g1'").fetchone()
        finally:
            conn.close()
        self.assertIn("( 3. Bb5", row[0])
        self.assertEqual(row[0], row[1])

    def test_mass_analysis_small_sparring_db_uses_real_parallel_uci_to_promote_gold(self):
        db_path = os.path.join(self.test_dir, "Sparring_Games.sqlite")
        sparring_repo = SparringGamesRepository(db_path)
        sparring_repo.upsert_game(
            game_id="silver-1",
            pgn=SAMPLE_8PLY_PGN,
            opponent_engine="Stockfish 18",
            result="0-1",
        )
        fake_bin = os.path.join(self.test_dir, "sf_fake.exe")
        with open(fake_bin, "wb") as f:
            f.write(b"fake")

        eng_svc = UCIEngineService(self.test_dir)
        analyzer = GameAnalyzerService(self.test_dir, eng_svc)
        mass_svc = MassAnalysisService(self.test_dir)

        with patch.object(eng_svc, "get_engine_path", return_value=fake_bin), \
             patch.object(eng_svc, "_popen_uci_clean", side_effect=lambda p, timeout=10.0: FakeSimpleEngine()), \
             patch("core.features.analysis.game_analyzer_service.get_game_analyzer_service", return_value=analyzer):
            job = mass_svc.run_mass_analysis(
                db_name="Sparring_Games.sqlite",
                job_id="job-test-1",
                depth=12,
                mode="MISSING_ONLY",
            )

        self.assertEqual(job["status"], "completed")
        self.assertEqual(job["strategy"], "real_uci_parallel")
        self.assertEqual(job["processed"], 1)
        loaded = GameRepository(db_path).get_game_by_rowid("silver-1")
        self.assertTrue(has_genuine_gold_eval(loaded["pgn"]))
        self.assertIn('[DataTier "Gold"]', loaded["pgn"])


if __name__ == "__main__":
    unittest.main()
