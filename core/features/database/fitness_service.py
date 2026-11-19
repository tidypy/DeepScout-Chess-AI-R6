import os
import re
import io
import json
import sqlite3
import hashlib
import chess
import chess.pgn
from typing import Dict, Any, List, Optional, Tuple, Set
from core.features.dossier.chess_math import Glicko2Calculator, ChessPerformanceCalculator
from core.persistence.database import (
    strip_fake_zero_acpl_comments,
    count_pgn_plies,
    set_pgn_header,
    extract_pgn_metadata,
    has_genuine_gold_eval,
    infer_eco_and_opening,
    normalize_pgn_date,
)

BASE_ENGINE_KEYWORDS: Set[str] = {
    "stockfish", "maia", "patricia", "ct800", "berserk", "dragon", "komodo",
    "lc0", "leela", "sparring", "andscacs", "cheng", "rybka", "houdini",
    "critter", "fruit", "toga", "rodent", "cdrill", "koivisto", "ethereal",
    "rubichess", "clover", "caissa", "viridithas", "weiss", "texel", "arasan",
    "crafty", "gull", "discocheck", "demolito", "cinnamon", "alaric",
    "wildcat", "zappa", "roce", "tarrasch", "irina", "hannibal", "hamsters",
}


def _load_dynamic_engine_tokens(root_dir: Optional[str] = None) -> Set[str]:
    """Dynamically aggregates built-in and user-registered engine tokens for name protection."""
    tokens: Set[str] = set(BASE_ENGINE_KEYWORDS)
    try:
        from core.features.engine.engine_service import DEFAULT_BUILTIN_ENGINES
        for eng in DEFAULT_BUILTIN_ENGINES:
            for field in ("id", "name"):
                val = str(eng.get(field) or "").strip().lower()
                if val:
                    tokens.add(val)
                    first_word = val.split()[0]
                    if len(first_word) >= 3:
                        tokens.add(first_word)
    except Exception:
        pass

    candidate_roots = []
    if root_dir:
        candidate_roots.append(root_dir)
    else:
        candidate_roots.append(
            os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
        )

    for base in candidate_roots:
        custom_path = os.path.join(base, "UserData", "custom_engines.json")
        if os.path.exists(custom_path):
            try:
                with open(custom_path, "r", encoding="utf-8") as f:
                    custom_list = json.load(f)
                if isinstance(custom_list, list):
                    for eng in custom_list:
                        if not isinstance(eng, dict):
                            continue
                        for field in ("id", "name"):
                            val = str(eng.get(field) or "").strip().lower()
                            if val:
                                tokens.add(val)
                                first_word = val.split()[0]
                                if len(first_word) >= 3:
                                    tokens.add(first_word)
            except Exception:
                pass
    return tokens

class AdjudicationCascade:
    """
    Deterministically resolves missing or ambiguous ('*') game results.
    Never leaves '*' un-adjudicated and never treats '*' as a default draw.
    """
    @staticmethod
    def resolve_from_termination(termination_str: Optional[str]) -> Optional[str]:
        if not termination_str:
            return None
        t = termination_str.lower()
        if "white resigned" in t or "black won" in t or "black wins" in t or "white forfeits" in t:
            return "0-1"
        if "black resigned" in t or "white won" in t or "white wins" in t or "black forfeits" in t:
            return "1-0"
        if "draw" in t or "stalemate" in t or "repetition" in t or "agreement" in t or "insufficient" in t or "50-move" in t:
            return "1/2-1/2"
        if "time forfeit" in t:
            if "white" in t: return "0-1"
            if "black" in t: return "1-0"
        return None

    @staticmethod
    def resolve_from_moves(moves_text: str) -> Optional[str]:
        """
        Detects terminal move patterns or explicit result string in move text.
        """
        if not moves_text:
            return None
        clean = moves_text.strip()

        # Strip PGN comments {...} and [%...] annotations first
        no_comments = re.sub(r"\{[^}]*\}", "", clean)
        no_comments = re.sub(r"\[%[^]]*\]", "", no_comments).strip()

        if no_comments.endswith("1-0") or no_comments.endswith("1 - 0"):
            return "1-0"
        if no_comments.endswith("0-1") or no_comments.endswith("0 - 1"):
            return "0-1"
        if no_comments.endswith("1/2-1/2") or no_comments.endswith("1/2 - 1/2") or no_comments.endswith("0.5-0.5"):
            return "1/2-1/2"

        tokens = [t for t in no_comments.split() if not t.endswith(".") and not t.isdigit() and not t.startswith("$")]
        if tokens and tokens[-1].endswith("#"):
            return "1-0" if len(tokens) % 2 != 0 else "0-1"
        return None

    @staticmethod
    def resolve_from_board(pgn_or_moves: str) -> Optional[str]:
        """
        Simulates game moves with python-chess to detect checkmate, stalemate, repetition, or insufficient material.
        """
        try:
            game = chess.pgn.read_game(io.StringIO(pgn_or_moves))
            if game:
                board = game.board()
                for move in game.mainline_moves():
                    board.push(move)
                if board.is_checkmate():
                    return "0-1" if board.turn == chess.WHITE else "1-0"
                if board.is_stalemate() or board.is_insufficient_material() or board.is_repetition(3) or board.is_fifty_moves():
                    return "1/2-1/2"
        except Exception:
            pass
        return None

    @staticmethod
    def resolve_from_eval(eval_cp: Optional[float]) -> Optional[str]:
        """
        Fallback terminal FEN evaluation threshold:
        Eval >= +200 cp (+2.0) -> 1-0
        Eval <= -200 cp (-2.0) -> 0-1
        |Eval| <= 55 cp (0.55) -> 1/2-1/2
        """
        if eval_cp is None:
            return None
        if eval_cp >= 200.0:
            return "1-0"
        if eval_cp <= -200.0:
            return "0-1"
        if abs(eval_cp) <= 55.0:
            return "1/2-1/2"
        return None


class DataFitnessService:
    """
    Orchestrates Data Fitness audits, sanitization, tier classification (T0 -> T3),
    and fast tag-derived Silver statistics generation.
    """
    def __init__(self, root_dir: str):
        self.root_dir = root_dir

    def _resolve_db_path(self, db_name: str) -> str:
        candidates = [
            os.path.join(self.root_dir, db_name),
            os.path.join(self.root_dir, "Resources", "IntFiles", db_name),
        ]
        for c in candidates:
            if os.path.exists(c):
                return c
        return os.path.join(self.root_dir, db_name)

    def _get_connection(self, db_path: str) -> sqlite3.Connection:
        conn = sqlite3.connect(db_path, timeout=30.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode = WAL;")
            conn.execute("PRAGMA busy_timeout = 10000;")
            conn.execute("PRAGMA synchronous = NORMAL;")
        except Exception:
            pass
        return conn

    @staticmethod
    def _is_engine_or_versioned_name(name: str, engine_tokens: Set[str]) -> bool:
        low = name.lower()
        if any(tok in low for tok in engine_tokens):
            return True
        # Protect versioned names like "Andscacs 0.94", "Rybka 2.3", "Cheng 4.41", "Engine v3.1"
        if re.search(r'(?:^|\s)v?\d+\.\d+(?:\.\d+)?[a-z]?(?:\s|$)', low):
            return True
        if re.search(r'(?:^|\s)(?:elo\s*)?\d{3,4}(?:\s|$)', low):
            return True
        return False

    @classmethod
    def normalize_player_name(cls, raw_name: Optional[str], root_dir: Optional[str] = None) -> str:
        """
        Cleans and normalizes human player name casing and whitespace while
        protecting all built-in + custom UCI engine names and repairing
        previously mangled engine names (e.g., '0.94, Andscacs' -> 'Andscacs 0.94').
        """
        if not raw_name or raw_name.strip() in ("?", "??", "", "Unknown", "None"):
            return "Unknown Player"
        name = raw_name.strip().strip('"').strip("'")

        if "Player" in name or "Human" in name:
            return "Player (Human)"

        engine_tokens = _load_dynamic_engine_tokens(root_dir)

        # Repair previously mangled engine names like "0.94, Andscacs" or "2.3, Rybka"
        if "," in name:
            left, right = [p.strip() for p in name.split(",", 1)]
            left_is_version = bool(re.match(r'^v?\d+(?:\.\d+)*[a-z]?$', left, re.IGNORECASE))
            right_is_engine = any(tok in right.lower() for tok in engine_tokens)
            if left_is_version or right_is_engine:
                return f"{right} {left}".strip()

        # Preserve engine names & versioned identifiers untouched
        if cls._is_engine_or_versioned_name(name, engine_tokens):
            return name.strip()

        # If 'Last, First'
        if "," in name:
            parts = [p.strip() for p in name.split(",", 1)]
            last = parts[0].title()
            first = parts[1].title() if len(parts) > 1 and parts[1] else ""
            if len(first) == 1:
                first += "."
            return f"{last}, {first}".strip(", ")

        # If 'First Last'
        parts = name.split()
        if len(parts) >= 2:
            return f"{parts[-1].title()}, {' '.join(parts[:-1]).title()}"

        return name.title()

    @staticmethod
    def normalize_date(raw_date: Optional[str]) -> str:
        """
        Standardizes dates to ISO YYYY.MM.DD format, safely handling partials ('????.??.??').
        """
        if not raw_date or not raw_date.strip():
            return "????.??.??"
        d = raw_date.strip().replace("-", ".").replace("/", ".")
        parts = d.split(".")
        if len(parts) == 3:
            year = parts[0] if len(parts[0]) == 4 and parts[0].isdigit() else "????"
            month = parts[1].zfill(2) if parts[1].isdigit() and 1 <= int(parts[1]) <= 12 else "??"
            day = parts[2].zfill(2) if parts[2].isdigit() and 1 <= int(parts[2]) <= 31 else "??"
            return f"{year}.{month}.{day}"
        if len(parts) == 1 and len(parts[0]) == 4 and parts[0].isdigit():
            return f"{parts[0]}.??.??"
        return "????.??.??"

    @staticmethod
    def classify_opening(moves_snippet: str, eco_header: Optional[str]) -> Tuple[str, str]:
        """
        Extracts or infers standard ECO and Opening System from initial moves.
        """
        if eco_header and len(eco_header.strip()) >= 3 and eco_header.strip() != "A00":
            return eco_header.strip().upper(), "Classified System"

        ms = (moves_snippet or "").lower().replace("  ", " ").strip()
        if "1. e4 c5" in ms or "1.e4 c5" in ms:
            return "B20", "Sicilian Defense"
        if "1. e4 e5" in ms or "1.e4 e5" in ms:
            if "2. nf3 nc6 3. bb5" in ms or "3.bb5" in ms:
                return "C60", "Ruy Lopez"
            if "2. nf3 nc6 3. bc4" in ms or "3.bc4" in ms:
                return "C50", "Italian Game"
            return "C20", "Open Game"
        if "1. e4 e6" in ms or "1.e4 e6" in ms:
            return "C00", "French Defense"
        if "1. e4 c6" in ms or "1.e4 c6" in ms:
            return "B10", "Caro-Kann Defense"
        if "1. d4 d5" in ms or "1.d4 d5" in ms:
            if "2. c4" in ms:
                return "D06", "Queen's Gambit"
            return "D00", "Queen's Pawn Game"
        if "1. d4 nf6" in ms or "1.d4 nf6" in ms:
            if "2. c4 g6" in ms:
                return "E60", "King's Indian Defense"
            if "2. c4 e6" in ms:
                return "E00", "Nimzo/Queen's Indian"
            return "A45", "Indian Defense"
        if "1. c4" in ms:
            return "A10", "English Opening"
        if "1. nf3" in ms:
            return "A04", "Réti Opening"
        return "A00", "Unclassified System"

    @staticmethod
    def _build_coalesced_select(cur: sqlite3.Cursor, table_name: str, extra_cols: List[str]) -> Tuple[str, Dict[str, str]]:
        """
        Inspects existing columns on `table_name` (non-destructively) and returns
        a SELECT column list with `COALESCE(NULLIF(_DATA_, ''), pgn) AS _DATA_`
        plus a lowercase->exact column map.
        """
        cur.execute(f"PRAGMA table_info({table_name})")
        col_map = {r["name"].lower(): r["name"] for r in cur.fetchall()}

        select_parts = ["ROWID as rowid"]
        for c in extra_cols:
            if c.lower() in col_map:
                select_parts.append(f"{col_map[c.lower()]} as {c.upper()}")
            else:
                select_parts.append(f"NULL as {c.upper()}")

        has_data = "_data_" in col_map
        has_pgn = "pgn" in col_map
        if has_data and has_pgn:
            select_parts.append(
                f"COALESCE(NULLIF({col_map['_data_']}, ''), {col_map['pgn']}) as _DATA_"
            )
        elif has_data:
            select_parts.append(f"{col_map['_data_']} as _DATA_")
        elif has_pgn:
            select_parts.append(f"{col_map['pgn']} as _DATA_")
        else:
            select_parts.append("'' as _DATA_")

        return ", ".join(select_parts), col_map

    @staticmethod
    def _decode_data(raw_data: Any) -> str:
        if not raw_data:
            return ""
        if isinstance(raw_data, bytes):
            return raw_data.decode("utf-8", errors="replace")
        return str(raw_data)

    def audit_database(self, db_name: str) -> Dict[str, Any]:
        """
        Full health scan and 4-tier categorization of games in a database.
        Coalesces `_DATA_` and `pgn`, uses `< 2` ply threshold, and separates
        honest Silver (`>= 2`-ply valid Seven Tag Roster) from genuine Gold.
        """
        db_path = self._resolve_db_path(db_name)
        if not os.path.exists(db_path):
            raise FileNotFoundError(f"Database {db_name} not found.")

        conn = self._get_connection(db_path)
        try:
            cur = conn.cursor()
            cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables_raw = [r[0] for r in cur.fetchall()]
            tables_lower = {t.lower(): t for t in tables_raw}
            if "games" in tables_lower:
                gtable = tables_lower["games"]
                select_sql, _ = self._build_coalesced_select(
                    cur,
                    gtable,
                    ["WHITE", "BLACK", "RESULT", "DATE", "EVENT", "ROUND", "ECO", "OPENING", "PLYCOUNT", "WHITEELO", "BLACKELO"],
                )
                cur.execute(f"SELECT {select_sql} FROM {gtable}")
                rows = [dict(r) for r in cur.fetchall()]
            elif "flags" in tables_lower:
                cur.execute("SELECT COUNT(*) FROM flags")
                flag_count = cur.fetchone()[0]
                return {
                    "database_name": db_name,
                    "total_games": flag_count,
                    "health_score": 100.0,
                    "grade": "A",
                    "tiers": {
                        "tier_0_quarantine": 0,
                        "tier_1_sanitized": 0,
                        "tier_2_silver": flag_count,
                        "tier_3_gold": 0,
                    },
                    "issues": {"missing_results": 0, "unclassified_ecos": 0, "missing_elos": 0, "short_stubs": 0, "corrupt_moves": 0},
                }
            elif "variations" in tables_lower:
                cur.execute("SELECT COUNT(*) FROM variations")
                var_count = cur.fetchone()[0]
                return {
                    "database_name": db_name,
                    "total_games": var_count,
                    "health_score": 100.0,
                    "grade": "A",
                    "tiers": {
                        "tier_0_quarantine": 0,
                        "tier_1_sanitized": 0,
                        "tier_2_silver": var_count,
                        "tier_3_gold": 0,
                    },
                    "issues": {"missing_results": 0, "unclassified_ecos": 0, "missing_elos": 0, "short_stubs": 0, "corrupt_moves": 0},
                }
            else:
                rows = []
        finally:
            conn.close()

        total_games = len(rows)
        if total_games == 0:
            return {
                "database_name": db_name,
                "total_games": 0,
                "health_score": 100.0,
                "grade": "A+",
                "tiers": {
                    "tier_0_quarantine": 0,
                    "tier_1_sanitized": 0,
                    "tier_2_silver": 0,
                    "tier_3_gold": 0,
                },
                "issues": {"missing_results": 0, "unclassified_ecos": 0, "missing_elos": 0, "short_stubs": 0, "corrupt_moves": 0},
            }

        t0_count, t1_count, t2_count, t3_count = 0, 0, 0, 0
        missing_results, unclassified_ecos, missing_elos, short_stubs, corrupt_moves = 0, 0, 0, 0, 0

        for r in rows:
            raw_data = self._decode_data(r.get("_DATA_"))
            cleaned_data = strip_fake_zero_acpl_comments(raw_data)

            white = (r.get("WHITE") or "").strip()
            black = (r.get("BLACK") or "").strip()
            result = (r.get("RESULT") or "").strip()
            date_val = (r.get("DATE") or "").strip()
            eco = (r.get("ECO") or "").strip()
            w_elo = str(r.get("WHITEELO") or "").strip()
            b_elo = str(r.get("BLACKELO") or "").strip()
            try:
                ply = int(r.get("PLYCOUNT") or 0)
            except (TypeError, ValueError):
                ply = 0

            # Hydrate from coalesced PGN whenever SQL columns are NULL/missing
            if cleaned_data and (not white or not black or ply < 2 or not result or not eco or not date_val):
                meta = extract_pgn_metadata(cleaned_data)
                if not white:
                    white = meta["WHITE"]
                if not black:
                    black = meta["BLACK"]
                if not result:
                    result = meta["RESULT"]
                if not date_val:
                    date_val = meta["DATE"]
                if not eco or eco == "-":
                    eco = meta["ECO"]
                if ply < 2:
                    ply = meta["PLYCOUNT"]
                if not w_elo and meta["WHITEELO"] is not None:
                    w_elo = str(meta["WHITEELO"])
                if not b_elo and meta["BLACKELO"] is not None:
                    b_elo = str(meta["BLACKELO"])

            # Tier 0 checks (corrupt / < 2 ply stubs)
            if not white or not black or white == "?" or black == "?" or ply < 2:
                t0_count += 1
                if ply < 2:
                    short_stubs += 1
                continue

            if result not in ("1-0", "0-1", "1/2-1/2", "0.5-0.5"):
                missing_results += 1

            if not eco or eco in ("A00", "-"):
                unclassified_ecos += 1

            if not (w_elo.isdigit() and int(w_elo) > 800) or not (b_elo.isdigit() and int(b_elo) > 800):
                missing_elos += 1

            declared_silver = bool(re.search(r'\[DataTier\s+"Silver"\]', cleaned_data, re.IGNORECASE))
            is_sparring_row = bool(
                re.search(r'\[Event\s+"[^"]*Sparring[^"]*"\]', cleaned_data, re.IGNORECASE)
                or (r.get("EVENT") or "").lower().find("sparring") >= 0
                or declared_silver
            )
            has_valid_date = bool(re.match(r'^\d{4}\.\d{2}\.\d{2}$', date_val))

            # Honest Tier 3 Gold vs Tier 2 Silver vs Tier 1 Sanitized
            if has_genuine_gold_eval(cleaned_data, ply_count=ply):
                t3_count += 1
            elif (
                declared_silver
                or (is_sparring_row and ply >= 2 and has_valid_date)
                or (eco and eco not in ("A00", "-") and (w_elo.isdigit() or b_elo.isdigit()))
            ):
                t2_count += 1
            else:
                t1_count += 1

        # Multi-dimensional tier-weighted health formula:
        # Tier 0 (Quarantine): 0% value
        # Tier 1 (Sanitized metadata): 45% value
        # Tier 2 (Silver Verified / Sparring): 80% value
        # Tier 3 (Gold Deep Engine Evaluated): 100% value
        tier_base_score = (t0_count * 0.0 + t1_count * 45.0 + t2_count * 80.0 + t3_count * 100.0) / total_games

        defect_ratio = (missing_results * 1.0 + unclassified_ecos * 0.5 + missing_elos * 0.3 + short_stubs * 2.5 + corrupt_moves * 5.0) / total_games
        penalty_deduction = min(30.0, defect_ratio * 30.0)

        health_score = round(max(5.0, min(100.0, tier_base_score - penalty_deduction)), 1)
        grade = "A+" if health_score >= 95 else "A" if health_score >= 88 else "B" if health_score >= 75 else "C" if health_score >= 60 else "Needs Repair"

        return {
            "database_name": db_name,
            "database_path": db_path,
            "total_games": total_games,
            "health_score": health_score,
            "grade": grade,
            "tiers": {
                "tier_0_quarantine": t0_count,
                "tier_1_sanitized": t1_count,
                "tier_2_silver": t2_count,
                "tier_3_gold": t3_count,
            },
            "issues": {
                "missing_results": missing_results,
                "unclassified_ecos": unclassified_ecos,
                "missing_elos": missing_elos,
                "short_stubs": short_stubs,
                "corrupt_moves": corrupt_moves,
            },
        }

    def clean_and_sanitize(
        self,
        db_name: str,
        purge_short_stubs: bool = True,
        auto_repair_results: bool = True,
        normalize_names_dates: bool = True,
    ) -> Dict[str, Any]:
        """
        Executes Tier 0 -> Tier 1/2 sanitization:
        - Coalesces `_DATA_` and `pgn` so companion rows are backfilled, not falsely purged
        - Prunes only genuine `< 2`-ply stubs
        - Adjudicates ambiguous '*' results
        - Normalizes human names & dates while protecting/un-mangling engine names
        - Updates SQLite database in an atomic WAL transaction
        """
        db_path = self._resolve_db_path(db_name)
        conn = self._get_connection(db_path)

        purged_count = 0
        repaired_results = 0
        normalized_records = 0

        try:
            cur = conn.cursor()
            cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables_lower = {r[0].lower(): r[0] for r in cur.fetchall()}
            if "games" not in tables_lower:
                return {
                    "status": "ok",
                    "database_name": db_name,
                    "purged_stubs_count": 0,
                    "repaired_results_count": 0,
                    "normalized_records_count": 0,
                }
            gtable = tables_lower["games"]
            select_sql, col_map = self._build_coalesced_select(
                cur,
                gtable,
                ["WHITE", "BLACK", "RESULT", "DATE", "EVENT", "ROUND", "ECO", "OPENING", "PLYCOUNT"],
            )
            cur.execute(f"SELECT {select_sql} FROM {gtable}")
            rows = [dict(r) for r in cur.fetchall()]

            has_data_col = "_data_" in col_map
            has_pgn_col = "pgn" in col_map
            has_ply_col = "plycount" in col_map

            delete_rowids = []
            updates = []

            for r in rows:
                rowid = r.get("rowid") or r.get("ROWID")
                raw_data = self._decode_data(r.get("_DATA_"))
                data = strip_fake_zero_acpl_comments(raw_data)

                white = (r.get("WHITE") or "").strip()
                black = (r.get("BLACK") or "").strip()
                res = (r.get("RESULT") or "").strip()
                date_val = (r.get("DATE") or "").strip()
                try:
                    ply = int(r.get("PLYCOUNT") or 0)
                except (TypeError, ValueError):
                    ply = 0

                # Backfill missing SQL metadata from coalesced PGN before evaluating stub deletion
                if data and (not white or not black or ply < 2 or not date_val or not res):
                    meta = extract_pgn_metadata(data)
                    if not white:
                        white = meta["WHITE"]
                    if not black:
                        black = meta["BLACK"]
                    if not res:
                        res = meta["RESULT"]
                    if not date_val:
                        date_val = meta["DATE"]
                    if ply < 2:
                        ply = meta["PLYCOUNT"]

                # 1. Prune only genuine < 2 ply stubs or completely unrecoverable rows
                if purge_short_stubs and (ply < 2 or not white or not black):
                    delete_rowids.append(rowid)
                    purged_count += 1
                    continue

                # 2. Result Adjudication Cascade
                new_res = res
                if auto_repair_results and (res == "*" or res == "" or res not in ("1-0", "0-1", "1/2-1/2", "0.5-0.5")):
                    new_res = (
                        AdjudicationCascade.resolve_from_moves(data)
                        or AdjudicationCascade.resolve_from_termination(data)
                        or AdjudicationCascade.resolve_from_board(data)
                        or "1/2-1/2"
                    )
                    if new_res != res:
                        repaired_results += 1

                # 3. Name and Date Normalization (protecting all engines + un-mangling)
                new_white = white
                new_black = black
                new_date = date_val

                if normalize_names_dates:
                    new_white = self.normalize_player_name(white, root_dir=self.root_dir)
                    new_black = self.normalize_player_name(black, root_dir=self.root_dir)
                    new_date = self.normalize_date(date_val)
                    if new_white != white or new_black != black or new_date != date_val:
                        normalized_records += 1

                # 4. Infer player/engine for sparring games if unknown
                if (new_white in ("Unknown Player", "?", "Unknown") or new_black in ("Unknown Player", "?", "Unknown")) and ("Sparring" in data or "DeepScout" in data or "Stockfish" in data or "Maia" in data):
                    if new_white in ("Unknown Player", "?", "Unknown"):
                        new_white = "Player (Human)"
                    if new_black in ("Unknown Player", "?", "Unknown"):
                        new_black = "Sparring Engine"

                # 5. Synchronize PGN text cleanly
                new_data = data
                if new_res and new_res != "*":
                    new_data = set_pgn_header(new_data, "Result", new_res)
                    new_data = re.sub(r'\s+\*\s*$', f' {new_res}', new_data)
                if new_white and new_white != "Unknown Player":
                    new_data = set_pgn_header(new_data, "White", new_white)
                if new_black and new_black != "Unknown Player":
                    new_data = set_pgn_header(new_data, "Black", new_black)
                if new_date and new_date != "????.??.??":
                    new_data = set_pgn_header(new_data, "Date", new_date)

                updates.append((new_white, new_black, new_res, new_date, ply, new_data, rowid))

            # Apply batch deletions
            if delete_rowids:
                cur.executemany(f"DELETE FROM {gtable} WHERE ROWID = ?", [(rid,) for rid in delete_rowids])

            # Apply batch updates dynamically matching existing columns
            if updates:
                set_cols = []
                if "white" in col_map:
                    set_cols.append((col_map["white"], 0))
                if "black" in col_map:
                    set_cols.append((col_map["black"], 1))
                if "result" in col_map:
                    set_cols.append((col_map["result"], 2))
                if "date" in col_map:
                    set_cols.append((col_map["date"], 3))
                if has_ply_col:
                    set_cols.append((col_map["plycount"], 4))
                if has_data_col:
                    set_cols.append((col_map["_data_"], 5))
                if has_pgn_col:
                    set_cols.append((col_map["pgn"], 5))

                if set_cols:
                    set_sql = ", ".join(f"{col_name} = ?" for col_name, _ in set_cols)
                    batch_params = [
                        tuple(u[idx] for _, idx in set_cols) + (u[6],)
                        for u in updates
                    ]
                    cur.executemany(f"UPDATE {gtable} SET {set_sql} WHERE ROWID = ?", batch_params)

            conn.commit()
        finally:
            conn.close()

        return {
            "status": "ok",
            "database_name": db_name,
            "purged_stubs_count": purged_count,
            "repaired_results_count": repaired_results,
            "normalized_records_count": normalized_records,
        }

    def repair_sparring_database(self, db_name: str = "Sparring_Games.sqlite") -> Dict[str, Any]:
        """
        Non-destructive repair & un-quarantine pass for `Sparring_Games.sqlite`:
        1. Backfills missing SQL columns (`WHITE.._DATA_`) from `pgn` (and keeps `pgn` synced).
        2. Repairs mangled engine names (e.g., `'0.94, Andscacs'` -> `'Andscacs 0.94'`).
        3. Strips fake zero-ACPL blocks and downgrades unanalyzed rows from fake Gold to Silver.
        4. Enforces Seven Tag Roster (`Date` = `YYYY.MM.DD`, `Round` = `"-"`, valid `ECO`).
        5. Purges ONLY true `< 2`-ply empty stubs.
        """
        db_path = self._resolve_db_path(db_name)
        if not os.path.exists(db_path):
            raise FileNotFoundError(f"Database {db_name} not found.")

        backfilled_rows = 0
        repaired_engine_names = 0
        downgraded_to_silver = 0
        confirmed_gold = 0
        confirmed_silver = 0
        purged_empty_stubs = 0

        conn = self._get_connection(db_path)
        try:
            cur = conn.cursor()
            cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables_lower = {r[0].lower(): r[0] for r in cur.fetchall()}
            if "games" not in tables_lower:
                return {
                    "status": "ok",
                    "database_name": db_name,
                    "backfilled_rows": 0,
                    "repaired_engine_names": 0,
                    "downgraded_to_silver": 0,
                    "confirmed_gold": 0,
                    "confirmed_silver": 0,
                    "purged_empty_stubs": 0,
                    "audit_after": self.audit_database(db_name),
                }

            gtable = tables_lower["games"]
            select_sql, col_map = self._build_coalesced_select(
                cur,
                gtable,
                [
                    "WHITE", "BLACK", "RESULT", "EVENT", "SITE", "DATE", "ROUND",
                    "ECO", "OPENING", "WHITEELO", "BLACKELO", "PLYCOUNT", "FEN", "OPPONENT_ENGINE",
                ],
            )
            cur.execute(f"SELECT {select_sql} FROM {gtable}")
            rows = [dict(r) for r in cur.fetchall()]

            delete_rowids: List[int] = []

            for r in rows:
                rowid = r.get("rowid") or r.get("ROWID")
                raw_data = self._decode_data(r.get("_DATA_"))
                had_fake_gold = bool(
                    re.search(r'\[%acpl[^\]]*\buser="0(?:\.0+)?"[^\]]*\bengine="0(?:\.0+)?"', raw_data)
                    or ("[DataTier \"Gold\"]" in raw_data)
                    or (
                        ("[%provenance" in raw_data or "[%acpl" in raw_data)
                        and not has_genuine_gold_eval(raw_data)
                    )
                )

                cleaned_pgn = strip_fake_zero_acpl_comments(raw_data)
                meta = extract_pgn_metadata(cleaned_pgn, fallback_today_date=True, is_sparring=True)

                try:
                    existing_ply = int(r.get("PLYCOUNT") or 0)
                except (TypeError, ValueError):
                    existing_ply = 0

                eff_ply = meta["PLYCOUNT"] if meta["PLYCOUNT"] > 0 else existing_ply
                if eff_ply < 2:
                    delete_rowids.append(rowid)
                    purged_empty_stubs += 1
                    continue

                orig_white = (r.get("WHITE") or "").strip()
                orig_black = (r.get("BLACK") or "").strip()
                orig_res = (r.get("RESULT") or "").strip()
                orig_date = (r.get("DATE") or "").strip()
                orig_round = (r.get("ROUND") or "").strip()
                orig_eco = (r.get("ECO") or "").strip()
                orig_opening = (r.get("OPENING") or "").strip()

                needs_backfill = (
                    not orig_white
                    or not orig_black
                    or existing_ply < 2
                    or not orig_date
                    or orig_round in ("", "?", "1")
                    or not orig_eco
                    or orig_eco == "-"
                )
                if needs_backfill:
                    backfilled_rows += 1

                raw_white = orig_white or meta["WHITE"] or "Player (Human)"
                raw_black = orig_black or meta["BLACK"] or (r.get("OPPONENT_ENGINE") or "Sparring Engine")
                norm_white = self.normalize_player_name(raw_white, root_dir=self.root_dir)
                norm_black = self.normalize_player_name(raw_black, root_dir=self.root_dir)
                if (orig_white and norm_white != orig_white) or (orig_black and norm_black != orig_black):
                    repaired_engine_names += 1

                eff_res = orig_res if orig_res in ("1-0", "0-1", "1/2-1/2") else (
                    meta["RESULT"] if meta["RESULT"] in ("1-0", "0-1", "1/2-1/2") else (
                        AdjudicationCascade.resolve_from_moves(cleaned_pgn)
                        or AdjudicationCascade.resolve_from_termination(cleaned_pgn)
                        or AdjudicationCascade.resolve_from_board(cleaned_pgn)
                        or "1/2-1/2"
                    )
                )
                eff_date = normalize_pgn_date(orig_date or meta["DATE"], fallback_today=True)
                eff_round = "-"
                eff_eco, eff_opening = infer_eco_and_opening(
                    cleaned_pgn,
                    orig_eco or meta["ECO"],
                    orig_opening or meta["OPENING"],
                )
                eff_event = (r.get("EVENT") or "").strip() or meta["EVENT"] or "DeepScout Engine Sparring"
                eff_site = (r.get("SITE") or "").strip() or meta["SITE"] or "DeepScout Arena"
                eff_w_elo = r.get("WHITEELO") if str(r.get("WHITEELO") or "").strip() else (meta["WHITEELO"] if meta["WHITEELO"] is not None else "")
                eff_b_elo = r.get("BLACKELO") if str(r.get("BLACKELO") or "").strip() else (meta["BLACKELO"] if meta["BLACKELO"] is not None else "")
                eff_fen = (r.get("FEN") or "").strip() or meta["FEN"]

                is_gold = has_genuine_gold_eval(cleaned_pgn, ply_count=eff_ply)
                if is_gold:
                    data_tier = "Gold"
                    confirmed_gold += 1
                else:
                    data_tier = "Silver"
                    # Strip synthetic heuristic-only batch blocks on unanalyzed sparring rows
                    cleaned_pgn = re.sub(r'\n*\[%provenance[^\]]*\]\n?', '\n', cleaned_pgn)
                    cleaned_pgn = re.sub(r'\n*\[%acpl[^\]]*\]\n?', '\n', cleaned_pgn)
                    cleaned_pgn = re.sub(r'\n*\[%caps[^\]]*\]\n?', '\n', cleaned_pgn).strip()
                    if had_fake_gold:
                        downgraded_to_silver += 1
                    else:
                        confirmed_silver += 1

                # Synchronize standardized Seven Tag Roster + DataTier inside PGN text
                synced_pgn = cleaned_pgn
                synced_pgn = set_pgn_header(synced_pgn, "Event", eff_event)
                synced_pgn = set_pgn_header(synced_pgn, "Site", eff_site)
                synced_pgn = set_pgn_header(synced_pgn, "Date", eff_date)
                synced_pgn = set_pgn_header(synced_pgn, "Round", eff_round)
                synced_pgn = set_pgn_header(synced_pgn, "White", norm_white)
                synced_pgn = set_pgn_header(synced_pgn, "Black", norm_black)
                synced_pgn = set_pgn_header(synced_pgn, "Result", eff_res)
                synced_pgn = set_pgn_header(synced_pgn, "ECO", eff_eco)
                if eff_opening:
                    synced_pgn = set_pgn_header(synced_pgn, "Opening", eff_opening)
                synced_pgn = set_pgn_header(synced_pgn, "DataTier", data_tier)
                synced_pgn = re.sub(r'(\s)\*\s*$', rf'\g<1>{eff_res}', synced_pgn)

                row_values: Dict[str, Any] = {
                    "white": norm_white,
                    "black": norm_black,
                    "result": eff_res,
                    "event": eff_event,
                    "site": eff_site,
                    "date": eff_date,
                    "round": eff_round,
                    "eco": eff_eco,
                    "opening": eff_opening,
                    "whiteelo": eff_w_elo,
                    "blackelo": eff_b_elo,
                    "plycount": eff_ply,
                    "fen": eff_fen,
                    "_data_": synced_pgn,
                    "pgn": synced_pgn,
                }
                write_pairs = [
                    (col_map[k], v)
                    for k, v in row_values.items()
                    if k in col_map
                ]
                if write_pairs:
                    set_clause = ", ".join(f"{c} = ?" for c, _ in write_pairs)
                    cur.execute(
                        f"UPDATE {gtable} SET {set_clause} WHERE ROWID = ?",
                        [v for _, v in write_pairs] + [rowid],
                    )

            if delete_rowids:
                cur.executemany(f"DELETE FROM {gtable} WHERE ROWID = ?", [(rid,) for rid in delete_rowids])

            conn.commit()
        finally:
            conn.close()

        return {
            "status": "ok",
            "database_name": db_name,
            "backfilled_rows": backfilled_rows,
            "repaired_engine_names": repaired_engine_names,
            "downgraded_to_silver": downgraded_to_silver,
            "confirmed_gold": confirmed_gold,
            "confirmed_silver": confirmed_silver,
            "purged_empty_stubs": purged_empty_stubs,
            "audit_after": self.audit_database(db_name),
        }

    def generate_silver_statistics(self, db_name: str) -> Dict[str, Any]:
        """
        Executes Tier 1 -> Tier 2 Silver Statistics Pass:
        - Classifies ECO and Opening System from move trees
        - Persists enriched ECO and Opening tags to database (syncing `_DATA_` & `pgn`)
        """
        db_path = self._resolve_db_path(db_name)
        conn = self._get_connection(db_path)

        ecos_assigned = 0

        try:
            cur = conn.cursor()
            cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
            tables_lower = {r[0].lower(): r[0] for r in cur.fetchall()}
            if "games" not in tables_lower:
                audit = self.audit_database(db_name)
                return {
                    "status": "ok",
                    "database_name": db_name,
                    "ecos_assigned": 0,
                    "tier_2_silver_games": audit["tiers"]["tier_2_silver"],
                    "current_health_score": audit["health_score"],
                }
            gtable = tables_lower["games"]
            select_sql, col_map = self._build_coalesced_select(cur, gtable, ["ECO", "OPENING"])
            cur.execute(f"SELECT {select_sql} FROM {gtable}")
            rows = [dict(r) for r in cur.fetchall()]

            eco_updates = []
            for r in rows:
                rowid = r.get("rowid") or r.get("ROWID")
                current_eco = (r.get("ECO") or "").strip()
                current_opening = (r.get("OPENING") or "").strip()
                data = self._decode_data(r.get("_DATA_"))

                if not current_eco or current_eco in ("A00", "-") or not current_opening:
                    inferred_eco, inferred_opening = infer_eco_and_opening(data, current_eco, current_opening)
                    if inferred_eco != current_eco or inferred_opening != current_opening:
                        new_data = set_pgn_header(data, "ECO", inferred_eco)
                        new_data = set_pgn_header(new_data, "Opening", inferred_opening)
                        eco_updates.append((inferred_eco, inferred_opening, new_data, rowid))
                        ecos_assigned += 1

            if eco_updates:
                set_cols = []
                if "eco" in col_map:
                    set_cols.append((col_map["eco"], 0))
                if "opening" in col_map:
                    set_cols.append((col_map["opening"], 1))
                if "_data_" in col_map:
                    set_cols.append((col_map["_data_"], 2))
                if "pgn" in col_map:
                    set_cols.append((col_map["pgn"], 2))
                if set_cols:
                    set_sql = ", ".join(f"{c} = ?" for c, _ in set_cols)
                    batch_params = [tuple(u[idx] for _, idx in set_cols) + (u[3],) for u in eco_updates]
                    cur.executemany(f"UPDATE {gtable} SET {set_sql} WHERE ROWID = ?", batch_params)
                    conn.commit()
        finally:
            conn.close()

        audit = self.audit_database(db_name)

        return {
            "status": "ok",
            "database_name": db_name,
            "ecos_assigned": ecos_assigned,
            "tier_2_silver_games": audit["tiers"]["tier_2_silver"] + audit["tiers"]["tier_3_gold"],
            "current_health_score": audit["health_score"],
            "grade": audit["grade"],
        }
