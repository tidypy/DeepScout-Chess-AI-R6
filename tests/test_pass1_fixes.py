"""
Pass 1 Verification Suite:
- Lazy sparring UPSERT (>= 2 plies only) & unified SQL + PGN column population
- Honest Silver vs. Gold tiering & fake zero-ACPL stripping
- PGN-aware Data Fitness audit/sanitize, engine name normalization, & repair_sparring_database
- Engine clone/register shared binary path preservation
- Flat get_engine_logs() without double-wrapping
- FastAPI threadpool offloading (sync `def` route handlers for blocking SQLite/UCI/HTTP I/O)
"""

import inspect
import json
import os
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from core.persistence.companion_repositories import SparringGamesRepository
from core.persistence.database import (
    GameRepository,
    strip_fake_zero_acpl_comments,
    has_genuine_gold_eval,
)
from core.features.database.fitness_service import DataFitnessService
from core.features.engine.engine_service import UCIEngineService
from core.features.engine import companion_router, router as engine_router
from core.features.database import router as fitness_router
from core.features.ai import router as ai_router
from core.features.consolidator import router as consolidator_router
from core.features.dossier import router as dossier_router
from core.features.openings import router as openings_router


FAKE_ZERO_ACPL_PGN = """[Event "DeepScout Engine Sparring"]
[Site "DeepScout Arena"]
[Date "2026.11.18"]
[Round "1"]
[White "Player (Human)"]
[Black "Andscacs 0.94"]
[Result "*"]
[ECO "-"]
[Opening "GMopenings.bin"]

1. e4 c5 2. Nf3 d6 { [%acpl global="0.0" user="0" engine="0"] [%caps user_accuracy="100%" engine_accuracy="100%"] [%stats best="0" inaccuracy="0" mistake="0" blunder="0"] [%provenance engine="Andscacs 0.94" elo="2500" date="2026-11-18T00:00:00Z"] [%sparring mode="UCI Sparring Arena" tutor_mode="passive_log"] } *
"""

REAL_GOLD_PGN = """[Event "DeepScout Engine Sparring"]
[Site "DeepScout Arena"]
[Date "2026.11.18"]
[Round "-"]
[White "Player (Human)"]
[Black "Stockfish 18"]
[Result "0-1"]
[ECO "B20"]
[Opening "Sicilian Defense"]
[EvalSource "Stockfish 18 (d18)"]
[PlayerACPL "42"]
[EngineACPL "9"]

1. e4 { [%eval +0.30] } c5 { [%eval +0.28] } 2. Nf3 { [%eval +0.32] } d6 { [%eval +0.35] } 0-1
"""


class TestPass1SparringAndFitness(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.test_dir, "Sparring_Games.sqlite")
        self.sparring_repo = SparringGamesRepository(self.db_path)
        self.fitness = DataFitnessService(self.test_dir)

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_lazy_create_does_not_write_zero_ply_stub(self):
        rec = self.sparring_repo.create_game(opponent_engine="Stockfish 18")
        self.assertTrue(rec["game_id"])

        conn = sqlite3.connect(self.db_path)
        try:
            count = conn.execute("SELECT COUNT(*) FROM Games").fetchone()[0]
        finally:
            conn.close()
        self.assertEqual(count, 0, "create_game must not write empty 0-ply rows to SQLite")

    def test_telemetry_flush_discards_0_and_1_ply_and_upserts_2_plus_as_silver(self):
        orig_repo = companion_router.companion_mgr.sparring_repo
        companion_router.companion_mgr.sparring_repo = self.sparring_repo
        try:
            # 0-ply session -> discarded
            res0 = companion_router.telemetry_flush(
                companion_router.TelemetryFlushRequest(
                    game_id="03ef74f1-0000-4000-8000-000000000000",
                    pgn='[Event "DeepScout Engine Sparring"]\n\n*',
                    player_color="white",
                    termination_type="EVAL_ADJUDICATED",
                )
            )
            self.assertTrue(res0["discarded"])

            # 1-ply session -> discarded
            res1 = companion_router.telemetry_flush(
                companion_router.TelemetryFlushRequest(
                    game_id="03ef74f1-1111-4000-8000-000000000001",
                    pgn='[Event "DeepScout Engine Sparring"]\n\n1. e4 *',
                    player_color="white",
                    termination_type="EVAL_ADJUDICATED",
                )
            )
            self.assertTrue(res1["discarded"])

            # 4-ply unanalyzed sparring game with fake zero-ACPL block -> atomic Silver UPSERT
            gid = "03ef74f1-2222-4000-8000-000000000002"
            self.sparring_repo.create_game(game_id=gid, opponent_engine="Andscacs 0.94")
            res2 = companion_router.telemetry_flush(
                companion_router.TelemetryFlushRequest(
                    game_id=gid,
                    pgn=FAKE_ZERO_ACPL_PGN,
                    player_color="white",
                    termination_type="MANUAL_RESIGN",
                )
            )
            self.assertFalse(res2["discarded"])
            self.assertEqual(res2["data_tier"], "Silver")
            self.assertEqual(res2["ply_count"], 4)

            # Verify single row with BOTH SQL columns and pgn populated
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row
            try:
                rows = conn.execute("SELECT * FROM Games").fetchall()
            finally:
                conn.close()

            self.assertEqual(len(rows), 1)
            row = dict(rows[0])
            self.assertEqual(row["game_id"], gid)
            self.assertEqual(row["WHITE"], "Player (Human)")
            self.assertEqual(row["BLACK"], "Andscacs 0.94")
            self.assertEqual(row["ROUND"], "-")
            self.assertEqual(row["DATE"], "2026.11.18")
            self.assertEqual(row["ECO"], "B20")
            self.assertEqual(row["PLYCOUNT"], 4)
            self.assertIn('[DataTier "Silver"]', row["pgn"])
            self.assertNotIn('user="0" engine="0"', row["pgn"])
            self.assertEqual(row["pgn"], row["_DATA_"])

            # Verify Data Fitness audit classifies it as Silver with 0 quarantine
            audit = self.fitness.audit_database("Sparring_Games.sqlite")
            self.assertEqual(audit["tiers"]["tier_0_quarantine"], 0)
            self.assertEqual(audit["tiers"]["tier_2_silver"], 1)
            self.assertEqual(audit["tiers"]["tier_3_gold"], 0)
        finally:
            companion_router.companion_mgr.sparring_repo = orig_repo

    def test_honest_silver_vs_gold_classification(self):
        cleaned = strip_fake_zero_acpl_comments(FAKE_ZERO_ACPL_PGN)
        self.assertNotIn("[%acpl", cleaned)
        self.assertFalse(has_genuine_gold_eval(FAKE_ZERO_ACPL_PGN, ply_count=4))
        self.assertTrue(has_genuine_gold_eval(REAL_GOLD_PGN, ply_count=4))

    def test_normalize_player_name_protects_and_repairs_engines(self):
        self.assertEqual(DataFitnessService.normalize_player_name("Andscacs 0.94"), "Andscacs 0.94")
        self.assertEqual(DataFitnessService.normalize_player_name("Rybka 2.3"), "Rybka 2.3")
        self.assertEqual(DataFitnessService.normalize_player_name("Cheng 4.41"), "Cheng 4.41")
        # Un-mangle previously inverted engine names
        self.assertEqual(DataFitnessService.normalize_player_name("0.94, Andscacs"), "Andscacs 0.94")
        self.assertEqual(DataFitnessService.normalize_player_name("2.3, Rybka"), "Rybka 2.3")
        self.assertEqual(DataFitnessService.normalize_player_name("4.41, Cheng"), "Cheng 4.41")
        # Still normalizes regular human player names
        self.assertEqual(DataFitnessService.normalize_player_name("Garry Kasparov"), "Kasparov, Garry")

    def test_repair_sparring_database_backfills_repairs_and_prunes_only_stubs(self):
        conn = sqlite3.connect(self.db_path)
        try:
            # 1. Legacy companion row: pgn-only with NULL WHITE/BLACK/PLYCOUNT/_DATA_ (previously quarantined!)
            conn.execute(
                "INSERT INTO Games (game_id, started_at, opponent_engine, pgn, RESULT) VALUES (?, ?, ?, ?, ?)",
                ("legacy-pgn-only", "2026-11-18T00:00:00Z", "Andscacs 0.94", FAKE_ZERO_ACPL_PGN, "*"),
            )
            # 2. Mangled engine name row + fake Gold heuristic block
            conn.execute(
                "INSERT INTO Games (WHITE, BLACK, RESULT, DATE, ROUND, ECO, OPENING, PLYCOUNT, _DATA_) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    "Player (Human)", "2.3, Rybka", "0-1", "2026.11.18", "1", "-", "GMopenings.bin", 4,
                    '[Event "DeepScout Engine Sparring"]\n[White "Player (Human)"]\n[Black "2.3, Rybka"]\n[Result "0-1"]\n\n1. d4 d5 2. c4 e6 0-1\n\n[%provenance engine="Stockfish 17" depth="22"]\n[%acpl global="66.6"]\n',
                ),
            )
            # 3. Genuine Gold row
            conn.execute(
                "INSERT INTO Games (WHITE, BLACK, RESULT, DATE, ROUND, ECO, OPENING, PLYCOUNT, _DATA_) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("Player (Human)", "Stockfish 18", "0-1", "2026.11.18", "-", "B20", "Sicilian Defense", 4, REAL_GOLD_PGN),
            )
            # 4. True 0-ply empty stub (should be purged)
            conn.execute(
                "INSERT INTO Games (game_id, started_at, opponent_engine, pgn, RESULT) VALUES (?, ?, ?, ?, ?)",
                ("empty-0-ply-stub", "2026-11-18T00:00:00Z", "Rybka 2.3", "", "*"),
            )
            conn.commit()
        finally:
            conn.close()

        # Even BEFORE repair, PGN-aware audit must not quarantine the 4-ply legacy pgn-only row!
        pre_audit = self.fitness.audit_database("Sparring_Games.sqlite")
        self.assertEqual(pre_audit["tiers"]["tier_0_quarantine"], 1)  # ONLY the 0-ply stub

        report = self.fitness.repair_sparring_database("Sparring_Games.sqlite")
        self.assertEqual(report["purged_empty_stubs"], 1)
        self.assertGreaterEqual(report["backfilled_rows"], 1)
        self.assertGreaterEqual(report["repaired_engine_names"], 1)
        self.assertEqual(report["confirmed_gold"], 1)
        self.assertEqual(report["audit_after"]["tiers"]["tier_0_quarantine"], 0)
        self.assertEqual(report["audit_after"]["tiers"]["tier_2_silver"], 2)
        self.assertEqual(report["audit_after"]["tiers"]["tier_3_gold"], 1)

        # Verify GameRepository.list_games sees clean repaired names & honest tiers
        repo = GameRepository(self.db_path)
        listed = repo.list_games(page=1, page_size=20)
        self.assertEqual(listed["total"], 3)
        blacks = {g["BLACK"] for g in listed["games"]}
        self.assertIn("Rybka 2.3", blacks)
        self.assertIn("Andscacs 0.94", blacks)
        self.assertNotIn("2.3, Rybka", blacks)


class TestPass1BackendFixes(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_clone_and_register_same_binary_preserves_existing_profile(self):
        fake_exe = os.path.join(self.test_dir, "stockfish_mock.exe")
        with open(fake_exe, "wb") as f:
            f.write(b"MZ" + b"\x00" * 1234)

        svc = UCIEngineService(self.test_dir)
        fake_probe = {
            "success": True,
            "path": os.path.abspath(fake_exe),
            "name": "Stockfish Mock",
            "author": "SF Team",
            "supports_elo": True,
            "supports_threads": True,
            "supports_hash": True,
            "supports_syzygy": False,
            "options": {},
        }
        with patch.object(svc, "test_uci_engine", return_value=fake_probe):
            p1 = svc.register_custom_engine(name="Stockfish Sparring", path=fake_exe, options={"UCI_Elo": 1600})
            p2 = svc.register_custom_engine(name="Stockfish Analyzer", path=fake_exe, options={"Hash": 512})

        self.assertNotEqual(p1["id"], p2["id"])
        saved = svc._load_custom_engines()
        saved_ids = {e["id"] for e in saved}
        self.assertIn(p1["id"], saved_ids)
        self.assertIn(p2["id"], saved_ids)
        self.assertEqual(len(saved), 2)

    def test_get_engine_logs_not_double_wrapped(self):
        companion_router.companion_engine_service.log_uci("sparring", ">> uci")
        single = companion_router.get_engine_logs(subsystem="sparring")
        self.assertEqual(single["subsystem"], "sparring")
        self.assertIsInstance(single["logs"], list)
        self.assertIn(">> uci", single["logs"])

        all_logs = companion_router.get_engine_logs(subsystem=None)
        self.assertIn("sparring", all_logs)
        self.assertIsInstance(all_logs["sparring"], list)

    def test_blocking_routes_are_sync_def_for_threadpool(self):
        sync_endpoints = [
            companion_router.create_sparring_game,
            companion_router.telemetry_flush,
            companion_router.get_engine_logs,
            companion_router.engine_handshake,
            engine_router.list_engines,
            engine_router.play_engine_move,
            engine_router.evaluate_position,
            engine_router.request_engine_variations,
            engine_router.browse_engine_file,
            fitness_router.audit_database,
            fitness_router.sanitize_database,
            fitness_router.repair_sparring_database,
            fitness_router.generate_silver_statistics,
            ai_router.generate_commentary,
            ai_router.test_connection,
            consolidator_router.merge_databases,
            dossier_router.get_player_dossier,
            openings_router.probe_opening_book,
            openings_router.save_repertoire_edge,
        ]
        for fn in sync_endpoints:
            self.assertFalse(
                inspect.iscoroutinefunction(fn),
                f"{fn.__module__}.{fn.__name__} must be sync `def` so FastAPI offloads blocking I/O to threadpool",
            )


if __name__ == "__main__":
    unittest.main()
