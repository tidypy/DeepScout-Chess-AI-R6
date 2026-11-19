"""
Companion Engine Subsystem - Dedicated SQLite Repositories
Implements Section 5 database schemas and the non-negotiable join contract:
(game_id, ply, fen).
"""

import os
import sqlite3
import json
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any, Tuple
from core.features.engine.companion_types import (
    SparringGameRecord,
    KibitzerVariationRecord,
    TutorFlagRecord,
    TutorInterruptMode,
    KibitzerTriggerSource,
    KibitzerLoggedBy,
    TutorFlagType,
    TutorOutcome,
    TutorTriggerSource,
)
from core.persistence.database import (
    strip_fake_zero_acpl_comments,
    count_pgn_plies,
    extract_pgn_metadata,
    set_pgn_header,
    has_genuine_gold_eval,
)

def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()

def _get_connection(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, timeout=30.0, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA busy_timeout = 10000;")
        conn.execute("PRAGMA synchronous = NORMAL;")
    except Exception:
        pass
    return conn

def _normalize_game_row(row_dict: Dict[str, Any]) -> Dict[str, Any]:
    """Ensures both canonical uppercase and companion lowercase keys are accessible."""
    out = dict(row_dict)
    if "result" not in out and "RESULT" in out:
        out["result"] = out["RESULT"]
    if "RESULT" not in out and "result" in out:
        out["RESULT"] = out["result"]
    if not out.get("pgn") and out.get("_DATA_"):
        raw = out["_DATA_"]
        out["pgn"] = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
    return out

# -----------------------------------------------------------------------------
# 1. Sparring Games Repository (Sparring_Games.sqlite) - Section 5.2
# -----------------------------------------------------------------------------

class SparringGamesRepository:
    """
    Persistence store for live game records.
    Database: Sparring_Games.sqlite
    Uses lazy UPSERT (>= 2 plies only) and populates both standard SQLite
    columns (WHITE.._DATA_) and companion columns without running ALTER TABLE.
    """
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._pending_sessions: Dict[str, Dict[str, Any]] = {}
        self._init_schema()

    def _get_games_table(self, cur: sqlite3.Cursor) -> str:
        cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND LOWER(name)='games'")
        row = cur.fetchone()
        return row[0] if row else "Games"

    def _init_schema(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.db_path)), exist_ok=True)
        conn = _get_connection(self.db_path)
        try:
            cur = conn.cursor()
            cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND LOWER(name)='games'")
            existing_row = cur.fetchone()

            if existing_row is None:
                # Unified non-destructive schema supporting both standard SQL columns & companion metadata
                cur.execute("""
                    CREATE TABLE IF NOT EXISTS Games (
                        WHITE                TEXT,
                        BLACK                TEXT,
                        RESULT               TEXT,
                        EVENT                TEXT,
                        SITE                 TEXT,
                        DATE                 TEXT,
                        ROUND                TEXT,
                        ECO                  TEXT,
                        OPENING              TEXT,
                        WHITEELO             INTEGER,
                        BLACKELO             INTEGER,
                        PLYCOUNT             INTEGER,
                        FEN                  TEXT,
                        _DATA_               BLOB,
                        game_id              TEXT,
                        started_at           TEXT,
                        opponent_engine      TEXT,
                        user_time_control    TEXT,
                        tutor_interrupt_mode TEXT,
                        pgn                  TEXT
                    );
                """)
                table_name = "Games"
            else:
                table_name = existing_row[0]

            cur.execute(f"PRAGMA table_info({table_name})")
            existing_cols = {row["name"].lower() for row in cur.fetchall()}

            for idx_name, col in [
                ("idx_games_started_at", "started_at"),
                ("idx_games_opponent", "opponent_engine"),
                ("idx_games_game_id", "game_id"),
                ("idx_games_white", "white"),
                ("idx_games_black", "black"),
            ]:
                if col in existing_cols:
                    try:
                        cur.execute(f"CREATE INDEX IF NOT EXISTS {idx_name} ON {table_name}({col});")
                    except Exception:
                        pass

            conn.commit()
        finally:
            conn.close()

    def create_game(
        self,
        opponent_engine: str,
        game_id: Optional[str] = None,
        user_time_control: Optional[str] = "unlimited",
        tutor_interrupt_mode: TutorInterruptMode = "passive_log",
        pgn: Optional[str] = "",
        result: Optional[str] = "*",
    ) -> SparringGameRecord:
        """
        Mints a game_id and caches session metadata lazily without writing
        an empty 0-ply stub row to SQLite. Persists only when >= 2 plies exist.
        """
        gid = game_id or str(uuid.uuid4())
        started_at = _utc_now_iso()

        record: SparringGameRecord = {
            "game_id": gid,
            "started_at": started_at,
            "opponent_engine": opponent_engine,
            "user_time_control": user_time_control,
            "tutor_interrupt_mode": tutor_interrupt_mode,
            "pgn": pgn or "",
            "result": result or "*",
        }
        self._pending_sessions[gid] = dict(record)

        # Only persist immediately if caller explicitly passed a valid >= 2 ply PGN
        if pgn and count_pgn_plies(pgn) >= 2:
            self.upsert_game(
                game_id=gid,
                pgn=pgn,
                result=result,
                opponent_engine=opponent_engine,
                started_at=started_at,
                user_time_control=user_time_control,
                tutor_interrupt_mode=tutor_interrupt_mode,
            )

        return record

    def delete_stub_if_exists(self, game_id: str) -> bool:
        """Deletes any stale 0/1-ply stub for game_id and clears pending cache."""
        self._pending_sessions.pop(game_id, None)
        if not game_id:
            return False
        conn = _get_connection(self.db_path)
        try:
            cur = conn.cursor()
            table_name = self._get_games_table(cur)
            cur.execute(f"PRAGMA table_info({table_name})")
            cols = {row["name"].lower(): row["name"] for row in cur.fetchall()}
            if "game_id" not in cols:
                return False
            gid_col = cols["game_id"]
            if "plycount" in cols:
                ply_col = cols["plycount"]
                cur.execute(
                    f"DELETE FROM {table_name} WHERE {gid_col} = ? AND ({ply_col} IS NULL OR {ply_col} < 2)",
                    (game_id,),
                )
            else:
                cur.execute(
                    f"DELETE FROM {table_name} WHERE {gid_col} = ? AND (pgn IS NULL OR TRIM(pgn) = '')",
                    (game_id,),
                )
            deleted = cur.rowcount > 0
            conn.commit()
            return deleted
        finally:
            conn.close()

    def upsert_game(
        self,
        game_id: str,
        pgn: str,
        result: Optional[str] = None,
        opponent_engine: Optional[str] = None,
        player_color: Optional[str] = None,
        started_at: Optional[str] = None,
        user_time_control: Optional[str] = None,
        tutor_interrupt_mode: Optional[str] = None,
    ) -> bool:
        """
        Atomically UPSERTs a sparring game into SQLite ONLY if ply_count >= 2.
        Populates both standard SQLite columns (WHITE.._DATA_) and companion
        columns (`game_id`, `pgn`, etc.) without executing ALTER TABLE.
        """
        cleaned_pgn = strip_fake_zero_acpl_comments(pgn or "")
        ply_count = count_pgn_plies(cleaned_pgn)
        if ply_count < 2:
            self.delete_stub_if_exists(game_id)
            return False

        pending = self._pending_sessions.get(game_id, {})
        eff_opponent = opponent_engine or pending.get("opponent_engine") or "Sparring Engine"
        eff_started = started_at or pending.get("started_at") or _utc_now_iso()
        eff_tc = user_time_control or pending.get("user_time_control") or "unlimited"
        eff_tutor_mode = tutor_interrupt_mode or pending.get("tutor_interrupt_mode") or "passive_log"

        meta = extract_pgn_metadata(cleaned_pgn, fallback_today_date=True, is_sparring=True)

        # Resolve players cleanly if PGN lacked White/Black headers
        color = (player_color or "white").lower()
        white = meta["WHITE"] or ("Player (Human)" if color == "white" else eff_opponent)
        black = meta["BLACK"] or (eff_opponent if color == "white" else "Player (Human)")
        eff_result = (result or meta["RESULT"] or "*").strip()
        if eff_result not in ("1-0", "0-1", "1/2-1/2", "*"):
            eff_result = "*"

        # Ensure PGN headers match standardized SQL columns
        enriched_pgn = cleaned_pgn
        enriched_pgn = set_pgn_header(enriched_pgn, "Event", meta["EVENT"])
        enriched_pgn = set_pgn_header(enriched_pgn, "Site", meta["SITE"])
        enriched_pgn = set_pgn_header(enriched_pgn, "Date", meta["DATE"])
        enriched_pgn = set_pgn_header(enriched_pgn, "Round", "-")
        enriched_pgn = set_pgn_header(enriched_pgn, "White", white)
        enriched_pgn = set_pgn_header(enriched_pgn, "Black", black)
        enriched_pgn = set_pgn_header(enriched_pgn, "Result", eff_result)
        enriched_pgn = set_pgn_header(enriched_pgn, "ECO", meta["ECO"])
        if meta["OPENING"]:
            enriched_pgn = set_pgn_header(enriched_pgn, "Opening", meta["OPENING"])
        if game_id:
            enriched_pgn = set_pgn_header(enriched_pgn, "GameId", game_id)

        # Honest Silver vs. Gold tier stamp
        data_tier = "Gold" if has_genuine_gold_eval(enriched_pgn, ply_count=ply_count) else "Silver"
        enriched_pgn = set_pgn_header(enriched_pgn, "DataTier", data_tier)

        col_values: Dict[str, Any] = {
            "white": white,
            "black": black,
            "result": eff_result,
            "event": meta["EVENT"],
            "site": meta["SITE"],
            "date": meta["DATE"],
            "round": "-",
            "eco": meta["ECO"],
            "opening": meta["OPENING"],
            "whiteelo": meta["WHITEELO"] if meta["WHITEELO"] is not None else "",
            "blackelo": meta["BLACKELO"] if meta["BLACKELO"] is not None else "",
            "plycount": ply_count,
            "fen": meta["FEN"],
            "_data_": enriched_pgn,
            "game_id": game_id,
            "started_at": eff_started,
            "opponent_engine": eff_opponent,
            "user_time_control": eff_tc,
            "tutor_interrupt_mode": eff_tutor_mode,
            "pgn": enriched_pgn,
        }

        conn = _get_connection(self.db_path)
        try:
            cur = conn.cursor()
            table_name = self._get_games_table(cur)
            cur.execute(f"PRAGMA table_info({table_name})")
            existing_lower = {row["name"].lower(): row["name"] for row in cur.fetchall()}

            write_pairs = [
                (existing_lower[k], v)
                for k, v in col_values.items()
                if k in existing_lower
            ]
            if not write_pairs:
                return False

            existing_rowid = None
            if "game_id" in existing_lower:
                gid_col = existing_lower["game_id"]
                cur.execute(f"SELECT ROWID FROM {table_name} WHERE {gid_col} = ?", (game_id,))
                found = cur.fetchone()
                if found:
                    existing_rowid = found[0]
            if existing_rowid is None and "_data_" in existing_lower and game_id:
                data_col = existing_lower["_data_"]
                cur.execute(
                    f"SELECT ROWID FROM {table_name} WHERE CAST({data_col} AS TEXT) LIKE ?",
                    (f'%[GameId "{game_id}"]%',),
                )
                found = cur.fetchone()
                if found:
                    existing_rowid = found[0]

            if existing_rowid is not None:
                set_clause = ", ".join(f"{c} = ?" for c, _ in write_pairs)
                vals = [v for _, v in write_pairs] + [existing_rowid]
                cur.execute(f"UPDATE {table_name} SET {set_clause} WHERE ROWID = ?", vals)
            else:
                cols_sql = ", ".join(c for c, _ in write_pairs)
                placeholders = ", ".join("?" for _ in write_pairs)
                cur.execute(
                    f"INSERT INTO {table_name} ({cols_sql}) VALUES ({placeholders})",
                    [v for _, v in write_pairs],
                )

            conn.commit()
            self._pending_sessions.pop(game_id, None)
            return True
        finally:
            conn.close()

    def update_game_pgn(self, game_id: str, pgn: str, result: Optional[str] = None) -> bool:
        """Backward-compatible wrapper that performs lazy atomic UPSERT (>= 2 plies)."""
        return self.upsert_game(game_id=game_id, pgn=pgn, result=result)

    def get_game(self, game_id: str) -> Optional[SparringGameRecord]:
        conn = _get_connection(self.db_path)
        try:
            cur = conn.cursor()
            table_name = self._get_games_table(cur)
            cur.execute(f"SELECT * FROM {table_name} WHERE game_id = ?", (game_id,))
            row = cur.fetchone()
            return _normalize_game_row(dict(row)) if row else None
        finally:
            conn.close()

    def list_games(self, limit: int = 50, offset: int = 0) -> List[SparringGameRecord]:
        conn = _get_connection(self.db_path)
        try:
            cur = conn.cursor()
            table_name = self._get_games_table(cur)
            cur.execute(f"SELECT * FROM {table_name} ORDER BY started_at DESC LIMIT ? OFFSET ?", (limit, offset))
            return [_normalize_game_row(dict(r)) for r in cur.fetchall()]
        finally:
            conn.close()

# -----------------------------------------------------------------------------
# 2. Kibitzer Analysis Repository (Kibitzer_Analysis.sqlite) - Section 5.3
# -----------------------------------------------------------------------------

class KibitzerAnalysisRepository:
    """
    Persistence store for roads-not-taken alternative variations.
    Database: Kibitzer_Analysis.sqlite
    """
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._init_schema()

    def _init_schema(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.db_path)), exist_ok=True)
        conn = _get_connection(self.db_path)
        try:
            cur = conn.cursor()
            cur.execute("""
                CREATE TABLE IF NOT EXISTS variations (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_id         TEXT NOT NULL,
                    ply             INTEGER NOT NULL,
                    fen             TEXT NOT NULL,
                    engine          TEXT NOT NULL,
                    pgn_fragment    TEXT NOT NULL,
                    eval_data       TEXT,
                    trigger_source  TEXT NOT NULL,
                    logged_by       TEXT NOT NULL,
                    was_played      INTEGER,
                    saved_at        TEXT NOT NULL
                );
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_kibitzer_game_ply ON variations(game_id, ply);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_kibitzer_fen ON variations(fen);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_kibitzer_trigger ON variations(trigger_source);")
            conn.commit()
        finally:
            conn.close()

    def log_variation(
        self,
        game_id: str,
        ply: int,
        fen: str,
        engine: str,
        pgn_fragment: str,
        eval_data: Optional[Any] = None,
        trigger_source: KibitzerTriggerSource = "get_advise",
        logged_by: KibitzerLoggedBy = "user_save",
        was_played: Optional[bool] = None,
    ) -> int:
        eval_str = json.dumps(eval_data) if isinstance(eval_data, (dict, list)) else (str(eval_data) if eval_data is not None else None)
        was_played_int = None if was_played is None else (1 if was_played else 0)
        saved_at = _utc_now_iso()

        conn = _get_connection(self.db_path)
        try:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO variations (game_id, ply, fen, engine, pgn_fragment, eval_data, trigger_source, logged_by, was_played, saved_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (game_id, ply, fen, engine, pgn_fragment, eval_str, trigger_source, logged_by, was_played_int, saved_at))
            var_id = cur.lastrowid
            conn.commit()
            return var_id
        finally:
            conn.close()

    def update_was_played(self, game_id: str, ply: int, was_played: bool) -> int:
        conn = _get_connection(self.db_path)
        try:
            cur = conn.cursor()
            cur.execute("UPDATE variations SET was_played = ? WHERE game_id = ? AND ply = ?", (1 if was_played else 0, game_id, ply))
            updated = cur.rowcount
            conn.commit()
            return updated
        finally:
            conn.close()

    def get_variations_for_game(self, game_id: str) -> List[KibitzerVariationRecord]:
        conn = _get_connection(self.db_path)
        try:
            cur = conn.cursor()
            cur.execute("SELECT * FROM variations WHERE game_id = ? ORDER BY ply ASC, id ASC", (game_id,))
            rows = [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()
        for r in rows:
            if r.get("was_played") is not None:
                r["was_played"] = bool(r["was_played"])
        return rows

    def get_variations_for_fen(self, fen: str) -> List[KibitzerVariationRecord]:
        conn = _get_connection(self.db_path)
        try:
            cur = conn.cursor()
            cur.execute("SELECT * FROM variations WHERE fen = ? ORDER BY saved_at DESC", (fen,))
            rows = [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()
        for r in rows:
            if r.get("was_played") is not None:
                r["was_played"] = bool(r["was_played"])
        return rows

# -----------------------------------------------------------------------------
# 3. Tutor Games Repository (Tutor_Games.sqlite) - Section 5.4
# -----------------------------------------------------------------------------

class TutorGamesRepository:
    """
    Persistence store for reinforcement flag events and suggestions.
    Database: Tutor_Games.sqlite
    """
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._init_schema()

    def _init_schema(self):
        os.makedirs(os.path.dirname(os.path.abspath(self.db_path)), exist_ok=True)
        conn = _get_connection(self.db_path)
        try:
            cur = conn.cursor()
            cur.execute("""
                CREATE TABLE IF NOT EXISTS flags (
                    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
                    game_id             TEXT NOT NULL,
                    ply                 INTEGER NOT NULL,
                    fen                 TEXT NOT NULL,
                    flag_type           TEXT NOT NULL,
                    engine              TEXT NOT NULL,
                    centipawn_data      TEXT,
                    suggested_variations TEXT,
                    tutor_outcome       TEXT NOT NULL,
                    trigger_source      TEXT NOT NULL,
                    logged_at           TEXT NOT NULL
                );
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_tutor_game_ply ON flags(game_id, ply);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_tutor_flag_type ON flags(flag_type);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_tutor_outcome ON flags(tutor_outcome);")
            conn.commit()
        finally:
            conn.close()

    def log_flag(
        self,
        game_id: str,
        ply: int,
        fen: str,
        flag_type: TutorFlagType,
        engine: str,
        centipawn_data: Optional[Any] = None,
        suggested_variations: Optional[Any] = None,
        tutor_outcome: TutorOutcome = "ignored_flag",
        trigger_source: TutorTriggerSource = "flag_triggered",
    ) -> int:
        cp_str = json.dumps(centipawn_data) if isinstance(centipawn_data, (dict, list)) else (str(centipawn_data) if centipawn_data is not None else None)
        sug_str = json.dumps(suggested_variations) if isinstance(suggested_variations, (dict, list)) else (str(suggested_variations) if suggested_variations is not None else None)
        logged_at = _utc_now_iso()

        conn = _get_connection(self.db_path)
        try:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO flags (game_id, ply, fen, flag_type, engine, centipawn_data, suggested_variations, tutor_outcome, trigger_source, logged_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (game_id, ply, fen, flag_type, engine, cp_str, sug_str, tutor_outcome, trigger_source, logged_at))
            flag_id = cur.lastrowid
            conn.commit()
            return flag_id
        finally:
            conn.close()

    def update_tutor_outcome(self, flag_id: int, outcome: TutorOutcome) -> bool:
        conn = _get_connection(self.db_path)
        try:
            cur = conn.cursor()
            cur.execute("UPDATE flags SET tutor_outcome = ? WHERE id = ?", (outcome, flag_id))
            updated = cur.rowcount > 0
            conn.commit()
            return updated
        finally:
            conn.close()

    def get_flags_for_game(self, game_id: str) -> List[TutorFlagRecord]:
        conn = _get_connection(self.db_path)
        try:
            cur = conn.cursor()
            cur.execute("SELECT * FROM flags WHERE game_id = ? ORDER BY ply ASC, id ASC", (game_id,))
            return [dict(r) for r in cur.fetchall()]
        finally:
            conn.close()

# -----------------------------------------------------------------------------
# 4. Unified Companion Data Manager (Cross-DB Joins) - Section 5.1 & 5.5
# -----------------------------------------------------------------------------

class CompanionDataManager:
    """
    Coordinates access to the 3 discrete SQLite databases, maintaining the
    shared join contract (game_id, ply, fen) without coupling runtime logic.
    """
    def __init__(self, root_dir: str):
        self.root_dir = root_dir
        self.sparring_repo = SparringGamesRepository(os.path.join(root_dir, "Sparring_Games.sqlite"))
        self.kibitzer_repo = KibitzerAnalysisRepository(os.path.join(root_dir, "Kibitzer_Analysis.sqlite"))
        self.tutor_repo = TutorGamesRepository(os.path.join(root_dir, "Tutor_Games.sqlite"))

    def get_full_game_dossier(self, game_id: str) -> Dict[str, Any]:
        """
        Executes non-invasive correlation across the 3 independent databases.
        """
        game = self.sparring_repo.get_game(game_id)
        if not game:
            return {"error": f"Game {game_id} not found."}

        variations = self.kibitzer_repo.get_variations_for_game(game_id)
        flags = self.tutor_repo.get_flags_for_game(game_id)

        # Correlate by ply
        ply_map: Dict[int, Dict[str, Any]] = {}
        for f in flags:
            p = f["ply"]
            if p not in ply_map:
                ply_map[p] = {"ply": p, "fen": f["fen"], "tutor_flags": [], "kibitzer_variations": []}
            ply_map[p]["tutor_flags"].append(f)

        for v in variations:
            p = v["ply"]
            if p not in ply_map:
                ply_map[p] = {"ply": p, "fen": v["fen"], "tutor_flags": [], "kibitzer_variations": []}
            ply_map[p]["kibitzer_variations"].append(v)

        sorted_plies = sorted(ply_map.values(), key=lambda x: x["ply"])

        return {
            "game": game,
            "timeline": sorted_plies,
            "total_tutor_flags": len(flags),
            "total_kibitzer_variations": len(variations),
        }
